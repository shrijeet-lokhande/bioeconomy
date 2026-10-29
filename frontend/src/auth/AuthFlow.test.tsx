// @vitest-environment jsdom
/**
 * Integration tests for the authentication flow at the App level: route
 * protection, login, logout, session restore after "refresh", and
 * registration with client-side validation. All network access is a
 * stubbed fetch (no real backend needed, no mocked components).
 */

import { StrictMode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import App from "../App";
import { AuthProvider } from "../auth/AuthContext";

import type { AuthUser } from "../lib/api";

const USER: AuthUser = {
  id: "11111111-2222-3333-4444-555555555555",
  full_name: "Jane Farmer",
  email: "jane@example.com",
  role: "user",
  is_active: true,
  created_at: "2026-10-24T12:00:00.000Z",
  updated_at: "2026-10-24T12:00:00.000Z",
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
    const fetchMock = vi.fn(
      async (input: RequestInfo | URL, init?: RequestInit) => {
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
            candidate.method === method &&
            // Query portions (page/page_size/search) are not part of matching.
            url.split("?")[0].endsWith(candidate.path),
        );
        if (handle === undefined) {
          return new Response(JSON.stringify({ detail: "Not found" }), {
            status: 404,
            headers,
          });
        }
        return new Response(
          handle.body === undefined ? null : JSON.stringify(handle.body),
          { status: handle.status, headers },
        );
      },
    );
    vi.stubGlobal("fetch", fetchMock);
  }
  return { calls, stub };
}

function renderApp() {
  render(
    <AuthProvider>
      <App />
    </AuthProvider>,
  );
}

function setHash(hash: string) {
  window.location.hash = hash;
  window.dispatchEvent(new HashChangeEvent("hashchange"));
}

beforeEach(() => {
  window.location.hash = "";
  sessionStorage.clear();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("route protection", () => {
  it("shows the sign-in screen for protected routes when unauthenticated", async () => {
    setHash("#/biomass-inventory");
    const { stub } = callLog();
    stub([{ method: "GET", path: "/auth/me", status: 401 }]);

    renderApp();
    expect(await screen.findByText("Checking your session…")).toBeTruthy();
    const heading = await screen.findByRole("heading", { name: "Sign in" });
    expect(heading).toBeTruthy();
    // The protected content never appears.
    expect(screen.queryByText("Listings")).toBeNull();
  });

  it("restores the signed-in user after a simulated refresh", async () => {
    setHash("#/biomass-inventory");
    const { stub } = callLog();
    stub([{ method: "GET", path: "/auth/me", status: 200, body: USER }]);

    renderApp();
    expect(await screen.findByRole("heading", { name: "Biomass Inventory" })).toBeTruthy();
    expect(screen.getAllByText("jane@example.com").length).toBeGreaterThan(0);
  });
});

describe("login flow", () => {
  it("rejects empty input without sending a request", async () => {
    setHash("#/login");
    const { stub } = callLog();
    stub([{ method: "GET", path: "/auth/me", status: 401 }]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Sign in" });

    await user.click(screen.getByRole("button", { name: "Sign in" }));
    expect(screen.getAllByRole("alert").length).toBeGreaterThan(0);
  });

  it("signs in and lands on the dashboard with the profile shown", async () => {
    setHash("#/login");
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 401 },
      { method: "POST", path: "/auth/login", status: 200, body: USER },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Sign in" });

    await user.type(screen.getByLabelText("Email address"), "Jane@Example.com");
    await user.type(screen.getByLabelText("Password"), "correct-horse-battery");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    const heading = await screen.findByRole("heading", { name: "Overview" });
    expect(heading).toBeTruthy();
    expect(screen.getByText("Jane Farmer")).toBeTruthy();
    expect(screen.getByText("jane@example.com")).toBeTruthy();
  });
});

describe("logout flow", () => {
  it("invalidates the visible session and returns to sign-in", async () => {
    setHash("#/");
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      { method: "POST", path: "/auth/logout", status: 204 },
      { method: "GET", path: "/auth/me", status: 401 },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("heading", { name: "Overview" });

    await user.click(screen.getByRole("button", { name: "Log out" }));
    expect(
      await screen.findByRole("heading", { name: "Sign in" }),
    ).toBeTruthy();
    // Protected content is gone after logout.
    expect(screen.queryByRole("heading", { name: "Overview" })).toBeNull();
  });
});

describe("registration flow", () => {
  it("blocks mismatched passwords client-side without a network call", async () => {
    setHash("#/register");
    const { calls, stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 401 },
      { method: "POST", path: "/auth/register", status: 201, body: USER },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Create account" });

    await user.type(screen.getByLabelText("Full name *"), "Jane Farmer");
    await user.type(screen.getByLabelText("Email address *"), "jane@example.com");
    await user.type(screen.getByLabelText("Password *"), "long-enough-pass");
    await user.type(screen.getByLabelText("Confirm password *"), "different!");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText("Passwords do not match."),
    ).toBeTruthy();
    expect(calls.filter((call) => call.url.includes("/auth/register"))).toHaveLength(0);
  });

  it("lands on the verification-pending screen with honest delivery status", async () => {
    setHash("#/register");
    const { calls, stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 401 },
      {
        method: "POST",
        path: "/auth/register",
        status: 201,
        body: { ...USER, is_email_verified: false, verification_required: true, email_delivery: "accepted" },
      },
      { method: "POST", path: "/auth/resend-verification", status: 202, body: { message: "accepted" } },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Create account" });

    await user.type(screen.getByLabelText("Full name *"), "Jane Farmer");
    await user.type(screen.getByLabelText("Email address *"), "Jane@Example.com");
    await user.type(screen.getByLabelText("Password *"), "long-enough-pass");
    await user.type(screen.getByLabelText("Confirm password *"), "long-enough-pass");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    // The dedicated verification-pending screen, with truth about delivery.
    expect(
      await screen.findByRole("heading", { name: "Verify your email" }),
    ).toBeTruthy();
    expect(screen.getByText(/email provider accepted the verification message for processing/i)).toBeTruthy();
    expect(
      screen.getAllByText(/jane@example\.com/).length,
    ).toBeGreaterThan(0);

    // Resend: pending state disables the button, then a neutral message.
    const resendButton = screen.getByRole("button", {
      name: "Resend verification email",
    });
    fireEvent.click(resendButton);
    // Synchronous check while the request is pending.
    expect((resendButton as HTMLButtonElement).disabled).toBe(true);
    const confirmation = await screen.findByText(
      /we have attempted to send a new verification email/i,
    );
    expect(confirmation).toBeTruthy();
    // Back to enabled after completion (repeat clicks safe).
    expect(
      (screen.getByRole("button", { name: "Resend verification email" }) as HTMLButtonElement)
        .disabled,
    ).toBe(false);
    expect(
      calls.filter((call) => call.url.includes("/auth/resend-verification")),
    ).toHaveLength(1);
  });

  it("does not call a timed-out email accepted or failed", async () => {
    setHash("#/register");
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 401 },
      {
        method: "POST",
        path: "/auth/register",
        status: 201,
        body: { ...USER, is_email_verified: false, verification_required: true, email_delivery: "unknown" },
      },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Create account" });
    await user.type(screen.getByLabelText("Full name *"), "Jane Farmer");
    await user.type(screen.getByLabelText("Email address *"), "jane@example.com");
    await user.type(screen.getByLabelText("Password *"), "long-enough-pass");
    await user.type(screen.getByLabelText("Confirm password *"), "long-enough-pass");
    await user.click(screen.getByRole("button", { name: "Create account" }));

    expect(
      await screen.findByText(/did not confirm whether it accepted the request/i),
    ).toBeTruthy();
    expect(
      screen.queryByText(/Resend accepted the verification email/i),
    ).toBeNull();
  });
});

describe("unverified sign-in flow", () => {
  it("routes to the verification-pending screen instead of an error", async () => {
    setHash("#/login");
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 401 },
      {
        method: "POST",
        path: "/auth/login",
        status: 403,
        body: {
          detail: {
            message: "This account is not verified.",
            code: "email_verification_required",
          },
        },
      },
    ]);

    const user = userEvent.setup();
    renderApp();
    await screen.findByRole("button", { name: "Sign in" });

    await user.type(screen.getByLabelText("Email address"), "pending@example.com");
    await user.type(screen.getByLabelText("Password"), "long-enough-pass");
    await user.click(screen.getByRole("button", { name: "Sign in" }));

    expect(
      await screen.findByRole("heading", { name: "Verify your email" }),
    ).toBeTruthy();
    expect(screen.getAllByText(/pending@example\.com/).length).toBeGreaterThan(0);
  });
});

describe("email verification page", () => {
  it("submits the link token, shows success, and strips the token from the URL", async () => {
    setHash("#/verify-email?token=raw-token-value-123");
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 401 },
      {
        method: "POST",
        path: "/auth/verify-email",
        status: 200,
        body: { message: "Email address verified. You can now sign in." },
      },
    ]);

    renderApp();
    expect(
      await screen.findByText(/Your email address is verified/i),
    ).toBeTruthy();
    // The token no longer appears in the visible URL.
    expect(window.location.hash).not.toContain("token=");
    // And it went to the backend exactly once.
    const link = screen.getByRole("link", { name: "Go to sign in" });
    expect(link).toBeTruthy();
  });

  it("shows the expired/invalid state for a rejected token", async () => {
    setHash("#/verify-email?token=stale-token-xyz");
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 401 },
      {
        method: "POST",
        path: "/auth/verify-email",
        status: 400,
        body: {
          detail: "This verification link is invalid or has expired.",
        },
      },
    ]);

    renderApp();
    expect(
      await screen.findByText(/invalid or has expired/i),
    ).toBeTruthy();
    expect(window.location.hash).not.toContain("token=");
    expect(
      screen.getByRole("link", { name: "Request a new verification email" }),
    ).toBeTruthy();
  });

  it("survives StrictMode double-invoked effects (one POST, no false 'malformed')", async () => {
    setHash("#/verify-email?token=strictmode-token-123");
    const { calls, stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 401 },
      {
        method: "POST",
        path: "/auth/verify-email",
        status: 200,
        body: { message: "Email address verified. You can now sign in." },
      },
    ]);

    // Production mounts inside <StrictMode>, whose dev double-invocation of
    // effects previously re-read the stripped URL and showed "malformed".
    render(
      <StrictMode>
        <AuthProvider>
          <App />
        </AuthProvider>
      </StrictMode>,
    );

    expect(
      await screen.findByText(/Your email address is verified/i),
    ).toBeTruthy();
    expect(window.location.hash).not.toContain("token=");
    const verifyPosts = calls.filter(
      (call) => call.method === "POST" && call.url.includes("/auth/verify-email"),
    );
    expect(verifyPosts).toHaveLength(1);
  });
});

interface AdminUserSummaryLike {
  [key: string]: unknown;
}

describe("admin panel", () => {
  const ADMIN_USER: AuthUser = {
    ...USER,
    id: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    full_name: "Ada Admin",
    email: "admin@example.com",
    role: "admin",
  };

  const NORMAL_TARGET: AdminUserSummaryLike = {
    ...USER,
    id: "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb",
    live_session_count: 1,
    is_email_verified: true,
    email_verified_at: "2026-10-24T12:30:00.000Z",
  };

  const ADMIN_LIST: unknown = {
    total: 2,
    page: 1,
    page_size: 20,
    items: [
      {
        ...ADMIN_USER,
        live_session_count: 1,
        is_email_verified: true,
        email_verified_at: "2026-10-24T12:00:00.000Z",
      },
      NORMAL_TARGET,
    ],
  };

  it("hides the Admin nav entry and the header badge from normal users", async () => {
    setHash("#/");
    const { stub } = callLog();
    stub([{ method: "GET", path: "/auth/me", status: 200, body: USER }]);

    renderApp();
    expect(await screen.findByText(USER.full_name)).toBeTruthy();
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
  });

  it("shows a clear no-access card for a non-admin reaching #/admin", async () => {
    setHash("#/admin");
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: USER },
      {
        method: "GET",
        path: "/admin/overview",
        status: 403,
        body: {
          detail: { message: "Administrator access is required.", code: "admin_required" },
        },
      },
    ]);

    renderApp();
    expect(
      await screen.findByText(/does not have administrator access/i),
    ).toBeTruthy();
  });

  it("loads the panel from its direct URL with no nav entry for admins either", async () => {
    setHash("#/admin");
    const { stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: ADMIN_USER },
      {
        method: "GET",
        path: "/admin/overview",
        status: 200,
        body: {
          total_users: 4,
          verified_users: 3,
          active_users: 3,
          admin_users: 1,
          live_sessions: 2,
          recent_registrations: [],
        },
      },
      { method: "GET", path: "/admin/users", status: 200, body: ADMIN_LIST },
    ]);

    renderApp();
    expect(
      await screen.findByRole("heading", { name: "Admin panel" }),
    ).toBeTruthy();
    expect(await screen.findByText("Recent registrations")).toBeTruthy();
    // Even the admin gets NO Admin link in the primary navigation — the
    // panel is URL-only by design.
    expect(screen.queryByRole("link", { name: "Admin" })).toBeNull();
    // The other navigation entries are untouched.
    expect(screen.getByRole("link", { name: "Overview" })).toBeTruthy();
    expect(screen.getByRole("link", { name: "Settings" })).toBeTruthy();
    // The header badge stays as the admin's status indicator.
    expect(screen.getByText("Admin", { selector: ".badge" })).toBeTruthy();
  });

  it("performs the deactivate action through the admin API", async () => {
    setHash("#/admin");
    const { calls, stub } = callLog();
    stub([
      { method: "GET", path: "/auth/me", status: 200, body: ADMIN_USER },
      {
        method: "GET",
        path: "/admin/overview",
        status: 200,
        body: {
          total_users: 1,
          verified_users: 1,
          active_users: 0,
          admin_users: 1,
          live_sessions: 0,
          recent_registrations: [],
        },
      },
      { method: "GET", path: "/admin/users", status: 200, body: ADMIN_LIST },
      {
        method: "PATCH",
        path: `/admin/users/${NORMAL_TARGET.id}`,
        status: 200,
        body: { ...NORMAL_TARGET, is_active: false },
      },
    ]);
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);

    renderApp();
    // Wait for the signed-in shell, then for the admin data to load (the
    // name in the header appears before the panel's data arrives).
    await screen.findByText(ADMIN_USER.full_name);
    await screen.findByRole("button", { name: "Users" });
    await userEvent.click(screen.getByRole("button", { name: "Users" }));
    await screen.findByText("jane@example.com");
    // Both rows have a Deactivate button; the admin's own is disabled by the
    // documented self-protection rule. Drive the TARGET's action.
    const deactivateButtons = screen.getAllByRole("button", {
      name: "Deactivate",
    }) as HTMLButtonElement[];
    const enabled = deactivateButtons.find((button) => !button.disabled);
    expect(enabled).toBeTruthy();
    expect(enabled?.closest("tr")?.textContent).toContain("jane@example.com");
    await userEvent.click(enabled!);

    await screen.findByText("Done.");
    const patches = calls.filter((call) => call.method === "PATCH");
    expect(patches).toHaveLength(1);
    expect(patches[0].body).toEqual({ is_active: false });
    confirmSpy.mockRestore();
  });
});
