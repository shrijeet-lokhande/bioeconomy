/**
 * Shared helpers for domain tests. Used only by *.test.ts files — this
 * module ships no production behavior.
 */

import type { BiomassListing, ListingInput } from "../domain/types";

export function makeListing(
  overrides: Partial<BiomassListing> = {},
): BiomassListing {
  return {
    id: "listing-1",
    title: "Test listing",
    biomassType: "Wood chips",
    quantityValue: 2,
    quantityUnit: "t",
    quality: null,
    location: "Test location",
    status: "available",
    notes: null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updatedAt: "2026-10-01T00:00:00.000Z",
    provenance: "demo",
    ...overrides,
  };
}

export function makeInput(
  overrides: Partial<ListingInput> = {},
): ListingInput {
  return {
    title: "Test input",
    biomassType: "Wood chips",
    quantityValue: 2,
    quantityUnit: "t",
    quality: null,
    location: "Test location",
    status: "available",
    notes: null,
    ...overrides,
  };
}
