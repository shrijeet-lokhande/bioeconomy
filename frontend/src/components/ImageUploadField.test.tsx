// @vitest-environment jsdom
/**
 * Behaviour tests for the shared mandatory-image upload field: previews,
 * removal, live count, the 5-image cap, and honest validation errors.
 */

import { StrictMode, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { ImageUploadField } from "./ImageUploadField";

const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);
const TEXT_BYTES = new Uint8Array([0x64, 0x65, 0x66, 0x69, 0x6e, 0x69, 0x74, 0x65]);

function pngFile(name = "photo.png"): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

function textFile(): File {
  // Declared as image/png but text inside — exactly the rename-game the
  // content sniffing must catch (the declared type/extension is untrusted).
  return new File([TEXT_BYTES], "notes.txt", { type: "image/png" });
}

function Harness(props: { onChange?: (files: File[]) => void; disabled?: boolean }) {
  const [files, setFiles] = useState<File[]>([]);
  return (
    <StrictMode>
      <ImageUploadField
        files={files}
        onChange={(next) => {
          setFiles(next);
          props.onChange?.(next);
        }}
        disabled={props.disabled}
      />
    </StrictMode>
  );
}

function renderHarness(props: Parameters<typeof Harness>[0] = {}) {
  render(<Harness {...props} />);
}

beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", {
    value: vi.fn(() => "blob:preview"),
    configurable: true,
    writable: true,
  });
  Object.defineProperty(URL, "revokeObjectURL", {
    value: vi.fn(),
    configurable: true,
    writable: true,
  });
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  delete (URL as unknown as Record<string, unknown>).createObjectURL;
  delete (URL as unknown as Record<string, unknown>).revokeObjectURL;
});

describe("ImageUploadField", () => {
  it("shows the required-image rule and starts at 0/5 with a disabled-free picker", async () => {
    renderHarness();
    expect(screen.getByText(/Upload 1–5 images/)).toBeTruthy();
    expect(screen.getByText("0/5 images uploaded")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Choose images" })).toBeTruthy();
    expect(screen.getByText(/select 1–5 images before saving/)).toBeTruthy();
  });

  it("adds valid images, shows previews and the live count", async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.upload(screen.getByLabelText(/Upload Images/), pngFile());
    expect(await screen.findByText("1/5 images uploaded")).toBeTruthy();
    const preview = await screen.findByAltText("Selected image 1: photo.png");
    expect(preview).toBeTruthy();
    expect(screen.getByRole("button", { name: "Remove image 1: photo.png" })).toBeTruthy();
  });

  it("rejects unsupported files with a specific message and keeps the selection", async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.upload(screen.getByLabelText(/Upload Images/), textFile());
    expect(
      await screen.findByText(/"notes.txt" does not decode as a JPEG, PNG or WebP image/),
    ).toBeTruthy();
    expect(screen.getByText("0/5 images uploaded")).toBeTruthy();
  });

  it("removes selected images and the count falls back honestly", async () => {
    const user = userEvent.setup();
    renderHarness();
    await user.upload(screen.getByLabelText(/Upload Images/), pngFile());
    await screen.findByText("1/5 images uploaded");
    await user.click(screen.getByRole("button", { name: /Remove image 1/ }));
    expect(await screen.findByText("0/5 images uploaded")).toBeTruthy();
    expect(screen.queryByAltText(/Selected image/)).toBeNull();
  });

  it("stops accepting images once five are selected", async () => {
    const user = userEvent.setup();
    renderHarness();
    // Five in one batch is allowed.
    await user.upload(
      screen.getByLabelText(/Upload Images/),
      [1, 2, 3, 4, 5].map((i) => pngFile(`p${i}.png`)),
    );
    expect(await screen.findByText("5/5 images uploaded")).toBeTruthy();
    // The picker now reports the cap and the hidden input is disabled.
    expect(screen.getByRole("button", { name: /Maximum of 5 images reached/ })).toBeTruthy();
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);

    // A further batch cannot be added through the disabled picker.
    await user.upload(input, pngFile("six.png")).catch(() => undefined);
    expect(screen.getByText("5/5 images uploaded")).toBeTruthy();
  });

  it("respects the disabled state for parent-driven busy states", async () => {
    renderHarness({ disabled: true });
    const input = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(input.disabled).toBe(true);
  });

  it("supports drag-and-drop as an alternative to the picker", async () => {
    renderHarness();
    const dropzone = document.querySelector(".image-upload-dropzone") as HTMLElement;
    const file = pngFile();
    const dataTransfer = {
      files: [file],
    };
    const event = new Event("drop", { bubbles: true, cancelable: true }) as unknown as DragEvent;
    Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
    dropzone.dispatchEvent(event);
    expect(await screen.findByText("1/5 images uploaded")).toBeTruthy();
  });
});
