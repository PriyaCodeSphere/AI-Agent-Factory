/**
 * Demo entry point.
 *
 *   node src/cli.ts lane-a
 *   node src/cli.ts lane-b
 *   node src/cli.ts lane-b --reject      (show the rework loop at FR-10)
 *   node src/cli.ts refusal
 *   node src/cli.ts all
 */

import { runLane, type LaneName } from "./scenarios.ts";
import type { HumanDecision } from "./orchestrator.ts";
import { runSelfTest } from "./selftest.ts";
import { loadAzureConfig } from "./llm/client.ts";

const LANES: LaneName[] = ["lane-a", "lane-b", "refusal"];

function usage(): never {
  console.log("Usage: node src/cli.ts <lane-a|lane-b|refusal|all|selftest> [options]");
  console.log("");
  console.log("  lane-a    Autonomous resolution, no human involved");
  console.log("  lane-b    Governed resolution, stops at the FR-10 engineering gate");
  console.log("  refusal   An agent declines to act under NFR-14");
  console.log("  all       All three, in order");
  console.log("  selftest  Verify the mock ERP and guardrails offline (no model calls)");
  console.log("");
  console.log("  --reject | --changes-requested   Engineering's decision at the FR-10 gate");
  console.log("  --trace-out <dir>               Write the full run trace as JSON");
  process.exit(1);
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const target = args[0];
  if (!target) usage();

  if (target === "selftest") {
    process.exit(runSelfTest() ? 0 : 1);
  }

  const humanDecision: HumanDecision = args.includes("--reject")
    ? "rejected"
    : args.includes("--changes-requested")
      ? "changes_requested"
      : "approved";

  const lanes: LaneName[] = target === "all" ? LANES : LANES.includes(target as LaneName) ? [target as LaneName] : usage();

  // Fail on configuration before printing a lane banner, so a misconfigured
  // run never looks like it started.
  const config = loadAzureConfig();
  console.log(
    `Azure OpenAI deployment "${config.deployment}" (api-version ${config.apiVersion})` +
      `${config.isReasoningModel ? ", reasoning model" : ""}`,
  );

  const traceFlag = args.indexOf("--trace-out");
  const traceOutDir = traceFlag !== -1 ? args[traceFlag + 1] : undefined;
  if (traceFlag !== -1 && !traceOutDir) {
    console.log("--trace-out needs a directory, e.g. --trace-out ./traces");
    process.exit(1);
  }

  for (const lane of lanes) {
    await runLane(lane, humanDecision, traceOutDir);
  }
}

main().catch((error: unknown) => {
  console.error("\nDemo failed:");
  console.error(error);
  process.exit(1);
});
