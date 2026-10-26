/**
 * Unit tests for the client-side image selection rules — the same rules the
 * backend enforces server-side (1–5 images, JPEG/PNG/WebP, size cap).
 */

import { describe, expect, it } from "vitest";
import {
  hasImageExtension,
  imageCountError,
  isSupportedImageMime,
  sniffImageType,
  validateImageFiles,
} from "./imageValidation";
import { IMAGE_RULES } from "../lib/api";

const PNG_BYTES = bytes(
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
);
const JPEG_BYTES = bytes(
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
);
const WEBP_BYTES = bytes(
  0x52, 0x49, 0x46, 0x46, 0x00, 0x00, 0x00, 0x00, 0x57, 0x45, 0x42, 0x50,
);
const TEXT_BYTES = bytes(0x64, 0x65, 0x66, 0x69, 0x6e, 0x69, 0x74, 0x65); // "definite"

/** Fresh ArrayBuffer-backed view (satisfies the BlobPart type argument). */
function bytes(...values: number[]): Uint8Array<ArrayBuffer> {
  const view = new Uint8Array(values.length);
  view.set(values);
  return view as Uint8Array<ArrayBuffer>;
}

function file(data: Uint8Array<ArrayBuffer>, name: string, type = "image/png"): File {
  return new File([data], name, { type });
}

describe("content sniffing", () => {
  it("recognises JPEG, PNG and WebP from magic bytes", async () => {
    expect(await sniffImageType(file(PNG_BYTES, "a.png"))).toBe("image/png");
    expect(await sniffImageType(file(JPEG_BYTES, "a.jpg"))).toBe("image/jpeg");
    expect(await sniffImageType(file(WEBP_BYTES, "a.webp"))).toBe("image/webp");
  });

  it("rejects non-image bytes regardless of filename or declared type", async () => {
    expect(await sniffImageType(file(TEXT_BYTES, "photo.png"))).toBeNull();
    expect(await sniffImageType(file(TEXT_BYTES, "photo.png", "text/plain"))).toBeNull();
  });
});

describe("extension and MIME helpers", () => {
  it("accepts only the supported extensions", () => {
    expect(hasImageExtension("photo.jpg")).toBe(true);
    expect(hasImageExtension("photo.JPEG")).toBe(true);
    expect(hasImageExtension("photo.png")).toBe(true);
    expect(hasImageExtension("photo.webp")).toBe(true);
    expect(hasImageExtension("photo.gif")).toBe(false);
    expect(hasImageExtension("photo.pdf")).toBe(false);
  });

  it("accepts only the supported MIME types", () => {
    expect(isSupportedImageMime("image/png")).toBe(true);
    expect(isSupportedImageMime("image/webp")).toBe(true);
    expect(isSupportedImageMime("image/gif")).toBe(false);
    expect(isSupportedImageMime("application/pdf")).toBe(false);
  });
});

describe("validateImageFiles", () => {
  it("accepts supported images within the remaining slots", async () => {
    const result = await validateImageFiles(
      [file(PNG_BYTES, "one.png"), file(JPEG_BYTES, "two.jpg", "image/jpeg")],
      0,
    );
    expect(result.ok).toBe(true);
    if (result.ok) expect(result.accepted.map((f) => f.name)).toEqual(["one.png", "two.jpg"]);
  });

  it("rejects the whole batch when any file is unsupported content", async () => {
    const result = await validateImageFiles(
      [file(PNG_BYTES, "good.png"), file(TEXT_BYTES, "fake.png")],
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/does not decode as a JPEG, PNG or WebP/);
    }
  });

  it("rejects unsupported declared MIME types", async () => {
    const result = await validateImageFiles(
      [file(PNG_BYTES, "doc.png", "application/pdf")],
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/not a supported image/);
    }
  });

  it("rejects extensions that contradict the actual bytes (backend parity)", async () => {
    const result = await validateImageFiles(
      [file(PNG_BYTES, "photo.jpg")],
      0,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/extension does not match its actual format/);
    }
  });

  it("rejects files larger than the per-image cap", async () => {
    const blob = new Blob([new Uint8Array(IMAGE_RULES.maxMb * 1024 * 1024 + 1)]);
    const big = new File([blob], "huge.png", { type: "image/png" });
    const result = await validateImageFiles([big], 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/larger than the 5 MB/);
    }
  });

  it("rejects empty files", async () => {
    const result = await validateImageFiles([file(new Uint8Array(0), "empty.png")], 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/empty/);
    }
  });

  it("rejects selections that exceed five total images", async () => {
    const five = Array.from({ length: 5 }, (_, i) => file(PNG_BYTES, `p${i}.png`));
    const result = await validateImageFiles([...five, file(PNG_BYTES, "six.png")], 0);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/at most 5 images/);
    }
  });

  it("counts existing images against the cap", async () => {
    const result = await validateImageFiles(
      [file(PNG_BYTES, "one.png"), file(PNG_BYTES, "two.png")],
      4,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/only 1 more slot is available/);
    }
  });

  it("reports that the cap is already reached when there are no slots left", async () => {
    const result = await validateImageFiles([file(PNG_BYTES, "one.png")], 5);
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.errors[0].message).toMatch(/Remove one to add another/);
    }
  });
});

describe("imageCountError", () => {
  it("requires at least one image", () => {
    expect(imageCountError(0)).toMatch(/At least one image is required/);
    expect(imageCountError(1)).toBeNull();
  });

  it("rejects more than five images", () => {
    expect(imageCountError(5)).toBeNull();
    expect(imageCountError(6)).toMatch(/at most 5/);
  });
});
