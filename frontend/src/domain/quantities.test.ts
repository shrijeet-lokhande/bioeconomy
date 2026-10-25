import { describe, expect, it } from "vitest";
import {
  formatNumber,
  formatQuantity,
  KG_PER_TONNE,
  listingMassKg,
  toKgEquivalent,
} from "./quantities";
import { makeListing } from "../testing/helpers";

describe("toKgEquivalent", () => {
  it("converts tonnes to kg", () => {
    expect(toKgEquivalent(2, "t")).toBe(2000);
  });

  it("keeps kilograms unchanged", () => {
    expect(toKgEquivalent(500, "kg")).toBe(500);
  });

  it("returns null for volume units (no mass conversion defined)", () => {
    expect(toKgEquivalent(15, "m3")).toBeNull();
  });

  it("rejects negative and non-finite values", () => {
    expect(toKgEquivalent(-1, "t")).toBeNull();
    expect(toKgEquivalent(Number.NaN, "kg")).toBeNull();
  });

  it("uses the documented conversion constant", () => {
    expect(KG_PER_TONNE).toBe(1000);
    expect(toKgEquivalent(KG_PER_TONNE, "kg") ?? 0).toBe(KG_PER_TONNE);
  });
});

describe("listingMassKg", () => {
  it("returns null when quantity is explicitly unknown", () => {
    const listing = makeListing({ quantityValue: null, quantityUnit: null });
    expect(listingMassKg(listing)).toBeNull();
  });

  it("returns null for volume-only listings", () => {
    const listing = makeListing({ quantityValue: 15, quantityUnit: "m3" });
    expect(listingMassKg(listing)).toBeNull();
  });

  it("returns the mass equivalent for kg/t listings", () => {
    expect(listingMassKg(makeListing({ quantityValue: 3, quantityUnit: "t" }))).toBe(3000);
    expect(listingMassKg(makeListing({ quantityValue: 750, quantityUnit: "kg" }))).toBe(750);
  });
});

describe("formatQuantity", () => {
  it("labels unknown quantities explicitly", () => {
    expect(formatQuantity(null, null)).toBe("Unknown");
    expect(formatQuantity(null, "t")).toBe("Unknown");
    expect(formatQuantity(5, null)).toBe("Unknown");
  });

  it("formats masses and volumes", () => {
    expect(formatQuantity(500, "kg")).toBe("500 kg");
    expect(formatQuantity(12, "t")).toBe("12 t");
    expect(formatQuantity(15, "m3")).toBe("15 m³");
    expect(formatQuantity(7.5, "t")).toBe("7.5 t");
  });
});

describe("formatNumber", () => {
  it("groups thousands deterministically", () => {
    expect(formatNumber(1250)).toBe("1,250");
    expect(formatNumber(43500)).toBe("43,500");
  });
});
