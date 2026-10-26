import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiRequestError,
  adminBiomassApi,
  type AuditEvent,
} from "../../lib/api";

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return "Action failed. Please try again.";
}

function formatWhen(value: string): string {
  return new Date(value).toLocaleString();
}

function describeEntity(event: AuditEvent): string {
  const primary = `${event.entity_type} ${event.entity_id.slice(0, 8)}`;
  if (event.related_entity_type && event.related_entity_id) {
    return `${primary} (also ${event.related_entity_type} ${event.related_entity_id.slice(0, 8)})`;
  }
  return primary;
}

/**
 * Read-only audit explorer. The backend exposes exactly one endpoint here and
 * it is a GET; audit rows themselves are append-only even at the database
 * level (the UPDATE/DELETE trigger), so there is deliberately no action,
 * edit, or delete affordance anywhere in this UI.
 */
export function AdminAuditTab() {
  const [action, setAction] = useState("");
  const [entityType, setEntityType] = useState<"lot" | "listing" | "order" | "">("");
  const [search, setSearch] = useState("");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<{
    total: number;
    page: number;
    page_size: number;
    items: AuditEvent[];
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await adminBiomassApi.audit({
          action: action.trim() === "" ? undefined : action.trim(),
          entity_type: entityType === "" ? undefined : entityType,
          search: search.trim() === "" ? undefined : search.trim(),
          page,
          page_size: 25,
        }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [action, entityType, search, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSubmit = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setPage(1);
    void load();
  };

  return (
    <section aria-label="Audit log" className="card">
      <p className="field-note" role="status">
        Append-only audit trail: rows are written inside the same database
        transaction as the change they describe, and the database itself
        refuses UPDATE and DELETE. This explorer is read-only by design.
      </p>
      <form className="toolbar" onSubmit={onSubmit}>
        <div className="field">
          <label htmlFor="audit-action">Action (e.g. lot.created)</label>
          <input
            id="audit-action"
            type="search"
            value={action}
            onChange={(event) => setAction(event.target.value)}
          />
        </div>
        <div className="field">
          <label htmlFor="audit-entity">Entity type</label>
          <select
            id="audit-entity"
            value={entityType}
            onChange={(event) => {
              setEntityType(event.target.value as typeof entityType);
              setPage(1);
            }}
          >
            <option value="">All</option>
            <option value="lot">Lot</option>
            <option value="listing">Listing</option>
            <option value="order">Order</option>
          </select>
        </div>
        <div className="field">
          <label htmlFor="audit-search">Search reason</label>
          <input
            id="audit-search"
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </div>
        <div className="toolbar-actions">
          <button type="submit" className="btn btn--primary">Filter</button>
        </div>
      </form>

      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      {!loading && data !== null && data.items.length === 0 ? (
        <p className="page-placeholder-note">No events match this filter.</p>
      ) : null}

      <div className="table-wrap">
        <table className="admin-table">
          <caption className="admin-table-caption">
            Biomass audit events (newest first; read-only)
          </caption>
          <thead>
            <tr>
              <th scope="col">When</th>
              <th scope="col">Action</th>
              <th scope="col">Actor</th>
              <th scope="col">Entity</th>
              <th scope="col">Reason</th>
              <th scope="col">Detail</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((event) => (
              <tr key={event.id}>
                <td data-label="When">{formatWhen(event.created_at)}</td>
                <td data-label="Action">{event.action}</td>
                <td data-label="Actor">{event.actor_role}</td>
                <td data-label="Entity">{describeEntity(event)}</td>
                <td data-label="Reason">{event.reason ?? "—"}</td>
                <td data-label="Detail">
                  {event.detail === null || Object.keys(event.detail).length === 0 ? (
                    "—"
                  ) : (
                    <button
                      type="button"
                      className="btn btn--small"
                      aria-expanded={expanded === event.id}
                      onClick={() => setExpanded(expanded === event.id ? null : event.id)}
                    >
                      View
                    </button>
                  )}
                  {expanded === event.id ? (
                    <pre className="audit-detail">
                      {JSON.stringify(event.detail, null, 2)}
                    </pre>
                  ) : null}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {data !== null && data.total > data.page_size ? (
        <p className="pager">
          Page {data.page} of {Math.ceil(data.total / data.page_size)} ·{" "}
          <button type="button" className="btn btn--small" disabled={page <= 1}
            onClick={() => setPage(page - 1)}>Previous</button>{" "}
          <button type="button" className="btn btn--small" disabled={data.page * data.page_size >= data.total}
            onClick={() => setPage(page + 1)}>Next</button>
        </p>
      ) : null}
    </section>
  );
}
