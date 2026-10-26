/**
 * Image selection validation for the mandatory 1–5 record images.
 *
 * Pure decision functions over the SAME rules the backend enforces
 * (backend/services/biomass_images.py: count 1..5, JPEG/PNG/WebP only,
 * per-file size cap). The client's copy improves usability; the server
 * re-validates everything — file CONTENT is sniffed from magic bytes on
 * both sides, a declared MIME type or filename is never trusted alone.
 */

import { IMAGE_RULES } from "../lib/api";

export interface ImageRuleError {
  /** Index (1-based, within the attempted selection) for honest messages. */
  readonly index: number;
  readonly name: string;
  readonly message: string;
}

export type ImageSelectionResult =
  | { ok: true; accepted: File[] }
  | { ok: false; errors: readonly ImageRuleError[] };

/** Extension allow-list (informational; content sniffing is authoritative). */
export function hasImageExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return IMAGE_RULES.acceptedExtensions.some((extension) =>
    lower.endsWith(extension),
  );
}

export function isSupportedImageMime(type: string): boolean {
  return (IMAGE_RULES.acceptedMimeTypes as readonly string[]).includes(type);
}

/**
 * Sniffs the REAL format from the leading bytes — the same signatures the
 * backend checks. Returns null for anything that is not JPEG, PNG or WebP.
 */
export async function sniffImageType(blob: Blob): Promise<string | null> {
  const header = new Uint8Array(await blob.slice(0, 12).arrayBuffer());
  if (header[0] === 0xff && header[1] === 0xd8 && header[2] === 0xff) {
    return "image/jpeg";
  }
  const png = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a];
  if (png.every((byte, i) => header[i] === byte)) {
    return "image/png";
  }
  const riff = [0x52, 0x49, 0x46, 0x46]; // "RIFF"
  const webp = [0x57, 0x45, 0x42, 0x50]; // "WEBP"
  if (
    riff.every((byte, i) => header[i] === byte) &&
    webp.every((byte, i) => header[8 + i] === byte)
  ) {
    return "image/webp";
  }
  return null;
}

function toRuleError(file: File, index: number, message: string): ImageRuleError {
  return { index, name: file.name, message };
}

/**
 * Validates a batch of ADDITIONAL files against the slots still available
 * (`currentCount` images are already selected). Every rejected file gets a
 * specific, actionable message; accepted files are returned in selection
 * order so callers can append them atomically.
 */
export async function validateImageFiles(
  files: readonly File[],
  currentCount: number,
): Promise<ImageSelectionResult> {
  const errors: ImageRuleError[] = [];
  const slotsLeft = IMAGE_RULES.max - currentCount;

  if (files.length > slotsLeft) {
    if (slotsLeft <= 0) {
      errors.push({
        index: 0,
        name: "",
        message: `You can upload at most ${IMAGE_RULES.max} images. Remove one to add another.`,
      });
    } else {
      errors.push({
        index: 0,
        name: "",
        message:
          `You can upload at most ${IMAGE_RULES.max} images — only ${slotsLeft} more ` +
          `${slotsLeft === 1 ? "slot is" : "slots are"} available. Deselect some files and retry.`,
      });
    }
  }

  const accepted: File[] = [];
  for (let i = 0; i < Math.min(files.length, slotsLeft); i += 1) {
    const file = files[i];
    const index = i + 1;

    if (file.size === 0) {
      errors.push(toRuleError(file, index, "This file is empty and cannot be used."));
      continue;
    }
    if (file.size > IMAGE_RULES.maxMb * 1024 * 1024) {
      errors.push(
        toRuleError(
          file,
          index,
          `"${file.name}" is larger than the ${IMAGE_RULES.maxMb} MB per-image limit.`,
        ),
      );
      continue;
    }
    if (file.type !== "" && !isSupportedImageMime(file.type)) {
      errors.push(
        toRuleError(
          file,
          index,
          `"${file.name}" is not a supported image. Only JPEG, PNG and WebP are accepted.`,
        ),
      );
      continue;
    }
    // Content sniffing is the real gate: a text file renamed to .png is
    // rejected here exactly as the backend rejects it.
    const sniffed = await sniffImageType(file);
    if (sniffed === null) {
      errors.push(
        toRuleError(
          file,
          index,
          `"${file.name}" does not decode as a JPEG, PNG or WebP image.`,
        ),
      );
      continue;
    }
    // Same extension-consistency rule as the backend: an extension that
    // contradicts the actual bytes is a client error (no extension at all
    // is tolerated, and the sniffed type decides the stored name).
    const extension = file.name.includes(".")
      ? file.name.slice(file.name.lastIndexOf(".")).toLowerCase()
      : "";
    const consistentExtensions: Record<string, string[]> = {
      "image/jpeg": [".jpg", ".jpeg"],
      "image/png": [".png"],
      "image/webp": [".webp"],
    };
    if (
      extension !== "" &&
      !consistentExtensions[sniffed].includes(extension)
    ) {
      errors.push(
        toRuleError(
          file,
          index,
          `"${file.name}"'s file extension does not match its actual format.`,
        ),
      );
      continue;
    }
    accepted.push(file);
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }
  return { ok: true, accepted };
}

/** The compulsory-image rule for the final selection at submit time. */
export function imageCountError(count: number): string | null {
  if (count < IMAGE_RULES.min) {
    return "At least one image is required — select 1–5 images before saving.";
  }
  if (count > IMAGE_RULES.max) {
    return `A record can carry at most ${IMAGE_RULES.max} images.`;
  }
  return null;
}
