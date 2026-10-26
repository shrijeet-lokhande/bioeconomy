# Current State

Last updated: 2026-10-27 — **Admin permanent record deletion** on top of
Task 007 (compulsory 1–5 record images), Task 006 (biomass inventory &
marketplace), Task 005 (admin panel), Task 003 (email verification) and
Task 002 (authentication). All slices are implemented, tested, and live
on this machine.

## What was implemented (admin permanent deletion, 2026-10-27)

Administrators can permanently delete biomass inventory lots and
marketplace listings — database rows, exclusively-owned dependents, image
metadata, and image files on disk — with server-enforced admin
authorization, retype-confirmation, order-history protection, a two-phase
reliable file cleanup, audit events, and full test coverage.

### Backend (`backend/src/backend/`)

- `services/purge.py` (NEW) — `purge_lot` / `purge_listing`: defense-in-
  depth admin re-check; confirmation requires the record's exact title
  (else 400); ANY order reference (any status, incl. cancelled) refuses
  with 409 — transaction history is never destroyed. One atomic DB
  transaction deletes the record + dependents (images, movements,
  order-free listings) + inserts a `biomass_deletion_cleanups` tracking
  row with the exact storage keys; `SELECT … FOR UPDATE` on the record
  serializes duplicate/concurrent requests. Files are unlinked AFTER the
  commit (idempotent; missing files count as cleaned); failures leave the
  tracking row `pending` and the response `status: "pending_cleanup"` —
  never a false "fully deleted". Repeating the same DELETE finishes a
  pending cleanup; a fully deleted id answers 404.
- `services/biomass_images.py` — added `safe_unlink` (strict regex for
  server-generated names `^[0-9a-f]{32}\.(jpg|png|webp)$`, resolved-path
  containment in the upload dir, symlink/directory refusal, missing-file
  idempotence) and `cleanup_files`.
- `api/admin_biomass.py` — `DELETE /api/v1/admin/biomass/inventory/{id}`
  and `DELETE /api/v1/admin/biomass/listings/{id}` (require_admin,
  origin check, rate limit; thin over the service).
- `services/audit.py` — new closed-set actions `admin.lot.deleted`,
  `admin.listing.deleted`, `admin.deletion.cleanup_completed`.
- `models.py` + migration `b4d7e91c2a55_admin_permanent_deletion`
  (down_revision `f1c49d83a2b0`, applied to the dev DB) —
  `biomass_deletion_cleanups` table (UNIQUE(entity_type, entity_id),
  status/attempts/file counters, JSONB storage_keys). Non-destructive.
- `biomass_schemas.py` — `AdminDeletionRequest`, `AdminDeletionResult`.

### Frontend (`frontend/src/`)

- `lib/api.ts` — `RequestOptions.method` gained `"DELETE"`;
  `AdminDeletionResult` type; `adminBiomassApi.purgeLot` /
  `purgeListing`.
- `pages/admin/AdminBiomassTab.tsx` — "Delete permanently" (btn--danger)
  on every lot and listing row; `PurgeDialog` shows the record's title +
  ID, warns the operation is irreversible, and requires retyping the
  exact title before the destructive button unlocks; busy-guarding
  prevents double submissions; outcome is reported accurately — success
  (form-note), pending file cleanup (new form-warn tone with retry
  guidance), or failure (form-error with the server's message); the list
  refreshes in place. The tab's `run` helper now supports result-derived
  feedback (note/error/warn tones).
- `index.css` — new `.form-warn` (earth-palette warning banner).

### Commands executed and actual results (permanent deletion)

| Command | Result |
| --- | --- |
| `uv run alembic upgrade head` | migration `b4d7e91c2a55` applied to the dev DB (biomass_deletion_cleanups; no existing data touched) |
| `uv run pytest -q` (backend) | **93 passed** — 79 previous + 14 deletion scenarios: lot purge w/ images rows+files+movements, listing purge w/o touching the lot, non-admin 403, anonymous 401, unknown 404, unrelated records+files intact, traversal/symlink/directory-name refusal, missing-files idempotence, interrupted-purge retry to completion, storage-refusal → pending_cleanup (never false success), sequential+threaded concurrent duplicates (one purge, one tracking row), order-referenced refusal 409 incl. cancelled orders with everything intact, wrong confirmation 400/422, minimal audit events without image contents |
| Frontend `npm test` | **115 passed** (12 files) — +5 admin deletion UI tests: title-retype gating (no DELETE ever sent until exact match, dialog shows title + ID), lot deletion success with in-place list refresh, listing deletion, 409 refusal surfaced with the record still listed, pending-cleanup reported without claiming full deletion |
| `npx tsc -b` / `npm run build` | exit 0 / OK |

Honesty record (permanent deletion):

- Audit log rows are deliberately RETAINED (append-only trigger) — they
  are the security record; they contain no image bytes.
- Backups, snapshots, replicas, journals, and external storage version
  history are NOT purged and are not claimed to be (docs/SECURITY.md).
- Database rows disappear atomically; file bytes are cleaned after the
  commit — the reverse failure mode (row without file) is impossible by
  construction; a file-cleanup failure is retryable and accurately
  reported.

## What was implemented (Task 007 — record images)

Registering an inventory lot and publishing a marketplace listing now both
REQUIRE 1–5 images, uploaded together with the record in one multipart
request so a record can never exist without its gallery.

### Backend (`backend/src/backend/`)

- **Migration `f1c49d83a2b0_biomass_record_images`** — new `biomass_images`
  table (lot_id XOR listing_id via CHECK, `position` 1–5 CHECK + per-parent
  UNIQUEs, `stored_name` UNIQUE server-generated uuid, `original_name`
  sanitized basename, `content_type ∈ jpeg|png|webp` CHECK, `size_bytes`
  CHECK, created_at) + listing index. Non-destructive; applied to the dev
  DB (see docs/DATABASE.md).
- **`services/biomass_images.py`** — `validate_images()` decides everything
  from BYTES (magic-byte sniffing: JPEG/PNG/WebP only — declared MIME and
  filename are untrusted; count 1–5 → 422; per-file cap
  `BIOMASS_IMAGE_MAX_MB` → 413; empty file → 422; extension contradicting
  the real format → 422) and `persist_images()` writes files under
  server-generated names and queues the rows inside the caller's OPEN
  transaction. Nothing about an upload is trusted end-to-end.
- **`services/biomass.py`** — `create_lot`/`create_listing` gained the
  images contract: validation FIRST (a client error raises before any
  record exists), gallery persisted in the SAME transaction as the record
  — a half-registered record is impossible. Listing validation even runs
  before the lot lookup. `lot.created`/`listing.created` audit details
  now include the image count.
- **`api/biomass.py`** — `POST /biomass/inventory` and
  `POST /biomass/marketplace/listings` are `multipart/form-data`
  (`payload` JSON string + `images` files); new
  `GET /biomass/images/{image_id}` serves bytes to authorized viewers
  (lot images: owner/admin; listing images: seller/admin, any verified
  user while `active`; else 404, anonymous 401 at the gate) with the
  sniffed media type; `ImageOut` (computed authorized `url`) now nests on
  `LotOut`, `ListingCard`, `ListingOwn` and admin lot payloads; list
  endpoints eager-load image rows.

### Frontend (`frontend/src/`)

- **`components/ImageUploadField.tsx`** — shared upload field for BOTH
  creation forms: picker button, drag-and-drop, previews (object URLs
  revoked eagerly), live `n/5 images uploaded` count, per-file validation
  messages, removal, hard stop at five.
- **`domain/imageValidation.ts`** — pure client mirror of the server rules
  (count, sniffing from magic bytes, size cap) — usability only, the
  server re-validates everything.
- **`pages/BiomassInventoryPage.tsx`** — the lot form and the
  "List on marketplace" form each carry an image field; submitting is
  blocked until at least one image is selected; the lot manager shows the
  record's gallery; server rejections surface without losing input.
- **`pages/MarketplacePage.tsx`** — browse cards and my-listings rows show
  the primary image; the purchase dialog shows the listing gallery.
- **`components/RecordImage.tsx`** — `RecordThumb`/`RecordGallery` render
  honest placeholders for legacy records without images (the mandatory
  rule applies to NEW records only); sources point at the authorized
  endpoint so the session decides visibility.
- **`lib/api.ts`** — `BiomassImage` type, `IMAGE_RULES`/`IMAGE_UPLOAD_HINT`,
  `createLot`/`createListing` send `multipart/form-data`
  (payload + files; no client Content-Type header).

## Commands executed and actual results (Task 007)

| Command | Result |
| --- | --- |
| `uv run alembic upgrade head` | migration `f1c49d83a2b0` applied to the dev DB (biomass_images table + index; no existing data touched) |
| `uv run pytest -q` (backend) | **79 passed** — 74 previous + 5 image scenarios: compulsory ≥1 (lot AND listing, nothing half-registered), count/format/extension-mismatch/oversize rules incl. 413, listing image exposure on browse cards, image access rules (stranger 200 on active-listing image / 404 on lot image / 401 anonymous), admin/owner/paused-listing access |
| Frontend `npm run test` | **110 passed** — 12 files incl. new domain `imageValidation` (15) and `ImageUploadField` component (7) suites; flow tests assert the blocked-submit-without-images path, the multipart body (payload + files), server-error surfacing without input loss, the publish-listing mandatory-image path, browse/detail image display, and legacy no-image degradation |
| `npx tsc -b` / `npm run build` | exit 0 / OK |

Honesty record (Task 007):

- The uploading forms validate client-side ONLY for usability; the server
  re-validates count, exact bytes, size — the client copy can never be the
  only guard.
- Failed multi-step repositories leave at most an orphan FILE on disk
  (harmless, outside the DB); the reverse (row without file) is
  impossible by ordering — deliberate trade-off, documented in the service
  docstrings.
- Legacy records created before this feature legitimately have zero
  images; UI shows an honest placeholder and the rule applies to new
  records only.
- No commits were made (per task rules); nested `backend/.git` still means
  never `git add .` at the root.

## What was implemented (Task 006 — biomass inventory & marketplace)

### Backend (`backend/src/backend/`)

- **Migration `5c1f2a9d7b40_biomass_inventory_marketplace`** — five new
  tables, non-destructive (see docs/DATABASE.md for the schema):
  `biomass_lots`, `biomass_listings`, `biomass_orders`, `stock_movements`
  (append-only journal with before/after), and `biomass_audit_events`
  (append-only enforced by the DB trigger `biomass_audit_append_only`).
  All quantities are NUMERIC; every non-key value set is constraint-checked.
- **`services/biomass.py`** — the lifecycle core. Every balance change
  appends a movement inside the same PostgreSQL transaction; reservations
  and fulfilment lock the listing + lot rows (`FOR UPDATE`, revalidated);
  quantities are Decimal end-to-end. State machines for lots (`active`/
  `archived`), listings (`draft`/`active`/`paused`/`withdrawn`/
  `sold_out`/`rejected`) and orders (`requested` → accept/reject/cancel/
  expire-72h → `awaiting_fulfilment` → `fulfilled` → `completed`/
  `disputed`; settle-record only). Reservation release is exactly-once;
  expired reservations are released lazily on reads. Same
  `client_request_id` returns the SAME order (200, idempotent).
- **`api/biomass.py`** — user endpoints: inventory CRUD-without-overwrite
  (PATCH rejects `quantity` with 422), adjust/transfer/archive/restore,
  CSV export, marketplace browse (vendor display name only on public
  shapes), my-listings + transitions, order create/list/detail/
  cancel/accept/reject/fulfil/confirm/dispute/settlement. Non-owner
  detail reads are 404 with the same body as missing (no existence
  oracle).
- **`api/admin_biomass.py`** — admin console under `require_admin`:
  overview metrics, global inventory inspection (owner identity shown),
  adjust (`admin_correction` movement) / flag / archive / restore,
  listing reject / suspend (409 while open requests exist, or `force`)/
  reinstate, order listing + `resolve-dispute` (resume|cancel; fulfilled
  orders cannot be cancelled — 409), read-only audit explorer with
  filters/paging. Every admin state change appends an audit event.

### Frontend (`frontend/src/`)

- **`pages/BiomassInventoryPage.tsx`** — rewritten against the real API
  (the localStorage demo store is gone from this page): summary cards,
  low-stock strip, search/status/unit/sort/pager, CSV export, lot form,
  lot manager (adjustment with mandatory reason, transfer, publish),
  movement journal per lot.
- **`pages/MarketplacePage.tsx`** — new: Browse / Purchases / Sales /
  My listings tabs; purchase dialog with idempotent request id; role- and
  status-correct order actions with honest 72h-expiry and
  manual-settlement wording.
- **`pages/admin/AdminBiomassTab.tsx` / `AdminAuditTab.tsx`** — new admin
  tabs (metrics, inspection, adjust, flag, moderation, dispute resolution;
  read-only audit explorer with filters and JSON detail expansion).
- **`lib/api.ts`** — `biomassApi` + `adminBiomassApi` typed clients,
  Decimal-as-string types, `randomRequestId()` auto-injected into order
  creations, CSV export helper.
- **`routes.ts` / `App.tsx` / `AppShell.tsx`** — `marketplace` route in
  the nav; inventory + marketplace wired; footer no longer claims demo
  data for the real pages.

## Commands executed and actual results (Task 006)

| Command | Result |
| --- | --- |
| `uv run alembic upgrade head` | migration `5c1f2a9d7b40` applied to the dev DB (tables + trigger created; no existing data touched) |
| `uv run pytest -q` (backend) | **74 passed** — 47 previous + 18 biomass user scenarios (ownership 404, 422s, movement reconcile incl. chain before/after, over-listing 409, concurrent oversell race, cancel-releases-once, full lifecycle + settlement record, idempotent replay, expiry release, dispute freeze, fulfilled-cannot-be-rewritten, non-admin 403) + 9 admin scenarios (overview from live data, inspection, reason-mandatory audited adjust, flag/archive, moderation, lot detail, audit GET-only via OpenAPI, engine-level UPDATE/DELETE trigger rejection) |
| Frontend `npm run test` | **83 passed** — 5 inventory, 4 marketplace, 5 admin-biomass scenarios (stubbed fetch; movement reconciliation, 404 non-owner, mandatory-reason disable, audit no-write) |
| `npx tsc -b` / `npm run build` | exit 0 / OK |

Honesty record from this task:

- The service-layer work surfaced and fixed real bugs via the new tests
  (`dispute_order` UnboundLocalError, a missing alias used by admin
  routes, an admin-router import) — found by tests before any live use.
- Draft listings DO consume offer room (conservative design: offered
  quantity can never exceed stock even at publish time); the test asserts
  this explicitly.
- No payment provider exists: settlement is a manual, clearly-labelled
  record that payment moved off-platform. Nothing claims money was
  captured.
- Permit references are stored as `unverified` and never claimed verified
  (no zone/farm/parcel models exist to validate them against).
- Pre-existing unresolved: nested `backend/.git` repo — never
  `git add .` at the root. No commits were made (per task rules).

## What was implemented (Task 005 — admin panel)

### Backend (`backend/src/backend/`)

- **`api/admin.py`** — the first authorization layer. `require_admin`
  dependency: authentication (401) → verification gate (403
  `email_verification_required`) → role gate (403
  `{"code":"admin_required"}`). Roles are RE-read from the DB per request,
  so a promotion/demotion applies to already-issued sessions on their next
  request. Six endpoints under `/api/v1/admin`:
  `GET /overview` (stats + live-session count + 5 recent registrations),
  `GET /users` (search/page/page_size, ILIKE over email/full_name),
  `GET /users/{id}` (detail + latest 50 session rows, METADATA only — no
  token hashes), `PATCH /users/{id}` (is_active / is_email_verified;
  un-verify and deactivate also revoke all live sessions of the target),
  `POST /users/{id}/sessions/revoke` (`{}` = all / `{"session_id": …}` =
  one; returns `{"revoked": n}`), `POST /users/{id}/role` (`"user" |
  "admin"`). Self-protection (400s): no self-deactivate, no self-un-verify,
  no self-demote. Mutations run the shared Origin-allow-list 403 check and
  the rate limiter (scope `admin`). 404 targets use one generic
  `User not found.` body.
- **`api/codes.py`** — `ADMIN_REQUIRED_CODE` / `ADMIN_REQUIRED_MESSAGE`.
- **`main.py`** — admin router included; CORS `allow_methods` now
  `["GET","POST","PATCH"]`.
- **No migration needed** (`users.role` exists since Task 002). NO schema
  changes, no destructive DB operations in this task. The only admin
  bootstrap is server-side SQL (docs/DATABASE.md) — no endpoint can create
  an admin; client `role` fields stay ignored everywhere.

### Frontend (`frontend/src/`)

- **`pages/AdminPage.tsx`** — Overview tab (stat cards: users / verified /
  active / admins / live sessions + recent registrations) and Users tab
  (search + paginated table with state/role badges and actions:
  Deactivate-Activate, Force-verify-Un-verify, Revoke-all-sessions,
  Promote-Demote; per-user expandable session list with single-session
  revoke). Own row is disabled with explanatory titles (self-protection is
  server-enforced anyway). Clear states: loading, no-access (403
  `admin_required`), error, empty filter.
- **`lib/api.ts`** — `adminApi` (five calls), `AdminUserSummary /
  AdminUserDetail / AdminUserList / AdminOverview / AdminSessionRow`
  types, `ADMIN_REQUIRED_CODE`, `PATCH` method added to the request helper.
- **`routes.ts` / `App.tsx`** — `#/admin` route (protected, prototype).
- **`components/AppShell.tsx`** — header "Admin" badge visible only when
  `user.role === "admin"`. The Admin panel deliberately has NO navigation
  entry: it is reachable only by entering its URL `#/admin` directly
  (client-side hiding is a UX choice; the server is the real gate).

## Commands executed and actual results (Task 005)

| Command | Result |
| --- | --- |
| `uv run pytest` (backend) | **47 passed** (13 admin scenarios on top of the 33 Task-002/003 tests; includes per-request role flips, DB-verified session revocation on un-verify, forged-session verification-gate precedence, self-protection 400s, CSRF 403, no-leak 404s, OpenAPI paths) |
| Frontend `npm run test` | **69 passed** (69) — 4 new admin UI scenarios (nav gating, 403 no-access card, stats load, PATCH-driven deactivate with confirm + body `{is_active:false}`) |
| `npx tsc -b` / `npm run build` | exit 0 / OK (260.82 kB, gzip 80.21 kB) |
| Bootstrap SQL dev DB | `UPDATE users SET role='admin' WHERE email='shrijeet733@gmail.com'` → role admin (documented path; that account is also verified, so it can sign in) |
| Live smoke `curl` | anonymous `GET /api/v1/admin/overview` → **401** `Not authenticated.`; `/admin/users` → 401; `/openapi.json` contains all five admin paths; `/api/v1/health` → ok |

Honesty record from this task:

- The frontend test for the deactivate action first failed because BOTH
  seeded rows rebuilt from the same `USER` fixture shared one id — the
  self-protection rule (correctly) disabled the admin's own button; fixed
  by giving the target its own id. The stub matcher now matches
  query-string-less URLs (`/admin/users?page=1`).
- Roles were renames-and-left: sessions are checked per request (test
  proves a pre-promotion session turns admin on its next request).
- Playwright/browser click-through was NOT executed; evidence is jsdom
  tests + curl against the live server.
- Pre-existing unresolved: nested `backend/.git` repo (zero commits) —
  never `git add .` at the root. No commits were made (per task rules).

## Account states (factual — see docs/DATABASE.md for the table)

- `shrijeet733@gmail.com` — **verified + admin**; the user can sign in and
  will see the Admin tab and badge immediately.

## What was implemented (Task 003 — email verification)

### Backend (`backend/src/backend/`)

- **Migration** `alembic/versions/3dd348b84f8a_email_verification_columns_and_tokens.py`
  — `users.is_email_verified` (bool, server default `false`),
  `users.email_verified_at` (nullable timestamptz), table
  `auth_email_verification_tokens` (id, unique 64-hex `token_hash`, user FK
  CASCADE, `expires_at`, `consumed_at`, `created_at`). Non-destructive; the
  migration deliberately does NOT verify existing users (test V14
  proves no auto-verification). Applied to the dev DB.
- **`verification.py`** — `VerificationService`: issue (supersedes the user's
  prior unconsumed tokens first), consume (ONE conditional
  `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING
  user_id` + user verify, single transaction → true single-use under
  concurrency), `purge_stale` housekeeping on register/resend. Tokens are
  256-bit `token_urlsafe`; only SHA-256(token) is stored (same pattern as
  auth sessions).
- **`mailer.py`** — `EmailSender` interface + three backends selected by
  `MAIL_BACKEND`: `console` (dev: unwrapped-line `.eml` files in
  gitignored `backend/.mail_outbox/` — links stay copyable out of the file),
  `smtp` (stdlib smtplib, STARTTLS enforced when `MAIL_USE_TLS=1`),
  `resend` (Resend HTTP API via httpx; provider errors surfaced as
  `EmailDeliveryError`, never as success). `CapturingEmailSender` test double.
  Verification links are built ONLY from `APP_BASE_URL` (never the request
  Host). Log lines never contain tokens or full URLs — recipient/subject and
  provider reasons only.
- **`api/auth.py`** — register now creates the account unverified, issues a
  token, sends the email via the configured backend (purging stale rows) and
  returns **`RegisterResponse`** (`UserPublic` + `verification_required: true`
  + honest `email_delivery: "accepted" | "failed"`); login 403 gate
  `{"detail": {"message", "code": "email_verification_required"}}` **before
  any session is created**; `POST /verify-email` (one generic 400 for
  unknown/expired/used); `POST /resend-verification` (ALWAYS neutral 202,
  non-enumerating; failures visible server-side only). Rate limits applied to
  verify/resend too (`rate_limit.py` scopes).
- **`api/dependencies.py`** — `get_current_user` rejects sessions of
  unverified accounts with the same structured 403 (covers pre-existing
  sessions too).
- **`api/codes.py`** — shared 403 code constant (import-cycle-free).
- **`main.py`** — `logging.basicConfig(INFO)` in `create_app()` so delivery
  acceptances are visible under plain uvicorn (`MAIL[resend] … accepted`).
- **Config** (`config.py`): `APP_BASE_URL`, `VERIFICATION_TOKEN_MINUTES`,
  `MAIL_BACKEND`, `MAIL_HOST/PORT/USERNAME/PASSWORD/USE_TLS`,
  `MAIL_FROM_ADDRESS`, `RESEND_API_KEY`, `MAIL_OUTBOX_DIR`. Real values in
  gitignored `backend/.env`; `backend/.env.example` has placeholders;
  `.mail_outbox/` gitignored.

### Frontend (`frontend/src/`)

- **`lib/api.ts`** — `ApiRequestError` now carries the structured `code`
  extracted from `{detail:{message,code}}`; `RegisterResult` type;
  `authApi.verifyEmail` / `authApi.resendVerification`;
  `VERIFICATION_REQUIRED_CODE`.
- **`auth/pendingEmail.ts`** — sessionStorage-only pending state
  (email + honest delivery status of the last register attempt). NEVER
  stores tokens.
- **`pages/VerificationPendingPage.tsx`** — pending screen after register and
  after the login 403; shows the honest delivery note when registration
  failed to hand off the email; resend with pending state and the neutral
  server confirmation for every outcome.
- **`pages/VerifyEmailPage.tsx`** — reads `#/verify-email?token=…`, strips
  the token from the URL via `history.replaceState` immediately, calls the
  API; success / generic-rejected states with paths to resend/login.
- **`pages/LoginPage.tsx`** — on `code === "email_verification_required"`
  routes to the pending screen instead of showing an error.
- **`pages/RegisterPage.tsx`** — success routes to the pending screen
  (honest delivery status); "not implemented anymore" messaging removed.
- **`routes.ts` / `App.tsx`** — query-aware hash parsing + two new public
  routes.

## Commands executed and actual results

| Command | Result |
| --- | --- |
| `uv add httpx` | OK (Resend client; httpx already present transitively) |
| `uv run alembic revision --autogenerate` + `upgrade head` | migration `3dd348b84f8a` applied to dev DB |
| `uv run pytest` | **33 passed** (19 Task-002 regression + 14 verification scenarios V1–V14, incl. a REAL concurrent double-consume race on PostgreSQL row locks) |
| Frontend `npm run test` / `npx tsc -b` / `npm run build` | **64 passed** / exit 0 / 249.94 kB gzip 77.40 kB |
| Live console-backend E2E (curl + real `.eml` outbox) | register 201 `accepted` → outbox `.eml` → login 403 `email_verification_required` (no cookie) → verify 200 → reuse 400 → login 200 + `is_email_verified:true` → me 200 → resend 202 neutral for verified AND unknown (identical bodies) |
| Live Resend probe: `example.com` recipient | provider HTTP 422 → respond honestly `email_delivery:"failed"` (documented provider restriction) |
| Live Resend probe: `shrijeet777@proton.me` | provider HTTP 403 "only send testing emails to your own email address (shrijeet733@gmail.com)" → honest failure; nonce-verified accounts re-verified via the documented admin SQL |
| Live real delivery: `shrijeet733@gmail.com` (Resend account owner) | **`MAIL[resend] verification email accepted`** (HTTP 200) — a REAL verification email sits in that inbox with a live token; account intentionally left unverified for the user to click the link |

Honesty record from this task:

- A console-outbox bug was found and fixed during live E2E: MIME
  quoted-printable soft-wrapped long URLs, so links copied from `.eml` were
  mangled (`=3D` artifacts). Real mail clients decode QP correctly, but dev
  tooling must not — the console backend now writes ≤998-char lines so the
  link is copyable from the file.
- `logging.basicConfig(INFO)` was added because uvicorn's default root level
  (WARNING) silently hid successful-delivery log lines — delivery must be
  observable.
- Two earlier test-iteration failures (over-broad DB assertion, newest-token
  capture) were fixed by scoping assertions per-user and capturing the most
  recent email for resend scenarios.
- Pre-existing unresolved: nested `backend/.git` repo (zero commits) — never
  `git add .` at the root. No commits were made (per task rules).

## Task 003 account states (historical)

- `shrijeet733@gmail.com` — was deliberately left unverified during Task
  003; the user clicked the live link on 2026-10-24 (see current account
  states above).
- `shrijeet777@proton.me`, `test.user@example.com`, `rl-test@example.com`,
  `e2e-…@example.com` — admin-verified via the documented SQL (the provider
  cannot deliver to those inboxes in Resend test mode).
- `full-e2e2-…@example.com` — verified through the full console-outbox
  cycle during live E2E.

## Known limitations / unfinished

- Resend test mode restricts recipients to the account owner's mailbox
  (`shrijeet733@gmail.com`) until a domain is verified at
  resend.com/domains; then set `MAIL_FROM_ADDRESS` on that domain.
- The Resend API key now lives in chat history as well — **rotate it**
  (revoke + new key into `backend/.env`).
- Rate limiter process-local; password reset/email change not implemented;
  the Task 005 account-supervision actions still lack their own audit trail
  (biomass actions are audited — `biomass_audit_events`; see
  docs/SECURITY.md).
- Production hardening (TLS/proxy, `COOKIE_SECURE=1`) outstanding.

## Manual verification steps (dev servers running)

1. Backend: `uv run uvicorn backend.main:app` in `backend/` (env from
   `backend/.env`, currently `MAIL_BACKEND=resend`). Frontend: `npm run dev`.
2. Register at `http://localhost:5173/#/register` → you land on the
   verification-pending screen.
3. If you register `shrijeet733@gmail.com` … (already exists; use Resend
   owner mailbox only through resend) — for any other address Resend will
   reject and the UI shows the honest "could not be sent" note + resend.
4. Open the latest email in that inbox, click the verification link →
   "Your email address is verified" → sign in normally.
5. Signing in with an unverified account routes to the pending screen (403
   gate); after verification sign-in works and the dashboard shows the
   profile.
6. **Admin check (Task 005)**: sign in as `shrijeet733@gmail.com` → the
   header shows an "Admin" badge (the panel intentionally has NO nav
   entry) → opening `http://localhost:5173/#/admin` directly shows the
   stat cards (Overview) and the Users tab lists all
   accounts with working actions. Any non-admin session that opens
   `#/admin` gets the explicit "does not have administrator access" note.
   Anonymous `curl http://127.0.0.1:8000/api/v1/admin/overview` → 401.

## Review pass (2026-10-27)

Second-session verification of the biomass module: all suites re-run green
(74 pytest / 83 Vitest; `tsc -b` clean; production build OK; dev DB at
migration head 5c1f2a9d7b40 with no seeded rows; 40 biomass paths
live-registered in /openapi.json). One robustness fix was applied in
`backend/src/backend/services/biomass.py`
(`get_order_for_participant_or_404` no longer returns None/500 for an
admin-session request of a nonexistent order under the user router — it
404s like any other unknown id). No dependencies, endpoints, or schema
changes were introduced by this pass; `context.txt` §9.6 records it.

## Next task

The biomass inventory + marketplace (Phase 2 core) is now implemented and
tested. Natural follow-ups: admin audit log for account supervision,
password reset / email-change flows, PostGIS decision for spatial
features (extension absent from this cluster).
