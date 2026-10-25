# API Contract — Bioeconomy

Status: partial. The authentication (+ email verification) slice and the
admin supervision slice below are implemented and verified (2026-10-24,
Tasks: secure registration/auth, Task 003 email verification, Task 005
admin panel). Everything else in the platform (biomass listings, geospatial
datasets, telemetry, analytics) has no API yet. Do not assume undocumented
endpoints.

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
- A verification email is sent to the address (default expiry
  `VERIFICATION_TOKEN_MINUTES = 30`).
- 201 → `RegisterResponse`; `Set-Cookie` is NOT issued (no auto sign-in).
  `email_delivery` is honest: `"accepted"` when the configured provider took
  the message, `"failed"` when it did not (the account still exists and is
  recoverable through resend).
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
{ "message": "If this address has an account awaiting verification, a new verification email has been sent." }
```

- The response is deliberately non-enumerating: account existence, verified
  state, and delivery outcome are indistinguishable from the outside.
  Delivery problems are observable server-side only (logs). A new token
  supersedes the account's previous unconsumed tokens.
- 422 → invalid email shape; 429 → rate limit; 403 → disallowed Origin.

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

## Not yet defined

Biomass listing CRUD, query/sort contracts for dashboards, dataset
provenance endpoints, IoT ingestion, analytics. When this writer documents a
planned-but-unbuilt contract, it must be clearly marked as a draft until the
implementation and its tests exist.
