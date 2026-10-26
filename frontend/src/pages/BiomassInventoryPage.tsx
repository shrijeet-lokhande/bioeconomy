import { useCallback, useEffect, useMemo, useState, type FormEvent } from "react";
import {
  ApiRequestError,
  UNIT_LABELS,
  biomassApi,
  formatQuantitySummary,
  type AdjustInput,
  type BiomassLot,
  type BiomassUnit,
  type LotPage,
  type LotDetailResponse,
} from "../lib/api";
import { Badge, type BadgeTone } from "../components/ui/Badge";
import { StatCard } from "../components/ui/StatCard";
import { ImageUploadField } from "../components/ImageUploadField";
import { RecordGallery, RecordThumb } from "../components/RecordImage";
import { imageCountError } from "../domain/imageValidation";

const PERMIT_LABELS: Record<string, string> = {
  not_provided: "No permit reference",
  unverified: "Permit unverified",
  review_required: "Permit under review",
};

const CATEGORY_SUGGESTIONS = [
  "Forestry",
  "Agriculture",
  "Residues",
  "Recovered",
];

interface Filters {
  search: string;
  status: "active" | "archived" | "all";
  unit: BiomassUnit | "";
  sort: "recent" | "updated" | "quantity" | "price";
  page: number;
}

function lotBadge(lot: BiomassLot): { tone: BadgeTone; label: string } {
  if (lot.status === "archived") return { tone: "muted", label: "Archived" };
  if (lot.admin_flag !== null) return { tone: "earth", label: "Flagged" };
  return { tone: "positive", label: "Active" };
}

function formatWhen(value: string): string {
  return new Date(value).toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  });
}

function errorText(error: unknown): string {
  if (error instanceof ApiRequestError) return error.message;
  return "Action failed. Please try again.";
}

export function BiomassInventoryPage() {
  const [filters, setFilters] = useState<Filters>({
    search: "",
    status: "active",
    unit: "",
    sort: "recent",
    page: 1,
  });
  const [appliedSearch, setAppliedSearch] = useState("");
  const [pageData, setPageData] = useState<LotPage | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<LotDetailResponse | null>(null);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<{ message: string; isError: boolean } | null>(null);
  const [csvBusy, setCsvBusy] = useState(false);

  const load = useCallback(async (current: Filters, search: string) => {
    setLoading(true);
    setLoadError(null);
    try {
      const data = await biomassApi.inventory({
        search,
        status_filter: current.status,
        unit: current.unit === "" ? undefined : current.unit,
        sort: current.sort,
        page: current.page,
        page_size: 10,
      });
      setPageData(data);
    } catch (error) {
      setLoadError(errorText(error));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void load(filters, appliedSearch);
  }, [filters, appliedSearch, load]);

  const summarize = (status: string) => {
    setFilters({ ...filters, status: status as Filters["status"], page: 1 });
  };

  const refreshDetail = useCallback(async (lotId: string): Promise<void> => {
    const detail = await biomassApi.lotDetail(lotId);
    setSelected(detail);
    await load(filters, appliedSearch);
  }, [filters, appliedSearch, load]);

  const exportCsv = async () => {
    setCsvBusy(true);
    try {
      const blob = await biomassApi.exportCsv();
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement("a");
      anchor.href = url;
      anchor.download = "biomass_inventory.csv";
      anchor.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      setFeedback({ message: errorText(error), isError: true });
    } finally {
      setCsvBusy(false);
    }
  };

  const toggleArchive = async (lot: BiomassLot) => {
    if (busy) return;
    if (
      lot.status === "active" &&
      !window.confirm(`Archive "${lot.title}"? It cannot be listed while archived.`)
    ) {
      return;
    }
    setBusy(true);
    setFeedback(null);
    try {
      await (lot.status === "active" ? biomassApi.archiveLot(lot.id) : biomassApi.restoreLot(lot.id));
      setFeedback({ message: "Done.", isError: false });
      await refreshDetail(lot.id);
    } catch (error) {
      setFeedback({ message: errorText(error), isError: true });
    } finally {
      setBusy(false);
    }
  };

  const summary = pageData?.summary ?? null;
  const lowStock = useMemo(() => {
    if (summary === null || pageData === null) return [];
    return pageData.items.filter((lot) => summary.low_stock_lot_ids.includes(lot.id));
  }, [summary, pageData]);

  const onSearch = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setAppliedSearch(filters.search);
    setFilters({ ...filters, page: 1 });
  };

  return (
    <article className="page">
      <header className="page-header">
        <h1>Biomass Inventory</h1>
        <p>
          Your recorded biomass stock. Every quantity change is a recorded
          stock movement with a reason — balances are never silently
          overwritten. Permit references are stored as recorded, but the
          platform does not verify them.
        </p>
        <div className="toolbar-actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={() => setCreating((open) => !open)}
          >
            {creating ? "Close form" : "Record new lot"}
          </button>
          <button type="button" className="btn" onClick={() => void exportCsv()} disabled={csvBusy}>
            {csvBusy ? "Exporting…" : "Export CSV"}
          </button>
        </div>
      </header>

      {feedback !== null ? (
        <p className={feedback.isError ? "form-error" : "form-note"} role={feedback.isError ? "alert" : "status"}>
          {feedback.message}
        </p>
      ) : null}

      {creating ? (
        <LotCreateForm
          onDone={(created) => {
            setCreating(false);
            setFeedback({ message: `Lot "${created.title}" recorded.`, isError: false });
            void load({ ...filters, status: "active", page: 1 }, appliedSearch);
          }}
          onCancel={() => setCreating(false)}
        />
      ) : null}

      {summary !== null ? (
        <section aria-labelledby="summary-heading">
          <h2 id="summary-heading" className="visually-hidden">Inventory summary</h2>
          <div className="stat-grid">
            <StatCard label="Lots" value={String(summary.total_lots)} hint={`${summary.active_lots} active`} />
            <StatCard
              label="Available"
              value={formatQuantitySummary(summary.available_by_unit)}
              hint="Per unit — never summed across units"
            />
            <StatCard
              label="Reserved"
              value={formatQuantitySummary(summary.reserved_by_unit)}
              hint="Held by open purchase requests"
            />
            <StatCard
              label={`Sold / transferred (${summary.period_days}d)`}
              value={formatQuantitySummary(summary.sold_period_by_unit)}
            />
            <StatCard
              label="Estimated value"
              value={
                summary.estimated_value_by_currency
                  ? Object.entries(summary.estimated_value_by_currency)
                      .map(([currency, value]) => `${currency} ${value}`)
                      .join(" · ")
                  : "—"
              }
              hint={`${summary.priced_lots} priced lot${summary.priced_lots === 1 ? "" : "s"}`}
            />
          </div>
        </section>
      ) : null}

      {lowStock.length > 0 ? (
        <div className="card alert-strip" role="status">
          <p>
            Low stock on: {" "}
            {lowStock.map((lot) => lot.title).join(", ")} — available quantity
            is at or below 10% of the original total.
          </p>
        </div>
      ) : null}

      <section className="card" aria-labelledby="inventory-list-heading">
        <h2 id="inventory-list-heading">Inventory lots</h2>

        <form className="toolbar" onSubmit={onSearch}>
          <div className="field">
            <label htmlFor="lot-search">Search</label>
            <input
              id="lot-search"
              type="search"
              value={filters.search}
              onChange={(event) => setFilters({ ...filters, search: event.target.value })}
              placeholder="Title, material, category, storage"
            />
          </div>
          <div className="field">
            <label htmlFor="lot-status">Status</label>
            <select
              id="lot-status"
              value={filters.status}
              onChange={(event) => summarize(event.target.value)}
            >
              <option value="active">Active</option>
              <option value="archived">Archived</option>
              <option value="all">All</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="lot-unit">Unit</label>
            <select
              id="lot-unit"
              value={filters.unit}
              onChange={(event) =>
                setFilters({ ...filters, unit: event.target.value as BiomassUnit | "", page: 1 })
              }
            >
              <option value="">All units</option>
              <option value="kg">kg</option>
              <option value="t">tonnes</option>
              <option value="m3">m³</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="lot-sort">Sort</label>
            <select
              id="lot-sort"
              value={filters.sort}
              onChange={(event) =>
                setFilters({ ...filters, sort: event.target.value as Filters["sort"], page: 1 })
              }
            >
              <option value="recent">Newest first</option>
              <option value="updated">Recently updated</option>
              <option value="quantity">Largest available</option>
              <option value="price">Highest price</option>
            </select>
          </div>
          <div className="toolbar-actions">
            <button type="submit" className="btn btn--primary">Search</button>
          </div>
        </form>

        {loadError !== null ? (
          <p className="form-error" role="alert">{loadError}</p>
        ) : null}

        {pageData !== null && pageData.items.length === 0 && !loading ? (
          <p className="page-placeholder-note">
            {appliedSearch === "" && filters.status === "active"
              ? "No inventory lots yet — record your first lot to start."
              : "No lots match the current filters."}
          </p>
        ) : null}

        <div className="table-wrap">
          <table className="listing-table">
            <caption className="visually-hidden">
              Your inventory lots with recorded balances
            </caption>
            <thead>
              <tr>
                <th scope="col">Lot</th>
                <th scope="col">Available</th>
                <th scope="col">Reserved</th>
                <th scope="col">Storage</th>
                <th scope="col">Permit</th>
                <th scope="col">Status</th>
                <th scope="col">Actions</th>
              </tr>
            </thead>
            <tbody>
              {(pageData?.items ?? []).map((lot) => {
                const badge = lotBadge(lot);
                return (
                  <tr key={lot.id}>
                    <th scope="row">
                      <div className="record-cell">
                        <RecordThumb images={lot.images} title={lot.title} />
                        <div>
                          <div>{lot.title}</div>
                          <div className="muted-line">
                            {lot.material_type} · {formatDecimalQty(lot.quantity_total)} {UNIT_LABELS[lot.unit]} ever recorded
                          </div>
                        </div>
                      </div>
                    </th>
                    <td>{formatDecimalQty(lot.quantity_available)} {UNIT_LABELS[lot.unit]}</td>
                    <td>{formatDecimalQty(lot.quantity_reserved)} {UNIT_LABELS[lot.unit]}</td>
                    <td>{lot.storage_location}</td>
                    <td>
                      {lot.permit_reference === null
                        ? "—"
                        : `${lot.permit_reference} (${PERMIT_LABELS[lot.permit_status] ?? lot.permit_status})`}
                    </td>
                    <td>
                      <Badge tone={badge.tone}>{badge.label}</Badge>
                    </td>
                    <td className="cell-actions">
                      <button
                        type="button"
                        className="btn btn--small"
                        onClick={() => void selectLot(lot.id)}
                      >
                        {selected?.lot.id === lot.id ? "Hide" : "Manage"}
                      </button>
                      <button
                        type="button"
                        className="btn btn--small btn--danger"
                        disabled={busy}
                        onClick={() => void toggleArchive(lot)}
                      >
                        {lot.status === "active" ? "Archive" : "Restore"}
                      </button>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>

        {pageData !== null && pageData.total > pageData.page_size ? (
          <p className="pager">
            Page {pageData.page} of {Math.ceil(pageData.total / pageData.page_size)} ·{" "}
            <button
              type="button"
              className="btn btn--small"
              disabled={filters.page <= 1}
              onClick={() => setFilters({ ...filters, page: filters.page - 1 })}
            >
              Previous
            </button>{" "}
            <button
              type="button"
              className="btn btn--small"
              disabled={pageData.page * pageData.page_size >= pageData.total}
              onClick={() => setFilters({ ...filters, page: filters.page + 1 })}
            >
              Next
            </button>
          </p>
        ) : null}
      </section>

      {selected !== null ? (
        <LotManager
          detail={selected}
          busy={busy}
          reload={() => refreshDetail(selected.lot.id)}
        />
      ) : null}
    </article>
  );

  async function selectLot(lotId: string) {
    if (selected?.lot.id === lotId) {
      setSelected(null);
      return;
    }
    setBusy(true);
    try {
      setSelected(await biomassApi.lotDetail(lotId));
      setFeedback(null);
    } catch (error) {
      setFeedback({ message: errorText(error), isError: true });
    } finally {
      setBusy(false);
    }
  }
}

function formatDecimalQty(value: string): string {
  const numeric = Number(value);
  return Number.isFinite(numeric)
    ? numeric.toLocaleString(undefined, { maximumFractionDigits: 3 })
    : value;
}

// ==== create form ===========================================================

interface LotFormState {
  title: string;
  category: string;
  materialType: string;
  unit: BiomassUnit;
  quantity: string;
  storageLocation: string;
  moisture: string;
  harvestDate: string;
  provenance: string;
  qualityGrade: string;
  permitReference: string;
  price: string;
}

const EMPTY_FORM: LotFormState = {
  title: "",
  category: CATEGORY_SUGGESTIONS[0],
  materialType: "",
  unit: "kg",
  quantity: "",
  storageLocation: "",
  moisture: "",
  harvestDate: "",
  provenance: "",
  qualityGrade: "",
  permitReference: "",
  price: "",
};

function LotCreateForm(props: {
  onDone: (created: BiomassLot) => void;
  onCancel: () => void;
}) {
  const [form, setForm] = useState<LotFormState>(EMPTY_FORM);
  const [images, setImages] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const set = <K extends keyof LotFormState>(key: K, value: LotFormState[K]) =>
    setForm({ ...form, [key]: value });

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    // Compulsory images: a lot never registers without 1–5 of them.
    const countProblem = imageCountError(images.length);
    if (countProblem !== null) {
      setError(countProblem);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await biomassApi.createLot(
        {
          title: form.title,
          category: form.category,
          material_type: form.materialType,
          unit: form.unit,
          quantity: form.quantity,
          storage_location: form.storageLocation,
          moisture_percent: form.moisture === "" ? null : form.moisture,
          harvest_date: form.harvestDate === "" ? null : form.harvestDate,
          source_provenance: form.provenance === "" ? null : form.provenance,
          quality_grade: form.qualityGrade === "" ? null : form.qualityGrade,
          permit_reference: form.permitReference === "" ? null : form.permitReference,
          price_per_unit: form.price === "" ? null : form.price,
          currency: "USD",
        },
        images,
      );
      props.onDone(created);
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="card" aria-labelledby="lot-form-heading">
      <h2 id="lot-form-heading">Record a new lot</h2>
      <form onSubmit={submit}>
        <div className="field-grid">
          <div className="field">
            <label htmlFor="lot-title">Title</label>
            <input id="lot-title" required maxLength={160} value={form.title}
              onChange={(event) => set("title", event.target.value)} />
            <label htmlFor="lot-category">Category</label>
            <select id="lot-category" value={form.category}
              onChange={(event) => set("category", event.target.value)}>
              {CATEGORY_SUGGESTIONS.map((option) => (
                <option key={option} value={option}>{option}</option>
              ))}
            </select>
            <label htmlFor="lot-material">Material type</label>
            <input id="lot-material" required maxLength={80} value={form.materialType}
              onChange={(event) => set("materialType", event.target.value)} />
            <label htmlFor="lot-unit">Unit</label>
            <select id="lot-unit" value={form.unit}
              onChange={(event) => set("unit", event.target.value as BiomassUnit)}>
              <option value="kg">kg</option>
              <option value="t">tonnes</option>
              <option value="m3">m³</option>
            </select>
          </div>
          <div className="field">
            <label htmlFor="lot-quantity">Quantity ({UNIT_LABELS[form.unit]})</label>
            <input id="lot-quantity" required inputMode="decimal" value={form.quantity}
              onChange={(event) => set("quantity", event.target.value)} />
            <label htmlFor="lot-storage">Storage location</label>
            <input id="lot-storage" required maxLength={200} value={form.storageLocation}
              onChange={(event) => set("storageLocation", event.target.value)} />
            <label htmlFor="lot-moisture">Moisture % (optional)</label>
            <input id="lot-moisture" inputMode="decimal" value={form.moisture}
              onChange={(event) => set("moisture", event.target.value)} />
            <label htmlFor="lot-harvest">Harvest date (optional)</label>
            <input id="lot-harvest" type="date" value={form.harvestDate}
              onChange={(event) => set("harvestDate", event.target.value)} />
          </div>
          <div className="field">
            <label htmlFor="lot-provenance">Source provenance (optional)</label>
            <input id="lot-provenance" maxLength={2000} value={form.provenance}
              onChange={(event) => set("provenance", event.target.value)} />
            <label htmlFor="lot-grade">Quality grade (optional)</label>
            <input id="lot-grade" maxLength={60} value={form.qualityGrade}
              onChange={(event) => set("qualityGrade", event.target.value)} />
            <label htmlFor="lot-permit">Permit reference (optional)</label>
            <input id="lot-permit" maxLength={200} value={form.permitReference}
              onChange={(event) => set("permitReference", event.target.value)} />
            <label htmlFor="lot-price">Reference price per unit (optional)</label>
            <input id="lot-price" inputMode="decimal" value={form.price}
              onChange={(event) => set("price", event.target.value)} />
          </div>
        </div>
        <ImageUploadField
          idPrefix="lot-images"
          files={images}
          onChange={setImages}
          disabled={busy}
          label="Upload Images"
        />
        {images.length === 0 ? (
          <p className="field-note">At least one image is required to record the lot.</p>
        ) : null}
        {error !== null ? (
          <p className="form-error" role="alert">{error}</p>
        ) : null}
        <div className="toolbar-actions">
          <button
            type="submit"
            className="btn btn--primary"
            disabled={busy || images.length === 0}
          >
            {busy ? "Saving…" : "Record lot"}
          </button>
          <button type="button" className="btn" onClick={props.onCancel}>Cancel</button>
        </div>
      </form>
    </section>
  );
}

// ==== selected lot manager ==================================================

interface AdjustmentState {
  kind: AdjustInput["kind"];
  quantity: string;
  newAvailable: string;
  reason: string;
}

const EMPTY_ADJUSTMENT: AdjustmentState = { kind: "addition", quantity: "", newAvailable: "", reason: "" };

function LotManager(props: {
  detail: LotDetailResponse;
  busy: boolean;
  reload: () => Promise<void>;
}) {
  const { lot, movements } = props.detail;
  const [adjustment, setAdjustment] = useState<AdjustmentState>(EMPTY_ADJUSTMENT);
  const [transfer, setTransfer] = useState({ recipient: "", quantity: "", note: "" });
  const [listing, setListing] = useState({
    title: "",
    quantity: "",
    price: "",
    fulfilment: "pickup",
    description: "",
  });
  const [listingImages, setListingImages] = useState<File[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [note, setNote] = useState<string | null>(null);
  const [busyLocal, setBusyLocal] = useState(false);

  const run = async (action: () => Promise<unknown>, success: string) => {
    if (props.busy || busyLocal) return;
    setBusyLocal(true);
    setError(null);
    setNote(null);
    try {
      await action();
      setNote(success);
      await props.reload();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusyLocal(false);
    }
  };

  const disabled = props.busy || busyLocal;

  return (
    <section className="card" aria-labelledby="lot-manage-heading">
      <h2 id="lot-manage-heading">Manage: {lot.title}</h2>
      <RecordGallery images={lot.images} title={lot.title} />
      <div className="stat-grid">
        <StatCard label="Available" value={`${formatDecimalQty(lot.quantity_available)} ${UNIT_LABELS[lot.unit]}`} />
        <StatCard label="Reserved" value={`${formatDecimalQty(lot.quantity_reserved)} ${UNIT_LABELS[lot.unit]}`} />
        <StatCard label="Sold" value={`${formatDecimalQty(lot.quantity_sold)} ${UNIT_LABELS[lot.unit]}`} />
        <StatCard label="Transferred out" value={`${formatDecimalQty(lot.quantity_transferred)} ${UNIT_LABELS[lot.unit]}`} />
        <StatCard label="Removed" value={`${formatDecimalQty(lot.quantity_removed)} ${UNIT_LABELS[lot.unit]}`} />
        <StatCard label="Total recorded" value={`${formatDecimalQty(lot.quantity_total)} ${UNIT_LABELS[lot.unit]}`} />
      </div>

      {error !== null ? <p className="form-error" role="alert">{error}</p> : null}
      {note !== null ? <p className="form-note" role="status">{note}</p> : null}

      <div className="manage-grid">
        <form
          className="manage-block"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                biomassApi.adjustLot(lot.id, {
                  kind: adjustment.kind,
                  quantity: adjustment.kind === "correction" ? undefined : adjustment.quantity,
                  new_available: adjustment.kind === "correction" ? adjustment.newAvailable : undefined,
                  reason: adjustment.reason,
                }),
              "Adjustment recorded as a stock movement.",
            );
          }}
        >
          <h3>Record adjustment</h3>
          <div className="field">
            <label htmlFor="adj-kind">Kind</label>
            <select
              id="adj-kind"
              value={adjustment.kind}
              onChange={(event) =>
                setAdjustment({ ...adjustment, kind: event.target.value as AdjustmentState["kind"] })
              }
            >
              <option value="addition">Addition</option>
              <option value="removal">Removal</option>
              <option value="correction">Correction (set exact available)</option>
            </select>
          </div>
          {adjustment.kind === "correction" ? (
            <div className="field">
              <label htmlFor="adj-new">Corrected available quantity</label>
              <input
                id="adj-new"
                required
                inputMode="decimal"
                value={adjustment.newAvailable}
                onChange={(event) => setAdjustment({ ...adjustment, newAvailable: event.target.value })}
              />
            </div>
          ) : (
            <div className="field">
              <label htmlFor="adj-quantity">Quantity</label>
              <input
                id="adj-quantity"
                required
                inputMode="decimal"
                value={adjustment.quantity}
                onChange={(event) => setAdjustment({ ...adjustment, quantity: event.target.value })}
              />
            </div>
          )}
          <div className="field">
            <label htmlFor="adj-reason">Reason (required, recorded)</label>
            <input
              id="adj-reason"
              required
              maxLength={500}
              value={adjustment.reason}
              onChange={(event) => setAdjustment({ ...adjustment, reason: event.target.value })}
            />
          </div>
          <button
            type="submit"
            className="btn btn--primary"
            disabled={
              disabled ||
              adjustment.reason.trim() === "" ||
              (adjustment.kind === "correction"
                ? adjustment.newAvailable.trim() === ""
                : adjustment.quantity.trim() === "")
            }
          >
            Record adjustment
          </button>
        </form>

        <form
          className="manage-block"
          onSubmit={(event) => {
            event.preventDefault();
            void run(
              () =>
                biomassApi.transferLot(lot.id, {
                  recipient_email: transfer.recipient,
                  quantity: transfer.quantity,
                  note: transfer.note === "" ? null : transfer.note,
                }),
              "Transfer recorded; the recipient holds a new lot with full provenance.",
            );
          }}
        >
          <h3>Transfer stock</h3>
          <div className="field">
            <label htmlFor="tr-email">Recipient email</label>
            <input
              id="tr-email"
              type="email"
              required
              value={transfer.recipient}
              onChange={(event) => setTransfer({ ...transfer, recipient: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="tr-quantity">Quantity ({UNIT_LABELS[lot.unit]})</label>
            <input
              id="tr-quantity"
              required
              inputMode="decimal"
              value={transfer.quantity}
              onChange={(event) => setTransfer({ ...transfer, quantity: event.target.value })}
            />
          </div>
          <div className="field">
            <label htmlFor="tr-note">Note (optional)</label>
            <input
              id="tr-note"
              maxLength={500}
              value={transfer.note}
              onChange={(event) => setTransfer({ ...transfer, note: event.target.value })}
            />
          </div>
          <button type="submit" className="btn" disabled={disabled}>
            Transfer
          </button>
        </form>

        {lot.status === "active" ? (
          <form
            className="manage-block"
            onSubmit={(event) => {
              event.preventDefault();
              // A listing carries its OWN 1–5 compulsory images.
              const countProblem = imageCountError(listingImages.length);
              if (countProblem !== null) {
                setError(countProblem);
                return;
              }
              void run(
                () =>
                  biomassApi.createListing(
                    {
                      lot_id: lot.id,
                      title: listing.title,
                      description: listing.description === "" ? null : listing.description,
                      quantity: listing.quantity,
                      price_per_unit: listing.price,
                      fulfilment: listing.fulfilment as "pickup" | "delivery" | "negotiable",
                      publish_now: true,
                    },
                    listingImages,
                  ),
                "Listing published on the marketplace.",
              );
            }}
          >
            <h3>List on marketplace</h3>
            <div className="field">
              <label htmlFor="li-title">Listing title</label>
              <input
                id="li-title"
                required
                maxLength={160}
                value={listing.title}
                onChange={(event) => setListing({ ...listing, title: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="li-quantity">Offered quantity (max {formatDecimalQty(lot.quantity_available)})</label>
              <input
                id="li-quantity"
                required
                inputMode="decimal"
                value={listing.quantity}
                onChange={(event) => setListing({ ...listing, quantity: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="li-price">Price per {UNIT_LABELS[lot.unit]}</label>
              <input
                id="li-price"
                required
                inputMode="decimal"
                value={listing.price}
                onChange={(event) => setListing({ ...listing, price: event.target.value })}
              />
            </div>
            <div className="field">
              <label htmlFor="li-fulfilment">Fulfilment</label>
              <select
                id="li-fulfilment"
                value={listing.fulfilment}
                onChange={(event) => setListing({ ...listing, fulfilment: event.target.value })}
              >
                <option value="pickup">Pickup</option>
                <option value="delivery">Delivery</option>
                <option value="negotiable">Negotiable</option>
              </select>
            </div>
            <div className="field">
              <label htmlFor="li-description">Description (optional)</label>
              <input
                id="li-description"
                maxLength={2000}
                value={listing.description}
                onChange={(event) => setListing({ ...listing, description: event.target.value })}
              />
            </div>
            <ImageUploadField
              idPrefix="listing-images"
              files={listingImages}
              onChange={setListingImages}
              disabled={disabled}
              label="Upload Images"
            />
            <button
              type="submit"
              className="btn btn--primary"
              disabled={disabled || listingImages.length === 0}
            >
              Publish listing
            </button>
          </form>
        ) : (
          <div className="manage-block">
            <h3>Marketplace</h3>
            <p className="page-placeholder-note">
              Archived lots cannot be listed on the marketplace.
            </p>
          </div>
        )}
      </div>

      <h3>Stock movement history</h3>
      {movements.length === 0 ? (
        <p className="page-placeholder-note">No movements recorded yet.</p>
      ) : (
        <div className="table-wrap">
          <table className="listing-table">
            <caption className="visually-hidden">Recorded stock movements, newest first</caption>
            <thead>
              <tr>
                <th scope="col">When</th>
                <th scope="col">Type</th>
                <th scope="col">Change</th>
                <th scope="col">Available after</th>
                <th scope="col">Reason</th>
              </tr>
            </thead>
            <tbody>
              {movements.map((movement) => (
                <tr key={movement.id}>
                  <td>{formatWhen(movement.created_at)}</td>
                  <td>{movement.movement_type}</td>
                  <td>
                    {movement.quantity_delta.startsWith("-")
                      ? formatDecimalQty(movement.quantity_delta)
                      : `+${formatDecimalQty(movement.quantity_delta)}`}
                  </td>
                  <td>{formatDecimalQty(movement.quantity_after)}</td>
                  <td>{movement.reason ?? "—"}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
    </section>
  );
}
