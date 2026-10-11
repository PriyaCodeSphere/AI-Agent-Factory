import { createReadStream } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { timingSafeEqual } from "node:crypto";
import { fileURLToPath } from "node:url";

import type { HumanDecision, LaneResult } from "./orchestrator.ts";
import { runLane, type LaneName } from "./scenarios.ts";
import {
  estimateCostUsd,
  setQuiet,
  subscribeTrace,
  summarise,
  type LaneSummary,
  type TraceEvent,
} from "./trace.ts";

const port = Number(process.env.PORT ?? 3000);
const publicDir = fileURLToPath(new URL("../public/", import.meta.url));
const lanes = new Set<LaneName>(["lane-a", "lane-b", "refusal"]);
const decisions = new Set<HumanDecision>(["approved", "changes_requested", "rejected"]);

interface RunRecord {
  id: string;
  lane: LaneName;
  humanDecision: HumanDecision;
  status: "queued" | "running" | "completed" | "failed";
  startedAt: string;
  finishedAt?: string;
  events: TraceEvent[];
  result?: LaneResult;
  summary?: LaneSummary;
  estimatedCostUsd?: number | null;
  error?: string;
  clients: Set<ServerResponse>;
}

const runs = new Map<string, RunRecord>();
let activeRunId: string | undefined;
setQuiet(true);

function sendJson(res: ServerResponse, status: number, value: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" });
  res.end(JSON.stringify(value));
}

function secureEqual(actual: string, expected: string): boolean {
  const left = Buffer.from(actual);
  const right = Buffer.from(expected);
  return left.length === right.length && timingSafeEqual(left, right);
}

function isAuthorised(req: IncomingMessage): boolean {
  const expectedPassword = process.env.DEMO_PASSWORD;
  if (!expectedPassword) return true;
  const header = req.headers.authorization;
  if (!header?.startsWith("Basic ")) return false;
  try {
    const decoded = Buffer.from(header.slice(6), "base64").toString("utf8");
    const separator = decoded.indexOf(":");
    if (separator < 0) return false;
    const username = decoded.slice(0, separator);
    const password = decoded.slice(separator + 1);
    return secureEqual(username, process.env.DEMO_USERNAME ?? "demo") && secureEqual(password, expectedPassword);
  } catch {
    return false;
  }
}

function sse(res: ServerResponse, event: string, value: unknown): void {
  res.write(`event: ${event}\ndata: ${JSON.stringify(value)}\n\n`);
}

function broadcast(run: RunRecord, event: string, value: unknown): void {
  for (const client of run.clients) sse(client, event, value);
}

function terminalPayload(run: RunRecord): object {
  return {
    id: run.id,
    status: run.status,
    result: run.result,
    summary: run.summary,
    estimatedCostUsd: run.estimatedCostUsd ?? null,
    error: run.error,
    finishedAt: run.finishedAt,
  };
}

async function executeRun(run: RunRecord): Promise<void> {
  activeRunId = run.id;
  run.status = "running";
  broadcast(run, "status", { status: run.status });

  const unsubscribe = subscribeTrace((event) => {
    run.events.push(event);
    broadcast(run, "trace", event);
  });

  try {
    run.result = await runLane(run.lane, run.humanDecision);
    run.summary = summarise();
    run.estimatedCostUsd = estimateCostUsd(run.summary) ?? null;
    run.status = "completed";
  } catch (error) {
    run.status = "failed";
    run.error = error instanceof Error ? error.message : String(error);
  } finally {
    unsubscribe();
    run.finishedAt = new Date().toISOString();
    activeRunId = undefined;
    broadcast(run, "complete", terminalPayload(run));
    for (const client of run.clients) client.end();
    run.clients.clear();
  }
}

function serveFile(res: ServerResponse, file: string, contentType: string): void {
  res.writeHead(200, {
    "content-type": contentType,
    "cache-control": file === "index.html" ? "no-cache" : "public, max-age=3600",
  });
  const stream = createReadStream(`${publicDir}${file}`);
  stream.on("error", () => res.end());
  stream.pipe(res);
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > 16_384) throw new Error("Request body is too large");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);

  if (req.method === "GET" && url.pathname === "/healthz") {
    sendJson(res, 200, { ok: true });
    return;
  }

  if (!isAuthorised(req)) {
    res.writeHead(401, {
      "content-type": "application/json; charset=utf-8",
      "www-authenticate": 'Basic realm="MRP Agent Demo", charset="UTF-8"',
    });
    res.end(JSON.stringify({ error: "Authentication required" }));
    return;
  }

  if (req.method === "GET" && url.pathname === "/api/health") {
    const endpoint = Boolean(process.env.AZURE_OPENAI_ENDPOINT);
    const apiKey = Boolean(process.env.AZURE_OPENAI_API_KEY);
    const deployment = process.env.AZURE_OPENAI_DEPLOYMENT ?? process.env.AZURE_OPENAI_CHAT_DEPLOYMENT;
    sendJson(res, 200, {
      ok: true,
      configured: endpoint && apiKey && Boolean(deployment),
      deployment: deployment ?? null,
      activeRunId: activeRunId ?? null,
    });
    return;
  }

  if (req.method === "POST" && url.pathname === "/api/runs") {
    if (activeRunId) {
      sendJson(res, 409, { error: "A demo run is already in progress", activeRunId });
      return;
    }
    try {
      const body = (await readJson(req)) as { lane?: LaneName; humanDecision?: HumanDecision };
      if (!body.lane || !lanes.has(body.lane)) {
        sendJson(res, 400, { error: "lane must be lane-a, lane-b, or refusal" });
        return;
      }
      const humanDecision = body.humanDecision ?? "approved";
      if (!decisions.has(humanDecision)) {
        sendJson(res, 400, { error: "humanDecision must be approved, changes_requested, or rejected" });
        return;
      }
      if (!process.env.AZURE_OPENAI_ENDPOINT || !process.env.AZURE_OPENAI_API_KEY ||
          !(process.env.AZURE_OPENAI_DEPLOYMENT ?? process.env.AZURE_OPENAI_CHAT_DEPLOYMENT)) {
        sendJson(res, 503, { error: "Azure OpenAI environment variables are not configured on the server" });
        return;
      }

      const id = crypto.randomUUID();
      const run: RunRecord = {
        id,
        lane: body.lane,
        humanDecision,
        status: "queued",
        startedAt: new Date().toISOString(),
        events: [],
        clients: new Set(),
      };
      if (runs.size >= 25) {
        const oldestCompleted = [...runs.values()].find((candidate) => candidate.status !== "running");
        if (oldestCompleted) runs.delete(oldestCompleted.id);
      }
      runs.set(id, run);
      activeRunId = id;
      sendJson(res, 202, { id, status: run.status });
      setImmediate(() => void executeRun(run));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Invalid request" });
    }
    return;
  }

  const eventMatch = url.pathname.match(/^\/api\/runs\/([0-9a-f-]+)\/events$/i);
  if (req.method === "GET" && eventMatch) {
    const run = runs.get(eventMatch[1] ?? "");
    if (!run) {
      sendJson(res, 404, { error: "Run not found" });
      return;
    }
    res.writeHead(200, {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    });
    res.write(": connected\n\n");
    for (const event of run.events) sse(res, "trace", event);
    if (run.status === "completed" || run.status === "failed") {
      sse(res, "complete", terminalPayload(run));
      res.end();
      return;
    }
    run.clients.add(res);
    const keepAlive = setInterval(() => res.write(": keepalive\n\n"), 15_000);
    req.on("close", () => {
      clearInterval(keepAlive);
      run.clients.delete(res);
    });
    return;
  }

  if (req.method === "GET" && url.pathname === "/") return serveFile(res, "index.html", "text/html; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/app.js") return serveFile(res, "app.js", "text/javascript; charset=utf-8");
  if (req.method === "GET" && url.pathname === "/styles.css") return serveFile(res, "styles.css", "text/css; charset=utf-8");

  sendJson(res, 404, { error: "Not found" });
});

server.listen(port, "0.0.0.0", () => {
  console.log(`MRP Agent Demo web UI: http://localhost:${port}`);
});
