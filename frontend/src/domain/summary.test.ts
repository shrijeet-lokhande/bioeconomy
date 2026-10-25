import { describe, expect, it } from "vitest";
import { summarize } from "./summary";
import { makeListing } from "../testing/helpers";
import { formatNumber } from "./quantities";

const LISTINGS = [
  makeListing({ id: "a", status: "available", quantityValue: 12, quantityUnit: "t" }),
  makeListing({ id: "b", status: "available", quantityValue: 1500, quantityUnit: "kg" }),
  makeListing({
    id: "c",
    status: "reserved",
    quantityValue: null,
    quantityUnit: null,
  }),
  makeListing({ id: "d", status: "reserved", quantityValue: 15, quantityUnit: "m3" }),
  makeListing({
    id: "e",
    status: "withdrawn",
    quantityValue: 30,
    quantityUnit: "t",
  }),
];

describe("summarize", () => {
  it("counts statuses independently", () => {
    const summary = summarize(LISTINGS);
    expect(summary.total).toBe(5);
    expect(summary.byStatus).toEqual({
      available: 2,
      reserved: 2,
      withdrawn: 1,
    });
  });

  it("sums only known mass, excluding volume and unknown", () => {
    const summary = summarize(LISTINGS);
    expect(summary.knownMassKg).toBe(12_000 + 1_500 + 30_000);
  });

  it("reports unknown and volume-only quantities separately", () => {
    const summary = summarize(LISTINGS);
    expect(summary.unknownQuantity).toBe(1);
    expect(summary.volumeOnlyQuantity).toBe(1);
  });

  it("handles an empty store", () => {
    const summary = summarize([]);
    expect(summary.total).toBe(0);
    expect(summary.knownMassKg).toBe(0);
    expect(summary.unknownQuantity).toBe(0);
    expect(summary.volumeOnlyQuantity).toBe(0);
  });

  it("produces values ready for deterministic formatting", () => {
    const summary = summarize(LISTINGS);
    expect(formatNumber(summary.knownMassKg)).toBe("43,500");
  });
});
