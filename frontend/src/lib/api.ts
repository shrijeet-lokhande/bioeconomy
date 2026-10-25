/**
 * Typed API client for the backend v1 API.
 *
 * Single place for request/response handling: cookie credentials ride along
 * automatically (the session cookie is HttpOnly, so the app can never read
 * or store it), 401 responses are surfaced so the auth layer can react, and
 * error messages stay generic.
 *
 * In dev, Vite proxies /api to the backend; in production a reverse proxy or
 * same-origin deployment must do the same (documented in README).
 */

export const API_BASE = "/api/v1";

/** Structured 403 marker emitted by the backend for unverified accounts. */
export const VERIFICATION_REQUIRED_CODE = "email_verification_required";

/** Structured 403 marker emitted by the backend for non-admin users. */
export const ADMIN_REQUIRED_CODE = "admin_required";

export interface AuthUser {
  id: string;
  full_name: string;
  email: string;
  role: string;
  is_active: boolean;
  created_at: string;
  updated_at: string;
}

export interface RegisterPayload {
  full_name: string;
  email: string;
  password: string;
}

export interface LoginPayload {
  email: string;
  password: string;
}

export class ApiRequestError extends Error {
  readonly status: number;
  /** Optional structured marker from the backend, e.g.
   * "email_verification_required" — used for routing decisions. */
  readonly code?: string;

  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = "ApiRequestError";
    this.status = status;
    this.code = code;
  }
}

interface RequestOptions {
  method?: "GET" | "POST" | "PATCH";
  body?: unknown;
  signal?: AbortSignal;
}

function extractDetail(body: unknown, status: number): string {
  // FastAPI error format: {"detail": "..."} or {"detail": [validation items]}
  if (body !== null && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (typeof detail === "string" && detail.trim() !== "") {
      return detail;
    }
    if (detail !== null && typeof detail === "object" && "message" in detail) {
      const message = (detail as { message: unknown }).message;
      if (typeof message === "string" && message.trim() !== "") {
        return message;
      }
    }
    if (Array.isArray(detail)) {
      return "Please review the form and try again.";
    }
  }
  switch (status) {
    case 400:
      return "Request could not be processed. Please try again.";
    case 401:
      return "Invalid email or password.";
    case 403:
      return "Request not allowed.";
    case 409:
      return "This email address is already registered.";
    case 429:
      return "Too many requests. Please try again later.";
    default:
      break;
  }
  if (status >= 500) {
    return "The server is temporarily unavailable. Please try again.";
  }
  return "Request failed. Please try again.";
}

function extractCode(body: unknown): string | undefined {
  if (body !== null && typeof body === "object" && "detail" in body) {
    const detail = (body as { detail: unknown }).detail;
    if (detail !== null && typeof detail === "object" && "code" in detail) {
      const code = (detail as { code: unknown }).code;
      if (typeof code === "string" && code !== "") {
        return code;
      }
    }
  }
  return undefined;
}

async function request<T>(path: string, options: RequestOptions = {}): Promise<T> {
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: options.body !== undefined ? { "Content-Type": "application/json" } : undefined,
      body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
      credentials: "include",
      signal: options.signal,
    });
  } catch (error) {
    // Network failure (backend down, CORS refused, offline).
    throw new ApiRequestError(
      0,
      "Cannot reach the server. Check that the backend is running.",
    );
  }

  if (response.status === 204) {
    return undefined as T;
  }

  let parsed: unknown = null;
  try {
    parsed = await response.json();
  } catch {
    parsed = null;
  }

  if (!response.ok) {
    throw new ApiRequestError(
      response.status,
      extractDetail(parsed, response.status),
      extractCode(parsed),
    );
  }
  return parsed as T;
}

export interface RegisterResult extends AuthUser {
  verification_required: boolean;
  /** "accepted" when the backend handed the email to the provider;
   * "failed" when delivery could not be completed — the UI must then offer
   * resend and never claim an email was sent. */
  email_delivery: "accepted" | "failed";
}

export const authApi = {
  register: (payload: RegisterPayload) =>
    request<RegisterResult>("/auth/register", { method: "POST", body: payload }),

  login: (payload: LoginPayload) =>
    request<AuthUser>("/auth/login", { method: "POST", body: payload }),

  logout: () => request<null>("/auth/logout", { method: "POST" }),

  me: () => request<AuthUser>("/auth/me"),

  /** Consumes a verification link token. 400 = invalid/expired/used. */
  verifyEmail: (token: string) =>
    request<{ message: string }>("/auth/verify-email", {
      method: "POST",
      body: { token },
    }),

  /** Always a neutral response — the UI must not infer account existence. */
  resendVerification: (email: string) =>
    request<{ message: string }>("/auth/resend-verification", {
      method: "POST",
      body: { email },
    }),
};

// ---------------------------------------------------------------------------
// Admin API (Task 005). Server-enforced: every call here returns 403 with
// code "admin_required" when the session owner is not a role='admin' user.
// ---------------------------------------------------------------------------

export interface AdminUserSummary extends AuthUser {
  is_email_verified: boolean;
  email_verified_at: string | null;
  live_session_count: number;
}

export interface AdminSessionRow {
  id: string;
  created_at: string;
  expires_at: string;
  revoked_at: string | null;
  live: boolean;
}

export interface AdminUserDetail extends AdminUserSummary {
  sessions: AdminSessionRow[];
}

export interface AdminUserList {
  total: number;
  page: number;
  page_size: number;
  items: AdminUserSummary[];
}

export interface AdminOverview {
  total_users: number;
  verified_users: number;
  active_users: number;
  admin_users: number;
  live_sessions: number;
  recent_registrations: AdminUserSummary[];
}

export type AdminUserRole = "user" | "admin";

export type AdminUserPatch = {
  is_active?: boolean;
  is_email_verified?: boolean;
};

export const adminApi = {
  overview: () => request<AdminOverview>("/admin/overview"),

  users: (page: number, pageSize: number, search: string) => {
    const params = new URLSearchParams({
      page: String(page),
      page_size: String(pageSize),
    });
    if (search.trim() !== "") {
      params.set("search", search.trim());
    }
    return request<AdminUserList>(`/admin/users?${params.toString()}`);
  },

  userDetail: (userId: string) =>
    request<AdminUserDetail>(`/admin/users/${userId}`),

  patchUser: (userId: string, patch: AdminUserPatch) =>
    request<AdminUserSummary>(`/admin/users/${userId}`, {
      method: "PATCH",
      body: patch,
    }),

  setRole: (userId: string, role: AdminUserRole) =>
    request<AdminUserSummary>(`/admin/users/${userId}/role`, {
      method: "POST",
      body: { role },
    }),

  revokeSessions: (userId: string, sessionId: string | null) =>
    request<{ revoked: number }>(`/admin/users/${userId}/sessions/revoke`, {
      method: "POST",
      body: sessionId === null ? {} : { session_id: sessionId },
    }),
};
