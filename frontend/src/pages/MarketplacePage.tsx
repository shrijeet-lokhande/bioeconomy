import { useCallback, useEffect, useState, type FormEvent } from "react";
import {
  ApiRequestError,
  UNIT_LABELS,
  biomassApi,
  type BiomassOrder,
  type BrowseListingPage,
  type ListingCard,
  type ListingOwn,
  type OrderStatus,
  type PageMeta,
} from "../lib/api";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { RecordGallery, RecordThumb } from "../components/RecordImage";

type TabId = "browse" | "purchases" | "sales" | "listings";

const ORDER_STATUS_LABELS: Record<OrderStatus, string> = {
  requested: "Requested — awaiting acceptance",
  awaiting_fulfilment: "Accepted — awaiting fulfilment",
  fulfilled: "Fulfilled",
  completed: "Completed",
  cancelled: "Cancelled",
  rejected: "Rejected",
  disputed: "Disputed",
};

function statusTone(status: OrderStatus): BadgeTone {
  switch (status) {
    case "requested":
    case "awaiting_fulfilment":
      return "neutral";
    case "fulfilled":
      return "neutral";
    case "completed":
      return "positive";
    case "disputed":
      return "earth";
    default:
      return "muted";
  }
}

function formatQty(value: string, unit: string): string {
  const numeric = Number(value);
  const shown = Number.isFinite(numeric)
    ? numeric.toLocaleString(undefined, { maximumFractionDigits: 3 })
    : value;
  return `${shown} ${UNIT_LABELS[unit as keyof typeof UNIT_LABELS] ?? unit}`;
}

function formatWhen(value: string | null): string {
  if (value === null) return "—";
  return new Date(value).toLocaleString();
}

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return "Action failed. Please try again.";
}

interface Feedback {
  message: string;
  isError: boolean;
}

/**
 * Marketplace: one page for the full transaction lifecycle.
 *
 * - Browse: only PUBLISHED listings from other users; purchase creates a
 *   request and atomically reserves stock (server-enforced; idempotent
 *   retries return the same order).
 * - Purchases / Sales: participation views. Actions available depend on
 *   the ROLE AND STATUS, and every action is validated server-side again.
 * - Sales: settlement recording is a MANUAL record — no payment provider
 *   exists, the platform never claims payment happened.
 */
export function MarketplacePage() {
  const [tab, setTab] = useState<TabId>("browse");

  return (
    <article className="page">
      <header className="page-header">
        <h1>Marketplace</h1>
        <p>
          Requesting a purchase reserves stock immediately — two buyers can
          never reserve more than what exists. Purchase requests auto-expire
          if not accepted within 72 hours. Settlement is recorded manually:
          the platform has no payment provider and never claims payment.
        </p>
      </header>

      <nav className="admin-tabs" aria-label="Marketplace sections">
        {(
          [
            ["browse", "Browse", "browse"],
            ["purchases", "My purchases", "purchases"],
            ["sales", "My sales", "sales"],
            ["listings", "My listings", "listings"],
          ] as const
        ).map(([id, label]) => (
          <button
            key={id}
            type="button"
            className={tab === id ? "admin-tab admin-tab--active" : "admin-tab"}
            onClick={() => setTab(id)}
            aria-current={tab === id ? "true" : undefined}
          >
            {label}
          </button>
        ))}
      </nav>

      {tab === "browse" ? <BrowseTab /> : null}
      {tab === "purchases" ? <OrdersTab role="buying" /> : null}
      {tab === "sales" ? <OrdersTab role="selling" /> : null}
      {tab === "listings" ? <MyListingsTab /> : null}
    </article>
  );
}

// ==== browse ================================================================

function BrowseTab() {
  const [searchInput, setSearchInput] = useState("");
  const [appliedSearch, setAppliedSearch] = useState("");
  const [sort, setSort] = useState<"recent" | "price_asc" | "price_desc" | "quantity_desc">("recent");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<BrowseListingPage | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [openListing, setOpenListing] = useState<ListingCard | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await biomassApi.browseListings({
          search: appliedSearch || undefined,
          sort,
          page,
          page_size: 12,
        }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [appliedSearch, sort, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedSearch(searchInput);
    setPage(1);
  };

  return (
    <section aria-label="Browse listings" className="card">
      <form className="toolbar" onSubmit={onSearch}>
        <div className="field">
          <label htmlFor="mk-search">Search</label>
          <input
            id="mk-search"
            type="search"
            value={searchInput}
            onChange={(event) => setSearchInput(event.target.value)}
            placeholder="Title, description, material, location"
          />
        </div>
        <div className="field">
          <label htmlFor="mk-sort">Sort</label>
          <select
            id="mk-sort"
            value={sort}
            onChange={(event) => {
              setSort(event.target.value as typeof sort);
              setPage(1);
            }}
          >
            <option value="recent">Newest first</option>
            <option value="price_asc">Price: low to high</option>
            <option value="price_desc">Price: high to low</option>
            <option value="quantity_desc">Largest available</option>
          </select>
        </div>
        <div className="toolbar-actions">
          <button type="submit" className="btn btn--primary">Search</button>
        </div>
      </form>

      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      {!loading && data !== null && data.items.length === 0 ? (
        <p className="page-placeholder-note">No active listings match this search.</p>
      ) : null}

      <div className="listing-cards">
        {(data?.items ?? []).map((card) => (
          <div className="listing-card" key={card.id}>
            <RecordThumb images={card.images} title={card.title} />
            <h3>{card.title}</h3>
            <p className="muted-line">
              {card.category} · {card.material_type}
            </p>
            <p>
              <strong>{formatQty(card.listing_available, card.unit)}</strong> available of{" "}
              {formatQty(card.quantity_total, card.unit)}
            </p>
            <p>
              {card.currency} {card.price_per_unit} / {UNIT_LABELS[card.unit]}
            </p>
            <p className="muted-line">
              {card.seller_name} · fulfilment: {card.fulfilment}
              {card.location !== null ? ` · ${card.location}` : ""}
            </p>
            <p className="muted-line">
              Permit on source lot:{" "}
              {card.permit_status === "not_provided" ? "not provided" : card.permit_status} — the
              platform does not verify permit references.
            </p>
            <button
              type="button"
              className="btn btn--primary btn--small"
              onClick={() => void openDetail(card.id)}
            >
              View & request purchase
            </button>
          </div>
        ))}
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

      {openListing !== null ? (
        <PurchaseDialog
          listing={openListing}
          onClose={() => setOpenListing(null)}
        />
      ) : null}
    </section>
  );

  async function openDetail(listingId: string) {
    setError(null);
    try {
      setOpenListing(await biomassApi.listingDetail(listingId));
    } catch (err) {
      setError(errorText(err));
    }
  }
}

function PurchaseDialog(props: { listing: ListingCard; onClose: () => void }) {
  const { listing } = props;
  const [quantity, setQuantity] = useState("");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [created, setCreated] = useState<BiomassOrder | null>(null);

  const maximum = Number(listing.listing_available);

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      // The backend returns the SAME order on a retry of the same
      // client_request_id (idempotent purchase requests).
      const order = await biomassApi.createOrder(listing.id, {
        quantity,
        buyer_note: note === "" ? null : note,
      });
      setCreated(order);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="purchase-heading">
      <h2 id="purchase-heading">Purchase request: {listing.title}</h2>
      <RecordGallery images={listing.images} title={listing.title} />
      <p>
        {formatQty(listing.listing_available, listing.unit)} available ·{" "}
        {listing.currency} {listing.price_per_unit} per {UNIT_LABELS[listing.unit]} ·
        seller {listing.seller_name}
      </p>
      {listing.description !== null ? <p>{listing.description}</p> : null}
      <p className="muted-line">
        Quality grade: {listing.quality_grade ?? "not recorded"} · moisture:{" "}
        {listing.moisture_percent !== null ? `${listing.moisture_percent}%` : "not recorded"} ·
        provenance: {listing.source_provenance ?? "not recorded"}
      </p>

      {created !== null ? (
        <div>
          <p className="form-note" role="status">
            Purchase request <strong>{created.reference}</strong> created with{" "}
            {formatQty(created.quantity, created.unit)} reserved. The seller must
            accept it within 72 hours or the reservation expires automatically.
          </p>
          <button type="button" className="btn" onClick={props.onClose}>Close</button>
        </div>
      ) : (
        <form onSubmit={submit}>
          <div className="field">
            <label htmlFor="po-quantity">Quantity ({UNIT_LABELS[listing.unit]}, max {listing.listing_available})</label>
            <input
              id="po-quantity"
              required
              inputMode="decimal"
              value={quantity}
              onChange={(event) => setQuantity(event.target.value)}
            />
            {Number.isFinite(maximum) ? (
              <p className="field-note">
                Reserving is instant and atomic; the stock is held while the
                seller decides.
              </p>
            ) : null}
          </div>
          <div className="field">
            <label htmlFor="po-note">Note to seller (optional)</label>
            <input
              id="po-note"
              maxLength={500}
              value={note}
              onChange={(event) => setNote(event.target.value)}
            />
          </div>
          {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
          <div className="toolbar-actions">
            <button type="submit" className="btn btn--primary" disabled={busy}>
              {busy ? "Requesting…" : "Request purchase"}
            </button>
            <button type="button" className="btn" onClick={props.onClose}>Cancel</button>
          </div>
        </form>
      )}
    </section>
  );
}

// ==== orders (purchases / sales) ============================================

function OrdersTab(props: { role: "buying" | "selling" }) {
  const [statusFilter, setStatusFilter] = useState<"all" | "open">("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<(PageMeta & { items: BiomassOrder[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);
  const [settling, setSettling] = useState<BiomassOrder | null>(null);
  const [disputing, setDisputing] = useState<BiomassOrder | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await biomassApi.orders({
          role: props.role,
          status_filter: statusFilter,
          page,
          page_size: 10,
        }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [props.role, statusFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const act = async (order: BiomassOrder, action: () => Promise<BiomassOrder>, success: string) => {
    if (busyId !== null) return;
    setBusyId(order.id);
    setFeedback(null);
    try {
      await action();
      setFeedback({ message: success, isError: false });
      await load();
    } catch (err) {
      setFeedback({ message: errorText(err), isError: true });
    } finally {
      setBusyId(null);
    }
  };

  const canAccept = (order: BiomassOrder) =>
    order.status === "requested" && order.role === "seller";
  const canConfirm = (order: BiomassOrder) =>
    order.status === "fulfilled" && order.role === "buyer";
  const canSettle = (order: BiomassOrder) =>
    order.status === "fulfilled" || order.status === "completed";

  return (
    <section aria-label={props.role === "buying" ? "Purchases" : "Sales"} className="card">
      <form className="toolbar" onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label htmlFor="ord-status">Status</label>
          <select
            id="ord-status"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as typeof statusFilter);
              setPage(1);
            }}
          >
            <option value="all">All</option>
            <option value="open">Open (not yet complete)</option>
          </select>
        </div>
      </form>

      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      {feedback !== null ? (
        <p className={feedback.isError ? "form-error" : "form-note"}
          role={feedback.isError ? "alert" : "status"}>
          {feedback.message}
        </p>
      ) : null}
      {!loading && data !== null && data.items.length === 0 ? (
        <p className="page-placeholder-note">
          {props.role === "buying"
            ? "No purchase requests yet — browse the marketplace to make one."
            : "No sales yet — publish a listing from your inventory."}
        </p>
      ) : null}

      <div className="order-list">
        {(data?.items ?? []).map((order) => (
          <div className="order-row" key={order.id}>
            <div className="order-head">
              <strong>{order.reference}</strong>
              <Badge tone={statusTone(order.status)}>
                {ORDER_STATUS_LABELS[order.status]}
              </Badge>
            </div>
            <p>
              {formatQty(order.quantity, order.unit)} · {order.currency}{" "}
              {order.unit_price} / {UNIT_LABELS[order.unit]} · total {order.currency}{" "}
              {order.total_amount}
            </p>
            <p className="muted-line">
              {props.role === "buying" ? "Seller" : "Buyer"}:{" "}
              {order.counterparty_name ?? "—"} · listing: {order.listing_title ?? "—"} ·
              created {formatWhen(order.created_at)}
            </p>
            {order.buyer_note !== null ? (
              <p className="muted-line">Buyer note: “{order.buyer_note}”</p>
            ) : null}
            {order.status === "requested" ? (
              <p className="muted-line">
                Reservation expires {formatWhen(order.reservation_expires_at)}
              </p>
            ) : null}
            {order.status === "cancelled" && order.released_at !== null ? (
              <p className="muted-line">Stock was released back {formatWhen(order.released_at)}.</p>
            ) : null}
            {order.dispute_reason !== null ? (
              <p className="muted-line">Dispute: “{order.dispute_reason}”{order.resolution_note !== null ? ` · resolution: “${order.resolution_note}”` : ""}</p>
            ) : null}
            {order.settlement_status === "settled" ? (
              <p className="muted-line">
                Settlement recorded {formatWhen(order.settlement_at)} (manual record —
                no payment was processed by the platform)
                {order.settlement_note !== null ? `: “${order.settlement_note}”` : ""}
              </p>
            ) : null}

            <div className="admin-actions">
              {canAccept(order) ? (
                <>
                  <button
                    type="button"
                    className="btn btn--small btn--primary"
                    disabled={busyId === order.id}
                    onClick={() =>
                      void act(order, () => biomassApi.orderAction(order.id, "accept"), "Request accepted; stock stays reserved.")
                    }
                  >
                    Accept
                  </button>
                  <button
                    type="button"
                    className="btn btn--small btn--danger"
                    disabled={busyId === order.id}
                    onClick={() =>
                      void act(order, () => biomassApi.orderAction(order.id, "reject"), "Request rejected; stock released back to your listing.")
                    }
                  >
                    Reject
                  </button>
                </>
              ) : null}
              {order.status === "requested" && order.role === "buyer" ? (
                <button
                  type="button"
                  className="btn btn--small btn--danger"
                  disabled={busyId === order.id}
                  onClick={() =>
                    void act(order, () => biomassApi.orderAction(order.id, "cancel"), "Purchase cancelled; stock released.")
                  }
                >
                  Cancel
                </button>
              ) : null}
              {order.status === "awaiting_fulfilment" && order.role === "seller" ? (
                <button
                  type="button"
                  className="btn btn--small btn--primary"
                  disabled={busyId === order.id}
                  onClick={() =>
                    void act(order, () => biomassApi.orderAction(order.id, "fulfil"), "Marked fulfilled; reserved stock recorded as sold.")
                  }
                >
                  Mark fulfilled
                </button>
              ) : null}
              {canConfirm(order) ? (
                <button
                  type="button"
                  className="btn btn--small btn--primary"
                  disabled={busyId === order.id}
                  onClick={() =>
                    void act(order, () => biomassApi.orderAction(order.id, "confirm"), "Receipt confirmed; transaction completed.")
                  }
                >
                  Confirm receipt
                </button>
              ) : null}
              {["awaiting_fulfilment", "fulfilled"].includes(order.status) && order.role === "buyer" ? (
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busyId === order.id}
                  onClick={() => setDisputing(order)}
                >
                  Open dispute
                </button>
              ) : null}
              {canSettle(order) && order.role === "seller" && order.settlement_status !== "settled" ? (
                <button
                  type="button"
                  className="btn btn--small"
                  disabled={busyId === order.id}
                  onClick={() => setSettling(order)}
                >
                  Record settlement
                </button>
              ) : null}
            </div>
          </div>
        ))}
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

      {disputing !== null ? (
        <ReasonDialog
          title={`Dispute ${disputing.reference}`}
          label="What went wrong? (required)"
          submitLabel="Open dispute"
          busy={busyId === disputing.id}
          onCancel={() => setDisputing(null)}
          onSubmit={(reason) =>
            act(disputing, () => biomassApi.disputeOrder(disputing.id, reason), "Dispute opened; the transaction is frozen until an administrator resolves it.").then(() => setDisputing(null))
          }
        />
      ) : null}
      {settling !== null ? (
        <ReasonDialog
          title={`Record settlement for ${settling.reference}`}
          label="How was payment settled off-platform? (required)"
          submitLabel="Record settlement"
          busy={busyId === settling.id}
          onCancel={() => setSettling(null)}
          onSubmit={(note) =>
            act(settling, () => biomassApi.recordSettlement(settling.id, note), "Settlement recorded. The platform never processed payment itself.").then(() => setSettling(null))
          }
        />
      ) : null}
    </section>
  );
}

function ReasonDialog(props: {
  title: string;
  label: string;
  submitLabel: string;
  busy: boolean;
  onCancel: () => void;
  onSubmit: (reason: string) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  return (
    <section className="card" aria-label={props.title}>
      <h2>{props.title}</h2>
      <div className="field">
        <label htmlFor="reason-dialog-input">{props.label}</label>
        <input
          id="reason-dialog-input"
          required
          maxLength={500}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
      </div>
      {text.trim() === "" ? (
        <p className="field-note">A reason is required and will be recorded verbatim.</p>
      ) : null}
      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      <div className="toolbar-actions">
        <button
          type="button"
          className="btn btn--primary"
          disabled={props.busy || text.trim() === ""}
          onClick={() =>
            props
              .onSubmit(text.trim())
              .catch(() => setError(errorText(new ApiRequestError(0, "Action failed."))))
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

// ==== my listings ===========================================================

function MyListingsTab() {
  const [statusFilter, setStatusFilter] = useState<"all" | ListingOwn["status"]>("all");
  const [page, setPage] = useState(1);
  const [data, setData] = useState<(PageMeta & { items: ListingOwn[] }) | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);
  const [busyId, setBusyId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<Feedback | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      setData(
        await biomassApi.myListings({ status_filter: statusFilter, page, page_size: 10 }),
      );
    } catch (err) {
      setError(errorText(err));
    } finally {
      setLoading(false);
    }
  }, [statusFilter, page]);

  useEffect(() => {
    void load();
  }, [load]);

  const transition = async (listing: ListingOwn, action: "publish" | "pause" | "resume" | "withdraw") => {
    if (busyId !== null) return;
    if (action === "withdraw" && !window.confirm(`Withdraw "${listing.title}" from sale?`)) {
      return;
    }
    setBusyId(listing.id);
    setFeedback(null);
    try {
      await biomassApi.listingTransition(listing.id, action);
      setFeedback({ message: "Listing updated.", isError: false });
      await load();
    } catch (err) {
      setFeedback({ message: errorText(err), isError: true });
    } finally {
      setBusyId(null);
    }
  };

  return (
    <section aria-label="My listings" className="card">
      <form className="toolbar" onSubmit={(event) => event.preventDefault()}>
        <div className="field">
          <label htmlFor="ml-status">Status</label>
          <select
            id="ml-status"
            value={statusFilter}
            onChange={(event) => {
              setStatusFilter(event.target.value as typeof statusFilter);
              setPage(1);
            }}
          >
            <option value="all">All</option>
            <option value="draft">Draft</option>
            <option value="active">Active</option>
            <option value="paused">Paused</option>
            <option value="withdrawn">Withdrawn</option>
            <option value="sold_out">Sold out</option>
            <option value="rejected">Rejected</option>
          </select>
        </div>
      </form>

      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      {feedback !== null ? (
        <p className={feedback.isError ? "form-error" : "form-note"}
          role={feedback.isError ? "alert" : "status"}>
          {feedback.message}
        </p>
      ) : null}
      {!loading && data !== null && data.items.length === 0 ? (
        <p className="page-placeholder-note">
          No listings yet — list a lot from your Biomass Inventory page.
        </p>
      ) : null}

      <div className="table-wrap">
        <table className="listing-table">
          <caption className="visually-hidden">Your marketplace listings</caption>
          <thead>
            <tr>
              <th scope="col">Listing</th>
              <th scope="col">Available</th>
              <th scope="col">Reserved</th>
              <th scope="col">Sold</th>
              <th scope="col">Price</th>
              <th scope="col">Status</th>
              <th scope="col">Actions</th>
            </tr>
          </thead>
          <tbody>
            {(data?.items ?? []).map((row) => (
              <tr key={row.id}>
                <th scope="row">
                  <div className="record-cell">
                    <RecordThumb images={row.images} title={row.title} />
                    <div>
                      <div>{row.title}</div>
                      <div className="muted-line">{row.material_type}</div>
                      {row.moderation_note !== null ? (
                        <div className="muted-line">Moderation: “{row.moderation_note}”</div>
                      ) : null}
                    </div>
                  </div>
                </th>
                <td>{formatQty(row.listing_available, row.unit)}</td>
                <td>{formatQty(row.listing_reserved, row.unit)}</td>
                <td>{formatQty(row.quantity_sold, row.unit)}</td>
                <td>{row.currency} {row.price_per_unit} / {UNIT_LABELS[row.unit]}</td>
                <td>
                  <Badge
                    tone={
                      row.status === "active"
                        ? "positive"
                        : row.status === "rejected"
                          ? "earth"
                          : "muted"
                    }
                  >
                    {row.status}
                  </Badge>
                </td>
                <td className="cell-actions">
                  {row.status === "draft" ? (
                    <button type="button" className="btn btn--small btn--primary"
                      disabled={busyId === row.id}
                      onClick={() => void transition(row, "publish")}>
                      Publish
                    </button>
                  ) : null}
                  {row.status === "active" ? (
                    <>
                      <button type="button" className="btn btn--small"
                        disabled={busyId === row.id}
                        onClick={() => void transition(row, "pause")}>
                        Pause
                      </button>
                      <button type="button" className="btn btn--small btn--danger"
                        disabled={busyId === row.id}
                        onClick={() => void transition(row, "withdraw")}>
                        Withdraw
                      </button>
                    </>
                  ) : null}
                  {row.status === "paused" ? (
                    <button type="button" className="btn btn--small btn--primary"
                      disabled={busyId === row.id}
                      onClick={() => void transition(row, "resume")}>
                      Resume
                    </button>
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
