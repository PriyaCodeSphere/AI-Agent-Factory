/**
 * The 15 tool/system integrations identified in the BRD, FR-21 through FR-35.
 *
 * The Zod schema on each one doubles as the integration spec you can hand to
 * the customer's ERP team. Every call is traced.
 */

import { z } from "zod";

import { defineTool } from "../llm/tool.ts";

import {
  CROSS_BRAND_PARTS,
  LOCATIONS,
  MATERIALS,
  SUPPLIER_RESPONSES,
  VENDOR_SOURCES,
} from "./fixtures.ts";
import {
  TODAY,
  addDays,
  erpForLocation,
  erpState,
  findException,
  inventoryFor,
  lastMrpResult,
  materialByCode,
  recordAllocationChange,
  recordAppliedSubstitution,
  recordEngineeringChange,
  recordErpWrite,
  recordPaintOrder,
  recordSafetyStockChange,
  recordScheduleChange,
  recordStockTransport,
  recordVendorCommitment,
  runScopedMrp,
  substitutionsFor,
} from "./store.ts";
import { emit } from "../trace.ts";

/** Set by the agent runner so tool traces are attributed to the right agent. */
let currentAgent = "orchestrator";
export function setCurrentAgent(name: string): void {
  currentAgent = name;
}

/**
 * Wraps a tool implementation with tracing and JSON serialisation.
 * `impl` comes first so its annotated parameter drives type inference for
 * `summarise` - the other order makes the input type collapse.
 */
function traced<I, O>(
  name: string,
  fr: string,
  impl: (input: I) => O,
  summarise: (input: I, output: O) => string,
): (input: I) => string {
  return (input: I) => {
    const started = Date.now();
    const output = impl(input);
    emit({
      kind: "tool",
      agent: currentAgent,
      tool: name,
      fr,
      summary: summarise(input, output),
      ms: Date.now() - started,
    });
    return JSON.stringify(output, null, 2);
  };
}

function decorateLocation(id: string) {
  const loc = LOCATIONS.find((l) => l.id === id);
  return { locationName: loc?.name, locationKind: loc?.kind, brand: loc?.brand, erpPlatform: loc?.erp };
}

// ── FR-21 ────────────────────────────────────────────────────────────────────
export const erpMrpEngineExecution = defineTool({
  name: "erp_mrp_engine_execution",
  description:
    "FR-21. Runs the applicable SAP ECC, SAP S/4 HANA, JDE, Baan or Oasis material-planning " +
    "functions using the prepared plant inputs. Returns MRP results and ERP exception messages.",
  inputSchema: z.object({
    plant: z.string().describe("Plant or DC id, e.g. 1010"),
  }),
  run: traced(
    "erp_mrp_engine_execution",
    "FR-21",
    (input: { plant: string }) => {
      const raised = erpState().exceptions.filter((e) => e.plant === input.plant);
      return {
        plant: input.plant,
        erpPlatform: erpForLocation(input.plant),
        runAt: TODAY,
        exceptionsGenerated: raised.length,
        exceptionIds: raised.map((e) => e.exceptionId),
      };
    },
    (i, o) => `plant ${i.plant} on ${o.erpPlatform} → ${o.exceptionsGenerated} exception(s)`,
  ),
});

// ── FR-22 ────────────────────────────────────────────────────────────────────
export const erpExceptionQueueLookup = defineTool({
  name: "erp_exception_queue_lookup",
  description:
    "FR-22. Retrieves current MRP exception messages, priorities, categories, materials and " +
    "affected plant information from the relevant ERP system.",
  inputSchema: z.object({
    plant: z.string().optional().describe("Restrict to one plant; omit for all plants"),
  }),
  run: traced(
    "erp_exception_queue_lookup",
    "FR-22",
    (input: { plant?: string }) => {
      const rows = erpState().exceptions.filter((e) => !input.plant || e.plant === input.plant);
      return {
        count: rows.length,
        exceptions: rows.map((e) => ({
          ...e,
          ...decorateLocation(e.plant),
          plannedLeadTimeDays: materialByCode(e.material)?.plannedLeadTimeDays,
          materialDescription: materialByCode(e.material)?.description,
        })),
      };
    },
    (_i, o) => `${o.count} open exception(s) retrieved`,
  ),
});

// ── FR-23 ────────────────────────────────────────────────────────────────────
export const planningNetworkAndPolicyLookup = defineTool({
  name: "planning_network_and_policy_lookup",
  description:
    "FR-23. Retrieves the corrective-action reference data available to planning: supplier " +
    "confirmations, inventory by location, engineering substitution documentation, production " +
    "priorities, allocations, safety stock and cross-brand part information.",
  inputSchema: z.object({
    material: z.string(),
  }),
  run: traced(
    "planning_network_and_policy_lookup",
    "FR-23",
    (input: { material: string }) => {
      const s = erpState();
      const inventory = inventoryFor(input.material).map((r) => ({
        ...r,
        ...decorateLocation(r.location),
        availabilityIsCurrent: !r.stale,
      }));
      // Ranked and totalled, because planners read an availability summary -
      // and because an agent should not have to do arithmetic to find the
      // largest holding across the network.
      const ranked = [...inventory].sort((a, b) => b.unrestrictedQty - a.unrestrictedQty);

      return {
        material: input.material,
        materialDescription: materialByCode(input.material)?.description,
        networkAvailabilitySummary: {
          totalAcrossAllLocations: inventory.reduce((sum, r) => sum + r.unrestrictedQty, 0),
          totalAtLocationsWithCurrentData: inventory
            .filter((r) => r.availabilityIsCurrent)
            .reduce((sum, r) => sum + r.unrestrictedQty, 0),
          rankedByQuantity: ranked.map(
            (r) =>
              `${r.location} ${r.locationName} (${r.locationKind}): ${r.unrestrictedQty} units, ` +
              `availability ${r.availabilityIsCurrent ? "current" : "NOT current"}`,
          ),
        },
        inventoryByLocation: inventory,
        vendorSources: VENDOR_SOURCES.filter((v) => v.material === input.material),
        engineeringSubstitutions: substitutionsFor(input.material),
        productionPriorities: s.productionSchedule.filter((p) => p.material === input.material),
        allocations: s.allocations.filter((a) => a.material === input.material),
        safetyStock: materialByCode(input.material)?.safetyStock ?? {},
        crossBrandEquivalents: CROSS_BRAND_PARTS.filter((p) => p.material === input.material),
        crossBrandNote:
          MATERIALS.find((m) => m.material === input.material)?.description ??
          "No cross-brand information available",
      };
    },
    (i) => `reference data assembled for ${i.material}`,
  ),
});

// ── FR-24 ────────────────────────────────────────────────────────────────────
export const supplierConfirmationInterface = defineTool({
  name: "supplier_confirmation_interface",
  description:
    "FR-24. Sends a delivery-date or quantity request to a supplier and retrieves the resulting " +
    "response. The response text is the supplier's own wording - it may or may not be an " +
    "explicit commitment.",
  inputSchema: z.object({
    vendor: z.string(),
    material: z.string(),
    requestedDate: z.string().describe("ISO date, e.g. 2026-10-27"),
    requestedQty: z.number().int().positive(),
  }),
  run: traced(
    "supplier_confirmation_interface",
    "FR-24",
    (input: { vendor: string; material: string; requestedDate: string; requestedQty: number }) => {
      // The vendor must be a real vendor id, not a description of one. Without
      // this check a mislabelled request looks identical to a supplier silence.
      const known = VENDOR_SOURCES.filter((v) => v.material === input.material);
      const match = known.find((v) => v.vendor === input.vendor);
      if (!match) {
        return {
          error:
            `"${input.vendor}" is not a vendor on record for ${input.material}. Use an exact vendor id ` +
            `from the source list. Vendors for this material: ${known.map((v) => v.vendor).join(", ") || "none"}.`,
        };
      }

      const reply = SUPPLIER_RESPONSES[input.vendor];
      return {
        vendor: input.vendor,
        requestSent: { ...input, sentAt: TODAY },
        supplierResponseText: reply?.commitment ?? "No response received within the request window.",
        responseReceived: Boolean(reply),
      };
    },
    (i, o) => (o.error ? `rejected: ${o.error}` : `request sent to ${i.vendor}, response received`),
  ),
});

// ── FR-25 ────────────────────────────────────────────────────────────────────
export const erpVendorSourceLookup = defineTool({
  name: "erp_vendor_source_lookup",
  description:
    "FR-25. Retrieves available vendor-source information for the affected material from the " +
    "relevant ERP environment.",
  inputSchema: z.object({ material: z.string() }),
  run: traced(
    "erp_vendor_source_lookup",
    "FR-25",
    (input: { material: string }) => ({
      material: input.material,
      vendors: VENDOR_SOURCES.filter((v) => v.material === input.material),
    }),
    (_i, o) => `${o.vendors.length} vendor source record(s)`,
  ),
});

// ── FR-26 ────────────────────────────────────────────────────────────────────
export const erpInventoryAndStockTransportInterface = defineTool({
  name: "erp_inventory_and_stock_transport_interface",
  description:
    "FR-26. Two actions. `read_availability` retrieves inventory by location, including the " +
    "timestamp the availability figure was last refreshed and whether that feed is current. " +
    "`create_stock_transport` records a stock transport requirement from a source location.",
  inputSchema: z.object({
    action: z.enum(["read_availability", "create_stock_transport"]),
    material: z.string(),
    fromLocation: z.string().optional().describe("Required for create_stock_transport"),
    toLocation: z.string().optional().describe("Required for create_stock_transport"),
    qty: z.number().int().positive().optional().describe("Required for create_stock_transport"),
    forException: z.string().optional().describe("Exception id this transport resolves"),
  }),
  run: traced(
    "erp_inventory_and_stock_transport_interface",
    "FR-26",
    (input: {
      action: "read_availability" | "create_stock_transport";
      material: string;
      fromLocation?: string;
      toLocation?: string;
      qty?: number;
      forException?: string;
    }) => {
      if (input.action === "read_availability") {
        return {
          action: input.action,
          material: input.material,
          readAt: TODAY,
          locations: inventoryFor(input.material).map((r) => ({
            ...r,
            ...decorateLocation(r.location),
            availabilityIsCurrent: !r.stale,
          })),
        };
      }

      if (!input.fromLocation || !input.toLocation || !input.qty || !input.forException) {
        return {
          action: input.action,
          error: "create_stock_transport requires fromLocation, toLocation, qty and forException.",
        };
      }

      const source = inventoryFor(input.material).find((r) => r.location === input.fromLocation);
      if (!source) {
        return { action: input.action, error: `No inventory record for ${input.material} at ${input.fromLocation}.` };
      }
      if (source.unrestrictedQty < input.qty) {
        return {
          action: input.action,
          error: `Only ${source.unrestrictedQty} available at ${input.fromLocation}, ${input.qty} requested.`,
        };
      }

      const stockTransport = recordStockTransport({
        material: input.material,
        fromLocation: input.fromLocation,
        toLocation: input.toLocation,
        qty: input.qty,
        expectedArrival: addDays(TODAY, source.transferLeadTimeDays),
        forException: input.forException,
      });
      return {
        action: input.action,
        stockTransport,
        sourceAvailabilityAsOf: source.availabilityAsOf,
        sourceAvailabilityIsCurrent: !source.stale,
      };
    },
    (i, o) => {
      if (i.action === "read_availability") return `availability read for ${o.locations?.length ?? 0} location(s)`;
      if (o.error) return `stock transport rejected: ${o.error}`;
      return `stock transport ${o.stockTransport?.documentNo ?? "?"} created`;
    },
  ),
});

// ── FR-27 ────────────────────────────────────────────────────────────────────
export const engineeringDocumentationLookup = defineTool({
  name: "engineering_documentation_lookup",
  description:
    "FR-27. Retrieves allowable substitution information for the constrained component from the " +
    "engineering documentation system. A status of `none` means engineering has not documented " +
    "any allowable substitute.",
  inputSchema: z.object({ material: z.string() }),
  run: traced(
    "engineering_documentation_lookup",
    "FR-27",
    (input: { material: string }) => {
      const all = substitutionsFor(input.material);
      const documented = all
        .filter((s) => s.status === "documented")
        .map((s) => ({ ...s, canBeAppliedDirectly: true, requiresEngineeringApproval: false }));
      const candidates = all
        .filter((s) => s.status === "none")
        .map((s) => ({
          ...s,
          canBeAppliedDirectly: false,
          requiresEngineeringApproval: true,
          note:
            "A known candidate substitute that engineering has not yet documented as allowable. It cannot " +
            "be applied directly, but it can be put to engineering for approval as a new substitution.",
        }));

      return {
        material: input.material,
        summary:
          `${documented.length} substitute(s) documented as allowable and applicable directly; ` +
          `${candidates.length} further candidate(s) exist that would need engineering approval first.`,
        documentedSubstitutions: documented,
        candidatesRequiringEngineeringApproval: candidates,
      };
    },
    (_i, o) =>
      `${o.documentedSubstitutions.length} documented, ${o.candidatesRequiringEngineeringApproval.length} needing approval`,
  ),
});

// ── FR-28 ────────────────────────────────────────────────────────────────────
export const engineeringChangeManagementInitiation = defineTool({
  name: "engineering_change_management_initiation",
  description:
    "FR-28. Creates the approved substitution change in the Engineering Change Management " +
    "process. Requires the reference of an explicit engineering approval decision.",
  inputSchema: z.object({
    material: z.string(),
    substitute: z.string(),
    decisionRef: z.string().describe("Reference of the engineering approval decision"),
    forException: z.string().describe("Exception id this change resolves"),
  }),
  run: traced(
    "engineering_change_management_initiation",
    "FR-28",
    (input: { material: string; substitute: string; decisionRef: string; forException: string }) => {
      if (input.decisionRef.trim().length === 0) {
        return { error: "An explicit approval decision reference is required (NFR-20)." };
      }
      return { engineeringChange: recordEngineeringChange(input) };
    },
    (_i, o) =>
      "error" in o ? `rejected: ${o.error}` : `engineering change ${o.engineeringChange.changeNo} created`,
  ),
});

// ── FR-29 ────────────────────────────────────────────────────────────────────
export const erpPaintProductionOrderCreation = defineTool({
  name: "erp_paint_production_order_creation",
  description: "FR-29. Creates the production order required to repaint an approved shared component.",
  inputSchema: z.object({
    material: z.string(),
    targetPartNo: z.string().describe("The cross-brand equivalent part being converted"),
    qty: z.number().int().positive(),
    forException: z.string().describe("Exception id this conversion resolves"),
  }),
  run: traced(
    "erp_paint_production_order_creation",
    "FR-29",
    (input: { material: string; targetPartNo: string; qty: number; forException: string }) => ({
      paintOrder: recordPaintOrder(input.material, input.targetPartNo, input.qty, input.forException),
    }),
    (_i, o) => `paint order ${o.paintOrder.orderNo} issued, usable by ${o.paintOrder.availableBy}`,
  ),
});

// ── FR-30 ────────────────────────────────────────────────────────────────────
export const erpProductionScheduleUpdate = defineTool({
  name: "erp_production_schedule_update",
  description:
    "FR-30. Retrieves and updates affected plant production schedules and production-order timing. " +
    "Omit `newPriority` to read the current schedule.",
  inputSchema: z.object({
    plant: z.string(),
    order: z.string().optional(),
    newPriority: z.number().int().optional().describe("Higher number = lower priority"),
    forException: z.string().optional().describe("Exception id this change resolves; required when updating"),
  }),
  run: traced(
    "erp_production_schedule_update",
    "FR-30",
    (input: { plant: string; order?: string; newPriority?: number; forException?: string }) => {
      if (input.order && input.newPriority !== undefined) {
        if (!input.forException) {
          return { error: "forException is required when changing a schedule, so the change is attributable." };
        }
        const scheduleChange = recordScheduleChange(input.order, input.newPriority, input.forException);
        return scheduleChange
          ? { scheduleChange }
          : { error: `Unknown production order ${input.order}.` };
      }
      return {
        plant: input.plant,
        orders: erpState().productionSchedule.filter((p) => p.plant === input.plant),
      };
    },
    (_i, o) => {
      if (o.error) return `rejected: ${o.error}`;
      const c = o.scheduleChange;
      if (c) return `order ${c.order} priority ${c.before} → ${c.after}`;
      return `${o.orders?.length ?? 0} production order(s) read`;
    },
  ),
});

// ── FR-31 ────────────────────────────────────────────────────────────────────
export const erpDealerAndCustomerAllocationUpdate = defineTool({
  name: "erp_dealer_and_customer_allocation_update",
  description:
    "FR-31. Retrieves current dealer and customer allocations and records a selected change for " +
    "scarce parts, assemblies or whole machines. Omit `newQty` to read.",
  inputSchema: z.object({
    material: z.string(),
    allocationId: z.string().optional(),
    newQty: z.number().int().nonnegative().optional(),
    forException: z.string().optional().describe("Exception id this change resolves; required when updating"),
  }),
  run: traced(
    "erp_dealer_and_customer_allocation_update",
    "FR-31",
    (input: { material: string; allocationId?: string; newQty?: number; forException?: string }) => {
      if (input.allocationId && input.newQty !== undefined) {
        if (!input.forException) {
          return { error: "forException is required when changing an allocation, so the change is attributable." };
        }
        const allocationChange = recordAllocationChange(input.allocationId, input.newQty, input.forException);
        return allocationChange ? { allocationChange } : { error: `Unknown allocation ${input.allocationId}.` };
      }
      return {
        material: input.material,
        allocations: erpState().allocations.filter((a) => a.material === input.material),
      };
    },
    (_i, o) => {
      if (o.error) return `rejected: ${o.error}`;
      const c = o.allocationChange;
      if (c) return `allocation ${c.allocationId} ${c.before} → ${c.after}`;
      return `${o.allocations?.length ?? 0} allocation(s) read`;
    },
  ),
});

// ── FR-32 ────────────────────────────────────────────────────────────────────
export const erpSafetyStockParameterUpdate = defineTool({
  name: "erp_safety_stock_parameter_update",
  description:
    "FR-32. Retrieves current safety-stock parameters and records a selected temporary change. " +
    "Omit `newLevel` to read.",
  inputSchema: z.object({
    material: z.string(),
    location: z.string(),
    newLevel: z.number().int().nonnegative().optional(),
    temporary: z.boolean().optional().describe("Must be true - these changes are temporary (NFR-28)"),
    forException: z.string().optional().describe("Exception id this change resolves; required when updating"),
  }),
  run: traced(
    "erp_safety_stock_parameter_update",
    "FR-32",
    (input: {
      material: string;
      location: string;
      newLevel?: number;
      temporary?: boolean;
      forException?: string;
    }) => {
      if (input.newLevel === undefined) {
        return {
          material: input.material,
          location: input.location,
          currentLevel: materialByCode(input.material)?.safetyStock[input.location] ?? 0,
        };
      }
      if (input.temporary !== true) {
        return { error: "Safety-stock changes on this path must be recorded as temporary (NFR-28)." };
      }
      if (!input.forException) {
        return { error: "forException is required when changing safety stock, so the change is attributable." };
      }
      return {
        safetyStockChange: recordSafetyStockChange(
          input.material,
          input.location,
          input.newLevel,
          true,
          input.forException,
        ),
      };
    },
    (_i, o) => {
      if (o.error) return `rejected: ${o.error}`;
      const c = o.safetyStockChange;
      if (c) return `safety stock ${c.from} → ${c.to} (temporary), ${c.released} units released`;
      return `safety stock read: ${o.currentLevel}`;
    },
  ),
});

// ── FR-33 ────────────────────────────────────────────────────────────────────
export const erpTransactionAndMasterDataUpdate = defineTool({
  name: "erp_transaction_and_master_data_update",
  description:
    "FR-33. Two actions. `read_current_state` returns the current planning picture for a material at " +
    "a plant - use it to establish the 'before' value you need. `write_change` writes a validated " +
    "transaction or planning master-data change to the applicable ERP platform and returns the " +
    "resulting status. Every write is recorded with a before-and-after value and a justification " +
    "(NFR-31), so read before you write.",
  inputSchema: z.object({
    action: z.enum(["read_current_state", "write_change"]),
    plant: z.string(),
    material: z.string().describe("Required for read_current_state"),
    changeType: z
      .string()
      .optional()
      .describe("For write_change: e.g. stock transport confirmation, planned receipt, MRP element"),
    objectRef: z.string().optional().describe("For write_change: the ERP object changed, e.g. STO-00001"),
    before: z.string().optional().describe("For write_change: the value before this change"),
    after: z.string().optional().describe("For write_change: the value after this change"),
    justification: z
      .string()
      .optional()
      .describe("For write_change: the corrective result that justifies this write (NFR-30)"),
  }),
  run: traced(
    "erp_transaction_and_master_data_update",
    "FR-33",
    (input: {
      action: "read_current_state" | "write_change";
      plant: string;
      material: string;
      changeType?: string;
      objectRef?: string;
      before?: string;
      after?: string;
      justification?: string;
    }) => {
      const s = erpState();

      if (input.action === "read_current_state") {
        return {
          action: input.action,
          plant: input.plant,
          material: input.material,
          erpPlatform: erpForLocation(input.plant),
          onHandAtPlant:
            inventoryFor(input.material).find((r) => r.location === input.plant)?.unrestrictedQty ?? 0,
          plannedReceipts: s.stockTransports
            .filter((t) => t.material === input.material && t.toLocation === input.plant)
            .map((t) => `${t.documentNo}: ${t.qty} units from ${t.fromLocation}, ETA ${t.expectedArrival}`),
          appliedSubstitutions: s.appliedSubstitutions.filter((x) => x.material === input.material),
          safetyStock: materialByCode(input.material)?.safetyStock[input.plant] ?? 0,
          safetyStockOverrides: s.safetyStockOverrides.filter(
            (o) => o.material === input.material && o.location === input.plant,
          ),
          engineeringChanges: s.engineeringChanges.filter((c) => c.material === input.material),
          existingWrites: s.erpWrites.map((w) => `${w.documentNo}: ${w.changeType} on ${w.objectRef}`),
        };
      }

      const missing = [
        !input.changeType && "changeType",
        !input.objectRef && "objectRef",
        input.before === undefined && "before",
        input.after === undefined && "after",
        !input.justification && "justification",
      ].filter(Boolean);
      if (missing.length > 0) {
        return {
          action: input.action,
          error:
            `write_change requires ${missing.join(", ")}. Call read_current_state first to establish ` +
            `the before value (NFR-31).`,
        };
      }

      return {
        action: input.action,
        erpUpdateStatus: "confirmed" as const,
        erpPlatform: erpForLocation(input.plant),
        write: recordErpWrite({
          erp: erpForLocation(input.plant),
          plant: input.plant,
          changeType: input.changeType!,
          objectRef: input.objectRef!,
          before: input.before!,
          after: input.after!,
          justification: input.justification!,
        }),
      };
    },
    (i, o) => {
      if (i.action === "read_current_state") {
        return `current state read for ${i.material} at ${i.plant}: ${o.onHandAtPlant ?? 0} on hand, ${o.plannedReceipts?.length ?? 0} planned receipt(s)`;
      }
      if (o.error) return `rejected: ${o.error}`;
      return `${o.write?.documentNo} → ${o.erpPlatform}: ${o.erpUpdateStatus}`;
    },
  ),
});

// ── FR-34 ────────────────────────────────────────────────────────────────────
export const erpScopedMrpExecution = defineTool({
  name: "erp_scoped_mrp_execution",
  description:
    "FR-34. Runs MRP for the selected material, plant, or group of affected plants, distribution " +
    "centres and warehouses. Returns the recalculated result for the exception.",
  inputSchema: z.object({
    exceptionId: z.string(),
    scope: z.enum(["material", "plant", "multi_location"]),
    locations: z
      .array(z.string())
      .min(1)
      .describe(
        "Plant or distribution-centre ids to include, e.g. [\"1010\", \"8010\"]. These are location " +
          "ids from the planning network, never material numbers.",
      ),
  }),
  run: traced(
    "erp_scoped_mrp_execution",
    "FR-34",
    (input: { exceptionId: string; scope: "material" | "plant" | "multi_location"; locations: string[] }) => {
      // NFR-34: the run must stay inside the real location scope. Reject invented
      // or mistyped ids rather than silently "running" against nothing.
      const knownIds = LOCATIONS.map((l) => l.id);
      const unknown = input.locations.filter((id) => !knownIds.includes(id));
      if (unknown.length > 0) {
        return {
          error:
            `Unknown location id(s): ${unknown.join(", ")}. Locations are plant or DC ids, not material ` +
            `numbers. Valid ids: ${LOCATIONS.map((l) => `${l.id} (${l.name})`).join(", ")}.`,
        };
      }

      const exception = findException(input.exceptionId);
      if (exception && !input.locations.includes(exception.plant)) {
        return {
          error:
            `The affected plant ${exception.plant} is not in the requested scope. A replanning run has to ` +
            `include the plant that raised the exception (NFR-33).`,
        };
      }

      return runScopedMrp(input.exceptionId, input.scope, input.locations);
    },
    (i, o) =>
      "error" in o
        ? `rejected: ${o.error}`
        : `${i.scope} run over [${i.locations.join(", ")}] → residual shortage ${o.residualShortageQty}`,
  ),
});

// ── FR-35 ────────────────────────────────────────────────────────────────────
export const erpMrpResultsLookup = defineTool({
  name: "erp_mrp_results_lookup",
  description:
    "FR-35. Retrieves updated material plans and exception messages for the material and " +
    "locations included in the replanning run. Read-only.",
  inputSchema: z.object({ exceptionId: z.string() }),
  run: traced(
    "erp_mrp_results_lookup",
    "FR-35",
    (input: { exceptionId: string }) => ({
      result: lastMrpResult(input.exceptionId),
      originalException: findException(input.exceptionId),
    }),
    (_i, o) =>
      "error" in o.result
        ? `no results yet: ${o.result.error}`
        : `residual shortage ${o.result.residualShortageQty} of ${o.result.originalShortageQty}`,
  ),
});

/**
 * Supports FR-05 and FR-06. Records supply against the exception on the
 * strength of a supplier commitment.
 *
 * NFR-10 says only explicit commitments count as confirmed, so this tool
 * deliberately asks the agent to quote the supplier's own words alongside its
 * reading of them - a hedge like "we'll do our best" cannot be quoted as an
 * explicit commitment without the contradiction being visible in the trace.
 */
export const recordSupplierCommitment = defineTool({
  name: "record_supplier_commitment",
  description:
    "Records a supplier's confirmed delivery commitment as supply against the exception. Only call " +
    "this when the supplier has given an explicit commitment to a quantity and a date. Do not call " +
    "it for a hedge, an intention, or a best-effort statement.",
  inputSchema: z.object({
    vendor: z.string(),
    qty: z.number().int().positive(),
    committedDate: z.string().describe("The date the supplier explicitly committed to, ISO format"),
    supplierWording: z.string().describe("The supplier's exact words, quoted from their response"),
    forException: z.string(),
  }),
  run: traced(
    "record_supplier_commitment",
    "FR-05",
    (input: {
      vendor: string;
      qty: number;
      committedDate: string;
      supplierWording: string;
      forException: string;
    }) => ({
      commitment: recordVendorCommitment(input.vendor, input.qty, input.committedDate, input.forException),
      recordedWording: input.supplierWording,
    }),
    (i) => `${i.qty} units committed by ${i.vendor} for ${i.committedDate}`,
  ),
});

/** Supports FR-08: marks an engineering-documented substitution as applied. */
export const applyDocumentedSubstitution = defineTool({
  name: "apply_documented_substitution",
  description:
    "Applies a substitution that engineering has already documented. Only call this for a " +
    "substitute whose documentation status is `documented`.",
  inputSchema: z.object({
    material: z.string(),
    substitute: z.string(),
    engineeringReference: z.string(),
    forException: z.string().describe("Exception id this substitution resolves"),
  }),
  run: traced(
    "apply_documented_substitution",
    "FR-08",
    (input: { material: string; substitute: string; engineeringReference: string; forException: string }) => {
      const doc = substitutionsFor(input.material).find(
        (s) => s.substitute === input.substitute && s.status === "documented",
      );
      if (!doc) {
        return { error: `No documented substitution ${input.substitute} exists for ${input.material} (NFR-16).` };
      }
      recordAppliedSubstitution(input.material, input.substitute, input.forException);
      return {
        applied: true as const,
        engineeringReference: doc.engineeringReference,
        restrictions: doc.restrictions,
      };
    },
    (i, o) =>
      "error" in o ? `rejected: ${o.error}` : `${i.substitute} applied under ${o.engineeringReference}`,
  ),
});
