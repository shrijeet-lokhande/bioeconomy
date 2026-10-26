import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiRequestError,
  UNIT_LABELS,
  adminBiomassApi,
  type AdminDeletionResult,
  type AdminListingRow,
  type AdminLotRow,
  type AdminLotSummary,
  type AdminOrderRow,
  type OrderStatus,
  type PageMeta,
} from "../../lib/api";
import { RecordThumb } from "../../components/RecordImage";

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return "Action failed. Please try again.";
}

/** Feedback tones: plain success (note), hard failure (error), and the
 * accurate in-between state "deleted, but file cleanup still pending"
 * (warn) — a purge must never be reported as fully completed when some
 * image files could not be removed yet. */
type Feedback = { message: string; tone: "note" | "error" | "warn" };

/**
 * Admin biomass console tab. Everything here is server-enforced: an admin
 * can inspect ANY user's inventory, apply audited corrections (a reason is
 * mandatory and stored), moderate listings, and resolve disputes. No history
 * is rewritten: corrections are movements, completed orders stay completed.
 */
export function AdminBiomassTab() {
  const [summary, setSummary] = useState<AdminLotSummary | null>(null);
  const [inventory, setInventory] = useState<(PageMeta & { items: AdminLotRow[] }) | null>(null);
  const [listings, setListings] = useState<(PageMeta & { items: AdminListingRow[] }) | null>(null);
  const [orders, setOrders] = useState<(PageMeta & { items: AdminOrderRow[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const [invSearchInput, setInvSearchInput] = useState("");
  const [invSearch, setInvSearch] = useState("");
  const [flaggedOnly, setFlaggedOnly] = useState(false);
  const [orderStatus, setOrderStatus] = useState<OrderStatus | "all">("all");
  const [adjusting, setAdjusting] = useState<AdminLotRow | null>(null);
  const [flagging, setFlagging] = useState<AdminLotRow | null>(null);
  const [moderating, setModerating] = useState<{
    listing: AdminListingRow;
    action: "reject" | "suspend";
  } | null>(null);
  const [resolving, setResolving] = useState<AdminOrderRow | null>(null);
  const [purging, setPurging] = useState<{
    kind: "lot" | "listing";
    id: string;
    title: string;
  } | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [summaryData, inventoryData, listingsData, ordersData] = await Promise.all([
        adminBiomassApi.overview(),
        adminBiomassApi.inventory({
          search: invSearch || undefined,
          flagged: flaggedOnly ? true : undefined,
          page_size: 10,
        }),
        adminBiomassApi.listings({ page_size: 10 }),
        adminBiomassApi.orders({
          status_filter: orderStatus === "all" ? undefined : orderStatus,
          page_size: 10,
        }),
      ]);
      setSummary(summaryData);
      setInventory(inventoryData);
      setListings(listingsData);
      setOrders(ordersData);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [invSearch, flaggedOnly, orderStatus]);

  useEffect(() => {
    void load();
  }, [load]);

  const run = async (
    id: string,
    action: () => Promise<unknown>,
    success: string | ((result: unknown) => Feedback),
  ) => {
    if (busyId !== null) return;
    setBusyId(id);
    setFeedback(null);
    try {
      const result = await action();
      const outcome: Feedback =
        typeof success === "function"
          ? success(result)
          : { message: success, tone: "note" };
      setFeedback(outcome);
      await load();
    } catch (err) {
      setFeedback({ message: errorText(err), tone: "error" });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label="Biomass oversight">
      {loading && summary === null ? (
        <p role="status">Loading biomass data…</p>
      ) : null}
      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      {feedback !== null ? (
        <p
          className={
            feedback.tone === "error"
              ? "form-error"
              : feedback.tone === "warn"
                ? "form-warn"
                : "form-note"
          }
          role={feedback.tone === "note" ? "status" : "alert"}
        >
          {feedback.message}
        </p>
      ) : null}

      {summary !== null ? (
        <section aria-labelledby="biomass-metrics">
          <div className="stat-grid">
            <div className="stat-card">
              <span className="stat-label">Lots</span>
              <span className="stat-value">{summary.total_lots}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Active lots</span>
              <span className="stat-value">{summary.active_lots}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Listings active / paused</span>
              <span className="stat-value">
                {summary.active_listings} / {summary.paused_listings}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Rejected / withdrawn listings</span>
              <span className="stat-value">
                {summary.rejected_listings} / {summary.withdrawn_listings}
              </span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Disputed orders</span>
              <span className="stat-value">{summary.disputed_orders}</span>
            </div>
            <div className="stat-card">
              <span className="stat-label">Adjustment movements</span>
              <span className="stat-value">{summary.movements_30d}</span>
            </div>
          </div>
        </section>
      ) : null}

      <section className="card" aria-labelledby="admin-inventory-heading">
        <h2 id="admin-inventory-heading">Inventory inspection</h2>
        <form className="toolbar" onSubmit={(event: FormEvent) => event.preventDefault()}>
          <div className="field">
            <label htmlFor="admin-inv-search">Search (title or owner)</label>
            <input
              id="admin-inv-search"
              type="search"
              value={invSearchInput}
              onChange={(event) => setInvSearchInput(event.target.value)}
            />
          </div>
          <div className="toolbar-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => {
                setInvSearch(invSearchInput);
              }}
            >
              Search
            </button>
            <button
              type="button"
              className={flaggedOnly ? "btn btn--primary" : "btn"}
              aria-pressed={flaggedOnly}
              onClick={() => setFlaggedOnly((value) => !value)}
            >
              Flagged only
            </button>
          </div>
        </form>

        <div className="table-wrap">
          <table className="admin-table">
            <caption className="admin-table-caption">
              All users' inventory (owner identity visible to admins only)
            </caption>
            <thead>
              <tr>
                <th scope="col">Lot / owner</th>
                <th scope="col">Available</th>
                <th scope="col">Reserved</th>
                <th scope="col">Sold</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(inventory?.items ?? []).map((row) => (
                <tr key={row.id}>
                  <td data-label="Lot">
                    <div className="record-cell">
                      <RecordThumb images={row.images} title={row.title} />
                      <div>
                        <div>{row.title}</div>
                        <div className="admin-user-cellemail">
                          {row.owner?.full_name ?? "Unknown"} · {row.owner?.email ?? "—"}
                        </div>
                      </div>
                    </div>
                    {row.admin_flag !== null ? (
                      <div className="field-error">Flag: “{row.admin_flag}”</div>
                    ) : null}
                  </td>
                  <td data-label="Available">
                    {row.quantity_available} {UNIT_LABELS[row.unit]}
                  </td>
                  <td data-label="Reserved">{row.quantity_reserved}</td>
                  <td data-label="Sold">{row.quantity_sold}</td>
                  <td data-label="Status">{row.status}</td>
                  <td data-label="Actions">
                    <div className="admin-actions">
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={busyId === row.id || row.status !== "active"}
                        onClick={() => setAdjusting(row)}
                      >
                        Adjust
                      </button>
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={busyId === row.id}
                        onClick={() => setFlagging(row)}
                      >
                        {row.admin_flag !== null ? "Re-flag" : "Flag"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={busyId === row.id}
                        onClick={() =>
                          void run(
                            row.id,
                            () =>
                              row.status === "active"
                                ? adminBiomassApi.archiveLot(row.id)
                                : adminBiomassApi.restoreLot(row.id),
                            row.status === "active" ? "Lot archived." : "Lot restored.",
                          )
                        }
                      >
                        {row.status === "active" ? "Archive" : "Restore"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--small btn--danger"
                        disabled={busyId === row.id}
                        onClick={() =>
                          setPurging({ kind: "lot", id: row.id, title: row.title })
                        }
                      >
                        Delete permanently
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {inventory !== null && inventory.items.length === 0 ? (
          <p className="page-placeholder-note">No inventory lots match.</p>
        ) : null}
      </section>

      <section className="card" aria-labelledby="admin-listings-heading">
        <h2 id="admin-listings-heading">Listing moderation</h2>
        <div className="table-wrap">
          <table className="admin-table">
            <caption className="admin-table-caption">
              Listings with seller identity; rejection and suspension are audited
            </caption>
            <thead>
              <tr>
                <th scope="col">Listing / seller</th>
                <th scope="col">Quantity</th>
                <th scope="col">Price</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(listings?.items ?? []).map((row) => (
                <tr key={row.id}>
                  <td data-label="Listing">
                    <div>{row.title}</div>
                    <div className="admin-user-cellemail">
                      {row.seller?.full_name ?? "Unknown"} · {row.seller?.email ?? "—"}
                    </div>
                    {row.moderation_note !== null ? (
                      <div className="field-error">Note: “{row.moderation_note}”</div>
                    ) : null}
                  </td>
                  <td data-label="Quantity">
                    {row.listing_available} / {row.quantity_total} {UNIT_LABELS[row.unit]}
                  </td>
                  <td data-label="Price">{row.currency} {row.price_per_unit}</td>
                  <td data-label="Status">{row.status}</td>
                  <td data-label="Actions">
                    <div className="admin-actions">
                      <button
                        type="button"
                        className="btn btn--small btn--danger"
                        disabled={busyId === row.id || row.status === "rejected"}
                        onClick={() => setModerating({ listing: row, action: "reject" })}
                      >
                        Reject
                      </button>
                      <button
                        type="button"
                        className="btn btn--small btn--danger"
                        disabled={busyId === row.id || row.status === "withdrawn" || row.status === "rejected"}
                        onClick={() => setModerating({ listing: row, action: "suspend" })}
                      >
                        Suspend
                      </button>
                      <button
                        type="button"
                        className="btn btn--small"
                        disabled={busyId === row.id || (row.status !== "withdrawn" && row.status !== "rejected")}
                        onClick={() =>
                          void run(row.id, () => adminBiomassApi.listingAction(row.id, "reinstate", ""), "Listing reinstated to paused.")
                        }
                      >
                        Reinstate
                      </button>
                      <button
                        type="button"
                        className="btn btn--small btn--danger"
                        disabled={busyId === row.id}
                        onClick={() =>
                          setPurging({
                            kind: "listing",
                            id: row.id,
                            title: row.title,
                          })
                        }
                      >
                        Delete permanently
                      </button>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {listings !== null && listings.items.length === 0 ? (
          <p className="page-placeholder-note">No listings yet.</p>
        ) : null}
      </section>

      <section className="card" aria-labelledby="admin-orders-heading">
        <h2 id="admin-orders-heading">Transactions & disputes</h2>
        <form className="toolbar" onSubmit={(event: FormEvent) => event.preventDefault()}>
          <div className="field">
            <label htmlFor="admin-order-status">Status</label>
            <select
              id="admin-order-status"
              value={orderStatus}
              onChange={(event) => setOrderStatus(event.target.value as OrderStatus | "all")}
            >
              <option value="all">All</option>
              <option value="requested">Requested</option>
              <option value="awaiting_fulfilment">Awaiting fulfilment</option>
              <option value="fulfilled">Fulfilled</option>
              <option value="completed">Completed</option>
              <option value="cancelled">Cancelled</option>
              <option value="rejected">Rejected</option>
              <option value="disputed">Disputed</option>
            </select>
          </div>
        </form>
        <div className="table-wrap">
          <table className="admin-table">
            <caption className="admin-table-caption">
              Transactions between users; disputes are resolved with a recorded note
            </caption>
            <thead>
              <tr>
                <th scope="col">Reference / parties</th>
                <th scope="col">Quantity</th>
                <th scope="col">Total</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(orders?.items ?? []).map((row) => (
                <tr key={row.id}>
                  <td data-label="Reference">
                    <div>{row.reference}</div>
                    <div className="admin-user-cellemail">
                      buyer {row.buyer_name ?? "—"} · seller {row.seller_name ?? "—"}
                    </div>
                    {row.dispute_reason !== null ? (
                      <div className="field-error">Dispute: “{row.dispute_reason}”</div>
                    ) : null}
                    {row.settlement_status === "settled" ? (
                      <div className="field-note">Settlement recorded (manual)</div>
                    ) : null}
                  </td>
                  <td data-label="Quantity">{row.quantity} {UNIT_LABELS[row.unit]}</td>
                  <td data-label="Total">{row.currency} {row.total_amount}</td>
                  <td data-label="Status">{row.status}</td>
                  <td data-label="Actions">
                    {row.status === "disputed" ? (
                      <button
                        type="button"
                        className="btn btn--small btn--primary"
                        disabled={busyId === row.id}
                        onClick={() => setResolving(row)}
                      >
                        Resolve dispute
                      </button>
                    ) : (
                      <span className="field-note">—</span>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {orders !== null && orders.items.length === 0 ? (
          <p className="page-placeholder-note">No transactions match this filter.</p>
        ) : null}
      </section>

      {summary !== null && summary.recent_events.length > 0 ? (
        <section className="card" aria-labelledby="admin-biomass-events-heading">
          <h2 id="admin-biomass-events-heading">Latest biomass audit events</h2>
          <ul className="recent-list">
            {summary.recent_events.map((event) => (
              <li key={event.id}>
                <span className="recent-title">{event.action}</span>
                <span className="recent-quantity">
                  {event.entity_type} {event.entity_id.slice(0, 8)} ·{" "}
                  {event.actor_role}
                </span>
              </li>
            ))}
          </ul>
          <p>
            The complete, filterable history lives in the Audit tab (strictly
            read-only).
          </p>
        </section>
      ) : null}

      {adjusting !== null ? (
        <AdjustDialog
          lot={adjusting}
          busy={busyId === adjusting.id}
          onCancel={() => setAdjusting(null)}
          onSubmit={(payload) =>
            run(
              adjusting.id,
              () => adminBiomassApi.adjustLot(adjusting.id, payload),
              "Correction recorded as an audited stock movement.",
            ).then(() => setAdjusting(null))
          }
        />
      ) : null}
      {purging !== null ? (
        <PurgeDialog
          kind={purging.kind}
          title={purging.title}
          recordId={purging.id}
          busy={busyId === purging.id}
          onCancel={() => setPurging(null)}
          onSubmit={(confirmTitle) =>
            run(
              purging.id,
              () =>
                purging.kind === "lot"
                  ? adminBiomassApi.purgeLot(purging.id, confirmTitle)
                  : adminBiomassApi.purgeListing(purging.id, confirmTitle),
              (result): Feedback => {
                const deletion = result as AdminDeletionResult;
                if (deletion.status === "pending_cleanup") {
                  return {
                    message:
                      `Deleted from the database, but ${deletion.failed_files} image file(s) ` +
                      "could not be removed yet — repeat the same delete to finish the cleanup.",
                    tone: "warn",
                  };
                }
                return {
                  message:
                    `Permanently deleted; ${deletion.removed_files + deletion.missing_files} ` +
                    "image file(s) were removed or were already gone.",
                  tone: "note",
                };
              },
            ).then(() => setPurging(null))
          }
        />
      ) : null}
      {flagging !== null ? (
        <SimplePrompt
          title={`Flag lot showing “${flagging.title}”`}
          label="What should admins watch for? (recorded verbatim; empty clears nothing)"
          allowEmpty={true}
          submitLabel="Save flag"
          busy={busyId === flagging.id}
          onCancel={() => setFlagging(null)}
          onSubmit={(note) =>
            run(flagging.id, () => adminBiomassApi.flagLot(flagging.id, note), "Flag saved.").then(() =>
              setFlagging(null),
            )
          }
        />
      ) : null}
      {moderating !== null ? (
        <SimplePrompt
          title={`${moderating.action === "reject" ? "Reject" : "Suspend"} “${moderating.listing.title}”`}
          label="Reason (required, recorded in the audit trail and shown to the seller)"
          allowEmpty={false}
          submitLabel={moderating.action === "reject" ? "Reject listing" : "Suspend listing"}
          busy={busyId === moderating.listing.id}
          onCancel={() => setModerating(null)}
          onSubmit={(reason) =>
            run(
              moderating.listing.id,
              () =>
                adminBiomassApi.listingAction(moderating.listing.id, moderating.action, reason),
              moderating.action === "reject"
                ? "Listing rejected; the seller sees the reason."
                : "Listing suspended (forces open purchase requests to be cancelled with force).",
            ).then(() => setModerating(null))
          }
        />
      ) : null}
      {resolving !== null ? (
        <ResolveDisputeDialog
          order={resolving}
          busy={busyId === resolving.id}
          onCancel={() => setResolving(null)}
          onSubmit={(action, note) =>
            run(
              resolving.id,
              () => adminBiomassApi.resolveDispute(resolving.id, action, note),
              action === "cancel"
                ? "Order cancelled; the stock was released."
                : "Dispute resolved; the transaction resumes.",
            ).then(() => setResolving(null))
          }
        />
      ) : null}
    </section>
  );
}

interface AdjustPayload {
  kind: "addition" | "removal" | "correction";
  quantity?: string;
  new_available?: string;
  reason: string;
}

function AdjustDialog(props: {
  lot: AdminLotRow;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (payload: AdjustPayload) => Promise<unknown>;
}) {
  const [kind, setKind] = useState<AdjustPayload["kind"]>("correction");
  const [quantity, setQuantity] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="card" aria-label={`Adjust ${props.lot.title}`}>
      <h2>Correct: {props.lot.title}</h2>
      <p className="muted-line">
        Currently available: {props.lot.quantity_available} {UNIT_LABELS[props.lot.unit]} ·
        owned by {props.lot.owner?.email ?? "—"}. Corrections are recorded movements with your
        reason — the previous balance stays in the history.
      </p>
      <div className="field">
        <label htmlFor="adj-admin-kind">Kind</label>
        <select
          id="adj-admin-kind"
          value={kind}
          onChange={(event) => setKind(event.target.value as AdjustPayload["kind"])}
        >
          <option value="correction">Correction (set exact available)</option>
          <option value="addition">Addition</option>
          <option value="removal">Removal</option>
        </select>
      </div>
      {kind !== "correction" ? (
        <div className="field">
          <label htmlFor="adj-admin-quantity">Quantity ({UNIT_LABELS[props.lot.unit]})</label>
          <input
            id="adj-admin-quantity"
            inputMode="decimal"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </div>
      ) : (
        <div className="field">
          <label htmlFor="adj-admin-new">Corrected available quantity</label>
          <input
            id="adj-admin-new"
            inputMode="decimal"
            value={quantity}
            onChange={(event) => setQuantity(event.target.value)}
          />
        </div>
      )}
      <div className="field">
        <label htmlFor="adj-admin-reason">Reason (required)</label>
        <input
          id="adj-admin-reason"
          value={reason}
          onChange={(event) => setReason(event.target.value)}
        />
      </div>
      {reason.trim() === "" ? (
        <p className="field-note">A reason is mandatory — it is stored in the audit trail.</p>
      ) : null}
      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="toolbar-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={props.busy || reason.trim() === "" || quantity.trim() === ""}
          onClick={() =>
            props
              .onSubmit({
                kind,
                quantity: kind === "correction" ? undefined : quantity.trim(),
                new_available: kind === "correction" ? quantity.trim() : undefined,
                reason: reason.trim(),
              })
              .catch((err) => setError(errorText(err)))
          }
        >
          Record correction
        </button>
        <button type="button" className="btn" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}

/** Confirmation dialog for PERMANENT deletion: identifies the record by
 * title and ID, warns that the operation is irreversible, and requires the
 * administrator to retype the record's exact title before the destructive
 * button unlocks. The server re-verifies everything — this dialog is
 * friction against accidents, not the security boundary. */
function PurgeDialog(props: {
  kind: "lot" | "listing";
  title: string;
  recordId: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (confirmTitle: string) => Promise<unknown>;
}) {
  const [confirm, setConfirm] = useState("");
  const [error, setError] = useState<string | null>(null);
  const matches = confirm === props.title;

  return (
    <section className="card" aria-label={`Delete permanently: ${props.title}`}>
      <h2>Delete permanently: {props.title}</h2>
      <p className="muted-line">
        {props.kind === "lot" ? "Inventory record" : "Marketplace listing"} · ID{" "}
        <code>{props.recordId}</code>
      </p>
      <p className="field-error">
        This cannot be undone through the application: the record, its image
        metadata, and its image files on the server are removed for good
        {props.kind === "lot"
          ? ", together with its stock-movement journal and its order-free listings"
          : ""}
        . Records referenced by purchase transactions are refused by the
        server — transaction history is never destroyed.
      </p>
      <div className="field">
        <label htmlFor="purge-confirm-input">
          Type the record title exactly to enable deletion
        </label>
        <input
          id="purge-confirm-input"
          value={confirm}
          autoComplete="off"
          onChange={(event) => setConfirm(event.target.value)}
        />
      </div>
      {confirm.length > 0 && !matches ? (
        <p className="field-note">The title does not match yet.</p>
      ) : null}
      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="toolbar-actions">
        <button
          type="button"
          className="btn btn--danger"
          disabled={props.busy || !matches}
          onClick={() =>
            props.onSubmit(props.title).catch((err) => setError(errorText(err)))
          }
        >
          Delete permanently
        </button>
        <button type="button" className="btn" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function SimplePrompt(props: {
  title: string;
  label: string;
  allowEmpty: boolean;
  submitLabel: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (text: string) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);
  const disabled = props.busy || (!props.allowEmpty && text.trim() === "");

  return (
    <section className="card" aria-label={props.title}>
      <h2>{props.title}</h2>
      <div className="field">
        <label htmlFor="simple-prompt-input">{props.label}</label>
        <input
          id="simple-prompt-input"
          value={text}
          maxLength={300}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="toolbar-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={disabled}
          onClick={() =>
            props
              .onSubmit(text.trim())
              .catch((err) => setError(errorText(err)))
          }
        >
          {props.submitLabel}
        </button>
        <button type="button" className="btn" onClick={props.onCancel} disabled={props.busy}>
          Cancel
        </button>
      </div>
    </section>
  );
}

function ResolveDisputeDialog(props: {
  order: AdminOrderRow;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (action: "resume" | "cancel", note: string) => Promise<unknown>;
}) {
  const [note, setNote] = useState("");
  const [action, setAction] = useState<"resume" | "cancel">("resume");
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="card" aria-label={`Resolve ${props.order.reference}`}>
      <h2>Resolve dispute on {props.order.reference}</h2>
      <p className="muted-line">
        Reason given: “{props.order.dispute_reason ?? "—"}” · current status {props.order.status}
      </p>
      <p className="field-note">
        Fulfilled stock has already legally moved — for those orders the
        server forbids cancelling (no un-sale) and only a resume is valid.
        Both options are offered here; the server has the final word.
      </p>
      <div className="field">
        <label htmlFor="resolve-action">Resolution</label>
        <select
          id="resolve-action"
          value={action}
          onChange={(event) => setAction(event.target.value as "resume" | "cancel")}
        >
          <option value="resume">Resume the transaction</option>
          <option value="cancel">Cancel the order (releases reserved stock)</option>
        </select>
      </div>
      <div className="field">
        <label htmlFor="resolve-note">Decision note (required)</label>
        <input id="resolve-note" value={note} maxLength={500}
          onChange={(event) => setNote(event.target.value)} />
      </div>
      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="toolbar-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={props.busy || note.trim() === ""}
          onClick={() =>
            props
              .onSubmit(action, note.trim())
              .catch((err) => setError(errorText(err)))
          }
        >
          Resolve dispute
        </button>
        <button type="button" className="btn" onClick={props.onCancel} disabled={props.busy}>
          Cancel dialog
        </button>
      </div>
    </section>
  );
}
