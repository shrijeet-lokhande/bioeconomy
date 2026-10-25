import type { ReactNode } from "react";

const DEFAULT_MESSAGE =
  "All records and figures in this section are hard-coded demo data used " +
  "to exercise the interface. They do not represent real-world supply, " +
  "availability, or measurements.";

export interface DemoBannerProps {
  message?: string;
  children?: ReactNode;
}

/**
 * Persistent provenance banner. Demo data must never be shown without this
 * labelling, per docs/PRODUCT_SPEC.md and docs/DECISIONS.md (empty — follow
 * PRODUCT_SPEC "never represent demo listings as real supply").
 */
export function DemoBanner({ message, children }: DemoBannerProps) {
  return (
    <aside className="demo-banner" role="note">
      <p>
        <strong>Demo data.</strong> {message ?? DEFAULT_MESSAGE}
      </p>
      {children}
    </aside>
  );
}
