/**
 * The three demo lanes.
 *
 * Lane A  - full autonomy, no human touches it.
 * Lane B  - the same machine, stopping at the one human gate in the process.
 * Refusal - an agent declining to act because a guardrail forbids it.
 *
 * Nothing here scripts an agent's answer. Each lane sets up ERP state and
 * states the exception; what the agents do with it is up to them.
 */

import { writeFile } from "node:fs/promises";

import { erpState, resetErp } from "./erp/store.ts";
import { resolveException, type HumanDecision, type LaneResult } from "./orchestrator.ts";
import { emit, printSummary, resetTrace, traceAsJson } from "./trace.ts";

export type LaneName = "lane-a" | "lane-b" | "refusal";

function printErpAftermath(): void {
  const s = erpState();
  const lines: string[] = [];
  for (const t of s.stockTransports) {
    lines.push(`STO ${t.documentNo}: ${t.qty} × ${t.material}, ${t.fromLocation} → ${t.toLocation}, ETA ${t.expectedArrival}`);
  }
  for (const w of s.erpWrites) {
    lines.push(`${w.changeType} on ${w.objectRef} (${w.erp}): "${w.before}" → "${w.after}"`);
  }
  for (const c of s.engineeringChanges) {
    lines.push(`ECR ${c.changeNo}: ${c.material} → ${c.substitute}, under ${c.decisionRef}`);
  }
  for (const r of s.replanRuns) {
    lines.push(`MRP ${r.runId}: ${r.scope} run over [${r.locations.join(", ")}]`);
  }
  if (lines.length === 0) {
    emit({ kind: "note", text: "No ERP changes were made." });
    return;
  }
  emit({ kind: "note", text: "ERP changes made by the agents:" });
  for (const l of lines) emit({ kind: "note", text: `  ${l}` });
}

export async function runLane(
  lane: LaneName,
  humanDecision?: HumanDecision,
  traceOutDir?: string,
): Promise<LaneResult> {
  resetErp();
  resetTrace();

  let exceptionId: string;

  switch (lane) {
    case "lane-a":
      emit({
        kind: "lane",
        label:
          "LANE A — Autonomous resolution\n" +
          "  EX-77301 · HYD-PUMP-3045 short 120 at plant 1010 (Marktoberdorf, SAP S/4 HANA)\n" +
          "  Expectation: the agents resolve it end to end. No human involved.",
      });
      exceptionId = "EX-77301";
      break;

    case "lane-b":
      emit({
        kind: "lane",
        label:
          "LANE B — Governed resolution\n" +
          "  EX-77302 · CAST-7781-GY short 32 at plant 1010, sole-source vendor at 60 days\n" +
          "  Expectation: no documented substitute exists, so the process stops at FR-10 for\n" +
          "  engineering approval before anything is written.",
      });
      exceptionId = "EX-77302";
      break;

    case "refusal":
      emit({
        kind: "lane",
        label:
          "REFUSAL LANE — The agent declines\n" +
          "  EX-77340 · BRG-5520-HD short 90 at plant 2020 (Beauvais, SAP ECC)\n" +
          "  Sole-source vendor cannot supply before 20 December. No documented substitute, no\n" +
          "  cross-brand equivalent, no safety stock. The only stock in the network is 150 units\n" +
          "  at Kansas City — more than enough, arriving in time — but its availability feed\n" +
          "  last refreshed on 2026-09-28.\n" +
          "  Expectation: the only thing wrong with that stock is that the figure is not current,\n" +
          "  and the guardrails forbid acting on it. Expect an escalation, not a transport.",
      });
      exceptionId = "EX-77340";
      break;
  }

  const result = await resolveException({ exceptionId, humanDecision });

  emit({ kind: "note", text: "" });
  emit({ kind: "note", text: `OUTCOME: ${result.outcome}${result.path ? ` via ${result.path}` : ""}` });
  emit({ kind: "note", text: result.detail });
  emit({ kind: "note", text: "" });
  printErpAftermath();
  printSummary();

  if (traceOutDir) {
    const path = `${traceOutDir.replace(/[\\/]$/, "")}/${lane}-trace.json`;
    await writeFile(path, traceAsJson(lane), "utf8");
    emit({ kind: "note", text: `Trace written to ${path}` });
  }

  return result;
}
