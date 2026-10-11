/**
 * The workflow.
 *
 * Note the division of labour, because it is the governance point of the demo:
 * the *recommendation* is made by an agent (FR-03), but the *routing* of that
 * recommendation is deterministic code here (FR-04 / BR-01, performed by the
 * "Workflow Service"). Same for the terminal outcome (FR-20 / BR-02). Agents
 * supply judgment; the process supplies control flow.
 */

import { z } from "zod";

import { runAgent, type AgentOutcome } from "./agents/run.ts";
import {
  ALTERNATE_SOURCING,
  CROSS_BRAND_COMPONENT_PLANNING,
  ENGINEERING_CHANGE_EXECUTION,
  ENGINEERING_SUBSTITUTION_PREPARATION,
  ERP_PLANNING_CHANGE,
  INVENTORY_TRANSFER,
  MATERIAL_PLANNING_EXECUTION,
  MATERIAL_SUBSTITUTION,
  MRP_CORRECTIVE_ACTION,
  MRP_EXCEPTION_TRIAGE,
  MRP_REPLANNING_SCOPE,
  MRP_RESULTS_RESOLUTION,
  PRODUCTION_SCHEDULE_RECOVERY,
  SAFETY_STOCK_RESOLUTION,
  SCARCE_SUPPLY_ALLOCATION,
  SUPPLIER_RECOVERY,
} from "./agents/registry.ts";
import { findException } from "./erp/store.ts";
import { emit } from "./trace.ts";

/** BR-01's nine supported corrective paths, exactly as the BRD lists them. */
export const CORRECTIVE_PATHS = [
  "supplier_delivery_or_quantity_change",
  "alternate_vendor",
  "alternate_inventory",
  "documented_substitution",
  "new_substitution",
  "cross_brand_conversion",
  "production_schedule_change",
  "allocation_change",
  "safety_stock_change",
] as const;

export type CorrectivePath = (typeof CORRECTIVE_PATHS)[number];

/**
 * What each path actually means, from the BRD's routing table (§6, BR-01).
 *
 * Without these the recommending agent sees nine bare enum names and has to
 * guess. The `new_substitution` line matters most: NFR-08 forbids *bypassing*
 * engineering approval, and an agent reading only the guardrail can conclude
 * the path itself is off limits, when in fact it is the path that routes
 * through the approval gate.
 */
const PATH_DEFINITIONS: Record<CorrectivePath, string> = {
  supplier_delivery_or_quantity_change:
    "Ask the supplier already on the order to improve the delivery date or the quantity.",
  alternate_vendor:
    "Source from a different vendor that the source data already represents as applicable for this material.",
  alternate_inventory:
    "Transfer usable stock in from another plant, distribution centre or warehouse in the network.",
  documented_substitution:
    "Apply a substitute component that engineering has already documented as allowable for this use.",
  new_substitution:
    "Propose a substitute that engineering has NOT yet documented. This path runs through the mandatory " +
    "engineering approval gate, so selecting it is not a bypass of that approval - it is how approval is " +
    "obtained. It is the correct choice when no documented substitute exists but a candidate component does.",
  cross_brand_conversion:
    "Convert a common component from another AGCO brand for this use, including any repaint required.",
  production_schedule_change:
    "Reprioritise production so the scarce component goes to higher-priority orders first.",
  allocation_change: "Rebalance dealer and customer allocations of the scarce supply.",
  safety_stock_change: "Temporarily lower safety stock to release constrained supply.",
};

export type HumanDecision = "approved" | "changes_requested" | "rejected";

export interface LaneResult {
  outcome: "resolved_or_reduced" | "still_unresolved" | "escalated";
  detail: string;
  path?: CorrectivePath;
}

// ── Structured agent outputs ─────────────────────────────────────────────────

const TriageSchema = z.object({
  topExceptionId: z.string().describe("The exception that needs attention first"),
  prioritised: z
    .array(
      z.object({
        exceptionId: z.string(),
        sourcePriority: z.string().describe("The priority as the source system reported it"),
        workingPriority: z.number().int().describe("1 = most urgent"),
        impactSummary: z.string(),
        basis: z.string().describe("The demand, lead-time or availability data behind this ordering"),
      }),
    )
    .describe("Every open exception, none omitted"),
});

const RecommendationSchema = z.object({
  exceptionId: z.string(),
  recommendedPath: z.enum(CORRECTIVE_PATHS),
  rationale: z.string(),
  supportingEvidence: z.array(z.string()).describe("Specific facts from tool results that support this path"),
  alternativesRejected: z.array(z.object({ path: z.enum(CORRECTIVE_PATHS), whyNot: z.string() })),
});

const InventoryTransferSchema = z.object({
  sourcedFromLocation: z.string(),
  qty: z.number().int(),
  stockTransportDocumentNo: z.string(),
  expectedArrival: z.string(),
  availabilityAsOf: z.string().describe("The timestamp of the availability result you relied on"),
});

const DocumentedSubstitutionSchema = z.object({
  substitute: z.string(),
  engineeringReference: z.string(),
  restrictionsChecked: z.string().describe("The documented restrictions and why this use is within them"),
});

const PreparationSchema = z.object({
  affectedMaterial: z.string(),
  proposedSubstitute: z.string(),
  engineeringSupportAvailable: z.string(),
  gapsForEngineering: z.array(z.string()),
  approvalStatus: z
    .literal("not_approved")
    .describe("Must be not_approved - this package is a request for a decision, nothing more"),
});

const ChangeExecutionSchema = z.object({
  engineeringChangeNo: z.string(),
  substitute: z.string(),
  decisionRef: z.string(),
});

const ErpChangeSchema = z.object({
  status: z.enum(["confirmed", "stopped"]),
  writes: z.array(z.object({ documentNo: z.string(), objectRef: z.string(), before: z.string(), after: z.string() })),
  justification: z.string(),
});

const ReplanSchema = z.object({
  scope: z.enum(["material", "plant", "multi_location"]),
  locations: z.array(z.string()),
  runId: z.string(),
  residualShortageQty: z.number().int(),
  scopeJustification: z.string(),
});

const SupplierCommitmentSchema = z.object({
  vendor: z.string(),
  committedQty: z.number().int(),
  committedDate: z.string(),
  supplierWording: z.string().describe("The supplier's exact words that make this an explicit commitment"),
});

const AlternateVendorSchema = z.object({
  vendor: z.string(),
  committedQty: z.number().int(),
  committedDate: z.string(),
  applicabilityEvidence: z.string().describe("What in the source data shows this vendor is applicable"),
});

const CrossBrandSchema = z.object({
  equivalentPart: z.string(),
  qty: z.number().int(),
  requiredColour: z.string(),
  paintOrderNo: z.string(),
  bomEvidence: z.string().describe("The documented alternate BOM that makes this conversion supportable"),
});

const ScheduleRecoverySchema = z.object({
  order: z.string(),
  fromPriority: z.number().int(),
  toPriority: z.number().int(),
  unitsProtected: z.number().int(),
  priorityEvidence: z.string().describe("The order priorities that support delaying this consumption"),
});

const AllocationSchema = z.object({
  allocationId: z.string(),
  fromQty: z.number().int(),
  toQty: z.number().int(),
  unitsFreed: z.number().int(),
  allocationEvidence: z.string().describe("The current allocations and priorities behind this change"),
});

const SafetyStockSchema = z.object({
  location: z.string(),
  fromLevel: z.number().int(),
  toLevel: z.number().int(),
  unitsReleased: z.number().int(),
  temporary: z.literal(true).describe("Must be true - this change is temporary (NFR-28)"),
});

const ValidationSchema = z.object({
  outcome: z.enum(["resolved_or_reduced", "still_unresolved"]),
  residualShortageQty: z.number().int(),
  comparedAgainst: z.string().describe("The original exception and the corrective action applied"),
  unsynchronisedLocations: z.array(z.string()),
  details: z.string(),
});

// ── Helpers ──────────────────────────────────────────────────────────────────

function escalatedResult(stage: string, outcome: Extract<AgentOutcome<never>, { status: "escalated" }>): LaneResult {
  return {
    outcome: "escalated",
    detail: `${stage} escalated under ${outcome.nfr}: ${outcome.reason}`,
  };
}

/** Either the corrective action succeeded with a summary, or the lane ends here. */
type CorrectiveResult = { summary: string } | { halt: LaneResult };

// ── FR-05..FR-16: the nine corrective branches ───────────────────────────────

async function executeCorrectivePath(
  path: CorrectivePath,
  exception: NonNullable<ReturnType<typeof findException>>,
  humanDecision: HumanDecision,
): Promise<CorrectiveResult> {
  const context =
    `Exception ${exception.exceptionId}: ${exception.shortageQty} units of ${exception.material} short at ` +
    `plant ${exception.plant}, required by ${exception.requiredByDate}. Affected demand: ` +
    `${exception.affectedDemand}.`;

  switch (path) {
    // FR-05 ─ Negotiate and reconcile supplier commitment changes
    case "supplier_delivery_or_quantity_change": {
      const outcome = await runAgent({
        spec: SUPPLIER_RECOVERY,
        submitToolName: "submit_supplier_resolution",
        submitToolDescription: "Report the supplier's confirmed commitment.",
        resultSchema: SupplierCommitmentSchema,
        task:
          `${context}\n\nRequest a delivery-date or quantity change from the vendor on the current plan ` +
          `(${exception.material}'s primary source) and reconcile what comes back.`,
      });
      if (outcome.status === "escalated") return { halt: escalatedResult("Supplier recovery", outcome) };
      return {
        summary:
          `${outcome.result.vendor} committed ${outcome.result.committedQty} units by ` +
          `${outcome.result.committedDate}`,
      };
    }

    // FR-06 ─ Resolve shortage through an applicable alternate vendor
    case "alternate_vendor": {
      const outcome = await runAgent({
        spec: ALTERNATE_SOURCING,
        submitToolName: "submit_alternate_vendor",
        submitToolDescription: "Report the applicable alternate vendor and its confirmed commitment.",
        resultSchema: AlternateVendorSchema,
        task: `${context}\n\nFind an applicable alternate vendor for this material and confirm what it can supply.`,
      });
      if (outcome.status === "escalated") return { halt: escalatedResult("Alternate sourcing", outcome) };
      return {
        summary:
          `alternate vendor ${outcome.result.vendor} committed ${outcome.result.committedQty} units by ` +
          `${outcome.result.committedDate}`,
      };
    }

    // FR-07 ─ Find and reserve alternate inventory across locations
    case "alternate_inventory": {
      const outcome = await runAgent({
        spec: INVENTORY_TRANSFER,
        submitToolName: "submit_stock_transport",
        submitToolDescription: "Report the stock transport you created and the availability result behind it.",
        resultSchema: InventoryTransferSchema,
        task:
          `${context}\n\nSearch the plant and distribution network for usable stock and, where a source is ` +
          `supportable, create the stock transport.`,
      });
      if (outcome.status === "escalated") return { halt: escalatedResult("Inventory sourcing", outcome) };
      return {
        summary:
          `${outcome.result.qty} units sourced from ${outcome.result.sourcedFromLocation} on ` +
          `${outcome.result.stockTransportDocumentNo}, arriving ${outcome.result.expectedArrival}`,
      };
    }

    // FR-08 ─ Validate and apply a documented material substitute
    case "documented_substitution": {
      const outcome = await runAgent({
        spec: MATERIAL_SUBSTITUTION,
        submitToolName: "submit_applied_substitution",
        submitToolDescription: "Report the documented substitution you validated and applied.",
        resultSchema: DocumentedSubstitutionSchema,
        task:
          `${context}\n\nCheck engineering documentation for an allowable substitute and apply it only if ` +
          `the documentation supports this particular use.`,
      });
      if (outcome.status === "escalated") return { halt: escalatedResult("Substitution validation", outcome) };
      return { summary: `${outcome.result.substitute} applied under ${outcome.result.engineeringReference}` };
    }

    // FR-09, FR-10 (human), FR-11 ─ New substitution
    case "new_substitution": {
      const prep = await runAgent({
        spec: ENGINEERING_SUBSTITUTION_PREPARATION,
        submitToolName: "submit_decision_package",
        submitToolDescription: "Report the decision package for engineering. It is a request, not an approval.",
        resultSchema: PreparationSchema,
        task:
          `${context}\n\nNo documented substitute is available. Assemble the package engineering needs to ` +
          `decide whether a new allowable substitution can be released.`,
      });
      if (prep.status === "escalated") return { halt: escalatedResult("Substitution preparation", prep) };

      // FR-10 ─ The one human gate in the future state.
      emit({
        kind: "human_gate",
        fr: "FR-10",
        gate: "Approve the proposed new material substitution",
        actor: "Engineering",
        outcome: `${humanDecision} — ${prep.result.proposedSubstitute} for ${prep.result.affectedMaterial}`,
      });

      if (humanDecision !== "approved") {
        return {
          halt: {
            outcome: "still_unresolved",
            path,
            detail:
              `Engineering returned "${humanDecision}" at the FR-10 gate. The agents hold; nothing was ` +
              `written to ERP and no substitution was applied.`,
          },
        };
      }

      const decisionRef = `ENG-DEC-${exception.exceptionId}`;
      const execution = await runAgent({
        spec: ENGINEERING_CHANGE_EXECUTION,
        submitToolName: "submit_engineering_change",
        submitToolDescription: "Report the Engineering Change Management record you created.",
        resultSchema: ChangeExecutionSchema,
        task:
          `Engineering has approved ${prep.result.proposedSubstitute} as a new allowable substitution for ` +
          `${prep.result.affectedMaterial} (exception ${exception.exceptionId}). The approval decision ` +
          `reference is ${decisionRef}. Initiate the Engineering Change Management process for exactly ` +
          `that substitute.`,
      });
      if (execution.status === "escalated") {
        return { halt: escalatedResult("Engineering change execution", execution) };
      }
      return {
        summary:
          `engineering change ${execution.result.engineeringChangeNo} initiated for ` +
          `${execution.result.substitute} under ${execution.result.decisionRef}`,
      };
    }

    // FR-12 ─ Validate shared-part conversion and issue a paint order
    case "cross_brand_conversion": {
      const outcome = await runAgent({
        spec: CROSS_BRAND_COMPONENT_PLANNING,
        submitToolName: "submit_conversion_plan",
        submitToolDescription: "Report the validated conversion and the paint order you issued.",
        resultSchema: CrossBrandSchema,
        task:
          `${context}\n\nCheck whether a common component from another AGCO brand can be converted for ` +
          `this use, and issue the paint order only if the conversion is supported by documentation.`,
      });
      if (outcome.status === "escalated") return { halt: escalatedResult("Cross-brand conversion", outcome) };
      return {
        summary:
          `${outcome.result.qty} units converted from ${outcome.result.equivalentPart} under paint order ` +
          `${outcome.result.paintOrderNo}`,
      };
    }

    // FR-14 ─ Protect scarce components through schedule reprioritization
    case "production_schedule_change": {
      const outcome = await runAgent({
        spec: PRODUCTION_SCHEDULE_RECOVERY,
        submitToolName: "submit_schedule_change",
        submitToolDescription: "Report the schedule change and the units it protects.",
        resultSchema: ScheduleRecoverySchema,
        task:
          `${context}\n\nCompare the production-order priorities at this plant and, where the priorities ` +
          `support it, delay a lower-priority order's consumption to protect the higher-priority demand.`,
      });
      if (outcome.status === "escalated") return { halt: escalatedResult("Schedule recovery", outcome) };
      return {
        summary:
          `${outcome.result.unitsProtected} units protected by moving ${outcome.result.order} from ` +
          `priority ${outcome.result.fromPriority} to ${outcome.result.toPriority}`,
      };
    }

    // FR-15 ─ Rebalance scarce supply across dealers and customers
    case "allocation_change": {
      const outcome = await runAgent({
        spec: SCARCE_SUPPLY_ALLOCATION,
        submitToolName: "submit_allocation_change",
        submitToolDescription: "Report the allocation change and the units it frees.",
        resultSchema: AllocationSchema,
        task:
          `${context}\n\nReview the current dealer and customer allocations for this material and rebalance ` +
          `them where the available priorities establish a defensible change.`,
      });
      if (outcome.status === "escalated") return { halt: escalatedResult("Allocation rebalancing", outcome) };
      return {
        summary:
          `${outcome.result.unitsFreed} units freed by changing allocation ${outcome.result.allocationId} ` +
          `from ${outcome.result.fromQty} to ${outcome.result.toQty}`,
      };
    }

    // FR-16 ─ Release constrained supply through temporary safety-stock changes
    case "safety_stock_change": {
      const outcome = await runAgent({
        spec: SAFETY_STOCK_RESOLUTION,
        submitToolName: "submit_safety_stock_change",
        submitToolDescription: "Report the temporary safety-stock change and the units it releases.",
        resultSchema: SafetyStockSchema,
        task:
          `${context}\n\nAssess the safety-stock parameters at the affected location and, where it is ` +
          `supportable, release constrained supply through a temporary change.`,
      });
      if (outcome.status === "escalated") return { halt: escalatedResult("Safety-stock resolution", outcome) };
      return {
        summary:
          `${outcome.result.unitsReleased} units released at ${outcome.result.location} by temporarily ` +
          `lowering safety stock from ${outcome.result.fromLevel} to ${outcome.result.toLevel}`,
      };
    }
  }
}

// ── The lane ─────────────────────────────────────────────────────────────────

export async function resolveException(opts: {
  exceptionId: string;
  humanDecision?: HumanDecision;
}): Promise<LaneResult> {
  const exception = findException(opts.exceptionId);
  if (!exception) return { outcome: "escalated", detail: `Unknown exception ${opts.exceptionId}` };

  // FR-01 ─ Resolve planning-input issues and execute plant MRP
  const planning = await runAgent({
    spec: MATERIAL_PLANNING_EXECUTION,
    submitToolName: "submit_mrp_run",
    submitToolDescription: "Report the completed MRP run for the plant.",
    resultSchema: z.object({
      plant: z.string(),
      erpPlatform: z.string(),
      exceptionIds: z.array(z.string()),
    }),
    task:
      `Material planning is required for plant ${exception.plant}. Execute MRP on the ERP platform that ` +
      `owns that plant and report which exceptions it generated.`,
  });
  if (planning.status === "escalated") return escalatedResult("Planning", planning);

  // FR-02 ─ Prioritize MRP exceptions by impact and urgency
  const triage = await runAgent({
    spec: MRP_EXCEPTION_TRIAGE,
    submitToolName: "submit_prioritised_exceptions",
    submitToolDescription: "Report every open exception in working-priority order.",
    resultSchema: TriageSchema,
    task:
      `MRP has run and generated exceptions for plant ${exception.plant}. Read the exception queue, pull ` +
      `whatever demand, lead-time and availability context you need, and prioritise. Report all of them.`,
  });
  if (triage.status === "escalated") return escalatedResult("Triage", triage);

  emit({
    kind: "note",
    text: `Working order: ${triage.result.prioritised
      .sort((a, b) => a.workingPriority - b.workingPriority)
      .map((e) => `${e.exceptionId}(p${e.workingPriority})`)
      .join(" → ")}`,
  });

  // FR-03 ─ Recommend the best supported MRP corrective action
  const recommendation = await runAgent({
    spec: MRP_CORRECTIVE_ACTION,
    submitToolName: "submit_corrective_recommendation",
    submitToolDescription: "Report the single most feasible documented corrective path, with evidence.",
    resultSchema: RecommendationSchema,
    task:
      `Exception ${exception.exceptionId}: ${exception.category} on material ${exception.material} at plant ` +
      `${exception.plant}. Short by ${exception.shortageQty} units, required by ${exception.requiredByDate}, ` +
      `earliest supply on the current plan is ${exception.earliestSupplyDate}. Affected demand: ` +
      `${exception.affectedDemand}.\n\n` +
      `Investigate the planning network and recommend exactly one of the nine supported corrective paths. ` +
      `Consider each path against the data you retrieve, and record why you rejected the ones you rejected.\n\n` +
      `The nine paths:\n` +
      CORRECTIVE_PATHS.map((p) => `  - ${p}: ${PATH_DEFINITIONS[p]}`).join("\n") +
      `\n\nYour recommendation has to be a path that can plausibly close this shortage by ` +
      `${exception.requiredByDate} on the evidence you have. If a path's own lead time or available ` +
      `quantity cannot meet that date, reject it on those grounds rather than recommending it as the best ` +
      `of a bad set. Exactly one path is executed, so do not pick one as a first attempt.\n\n` +
      `When a rejection rests on a quantity or a date, quote the figure and where it came from. The network ` +
      `includes distribution centres as well as plants, so check every location the tools return, not just ` +
      `the plants.`,
  });
  if (recommendation.status === "escalated") return escalatedResult("Corrective-action selection", recommendation);

  const path = recommendation.result.recommendedPath;

  // FR-04 ─ BR-01. Deterministic routing, performed by the Workflow Service.
  emit({
    kind: "decision",
    rule: "BR-01",
    question: "Which supported corrective path should be executed?",
    outcome: `${path} — ${recommendation.result.rationale}`,
  });
  for (const alt of recommendation.result.alternativesRejected) {
    emit({ kind: "note", text: `rejected ${alt.path}: ${alt.whyNot}` });
  }

  // FR-05..FR-16 ─ Corrective action. Only the routed branch runs.
  const corrective = await executeCorrectivePath(path, exception, opts.humanDecision ?? "approved");
  if ("halt" in corrective) return { ...corrective.halt, path };
  const correctiveSummary = corrective.summary;

  // FR-17 ─ Translate the resolution into controlled ERP changes
  const erpChange = await runAgent({
    spec: ERP_PLANNING_CHANGE,
    submitToolName: "submit_erp_changes",
    submitToolDescription: "Report the ERP writes you made, with before and after values.",
    resultSchema: ErpChangeSchema,
    task:
      `The corrective action for exception ${exception.exceptionId} is complete: ${correctiveSummary}. ` +
      `The affected material is ${exception.material} at plant ${exception.plant}.\n\n` +
      `Read the current ERP state for that material and plant first, so your before value is the real one, ` +
      `then write the resulting transaction or planning master-data change to the ERP platform that owns ` +
      `the plant.`,
  });
  if (erpChange.status === "escalated") return escalatedResult("ERP update", erpChange);

  // FR-18 ─ Choose and execute the required MRP replanning scope
  const replan = await runAgent({
    spec: MRP_REPLANNING_SCOPE,
    submitToolName: "submit_replanning_run",
    submitToolDescription: "Report the scope you selected, the locations included, and the run result.",
    resultSchema: ReplanSchema,
    task:
      `ERP updates are confirmed for exception ${exception.exceptionId}. The affected material is ` +
      `${exception.material} and the plant that raised the exception is ${exception.plant}. The corrective ` +
      `action applied was: ${correctiveSummary}.\n\n` +
      `Decide whether this needs a material-level, plant-level or multi-location replanning run, then ` +
      `execute it. Scope is expressed as plant and distribution-centre location ids (for example "1010" ` +
      `or "8010"), never material numbers — look up the planning network if you need to confirm which ` +
      `locations exist. Every location the corrective action touched has to end up with a synchronised ` +
      `plan, and the run must include plant ${exception.plant}.`,
  });
  if (replan.status === "escalated") return escalatedResult("Replanning", replan);

  // FR-19 ─ Reconcile updated plans and diagnose residual exceptions
  const validation = await runAgent({
    spec: MRP_RESULTS_RESOLUTION,
    submitToolName: "submit_resolution_assessment",
    submitToolDescription: "Report whether the exception has been resolved or reduced, against the original.",
    resultSchema: ValidationSchema,
    task:
      `Replanning run ${replan.result.runId} has completed for exception ${exception.exceptionId}. The ` +
      `original exception was a shortage of ${exception.shortageQty} units of ${exception.material} at plant ` +
      `${exception.plant}, required by ${exception.requiredByDate}. The corrective action applied was: ` +
      `${correctiveSummary}. Retrieve the updated plan and determine whether the exception has been ` +
      `alleviated.`,
  });
  if (validation.status === "escalated") return escalatedResult("Validation", validation);

  // FR-20 ─ BR-02. Deterministic terminal routing.
  emit({
    kind: "decision",
    rule: "BR-02",
    question: "Has the MRP exception been resolved or reduced?",
    outcome:
      validation.result.outcome === "resolved_or_reduced"
        ? `MRP exception resolved or reduced — residual shortage ${validation.result.residualShortageQty}`
        : `MRP exception remains unresolved — residual shortage ${validation.result.residualShortageQty}`,
  });

  return { outcome: validation.result.outcome, path, detail: validation.result.details };
}
