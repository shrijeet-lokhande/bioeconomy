// @vitest-environment jsdom
/**
 * Admin biomass console tests: overview metrics, cross-user inventory
 * inspection (ownership visible to admins), listing moderation with a
 * mandatory reason, dispute resolution wording, and the strictly read-only
 * audit explorer.
 */

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { AuthProvider } from "../auth/AuthContext";

import type { AuditEvent, BiomassUnit } from "../lib/api";

const ADMIN = {
  id: "11111111-2222-3333-4444-555555555555",
  full_name: "Ada Admin",
  email: "ada@example.com",
  role: "admin",
  is_active: true,
  created_at: "2026-10-24T12:00:00.000Z",
  updated_at: "2026-10-24T12:00:00.000Z",
};

const LOT_ID = "aaaaaaaa-2222-3333-4444-555555555555";
const LISTING_ID = "bbbbbbbb-2222-3333-4444-555555555555";
const ORDER_ID = "dddddddd-2222-3333-4444-555555555555";
const UNIT: BiomassUnit = "kg";

function lotRow() {
  return {
    id: LOT_ID,
    owner_id: "eeeeeeee-2222-3333-4444-555555555555",
    title: "Wood chip lot",
    category: "Forestry",
    material_type: "Wood chips",
    unit: UNIT,
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
    permit_reference: null,
    permit_status: "not_provided",
    status: "active",
    admin_flag: null,
    price_per_unit: null,
    currency: "USD",
    created_at: "2026-10-24T12:00:00.000Z",
    updated_at: "2026-10-24T12:00:00.000Z",
    owner: {
      id: "eeeeeeee-2222-3333-4444-555555555555",
      full_name: "Ola Seller",
      email: "ola@example.com",
    },
    open_listings: 1,
  };
}

function listingRow() {
  return {
    ...lotRow(),
    id: LISTING_ID,
    lot_id: LOT_ID,
    title: "Wood chips for sale",
    description: null,
    quantity_total: "300.000",
    quantity_available: "300.000",
    listing_available: "300.000",
    listing_reserved: "0.000",
    quantity_sold: "0.000",
    price_per_unit: "25.50",
    currency: "USD",
    fulfilment: "pickup",
    available_from: null,
    available_until: null,
    status: "active" as const,
    moderation_note: null,
    permit_status: "not_provided",
    quality_grade: null,
    moisture_percent: null,
    seller: {
      id: "eeeeeeee-2222-3333-4444-555555555555",
      full_name: "Ola Seller",
      email: "ola@example.com",
    },
  };
}

function orderRow() {
  return {
    id: ORDER_ID,
    reference: "BO-CAFEBABE",
    listing_id: LISTING_ID,
    lot_id: LOT_ID,
    buyer_id: "11111111-2222-3333-4444-555555555555",
    seller_id: "eeeeeeee-2222-3333-4444-555555555555",
    quantity: "10.000",
    unit: UNIT,
    unit_price: "25.50",
    total_amount: "255.00",
    currency: "USD",
    status: "disputed" as const,
    buyer_note: null,
    reservation_expires_at: null,
    released_at: null,
    fulfilled_at: null,
    completed_at: null,
    cancelled_at: null,
    rejected_at: null,
    disputed_at: "2026-10-26T10:00:00.000Z",
    dispute_reason: "Quantity on delivery was short.",
    resolution_note: null,
    settlement_status: "unrecorded" as const,
    settlement_note: null,
    settlement_at: null,
    listing_title: "Wood chips for sale",
    counterparty_name: null,
    buyer_name: "Jane Buyer",
    seller_name: "Ola Seller",
    created_at: "2026-10-26T10:00:00.000Z",
    updated_at: "2026-10-26T10:00:00.000Z",
  };
}

const EVENT: AuditEvent = {
  id: "cccccccc-2222-3333-4444-555555555555",
  actor_id: ADMIN.id,
  actor_role: "admin",
  action: "admin.lot.corrected",
  entity_type: "lot",
  entity_id: LOT_ID,
  reason: "Scale recalibration",
  detail: {
    movement_type: "admin_correction",
    delta: "-20.000",
    available_before: "480.000",
    available_after: "460.000",
  },
  related_entity_type: null,
  related_entity_id: null,
  created_at: "2026-10-26T09:00:00.000Z",
};

interface Handle {
  method: "GET" | "POST" | "PATCH" | "DELETE";
  path: string;
  status: number;
  /** Static payload, or a function evaluated per request (lets a refreshed
   * list reflect an earlier mutation within one test). */
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
      const payload =
        typeof handle.body === "function" ? (handle.body as () => unknown)() : handle.body;
      return new Response(payload === undefined ? null : JSON.stringify(payload), {
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

const BASE_HANDLES: Handle[] = [
  { method: "GET", path: "/auth/me", status: 200, body: ADMIN },
  {
    method: "GET",
    path: "/admin/overview",
    status: 200,
    body: {
      total_users: 3,
      verified_users: 3,
      active_users: 3,
      admin_users: 1,
      live_sessions: 3,
      recent_registrations: [],
    },
  },
  { method: "GET", path: "/admin/users", status: 200, body: { total: 0, page: 1, page_size: 20, items: [] } },
  {
    method: "GET",
    path: "/admin/biomass/overview",
    status: 200,
    body: {
      total_lots: 2,
      active_lots: 2,
      archived_lots: 0,
      active_listings: 1,
      paused_listings: 0,
      withdrawn_listings: 0,
      rejected_listings: 0,
      orders: { disputed: 1 },
      disputed_orders: 1,
      movements_30d: 3,
      recent_events: [],
    },
  },
  {
    method: "GET",
    path: "/admin/biomass/inventory",
    status: 200,
    body: { total: 1, page: 1, page_size: 10, items: [lotRow()] },
  },
  {
    method: "GET",
    path: "/admin/biomass/listings",
    status: 200,
    body: { total: 1, page: 1, page_size: 10, items: [listingRow()] },
  },
  {
    method: "GET",
    path: "/admin/biomass/orders",
    status: 200,
    body: { total: 1, page: 1, page_size: 10, items: [orderRow()] },
  },
  {
    method: "GET",
    path: "/admin/biomass/audit",
    status: 200,
    body: { total: 1, page: 1, page_size: 25, items: [EVENT] },
  },
];

beforeEach(() => {
  window.location.hash = "#/admin";
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("admin biomass console", () => {
  it("shows server-derived metrics and other users' inventory with ownership", async () => {
    const { stub } = callLog();
    stub(BASE_HANDLES);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Users" }); // panel loaded
    await user.click(screen.getByRole("button", { name: "Biomass" }));

    expect(await screen.findByText("Inventory inspection")).toBeTruthy();
    // Admins see the owner's identity on other users' lots.
    await screen.findAllByText(/ola@example\.com/);
    expect(screen.getAllByText(/ola@example\.com/).length).toBeGreaterThan(0);
    expect(screen.getByText("Disputed orders")).toBeTruthy();
  });

  it("corrections require a reason before submission is possible", async () => {
    const { calls, stub } = callLog();
    stub([...BASE_HANDLES, { method: "POST", path: `/admin/biomass/inventory/${LOT_ID}/adjust`, status: 200, body: lotRow() }]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Biomass" }));
    await screen.findByText("Listing moderation");
    await screen.findAllByText("Wood chip lot");

    await user.click(screen.getByRole("button", { name: "Adjust" }));
    const reasonBox = await screen.findByLabelText("Reason (required)");
    await user.type(screen.getByLabelText("Corrected available quantity"), "480.000");

    const record = screen.getByRole("button", { name: "Record correction" });
    expect((record as HTMLButtonElement).disabled).toBe(true);
    await user.type(reasonBox, "Scale recalibration by inspection");
    expect((record as HTMLButtonElement).disabled).toBe(false);
    await user.click(record);

    const posted = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.split("?")[0].endsWith(`/admin/biomass/inventory/${LOT_ID}/adjust`),
    );
    expect(posted?.body).toMatchObject({
      kind: "correction",
      new_available: "480.000",
      reason: "Scale recalibration by inspection",
    });
  });

  it("listing rejection sends the recorded reason", async () => {
    const { calls, stub } = callLog();
    stub([
      ...BASE_HANDLES,
      {
        method: "POST",
        path: `/admin/biomass/listings/${LISTING_ID}/reject`,
        status: 200,
        body: listingRow(),
      },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Biomass" }));
    await screen.findByText("Listing moderation");
    await screen.findAllByText("Wood chips for sale");

    await user.click(screen.getByRole("button", { name: "Reject" }));
    await user.type(
      await screen.findByLabelText(/Reason \(required, recorded in the audit trail/),
      "Misidentified material",
    );
    await user.click(screen.getByRole("button", { name: "Reject listing" }));

    const posted = calls.find(
      (call) =>
        call.method === "POST" &&
        call.url.split("?")[0].endsWith(`/admin/biomass/listings/${LISTING_ID}/reject`),
    );
    expect(posted?.body).toMatchObject({ reason: "Misidentified material", force: false });
  });

  it("dispute resolution on a fulfilled order explains that cancel is impossible", async () => {
    const { stub } = callLog();
    stub(BASE_HANDLES);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Biomass" }));

    await user.click(await screen.findByRole("button", { name: "Resolve dispute" }));
    const heading = await screen.findByText("Resolve dispute on", { exact: false });
    const dialogText = heading.closest("section")?.textContent ?? "";
    expect(dialogText).toContain("stock has already legally moved");
    expect(dialogText).toContain("server forbids cancelling");
    expect(dialogText).toContain("final word");
  });
});

describe("admin permanent deletion", () => {
  async function openBiomassTab(user: ReturnType<typeof userEvent.setup>) {
    renderApp();
    await screen.findByRole("button", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Biomass" }));
    await screen.findByText("Listing moderation");
    await screen.findAllByText("Wood chip lot");
  }

  it("requires retyping the exact record title before the destructive button unlocks", async () => {
    const { calls, stub } = callLog();
    stub(BASE_HANDLES);

    const user = userEvent.setup();
    await openBiomassTab(user);

    // One destructive affordance per record type (lot row + listing row).
    const rowButtons = screen.getAllByRole("button", { name: "Delete permanently" });
    expect(rowButtons).toHaveLength(2);
    await user.click(rowButtons[0]);

    const confirmInput = await screen.findByLabelText(
      "Type the record title exactly to enable deletion",
    );
    // The dialog identifies the record by title AND id.
    expect(screen.getAllByText(/Delete permanently: Wood chip lot/).length).toBeGreaterThan(0);
    const idCode = screen.getByText(LOT_ID);
    expect(idCode.tagName).toBe("CODE");

    const dialogConfirm = screen.getAllByRole("button", { name: "Delete permanently" })[2];
    expect((dialogConfirm as HTMLButtonElement).disabled).toBe(true);
    await user.type(confirmInput, "Wood chip lo");
    expect((dialogConfirm as HTMLButtonElement).disabled).toBe(true);
    await user.clear(confirmInput);
    await user.type(confirmInput, "A different record entirely");
    expect((dialogConfirm as HTMLButtonElement).disabled).toBe(true);

    // Nothing was ever sent while the confirmation was incomplete.
    expect(calls.filter((call) => call.method === "DELETE")).toHaveLength(0);

    await user.clear(confirmInput);
    await user.type(confirmInput, "Wood chip lot");
    expect((dialogConfirm as HTMLButtonElement).disabled).toBe(false);
  });

  it("deletes a lot after confirmation and refreshes the list without a page reload", async () => {
    let inventoryItems: unknown[] = [lotRow()];
    const { calls, stub } = callLog();
    stub([
      ...BASE_HANDLES.filter(
        (handle) => !(handle.method === "GET" && handle.path === "/admin/biomass/inventory"),
      ),
      {
        method: "GET",
        path: "/admin/biomass/inventory",
        status: 200,
        body: () => ({
          total: inventoryItems.length,
          page: 1,
          page_size: 10,
          items: inventoryItems,
        }),
      },
      {
        method: "DELETE",
        path: `/admin/biomass/inventory/${LOT_ID}`,
        status: 200,
        // Function body doubles as the mutation hook: the record disappears
        // from the refreshed list because THIS call empties it.
        body: () => {
          inventoryItems = [];
          return {
            entity_type: "lot",
            entity_id: LOT_ID,
            status: "completed",
            removed_files: 2,
            missing_files: 0,
            failed_files: 0,
          };
        },
      },
    ]);

    const user = userEvent.setup();
    await openBiomassTab(user);

    await user.click(screen.getAllByRole("button", { name: "Delete permanently" })[0]);
    await user.type(
      await screen.findByLabelText("Type the record title exactly to enable deletion"),
      "Wood chip lot",
    );
    await user.click(screen.getAllByRole("button", { name: "Delete permanently" })[2]);

    expect(
      await screen.findByText(/Permanently deleted; 2 image file\(s\) were removed/),
    ).toBeTruthy();
    // The row is gone after the in-place refresh (waits for it to finish).
    await waitFor(() => expect(screen.queryByText("Wood chip lot")).toBeNull());

    const sent = calls.find((call) => call.method === "DELETE");
    expect(sent?.url.split("?")[0].endsWith(`/admin/biomass/inventory/${LOT_ID}`)).toBe(true);
    expect(sent?.body).toEqual({ confirm_title: "Wood chip lot" });
  });

  it("deletes a listing after confirmation with the listing's own title", async () => {
    const { calls, stub } = callLog();
    stub([
      ...BASE_HANDLES,
      {
        method: "DELETE",
        path: `/admin/biomass/listings/${LISTING_ID}`,
        status: 200,
        body: {
          entity_type: "listing",
          entity_id: LISTING_ID,
          status: "completed",
          removed_files: 3,
          missing_files: 1,
          failed_files: 0,
        },
      },
    ]);

    const user = userEvent.setup();
    await openBiomassTab(user);

    await user.click(screen.getAllByRole("button", { name: "Delete permanently" })[1]);
    await user.type(
      await screen.findByLabelText("Type the record title exactly to enable deletion"),
      "Wood chips for sale",
    );
    await user.click(screen.getAllByRole("button", { name: "Delete permanently" })[2]);

    expect(await screen.findByText(/Permanently deleted; 4 image file\(s\)/)).toBeTruthy();
    const sent = calls.find((call) => call.method === "DELETE");
    expect(sent?.url.split("?")[0].endsWith(`/admin/biomass/listings/${LISTING_ID}`)).toBe(true);
    expect(sent?.body).toEqual({ confirm_title: "Wood chips for sale" });
  });

  it("shows the server's refusal instead of pretending the record was deleted", async () => {
    const { stub } = callLog();
    stub([
      ...BASE_HANDLES,
      {
        method: "DELETE",
        path: `/admin/biomass/inventory/${LOT_ID}`,
        status: 409,
        body: {
          detail:
            "This record is referenced by purchase transactions. Permanent deletion is " +
            "refused to preserve transaction history — archive or withdraw it instead.",
        },
      },
    ]);

    const user = userEvent.setup();
    await openBiomassTab(user);

    await user.click(screen.getAllByRole("button", { name: "Delete permanently" })[0]);
    await user.type(
      await screen.findByLabelText("Type the record title exactly to enable deletion"),
      "Wood chip lot",
    );
    await user.click(screen.getAllByRole("button", { name: "Delete permanently" })[2]);

    expect(await screen.findByText(/referenced by purchase transactions/)).toBeTruthy();
    // The record is still listed — nothing was deleted.
    expect(screen.getAllByText("Wood chip lot").length).toBeGreaterThan(0);
  });

  it("reports pending file cleanup and never claims full deletion", async () => {
    const { stub } = callLog();
    stub([
      ...BASE_HANDLES,
      {
        method: "DELETE",
        path: `/admin/biomass/inventory/${LOT_ID}`,
        status: 200,
        body: {
          entity_type: "lot",
          entity_id: LOT_ID,
          status: "pending_cleanup",
          removed_files: 1,
          missing_files: 0,
          failed_files: 1,
        },
      },
    ]);

    const user = userEvent.setup();
    await openBiomassTab(user);

    await user.click(screen.getAllByRole("button", { name: "Delete permanently" })[0]);
    await user.type(
      await screen.findByLabelText("Type the record title exactly to enable deletion"),
      "Wood chip lot",
    );
    await user.click(screen.getAllByRole("button", { name: "Delete permanently" })[2]);

    const outcome = await screen.findByText(/could not be removed yet/);
    expect(outcome.textContent).toContain("repeat the same delete to finish the cleanup");
    expect(outcome.textContent).not.toContain("Permanently deleted;");
  });
});

describe("audit explorer", () => {
  it("lists append-only events and expands detail payloads; no write affordance", async () => {
    const { stub } = callLog();
    stub(BASE_HANDLES);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Users" });
    await user.click(screen.getByRole("button", { name: "Audit log" }));

    expect(await screen.findByText("admin.lot.corrected")).toBeTruthy();
    expect(screen.getByText(/Append-only audit trail/)).toBeTruthy();

    await user.click(screen.getByRole("button", { name: "View" }));
    expect(await screen.findByText(/available_before/)).toBeTruthy();

    // There is no edit/delete/purge action anywhere in the audit UI.
    expect(screen.queryByText("Delete")).toBeNull();
    expect(screen.queryByText("Edit")).toBeNull();
  });
});
