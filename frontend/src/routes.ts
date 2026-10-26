/**
 * Route registry for the prototype.
 *
 * Navigation is intentionally dependency-free hash routing; the Overview,
 * Biomass Inventory, Marketplace, Admin console, and auth pages are real.
 * Re-evaluate when more sections become real; replacing this with a proper
 * router (and history URLs) must be an explicit decision.
 */

export type RouteId =
  | "overview"
  | "biomass-inventory"
  | "marketplace"
  | "map-explorer"
  | "analytics"
  | "settings"
  | "admin"
  | "login"
  | "register"
  | "verify-email"
  | "verification-pending";

export type RouteStatus = "prototype" | "planned";

/** "public" routes are reachable without a session; everything else is protected. */
export type RouteAccess = "public" | "protected" | "auth";

export interface AppRoute {
  readonly id: RouteId;
  readonly label: string;
  /** In-app link target, e.g. "#/biomass-inventory". */
  readonly hash: string;
  readonly heading: string;
  /** One-line scope description shown on the placeholder page. */
  readonly description: string;
  readonly status: RouteStatus;
  /** Whether the entry appears in the primary navigation. */
  readonly showInNav: boolean;
  /** auth = redirects signed-in users away (login/register). */
  readonly access: RouteAccess;
  /** Where the work is scheduled, if the roadmap defines it. */
  readonly plannedIn?: string;
}

export const DEFAULT_ROUTE_ID: RouteId = "overview";

export const ROUTES: readonly AppRoute[] = [
  {
    id: "overview",
    label: "Overview",
    hash: "#/",
    heading: "Overview",
    description:
      "Functional dashboard summarising the local demo listing data.",
    status: "prototype",
    showInNav: true,
    access: "protected",
  },
  {
    id: "biomass-inventory",
    label: "Biomass Inventory",
    hash: "#/biomass-inventory",
    heading: "Biomass Inventory",
    description:
      "Real backend workflow: record stock with full movement history, " +
      "adjust quantities with auditable reasons, transfer to other users, " +
      "and publish lots on the marketplace.",
    status: "prototype",
    showInNav: true,
    access: "protected",
  },
  {
    id: "marketplace",
    label: "Marketplace",
    hash: "#/marketplace",
    heading: "Marketplace",
    description:
      "Browse listed biomass, request purchases with atomic stock " +
      "reservation, and manage your own listings, purchases, and sales " +
      "through the full transaction lifecycle.",
    status: "prototype",
    showInNav: true,
    access: "protected",
  },
  {
    id: "map-explorer",
    label: "Map Explorer",
    hash: "#/map-explorer",
    heading: "Map Explorer",
    description:
      "Placeholder. Geospatial datasets and map layers, with recorded source, " +
      "date, coverage, and limitations for each dataset shown.",
    status: "planned",
    showInNav: true,
    access: "protected",
    plannedIn: "Roadmap Phase 4",
  },
  {
    id: "analytics",
    label: "Analytics",
    hash: "#/analytics",
    heading: "Analytics",
    description:
      "Placeholder. Deterministic analytics over validated data, followed by " +
      "AI-assisted insights that disclose uncertainty.",
    status: "planned",
    showInNav: true,
    access: "protected",
    plannedIn: "Roadmap Phase 5",
  },
  {
    id: "settings",
    label: "Settings",
    hash: "#/settings",
    heading: "Settings",
    description:
      "Placeholder. Account preferences; the signed-in profile comes from " +
      "the real backend session.",
    status: "planned",
    showInNav: true,
    access: "protected",
    plannedIn: "Not scheduled yet (after Roadmap Phase 3)",
  },
  {
    id: "admin",
    label: "Admin",
    hash: "#/admin",
    heading: "Admin Panel",
    description:
      "Role-gated supervision: platform stats, user list with search, " +
      "account actions (activate, verify, sessions, roles). Server-enforced: " +
      "non-admin sessions receive a 403 admin_required response.",
    status: "prototype",
    // Deliberately NOT in the primary navigation: the panel is reachable
    // only by navigating to #/admin directly. The server still enforces
    // the role; hiding the link is a UX choice, not access control.
    showInNav: false,
    access: "protected",
  },
  {
    id: "login",
    label: "Sign in",
    hash: "#/login",
    heading: "Sign in",
    description: "Sign in to the Bioeconomy platform.",
    status: "prototype",
    showInNav: false,
    access: "auth",
  },
  {
    id: "register",
    label: "Create account",
    hash: "#/register",
    heading: "Create account",
    description: "Register a new Bioeconomy account.",
    status: "prototype",
    showInNav: false,
    access: "auth",
  },
  {
    id: "verify-email",
    label: "Email verification",
    hash: "#/verify-email",
    heading: "Email verification",
    description:
      "Consumes the token from a verification link; the token portion of "
      + "the URL is stripped as soon as it is read.",
    status: "prototype",
    showInNav: false,
    access: "public",
  },
  {
    id: "verification-pending",
    label: "Verification pending",
    hash: "#/verification-pending",
    heading: "Verification pending",
    description:
      "Explains that the account waits for email confirmation; offers the "
      + "resend action with a neutral, non-enumerating confirmation.",
    status: "prototype",
    showInNav: false,
    access: "public",
  },
] as const;

function parseHash(hash: string): RouteId | undefined {
  // Query portions (e.g. #/verify-email?token=…) are not part of routing.
  const path = hash.replace(/^#\/?/, "").split("?")[0].toLowerCase();
  return ROUTES.find((route) => route.hash.slice(1) === `/${path}`)?.id;
}

/** Resolve the current route from the browser URL, falling back to Overview. */
export function routeIdFromLocation(): RouteId {
  return parseHash(window.location.hash) ?? DEFAULT_ROUTE_ID;
}

export function findRoute(id: RouteId): AppRoute {
  return ROUTES.find((route) => route.id === id) ?? ROUTES[0];
}

export function navigationRoutes(): readonly AppRoute[] {
  return ROUTES.filter((route) => route.showInNav);
}
