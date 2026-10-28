# Security Notes — Bioeconomy

This file records the actual security state of the implemented system. It is
not aspirational: items marked "deferred" are not implemented.

## Implemented and verified (2026-10-24)

- **Password storage**: Argon2id (`argon2-cffi`, OWASP default parameters:
  t=3, m=64 MiB, p=4, unique per-hash salt). No plaintext or reversible
  password data exists anywhere; automated test asserts the PHC format in
  the database row.
- **Password recovery**: reset links contain 256-bit random tokens while
  `auth_password_reset_tokens` stores only SHA-256 hashes. Tokens expire after
  30 minutes by default, are single-use, and are revoked on reset. Password
  changes use the existing Argon2id policy and revoke every active database
  session in the same transaction. Public request responses are identical for
  existing and unknown addresses; reset pages strip the URL token and use a
  no-referrer policy. The current process-local rate limiter is suitable only
  for a single API process; multi-worker production needs a shared limiter.
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

## Biomass inventory & marketplace (Task 006 — implemented and verified 2026-10-26)

- **Ownership is enforced server-side on every state-changing operation**:
  lot edit/adjust/transfer/archive, listing publish/transition, and every
  order action re-validates status AND the authenticated actor's role in
  the transaction before touching data. Non-owner access to a detail
  endpoint is a plain **404 with the same body as a missing entity** —
  a non-owner gains no existence oracle (tested: another user's lot id
  reads exactly like a nonexistent one).
- **Quantity integrity under concurrency**: reservations and fulfilment
  run inside PostgreSQL transactions with `FOR UPDATE` row locks on the
  listing and the lot and revalidate quantities inside the transaction —
  two concurrent buyers cannot oversell one lot (real concurrent test).
  Quantities are `NUMERIC` end-to-end and serialized as JSON strings;
  nothing is ever written as a float. A quantity can never be silently
  overwritten: PATCHes containing `quantity` are rejected 422, and every
  balance change appends a `stock_movements` row (before/after recorded).
- **Idempotent purchase retries**: `client_request_id` is UNIQUE at the
  database level; replaying the same id returns the same order (200)
  instead of creating a second reservation.
- **Audit trail, enforced append-only**: admin actions (inventory
  adjust/flag/archive, listing reject/suspend/reinstate, dispute
  resolution) and sensitive user transitions append
  `biomass_audit_events` (actor, action, entity, optional reason/detail).
  A database trigger refuses UPDATE and DELETE at the engine level
  (tested by executing both statements directly). The admin audit
  endpoint is strictly read-only; there is no write path in the API.
- **Permit references are never claimed verified**: a lot's
  `permit_reference` is stored with `permit_status: "unverified"`; no
  endpoint, response, or UI text asserts the platform validated it.
- **Payment reality**: there is no payment provider. The seller's
  "mark settled" action only records a manual, clearly-labelled note that
  payment moved off-platform; the order status and the UI wording never
  imply that money was captured through the platform.
- **Public data minimization**: marketplace browse exposes the seller's
  display name only — no seller id/email on public shapes.
- **Same gate chain and mutation hardening**: every biomass endpoint runs
  the 401 → verification-gate order; every state-changing request runs
  the shared untrusted-Origin 403 check plus a dedicated `biomass`
  rate-limit scope; admin biomass mutations are additionally gated by
  `require_admin` (role re-read per request).

## Biomass record images (Task 007 — implemented and verified 2026-10-27)

- **Compulsory, size- and count-bounded uploads**: registering a lot or
  creating a listing REQUIRES 1–5 images (422 otherwise); each file must
  be ≤ `BIOMASS_IMAGE_MAX_MB` (5 MB default, HTTP 413 when over).
  Validation runs BEFORE any record is written — a rejected upload can
  never leave a half-registered record.
- **Client-supplied metadata is never trusted**: the actual media type
  comes from magic-byte sniffing (JPEG `FF D8 FF`, PNG `89 50 4E 47 0D 0A
  1A 0A`, WebP `RIFF…WEBP`) — the declared Content-Type and filename are
  ignored for typing; a text file renamed to `.png` is rejected on both
  client and server (tested), as is an extension that contradicts the
  real bytes.
- **Path-traversal-proof storage**: file bytes are written to a
  gitignored directory (`BIOMASS_IMAGE_UPLOAD_DIR`, default
  `backend/.data/biomass_images`) under a server-generated uuid-hex name
  (`stored_name`, UNIQUE) — a client-supplied name never touches the
  filesystem, so traversal/output-collision attacks have no surface.
  `original_name` is sanitized to a basename and used for display only.
- **Authorization-gated serving, no public files**: there are no static
  file mounts for uploads. Every image is served through
  `GET /api/v1/biomass/images/{image_id}` behind the verified-session
  gate, with object-level rules: lot images → owner or admin; listing
  images → seller or admin always, any verified user while the listing is
  `active`. All other viewers get a 404 indistinguishable from a missing
  image (no existence oracle, tested; anonymous requests stop at the 401
  gate). The response carries the SNIFFED content type, never a
  client-asserted one.
- **Immutability by construction**: the API has no image
  add/remove/reorder endpoint — a gallery is fixed at creation and rows
  survive only alongside their record (FK CASCADE).

## Admin permanent deletion (implemented and verified 2026-10-27)

- **Server-enforced, admin-only**: `DELETE /api/v1/admin/biomass/
  inventory/{id}` and `DELETE /api/v1/admin/biomass/listings/{id}` run
  behind `require_admin` (401 → 403 verification → 403 admin_required)
  AND re-check `actor.role == "admin"` inside the purge service. Non-
  admins and anonymous callers are tested and rejected; the frontend
  button is convenience, not the security boundary.
- **Explicit confirmation**: the request body must repeat the record's
  exact title (`confirm_title`; whitespace-trimmed). A mismatch is a 400
  and deletes nothing — a bare-ID request can never purge.
- **Transaction history is never destroyed**: any order reference (any
  status, including cancelled) refuses the purge with 409. Lots are
  purged with their exclusively-owned dependents only (image metadata,
  stock-movement journal, order-free listings).
- **Two-phase, honest deletion**: the DB purge commits atomically
  together with a `biomass_deletion_cleanups` tracking row listing the
  exact storage keys; image files are unlinked AFTER the commit via
  `safe_unlink` (strict server-generated-name regex, resolved-path
  containment in the upload dir, no symlinks/directories — path
  traversal and malicious keys are unit-tested). Missing files count as
  cleaned; refused keys leave the row `pending` and the API responds
  `status: "pending_cleanup"` — it never claims full deletion when file
  cleanup failed. Repeating the same DELETE finishes a pending cleanup;
  a fully deleted id answers 404. Duplicate/concurrent requests
  serialize on `SELECT … FOR UPDATE` (tested).
- **Audit retention (deliberate)**: every purge appends minimal events to
  the append-only `biomass_audit_events` (actor, timestamp, title, row
  counts; never image contents, no full PII). These rows are RETAINED —
  they are the security record of who destroyed what, and the DB trigger
  makes them unmodifiable. `admin.deletion.cleanup_completed` records
  the file phase when it finishes.
- **What is NOT claimed**: backups, snapshots, replicas, filesystem
  journals, or external storage version history are NOT purged by this
  feature (the local-disk implementation has no such layers). No search
  index or cache exists in this project, so none needs invalidation.

## Known limitations and follow-up tasks

- Password reset, account recovery, email change flows: not implemented
  (email verification partially fills the "address is reachable" gap).
- Rate limiting is per-process (not shared across workers/instances) and not
  proxy-aware. Follow-up: Redis-backed shared limiter + real client IP from
  the trusted reverse proxy header.
- CSRF is Origin-allow-list based; a full double-submit-token scheme on top of
  SameSite=Lax can be added when deployment topology is known.
- The Task 005 account-supervision endpoints still have no audit trail of
  their own (`admin_audit_log` remains the follow-up); the biomass domain
  now HAS an append-only audit (`biomass_audit_events`) — extending that
  pattern to account supervision is the natural next step.
- The biomass audit log stores only what admin/user actions record; there
  is no log ingestion, alerting, or retention policy yet.
- TLS/proxy hardening (HSTS, strict headers) belongs to deployment, not the
  application yet — no claims of production readiness are made.
- PostGIS is not installed on this machine's PostgreSQL 18.6 instance (not
  available as an extension). No spatial features were added or claimed for
  auth.
- The verification email content is a plain, professional template with no
  click-tracking; deliverability (SPF/DKIM alignment) depends on the
  provider/domain setup once a real sending domain is verified.
