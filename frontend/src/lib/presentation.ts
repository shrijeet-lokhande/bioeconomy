/**
 * Presentation-only mappings between domain values and UI tones/labels.
 * Keeps pages free of duplicated switch statements.
 */

import { STATUS_LABELS, type BiomassStatus, type QuantityUnit } from "../domain/types";
import type { BadgeTone } from "../components/ui/Badge";

export const STATUS_TONE: Readonly<Record<BiomassStatus, BadgeTone>> = {
  available: "positive",
  reserved: "earth",
  withdrawn: "muted",
};

export function statusBadge(status: BiomassStatus): {
  label: string;
  tone: BadgeTone;
} {
  return { label: STATUS_LABELS[status], tone: STATUS_TONE[status] };
}

export const UNIT_OPTIONS: readonly QuantityUnit[] = ["kg", "t", "m3"];

export function formatUpdatedAt(iso: string): string {
  // ISO-8601: the date component is simply the first 10 characters.
  return iso.slice(0, 10);
}
