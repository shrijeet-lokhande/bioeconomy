# Current State

Last updated: 2026-10-24 — **Task 005 (admin panel)** on top of Task 003
(email verification) and Task 002 (authentication). All three slices are
implemented, tested, and live on this machine.

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
  the admin actions have no audit trail yet (see docs/SECURITY.md).
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

## Next task

Roadmap Phase 2 (biomass listing persistence) remains the next feature;
password reset / email-change flows are the natural auth follow-ups, and an
admin audit log is the natural admin follow-up.
