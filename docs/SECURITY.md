# Security Notes — Bioeconomy

This file records the actual security state of the implemented system. It is
not aspirational: items marked "deferred" are not implemented.

## Implemented and verified (2026-10-24)

- **Password storage**: Argon2id (`argon2-cffi`, OWASP default parameters:
  t=3, m=64 MiB, p=4, unique per-hash salt). No plaintext or reversible
  password data exists anywhere; automated test asserts the PHC format in
  the database row.
- **Server-side validation**: every registration/login field is validated on
  the server (Pydantic), independent of frontend checks. Max lengths enforced
  (name 200, email 320, password 200; password minimum 10 — a length-only
  NIST-SP-800-63B-aligned policy; composition rules were deliberately not
  added).
- **Email uniqueness**: database-level `UNIQUE` constraint on normalized
  lowercase email; the API catches uniqueness races and returns a generic
  409.
- **Sessions**: cryptographically random 256-bit tokens; the DB stores only
  SHA-256(token), so a database leak exposes no usable sessions. `auth_sessions`
  rows carry absolute expiry (default 7 days) and revocation timestamps;
  lookup rejects expired/revoked rows and sessions of deactivated users.
- **Cookie**: `bio_session` is `HttpOnly`, `SameSite=Lax`, `Path=/`;
  `Secure` is controlled by `COOKIE_SECURE` (must be enabled in production).
  Tokens are never stored in localStorage or read by the frontend.
- **CSRF**: SameSite=Lax cookie + Origin allow-list check on unsafe methods
  (register/login/logout); mismatched Origins get 403. Missing Origin (non-
  browser clients) is permitted — documented consequence: a client that can't
  send cookies cross-site isn't a CSRF vector.
- **Credential hardening**: login failures return one non-revealing message
  for unknown email and wrong password; the unknown-email branch verifies a
  dummy Argon2id hash for timing equivalence. Logout revocation is replay-
  safe (tested by re-sending the revoked cookie).
- **No privilege escalation**: role/is_active are server constants; client
  fields of those names are ignored (tested).
- **Uniqueness/abuse**: process-local rate limiting (default 5/min per IP)
  on register, login, verify-email, and resend-verification.
- **Secrets**: all credentials come from environment variables
  (`backend/.env`, gitignored). `.env.example` contains placeholders only.

## Email verification (Task 003 — implemented and verified 2026-10-24)

- **Verified-email gate (server-side)**: registration sets
  `is_email_verified = false`. Login of an unverified account returns 403
  with the structured code `email_verification_required` and creates NO
  session; the same 403 guards every authenticated endpoint, including
  sessions issued before this feature existed. Only token consumption (or
  the documented manual admin SQL) flips the flag — there is no client path.
- **Token storage**: verification tokens are 256-bit `secrets.token_urlsafe`
  values. The database stores only SHA-256(token) (64-hex, unique) in
  `auth_email_verification_tokens`; the raw token exists solely inside the
  emailed link. A database leak exposes no usable verification tokens.
- **Single use, atomic**: consumption is one conditional
  `UPDATE … WHERE consumed_at IS NULL AND expires_at > now() RETURNING
  user_id` plus the user's verify-update, committed in one transaction —
  concurrent requests cannot consume one token twice (row-lock semantics
  verified by a real concurrent test against PostgreSQL).
- **Expiry**: tokens expire (default 30 minutes,
  `VERIFICATION_TOKEN_MINUTES`). Expired/unknown/used tokens return one
  identical generic 400 body — no oracle for token state.
- **Supersede**: issuing a new token (register or resend) marks the user's
  prior unconsumed tokens consumed first, so stale links never work. Stale
  rows are purged opportunistically.
- **Trusted link construction**: verification URLs are built only from
  `APP_BASE_URL` (server config), never from the untrusted request Host
  header — no link-injection through `Host`.
- **No tokens in logs or storage**: neither backend nor frontend ever logs a
  raw token or writes it to storage/sessionStorage. The frontend strips the
  token from the URL (`history.replaceState`) as soon as it is read, so it
  does not linger in the address bar or browser history.
- **Provider failures are never claimed as success**: the register response
  reports honest `email_delivery: "accepted" | "failed"`; resend-verification
  is neutral (202) by design and does not report delivery either way.
- **Mail provider reality (documented behavior of the configured Resend
  account)**: without a verified domain, Resend delivers only to the account
  owner's own mailbox and rejects other recipients (HTTP 403/422). These
  rejections surface honestly as `email_delivery: "failed"` — they are
  provider-side restrictions, not silent drop. To deliver to arbitrary
  recipients, verify a domain at resend.com/domains and set
  `MAIL_FROM_ADDRESS` to an address on that domain.

## Admin authorization (Task 005 — implemented and verified 2026-10-24)

- **First real authorization layer**: `/api/v1/admin/*` is guarded by the
  `require_admin` dependency — a role check on the SESSION OWNER read from
  the database on every request, not frozen into the session/cookie.
  Flipping a role takes effect on the next request of any live session
  (verified by test: a pre-promotion session gains access; a post-demotion
  session loses it immediately).
- **Gate order**: authentication (401) → email verification (403 with
  `email_verification_required`) → role (403 with the structured code
  `admin_required`). A forged live session on an unverified promoted user
  hits the verification gate first — verified by test.
- **No endpoint can create an admin**: admin status originates exclusively
  from the documented operator SQL (`UPDATE users SET role='admin' …`).
  Registration ignores client `role` fields (asserted); the promotion
  endpoint requires an already-authenticated verified admin.
- **Self-protection, server-side (not just UI-disabled)**: the current admin
  gets 400 on attempts to deactivate their own account, un-verify their own
  account, or demote their own role — blocking the common last-admin
  lockout footguns.
- **Immediate effect of account actions**: force-verify/un-verify and
  deactivate atomically commit the flag AND revoke all live sessions of the
  target when the flag would exclude them (un-verify / deactivate), so
  stale sessions die in the same action (DB-verified in tests). Sessions of
  deactivated users are additionally rejected by resolution regardless.
- **No secret leakage in supervision data**: listing/detail payloads carry
  names, emails, flags, counts, and session METADATA (ids + timestamps)
  only; automated test asserts `token_hash`/`password_hash` never appear.
  Session token hashes are never exposed through the admin API.
- **CSRF/rate limits on mutations**: PATCH/POST admin actions run the same
  untrusted-Origin 403 check and the process-local rate limiter (scope
  `admin`), like the auth endpoints. CORS preflight now also allows PATCH.
- **Scope discipline**: supervision covers accounts and sessions only. The
  frontend admin panel shows platform stats and user administration; listing
  data remains the localStorage demo and is NOT supervised through this API
  (no fake admin views of non-existent entity endpoints).

## Known limitations and follow-up tasks

- Password reset, account recovery, email change flows: not implemented
  (email verification partially fills the "address is reachable" gap).
- Rate limiting is per-process (not shared across workers/instances) and not
  proxy-aware. Follow-up: Redis-backed shared limiter + real client IP from
  the trusted reverse proxy header.
- CSRF is Origin-allow-list based; a full double-submit-token scheme on top of
  SameSite=Lax can be added when deployment topology is known.
- No audit logging, no abuse monitoring, no lockout/containment procedures.
  The admin panel performs state changes without an audit trail — an
  `admin_audit_log` table plus recorded actor/action/target/commit is the
  natural next hardening step.
- TLS/proxy hardening (HSTS, strict headers) belongs to deployment, not the
  application yet — no claims of production readiness are made.
- PostGIS is not installed on this machine's PostgreSQL 18.6 instance (not
  available as an extension). No spatial features were added or claimed for
  auth.
- The verification email content is a plain, professional template with no
  click-tracking; deliverability (SPF/DKIM alignment) depends on the
  provider/domain setup once a real sending domain is verified.
