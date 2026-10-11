/**
 * Mutable in-memory ERP state.
 *
 * Every write the agents make lands here and shows up in the next MRP run, so
 * the closing "has the exception been alleviated?" answer (FR-19 / BR-02) is
 * computed from what the agents actually did - not scripted.
 */

import {
  ALLOCATIONS,
  EXCEPTIONS,
  INVENTORY,
  LOCATIONS,
  MATERIALS,
  PRODUCTION_PRIORITIES,
  SUBSTITUTIONS,
  type ExceptionMessage,
  type InventoryRecord,
  type SubstitutionRecord,
} from "./fixtures.ts";

export interface StockTransport {
  documentNo: string;
  material: string;
  fromLocation: string;
  toLocation: string;
  qty: number;
  expectedArrival: string;
  forException: string;
}

export interface ErpWrite {
  documentNo: string;
  erp: string;
  plant: string;
  changeType: string;
  objectRef: string;
  before: string;
  after: string;
  justification: string;
  at: string;
}

export interface ReplanRun {
  runId: string;
  scope: "material" | "plant" | "multi_location";
  locations: string[];
  material: string;
  at: string;
}

export interface EngineeringChange {
  changeNo: string;
  material: string;
  substitute: string;
  decisionRef: string;
  at: string;
}

/**
 * Supply that a corrective action has made available against an exception.
 *
 * Every one of BR-01's nine paths ends up here, which is what lets the closing
 * MRP recompute be a single calculation rather than nine special cases. A path
 * that frees existing stock (safety stock, allocation, schedule) records it the
 * same way as one that brings new stock in (transport, vendor, conversion).
 */
export interface CorrectiveSupply {
  exceptionId: string;
  qty: number;
  availableBy: string;
  source: string;
}

interface State {
  inventory: InventoryRecord[];
  exceptions: ExceptionMessage[];
  /** Mutable so a scenario can close off the substitution path. */
  substitutions: SubstitutionRecord[];
  stockTransports: StockTransport[];
  erpWrites: ErpWrite[];
  replanRuns: ReplanRun[];
  engineeringChanges: EngineeringChange[];
  productionSchedule: typeof PRODUCTION_PRIORITIES;
  allocations: typeof ALLOCATIONS;
  safetyStockOverrides: { material: string; location: string; from: number; to: number; temporary: boolean }[];
  paintOrders: { orderNo: string; material: string; targetPartNo: string; qty: number }[];
  /** Substitutions the agents have validated or had approved, by material. */
  appliedSubstitutions: { material: string; substitute: string; basis: "documented" | "approved_change" }[];
  /** Supply made available by corrective actions, from any of the nine paths. */
  correctiveSupply: CorrectiveSupply[];
  /** Most recent MRP result per exception, so the results lookup is a read. */
  mrpResults: Record<string, MrpResult>;
  seq: number;
}

function freshState(): State {
  return {
    inventory: INVENTORY.map((r) => ({ ...r })),
    exceptions: EXCEPTIONS.map((e) => ({ ...e })),
    substitutions: SUBSTITUTIONS.map((s) => ({ ...s })),
    stockTransports: [],
    erpWrites: [],
    replanRuns: [],
    engineeringChanges: [],
    productionSchedule: PRODUCTION_PRIORITIES.map((p) => ({ ...p })),
    allocations: ALLOCATIONS.map((a) => ({ ...a })),
    safetyStockOverrides: [],
    paintOrders: [],
    appliedSubstitutions: [],
    correctiveSupply: [],
    mrpResults: {},
    seq: 0,
  };
}

let state: State = freshState();

export function resetErp(): void {
  state = freshState();
}

export function erpState(): Readonly<State> {
  return state;
}

function nextDoc(prefix: string): string {
  state.seq += 1;
  return `${prefix}-${String(state.seq).padStart(5, "0")}`;
}

export function locationById(id: string) {
  return LOCATIONS.find((l) => l.id === id);
}

export function materialByCode(code: string) {
  return MATERIALS.find((m) => m.material === code);
}

/** The ERP platform that owns a given plant or DC (NFR-02). */
export function erpForLocation(id: string): string {
  return locationById(id)?.erp ?? "unknown";
}

export function findException(exceptionId: string): ExceptionMessage | undefined {
  return state.exceptions.find((e) => e.exceptionId === exceptionId);
}

export function inventoryFor(material: string): InventoryRecord[] {
  return state.inventory.filter((r) => r.material === material);
}

export function substitutionsFor(material: string): SubstitutionRecord[] {
  return state.substitutions.filter((s) => s.material === material);
}

/**
 * Scenario setup only: drains a location's stock so the refusal lane leaves
 * the agent with nothing but an out-of-date availability figure to act on.
 */
export function drainInventoryAt(material: string, location: string): void {
  const row = state.inventory.find((r) => r.material === material && r.location === location);
  if (row) row.unrestrictedQty = 0;
}


export function recordCorrectiveSupply(supply: CorrectiveSupply): void {
  state.correctiveSupply.push(supply);
}

export function recordStockTransport(args: Omit<StockTransport, "documentNo">): StockTransport {
  const source = state.inventory.find(
    (r) => r.material === args.material && r.location === args.fromLocation,
  );
  if (source) source.unrestrictedQty = Math.max(0, source.unrestrictedQty - args.qty);

  const doc: StockTransport = { documentNo: nextDoc("STO"), ...args };
  state.stockTransports.push(doc);
  recordCorrectiveSupply({
    exceptionId: args.forException,
    qty: args.qty,
    availableBy: args.expectedArrival,
    source: `${doc.documentNo}: ${args.qty} units from ${args.fromLocation}, arriving ${args.expectedArrival}`,
  });
  return doc;
}

export function recordErpWrite(args: Omit<ErpWrite, "documentNo" | "at">): ErpWrite {
  const write: ErpWrite = {
    documentNo: nextDoc("DOC"),
    at: new Date().toISOString(),
    ...args,
  };
  state.erpWrites.push(write);
  return write;
}

/** The demo's "today". Shared so every date calculation agrees. */
export const TODAY = "2026-10-10";

export function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** A substitution covers the whole requirement it was selected for. */
function coverSubstitution(forException: string, substitute: string, basis: string): void {
  const exception = findException(forException);
  if (!exception) return;
  recordCorrectiveSupply({
    exceptionId: forException,
    qty: exception.shortageQty,
    availableBy: TODAY,
    source: `Substitution ${substitute} (${basis}) covers the ${exception.material} requirement`,
  });
}

export function recordEngineeringChange(
  args: Omit<EngineeringChange, "changeNo" | "at"> & { forException: string },
): EngineeringChange {
  const { forException, ...rest } = args;
  const change: EngineeringChange = {
    changeNo: nextDoc("ECR"),
    at: new Date().toISOString(),
    ...rest,
  };
  state.engineeringChanges.push(change);
  state.appliedSubstitutions.push({
    material: rest.material,
    substitute: rest.substitute,
    basis: "approved_change",
  });
  coverSubstitution(forException, rest.substitute, "approved engineering change");
  return change;
}

export function recordAppliedSubstitution(material: string, substitute: string, forException: string): void {
  state.appliedSubstitutions.push({ material, substitute, basis: "documented" });
  coverSubstitution(forException, substitute, "engineering documented");
}

/** Cross-brand conversion. Paint adds a short lead time before the part is usable. */
export function recordPaintOrder(material: string, targetPartNo: string, qty: number, forException: string) {
  const order = { orderNo: nextDoc("PNT"), material, targetPartNo, qty };
  state.paintOrders.push(order);
  const availableBy = addDays(TODAY, 5);
  recordCorrectiveSupply({
    exceptionId: forException,
    qty,
    availableBy,
    source: `${order.orderNo}: ${qty} units converted from ${targetPartNo}, painted and usable by ${availableBy}`,
  });
  return { ...order, availableBy };
}

export function recordSafetyStockChange(
  material: string,
  location: string,
  to: number,
  temporary: boolean,
  forException: string,
) {
  const from = materialByCode(material)?.safetyStock[location] ?? 0;
  state.safetyStockOverrides.push({ material, location, from, to, temporary });
  const released = Math.max(0, from - to);
  if (released > 0) {
    recordCorrectiveSupply({
      exceptionId: forException,
      qty: released,
      availableBy: TODAY,
      source: `${released} units released at ${location} by temporarily lowering safety stock ${from} → ${to}`,
    });
  }
  return { material, location, from, to, temporary, released };
}

export function recordScheduleChange(order: string, newPriority: number, forException: string) {
  const row = state.productionSchedule.find((p) => p.order === order);
  if (!row) return undefined;
  const before = row.priority;
  row.priority = newPriority;

  // Deprioritising an order frees the components it would have consumed.
  const released = newPriority > before ? row.qty : 0;
  if (released > 0) {
    recordCorrectiveSupply({
      exceptionId: forException,
      qty: released,
      availableBy: TODAY,
      source: `${released} units protected by deprioritising ${order} (priority ${before} → ${newPriority})`,
    });
  }
  return { order, before, after: newPriority, released };
}

export function recordAllocationChange(allocationId: string, newQty: number, forException: string) {
  const row = state.allocations.find((a) => a.allocationId === allocationId);
  if (!row) return undefined;
  const before = row.qty;
  row.qty = newQty;

  const released = Math.max(0, before - newQty);
  if (released > 0) {
    recordCorrectiveSupply({
      exceptionId: forException,
      qty: released,
      availableBy: TODAY,
      source: `${released} units freed by reducing allocation ${allocationId} from ${before} to ${newQty}`,
    });
  }
  return { allocationId, before, after: newQty, released };
}

/** Supplier or alternate-vendor commitment. Only call for an explicit commitment. */
export function recordVendorCommitment(
  vendor: string,
  qty: number,
  committedDate: string,
  forException: string,
) {
  recordCorrectiveSupply({
    exceptionId: forException,
    qty,
    availableBy: committedDate,
    source: `${vendor} committed ${qty} units by ${committedDate}`,
  });
  return { vendor, qty, committedDate };
}

export interface MrpResult {
  runId: string;
  scope: ReplanRun["scope"];
  locations: string[];
  material: string;
  exceptionId: string;
  originalShortageQty: number;
  coveredQty: number;
  residualShortageQty: number;
  coverageDetail: string[];
  /** Locations in scope that have no synchronised plan yet (NFR-37). */
  unsynchronisedLocations: string[];
}

/**
 * Re-run MRP for a scope and recompute the exception.
 *
 * Coverage counts only inbound stock transports that arrive on or before the
 * required date, plus substitutions that have a documented or approved basis.
 */
export function runScopedMrp(
  exceptionId: string,
  scope: ReplanRun["scope"],
  locations: string[],
): MrpResult | { error: string } {
  const exception = findException(exceptionId);
  if (!exception) return { error: `Unknown exception ${exceptionId}` };

  const runId = nextDoc("MRP");
  state.replanRuns.push({
    runId,
    scope,
    locations,
    material: exception.material,
    at: new Date().toISOString(),
  });

  const detail: string[] = [];
  let covered = 0;

  // Supply only counts if it lands on or before the date the material is needed.
  for (const supply of state.correctiveSupply) {
    if (supply.exceptionId !== exceptionId) continue;
    if (supply.availableBy <= exception.requiredByDate) {
      const applied = Math.min(supply.qty, Math.max(0, exception.shortageQty - covered));
      covered += applied;
      detail.push(`${supply.source} — counted ${applied} toward the shortage`);
    } else {
      detail.push(
        `${supply.source} — NOT counted: available ${supply.availableBy}, after the required date ${exception.requiredByDate}`,
      );
    }
  }

  // A plant-only run leaves the supplying DC's plan unsynchronised.
  const supplying = state.stockTransports
    .filter((s) => s.forException === exceptionId)
    .map((s) => s.fromLocation);
  const unsynchronised = supplying.filter((l) => !locations.includes(l));

  const result: MrpResult = {
    runId,
    scope,
    locations,
    material: exception.material,
    exceptionId,
    originalShortageQty: exception.shortageQty,
    coveredQty: covered,
    residualShortageQty: Math.max(0, exception.shortageQty - covered),
    coverageDetail: detail.length ? detail : ["No corrective supply recorded against this exception."],
    unsynchronisedLocations: unsynchronised,
  };
  state.mrpResults[exceptionId] = result;
  return result;
}

/**
 * Last MRP result for an exception, for the results-lookup tool (FR-35).
 * Read-only - it does not trigger a run, so the validation agent cannot
 * accidentally replan by looking.
 */
export function lastMrpResult(exceptionId: string): MrpResult | { error: string } {
  const result = state.mrpResults[exceptionId];
  if (!result) return { error: "No replanning run has been executed for this exception yet." };
  return result;
}
