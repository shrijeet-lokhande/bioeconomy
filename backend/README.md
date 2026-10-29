# Bioeconomy Backend

FastAPI service for the Bioeconomy platform. Current scope: user
registration, login, logout, email verification, and session-based
current-user profile; the role-gated admin supervision API (`/api/v1/admin/*`, Task 005); and the biomass inventory + marketplace
feature (`/api/v1/biomass/*` + `/api/v1/admin/biomass/*`, Task 006) —
backed by PostgreSQL with Alembic migrations.

## Stack

- Python >= 3.14, package manager: uv (src layout, `backend` package at
  `backend/src/backend/`)
- FastAPI 0.162, SQLAlchemy 2.1 (sync), Alembic 1.20, psycopg 3 (PostgreSQL)
- Argon2id password hashing (`argon2-cffi`), email validation (`email-validator`)
- Test runner: pytest (isolated per-run test databases; see below)

## Setup

1. PostgreSQL must be available. Local development instance (Arch example):

   ```bash
   sudo pacman -S --needed postgresql
   sudo -u postgres initdb -D /var/lib/postgres/data
   sudo systemctl enable --now postgresql.service
   # Pick your own local dev credentials — the values below are placeholders.
   sudo -u postgres psql -c "CREATE USER bioeconomy_app WITH PASSWORD '<local-dev-password>' CREATEDB;"
   sudo -u postgres createdb -O bioeconomy_app bioeconomy
   ```

   Only the client tools are needed for consumers; this machine currently has
   no Docker, so containers are not part of this setup.

2. Copy environment variables (never commit real values):

   ```bash
   cp .env.example .env
   # edit .env — set DATABASE_URL to your real connection string
   ```

3. Apply migrations (creates `users`, `auth_sessions`, and — from
   revision `5c1f2a9d7b40` — the biomass inventory/marketplace tables;
   from `f1c49d83a2b0` — the `biomass_images` table; from `b4d7e91c2a55`
   — the `biomass_deletion_cleanups` tracking table; never start tables
   with `create_all()`):

   ```bash
   uv sync
   uv run alembic upgrade head
   ```

4. Run the API (entry app object is `backend/main.py:app`):

   ```bash
   uv run uvicorn backend.main:app --reload
   # http://127.0.0.1:8000/api/v1/health
   ```

## Environment variables (backend/.env or process env)

| Variable | Meaning |
| --- | --- |
| `DATABASE_URL` | SQLAlchemy URL, psycopg 3 dialect: `postgresql+psycopg://user:password@host:5432/bioeconomy` |
| `APP_ENV` | `development` (default), `test`, or `production`; production requires `COOKIE_SECURE=1`, HTTPS links, a non-console backend, and a non-test/non-placeholder sender |
| `CORS_ORIGINS` | JSON array of allowed browser origins, e.g. `["http://localhost:5173"]` |
| `COOKIE_SECURE` | `1` = session cookie sent only over HTTPS. **Must be 1 in production.** |
| `COOKIE_SAMESITE` | `lax` (default) or `strict` |
| `SESSION_LIFETIME_HOURS` | Absolute session lifetime (server-enforced), default 168 |
| `RATE_LIMIT_ENABLED` | `1`/`0` — process-local throttling of register/login/verify/resend |
| `RATE_LIMIT_PER_MINUTE` | Attempts per client IP per minute, default 5 |
| `APP_BASE_URL` | Trusted base URL used to build verification links (NEVER from the request Host header) |
| `VERIFICATION_TOKEN_MINUTES` | Verification token lifetime, default 30 |
| `VERIFICATION_EMAIL_LIMIT_PER_HOUR` | Maximum resend-verification attempts for one normalized address in one hour, default 3 |
| `MAIL_BACKEND` | `console` (dev outbox), `smtp` (generic SMTP), or `resend` (Resend HTTP API) |
| `MAIL_OUTBOX_DIR` | Where the console backend writes `.eml` files (default `.mail_outbox`, gitignored) |
| `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_USE_TLS` | Generic SMTP configuration (`MAIL_USE_TLS=1` enforces STARTTLS) |
| `MAIL_FROM_ADDRESS` | Sender address of verification emails |
| `RESEND_API_KEY` | Resend API key (secret; `.env` only). A failed/absent key is never treated as a successful send |
| `BIOMASS_IMAGE_UPLOAD_DIR` | Where uploaded record-image files are stored (default `.data/biomass_images`, gitignored; server-generated names; served only via the authorized image endpoint) |
| `BIOMASS_IMAGE_MAX_MB` | Per-image size cap in MB, default 5 (1–5 images per record is a fixed server rule) |

## API — authentication (`/api/v1/auth`)

### Forgot and reset password

`POST /forgot-password` accepts `{ "email": "..." }` and always returns
the same neutral 202 response. Eligible (active, email-verified) accounts
receive a reset link using the trusted `APP_BASE_URL`. Tokens are random
256-bit values; only SHA-256 hashes are stored, they expire after
`PASSWORD_RESET_TOKEN_MINUTES` (30 by default), and each token works once.
`POST /reset-password` accepts `{ "token": "...", "password": "..." }`.
On success, all outstanding reset tokens and database sessions for that
account are revoked; the user must sign in again. Passwords retain the
existing 10–200 character policy and Argon2id hashing. Reset pages strip
the token from the address bar and the app sets a no-referrer policy.

For local testing, `MAIL_BACKEND=console` writes messages to the ignored
`.mail_outbox/`; open the newest message and follow the link. For real Resend
delivery, configure `MAIL_BACKEND=resend`, `RESEND_API_KEY`, and
`MAIL_FROM_ADDRESS` on a domain you own and Resend marks verified. Resend's
`onboarding@resend.dev` shared sender is for testing; it is not a production
sender for arbitrary users. The app fails startup in `APP_ENV=production` if
`COOKIE_SECURE=0`, the sender is shared/placeholder, the backend is console,
or `APP_BASE_URL` is not HTTPS. A configured sender address is not proof that
its domain is verified. In development, the shared sender remains available
for test-mode use but startup prints a warning that it cannot serve ordinary
user verification.

### Resend domain and delivery setup

1. In the Resend dashboard, open **Domains**, add a domain or (recommended)
   a transactional subdomain you control, and copy the DNS records Resend
   displays exactly. Add the displayed DKIM and SPF records, plus any return-
   path records shown for the chosen configuration, at the domain's DNS host.
   Record names and values are generated for that domain; never copy sample
   values from this README or create a duplicate SPF record at the same host.
2. Click **Verify** in Resend and wait until sending capability is marked
   verified. Resend requires an owned verified domain for ordinary sender
   addresses. DMARC is strongly recommended for authentication/alignment; start
   with a monitoring policy such as `p=none` while reviewing reports, then
   tighten it only after every legitimate sender is accounted for. DMARC is a
   separate DNS TXT record at `_dmarc.<domain>` and does not replace SPF/DKIM.
3. Set `MAIL_FROM_ADDRESS=verify@<verified-domain>` and `APP_ENV=production`.
   Use a send-only API key permitted to send from that verified domain. Keep
   `RESEND_API_KEY` in `backend/.env` or a secret store, never in source or
   logs. Restart the backend after changing configuration.
4. Public responses and the registration UI distinguish Resend API acceptance
   from mailbox delivery. The server logs the correlation ID and Resend email
   ID, if returned; they contain no recipient address, token, or provider error
   body. Timeouts are recorded as an unknown acceptance state and are not
   retried automatically. Use the correlation ID to find the matching message
   in Resend's Emails dashboard.
5. In Resend, open **Emails** and inspect the individual event timeline. Check
   for `email.sent`, `email.delivered`, `email.bounced`,
   `email.delivery_delayed`, `email.complained`, `email.failed`, or
   `email.suppressed` as applicable. `email.sent`/an API email ID means the
   provider accepted it, not that the mailbox received it. A Delivered event
   confirms acceptance by the recipient mail server, not inbox placement; also
   check spam/quarantine and the recipient provider's logs when needed.
6. Automated tests mock Resend. For a live domain setup, register one
   consenting test mailbox, confirm an `email.delivered` event, open the link,
   and verify that reusing the token fails. Resend's `delivered@resend.dev`
   is a test recipient useful for request-path checks only; it does not prove
   delivery to arbitrary inboxes.

The configured key on this development machine is send-only: read-only API
requests for domains, email history, and usage returned HTTP 401, so no
account-level domain state, recipient events, or quota could be inspected
programmatically. Use the Resend dashboard for those checks. Resend's current
public pricing lists a free quota, but plan and account-level limits can
change; check [current pricing](https://resend.com/pricing) and usage in the
account rather than treating an email ID as proof of a quota or delivery.
At this documentation update (2026-10-30), the public free plan lists 3,000
emails per month, a 100-per-day limit, and three domains; the actual account's
usage remains unverified because the configured key cannot read `/usage`.

Authentication rate limits are process-local, so use a shared limiter and
proxy-aware IP handling for multi-worker production. Verification resends are
also limited to three attempts per normalized email identifier per hour using
a SHA-256 identifier key; the address itself is not retained in limiter keys.

| Method | Path | Auth | Success | Error statuses |
| --- | --- | --- | --- | --- |
| POST | `/register` | none | 201 `RegisterResponse` | 409 duplicate email, 422 validation, 429 rate limit, 403 disallowed Origin |
| POST | `/login` | none | 200 `UserPublic` + `Set-Cookie: bio_session` | 401 `Invalid email or password.` (generic), 403 `email_verification_required` (no session created) / inactive account / disallowed Origin, 429 |
| POST | `/logout` | optional cookie | 204, cookie cleared + session revoked | 403 disallowed Origin |
| GET | `/me` | cookie (verified session) | 200 `UserPublic` | 401 not authenticated / expired, 403 `email_verification_required` |
| POST | `/verify-email` | none | 200 verified | 400 one generic rejection for invalid/expired/used tokens, 429 |
| POST | `/resend-verification` | none | 202 always-identical neutral message | 422 validation, 429 |

`RegisterResponse` = `UserPublic` fields + `verification_required: true` +
`email_delivery: "accepted" | "failed" | "unknown"` — provider API status,
not mailbox delivery status. A timeout is reported as unknown acceptance.
`UserPublic` = `{ id, full_name, email, role, is_active, is_email_verified,
created_at, updated_at }`. Password hashes, session tokens, and
verification tokens never appear in any response. Role and verification
status are server-controlled; client fields of those names are ignored.

Sessions: random 256-bit token in a `HttpOnly` cookie; only SHA-256(token)
plus expiry/revocation is stored in `auth_sessions`. Verification: only
SHA-256(token) in `auth_email_verification_tokens`; single-use (atomic
consumption), 30-minute default expiry, resend supersedes older tokens.
CSRF: `SameSite=Lax` plus an Origin-allowlist check on unsafe methods.

## API — admin (`/api/v1/admin`, Task 005)

First authorization layer: every call is gated authentication (401) →
email verification (403 `email_verification_required`) → role (403
`{"code": "admin_required"}`), checked per request against the DB row of
the session owner. There is NO endpoint that creates an admin — the role
is granted ONLY by operator SQL (below).

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| GET | `/overview` | 200 stats: users/verified/active/admins/live sessions + 5 recent registrations | 401 / 403 `admin_required` |
| GET | `/users?search=&page=&page_size=` | 200 `{ total, page, page_size, items[] }` | 401/403, 422 bad params |
| GET | `/users/{user_id}` | 200 summary + latest 50 sessions (metadata only, never token hashes) | 401/403, 404 `User not found.` |
| PATCH | `/users/{user_id}` | 200 updated summary (body `{ is_active?, is_email_verified? }`; un-verify/deactivate also revokes all target sessions) | 401/403, 400 self-deactivate/self-un-verify, 404, 429 |
| POST | `/users/{user_id}/sessions/revoke` | 200 `{ "revoked": n }` (body `{}` = all live, or `{"session_id": …}` = one) | 401/403, 404, 429 |
| POST | `/users/{user_id}/role` | 200 updated summary (body `{"role": "user" \| "admin"}`) | 401/403, 400 self-demote, 404, 422, 429 |

Promotion takes effect on the target's NEXT request (roles are not frozen
into sessions).

## API — biomass inventory & marketplace (`/api/v1/biomass`, Task 006)

All endpoints require a verified session. Every state-changing request
validates ownership/status server-side; a non-owner detail read gets the
same 404 body as a missing entity. Quantities are Decimal, serialized as
JSON strings (never floats). Full status/error semantics:
docs/API_CONTRACT.md.

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| GET | `/biomass/inventory` | 200 `LotPage` (summary, search/status/unit/sort, paging) | 422 bad params |
| POST | `/biomass/inventory` | 201 lot with its 1–5 COMPULSORY images (`multipart/form-data`: `payload` = LotCreateRequest JSON + `images` files; mid-part format sniffed from magic bytes, ≤ `BIOMASS_IMAGE_MAX_MB` each → 413; validated before any write) (initial movement `initial` recorded) | 422 validation / >5 or 0 images, 413 oversize, 401/403 |
| GET | `/biomass/images/{image_id}` | 200 image bytes with the SNIFFED media type — lot images: owner/admin; listing images: seller/admin, any verified user while `active` | 404 otherwise (no oracle), 401 anonymous |
| GET | `/biomass/inventory/{lot_id}` | 200 `LotDetail {lot, movements}` | 404 (incl. non-owner) |
| PATCH | `/biomass/inventory/{lot_id}` | 200 metadata-only edit | 422 if body contains `quantity` (record an adjustment instead), 404 |
| POST | `/biomass/inventory/{lot_id}/adjust` | 200 adjustment; appends one movement | 409 over-removal/no-op, 422 reason missing/empty, 404 |
| POST | `/biomass/inventory/{lot_id}/archive` / `/restore` | 200 | 409 open listings / wrong state, 404 |
| POST | `/biomass/inventory/{lot_id}/transfer` | 201 `{source_lot, transferred_lot}` (recipient gets a new lot + `transfer_in` journal) | 400 unknown/inactive/self recipient, 409 insufficient quantity, 404 |
| GET | `/biomass/inventory/export.csv` | 200 `text/csv` (caller's own rows) | |
| GET | `/biomass/marketplace/listings` | 200 active public cards (sweeps stale reservations first) | |
| GET | `/biomass/marketplace/listings/{id}` | 200 `ListingCard` | 404 |
| POST | `/biomass/marketplace/listings` | 201 `ListingOwn` with its 1–5 COMPULSORY images (`multipart/form-data`: `payload` + `images`, same rules as lot creation; image validation runs before the lot lookup) (offered quantity must fit the lot with its other live listings including drafts) | 409 offered > available room, 422 validation / image count or format, 413 oversize, 404 unknown/non-owned lot |
| GET | `/biomass/marketplace/my/listings` | 200 seller management view | |
| PATCH | `/biomass/marketplace/listings/{id}` | 200 seller edit (ownership enforced) | 403/404, 409, 422 |
| POST | `/biomass/marketplace/listings/{id}/publish` / `/pause` / `/resume` / `/withdraw` | 200 | 403/404, 409 wrong state |
| POST | `/biomass/marketplace/listings/{id}/orders` | 201 order `requested` + atomic reservation; same `client_request_id` replay → 200 same order | 409 insufficient/self-purchase, 422 |
| GET | `/biomass/marketplace/orders?role=&status_filter=` (+ `{id}`) | 200 (buyer/seller visibility only) | 404 (incl. not-your-order) |
| POST | `/biomass/marketplace/orders/{id}/cancel` | buyer cancels `requested`; releases reservation exactly once | 403/404, 409 |
| POST | `/biomass/marketplace/orders/{id}/accept` / `/reject` | seller decides; reject releases | 403/404, 409 |
| POST | `/biomass/marketplace/orders/{id}/fulfil` | reserved → sold | 403/404, 409 |
| POST | `/biomass/marketplace/orders/{id}/confirm` | buyer accepts delivery → `completed` (terminal) | 403/404, 409 |
| POST | `/biomass/marketplace/orders/{id}/dispute` | buyer freezes (reason required) | 403/404, 409 |
| POST | `/biomass/marketplace/orders/{id}/settlement` | seller records the MANUAL off-platform settlement note (no payment provider; never presented as money captured) | 403 (buyer), 404, 409 |

`requested` orders unaccepted for 72 hours are released lazily (status
`cancelled`, `released_at` set, one `release` movement).

## API — admin biomass + audit (`/api/v1/admin/biomass`, Task 006)

Behind the same `require_admin` gates as Task 005; every state change
appends an audited `biomass_audit_events` row (append-only at the DB
level via the `biomass_audit_append_only` trigger — UPDATE and DELETE are
rejected by the engine itself).

| Method | Path | Success | Errors |
| --- | --- | --- | --- |
| GET | `/admin/biomass/overview` | 200 live metrics (lots/listings/orders by status, disputed, adjustments, newest 10 audit rows) | 401/403 |
| GET | `/admin/biomass/inventory` (+ `{id}`, `/{id}/detail`) | 200 global inspection incl. owner identity; `flagged` filter; detail adds movements/listings/orders | 404 |
| POST | `/admin/biomass/inventory/{lot_id}/adjust` | 200 `admin_correction` movement (reason mandatory, audited) | 404, 422 |
| POST | `/admin/biomass/inventory/{lot_id}/archive` / `/restore` / `/flag` | 200 (flag stores a recorded note) | 404, 409 |
| GET | `/admin/biomass/listings` | 200 all listings | |
| POST | `/admin/biomass/listings/{id}/reject` (reason) / `/suspend` / `/reinstate` | 200; suspend is 409 with `code: "active_requests_exist"` while orders are open (or `force: true` cancels+releases them); reinstate → `paused` | 404, 409 |
| GET | `/admin/biomass/orders` (+ `{id}`) | 200 status filter + reference search | 404 |
| POST | `/admin/biomass/orders/{id}/resolve-dispute` `{action: resume\|cancel, note}` | 200 dispute resolved; **cancel on a fulfilled order is refused 409** (stock has moved; resume only) | 404, 409 |
| GET | `/admin/biomass/audit` | 200 read-only audit explorer (action/entity_type/entity_id/search, paging) — there is deliberately NO write endpoint for audit rows | 401/403 |

Granting admin (operator-only bootstrap)

```sql
UPDATE users SET role = 'admin' WHERE email = '<address>';
```

## Email verification — local testing & production

- **Local dev (no mail server)**: `MAIL_BACKEND=console` → every
  verification email is a clearly labeled `.eml` in `backend/.mail_outbox/`
  (gitignored). Open the LATEST file — links are written unwrapped, so the
  URL is copyable — and follow it. Full local cycle: register → latest
  `.eml` → click link → sign in.
- **Resend** (current local configuration): `MAIL_BACKEND=resend` with
  `MAIL_FROM_ADDRESS=onboarding@resend.dev`. This is the shared testing
  sender and is not suitable for arbitrary users. Earlier live API responses
  rejected another recipient; the current send-only key cannot read account
  domains or delivery events. To send to users, verify a domain you own and
  use a sender address on it; the production config guard rejects the shared
  test sender.
- **Generic SMTP**: `MAIL_BACKEND=smtp` + the `MAIL_*` variables above.
- Server logs record the email purpose, opaque correlation ID, user UUID,
  provider, provider email ID (when returned), and safe failure category/status
  code. They do not record recipient addresses, tokens, credentials, provider
  response bodies, or raw exception messages. Acceptance is not a delivery
  confirmation; inspect the message's event timeline in Resend.

### Administrative verification of pre-existing accounts (explicit)

Migration deliberately leaves existing users UNVERIFIED. The approved
admin action (manual, operator-gated; NOT exposed via API):

```sql
UPDATE users SET is_email_verified = TRUE, email_verified_at = now()
WHERE email = '<address>';
```

## Tests

`uv run pytest` creates a fresh database `bioeconomy_test_<hex>` on the
instance from `DATABASE_URL` (requires the role to have `CREATEDB`), applies
the real Alembic migration chain, runs the suite, and drops the database.
The dev database is never touched by tests. The suite covers registration,
hash storage, login, wrong password, duplicates, invalid input, `/me` with
and without a session, logout revocation, expiry, role-escalation attempts,
email verification (14 scenarios incl. a real double-consume race), and the
admin panel (13 scenarios: gates, per-request role flips, pagination/search,
deactivate + live revocation, self-protection, CSRF, no-leak 404s, OpenAPI
paths) plus the biomass inventory & marketplace API (18 scenarios:
ownership 404, server-side validation, movement-journal reconciliation
including the before/after chain, listing-over-stock 409, a real
concurrent oversell race, exactly-once reservation release, full order
lifecycle with the settlement record, idempotent purchase replay, 72h
expiry release, dispute freeze, completed-not-rewritable, non-admin 403)
and the admin biomass console + audit (9 scenarios: overview from live
data, owner-visible inspection, reason-mandatory audited adjustment,
flag/archive/restore, listing moderation, lot detail, audit endpoint
GET-only, engine-level UPDATE/DELETE rejection by the append-only
trigger) — 74 tests total.

## Known limitations (implemented vs. deferred)

- Email verification was completed in Task 003 (server gate + tokens +
  mailer backends); pre-existing unverified accounts stay locked out until
  they verify or the operator runs the documented SQL.
- Admin account-supervision actions have no audit trail of their own yet;
  the biomass domain is audited in `biomass_audit_events` (append-only at
  the DB level) — extending that pattern to Task 005 endpoints is the
  natural follow-up.
- No payment provider: order settlement is a manual, clearly-labelled
  record only; permit references are stored as `unverified` and are never
  claimed verified (no farm/zone/parcel models exist to validate against).
- Geospatial (PostGIS) features: deferred — the extension is absent from
  this PostgreSQL instance; biomass lots carry only free-text storage
  locations, no coordinates.
- Email change: not implemented.
- Rate limiting: per-process memory only — not shared across workers/instances;
  replace with a shared store (Redis) before multi-instance production.
- Deployment hardening (TLS termination, proxy-aware client IPs, structured
  logging without sensitive data, audit trail) remains future work.
