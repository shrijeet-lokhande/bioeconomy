import { useMemo, useState } from "react";
import { createListingStore } from "../data/listingStore";
import { applyFilters, DEFAULT_FILTER, type ListingFilter } from "../domain/filters";
import { formatQuantity } from "../domain/quantities";
import {
  STATUS_LABELS,
  type BiomassListing,
  type BiomassStatus,
  type ListingInput,
} from "../domain/types";
import { DemoBanner } from "../components/DemoBanner";
import { ListingForm } from "../components/ListingForm";
import { Badge } from "../components/ui/Badge";
import { formatUpdatedAt, statusBadge } from "../lib/presentation";

const SORT_OPTIONS: readonly { value: NonNullable<ListingFilter["sort"]> | "recent"; label: string }[] = [
  { value: "recent", label: "Newest first" },
  { value: "title", label: "Title A–Z" },
  { value: "quantity-desc", label: "Largest known quantity" },
];

interface FormState {
  readonly open: boolean;
  readonly editing: Readonly<BiomassListing> | null;
}

const CLOSED: FormState = { open: false, editing: null };

/**
 * Demo biomass listing workflow: search, filter, sort, create, edit, and
 * delete listings. The store persists only to this browser's localStorage
 * and every record is provenance "demo" — this is not a backend service.
 */
export function BiomassInventoryPage() {
  const [store] = useState(() => createListingStore());
  const [listings, setListings] = useState<readonly BiomassListing[]>(() =>
    store.getAll(),
  );
  const [filter, setFilter] = useState<ListingFilter>(DEFAULT_FILTER);
  const [form, setForm] = useState<FormState>(CLOSED);

  const refresh = () => setListings(store.getAll());
  const visible = useMemo(
    () => applyFilters(listings, filter),
    [listings, filter],
  );

  const handleSubmit = (input: ListingInput) => {
    if (form.editing) {
      store.update(form.editing.id, input);
    } else {
      store.create(input);
    }
    refresh();
    setForm(CLOSED);
  };

  const handleDelete = (listing: BiomassListing) => {
    const confirmed = window.confirm(
      `Remove the demo listing "${listing.title}"? ` +
        "This only removes local demo data in this browser.",
    );
    if (!confirmed) return;
    store.remove(listing.id);
    refresh();
    if (form.editing?.id === listing.id) setForm(CLOSED);
  };

  const handleReset = () => {
    const confirmed = window.confirm(
      "Reset the demo listings to the original seed data? " +
        "Any locally stored changes will be discarded.",
    );
    if (!confirmed) return;
    store.resetToDemoSeed();
    refresh();
    setForm(CLOSED);
  };

  return (
    <article className="page">
      <header className="page-header">
        <h1>Biomass Inventory</h1>
        <Badge tone="prototype">Demo workflow</Badge>
      </header>

      <DemoBanner message="These listings are fictional examples stored in this browser only. They are not real-world supply and cannot be verified here." />

      {form.open ? (
        <section className="card" aria-labelledby="listing-form-heading">
          <h2 id="listing-form-heading">
            {form.editing ? `Edit listing: ${form.editing.title}` : "New demo listing"}
          </h2>
          <ListingForm
            initial={form.editing}
            onSubmit={handleSubmit}
            onCancel={() => setForm(CLOSED)}
          />
        </section>
      ) : null}

      <section className="card" aria-labelledby="listings-heading">
        <h2 id="listings-heading">Listings</h2>

        <div className="toolbar">
          <div className="field">
            <label htmlFor="filter-query">Search</label>
            <input
              id="filter-query"
              type="search"
              value={filter.query}
              onChange={(event) =>
                setFilter({ ...filter, query: event.target.value })
              }
              placeholder="Title, type, or location"
            />
          </div>
          <div className="field">
            <label htmlFor="filter-status">Status</label>
            <select
              id="filter-status"
              value={filter.status}
              onChange={(event) =>
                setFilter({
                  ...filter,
                  status: event.target.value as BiomassStatus | "all",
                })
              }
            >
              <option value="all">All statuses</option>
              {(Object.keys(STATUS_LABELS) as BiomassStatus[]).map((status) => (
                <option key={status} value={status}>
                  {STATUS_LABELS[status]}
                </option>
              ))}
            </select>
          </div>
          <div className="field">
            <label htmlFor="filter-sort">Sort</label>
            <select
              id="filter-sort"
              value={filter.sort}
              onChange={(event) =>
                setFilter({
                  ...filter,
                  sort: event.target.value as ListingFilter["sort"],
                })
              }
            >
              {SORT_OPTIONS.map((option) => (
                <option key={option.value} value={option.value}>
                  {option.label}
                </option>
              ))}
            </select>
          </div>
          <div className="toolbar-actions">
            <button
              type="button"
              className="btn btn--primary"
              onClick={() => setForm({ open: true, editing: null })}
            >
              New demo listing
            </button>
            <button type="button" className="btn" onClick={handleReset}>
              Reset demo seed
            </button>
          </div>
        </div>

        <p className="result-count" aria-live="polite">
          Showing {visible.length} of {listings.length} demo listings
          {filter.query.trim() !== "" ? ` for "${filter.query.trim()}"` : ""}.
        </p>

        {visible.length === 0 ? (
          <div className="empty-state">
            <p>No demo listings match the current filters.</p>
            <button
              type="button"
              className="btn"
              onClick={() => setFilter({ ...DEFAULT_FILTER })}
            >
              Clear filters
            </button>
          </div>
        ) : (
          <div className="table-wrap">
            <table className="listing-table">
              <caption className="visually-hidden">
                Demo biomass listings; every row is local demo data
              </caption>
              <thead>
                <tr>
                  <th scope="col">Title</th>
                  <th scope="col">Type</th>
                  <th scope="col">Quantity</th>
                  <th scope="col">Location</th>
                  <th scope="col">Status</th>
                  <th scope="col">Updated</th>
                  <th scope="col">Actions</th>
                </tr>
              </thead>
              <tbody>
                {visible.map((listing) => {
                  const badge = statusBadge(listing.status);
                  return (
                    <tr key={listing.id}>
                      <th scope="row">{listing.title}</th>
                      <td>{listing.biomassType}</td>
                      <td>
                        {formatQuantity(
                          listing.quantityValue,
                          listing.quantityUnit,
                        )}
                      </td>
                      <td>{listing.location}</td>
                      <td>
                        <Badge tone={badge.tone}>{badge.label}</Badge>
                      </td>
                      <td>{formatUpdatedAt(listing.updatedAt)}</td>
                      <td className="cell-actions">
                        <button
                          type="button"
                          className="btn btn--small"
                          onClick={() => setForm({ open: true, editing: listing })}
                        >
                          Edit
                        </button>
                        <button
                          type="button"
                          className="btn btn--small btn--danger"
                          onClick={() => handleDelete(listing)}
                        >
                          Delete
                        </button>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </article>
  );
}
