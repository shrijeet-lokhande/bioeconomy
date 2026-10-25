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
    existing row is modified or removed by the migration). Apply with
    `uv run alembic upgrade head` from `backend/`.

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
