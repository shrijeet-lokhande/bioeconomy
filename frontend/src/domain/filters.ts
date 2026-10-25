/**
 * Filtering and sorting for demo listings. Pure functions over readonly
 * arrays so sorting never mutates the underlying store copy.
 */

import { listingMassKg } from "./quantities";
import type { BiomassListing, BiomassStatus } from "./types";

export type ListingSort = "recent" | "title" | "quantity-desc";

export interface ListingFilter {
  readonly query: string;
  readonly status: BiomassStatus | "all";
  readonly sort: ListingSort;
}

export const DEFAULT_FILTER: ListingFilter = {
  query: "",
  status: "all",
  sort: "recent",
};

/** Case-insensitive match over title, biomass type, and location. */
export function matchesQuery(
  listing: BiomassListing,
  query: string,
): boolean {
  const needle = query.trim().toLowerCase();
  if (needle === "") return true;
  return [listing.title, listing.biomassType, listing.location].some(
    (field) => field.toLowerCase().includes(needle),
  );
}

/**
 * Unknown mass sorts below all known masses instead of being dropped —
 * filtered-out data must not disappear silently.
 */
export function applyFilters(
  listings: readonly BiomassListing[],
  filter: ListingFilter,
): readonly BiomassListing[] {
  const filtered = listings.filter(
    (listing) =>
      (filter.status === "all" || listing.status === filter.status) &&
      matchesQuery(listing, filter.query),
  );

  return [...filtered].sort((a, b) => {
    switch (filter.sort) {
      case "title":
        return a.title.localeCompare(b.title);
      case "quantity-desc": {
        const massA = listingMassKg(a);
        const massB = listingMassKg(b);
        if (massA === null && massB === null) return 0;
        if (massA === null) return 1;
        if (massB === null) return -1;
        return massB - massA;
      }
      // ISO-8601 strings sort lexicographically as dates.
      default:
        return b.updatedAt.localeCompare(a.updatedAt);
    }
  });
}
