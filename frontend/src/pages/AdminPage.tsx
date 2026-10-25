import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ADMIN_REQUIRED_CODE,
  ApiRequestError,
  adminApi,
  type AdminOverview,
  type AdminSessionRow,
  type AdminUserDetail,
  type AdminUserList,
  type AdminUserRole,
  type AdminUserSummary,
} from "../lib/api";
import { useAuth } from "../auth/AuthContext";

type TabId = "overview" | "users";

type LoadState =
  | { kind: "loading" }
  | { kind: "ready" }
  | { kind: "denied" }
  | { kind: "error"; message: string };

interface RowActionFeedback {
  userId: string;
  message: string;
  isError: boolean;
}

const PAGE_SIZE = 20;

function formatWhen(value: string | null): string {
  if (value === null) return "—";
  return new Date(value).toLocaleString();
}

function verificationBadge(user: AdminUserSummary): string {
  if (!user.is_active) return "Deactivated";
  if (user.is_email_verified) return "Verified";
  return "Unverified";
}

/**
 * Admin panel (Task 005).
 *
 * The role check here is a UX courtesy: every action goes through
 * /api/v1/admin/*, and the SERVER enforces role == admin for real (403
 * admin_required). A non-admin reaching this page sees a clear no-access
 * note instead of fake data. Missing/deactivated accounts and unverified
 * users can never get here (authentication gate).
 */
export function AdminPage() {
  const { user } = useAuth();
  const [tab, setTab] = useState<TabId>("overview");
  const [loadState, setLoadState] = useState<LoadState>({ kind: "loading" });
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [listing, setListing] = useState<AdminUserList | null>(null);
  const [page, setPage] = useState(1);
  const [searchInput, setSearchInput] = useState("");
  const [directory, setDirectory] = useState("");
  const [expandedUser, setExpandedUser] = useState<string | null>(null);
  const [sessionRows, setSessionRows] = useState<AdminSessionRow[] | null>(null);
  const [feedback, setFeedback] = useState<RowActionFeedback | null>(null);
  const [busyUserId, setBusyUserId] = useState<string | null>(null);

  const load = useCallback(
    async (pageNumber: number, searchTerm: string) => {
      setLoadState({ kind: "loading" });
      try {
        // Admin sees both views fresh; keep the calls independent so a
        // search refresh does not repaint the stat cards twice.
        const [overviewData, listData] = await Promise.all([
          adminApi.overview(),
          adminApi.users(pageNumber, PAGE_SIZE, searchTerm),
        ]);
        setOverview(overviewData);
        setListing(listData);
        setPage(pageNumber);
        setLoadState({ kind: "ready" });
      } catch (error) {
        if (error instanceof ApiRequestError) {
          if (error.code === ADMIN_REQUIRED_CODE || error.status === 403) {
            setLoadState({ kind: "denied" });
            return;
          }
          setLoadState({ kind: "error", message: error.message });
          return;
        }
        setLoadState({ kind: "error", message: "Could not reach the server." });
      }
    },
    [],
  );

  useEffect(() => {
    void load(1, "");
  }, [load]);

  const runAction = async (
    userId: string,
    action: () => Promise<AdminUserSummary | { revoked: number }>,
    confirmationWording: string | null,
  ) => {
    if (busyUserId !== null) return;
    if (confirmationWording !== null && !window.confirm(confirmationWording)) {
      return;
    }
    setBusyUserId(userId);
    setFeedback(null);
    try {
      await action();
      setSessionRows(null); // force a reload on next expand
      setFeedback({ userId, message: "Done.", isError: false });
      await load(page, directory);
    } catch (error) {
      const message =
        error instanceof ApiRequestError
          ? `${error.message}${error.code === ADMIN_REQUIRED_CODE ? " (admin_required)" : ""}`
          : "Action failed. Please try again.";
      setFeedback({ userId, message, isError: true });
    } finally {
      setBusyUserId(null);
    }
  };

  const expandSessions = useCallback(
    async (userId: string) => {
      if (expandedUser === userId) {
        setExpandedUser(null);
        return;
      }
      setExpandedUser(userId);
      setSessionRows(null);
      try {
        const detail: AdminUserDetail = await adminApi.userDetail(userId);
        setSessionRows(detail.sessions);
      } catch {
        setSessionRows([]);
      }
    },
    [expandedUser],
  );

  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setDirectory(searchInput);
    void load(1, searchInput);
  };

  const onRevokeOne = (userId: string, sessionId: string) =>
    void runAction(
      userId,
      () => adminApi.revokeSessions(userId, sessionId),
      "Revoke this session? The user will be signed out there.",
    );

  const onRevokeAll = (userId: string) =>
    void runAction(
      userId,
      () => adminApi.revokeSessions(userId, null),
      "Revoke ALL live sessions of this user?",
    );

  const onToggleActive = (row: AdminUserSummary) =>
    void runAction(
      row.id,
      () => adminApi.patchUser(row.id, { is_active: !row.is_active }),
      row.is_active
        ? "Deactivate this account? The user will be signed out everywhere."
        : null,
    );

  const onToggleVerified = (row: AdminUserSummary) =>
    void runAction(
      row.id,
      () => adminApi.patchUser(row.id, { is_email_verified: !row.is_email_verified }),
      row.is_email_verified
        ? "Un-verify this account? All their sessions will be revoked."
        : null,
    );

  const onToggleRole = (row: AdminUserSummary) =>
    void runAction(
      row.id,
      () => adminApi.setRole(row.id, (row.role === "admin" ? "user" : "admin") as AdminUserRole),
      row.role === "admin"
        ? `Demote ${row.email} to a normal user?`
        : `Promote ${row.email} to ADMIN? They will control all accounts.`,
    );

  if (loadState.kind === "denied") {
    return (
      <article className="page admin-page">
        <div className="card">
          <h1 className="page-title">Admin panel</h1>
          <p className="form-error" role="alert">
            This account does not have administrator access.
          </p>
        </div>
      </article>
    );
  }

  if (loadState.kind === "error") {
    return (
      <article className="page admin-page">
        <div className="card">
          <h1 className="page-title">Admin panel</h1>
          <p className="form-error" role="alert">
            {loadState.message}
          </p>
        </div>
      </article>
    );
  }

  if (loadState.kind === "loading" && overview === null && listing === null) {
    return (
      <article className="page admin-page">
        <div className="card">
          <h1 className="page-title">Admin Panel</h1>
          <p role="status" aria-live="polite">
            Loading admin data…
          </p>
        </div>
      </article>
    );
  }

  return (
    <article className="page admin-page">
      <header className="page-header">
        <h1>Admin panel</h1>
        <p>
          Supervision over platform accounts. Every action here is enforced
          and rejected server-side unless the session belongs to a role
          `admin` user.
        </p>
      </header>

      <nav className="admin-tabs" aria-label="Admin sections">
        <button
          type="button"
          className={tab === "overview" ? "admin-tab admin-tab--active" : "admin-tab"}
          onClick={() => setTab("overview")}
          aria-current={tab === "overview" ? "true" : undefined}
        >
          Overview
        </button>
        <button
          type="button"
          className={tab === "users" ? "admin-tab admin-tab--active" : "admin-tab"}
          onClick={() => setTab("users")}
          aria-current={tab === "users" ? "true" : undefined}
        >
          Users
        </button>
      </nav>

      {tab === "overview" ? (
        <section aria-label="Platform statistics">
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-label">Users</span>
              <span className="stat-value">{overview?.total_users ?? "—"}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Verified</span>
              <span className="stat-value">{overview?.verified_users ?? "—"}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Active</span>
              <span className="stat-value">{overview?.active_users ?? "—"}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Admins</span>
              <span className="stat-value">{overview?.admin_users ?? "—"}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Live sessions</span>
              <span className="stat-value">{overview?.live_sessions ?? "—"}</span>
            </div>
          </div>

          <section className="card" aria-labelledby="recent-registrations">
            <h2 id="recent-registrations">Recent registrations</h2>
            <ul className="recent-list">
              {(overview?.recent_registrations ?? []).map((row) => (
                <li key={row.id}>
                  <span className="recent-title">{row.full_name}</span>
                  <span className="recent-quantity">{row.email}</span>
                  <span className="recent-quantity">
                    {verificationBadge(row)}
                  </span>
                </li>
              ))}
            </ul>
          </section>
        </section>
      ) : (
        <section aria-label="User management">
          <form className="admin-search" onSubmit={onSearch}>
            <label htmlFor="admin-search" className="field-label">
              Search users (name or email)
            </label>
            <input
              id="admin-search"
              type="search"
              value={searchInput}
              onChange={(event) => setSearchInput(event.target.value)}
              placeholder="e.g. jane@example.com"
            />
            <button type="submit" className="btn btn--primary" disabled={loadState.kind === "loading"}>
              {loadState.kind === "loading" ? "Loading…" : "Search"}
            </button>
            {directory !== "" ? (
              <button
                type="button"
                className="btn btn--small"
                onClick={() => {
                  setSearchInput("");
                  setDirectory("");
                  void load(1, "");
                }}
              >
                Clear filter
              </button>
            ) : null}
          </form>

          {listing !== null ? (
            <p className="admin-count" role="status">
              {listing.total} user{listing.total === 1 ? "" : "s"} match
              {directory === "" ? "ed (all)" : "es for “" + directory + "”"}
              {listing.total > listing.items.length
                ? ` — page ${listing.page} of ${Math.ceil(listing.total / listing.page_size)}`
                : ""}
            </p>
          ) : null}

          {listing !== null && listing.items.length === 0 ? (
            <p className="page-placeholder-note">No users match this filter.</p>
          ) : null}

          <div className="table-wrap">
            <table className="admin-table">
              <caption className="admin-table-caption">
                User accounts (server-controlled state; actions are audited in the response)
              </caption>
              <thead>
                <tr>
                  <th scope="col">Name / Email</th>
                  <th scope="col">State</th>
                  <th scope="col">Role</th>
                  <th scope="col">Sessions</th>
                  <th scope="col">Registered</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {(listing?.items ?? []).map((row) => (
                  <AdminRow
                    key={row.id}
                    row={row}
                    isSelf={user?.id === row.id}
                    busy={busyUserId === row.id}
                    feedback={feedback?.userId === row.id ? feedback : null}
                    expanded={expandedUser === row.id}
                    sessionRows={sessionRows}
                    onToggleActive={() => onToggleActive(row)}
                    onToggleVerified={() => onToggleVerified(row)}
                    onToggleRole={() => onToggleRole(row)}
                    onRevokeAll={() => onRevokeAll(row.id)}
                    onExpand={() => void expandSessions(row.id)}
                    onRevokeOne={onRevokeOne}
                  />
                ))}
              </tbody>
            </table>
          </div>

          {listing !== null && listing.total > listing.page * listing.page_size ? (
            <button
              type="button"
              className="btn"
              onClick={() => void load(listing.page + 1, directory)}
              disabled={loadState.kind === "loading"}
            >
              Load next page
            </button>
          ) : null}
        </section>
      )}
    </article>
  );
}

interface AdminRowProps {
  row: AdminUserSummary;
  isSelf: boolean;
  busy: boolean;
  feedback: RowActionFeedback | null;
  expanded: boolean;
  sessionRows: AdminSessionRow[] | null;
  onToggleActive: () => void;
  onToggleVerified: () => void;
  onToggleRole: () => void;
  onRevokeAll: () => void;
  onExpand: () => void;
  onRevokeOne: (userId: string, sessionId: string) => void;
}

function AdminRow({
  row,
  isSelf,
  busy,
  feedback,
  expanded,
  sessionRows,
  onToggleActive,
  onToggleVerified,
  onToggleRole,
  onRevokeAll,
  onExpand,
  onRevokeOne,
}: AdminRowProps) {
  return (
    <>
      <tr className={row.is_active ? undefined : "admin-row-inactive"}>
        <td data-label="Name / Email">
          <div className="admin-user-cellname">{row.full_name}</div>
          <div className="admin-user-cellemail">{row.email}</div>
        </td>
        <td data-label="State">
          <span
            className={
              row.is_active && row.is_email_verified
                ? "badge badge--positive"
                : "badge badge--muted"
            }
          >
            {verificationBadge(row)}
          </span>
        </td>
        <td data-label="Role">
          {row.role === "admin" ? (
            <span className="badge badge--earth">admin</span>
          ) : (
            <span className="badge badge--muted">user</span>
          )}
        </td>
        <td data-label="Sessions">
          <button
            type="button"
            className="btn btn--small"
            onClick={onExpand}
            aria-expanded={expanded}
          >
            {row.live_session_count} live · view
          </button>
        </td>
        <td data-label="Registered">{formatWhen(row.created_at)}</td>
        <td data-label="Actions">
          <div className="admin-actions">
            <button
              type="button"
              className="btn btn--small"
              disabled={busy || isSelf}
              title={isSelf ? "You cannot deactivate your own account." : undefined}
              onClick={onToggleActive}
            >
              {row.is_active ? "Deactivate" : "Activate"}
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy || isSelf}
              title={isSelf ? "You cannot un-verify your own account." : undefined}
              onClick={onToggleVerified}
            >
              {row.is_email_verified ? "Un-verify" : "Force-verify"}
            </button>
            <button
              type="button"
              className="btn btn--small btn--danger"
              disabled={busy}
              onClick={onRevokeAll}
            >
              Revoke sessions
            </button>
            <button
              type="button"
              className="btn btn--small"
              disabled={busy}
              onClick={onToggleRole}
            >
              {row.role === "admin" ? "Demote" : "Promote"}
            </button>
          </div>
          {feedback !== null ? (
            <p
              className={feedback.isError ? "field-error" : "field-note"}
              role={feedback.isError ? "alert" : "status"}
            >
              {feedback.message}
            </p>
          ) : null}
        </td>
      </tr>
      {expanded ? (
        <tr className="admin-sessions-row">
          <td colSpan={6}>
            {sessionRows === null ? (
              <p role="status">Loading sessions…</p>
            ) : sessionRows.length === 0 ? (
              <p>No recorded sessions for this user.</p>
            ) : (
              <ul className="admin-session-list">
                {sessionRows.map((session) => (
                  <li key={session.id}>
                    <span>
                      {session.live
                        ? "Live"
                        : session.revoked_at !== null
                          ? "Revoked"
                          : "Expired"}
                    </span>
                    <span className="admin-session-when">
                      created {formatWhen(session.created_at)} · expires{" "}
                      {formatWhen(session.expires_at)}
                    </span>
                    {session.live ? (
                      <button
                        type="button"
                        className="btn btn--small btn--danger"
                        onClick={() => onRevokeOne(row.id, session.id)}
                      >
                        Revoke
                      </button>
                    ) : null}
                  </li>
                ))}
              </ul>
            )}
          </td>
        </tr>
      ) : null}
    </>
  );
}
