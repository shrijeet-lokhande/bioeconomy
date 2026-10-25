import { useState, type ChangeEvent, type FormEvent } from "react";
import {
  validateListingInput,
  type RawListingInput,
  type ValidationError,
} from "../domain/validation";
import {
  BIOMASS_TYPES,
  QUANTITY_UNITS,
  STATUS_LABELS,
  UNIT_LABELS,
  BIOMASS_STATUSES,
  type BiomassListing,
  type ListingInput,
} from "../domain/types";

export interface ListingFormProps {
  initial?: Readonly<BiomassListing> | null;
  submitLabel?: string;
  onSubmit: (input: ListingInput) => void;
  onCancel: () => void;
}

const BLANK: RawListingInput = {
  title: "",
  biomassType: BIOMASS_TYPES[0] ?? "Other",
  location: "",
  quantityValue: "",
  quantityUnit: "",
  quality: "",
  status: "available",
  notes: "",
};

function toRaw(listing: Readonly<BiomassListing>): RawListingInput {
  return {
    title: listing.title,
    biomassType: listing.biomassType,
    location: listing.location,
    quantityValue:
      listing.quantityValue === null ? "" : String(listing.quantityValue),
    quantityUnit: listing.quantityUnit ?? "",
    quality: listing.quality ?? "",
    status: listing.status,
    notes: listing.notes ?? "",
  };
}

function fieldSetter(
  raw: RawListingInput,
  setRaw: (next: RawListingInput) => void,
  field: keyof RawListingInput,
) {
  return (event: ChangeEvent<HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement>) => {
    setRaw({ ...raw, [field]: event.target.value });
  };
}

/**
 * Create/edit form for demo listings. Validation lives in the domain layer
 * (src/domain/validation.ts) so the form only wires state and errors.
 */
export function ListingForm({
  initial,
  submitLabel = "Save listing",
  onSubmit,
  onCancel,
}: ListingFormProps) {
  const [raw, setRaw] = useState<RawListingInput>(() =>
    initial ? toRaw(initial) : BLANK,
  );
  const [errors, setErrors] = useState<readonly ValidationError[]>([]);

  const errorFor = (field: string): string | undefined =>
    errors.find((validationError) => validationError.field === field)?.message;

  const handleSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const result = validateListingInput(raw);
    if (result.ok) {
      setErrors([]);
      onSubmit(result.value);
    } else {
      setErrors(result.errors);
    }
  };

  const handleCancel = () => {
    setErrors([]);
    onCancel();
  };

  const described = (field: string): string | undefined =>
    errorFor(field) ? `${field}-error` : undefined;

  return (
    <form className="listing-form" onSubmit={handleSubmit} noValidate>
      <div className="form-grid">
        <div className="field field--wide">
          <label htmlFor="listing-title">Title *</label>
          <input
            id="listing-title"
            value={raw.title}
            onChange={fieldSetter(raw, setRaw, "title")}
            aria-invalid={Boolean(errorFor("title"))}
            aria-describedby={described("title")}
          />
          {errorFor("title") ? (
            <p className="field-error" id="title-error" role="alert">
              {errorFor("title")}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="listing-biomass-type">Biomass type *</label>
          <select
            id="listing-biomass-type"
            value={raw.biomassType}
            onChange={fieldSetter(raw, setRaw, "biomassType")}
            aria-invalid={Boolean(errorFor("biomassType"))}
            aria-describedby={described("biomassType")}
          >
            {BIOMASS_TYPES.map((type) => (
              <option key={type} value={type}>
                {type}
              </option>
            ))}
          </select>
          {errorFor("biomassType") ? (
            <p className="field-error" id="biomassType-error" role="alert">
              {errorFor("biomassType")}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="listing-status">Status *</label>
          <select
            id="listing-status"
            value={raw.status}
            onChange={fieldSetter(raw, setRaw, "status")}
          >
            {BIOMASS_STATUSES.map((status) => (
              <option key={status} value={status}>
                {STATUS_LABELS[status]}
              </option>
            ))}
          </select>
          {errorFor("status") ? (
            <p className="field-error" id="status-error" role="alert">
              {errorFor("status")}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="listing-quantity">Quantity</label>
          <input
            id="listing-quantity"
            type="number"
            min="0"
            step="any"
            value={raw.quantityValue}
            onChange={fieldSetter(raw, setRaw, "quantityValue")}
            placeholder="Leave empty if not known"
            aria-invalid={Boolean(errorFor("quantityValue"))}
            aria-describedby={described("quantityValue")}
          />
          {errorFor("quantityValue") ? (
            <p className="field-error" id="quantityValue-error" role="alert">
              {errorFor("quantityValue")}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="listing-unit">Unit</label>
          <select
            id="listing-unit"
            value={raw.quantityUnit}
            onChange={fieldSetter(raw, setRaw, "quantityUnit")}
            aria-invalid={Boolean(errorFor("quantityUnit"))}
            aria-describedby={described("quantityUnit")}
          >
            <option value="">Unknown</option>
            {QUANTITY_UNITS.map((unit) => (
              <option key={unit} value={unit}>
                {UNIT_LABELS[unit]}
              </option>
            ))}
          </select>
          {errorFor("quantityUnit") ? (
            <p className="field-error" id="quantityUnit-error" role="alert">
              {errorFor("quantityUnit")}
            </p>
          ) : null}
        </div>

        <div className="field">
          <label htmlFor="listing-quality">Condition / quality (optional)</label>
          <input
            id="listing-quality"
            value={raw.quality}
            onChange={fieldSetter(raw, setRaw, "quality")}
            placeholder="Leave empty if not known"
          />
        </div>

        <div className="field">
          <label htmlFor="listing-location">Location *</label>
          <input
            id="listing-location"
            value={raw.location}
            onChange={fieldSetter(raw, setRaw, "location")}
            aria-invalid={Boolean(errorFor("location"))}
            aria-describedby={described("location")}
          />
          {errorFor("location") ? (
            <p className="field-error" id="location-error" role="alert">
              {errorFor("location")}
            </p>
          ) : null}
        </div>

        <div className="field field--wide">
          <label htmlFor="listing-notes">Notes (optional)</label>
          <textarea
            id="listing-notes"
            rows={3}
            value={raw.notes}
            onChange={(event) =>
              setRaw({ ...raw, notes: event.target.value })
            }
          />
        </div>
      </div>

      <div className="form-actions">
        <button type="submit" className="btn btn--primary">
          {submitLabel}
        </button>
        <button type="button" className="btn" onClick={handleCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}
