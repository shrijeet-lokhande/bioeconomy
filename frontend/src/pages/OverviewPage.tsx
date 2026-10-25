import { useMemo, useState } from "react";
import { createListingStore } from "../data/listingStore";
import { formatNumber, formatQuantity } from "../domain/quantities";
import { summarize } from "../domain/summary";
import type { BiomassListing } from "../domain/types";
import { DemoBanner } from "../components/DemoBanner";
import { StatCard } from "../components/ui/StatCard";
import { Badge } from "../components/ui/Badge";
import { statusBadge } from "../lib/presentation";

const DASHBOARD_BANNER =
  "Every figure below summarizes fictional demo listings stored only in this " +
  "browser. They do not represent real-world supply, availability, or land data.";

/**
 * First functional dashboard. All numbers are computed from the local demo
 * listing store with tested, deterministic logic — nothing is invented here,
 * and unknown quantities are never treated as zero.
 */
export function OverviewPage() {
  const [listings] = useState<readonly BiomassListing[]>(() =>
    createListingStore().getAll(),
  );

  const summary = useMemo(() => summarize(listings), [listings]);
  const recent = useMemo(
    () =>
      [...listings]
        .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
        .slice(0, 3),
    [listings],
  );

  return (
    <article className="page">
      <header className="page-header">
        <h1>Overview</h1>
        <Badge tone="prototype">Demo dashboard</Badge>
      </header>

      <DemoBanner message={DASHBOARD_BANNER} />

      <section aria-labelledby="dashboard-stats-heading">
        <h2 id="dashboard-stats-heading">Demo listing summary</h2>
        <div className="stat-grid">
          <StatCard
            label="Demo listings"
            value={String(summary.total)}
            hint="Records in the local demo store"
          />
          <StatCard
            label="Available"
            value={String(summary.byStatus.available)}
          />
          <StatCard
            label="Reserved"
            value={String(summary.byStatus.reserved)}
          />
          <StatCard
            label="Known mass (kg equivalent)"
            value={`${formatNumber(summary.knownMassKg)} kg`}
            hint="Sum of known kg/t quantities only — m³ and unknown quantities are excluded, not counted as zero"
          />
          <StatCard
            label="Unknown quantity"
            value={String(summary.unknownQuantity)}
            hint="Explicitly unknown, kept out of totals"
          />
          <StatCard
            label="Volume-only (m³)"
            value={String(summary.volumeOnlyQuantity)}
            hint="No mass conversion defined for these records"
          />
        </div>
      </section>

      <section className="card" aria-labelledby="recent-heading">
        <h2 id="recent-heading">Most recently updated</h2>
        {recent.length === 0 ? (
          <p>No demo listings yet — open the Biomass Inventory to create one.</p>
        ) : (
          <ul className="recent-list">
            {recent.map((listing) => {
              const badge = statusBadge(listing.status);
              return (
                <li key={listing.id}>
                  <span className="recent-title">{listing.title}</span>
                  <span className="recent-quantity">
                    {formatQuantity(listing.quantityValue, listing.quantityUnit)}
                  </span>
                  <Badge tone={badge.tone}>{badge.label}</Badge>
                </li>
              );
            })}
          </ul>
        )}
        <p>
          <a href="#/biomass-inventory">Open the Biomass Inventory workflow →</a>
        </p>
      </section>

      <section className="card" aria-labelledby="about-data-heading">
        <h2 id="about-data-heading">How this prototype handles data</h2>
        <ul>
          <li>
            <strong>No backend connection.</strong> Demo records are kept in
            this browser's local storage; nothing is sent anywhere.
          </li>
          <li>
            <strong>All records are labelled.</strong> Each demo listing
            carries a "demo" provenance marker, and banners state the
            limitation next to every screen.
          </li>
          <li>
            <strong>Unknown ≠ zero.</strong> Listings without a known quantity
            are excluded from mass totals and counted separately.
          </li>
          <li>
            <strong>Planned next:</strong> a real backend API and database
            (Roadmap Phase 2) will replace the demo store behind the same
            interface.
          </li>
        </ul>
      </section>
    </article>
  );
}
