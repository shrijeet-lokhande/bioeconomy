/**
 * Aggregate summaries for the dashboard. All figures derive from the demo
 * store only; the UI must keep labelling them as demo data.
 *
 * Unknown quantities and volume-only (m³) records are reported separately —
 * they are never merged into mass totals.
 */

import { listingMassKg } from "./quantities";
import type { BiomassListing, BiomassStatus } from "./types";

export interface DemoListingSummary {
  readonly total: number;
  readonly byStatus: Readonly<Record<BiomassStatus, number>>;
  /** Sum of known kg/t quantities, in kg. Excludes m³ and unknown. */
  readonly knownMassKg: number;
  /** Number of listings whose quantity is unknown. */
  readonly unknownQuantity: number;
  /** Number of listings whose quantity is volume-only (m³). */
  readonly volumeOnlyQuantity: number;
}

export function summarize(
  listings: readonly BiomassListing[],
): DemoListingSummary {
  const byStatus: Record<BiomassStatus, number> = {
    available: 0,
    reserved: 0,
    withdrawn: 0,
  };

  let knownMassKg = 0;
  let unknownQuantity = 0;
  let volumeOnlyQuantity = 0;

  for (const listing of listings) {
    byStatus[listing.status] += 1;
    const mass = listingMassKg(listing);
    if (mass === null) {
      if (listing.quantityUnit === "m3") {
        volumeOnlyQuantity += 1;
      } else {
        unknownQuantity += 1;
      }
    } else {
      knownMassKg += mass;
    }
  }

  return {
    total: listings.length,
    byStatus,
    knownMassKg,
    unknownQuantity,
    volumeOnlyQuantity,
  };
}
