import { describe, expect, it } from "vitest";
import {
  parseQuantityValue,
  validateListingInput,
  type RawListingInput,
} from "./validation";

function rawInput(
  overrides: Partial<RawListingInput> = {},
): RawListingInput {
  return {
    title: "  Wood chips — spruce  ",
    biomassType: "Wood chips",
    location: "  Kainuu (demo)  ",
    quantityValue: "12",
    quantityUnit: "t",
    quality: "  ",
    status: "available",
    notes: "  Demo note.  ",
    ...overrides,
  };
}

describe("parseQuantityValue", () => {
  it("treats empty input as unknown, never zero", () => {
    expect(parseQuantityValue("")).toEqual({ kind: "unknown" });
    expect(parseQuantityValue("   ")).toEqual({ kind: "unknown" });
  });

  it("rejects non-numeric and non-positive values", () => {
    expect(parseQuantityValue("abc")).toMatchObject({ kind: "invalid" });
    expect(parseQuantityValue("-3")).toMatchObject({ kind: "invalid" });
    expect(parseQuantityValue("0")).toMatchObject({ kind: "invalid" });
  });

  it("accepts positive decimals", () => {
    expect(parseQuantityValue("7.5")).toEqual({ kind: "valid", value: 7.5 });
  });
});

describe("validateListingInput", () => {
  it("accepts a complete input and normalizes it", () => {
    const result = validateListingInput(rawInput());
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.title).toBe("Wood chips — spruce");
      expect(result.value.location).toBe("Kainuu (demo)");
      expect(result.value.quality).toBeNull();
      expect(result.value.notes).toBe("Demo note.");
      expect(result.value.quantityValue).toBe(12);
      expect(result.value.quantityUnit).toBe("t");
    }
  });

  it("accepts an unknown quantity without a unit", () => {
    const result = validateListingInput(
      rawInput({ quantityValue: "  ", quantityUnit: "  " }),
    );
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value.quantityValue).toBeNull();
      expect(result.value.quantityUnit).toBeNull();
    }
  });

  it("requires a title, type, and location", () => {
    const result = validateListingInput(
      rawInput({ title: "", biomassType: "   ", location: "" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      const fields = result.errors.map((error) => error.field);
      expect(fields).toContain("title");
      expect(fields).toContain("biomassType");
      expect(fields).toContain("location");
    }
  });

  it("rejects a title over 120 characters", () => {
    const result = validateListingInput(rawInput({ title: "x".repeat(121) }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.field === "title")).toBe(true);
    }
  });

  it("rejects a quantity value without a unit", () => {
    const result = validateListingInput(
      rawInput({ quantityValue: "10", quantityUnit: "" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.field === "quantityUnit"),
      ).toBe(true);
    }
  });

  it("requires a value when a unit is chosen", () => {
    const result = validateListingInput(
      rawInput({ quantityValue: "", quantityUnit: "kg" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.field === "quantityValue"),
      ).toBe(true);
    }
  });

  it("rejects an unrecognized status", () => {
    const result = validateListingInput(rawInput({ status: "sold" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors.some((error) => error.field === "status")).toBe(
        true,
      );
    }
  });

  it("rejects non-numeric quantity text with a field error", () => {
    const result = validateListingInput(rawInput({ quantityValue: "twelve" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(
        result.errors.some((error) => error.field === "quantityValue"),
      ).toBe(true);
    }
  });
});
