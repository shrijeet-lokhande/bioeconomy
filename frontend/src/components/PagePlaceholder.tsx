import { Badge } from "./ui/Badge";
import type { AppRoute } from "../routes";

export interface PagePlaceholderProps {
  route: AppRoute;
}

/**
 * Shared placeholder for sections whose implementation is scheduled later.
 * States clearly that nothing is behind the navigation entry yet.
 */
export function PagePlaceholder({ route }: PagePlaceholderProps) {
  return (
    <article className="page">
      <header className="page-header">
        <h1>{route.heading}</h1>
        <Badge tone="planned">Planned — not started</Badge>
      </header>
      <p>{route.description}</p>
      <p>
        {route.plannedIn
          ? `Scheduled under: ${route.plannedIn}.`
          : "No implementation slot has been agreed yet."}
      </p>
      <p className="page-placeholder-note">
        This page contains no data or workflows. Navigation exists to complete
        the application shell only.
      </p>
    </article>
  );
}
