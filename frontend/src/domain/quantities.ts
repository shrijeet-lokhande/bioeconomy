/**
 * Quantity helpers. Conversions and formatting are deterministic so that
 * totals shown in the UI can be tested against them.
 *
 * Rule from docs/AGENTS.md context: distinguish unknown from zero. A
 * listing with unknown quantity contributes nothing to mass totals and is
 * reported separately, never folded into a sum.
 */

import type { BiomassListing, QuantityUnit } from "./types";

export const KG_PER_TONNE = 1000;

/**
 * Mass-equivalent in kg. Volume units (m³) have no defined mass conversion,
 * so they return null — callers must surface that as "not countable", not 0.
 */
export function toKgEquivalent(
  value: number,
  unit: QuantityUnit,
): number | null {
  if (!Number.isFinite(value) || value < 0) return null;
  switch (unit) {
    case "kg":
      return value;
    case "t":
      return value * KG_PER_TONNE;
    case "m3":
      return null;
  }
}

/** Mass equivalent of a listing, or null when unknown / non-mass unit. */
export function listingMassKg(listing: BiomassListing): number | null {
  if (listing.quantityValue === null || listing.quantityUnit === null) {
    return null;
  }
  return toKgEquivalent(listing.quantityValue, listing.quantityUnit);
}

/** Formats a quantity for display; unknown stays explicitly unknown. */
export function formatQuantity(
  value: number | null,
  unit: QuantityUnit | null,
): string {
  if (value === null || unit === null) return "Unknown";
  if (unit === "m3") return `${formatNumber(value)} m³`;
  return `${formatNumber(value)} ${unit}`;
}

/** Grouped number formatting; en-US is pinned for deterministic output. */
export function formatNumber(value: number): string {
  return value.toLocaleString("en-US");
}
