# API Contract — Bioeconomy

Status: partial. The authentication (+ email verification) slice, the admin
supervision slice, and the biomass inventory + marketplace slice below are
implemented and verified (2026-10-26; Tasks: secure registration/auth, Task
003 email verification, Task 005 admin panel, biomass inventory &
marketplace). Everything else in the platform (geospatial datasets,
telemetry, analytics) has no API yet. Do not assume undocumented endpoints.

Base path: `/api/v1`

## Authentication

### POST /api/v1/auth/register

Request:

```json
{ "full_name": "Jane Farmer", "email": "jane@example.com", "password": "…≥10 chars…" }
```

- Full name: 1–200 chars (trimmed). Email: valid RFC-style address ≤320
  chars, normalized to lowercase server-side. Password: 10–200 chars.
- Unknown/extra JSON fields (e.g. `role`, `is_active`, `is_email_verified`)
  are ignored.
- The configured provider is asked to send a verification email to the
  normalized address (default expiry `VERIFICATION_TOKEN_MINUTES = 30`).
- 201 → `RegisterResponse`; `Set-Cookie` is NOT issued (no auto sign-in).
  `email_delivery` is honest: `"accepted"` when the provider API accepted the
  message for processing, `"failed"` when it did not (the account still
  exists and is recoverable through resend), and `"unknown"` when a timeout
  or transport error leaves API acceptance undetermined. `"accepted"` is NOT
  a delivery confirmation; inspect the provider's event log for delivery
  status. For `"unknown"`, check inbox/spam before resending because the
  provider may have accepted the original request.
- 409 → `{ "detail": "This email address is already registered." }`
- 422 → FastAPI validation errors; 429 → rate limit; 403 → disallowed Origin.

Example 201 body:

```json
{
  "id": "uuid",
  "full_name": "Jane Farmer",
  "email": "jane@example.com",
  "role": "user",
  "is_active": true,
  "is_email_verified": false,
  "created_at": "ISO-8601 tz-aware",
  "updated_at": "ISO-8601 tz-aware",
  "verification_required": true,
  "email_delivery": "accepted"
}
```

### POST /api/v1/auth/login

Request: `{ "email", "password" }`. 200 → `UserPublic` and:

```
Set-Cookie: bio_session=<token>; HttpOnly; Path=/; SameSite=Lax; Max-Age=604800
```

(`Secure` is added when `COOKIE_SECURE=1`.) 401 → generic
`Invalid email or password.` for both unknown email and wrong password.
403 → `Account is inactive.`

**403 (verification gate)** — unverified accounts are refused BEFORE any
session is created:

```json
{ "detail": { "message": "This account is not verified. Please confirm your email address first.", "code": "email_verification_required" } }
```

Clients should branch on `code`, not on the prose.

### POST /api/v1/auth/logout

204 → empty body; session row (if any) is revoked server-side and the
cookie is cleared. Idempotent for anonymous callers.

### GET /api/v1/auth/me

200 → `UserPublic` of the session owner; 401 when the cookie is missing,
revoked, or expired; 403 with `code: "email_verification_required"` when the
session belongs to an unverified account (server-side gate — applies even to
sessions created before verification existed).

### POST /api/v1/auth/verify-email

Request: `{ "token": "<raw token from the emailed link>" }`.

- 200 → `{ "message": "Email address verified. You can now sign in." }`
- 400 → one generic body for ALL failure classes (unknown token, expired
  token, already-used token); clients cannot distinguish them:

```json
{ "detail": "This verification link is invalid or has expired. Request a new verification email." }
```

- 422 → malformed request; 429 → rate limit; 403 → disallowed Origin.
- The link format the user receives:
  `{APP_BASE_URL}/#/verify-email?token=<raw>` — frontend route, not an API
  route; the frontend performs this POST.

### POST /api/v1/auth/resend-verification

Request: `{ "email": "jane@example.com" }`.

- **202 always** (for any syntactically valid email) with one constant body:

```json
{ "message": "If this address has an account awaiting verification, we have attempted to send a new verification email. This message does not confirm delivery." }
```

- The response is deliberately non-enumerating: account existence, verified
  state, and delivery outcome are indistinguishable from the outside.
  Delivery problems are observable server-side only (logs). A new token
  supersedes the account's previous unconsumed tokens.
- 422 → invalid email shape; 429 → rate limit; 403 → disallowed Origin.

The same neutral response is used after provider rejection to prevent account
enumeration. The server records a safe error category and correlation ID for
diagnostics. Resend attempts are also limited to three per normalized address
per hour by default (`VERIFICATION_EMAIL_LIMIT_PER_HOUR`).

### POST /api/v1/auth/forgot-password

Request: `{ "email": "jane@example.com" }`. Always returns the same 202
message for a missing, ineligible, or eligible account. Active, verified
accounts receive a single-use reset link when the provider accepts the send.
The reset token is random, expires after `PASSWORD_RESET_TOKEN_MINUTES` (30 by
default), and only its SHA-256 hash is stored. Per-IP and per-normalized-address
rate limits apply. The neutral response does not confirm provider acceptance
or mailbox delivery.

### POST /api/v1/auth/reset-password

Request: `{ "token": "<raw reset token>", "password": "<new password>" }`.
Success returns 200 and revokes all existing database sessions for that user.
Invalid, expired, consumed, or revoked tokens return one generic 400. The raw
token is never persisted or logged; the frontend removes it from the address
bar before submitting it.

### Response schemas

`UserPublic` (also the 200 body of login and `me`):

```json
{
  "id": "uuid",
  "full_name": "string",
  "email": "string (lowercase)",
  "role": "user",
  "is_active": true,
  "is_email_verified": false,
  "created_at": "ISO-8601 tz-aware",
  "updated_at": "ISO-8601 tz-aware"
}
```

No endpoint ever returns `password_hash`, session tokens, verification
tokens, or any other authentication secret. `role`, `is_active`,
`is_email_verified` are server-controlled; client fields of those names are
ignored.

### Health

- `GET /api/v1/health` → `{ "status": "ok" }` (liveness only; performs no
  database round-trip by design).

## Admin (Task 005 — implemented and verified 2026-10-24)

All `/api/v1/admin/*` endpoints are server-guarded, in this order:

1. **401** — no cookie, or revoked/expired/inactive-owner session
   (inherited from the authentication dependency).
2. **403 `email_verification_required`** — session belongs to an unverified
   account (the verification gate outranks the role gate).
3. **403 `admin_required`** — session verified but the owner's `role` is not
   `"admin"`:

```json
{ "detail": { "message": "Administrator access is required.", "code": "admin_required" } }
```

Roles are read from the database on every request: a flipped role applies to
already-issued sessions immediately. The FIRST (and any) admin is created
exclusively by the operator via documented SQL (see docs/DATABASE.md) — no
endpoint can create an admin, and client-supplied `role` fields are ignored
everywhere.

### GET /api/v1/admin/overview

200 → `AdminOverview`:

```json
{
  "total_users": 4,
  "verified_users": 3,
  "active_users": 3,
  "admin_users": 1,
  "live_sessions": 2,
  "recent_registrations": [ { "…AdminUserSummary…": "latest 5" } ]
}
```

`live_sessions` counts non-revoked, non-expired session rows.

### GET /api/v1/admin/users

Query: `search` (≤120 chars, ILIKE substring over email/full_name, optional),
`page` (≥1, default 1), `page_size` (1–100, default 20). 200 → `AdminUserList`:

```json
{
  "total": 42,
  "page": 1,
  "page_size": 20,
  "items": [ { "…AdminUserSummary…": "" } ]
}
```

Ordering is always `created_at DESC` (server-defined).

`AdminUserSummary` = `UserPublic` fields plus:

```json
{
  "is_email_verified": true,
  "email_verified_at": "ISO-8601 or null",
  "live_session_count": 2
}
```

422 → invalid query parameters.

### GET /api/v1/admin/users/{user_id}

200 → `AdminUserDetail` = `AdminUserSummary` plus:

```json
{
  "sessions": [
    {
      "id": "uuid",
      "created_at": "ISO-8601",
      "expires_at": "ISO-8601",
      "revoked_at": "ISO-8601 or null",
      "live": true
    }
  ]
}
```

Up to the 50 most recent session rows, metadata only — no token hashes are
ever exposed. 404 → generic `User not found.` (no existence-oracle details).

### PATCH /api/v1/admin/users/{user_id}

Request (both fields optional, ignored extras):

```json
{ "is_active": false }
```

- 200 → updated `AdminUserSummary`.
- Setting `is_email_verified: false` (or `is_active: false`) also revokes
  ALL of that user's live sessions server-side, so the flag change has an
  immediate effect. Un-verify clears `email_verified_at`; force-verify
  stamps it.
- **Self-protection (400)**: an admin cannot deactivate or un-verify their
  own account (either would cut them off from these endpoints immediately).
- 404 → unknown user; 403 → untrusted Origin / non-admin; 429 → rate limit.

### POST /api/v1/admin/users/{user_id}/sessions/revoke

Request: `{}` (omit `session_id` ⇒ revoke ALL live sessions of the user) or
`{ "session_id": "<uuid>" }` (revoke that one session).

- 200 → `{ "revoked": <n> }` (n = actual number of rows revoked; 0 for an
  unknown session id on a real user).
- 404 → unknown user (checked BEFORE any revocation); 403 → non-admin /
  untrusted Origin; 429 → rate limit.

### POST /api/v1/admin/users/{user_id}/role

Request: `{ "role": "user" | "admin" }` (only these two values exist; other
values → 422).

- 200 → updated `AdminUserSummary`.
- **Self-protection (400)**: an admin cannot demote themselves (prevents the
  last-admin lockout). Promoting another user takes effect on their next
  request/log-in without any session invalidation.
- 404 unknown user; 403 non-admin / untrusted Origin; 429 rate limit.

## Biomass inventory & marketplace (implemented and verified 2026-10-26)

All `/api/v1/biomass/*` endpoints require a verified session (the same 401 →
403 `email_verification_required` order as the admin API). Every
state-changing request also runs the shared untrusted-Origin check and the
`biomass` rate-limit scope. Quantities are Decimal and serialize as JSON
STRINGS (e.g. `"500.500"`, exactly 3 decimals) — never parse them as floats.
`null` means unknown; zero is never fabricated.

### Inventory

- `GET /biomass/inventory` — `search`, `status_filter` (`active|archived|all`,
  default `active`), `unit` (`kg|t|m3`), `sort`
  (`recent|updated|quantity|price`), `period_days` (1–365), `page`,
  `page_size`. 200 → `LotPage { summary: InventorySummary, total, page,
  page_size, items }`. The summary aggregates per unit — quantities of
  different units are never summed, and `low_stock_lot_ids` flags active lots
  whose available quantity fell to ≤10% of `quantity_total`.
- `POST /biomass/inventory` — create a lot; **`multipart/form-data`**:
  `payload` is the LotCreateRequest JSON string (`title`, `category`,
  `material_type`, `unit` `kg|t|m3`, `quantity` > 0, `storage_location`;
  optional `moisture_percent` 0–100, `harvest_date`, `source_provenance`,
  `quality_grade`, `quality_note`, `permit_reference`, `price_per_unit`,
  `currency` ISO-4217) and `images` is 1–5 image files. An image set is
  COMPULSORY: **a lot is never registered without at least one image** and
  never with more than five (422); each file must be JPEG, PNG or WebP —
  decided by magic-byte sniffing, not the client's declared type — and ≤
  `BIOMASS_IMAGE_MAX_MB` (413 when over). Images are validated BEFORE any
  row is written and persisted inside the creation transaction, so a
  failed upload never leaves a half-registered lot. 201 → `LotOut`
  (carries `images[]` with authorized `url`s). A provided
  `permit_reference` is stored with `permit_status: "unverified"` — the
  platform does NOT verify it.
- `GET /biomass/inventory/{lot_id}` — 200 → `LotDetail { lot, movements }`
  (newest-first movement journal, ≤50 rows). **404 for a lot that exists but
  belongs to another user** (indistinguishable from nonexistent — no
  existence oracle).
- `PATCH /biomass/inventory/{lot_id}` — metadata-only edit. A payload that
  contains `quantity` is rejected 422 ("record a stock adjustment instead") —
  quantities are never silently overwritten.
- `POST /biomass/inventory/{lot_id}/adjust` — `{ kind: addition|removal|
  correction, quantity? , new_available? , reason (required, ≤500) }`.
  Addition/removal mutate the balance through one appended `stock_movements`
  row; `correction` sets the exact available quantity and records
  before/after. 409 when a removal would exceed the available quantity or a
  correction is a no-op. 422 when the required reason is missing.
- `POST .../archive`, `POST .../restore` — 409 when already archived /
  restoring an active lot... archive is refused when the lot still has
  open marketplace listings.
- `POST .../transfer` — `{ recipient_email, quantity, note? }`; 201 →
  `TransferResult { source_lot, transferred_lot }`. The recipient gets a NEW
  lot whose movement journal starts with a `transfer_in` row and whose
  `source_provenance` traces the original; 400 for unknown/unactive
  recipient or self-transfer.
- `GET /biomass/inventory/export.csv` — CSV of the caller's own inventory
  (`text/csv; charset=utf-8`, `Content-Disposition: attachment`).

### Marketplace listings

- `GET /biomass/marketplace/listings` — public browse (only `active`
  listings on `active` lots). Query: `search`, `category`, `material_type`,
  `unit`, `min_quantity`, `max_price`, `sort`
  (`recent|price_asc|price_desc|quantity_desc`), paging. Cards expose the
  seller's display name only — NO seller id/email on public shapes. Runs an
  honest-availability sweep (expired reservations released) on every read.
- `GET /biomass/marketplace/listings/{id}` — `ListingCard`; also sweeps
  that listing's stale reservations before showing availability.
- `POST /biomass/marketplace/listings` — **`multipart/form-data`**:
  `payload` is the ListingCreateRequest JSON string (`{ lot_id, title,
  quantity, price_per_unit > 0, fulfilment: pickup|delivery|negotiable,
  publish_now, description?/location?/available_from?/available_until? }`)
  plus the COMPULSORY 1–5 `images` files (same rules as lot creation —
  format sniffed from bytes, per-file size cap → 413, count 1–5 → 422;
  validated before the lot lookup so client errors surface before
  resource checks). 201 → `ListingOwn` (carries `images[]`). Offered
  quantity is validated against the lot's available quantity MINUS the
  offered quantity of the lot's other live listings (drafts consume room
  too); 409 when exceeded.
- `GET /biomass/marketplace/my/listings?status_filter=...` — the seller's
  management view (includes `listing_reserved`, `quantity_sold`,
  `moderation_note`).
- `PATCH /marketplace/listings/{id}` — seller edits; `POST
  /marketplace/listings/{id}/publish|pause|resume|withdraw` — state
  transitions drafted/active/paused/withdrawn (server-validated).
- Listing states: `draft`, `active`, `paused`, `withdrawn`, `sold_out`,
  `rejected` (admin moderation). There is no pre-publish moderation gate;
  admins reject/suspend afterwards.

### Record images

- `GET /biomass/images/{image_id}` — serves ONE image's file bytes to
  authorized viewers (requires a verified session; anonymous requests are
  401 at the gate). **Access rules** — everything else is 404
  (indistinguishable from a nonexistent image, no existence oracle):
  - lot image: the lot owner (or an admin);
  - listing image: the seller (or an admin) always; ANY verified user
    while the listing is `active` (matches marketplace visibility).
  Response: the sniffed media type `image/jpeg|png|webp` and the exact
  stored bytes; inline (no `Content-Disposition: attachment`).
- `ImageOut` shape (nested on `LotOut` / `ListingCard` / `ListingOwn` /
  admin lot payloads): `{ id, position (1–5), original_name, content_type,
  size_bytes, created_at, url }` where `url` is the endpoint above — there
  are NO public static file URLs.
- Images are immutable through the API: there is no add/remove/reorder
  endpoint; a record's gallery is fixed at creation. Delete-orphan applies
  only at the database level via CASCADE.

### Orders (full transaction lifecycle)

- `POST /biomass/marketplace/listings/{id}/orders` — body `{ quantity,
  buyer_note?, client_request_id? }`. Creates order status `requested` and
  atomically RESERVES stock under PostgreSQL row locks (`FOR UPDATE` on the
  listing and the lot, revalidated inside the transaction): two concurrent
  buyers can never reserve more than the lot has; one gets 201, the other
  409. Sending the SAME `client_request_id` again returns the SAME order
  with **200** instead of 201 — an idempotent retry, not a second purchase.
  Self-purchase is 409. Order reference format: `BO-XXXXXXXX`.
- `GET /biomass/marketplace/orders?role=buying|selling&status_filter=all|
  open|<status>` and `GET /biomass/marketplace/orders/{id}` —
  `OrderOut`; exposure requires being buyer or seller (otherwise 404).
- Transitions (all server-validated against status AND role; mismatched
  role/actor is 403 or 404, wrong state is 409):
  - buyer `POST .../cancel` (while `requested`) releases the reservation
    exactly once (enforced: duplicate release raises 409).
  - seller `POST .../accept` → `awaiting_fulfilment`, or `POST
    .../reject` → `rejected` (releases the reservation too).
  - **reservation expiry**: `requested` orders unaccepted for 72 hours are
    expired lazily on the next relevant read/service call — status becomes
    `cancelled` with `released_at` set and one `release` movement appended.
  - seller `POST .../fulfil` (from `awaiting_fulfilment`) converts
    reserved → sold; idempotency enforced (second fulfil is 409).
  - buyer `POST .../confirm` (from `fulfilled`) → `completed`. A completed
    order can never be re-transitioned.
  - buyer `POST .../dispute` `{ reason required }` from
    `requested|awaiting_fulfilment|fulfilled` → `disputed`; the order is
    frozen (other transitions are 409 while disputed).
  - seller `POST .../settlement` `{ note }` — records that payment moved
    OFF-platform (`settlement_status: "settled"`). NO payment provider is
    configured: this is a manual, clearly-labelled record only. Buyer
    attempt is 403; double settlement 409.
- Admin dispute resolution: `POST /api/v1/admin/biomass/orders/{id}/
  resolve-dispute` `{ action: resume|cancel, note required }` on
  `disputed` orders only. For orders that were already fulfilled, `cancel`
  is refused with 409 — stock has legally moved; only `resume` is valid.

### Admin biomass console (`/api/v1/admin/biomass/*`, require_admin)

- `GET /overview` — live metrics: lot/listing counts by status, order
  counts by status, disputed count, adjustment movements, 10 newest audit
  events. Nothing fabricated.
- `GET /inventory` (+`/inventory/{id}`, `/inventory/{id}/detail`) — global
  inspection including owner identity (email/name), search, `flagged`
  filter; detail adds movements, listings, and orders for the lot.
- `POST /inventory/{id}/adjust|archive|restore|flag` — same service rules
  as the user API but with admin actions (`admin_correction` movement,
  `admin.*` audit events). A reason is mandatory on adjust; flag stores a
  recorded note.
- `GET /listings`, `POST /listings/{id}/reject` (reason required),
  `POST .../suspend` (409 with `code: "active_requests_exist"` while
  purchase requests are open; `force: true` also cancels + releases those
  orders), `POST .../reinstate` (→ `paused`, never silently re-publishes).
- `GET /orders` (status filter + reference search), `GET /orders/{id}`,
  `POST .../resolve-dispute` (see above). Completed orders cannot be
  rewritten: the resolve endpoint only works on disputed rows and there is
  no PATCH anywhere.
- `GET /audit` — READ-ONLY audit explorer: filters `action`,
  `entity_type` (`lot|listing|order`), `entity_id`, `search`, paging.
  There is deliberately no endpoint that creates, updates, or deletes
  audit rows; the database trigger `biomass_audit_append_only` refuses
  UPDATE and DELETE at the engine level.

#### Admin permanent deletion (implemented and verified 2026-10-27)

- `DELETE /api/v1/admin/biomass/inventory/{lot_id}` and
  `DELETE /api/v1/admin/biomass/listings/{listing_id}` — body
  `{"confirm_title": "<exact record title>"}` (retype-confirmation;
  mismatch → 400, missing field → 422). Admin-only (401 unauthenticated,
  403 non-admin, re-checked in the service layer).
- Deletion policy: hard-delete ONLY when no order (any status) references
  the record (directly or, for lots, via its listings) — otherwise 409
  `"This record is referenced by purchase transactions…"`; archive/withdraw
  remain the options there. A lot purge removes the lot, its stock-movement
  journal, its order-free listings, all image metadata rows, and the image
  files on disk. A listing purge removes the listing, its image metadata,
  and its files; the source lot is untouched.
- Two phases: the DB purge (record + dependents + a tracking row in
  `biomass_deletion_cleanups` listing the exact storage keys) commits
  atomically; files are unlinked AFTER the commit by `safe_unlink`
  (server-generated names only, contained in the upload dir, no
  symlinks/directories, missing files count as cleaned). File failures
  leave the tracking row `pending` — retry the same request to finish.
- Responses: `200 {"entity_type", "entity_id", "status": "completed" |
  "pending_cleanup", "removed_files", "missing_files", "failed_files"}` —
  `pending_cleanup` is explicitly NOT reported as fully deleted. A repeat
  request for a fully deleted id → 404. Duplicate/concurrent requests are
  serialized by `SELECT … FOR UPDATE`; exactly one purge occurs.
- Audit: appends `admin.lot.deleted` / `admin.listing.deleted` (actor,
  title, counts) and `admin.deletion.cleanup_completed` when files finish.
  The append-only audit log is RETAINED (never purged); it contains no
  image contents. Backups/replicas are NOT claimed purged (see SECURITY).

## Not yet defined

Geospatial dataset provenance endpoints, IoT ingestion, analytics
(biomass inventory + marketplace are now implemented above). When this
writer documents a planned-but-unbuilt contract, it must be clearly marked
as a draft until the implementation and its tests exist.
