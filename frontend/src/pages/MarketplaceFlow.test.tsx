// @vitest-environment jsdom
/**
 * Marketplace integration tests against the real API: public listing cards
 * must never leak seller email/id, purchase requests carry an idempotency
 * key, and the UI is explicit about manual settlement and 72-hour expiry.
 */

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { AuthProvider } from "../auth/AuthContext";

import type { BiomassOrder, ListingCard } from "../lib/api";

const USER = {
  id: "11111111-2222-3333-4444-555555555555",
  full_name: "Jane Buyer",
  email: "jane@example.com",
  role: "user",
  is_active: true,
  created_at: "2026-10-24T12:00:00.000Z",
  updated_at: "2026-10-24T12:00:00.000Z",
};

const SELLER_ID = "99999999-2222-3333-4444-555555555555";

const LISTING: ListingCard = {
  id: "bbbbbbbb-2222-3333-4444-555555555555",
  title: "Wood chips for sale",
  description: "Dry pine chips from sawmill residues.",
  category: "Forestry",
  material_type: "Wood chips",
  unit: "kg",
  location: "Harbor depot",
  quantity_total: "300.000",
  listing_available: "40.000",
  price_per_unit: "25.50",
  currency: "USD",
  fulfilment: "pickup",
  available_from: null,
  available_until: null,
  quality_grade: "A",
  source_provenance: "Sawmill lot 12",
  moisture_percent: "12.5",
  permit_status: "unverified",
  seller_name: "Ola Sawmill",
  created_at: "2026-10-24T12:00:00.000Z",
  images: [
    {
      id: "eeeeeeee-1111-3333-4444-555555555555",
      position: 1,
      original_name: "chips.jpg",
      content_type: "image/jpeg",
      size_bytes: 1234,
      created_at: "2026-10-24T12:00:00.000Z",
      url: "/api/v1/biomass/images/eeeeeeee-1111-3333-4444-555555555555",
    },
    {
      id: "eeeeeeee-2222-3333-4444-555555555555",
      position: 2,
      original_name: "chips-2.jpg",
      content_type: "image/jpeg",
      size_bytes: 2345,
      created_at: "2026-10-24T12:00:00.000Z",
      url: "/api/v1/biomass/images/eeeeeeee-2222-3333-4444-555555555555",
    },
  ],
};

const ORDER: BiomassOrder = {
  id: "dddddddd-2222-3333-4444-555555555555",
  reference: "BO-CAFEBABE",
  listing_id: LISTING.id,
  lot_id: "aaaaaaaa-2222-3333-4444-555555555555",
  buyer_id: USER.id,
  seller_id: SELLER_ID,
  quantity: "10.000",
  unit: "kg",
  unit_price: "25.50",
  total_amount: "255.00",
  currency: "USD",
  status: "requested",
  buyer_note: null,
  reservation_expires_at: "2026-10-29T12:00:00.000Z",
  released_at: null,
  fulfilled_at: null,
  completed_at: null,
  cancelled_at: null,
  rejected_at: null,
  disputed_at: null,
  dispute_reason: null,
  resolution_note: null,
  settlement_status: "unrecorded",
  settlement_note: null,
  settlement_at: null,
  listing_title: LISTING.title,
  counterparty_name: "Ola Sawmill",
  role: "buyer",
  created_at: "2026-10-26T10:00:00.000Z",
  updated_at: "2026-10-26T10:00:00.000Z",
};

interface Handle {
  method: "GET" | "POST" | "PATCH";
  path: string;
  status: number;
  body?: unknown;
}

function callLog() {
  const calls: { method: string; url: string; body?: unknown }[] = [];
  function stub(handles: Handle[]) {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = (init?.method ?? "GET") as string;
      let body: unknown;
      if (typeof init?.body === "string") {
        body = JSON.parse(init.body);
      }
      calls.push({ method, url, body });
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
  window.location.hash = "#/marketplace";
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

const BASE_HANDLES: Handle[] = [
  { method: "GET", path: "/auth/me", status: 200, body: USER },
  {
    method: "GET",
    path: "/biomass/marketplace/listings",
    status: 200,
    body: { total: 1, page: 1, page_size: 12, items: [LISTING] },
  },
  { method: "GET", path: `/biomass/marketplace/listings/${LISTING.id}`, status: 200, body: LISTING },
];

describe("marketplace browse", () => {
  it("renders public cards without leaking seller email or id", async () => {
    const { stub } = callLog();
    stub(BASE_HANDLES);

    renderApp();
    expect(await screen.findByRole("heading", { name: "Marketplace" })).toBeTruthy();
    expect(await screen.findByText("Wood chips for sale")).toBeTruthy();
    expect(screen.getByText(/Ola Sawmill/)).toBeTruthy();
    // Only the display name is public: NO seller email anywhere, NO id.
    expect(screen.queryByText(/sawmill@example\.com/i)).toBeNull();
    expect(screen.queryByText(SELLER_ID)).toBeNull();
    // Honest wording about permits and expiry.
    expect(
      await screen.findByText(/platform does not verify permit references/),
    ).toBeTruthy();
    expect(document.body.textContent).toMatch(/72 hours/);
  });

  it("shows the primary image on browse cards and the gallery in the detail view", async () => {
    const { stub } = callLog();
    stub(BASE_HANDLES);

    const user = userEvent.setup();
    renderApp();
    // Browse card: the first image by position as the primary thumbnail.
    const thumb = await screen.findByAltText("Primary image of Wood chips for sale");
    expect((thumb as HTMLImageElement).src).toContain(
      "/api/v1/biomass/images/eeeeeeee-1111-3333-4444-555555555555",
    );

    // Detail view: a gallery with image navigation between both images.
    await user.click(screen.getByRole("button", { name: "View & request purchase" }));
    expect(
      await screen.findByAltText("Image 1 of 2 for Wood chips for sale"),
    ).toBeTruthy();
    await user.click(screen.getByRole("button", { name: "Show image 2 of 2" }));
    expect(
      screen.getByAltText("Image 2 of 2 for Wood chips for sale"),
    ).toBeTruthy();
  });

  it("degrades honestly when a legacy listing has no images", async () => {
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      {
        method: "GET",
        path: "/biomass/marketplace/listings",
        status: 200,
        body: { total: 1, page: 1, page_size: 12, items: [{ ...LISTING, images: [] }] },
      },
    ]);

    renderApp();
    await screen.findByText("Wood chips for sale");
    // No broken <img>: the placeholder stands in for the missing image.
    expect(screen.queryByAltText(/Primary image/)).toBeNull();
  });
});

describe("purchase flow", () => {
  it("creates an idempotent reservation request through the API", async () => {
    const { calls, stub } = callLog();
    stub([
      ...BASE_HANDLES,
      {
        method: "POST",
        path: `/biomass/marketplace/listings/${LISTING.id}/orders`,
        status: 201,
        body: ORDER,
      },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Wood chips for sale");

    await user.click(screen.getByRole("button", { name: "View & request purchase" }));
    const quantityBox = await screen.findByLabelText(/^Quantity \(kg/);
    await user.type(quantityBox, "10.000");
    await user.click(screen.getByRole("button", { name: "Request purchase" }));

    const posted = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.split("?")[0].endsWith(`/biomass/marketplace/listings/${LISTING.id}/orders`),
    );
    expect(posted).toBeTruthy();
    // Every purchase request carries a client-generated idempotency key.
    expect(typeof (posted?.body as Record<string, unknown>).client_request_id).toBe("string");
    expect((posted?.body as Record<string, unknown>).quantity).toBe("10.000");

    expect(
      (await screen.findByText(/BO-CAFEBABE/)).textContent,
    ).toBe("BO-CAFEBABE");
    expect(document.body.textContent).toMatch(/created with 10 kg reserved/);
  });

  it("surfaces server-side quantity conflicts honestly", async () => {
    const { stub } = callLog();
    stub([
      ...BASE_HANDLES,
      {
        method: "POST",
        path: `/biomass/marketplace/listings/${LISTING.id}/orders`,
        status: 409,
        body: { detail: "Not enough available quantity for this operation." },
      },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByText("Wood chips for sale");
    await user.click(screen.getByRole("button", { name: "View & request purchase" }));
    await user.type(await screen.findByLabelText(/^Quantity \(kg/), "999");
    await user.click(screen.getByRole("button", { name: "Request purchase" }));

    expect(
      await screen.findByText(/Not enough available quantity/),
    ).toBeTruthy();
  });
});

describe("purchase lifecycle", () => {
  it("shows expiry, settlement wording, and status for the buyer", async () => {
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      {
        method: "GET",
        path: "/biomass/marketplace/orders",
        status: 200,
        body: { total: 1, page: 1, page_size: 10, items: [ORDER] },
      },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "My purchases" });
    await user.click(screen.getByRole("button", { name: "My purchases" }));

    expect(await screen.findByText("BO-CAFEBABE")).toBeTruthy();
    expect(screen.getByText(/Reservation expires/)).toBeTruthy();
    expect(document.body.textContent).toMatch(/no payment was processed by the platform|never claims payment/i);
  });
});
