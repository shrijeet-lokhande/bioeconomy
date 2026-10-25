# Bioeconomy Backend

FastAPI service for the Bioeconomy platform. Current scope: user
registration, login, logout, email verification, and session-based
current-user profile, plus the role-gated admin supervision API (`/api/v1/admin/*`, Task 005) — backed by PostgreSQL with Alembic
migrations. The biomass/API-v1 feature set is not implemented yet.

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

3. Apply migrations (creates `users`, `auth_sessions`; never start tables
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
| `CORS_ORIGINS` | JSON array of allowed browser origins, e.g. `["http://localhost:5173"]` |
| `COOKIE_SECURE` | `1` = session cookie sent only over HTTPS. **Must be 1 in production.** |
| `COOKIE_SAMESITE` | `lax` (default) or `strict` |
| `SESSION_LIFETIME_HOURS` | Absolute session lifetime (server-enforced), default 168 |
| `RATE_LIMIT_ENABLED` | `1`/`0` — process-local throttling of register/login/verify/resend |
| `RATE_LIMIT_PER_MINUTE` | Attempts per client IP per minute, default 5 |
| `APP_BASE_URL` | Trusted base URL used to build verification links (NEVER from the request Host header) |
| `VERIFICATION_TOKEN_MINUTES` | Verification token lifetime, default 30 |
| `MAIL_BACKEND` | `console` (dev outbox), `smtp` (generic SMTP), or `resend` (Resend HTTP API) |
| `MAIL_OUTBOX_DIR` | Where the console backend writes `.eml` files (default `.mail_outbox`, gitignored) |
| `MAIL_HOST`, `MAIL_PORT`, `MAIL_USERNAME`, `MAIL_PASSWORD`, `MAIL_USE_TLS` | Generic SMTP configuration (`MAIL_USE_TLS=1` enforces STARTTLS) |
| `MAIL_FROM_ADDRESS` | Sender address of verification emails |
| `RESEND_API_KEY` | Resend API key (secret; `.env` only). A failed/absent key is never treated as a successful send |

## API — authentication (`/api/v1/auth`)

| Method | Path | Auth | Success | Error statuses |
| --- | --- | --- | --- | --- |
| POST | `/register` | none | 201 `RegisterResponse` | 409 duplicate email, 422 validation, 429 rate limit, 403 disallowed Origin |
| POST | `/login` | none | 200 `UserPublic` + `Set-Cookie: bio_session` | 401 `Invalid email or password.` (generic), 403 `email_verification_required` (no session created) / inactive account / disallowed Origin, 429 |
| POST | `/logout` | optional cookie | 204, cookie cleared + session revoked | 403 disallowed Origin |
| GET | `/me` | cookie (verified session) | 200 `UserPublic` | 401 not authenticated / expired, 403 `email_verification_required` |
| POST | `/verify-email` | none | 200 verified | 400 one generic rejection for invalid/expired/used tokens, 429 |
| POST | `/resend-verification` | none | 202 always-identical neutral message | 422 validation, 429 |

`RegisterResponse` = `UserPublic` fields + `verification_required: true` +
`email_delivery: "accepted" | "failed"` — honest delivery reporting.
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

### Granting admin (operator-only bootstrap)

```sql
UPDATE users SET role = 'admin' WHERE email = '<address>';
```

## Email verification — local testing & production

- **Local dev (no mail server)**: `MAIL_BACKEND=console` → every
  verification email is a clearly labeled `.eml` in `backend/.mail_outbox/`
  (gitignored). Open the LATEST file — links are written unwrapped, so the
  URL is copyable — and follow it. Full local cycle: register → latest
  `.eml` → click link → sign in.
- **Resend** (as configured on this machine): `MAIL_BACKEND=resend` +
  `RESEND_API_KEY`. Provider note: without a verified domain, Resend
  delivers ONLY to the account owner's own mailbox and rejects other
  recipients with HTTP 403 — surfaced honestly as
  `email_delivery: "failed"`, never claimed as sent. To reach arbitrary
  recipients: verify a domain at resend.com/domains and set
  `MAIL_FROM_ADDRESS` to an address on that domain.
- **Generic SMTP**: `MAIL_BACKEND=smtp` + the `MAIL_*` variables above.
- Acceptances are visible in the server log
  (`MAIL[resend] verification email accepted for …`); failures are logged
  with the provider reason.

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
paths) — 47 tests total.

## Known limitations (implemented vs. deferred)

- Email verification was completed in Task 003 (server gate + tokens +
  mailer backends); pre-existing unverified accounts stay locked out until
  they verify or the operator runs the documented SQL.
- Admin supervision has no audit trail yet; an admin audit log is the
  natural follow-up (see docs/SECURITY.md).
- Password reset: not implemented.
- Rate limiting: per-process memory only — not shared across workers/instances;
  replace with a shared store (Redis) before multi-instance production.
- Deployment hardening (TLS termination, proxy-aware client IPs, structured
  logging without sensitive data, audit trail) remains future work.
