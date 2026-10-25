import { describe, expect, it } from "vitest";
import { applyFilters, DEFAULT_FILTER, matchesQuery } from "./filters";
import { makeListing } from "../testing/helpers";

const spruceChips = makeListing({
  id: "a",
  title: "Wood chips — spruce",
  location: "Kainuu (demo)",
  quantityValue: 12,
  quantityUnit: "t",
  status: "available",
  updatedAt: "2026-10-20T10:00:00.000Z",
});

const strawBales = makeListing({
  id: "b",
  title: "Straw — wheat bales",
  biomassType: "Straw",
  location: "Ostrobothnia (demo)",
  quantityValue: 1500,
  quantityUnit: "kg",
  status: "available",
  updatedAt: "2026-10-15T10:00:00.000Z",
});

const willow = makeListing({
  id: "c",
  title: "Willow chips",
  location: "Savonia (demo)",
  quantityValue: null,
  quantityUnit: null,
  status: "reserved",
  updatedAt: "2026-10-21T10:00:00.000Z",
});

const prunings = makeListing({
  id: "d",
  title: "Orchard prunings",
  biomassType: "Prunings",
  location: "Turku (demo)",
  quantityValue: 15,
  quantityUnit: "m3",
  status: "available",
  updatedAt: "2026-10-05T10:00:00.000Z",
});

const residue = makeListing({
  id: "e",
  title: "Mixed forest residue",
  location: "Jyväskylä (demo)",
  quantityValue: 30,
  quantityUnit: "t",
  status: "withdrawn",
  updatedAt: "2026-10-10T10:00:00.000Z",
});

const DEMO = [spruceChips, strawBales, willow, prunings, residue];

describe("matchesQuery", () => {
  it("matches title, type, and location case-insensitively", () => {
    expect(matchesQuery(spruceChips, "chips")).toBe(true);
    expect(matchesQuery(strawBales, "STRAW")).toBe(true);
    expect(matchesQuery(prunings, "turku")).toBe(true);
    expect(matchesQuery(spruceChips, "wheat")).toBe(false);
  });

  it("matches an empty query for everything", () => {
    expect(matchesQuery(spruceChips, "  ")).toBe(true);
  });
});

describe("applyFilters", () => {
  it("returns all demo listings for the default filter", () => {
    expect(applyFilters(DEMO, DEFAULT_FILTER).map((l) => l.id)).toEqual([
      "c",
      "a",
      "b",
      "e",
      "d",
    ]);
  });

  it("filters by status", () => {
    const result = applyFilters(DEMO, {
      ...DEFAULT_FILTER,
      status: "reserved" as const,
    });
    expect(result.map((l) => l.id)).toEqual(["c"]);
  });

  it("combines query and status filters", () => {
    const result = applyFilters(DEMO, {
      query: "chips",
      status: "available" as const,
      sort: "recent" as const,
    });
    expect(result.map((l) => l.id)).toEqual(["a"]);
  });

  it("sorts by title", () => {
    const result = applyFilters(DEMO, { ...DEFAULT_FILTER, sort: "title" });
    expect(result.map((l) => l.title)).toEqual([
      "Mixed forest residue",
      "Orchard prunings",
      "Straw — wheat bales",
      "Willow chips",
      "Wood chips — spruce",
    ]);
  });

  it("sorts known mass descending and keeps unknown-mass rows visible", () => {
    const result = applyFilters(DEMO, {
      ...DEFAULT_FILTER,
      sort: "quantity-desc",
    });
    // e: 30 t from an "all"-status filter, then a: 12 t, b: 1,500 kg;
    // volume-only and unknown-mass rows sort last, still visible.
    expect(result.map((l) => l.id)).toEqual(["e", "a", "b", "c", "d"]);
    // unknown rows are still returned, never dropped by sorting.
    expect(result).toHaveLength(5);
  });

  it("never mutates the input array", () => {
    const copy = [...DEMO];
    applyFilters(DEMO, { ...DEFAULT_FILTER, sort: "quantity-desc" });
    expect(DEMO).toEqual(copy);
  });
});
