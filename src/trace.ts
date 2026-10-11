/**
 * Demo instrumentation.
 *
 * Every agent turn, tool call, guardrail stop and human gate is recorded with
 * wall-clock timing and token usage. Two reasons this exists:
 *  1. It is the narration the presenter reads off the screen.
 *  2. It produces the baseline numbers the Solution Brief's ROI slide is
 *     missing ("Insufficient data: no cycle-time or cost-impact figures").
 */

export type TraceEvent =
  | { kind: "lane"; label: string; at: number }
  | { kind: "agent_start"; agent: string; fr: string; at: number }
  | { kind: "agent_end"; agent: string; fr: string; ms: number; inputTokens: number; outputTokens: number; cachedTokens: number; at: number }
  | { kind: "tool"; agent: string; tool: string; fr: string; summary: string; ms: number; at: number }
  | { kind: "decision"; rule: string; question: string; outcome: string; at: number }
  | { kind: "escalation"; agent: string; nfr: string; reason: string; at: number }
  | { kind: "human_gate"; fr: string; gate: string; actor: string; outcome: string; at: number }
  | { kind: "note"; text: string; at: number };

/** Omit that distributes across the union, so each variant keeps its own fields. */
type DistributiveOmit<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never;
export type TraceEventInput = DistributiveOmit<TraceEvent, "at"> & { at?: number };

const events: TraceEvent[] = [];
let quiet = false;
const listeners = new Set<(event: TraceEvent) => void>();

export function setQuiet(value: boolean): void {
  quiet = value;
}

export function resetTrace(): void {
  events.length = 0;
}

export function allEvents(): readonly TraceEvent[] {
  return events;
}

/** Subscribe to trace events as they happen (used by the web UI's SSE feed). */
export function subscribeTrace(listener: (event: TraceEvent) => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

const C = {
  dim: "\x1b[2m",
  reset: "\x1b[0m",
  bold: "\x1b[1m",
  cyan: "\x1b[36m",
  green: "\x1b[32m",
  yellow: "\x1b[33m",
  magenta: "\x1b[35m",
  red: "\x1b[31m",
};

function out(line: string): void {
  if (!quiet) console.log(line);
}

export function emit(event: TraceEventInput): void {
  const full = { ...event, at: event.at ?? Date.now() } as TraceEvent;
  events.push(full);
  for (const listener of listeners) listener(full);

  switch (full.kind) {
    case "lane":
      out(`\n${C.bold}${"=".repeat(74)}${C.reset}`);
      out(`${C.bold}  ${full.label}${C.reset}`);
      out(`${C.bold}${"=".repeat(74)}${C.reset}`);
      break;
    case "agent_start":
      out(`\n${C.cyan}▶ ${full.agent}${C.reset} ${C.dim}(${full.fr})${C.reset}`);
      break;
    case "agent_end":
      out(
        `${C.dim}  └ completed in ${(full.ms / 1000).toFixed(1)}s · ` +
          `${full.inputTokens} in / ${full.outputTokens} out` +
          (full.cachedTokens > 0 ? ` · ${full.cachedTokens} cached` : "") +
          C.reset,
      );
      break;
    case "tool":
      out(`  ${C.dim}⚙${C.reset} ${full.tool} ${C.dim}(${full.fr})${C.reset} — ${full.summary}`);
      break;
    case "decision":
      out(`\n${C.magenta}◆ ${full.rule}${C.reset} ${full.question}`);
      out(`  ${C.magenta}→ ${full.outcome}${C.reset}`);
      break;
    case "escalation":
      out(`\n${C.red}⛔ ESCALATED by ${full.agent}${C.reset} ${C.dim}(${full.nfr})${C.reset}`);
      out(`   ${full.reason}`);
      break;
    case "human_gate":
      out(`\n${C.yellow}👤 HUMAN GATE ${full.fr} — ${full.gate}${C.reset}`);
      out(`   ${full.actor}: ${C.yellow}${full.outcome}${C.reset}`);
      break;
    case "note":
      out(`${C.dim}   ${full.text}${C.reset}`);
      break;
  }
}

export interface LaneSummary {
  agentTurns: number;
  toolCalls: number;
  escalations: number;
  humanGates: number;
  agentWallClockMs: number;
  inputTokens: number;
  outputTokens: number;
  cachedTokens: number;
}

export function summarise(): LaneSummary {
  const summary: LaneSummary = {
    agentTurns: 0,
    toolCalls: 0,
    escalations: 0,
    humanGates: 0,
    agentWallClockMs: 0,
    inputTokens: 0,
    outputTokens: 0,
    cachedTokens: 0,
  };
  for (const e of events) {
    if (e.kind === "agent_end") {
      summary.agentTurns += 1;
      summary.agentWallClockMs += e.ms;
      summary.inputTokens += e.inputTokens;
      summary.outputTokens += e.outputTokens;
      summary.cachedTokens += e.cachedTokens;
    }
    if (e.kind === "tool") summary.toolCalls += 1;
    if (e.kind === "escalation") summary.escalations += 1;
    if (e.kind === "human_gate") summary.humanGates += 1;
  }
  return summary;
}

/**
 * Cost estimate from your own Azure rates.
 *
 * Deliberately not defaulted to a published price: Azure rates vary by region,
 * deployment type and agreement, and a wrong number quoted to a customer is
 * worse than no number. Set the three env vars to switch this on.
 */
export function estimateCostUsd(s: LaneSummary): number | undefined {
  const input = Number(process.env.AZURE_INPUT_USD_PER_1M);
  const output = Number(process.env.AZURE_OUTPUT_USD_PER_1M);
  const cached = Number(process.env.AZURE_CACHED_INPUT_USD_PER_1M ?? 0);

  if (!Number.isFinite(input) || !Number.isFinite(output) || input === 0) return undefined;

  return (
    (s.inputTokens / 1e6) * input +
    (s.outputTokens / 1e6) * output +
    (s.cachedTokens / 1e6) * (Number.isFinite(cached) ? cached : 0)
  );
}

/**
 * The run as JSON: every agent turn, tool call, decision, gate and escalation
 * with timings and token counts. This is the feed a diagram UI would replay,
 * and the raw material for the baseline measurements the Solution Brief's ROI
 * slide is missing.
 */
export function traceAsJson(label: string): string {
  const first = events[0]?.at ?? Date.now();
  return JSON.stringify(
    {
      label,
      recordedAt: new Date(first).toISOString(),
      summary: summarise(),
      estimatedCostUsd: estimateCostUsd(summarise()) ?? null,
      events: events.map((e) => ({ ...e, msFromStart: e.at - first })),
    },
    null,
    2,
  );
}

export function printSummary(): void {
  const s = summarise();
  out(`\n${C.bold}${"-".repeat(74)}${C.reset}`);
  out(`${C.bold}  Run summary${C.reset}`);
  out(`  Agent turns ............ ${s.agentTurns}`);
  out(`  ERP tool calls ......... ${s.toolCalls}`);
  out(`  Human gates ............ ${s.humanGates}`);
  out(`  Escalations ............ ${s.escalations}`);
  out(`  Agent wall clock ....... ${(s.agentWallClockMs / 1000).toFixed(1)}s`);
  out(`  Tokens ................. ${s.inputTokens} in / ${s.outputTokens} out / ${s.cachedTokens} cached`);
  const cost = estimateCostUsd(s);
  out(
    cost === undefined
      ? "  Approx. model cost ..... set AZURE_INPUT_USD_PER_1M / AZURE_OUTPUT_USD_PER_1M to estimate"
      : `  Approx. model cost ..... $${cost.toFixed(4)}`,
  );
  out(`${C.bold}${"-".repeat(74)}${C.reset}`);
}
