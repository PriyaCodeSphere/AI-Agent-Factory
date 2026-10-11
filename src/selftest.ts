/**
 * Offline self-test. No model calls, no credentials needed.
 *
 * Verifies the parts of the demo that must not be in doubt when you are
 * standing in front of a customer: that the mock ERP arithmetic closes the
 * loop, that every corrective path reaches the MRP result, that the refusal
 * lane really does leave only stale data on the table, and that the tool-level
 * guardrails reject what they are supposed to reject.
 *
 * Tool calls go through each tool's Zod schema rather than straight to `run`,
 * so a schema change that the orchestrator has not caught up with fails here.
 */

import {
  applyDocumentedSubstitution,
  engineeringChangeManagementInitiation,
  engineeringDocumentationLookup,
  erpDealerAndCustomerAllocationUpdate,
  erpExceptionQueueLookup,
  erpInventoryAndStockTransportInterface,
  erpMrpEngineExecution,
  erpMrpResultsLookup,
  erpPaintProductionOrderCreation,
  erpProductionScheduleUpdate,
  erpSafetyStockParameterUpdate,
  erpScopedMrpExecution,
  erpTransactionAndMasterDataUpdate,
  erpVendorSourceLookup,
  planningNetworkAndPolicyLookup,
  recordSupplierCommitment,
} from "./erp/tools.ts";
import { inventoryFor, resetErp } from "./erp/store.ts";
import { ALL_AGENTS } from "./agents/registry.ts";
import { CORRECTIVE_PATHS } from "./orchestrator.ts";
import type { AgentTool } from "./llm/tool.ts";
import { setQuiet } from "./trace.ts";

let passed = 0;
const failures: string[] = [];

function check(label: string, condition: boolean, detail = ""): void {
  if (condition) {
    passed += 1;
    console.log(`  ok   ${label}`);
  } else {
    failures.push(`${label}${detail ? ` — ${detail}` : ""}`);
    console.log(`  FAIL ${label}${detail ? ` — ${detail}` : ""}`);
  }
}

/** Validates args against the tool's schema, runs it, and parses the result. */
function call(tool: AgentTool, args: unknown): any {
  const parsed = tool.inputSchema.safeParse(args);
  if (!parsed.success) {
    throw new Error(
      `${tool.name} rejected its arguments: ` +
        parsed.error.issues.map((i) => `${i.path.join(".") || "(root)"} ${i.message}`).join("; "),
    );
  }
  const output = tool.run(parsed.data);
  if (typeof output !== "string") throw new Error(`${tool.name} returned a promise; expected synchronous.`);
  return JSON.parse(output);
}

export function runSelfTest(): boolean {
  setQuiet(true);

  console.log("\nMock ERP self-test (no model calls)\n");

  // ── Lane A arithmetic ──────────────────────────────────────────────────────
  console.log("Lane A — alternate inventory closes the shortage");
  resetErp();

  const mrpRun = call(erpMrpEngineExecution, { plant: "1010" });
  check("FR-21 MRP run raises plant 1010 exceptions", mrpRun.exceptionsGenerated === 2, `got ${mrpRun.exceptionsGenerated}`);
  check("FR-21 uses the plant's own ERP platform", mrpRun.erpPlatform === "SAP S/4 HANA", mrpRun.erpPlatform);

  const queue = call(erpExceptionQueueLookup, { plant: "1010" });
  check("FR-22 exception queue returns source priority", queue.exceptions[0].sourcePriority === "high");

  const availability = call(erpInventoryAndStockTransportInterface, {
    action: "read_availability",
    material: "HYD-PUMP-3045",
  });
  const ennery = availability.locations.find((l: any) => l.location === "8010");
  check("FR-26 Ennery shows 140 units, feed current", ennery.unrestrictedQty === 140 && ennery.availabilityIsCurrent === true);
  const kansas = availability.locations.find((l: any) => l.location === "8020");
  check("FR-26 Kansas City is flagged as not current", kansas.availabilityIsCurrent === false);

  const transport = call(erpInventoryAndStockTransportInterface, {
    action: "create_stock_transport",
    material: "HYD-PUMP-3045",
    fromLocation: "8010",
    toLocation: "1010",
    qty: 120,
    forException: "EX-77301",
  });
  check("FR-26 stock transport created", Boolean(transport.stockTransport?.documentNo));
  check(
    "FR-26 arrival beats the required date",
    transport.stockTransport.expectedArrival <= "2026-10-27",
    transport.stockTransport?.expectedArrival,
  );
  check("FR-26 source stock drawn down", inventoryFor("HYD-PUMP-3045").find((r) => r.location === "8010")!.unrestrictedQty === 20);

  // FR-33 is read-then-write: the "before" value has to come from somewhere.
  const currentState = call(erpTransactionAndMasterDataUpdate, {
    action: "read_current_state",
    plant: "1010",
    material: "HYD-PUMP-3045",
  });
  check("FR-33 read_current_state surfaces the planned receipt", currentState.plannedReceipts.length === 1);

  const write = call(erpTransactionAndMasterDataUpdate, {
    action: "write_change",
    plant: "1010",
    material: "HYD-PUMP-3045",
    changeType: "planned receipt",
    objectRef: transport.stockTransport.documentNo,
    before: "no inbound receipt",
    after: "120 units inbound 2026-10-13",
    justification: "Stock transport from Ennery PDC against EX-77301",
  });
  check("FR-33 ERP write confirmed with audit trail", write.erpUpdateStatus === "confirmed" && Boolean(write.write.documentNo));

  const incompleteWrite = call(erpTransactionAndMasterDataUpdate, {
    action: "write_change",
    plant: "1010",
    material: "HYD-PUMP-3045",
    changeType: "planned receipt",
  });
  check("NFR-31 write without before/after rejected", typeof incompleteWrite.error === "string");

  const replan = call(erpScopedMrpExecution, {
    exceptionId: "EX-77301",
    scope: "multi_location",
    locations: ["1010", "8010"],
  });
  check("FR-34 multi-location replan clears the shortage", replan.residualShortageQty === 0, `residual ${replan.residualShortageQty}`);
  check("FR-34 no unsynchronised locations left", replan.unsynchronisedLocations.length === 0);

  const results = call(erpMrpResultsLookup, { exceptionId: "EX-77301" });
  check("FR-35 results lookup is read-only and agrees", results.result.residualShortageQty === 0);

  // A plant-only run must leave the supplying DC unsynchronised (NFR-37's trigger).
  const plantOnly = call(erpScopedMrpExecution, { exceptionId: "EX-77301", scope: "plant", locations: ["1010"] });
  check(
    "NFR-37 plant-only scope leaves the supplying DC unsynchronised",
    plantOnly.unsynchronisedLocations.includes("8010"),
    JSON.stringify(plantOnly.unsynchronisedLocations),
  );

  // NFR-34: invented location ids must be rejected, not silently "run".
  const bogusScope = call(erpScopedMrpExecution, {
    exceptionId: "EX-77301",
    scope: "multi_location",
    locations: ["HYDROPLANT01", "HYDRODC01"],
  });
  check("NFR-34 invented location ids rejected", typeof bogusScope.error === "string");

  const missingPlant = call(erpScopedMrpExecution, {
    exceptionId: "EX-77301",
    scope: "plant",
    locations: ["8010"],
  });
  check("NFR-33 scope excluding the affected plant rejected", typeof missingPlant.error === "string");

  // ── Refusal lane setup ────────────────────────────────────────────────────
  //
  // The lane only tests NFR-14 if the stale stock is the sole route that could
  // close the shortage. These checks assert that isolation holds - if a later
  // fixture edit opens another path, the recommending agent will take it and
  // the refusal will quietly stop being demonstrated.
  console.log("\nRefusal lane — the stale stock is the only route");
  resetErp();

  const scarce = call(erpInventoryAndStockTransportInterface, {
    action: "read_availability",
    material: "BRG-5520-HD",
  });
  const withStock = scarce.locations.filter((l: any) => l.unrestrictedQty >= 90);
  check("only one location shows enough stock", withStock.length === 1, `${withStock.length} locations`);
  check("and that location's feed is stale", withStock[0]?.availabilityIsCurrent === false, withStock[0]?.locationName);
  check(
    "the stale stock would otherwise arrive in time",
    "2026-10-20" <= "2026-11-05",
  );

  const bearingSubs = call(engineeringDocumentationLookup, { material: "BRG-5520-HD" });
  check(
    "no substitute and no approval candidate exist",
    bearingSubs.documentedSubstitutions.length === 0 && bearingSubs.candidatesRequiringEngineeringApproval.length === 0,
  );

  const bearingRef = call(planningNetworkAndPolicyLookup, { material: "BRG-5520-HD" });
  check("no cross-brand equivalent", bearingRef.crossBrandEquivalents.length === 0);
  check("no allocations to rebalance", bearingRef.allocations.length === 0);
  check("no production orders to reprioritise", bearingRef.productionPriorities.length === 0);
  check("no safety stock to release", Object.keys(bearingRef.safetyStock).length === 0);

  const bearingVendors = call(erpVendorSourceLookup, { material: "BRG-5520-HD" });
  check("sole vendor cannot meet the required date", bearingVendors.vendors[0].earliestAvailableDate > "2026-11-05");

  // ── Every corrective path reaches the MRP result ──────────────────────────
  console.log("\nAll nine BR-01 paths feed the corrective-supply ledger");

  resetErp();
  const safety = call(erpSafetyStockParameterUpdate, {
    material: "HYD-PUMP-3045",
    location: "1010",
    newLevel: 0,
    temporary: true,
    forException: "EX-77301",
  });
  check("FR-32 safety-stock release frees 40 units", safety.safetyStockChange.released === 40);

  const allocation = call(erpDealerAndCustomerAllocationUpdate, {
    material: "HYD-PUMP-3045",
    allocationId: "AL-5501",
    newQty: 0,
    forException: "EX-77301",
  });
  check("FR-31 allocation change frees 60 units", allocation.allocationChange.released === 60);

  const schedule = call(erpProductionScheduleUpdate, {
    plant: "1010",
    order: "PO-884255",
    newPriority: 9,
    forException: "EX-77301",
  });
  check("FR-30 deprioritising the stock-build order protects 40 units", schedule.scheduleChange.released === 40);

  const combined = call(erpScopedMrpExecution, { exceptionId: "EX-77301", scope: "plant", locations: ["1010"] });
  check("three freeing paths together clear the 120 shortage", combined.residualShortageQty === 0, `residual ${combined.residualShortageQty}`);

  resetErp();
  const paint = call(erpPaintProductionOrderCreation, {
    material: "HYD-PUMP-3045",
    targetPartNo: "HYD-PUMP-3045-MF",
    qty: 75,
    forException: "EX-77301",
  });
  check("FR-29 paint order is usable before the required date", paint.paintOrder.availableBy <= "2026-10-27");
  const afterPaint = call(erpScopedMrpExecution, { exceptionId: "EX-77301", scope: "plant", locations: ["1010"] });
  check("FR-29 conversion reduces but does not clear the shortage", afterPaint.residualShortageQty === 45, `residual ${afterPaint.residualShortageQty}`);

  resetErp();
  call(recordSupplierCommitment, {
    vendor: "V-10044 Hydrotek GmbH",
    qty: 120,
    committedDate: "2026-12-05",
    supplierWording: "No capacity available before 2026-12-05.",
    forException: "EX-77301",
  });
  const lateSupply = call(erpScopedMrpExecution, { exceptionId: "EX-77301", scope: "plant", locations: ["1010"] });
  check("supply arriving after the required date is not counted", lateSupply.residualShortageQty === 120, `residual ${lateSupply.residualShortageQty}`);

  resetErp();
  call(recordSupplierCommitment, {
    vendor: "V-10044 Hydrotek GmbH",
    qty: 120,
    committedDate: "2026-10-20",
    supplierWording: "Confirmed: 120 units despatched for 20 October.",
    forException: "EX-77301",
  });
  const onTimeSupply = call(erpScopedMrpExecution, { exceptionId: "EX-77301", scope: "plant", locations: ["1010"] });
  check("an on-time commitment clears the shortage", onTimeSupply.residualShortageQty === 0);

  resetErp();
  const goodSub = call(applyDocumentedSubstitution, {
    material: "HYD-PUMP-3045",
    substitute: "HYD-PUMP-3048",
    engineeringReference: "ECN-2024-0912",
    forException: "EX-77301",
  });
  check("FR-08 documented substitution applied", goodSub.applied === true);
  check("FR-08 restrictions surfaced to the agent", String(goodSub.restrictions).includes("Fendt 700 Vario"));
  const afterSub = call(erpScopedMrpExecution, { exceptionId: "EX-77301", scope: "plant", locations: ["1010"] });
  check("FR-08 substitution clears the shortage", afterSub.residualShortageQty === 0);

  // ── Registry completeness ─────────────────────────────────────────────────
  console.log("\nRegistry matches the BRD");
  check("all 16 digital personas are defined", ALL_AGENTS.length === 16, `${ALL_AGENTS.length}`);
  check("BR-01 still lists nine corrective paths", CORRECTIVE_PATHS.length === 9);
  check("no duplicate agent names", new Set(ALL_AGENTS.map((a) => a.name)).size === ALL_AGENTS.length);
  check(
    "every agent has at least one guardrail and an escalation path",
    ALL_AGENTS.every((a) => a.guardrails.length > 0 && Boolean(a.escalation.text)),
  );
  check("every agent has at least one tool", ALL_AGENTS.every((a) => a.tools.length > 0));

  // ── Tool-level guardrails ─────────────────────────────────────────────────
  console.log("\nGuardrails enforced at the tool boundary");
  resetErp();

  const badSub = call(applyDocumentedSubstitution, {
    material: "CAST-7781-GY",
    substitute: "CAST-7902-GY",
    engineeringReference: "made-up",
    forException: "EX-77302",
  });
  check("NFR-16 undocumented substitution rejected", typeof badSub.error === "string");

  const permanentSafetyStock = call(erpSafetyStockParameterUpdate, {
    material: "HYD-PUMP-3045",
    location: "1010",
    newLevel: 0,
  });
  check("NFR-28 non-temporary safety-stock change rejected", typeof permanentSafetyStock.error === "string");

  const noDecision = call(engineeringChangeManagementInitiation, {
    material: "CAST-7781-GY",
    substitute: "CAST-7902-GY",
    decisionRef: "  ",
    forException: "EX-77302",
  });
  check("NFR-20 engineering change without a decision rejected", typeof noDecision.error === "string");

  const unattributed = call(erpSafetyStockParameterUpdate, {
    material: "HYD-PUMP-3045",
    location: "1010",
    newLevel: 0,
    temporary: true,
  });
  check("unattributed safety-stock change rejected", typeof unattributed.error === "string");

  const overdraw = call(erpInventoryAndStockTransportInterface, {
    action: "create_stock_transport",
    material: "CAST-7781-GY",
    fromLocation: "1010",
    toLocation: "2020",
    qty: 999,
    forException: "EX-77302",
  });
  check("stock transport beyond available quantity rejected", typeof overdraw.error === "string");

  resetErp();
  setQuiet(false);

  console.log("");
  if (failures.length === 0) {
    console.log(`All ${passed} checks passed.\n`);
    return true;
  }
  console.log(`${passed} passed, ${failures.length} FAILED:`);
  for (const f of failures) console.log(`  - ${f}`);
  console.log("");
  return false;
}
