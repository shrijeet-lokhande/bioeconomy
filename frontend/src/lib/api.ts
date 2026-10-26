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
  method?: "GET" | "POST" | "PATCH" | "DELETE";
  /** Plain object → JSON body; FormData → multipart body (no manual
   * Content-Type: the browser supplies the boundary). */
  body?: unknown | FormData;
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
  const isFormData = options.body instanceof FormData;
  let response: Response;
  try {
    response = await fetch(`${API_BASE}${path}`, {
      method: options.method ?? "GET",
      headers: options.body !== undefined && !isFormData
        ? { "Content-Type": "application/json" }
        : undefined,
      body:
        options.body === undefined
          ? undefined
          : isFormData
            ? (options.body as FormData)
            : JSON.stringify(options.body),
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

// ---------------------------------------------------------------------------
// Biomass inventory + marketplace (real backend; replaces the localStorage
// demo store). Quantities arrive as precision-preserving strings from the
// Decimal-based backend serializer — never parse them with floats.
// ---------------------------------------------------------------------------

export type BiomassUnit = "kg" | "t" | "m3";

export const UNIT_LABELS: Record<BiomassUnit, string> = {
  kg: "kg",
  t: "tonnes",
  m3: "m³",
};

// ---------------------------------------------------------------------------
// Record images. One record (inventory lot or marketplace listing) carries
// 1–5 mandatory images; the rules here MIRROR the server's enforcement
// (backend/services/biomass_images.py) — they improve usability, they are
// never the only guard.
// ---------------------------------------------------------------------------

export interface BiomassImage {
  id: string;
  position: number;
  original_name: string;
  content_type: string;
  size_bytes: number;
  created_at: string;
  /** Authorized image endpoint — authentication rides on the session cookie;
   * there are no public static file URLs. */
  url: string;
}

export const IMAGE_RULES = {
  min: 1,
  max: 5,
  /** Mirrors the backend's `biomass_image_max_mb` setting (5 MB per image). */
  maxMb: 5,
  /** Only formats the backend accepts (sniffed from magic bytes, not names). */
  acceptedMimeTypes: ["image/jpeg", "image/png", "image/webp"],
  acceptedExtensions: [".jpg", ".jpeg", ".png", ".webp"],
} as const;

export const IMAGE_UPLOAD_HINT =
  "Upload 1–5 images. At least one image is required.";

/** Images of one record, in display order. Legacy records without images
 * (none can be created through the current API, but older data may exist)
 * degrade gracefully to an empty gallery. */
export function recordImages(images?: BiomassImage[]): BiomassImage[] {
  return images ?? [];
}

export interface BiomassLot {
  id: string;
  owner_id: string;
  title: string;
  category: string;
  material_type: string;
  unit: BiomassUnit;
  quantity_total: string;
  quantity_available: string;
  quantity_reserved: string;
  quantity_sold: string;
  quantity_transferred: string;
  quantity_removed: string;
  moisture_percent: string | null;
  harvest_date: string | null;
  source_provenance: string | null;
  storage_location: string;
  quality_grade: string | null;
  quality_note: string | null;
  permit_reference: string | null;
  permit_status: "not_provided" | "unverified" | "review_required";
  status: "active" | "archived";
  admin_flag: string | null;
  price_per_unit: string | null;
  currency: string;
  created_at: string;
  updated_at: string;
  images?: BiomassImage[];
}

export interface StockMovement {
  id: string;
  movement_type: string;
  quantity_delta: string;
  quantity_before: string;
  quantity_after: string;
  reason: string | null;
  created_at: string;
}

export interface LotDetailResponse {
  lot: BiomassLot;
  movements: StockMovement[];
}

export function formatQuantitySummary(
  summary: Partial<Record<BiomassUnit, string | null>>,
): string {
  const parts = (Object.keys(UNIT_LABELS) as BiomassUnit[])
    .filter((unit) => summary[unit] !== null && summary[unit] !== undefined)
    .map((unit) => `${summary[unit]} ${UNIT_LABELS[unit]}`);
  return parts.length === 0 ? "—" : parts.join(" · ");
}

/** Cross-unit LOW-stock and totals never merge: this joins per-unit text. */
export function formatDecimal(value: string | null): string {
  if (value === null) return "—";
  return value;
}

export interface InventorySummary {
  total_lots: number;
  active_lots: number;
  available_by_unit: Record<BiomassUnit, string | null>;
  reserved_by_unit: Record<BiomassUnit, string | null>;
  sold_period_by_unit: Record<BiomassUnit, string | null>;
  period_days: number;
  estimated_value_by_currency: Record<string, string> | null;
  priced_lots: number;
  low_stock_lot_ids: string[];
}

export interface LotPage {
  summary: InventorySummary;
  total: number;
  page: number;
  page_size: number;
  items: BiomassLot[];
}

export interface LotCreateInput {
  title: string;
  category: string;
  material_type: string;
  unit: BiomassUnit;
  quantity: string;
  storage_location: string;
  moisture_percent?: string | null;
  harvest_date?: string | null;
  source_provenance?: string | null;
  quality_grade?: string | null;
  quality_note?: string | null;
  permit_reference?: string | null;
  price_per_unit?: string | null;
  currency?: string | null;
}

export interface LotUpdateInput {
  title?: string;
  category?: string;
  material_type?: string;
  storage_location?: string;
  moisture_percent?: string | null;
  harvest_date?: string | null;
  source_provenance?: string | null;
  quality_grade?: string | null;
  quality_note?: string | null;
  permit_reference?: string | null;
  price_per_unit?: string | null;
  currency?: string | null;
}

export interface AdjustInput {
  kind: "addition" | "removal" | "correction";
  quantity?: string;
  new_available?: string;
  reason: string;
}

export interface TransferResult {
  source_lot: BiomassLot;
  transferred_lot: BiomassLot;
}

export interface ListingCard {
  id: string;
  title: string;
  description: string | null;
  category: string;
  material_type: string;
  unit: BiomassUnit;
  location: string | null;
  quantity_total: string;
  listing_available: string;
  price_per_unit: string;
  currency: string;
  fulfilment: string;
  available_from: string | null;
  available_until: string | null;
  quality_grade: string | null;
  source_provenance: string | null;
  moisture_percent: string | null;
  permit_status: string;
  seller_name: string;
  created_at: string;
  images?: BiomassImage[];
}

export interface ListingOwn {
  id: string;
  lot_id: string;
  title: string;
  description: string | null;
  category: string;
  material_type: string;
  unit: BiomassUnit;
  location: string | null;
  quantity_total: string;
  listing_available: string;
  listing_reserved: string;
  quantity_sold: string;
  price_per_unit: string;
  currency: string;
  fulfilment: string;
  available_from: string | null;
  available_until: string | null;
  status: ListingStatus;
  moderation_note: string | null;
  permit_status?: string;
  quality_grade?: string | null;
  moisture_percent?: string | null;
  created_at: string;
  updated_at: string;
  images?: BiomassImage[];
}

export type ListingStatus =
  | "draft"
  | "active"
  | "paused"
  | "withdrawn"
  | "sold_out"
  | "rejected";

export type ListingListingStatus = ListingStatus;

export interface ListingInput {
  lot_id: string;
  title: string;
  description?: string | null;
  quantity: string;
  price_per_unit: string;
  fulfilment: "pickup" | "delivery" | "negotiable";
  available_from?: string | null;
  available_until?: string | null;
  location?: string | null;
  publish_now: boolean;
}

export type OrderStatus =
  | "requested"
  | "awaiting_fulfilment"
  | "fulfilled"
  | "completed"
  | "cancelled"
  | "rejected"
  | "disputed";

export interface BiomassOrder {
  id: string;
  reference: string;
  listing_id: string;
  lot_id: string;
  buyer_id: string;
  seller_id: string;
  quantity: string;
  unit: BiomassUnit;
  unit_price: string;
  total_amount: string;
  currency: string;
  status: OrderStatus;
  buyer_note: string | null;
  reservation_expires_at: string | null;
  released_at: string | null;
  fulfilled_at: string | null;
  completed_at: string | null;
  cancelled_at: string | null;
  rejected_at: string | null;
  disputed_at: string | null;
  dispute_reason: string | null;
  resolution_note: string | null;
  settlement_status: "unrecorded" | "settled";
  settlement_note: string | null;
  settlement_at: string | null;
  listing_title: string | null;
  counterparty_name: string | null;
  role: "buyer" | "seller";
  created_at: string;
  updated_at: string;
}

export interface OrderPage {
  total: number;
  page: number;
  page_size: number;
  items: BiomassOrder[];
}

export interface PageMeta {
  total: number;
  page: number;
  page_size: number;
}

export interface BrowseListingPage extends PageMeta {
  items: ListingCard[];
}

export interface OrderCreateInput {
  quantity: string;
  buyer_note?: string | null;
  /** Idempotency key: retrying a timed-out request returns the SAME order
   * (HTTP 200 instead of 201) instead of double-purchasing. */
  client_request_id?: string;
}

/** Builds the multipart body the create endpoints expect: the JSON record
 * payload under `payload`, the mandatory 1–5 images under `images`. */
function multipartPayload(payload: unknown, images: File[]): FormData {
  const form = new FormData();
  form.append("payload", JSON.stringify(payload));
  for (const image of images) {
    form.append("images", image, image.name);
  }
  return form;
}

const qs = (params: Record<string, string | number | boolean | undefined>) => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined && value !== "") {
      search.set(key, String(value));
    }
  }
  const query = search.toString();
  return query === "" ? "" : `?${query}`;
};

function randomRequestId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return crypto.randomUUID();
  }
  return `req-${Date.now()}-${Math.random().toString(10).slice(2)}`;
}

export const biomassApi = {
  // -- inventory ------------------------------------------------------------
  inventory: (params: {
    search?: string;
    status_filter?: "active" | "archived" | "all";
    unit?: BiomassUnit;
    sort?: "recent" | "updated" | "quantity" | "price";
    page?: number;
    page_size?: number;
    period_days?: number;
  } = {}) => request<LotPage>(`/biomass/inventory${qs(params)}`),

  lotDetail: (lotId: string) => request<LotDetailResponse>(`/biomass/inventory/${lotId}`),

  /**
   * Creates a lot with its 1–5 MANDATORY images (multipart/form-data).
   * The backend rejects requests without images, with too many images, or
   * with files that do not decode as supported images — this client mirrors
   * those rules before uploading, but the server remains the authority.
   */
  createLot: (payload: LotCreateInput, images: File[]) =>
    request<BiomassLot>("/biomass/inventory", {
      method: "POST",
      body: multipartPayload(payload, images),
    }),

  updateLot: (lotId: string, patch: LotUpdateInput) =>
    request<BiomassLot>(`/biomass/inventory/${lotId}`, { method: "PATCH", body: patch }),

  adjustLot: (lotId: string, payload: AdjustInput) =>
    request<BiomassLot>(`/biomass/inventory/${lotId}/adjust`, {
      method: "POST",
      body: payload,
    }),

  archiveLot: (lotId: string) =>
    request<BiomassLot>(`/biomass/inventory/${lotId}/archive`, { method: "POST", body: {} }),

  restoreLot: (lotId: string) =>
    request<BiomassLot>(`/biomass/inventory/${lotId}/restore`, { method: "POST", body: {} }),

  transferLot: (lotId: string, payload: { recipient_email: string; quantity: string; note?: string | null }) =>
    request<TransferResult>(`/biomass/inventory/${lotId}/transfer`, {
      method: "POST",
      body: payload,
    }),

  /** CSV export of the caller's own inventory (server-side ownership). */
  exportCsv: async (): Promise<Blob> => {
    const response = await fetch(`${API_BASE}/biomass/inventory/export.csv`, {
      credentials: "include",
    });
    if (!response.ok) {
      throw new ApiRequestError(response.status, "Export failed. Please try again.");
    }
    return response.blob();
  },

  // -- marketplace ----------------------------------------------------------
  browseListings: (params: {
    search?: string;
    category?: string;
    unit?: BiomassUnit;
    max_price?: string;
    min_quantity?: string;
    sort?: "recent" | "price_asc" | "price_desc" | "quantity_desc";
    page?: number;
    page_size?: number;
  } = {}) =>
    request<BrowseListingPage>(`/biomass/marketplace/listings${qs(params)}`),

  listingDetail: (listingId: string) =>
    request<ListingCard>(`/biomass/marketplace/listings/${listingId}`),

  createListing: (payload: ListingInput, images: File[]) =>
    request<ListingOwn>("/biomass/marketplace/listings", {
      method: "POST",
      body: multipartPayload(payload, images),
    }),

  myListings: (params: {
    status_filter?:
      | "all"
      | "draft"
      | "active"
      | "paused"
      | "withdrawn"
      | "sold_out"
      | "rejected";
    page?: number;
    page_size?: number;
  } = {}) =>
    request<PageMeta & { items: ListingOwn[] }>(
      `/biomass/marketplace/my/listings${qs(params)}`,
    ),

  listingTransition: (
    listingId: string,
    action: "publish" | "pause" | "resume" | "withdraw",
  ) =>
    request<ListingOwn>(`/biomass/marketplace/listings/${listingId}/${action}`, {
      method: "POST",
      body: {},
    }),

  createOrder: (listingId: string, payload: OrderCreateInput) =>
    request<BiomassOrder>(`/biomass/marketplace/listings/${listingId}/orders`, {
      method: "POST",
      body: { ...payload, client_request_id: payload.client_request_id ?? randomRequestId() },
    }),

  orders: (params: {
    role?: "buying" | "selling";
    status_filter?: "all" | "open" | OrderStatus;
    page?: number;
    page_size?: number;
  } = {}) => request<OrderPage>(`/biomass/marketplace/orders${qs(params)}`),

  orderDetail: (orderId: string) =>
    request<BiomassOrder>(`/biomass/marketplace/orders/${orderId}`),

  orderAction: (orderId: string, action: "accept" | "reject" | "cancel" | "fulfil" | "confirm") =>
    request<BiomassOrder>(`/biomass/marketplace/orders/${orderId}/${action}`, {
      method: "POST",
      body: {},
    }),

  disputeOrder: (orderId: string, reason: string) =>
    request<BiomassOrder>(`/biomass/marketplace/orders/${orderId}/dispute`, {
      method: "POST",
      body: { reason },
    }),

  recordSettlement: (orderId: string, note: string) =>
    request<BiomassOrder>(`/biomass/marketplace/orders/${orderId}/settlement`, {
      method: "POST",
      body: { note },
    }),
};

// ---------------------------------------------------------------------------
// Admin biomass console (server-enforced require_admin; same shapes as the
// backend biomass_schemas). Read-only over others' data plus auditable
// moderation/corrections.
// ---------------------------------------------------------------------------

export interface AdminOwnerInfo {
  id: string;
  full_name: string;
  email: string;
}

export interface AdminLotRow extends BiomassLot {
  owner: AdminOwnerInfo | null;
  open_listings: number;
}

export interface AdminLotSummary {
  total_lots: number;
  active_lots: number;
  archived_lots: number;
  active_listings: number;
  paused_listings: number;
  withdrawn_listings: number;
  rejected_listings: number;
  orders: Record<string, number>;
  disputed_orders: number;
  movements_30d: number;
  recent_events: AuditEvent[];
}

export interface AdminListingRow extends ListingOwn {
  seller: AdminOwnerInfo | null;
}

export interface AdminOrderRow extends Omit<BiomassOrder, "role"> {
  buyer_name: string | null;
  seller_name: string | null;
}

export interface AuditEvent {
  id: string;
  actor_id: string | null;
  actor_role: string;
  action: string;
  entity_type: "lot" | "listing" | "order";
  entity_id: string;
  reason: string | null;
  detail: Record<string, unknown> | null;
  related_entity_type: string | null;
  related_entity_id: string | null;
  created_at: string;
}

/** Result of an admin permanent deletion. `status` is "completed" when the
 * database purge AND the file cleanup both succeeded, and
 * "pending_cleanup" when the record is gone but some image files still
 * need a retry — never presented as fully deleted in that case. */
export interface AdminDeletionResult {
  entity_type: "lot" | "listing";
  entity_id: string;
  status: "completed" | "pending_cleanup";
  removed_files: number;
  missing_files: number;
  failed_files: number;
}

export interface AuditPage extends PageMeta {
  items: AuditEvent[];
}

export const adminBiomassApi = {
  overview: () => request<AdminLotSummary>("/admin/biomass/overview"),

  inventory: (params: {
    search?: string;
    status_filter?: "active" | "archived" | "all";
    flagged?: boolean;
    page?: number;
    page_size?: number;
  } = {}) =>
    request<PageMeta & { items: AdminLotRow[] }>(
      `/admin/biomass/inventory${qs({
        ...params,
        flagged: params.flagged === true ? "true" : undefined,
      })}`,
    ),

  inventoryDetail: (lotId: string) => request<AdminLotRow>(`/admin/biomass/inventory/${lotId}`),

  inventoryFullDetail: (lotId: string) =>
    request<{
      lot: AdminLotRow;
      movements: {
        id: string;
        movement_type: string;
        quantity_delta: string;
        quantity_before: string;
        quantity_after: string;
        reason: string | null;
        created_at: string;
      }[];
      listings: AdminListingRow[];
      orders: AdminOrderRow[];
    }>(`/admin/biomass/inventory/${lotId}/detail`),

  adjustLot: (
    lotId: string,
    payload: AdjustInput,
  ) =>
    request<AdminLotRow>(`/admin/biomass/inventory/${lotId}/adjust`, {
      method: "POST",
      body: payload,
    }),

  archiveLot: (lotId: string) =>
    request<AdminLotRow>(`/admin/biomass/inventory/${lotId}/archive`, {
      method: "POST",
      body: {},
    }),

  restoreLot: (lotId: string) =>
    request<AdminLotRow>(`/admin/biomass/inventory/${lotId}/restore`, {
      method: "POST",
      body: {},
    }),

  flagLot: (lotId: string, note: string) =>
    request<AdminLotRow>(`/admin/biomass/inventory/${lotId}/flag`, {
      method: "POST",
      body: { note },
    }),

  listings: (params: {
    status_filter?:
      | "all"
      | "draft"
      | "active"
      | "paused"
      | "withdrawn"
      | "sold_out"
      | "rejected";
    search?: string;
    page?: number;
    page_size?: number;
  } = {}) =>
    request<PageMeta & { items: AdminListingRow[] }>(
      `/admin/biomass/listings${qs(params)}`,
    ),

  listingAction: (
    listingId: string,
    action: "reject" | "suspend" | "reinstate",
    reason: string,
    force = false,
  ) =>
    request<AdminListingRow>(`/admin/biomass/listings/${listingId}/${action}`, {
      method: "POST",
      body: action === "reinstate" ? {} : { reason, force },
    }),

  orders: (params: {
    status_filter?: OrderStatus;
    search?: string;
    page?: number;
    page_size?: number;
  } = {}) =>
    request<
      PageMeta & { status_breakdown: Record<string, number> | null; items: AdminOrderRow[] }
    >(`/admin/biomass/orders${qs(params)}`),

  orderDetail: (orderId: string) =>
    request<AdminOrderRow>(`/admin/biomass/orders/${orderId}`),

  resolveDispute: (orderId: string, action: "resume" | "cancel", note: string) =>
    request<AdminOrderRow>(`/admin/biomass/orders/${orderId}/resolve-dispute`, {
      method: "POST",
      body: { action, note },
    }),

  audit: (params: {
    action?: string;
    entity_type?: "lot" | "listing" | "order";
    entity_id?: string;
    search?: string;
    page?: number;
    page_size?: number;
  } = {}) => request<AuditPage>(`/admin/biomass/audit${qs(params)}`),

  /** PERMANENT deletion. Requires the record's exact title as the explicit
   * confirmation; the server enforces admin authorization regardless. */
  purgeLot: (lotId: string, confirmTitle: string) =>
    request<AdminDeletionResult>(`/admin/biomass/inventory/${lotId}`, {
      method: "DELETE",
      body: { confirm_title: confirmTitle },
    }),

  purgeListing: (listingId: string, confirmTitle: string) =>
    request<AdminDeletionResult>(`/admin/biomass/listings/${listingId}`, {
      method: "DELETE",
      body: { confirm_title: confirmTitle },
    }),
};
