/**
 * Seed data for the demo. One scarce material across three plants and two
 * distribution centres, each plant on its own ERP platform so the agents have
 * to honour NFR-02 ("Use the ERP platform assigned to the affected plant").
 *
 * Deliberately small: the BRD lists 150 data objects, this models the ~8
 * entities both demo lanes actually touch.
 */

export type ErpPlatform = "SAP S/4 HANA" | "SAP ECC" | "JDE" | "Baan" | "Oasis";

export interface Location {
  id: string;
  name: string;
  kind: "plant" | "distribution_centre";
  brand: string;
  erp: ErpPlatform;
}

export const LOCATIONS: Location[] = [
  { id: "1010", name: "Marktoberdorf", kind: "plant", brand: "Fendt", erp: "SAP S/4 HANA" },
  { id: "2020", name: "Beauvais", kind: "plant", brand: "Massey Ferguson", erp: "SAP ECC" },
  { id: "3030", name: "Jackson MN", kind: "plant", brand: "Challenger", erp: "JDE" },
  { id: "8010", name: "Ennery PDC", kind: "distribution_centre", brand: "AGCO Parts", erp: "SAP ECC" },
  { id: "8020", name: "Kansas City PDC", kind: "distribution_centre", brand: "AGCO Parts", erp: "Baan" },
];

export interface MaterialMaster {
  material: string;
  description: string;
  unit: string;
  primaryVendor: string;
  plannedLeadTimeDays: number;
  safetyStock: Record<string, number>;
}

export const MATERIALS: MaterialMaster[] = [
  {
    material: "HYD-PUMP-3045",
    description: "Hydraulic gear pump, 45 cc/rev, shared Fendt/Massey Ferguson",
    unit: "EA",
    primaryVendor: "V-10044 Hydrotek GmbH",
    plannedLeadTimeDays: 45,
    safetyStock: { "1010": 40, "2020": 25 },
  },
  {
    material: "CAST-7781-GY",
    description: "Front axle support casting, grey iron",
    unit: "EA",
    primaryVendor: "V-20781 Ferrocast SpA",
    plannedLeadTimeDays: 60,
    safetyStock: { "1010": 15 },
  },
  {
    // The refusal lane's material. Deliberately minimal: no documented
    // substitute, no cross-brand equivalent, no allocations, no safety stock,
    // no second vendor. Network stock is the only route that can close it,
    // which is what isolates the stale-data guardrail.
    material: "BRG-5520-HD",
    description: "Heavy-duty tapered roller bearing, final drive",
    unit: "EA",
    primaryVendor: "V-30550 Nordlager AB",
    plannedLeadTimeDays: 70,
    safetyStock: {},
  },
];

/** MRP exception messages, as the ERP exception queue would return them (FR-22). */
export interface ExceptionMessage {
  exceptionId: string;
  plant: string;
  material: string;
  category: string;
  /** Source-system priority. NFR-04 forbids overwriting this. */
  sourcePriority: "high" | "medium" | "low";
  shortageQty: number;
  requiredByDate: string;
  earliestSupplyDate: string;
  affectedDemand: string;
}

export const EXCEPTIONS: ExceptionMessage[] = [
  {
    exceptionId: "EX-77301",
    plant: "1010",
    material: "HYD-PUMP-3045",
    category: "Component availability shortage",
    sourcePriority: "high",
    shortageQty: 120,
    requiredByDate: "2026-10-27",
    earliestSupplyDate: "2026-11-24",
    affectedDemand: "Fendt 700 Vario assembly line, 120 units, firm customer orders",
  },
  {
    exceptionId: "EX-77302",
    plant: "1010",
    material: "CAST-7781-GY",
    category: "Component availability shortage",
    sourcePriority: "high",
    shortageQty: 32,
    requiredByDate: "2026-10-30",
    earliestSupplyDate: "2026-12-14",
    affectedDemand: "Fendt 700 Vario front axle sub-assembly, 32 units",
  },
  {
    exceptionId: "EX-77318",
    plant: "2020",
    material: "HYD-PUMP-3045",
    category: "Planned lead time exceeded",
    sourcePriority: "low",
    shortageQty: 8,
    requiredByDate: "2026-12-15",
    earliestSupplyDate: "2026-12-20",
    affectedDemand: "Massey Ferguson 8S service stock replenishment",
  },
  {
    // The refusal lane. Only Kansas City holds enough, and its feed is stale.
    exceptionId: "EX-77340",
    plant: "2020",
    material: "BRG-5520-HD",
    category: "Component availability shortage",
    sourcePriority: "high",
    shortageQty: 90,
    requiredByDate: "2026-11-05",
    earliestSupplyDate: "2026-12-20",
    affectedDemand: "Massey Ferguson 8S final drive assembly, 90 units, firm customer orders",
  },
];

/**
 * Inventory by location. `availabilityAsOf` drives the NFR-14 guardrail:
 * the agent may not reserve against a stale availability result.
 */
export interface InventoryRecord {
  material: string;
  location: string;
  unrestrictedQty: number;
  availabilityAsOf: string;
  /** True where the location's nightly feed failed - availability is not current. */
  stale: boolean;
  transferLeadTimeDays: number;
}

export const INVENTORY: InventoryRecord[] = [
  { material: "HYD-PUMP-3045", location: "1010", unrestrictedQty: 6, availabilityAsOf: "2026-10-10T04:00:00Z", stale: false, transferLeadTimeDays: 0 },
  { material: "HYD-PUMP-3045", location: "2020", unrestrictedQty: 18, availabilityAsOf: "2026-10-10T04:00:00Z", stale: false, transferLeadTimeDays: 4 },
  { material: "HYD-PUMP-3045", location: "3030", unrestrictedQty: 0, availabilityAsOf: "2026-10-10T04:00:00Z", stale: false, transferLeadTimeDays: 21 },
  { material: "HYD-PUMP-3045", location: "8010", unrestrictedQty: 140, availabilityAsOf: "2026-10-10T04:00:00Z", stale: false, transferLeadTimeDays: 3 },
  // Kansas City's feed failed. The refusal-lane trap: enough stock to fully
  // close the shortage, so declining it has to come from the guardrail rather
  // than from the quantity being insufficient.
  { material: "HYD-PUMP-3045", location: "8020", unrestrictedQty: 130, availabilityAsOf: "2026-09-28T04:00:00Z", stale: true, transferLeadTimeDays: 14 },
  { material: "CAST-7781-GY", location: "1010", unrestrictedQty: 3, availabilityAsOf: "2026-10-10T04:00:00Z", stale: false, transferLeadTimeDays: 0 },
  { material: "CAST-7781-GY", location: "8010", unrestrictedQty: 0, availabilityAsOf: "2026-10-10T04:00:00Z", stale: false, transferLeadTimeDays: 3 },

  // Refusal lane. Kansas City holds more than enough and would arrive in time,
  // but its availability feed is 12 days old - the only thing wrong with it.
  { material: "BRG-5520-HD", location: "2020", unrestrictedQty: 4, availabilityAsOf: "2026-10-10T04:00:00Z", stale: false, transferLeadTimeDays: 0 },
  { material: "BRG-5520-HD", location: "8010", unrestrictedQty: 0, availabilityAsOf: "2026-10-10T04:00:00Z", stale: false, transferLeadTimeDays: 5 },
  { material: "BRG-5520-HD", location: "3030", unrestrictedQty: 0, availabilityAsOf: "2026-10-10T04:00:00Z", stale: false, transferLeadTimeDays: 18 },
  { material: "BRG-5520-HD", location: "8020", unrestrictedQty: 150, availabilityAsOf: "2026-09-28T04:00:00Z", stale: true, transferLeadTimeDays: 10 },
];

/** Engineering substitution documentation (FR-27). */
export interface SubstitutionRecord {
  material: string;
  substitute: string;
  description: string;
  /** Only `documented` substitutions may be applied without the FR-10 gate. */
  status: "documented" | "none";
  engineeringReference?: string;
  restrictions?: string;
}

export const SUBSTITUTIONS: SubstitutionRecord[] = [
  {
    material: "HYD-PUMP-3045",
    substitute: "HYD-PUMP-3048",
    description: "Hydraulic gear pump, 48 cc/rev",
    status: "documented",
    engineeringReference: "ECN-2024-0912",
    restrictions: "Approved for Fendt 700 Vario only; not released for Massey Ferguson 8S.",
  },
  {
    material: "CAST-7781-GY",
    substitute: "CAST-7902-GY",
    description: "Front axle support casting, grey iron, Challenger variant",
    // No engineering documentation - must route to the FR-10 human gate.
    status: "none",
  },
];

/**
 * Vendor source list (FR-25).
 *
 * `earliestAvailableDate` is given as a date, not only a lead time in days.
 * Planning systems hold both, and a date the agent can compare directly is
 * more reliable than one it has to compute.
 */
export interface VendorSource {
  material: string;
  vendor: string;
  applicable: boolean;
  quotedLeadTimeDays: number;
  earliestAvailableDate: string;
  note: string;
}

export const VENDOR_SOURCES: VendorSource[] = [
  {
    material: "HYD-PUMP-3045",
    vendor: "V-10044 Hydrotek GmbH",
    applicable: true,
    quotedLeadTimeDays: 45,
    earliestAvailableDate: "2026-11-24",
    note: "Primary source, currently constrained",
  },
  {
    material: "HYD-PUMP-3045",
    vendor: "V-10092 Pumptec Sarl",
    applicable: true,
    quotedLeadTimeDays: 38,
    earliestAvailableDate: "2026-12-05",
    note: "Secondary source, no current capacity confirmation",
  },
  {
    material: "CAST-7781-GY",
    vendor: "V-20781 Ferrocast SpA",
    applicable: true,
    quotedLeadTimeDays: 60,
    earliestAvailableDate: "2026-12-14",
    note: "Sole qualified source. Foundry fully booked; no earlier date offered.",
  },
  {
    material: "BRG-5520-HD",
    vendor: "V-30550 Nordlager AB",
    applicable: true,
    quotedLeadTimeDays: 70,
    earliestAvailableDate: "2026-12-20",
    note: "Sole qualified source. No expedite available.",
  },
];

/** Supplier commitment responses keyed by vendor (FR-24). */
export const SUPPLIER_RESPONSES: Record<string, { commitment: string; explicit: boolean }> = {
  "V-10044 Hydrotek GmbH": {
    commitment: "We will do our best to improve the date, likely sometime in November.",
    explicit: false, // NFR-10: not an explicit commitment - must not be treated as confirmed.
  },
  "V-10092 Pumptec Sarl": {
    commitment: "No capacity available before 2026-12-05.",
    explicit: true,
  },
  // Sole qualified source for the casting, and a firm refusal. The supplier
  // path is genuinely closed for CAST-7781-GY.
  "V-20781 Ferrocast SpA": {
    commitment: "Foundry is fully booked through December. We cannot improve the date or the quantity.",
    explicit: true,
  },
  "V-30550 Nordlager AB": {
    commitment: "Allocation is committed through year end. 20 December is the earliest we can offer.",
    explicit: true,
  },
};

/** Production order priorities, for the schedule-recovery path (FR-30). */
export const PRODUCTION_PRIORITIES = [
  { order: "PO-884201", plant: "1010", material: "HYD-PUMP-3045", qty: 120, priority: 1, note: "Firm customer orders, Fendt 700 Vario" },
  { order: "PO-884255", plant: "1010", material: "HYD-PUMP-3045", qty: 40, priority: 4, note: "Stock build, no firm demand" },
];

/**
 * Shared components across AGCO brands, for the cross-brand conversion path
 * (FR-12 / FR-29). A documented alternate BOM is what makes a conversion
 * supportable; without one, NFR-22 forbids claiming it.
 */
export interface CrossBrandPart {
  material: string;
  equivalentPart: string;
  brand: string;
  requiredColour: string;
  availableQty: number;
  alternateBomDocumented: boolean;
}

export const CROSS_BRAND_PARTS: CrossBrandPart[] = [
  {
    material: "HYD-PUMP-3045",
    equivalentPart: "HYD-PUMP-3045-MF",
    brand: "Massey Ferguson",
    requiredColour: "Fendt nature green",
    availableQty: 75,
    alternateBomDocumented: true,
  },
  {
    material: "CAST-7781-GY",
    equivalentPart: "CAST-7781-CH",
    brand: "Challenger",
    requiredColour: "Fendt nature green",
    availableQty: 40,
    // No documented alternate BOM - NFR-22 blocks this one.
    alternateBomDocumented: false,
  },
];

/** Dealer and customer allocations, for the allocation path (FR-31). */
export const ALLOCATIONS = [
  { allocationId: "AL-5501", material: "HYD-PUMP-3045", channel: "Dealer network EMEA", qty: 60, priority: 3 },
  { allocationId: "AL-5502", material: "HYD-PUMP-3045", channel: "Assembly line 1010", qty: 120, priority: 1 },
];
