/**
 * Core domain types for the biomass listing demo workflow.
 *
 * These types are the stable boundary the future backend API must match
 * (docs/API_CONTRACT.md is the intended home for that contract — currently
 * empty). Every stored record carries provenance "demo": nothing in this
 * prototype represents real-world supply.
 */

export type BiomassStatus = "available" | "reserved" | "withdrawn";

export type QuantityUnit = "kg" | "t" | "m3";

/** All demo-store records share this provenance marker. */
export type Provenance = "demo";

export interface BiomassListing {
  readonly id: string;
  readonly title: string;
  readonly biomassType: string;
  /** null = unknown. Unknown is never silently treated as zero. */
  readonly quantityValue: number | null;
  /** Required when quantityValue is set. */
  readonly quantityUnit: QuantityUnit | null;
  /** Free-text condition/quality note when known; null = not known. */
  readonly quality: string | null;
  readonly location: string;
  readonly status: BiomassStatus;
  readonly notes: string | null;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly provenance: Provenance;
}

/** Validated input used by create/update operations. */
export interface ListingInput {
  readonly title: string;
  readonly biomassType: string;
  readonly quantityValue: number | null;
  readonly quantityUnit: QuantityUnit | null;
  readonly quality: string | null;
  readonly location: string;
  readonly status: BiomassStatus;
  readonly notes: string | null;
}

export const BIOMASS_STATUSES: readonly BiomassStatus[] = [
  "available",
  "reserved",
  "withdrawn",
];

export const STATUS_LABELS: Readonly<Record<BiomassStatus, string>> = {
  available: "Available",
  reserved: "Reserved",
  withdrawn: "Withdrawn",
};

export const QUANTITY_UNITS: readonly QuantityUnit[] = ["kg", "t", "m3"];

export const UNIT_LABELS: Readonly<Record<QuantityUnit, string>> = {
  kg: "kg",
  t: "t (tonnes)",
  m3: "m³ (volume)",
};

/** Fixed demo taxonomy — keep demo records consistent with this list. */
export const BIOMASS_TYPES: readonly string[] = [
  "Wood chips",
  "Straw",
  "Mixed forest residue",
  "Prunings",
  "Press cake",
  "Other",
];
