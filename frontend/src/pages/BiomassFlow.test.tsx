// @vitest-environment jsdom
/**
 * Integration tests for the PRODUCTION biomass inventory workflow backed by
 * the real API: summary rendering from server data, lot creation through the
 * real endpoint, and quantity adjustments that must carry a recorded reason.
 * All network access is a stubbed fetch (same pattern as AuthFlow.test.tsx).
 */

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { AuthProvider } from "../auth/AuthContext";

import type { BiomassLot, LotPage } from "../lib/api";

const USER = {
  id: "11111111-2222-3333-4444-555555555555",
  full_name: "Jane Farmer",
  email: "jane@example.com",
  role: "user",
  is_active: true,
  created_at: "2026-10-24T12:00:00.000Z",
  updated_at: "2026-10-24T12:00:00.000Z",
};

const LOT: BiomassLot = {
  id: "aaaaaaaa-2222-3333-4444-555555555555",
  owner_id: USER.id,
  title: "Wood chip lot",
  category: "Forestry",
  material_type: "Wood chips",
  unit: "kg",
  quantity_total: "500.500",
  quantity_available: "500.500",
  quantity_reserved: "0.000",
  quantity_sold: "0.000",
  quantity_transferred: "0.000",
  quantity_removed: "0.000",
  moisture_percent: null,
  harvest_date: null,
  source_provenance: null,
  storage_location: "Barn A",
  quality_grade: null,
  quality_note: null,
  permit_reference: "PERMIT-2026-0042",
  permit_status: "unverified",
  status: "active",
  admin_flag: null,
  price_per_unit: null,
  currency: "USD",
  created_at: "2026-10-24T12:00:00.000Z",
  updated_at: "2026-10-24T12:00:00.000Z",
};

function lotPage(items: BiomassLot[]): LotPage {
  return {
    summary: {
      total_lots: items.length,
      active_lots: items.filter((lot) => lot.status === "active").length,
      available_by_unit: { kg: "500.500", t: null, m3: null },
      reserved_by_unit: { kg: "0.000", t: null, m3: null },
      sold_period_by_unit: { kg: null, t: null, m3: null },
      period_days: 30,
      estimated_value_by_currency: null,
      priced_lots: 0,
      low_stock_lot_ids: [],
    },
    total: items.length,
    page: 1,
    page_size: 10,
    items,
  };
}

interface Handle {
  method: "GET" | "POST" | "PATCH";
  path: string;
  status: number;
  body?: unknown;
}

interface Call {
  method: string;
  url: string;
  body?: unknown;
  /** Set when the request carried a multipart body. */
  form?: { payload: Record<string, unknown>; imageCount: number };
}

/** The 8 PNG magic bytes are all the client-side sniff checks — any file
 * starting with them is treated as an image on the frontend; the backend
 * re-checks with the same signature. */
const PNG_BYTES = new Uint8Array([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x00,
]);

export function pngFile(name = "photo.png"): File {
  return new File([PNG_BYTES], name, { type: "image/png" });
}

function callLog() {
  const calls: Call[] = [];
  function stub(handles: Handle[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET") as string;
      let body: unknown;
      let form: Call["form"] | undefined;
      if (typeof init?.body === "string") {
        body = JSON.parse(init.body);
      } else if (init?.body instanceof FormData) {
        // Multipart create requests: the JSON record payload plus the
        // mandatory image files.
        form = {
          payload: JSON.parse(String(init.body.get("payload") ?? "{}")),
          imageCount: init.body.getAll("images").length,
        };
      }
      calls.push({ method, url, body, form });

      const headers = { "content-type": "application/json" };
      const handle = handles.find(
        (candidate) =>
          candidate.method === method && url.split("?")[0].endsWith(candidate.path),
      );
      if (handle === undefined) {
        return new Response(JSON.stringify({ detail: "Not found" }), { status: 404, headers });
      }
      return new Response(handle.body === undefined ? null : JSON.stringify(handle.body), {
        status: handle.status,
        headers,
      });
    });
    vi.stubGlobal("fetch", fetchMock);
  }
  return { calls, stub };
}

function renderApp() {
  render(
    <StrictMode>
      <AuthProvider>
        <App />
      </AuthProvider>
    </StrictMode>,
  );
}

beforeEach(() => {
  window.location.hash = "#/biomass-inventory";
  sessionStorage.clear();
  // jsdom has no object-URL store; image previews map to a fake scheme.
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

describe("inventory overview from the real API", () => {
  it("renders server-computed summary and lots, honest about unverified permits", async () => {
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      { method: "GET", path: "/biomass/inventory", status: 200, body: lotPage([LOT]) },
    ]);

    renderApp();
    expect(await screen.findByRole("heading", { name: "Biomass Inventory" })).toBeTruthy();
    expect(await screen.findByText("Wood chip lot")).toBeTruthy();
    // Summary values come from the server's per-unit aggregation.
    expect(await screen.findByText("500.500 kg")).toBeTruthy();
    // Permit references are labelled honestly, never claimed verified.
    expect(screen.getByText(/Permit unverified/)).toBeTruthy();
    expect(screen.queryByAltText("Demo workflow")).toBeNull();
  });

  it("shows the empty state when the server returns no lots", async () => {
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      { method: "GET", path: "/biomass/inventory", status: 200, body: lotPage([]) },
    ]);

    renderApp();
    expect(
      await screen.findByText(/No inventory lots yet/),
    ).toBeTruthy();
  });
});

describe("lot creation", () => {
  it("blocks submission with zero images and never sends a request", async () => {
    const { calls, stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      { method: "GET", path: "/biomass/inventory", status: 200, body: lotPage([]) },
      { method: "POST", path: "/biomass/inventory", status: 201, body: LOT },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/No inventory lots yet/);

    await user.click(screen.getByRole("button", { name: "Record new lot" }));
    await user.type(screen.getByLabelText("Title"), "Wood chip lot");
    await user.type(screen.getByLabelText("Material type"), "Wood chips");
    await user.type(screen.getByLabelText(/^Quantity/), "500.500");
    await user.type(screen.getByLabelText("Storage location"), "Barn A");

    // The submit button is disabled and the required-image message shows.
    const submit = screen.getByRole("button", { name: "Record lot" });
    expect((submit as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/0\/5 images uploaded/)).toBeTruthy();
    await user.click(submit);
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.url.split("?")[0].endsWith("/biomass/inventory"),
      ),
    ).toHaveLength(0);
  });

  it("posts a multipart payload with the compulsory image", async () => {
    const { calls, stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      { method: "GET", path: "/biomass/inventory", status: 200, body: lotPage([]) },
      { method: "POST", path: "/biomass/inventory", status: 201, body: LOT },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/No inventory lots yet/);

    await user.click(screen.getByRole("button", { name: "Record new lot" }));
    await user.type(screen.getByLabelText("Title"), "Wood chip lot");
    await user.type(screen.getByLabelText("Material type"), "Wood chips");
    await user.type(screen.getByLabelText(/^Quantity/), "500.500");
    await user.type(screen.getByLabelText("Storage location"), "Barn A");
    await user.upload(screen.getByLabelText(/Upload Images/), pngFile());
    expect(await screen.findByText(/1\/5 images uploaded/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Record lot" }));

    const posted = calls.find(
      (call) => call.method === "POST" && call.url.split("?")[0].endsWith("/biomass/inventory"),
    );
    expect(posted).toBeTruthy();
    // The create request is multipart: JSON payload + the mandatory image.
    expect(posted?.form).toBeTruthy();
    expect(posted?.form?.imageCount).toBe(1);
    expect(posted?.form?.payload).toMatchObject({
      title: "Wood chip lot",
      quantity: "500.500",
      unit: "kg",
      storage_location: "Barn A",
    });
    expect(
      await screen.findByText(/Lot "Wood chip lot" recorded/),
    ).toBeTruthy();
  });

  it("surfaces the server's image-validation errors without losing form input", async () => {
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      { method: "GET", path: "/biomass/inventory", status: 200, body: lotPage([]) },
      {
        method: "POST",
        path: "/biomass/inventory",
        status: 422,
        body: { detail: "At least one image is required to register this record." },
      },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByText(/No inventory lots yet/);
    await user.click(screen.getByRole("button", { name: "Record new lot" }));
    await user.type(screen.getByLabelText("Title"), "Still here");
    await user.type(screen.getByLabelText(/^Quantity/), "10");
    await user.upload(screen.getByLabelText(/Upload Images/), pngFile());
    await user.click(screen.getByRole("button", { name: "Record lot" }));

    expect(await screen.findByText(/At least one image is required/)).toBeTruthy();
    // The form keeps every other input on a failed submission.
    expect((screen.getByLabelText("Title") as HTMLInputElement).value).toBe("Still here");
  });
});

describe("listing creation from the lot manager", () => {
  it("publishes a listing with its own mandatory images", async () => {
    const { calls, stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      { method: "GET", path: "/biomass/inventory", status: 200, body: lotPage([LOT]) },
      {
        method: "GET",
        path: `/biomass/inventory/${LOT.id}`,
        status: 200,
        body: { lot: LOT, movements: [] },
      },
      {
        method: "POST",
        path: "/biomass/marketplace/listings",
        status: 201,
        body: { id: "b7aaaaaaaa-2222-3333-4444-555555555555", lot_id: LOT.id, title: "Chips for sale" },
      },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Wood chip lot");
    await user.click(screen.getByRole("button", { name: "Manage" }));
    const publish = await screen.findByRole("button", { name: "Publish listing" });
    expect((publish as HTMLButtonElement).disabled).toBe(true);

    await user.type(screen.getByLabelText("Listing title"), "Chips for sale");
    await user.type(screen.getByLabelText(/Offered quantity/), "40");
    await user.type(screen.getByLabelText(/Price per/), "12.50");
    await user.upload(screen.getByLabelText(/Upload Images/), pngFile());
    expect(await screen.findByText(/1\/5 images uploaded/)).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Publish listing" }));

    const posted = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.split("?")[0].endsWith("/biomass/marketplace/listings"),
    );
    expect(posted).toBeTruthy();
    expect(posted?.form?.imageCount).toBe(1);
    expect(posted?.form?.payload).toMatchObject({
      lot_id: LOT.id,
      title: "Chips for sale",
      quantity: "40",
      publish_now: true,
    });
  });
});

describe("stock adjustments", () => {
  it("never sends an adjustment without the mandatory reason", async () => {
    const { calls, stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      { method: "GET", path: "/biomass/inventory", status: 200, body: lotPage([LOT]) },
      {
        method: "GET",
        path: `/biomass/inventory/${LOT.id}`,
        status: 200,
        body: {
          lot: LOT,
          movements: [
            {
              id: "cccccccc-2222-3333-4444-555555555555",
              movement_type: "initial",
              quantity_delta: "500.500",
              quantity_before: "0.000",
              quantity_after: "500.500",
              reason: null,
              created_at: "2026-10-24T12:00:00.000Z",
            },
          ],
        },
      },
      { method: "POST", path: `/biomass/inventory/${LOT.id}/adjust`, status: 200, body: LOT },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Wood chip lot");

    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByText(/Manage: Wood chip lot/)).toBeTruthy();

    await user.type(screen.getByLabelText("Quantity"), "25");
    // Try submitting WITHOUT a reason — the button stays disabled and no
    // request is sent (the reason is mandatory and recorded).
    const recordButton = screen.getByRole("button", { name: "Record adjustment" });
    expect((recordButton as HTMLButtonElement).disabled).toBe(true);
    expect(
      calls.filter(
        (call) => call.method === "POST" && call.url.includes("/adjust"),
      ),
    ).toHaveLength(0);

    await user.type(screen.getByLabelText("Reason (required, recorded)"), "Scale recalibration");
    expect((recordButton as HTMLButtonElement).disabled).toBe(false);
    await user.click(recordButton);

    const posted = calls.find(
      (call) => call.method === "POST" && call.url.split("?")[0].endsWith("/biomass/inventory/" + LOT.id + "/adjust"),
    );
    expect(posted?.body).toMatchObject({
      kind: "addition",
      quantity: "25",
      reason: "Scale recalibration",
    });
  });

  it("renders the stock movement journal", async () => {
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      { method: "GET", path: "/biomass/inventory", status: 200, body: lotPage([LOT]) },
      {
        method: "GET",
        path: `/biomass/inventory/${LOT.id}`,
        status: 200,
        body: {
          lot: LOT,
          movements: [
            {
              id: "cccccccc-2222-3333-4444-555555555555",
              movement_type: "initial",
              quantity_delta: "500.500",
              quantity_before: "0.000",
              quantity_after: "500.500",
              reason: null,
              created_at: "2026-10-24T12:00:00.000Z",
            },
          ],
        },
      },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Wood chip lot");
    await user.click(screen.getByRole("button", { name: "Manage" }));
    expect(await screen.findByText("Stock movement history")).toBeTruthy();
    expect(screen.getByText("initial")).toBeTruthy();
  });
});
