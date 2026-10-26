# Local Development Database

This machine runs PostgreSQL 18.6 natively (no Docker available on the
system). Recorded here for future sessions — factual setup state, not
instructions to reproduce a specific password.

- Server: PostgreSQL 18.6, `localhost:5432`, running as a system service.
- Dev database: `bioeconomy` (created for this project).
- App role: `bioeconomy_app`, password stored only in `backend/.env`
  (gitignored); the role has `CREATEDB` so the test suite can create and
  drop isolated `bioeconomy_test_<hex>` databases.
- Installed extensions: none for PostGIS — `postgis` is NOT available in
  this cluster (`pg_available_extensions` lacks it). No spatial features
  exist yet; Phase 4 will need an installation decision.
- pg_hba note: TCP connections to the `postgres` maintenance database fail
  password authentication for the app role; the test fixture therefore runs
  its CREATE/DROP DATABASE admin statements over a connection to `bioeconomy`
  in autocommit mode.
- `backend/.env.example` documents all variables with placeholder values.
- Server-side tables are owned by Alembic. Applied migrations:
  - `8a2056eb9760_create_users_and_auth_sessions`
  - `3dd348b84f8a_email_verification_columns_and_tokens` (adds
    `users.is_email_verified` default `false`, `users.email_verified_at`,
    and the `auth_email_verification_tokens` table — non-destructive; no
    existing row is modified or removed by the migration).
  - `5c1f2a9d7b40_biomass_inventory_marketplace` (creates the five biomass
    tables described below, their indexes/CHECK constraints, and the
    `biomass_audit_append_only` database trigger — non-destructive: new
    tables only, no existing row is modified or removed; downgrade drops
    only these new objects). Apply with
    `uv run alembic upgrade head` from `backend/`.
  - `f1c49d83a2b0_biomass_record_images` (creates `biomass_images` +
    indexes — non-destructive: new table only; downgrade drops only this
    table). Applied to the dev database on 2026-10-27.
  - `b4d7e91c2a55_admin_permanent_deletion` (creates
    `biomass_deletion_cleanups` — non-destructive: new table only;
    downgrade drops only this table). Applied to the dev database on
    2026-10-27.

### Biomass inventory & marketplace tables (migration `5c1f2a9d7b40`, 2026-10-26)

All quantities are `NUMERIC(14,3)`, prices `NUMERIC(14,2)` — never floats.
Every table carries tz-aware `created_at` (and `updated_at` where the row is
mutable) with `now()` server defaults; value sets are enforced by String
CHECK constraints. UUID PKs with `ondelete=RESTRICT` for entity FKs (a
referenced lot/listing/user cannot be silently deleted).

- **`biomass_lots`** — one owned inventory lot. Running counters
  `quantity_total / available / reserved / sold / transferred / removed`
  (all ≥ 0, CHECK-enforced) which are NEVER overwritten directly: they move
  only through appended `stock_movements` rows. `unit` ∈ `kg|t|m3` (no
  cross-unit aggregation); `permit_reference` is stored together with
  `permit_status ∈ not_provided|unverified` — the platform does NOT verify
  permits; `status ∈ active|archived`; optional `admin_flag`.
- **`biomass_listings`** — a marketplace offer against one lot with its own
  `listing_available / listing_reserved / quantity_sold` counters. Draft
  listings also consume offer room (offered quantity can never exceed what
  the lot still has). `status ∈ draft|active|paused|withdrawn|sold_out|
  rejected` (+ `moderation_note` from admin actions).
- **`biomass_orders`** — the transaction lifecycle, atomically reserving
  stock under PostgreSQL row locks. `reference` is a unique
  `BO-XXXXXXXX`; `client_request_id` is UNIQUE (idempotent retry = same
  order, not a second purchase). `status ∈ requested|awaiting_fulfilment|
  fulfilled|completed|cancelled|rejected|disputed` with per-transition
  timestamps and `dispute_previous_status` for the resumed state.
  `settlement_status ∈ pending|settled` records the manual off-platform
  settlement note — there is no payment provider.
- **`stock_movements`** — append-only journal per lot:
  `movement_type ∈ initial|addition|removal|correction|reservation|release|
  sale|transfer_out|transfer_in|admin_correction`, each row storing
  `quantity_delta` and `quantity_before/after` so every counter value is
  traceable to the chain of movements.
- **`biomass_audit_events`** — actor/action/entity audit trail (JSONB
  `detail`) written by admin actions and sensitive user transitions.
  **Append-only is enforced by the database itself**: trigger
  `biomass_audit_append_only` raises an exception on any UPDATE or DELETE
  of a row (verified by a test that executes both statements directly).
- **`biomass_images`** (migration `f1c49d83a2b0`, 2026-10-27) — one image
  attached to EXACTLY one record: `lot_id` XOR `listing_id` (CHECK
  `(lot_id IS NULL) <> (listing_id IS NULL)`), both `ON DELETE CASCADE`.
  `position` 1–5 (CHECK) unique per parent (`UNIQUE(lot_id, position)`,
  `UNIQUE(listing_id, position)`). The FILE BYTES live on disk in
  `BIOMASS_IMAGE_UPLOAD_DIR` under a server-generated uuid name
  (`stored_name` UNIQUE); the row stores `original_name` (sanitized
  basename, display only), `content_type ∈ image/jpeg|png|webp` (CHECK;
  decided by magic-byte sniffing, never the client's declared type) and
  `size_bytes > 0` (CHECK). The 1–5 COUNT rule is service-layer
  (row counts are not SQL-constraint material) — an image set is VALIDATED
  before any record is written and PERSISTED inside the record-creation
  transaction, so a lot/listing can never exist without its compulsory
  images.

Users reference these tables with `RESTRICT`/`SET NULL` (audit actor,
movement actor) — deleting a user is not silently cascaded through
inventory data.

- **`biomass_deletion_cleanups`** (migration `b4d7e91c2a55`,
  2026-10-27) — reliable-deletion tracking for admin permanent purges.
  `entity_type ∈ {lot, listing}` (CHECK) + `entity_id` UUID, UNIQUE
  together; `storage_keys` JSONB (the server-generated `stored_name`s of
  every image file that belonged to the deleted record, resolved from DB
  metadata before the rows were purged); `status ∈ {pending, completed}`
  (CHECK); `attempts`, `removed_files`, `missing_files`,
  `failed_files` counters. Written in the SAME transaction as the purge;
  file bytes are deleted after the commit, and a failed/interrupted file
  phase leaves the row `pending` so the same DELETE request can be
  repeated to finish cleanup idempotently.

### `auth_email_verification_tokens`

| Column | Type | Notes |
| --- | --- | --- |
| `id` | UUID PK | |
| `token_hash` | varchar(64) UNIQUE | SHA-256 of the raw token; raw tokens are never stored |
| `user_id` | UUID FK → users.id ON DELETE CASCADE | |
| `expires_at` | timestamptz | default lifetime 30 min (`VERIFICATION_TOKEN_MINUTES`) |
| `consumed_at` | timestamptz NULL | set by consumption AND by supersede (new token issued) |
| `created_at` | timestamptz | |

Housekeeping deletes consumed/expired rows opportunistically on
register/resend.

### Account verification states (factual, as of 2026-10-24)

| Account | State | How |
| --- | --- | --- |
| `shrijeet733@gmail.com` | **verified + admin** | verification email clicked by the user (Task 003); admin role assigned by the Task 005 bootstrap SQL below |
| `shrijeet777@proton.me`, `test.user@example.com`, `rl-test@example.com`, `e2e-…@example.com` | verified | documented admin SQL below (provider cannot deliver to these inboxes in test mode) |
| `full-e2e2-…@example.com`, `console-e2e-…@example.com` | created during live E2E | one verified via console-outbox cycle; other delivery-honest-failed |

Pre-existing accounts were deliberately NOT auto-verified by the migration
(verified by test V14). The approved administrative verification (manual,
operator-gated, not exposed via API):

```sql
UPDATE users SET is_email_verified = TRUE, email_verified_at = now()
WHERE email = '<address>';
```

### Admin bootstrap (Task 005 — the ONLY path to an admin)

`users.role` ('user' < 'admin') is server-controlled; no API endpoint can
create an administrator. The first (and any) admin is granted exclusively by
running this SQL on the server as the operator:

```sql
UPDATE users SET role = 'admin' WHERE email = '<address>';
```

Facts:

- Executed once for `shrijeet733@gmail.com` on 2026-10-24 (row unchanged in
  all other columns).
- Role changes take effect on the NEXT request of any live session — roles
  are not frozen into sessions (`require_admin` re-reads them per request).
- Self-protection rules: an admin cannot deactivate / un-verify / demote
  their own role through the API (400s) — keep a second admin before
  demoting an account manually, or reverse the SQL above.

  To remove an admin (operator action, not API): the demote endpoint with
  another admin's session, or directly:

  ```sql
  UPDATE users SET role = 'user' WHERE email = '<address>';
  ```

- To start/stop the service on this machine: `sudo systemctl start|stop
  postgresql.service` (requires your sudo password).
