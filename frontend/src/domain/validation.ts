/**
 * Listing input validation. Pure functions: the same rules run in the form
 * and anywhere else, and the rules are unit-tested.
 *
 * Input comes from HTML forms as raw strings; this module is the single
 * place where strings become domain values.
 */

import {
  BIOMASS_STATUSES,
  QUANTITY_UNITS,
  type BiomassStatus,
  type ListingInput,
  type QuantityUnit,
} from "./types";

export interface ValidationError {
  readonly field: string;
  readonly message: string;
}

/** Raw form-shaped input before validation. */
export interface RawListingInput {
  readonly title: string;
  readonly biomassType: string;
  readonly location: string;
  readonly quantityValue: string;
  readonly quantityUnit: string;
  readonly quality: string;
  readonly status: string;
  readonly notes: string;
}

export type ValidationResult =
  | { ok: true; value: ListingInput }
  | { ok: false; errors: readonly ValidationError[] };

export type QuantityParse =
  | { kind: "unknown" }
  | { kind: "valid"; value: number }
  | { kind: "invalid"; reason: string };

/** Parses a raw quantity string. Empty means "unknown", never zero. */
export function parseQuantityValue(raw: string): QuantityParse {
  const trimmed = raw.trim();
  if (trimmed === "") return { kind: "unknown" };
  const value = Number(trimmed);
  if (!Number.isFinite(value)) {
    return { kind: "invalid", reason: "Enter a number." };
  }
  if (value <= 0) {
    return { kind: "invalid", reason: "Quantity must be greater than 0." };
  }
  return { kind: "valid", value };
}

function isStatus(value: string): value is BiomassStatus {
  return (BIOMASS_STATUSES as readonly string[]).includes(value);
}

function isUnit(value: string): value is QuantityUnit {
  return (QUANTITY_UNITS as readonly string[]).includes(value);
}

function optionalText(raw: string): string | null {
  const trimmed = raw.trim();
  return trimmed === "" ? null : trimmed;
}

/** Parse flow narrowed to a single validity state after error collection. */
type ParsedQuantity =
  | { kind: "unknown" }
  | { kind: "valid"; value: number; unit: QuantityUnit | null };

function parseQuantityField(
  raw: RawListingInput,
  errors: ValidationError[],
): ParsedQuantity {
  const quantity = parseQuantityValue(raw.quantityValue);
  if (quantity.kind === "invalid") {
    errors.push({
      field: "quantityValue",
      message: `Quantity: ${quantity.reason}`,
    });
  }
  if (quantity.kind === "valid") {
    if (!isUnit(raw.quantityUnit)) {
      errors.push({
        field: "quantityUnit",
        message: "Choose a unit for the entered quantity.",
      });
      return { kind: "valid", value: quantity.value, unit: null };
    }
    return { kind: "valid", value: quantity.value, unit: raw.quantityUnit };
  }
  if (raw.quantityUnit.trim() !== "") {
    errors.push({
      field: "quantityValue",
      message: "Enter a quantity value for the chosen unit.",
    });
  }
  return { kind: "unknown" };
}

/**
 * Validates and normalizes raw form input. On success the returned
 * ListingInput is fully normalized (trimmed, optional fields as null).
 */
export function validateListingInput(raw: RawListingInput): ValidationResult {
  const errors: ValidationError[] = [];

  const title = raw.title.trim();
  if (title === "") {
    errors.push({ field: "title", message: "Title is required." });
  } else if (title.length > 120) {
    errors.push({
      field: "title",
      message: "Keep the title under 120 characters.",
    });
  }

  const biomassType = raw.biomassType.trim();
  if (biomassType === "") {
    errors.push({ field: "biomassType", message: "Biomass type is required." });
  }

  const location = raw.location.trim();
  if (location === "") {
    errors.push({ field: "location", message: "Location is required." });
  }

  const status: string = raw.status;
  let validStatus: BiomassStatus | null = null;
  if (isStatus(status)) {
    validStatus = status;
  } else {
    errors.push({ field: "status", message: "Choose a valid status." });
  }

  const quantity = parseQuantityField(raw, errors);

  if (errors.length > 0) return { ok: false, errors };

  if (validStatus === null) {
    // Unreachable in practice (an invalid status always produced an error
    // above), handled explicitly to keep the success branch total.
    return {
      ok: false,
      errors: [{ field: "status", message: "Choose a valid status." }],
    };
  }

  return {
    ok: true,
    value: {
      title,
      biomassType,
      location,
      quantityValue: quantity.kind === "valid" ? quantity.value : null,
      quantityUnit: quantity.kind === "valid" ? quantity.unit : null,
      quality: optionalText(raw.quality),
      status: validStatus,
      notes: optionalText(raw.notes),
    },
  };
}
