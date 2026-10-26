import type { ReactNode } from "react";
import { Badge } from "./ui/Badge";
import { useAuth } from "../auth/AuthContext";
import { ROUTES, type AppRoute } from "../routes";

const PROTOTYPE_NOTE =
  "Bioeconomy platform prototype — the account system, biomass inventory, " +
  "marketplace workflows, and admin console run on the real backend. " +
  "Server-enforced roles, recorded stock movements, and honest labelling " +
  "where data is not verified.";

export interface AppShellProps {
  activeRoute: AppRoute;
  children: ReactNode;
}

/**
 * Application shell: header (with user menu), primary navigation, main
 * content, and footer. Responsive without JavaScript — layout rules live
 * in index.css.
 */
export function AppShell({ activeRoute, children }: AppShellProps) {
  const { user, logout } = useAuth();
  const navRoutes = ROUTES.filter((route) => route.showInNav);
  // The header Admin badge is informational only: the Admin panel is not
  // in the navigation (it is reachable by entering #/admin directly), and
  // the server enforces the role for real (403 admin_required).
  const isAdmin = user?.role === "admin";

  return (
    <div className="app-shell">
      <a className="skip-link" href="#main-content">
        Skip to main content
      </a>

      <header className="app-header">
        <a className="brand" href="#/">
          <span className="brand-mark" aria-hidden="true">
            🌿
          </span>
          <span className="brand-name">Bioeconomy</span>
        </a>
        <div className="header-actions">
          <Badge tone="prototype">Demo prototype</Badge>
          {user !== null ? (
            <div className="user-menu">
              <span className="user-menu-info">
                <span className="user-menu-name">{user.full_name}</span>
                <span className="user-menu-email">{user.email}</span>
              </span>
              {isAdmin ? <Badge tone="positive">Admin</Badge> : null}
              <button
                type="button"
                className="btn btn--small header-logout"
                onClick={() => {
                  void logout().then(() => {
                    window.location.hash = "#/login";
                  });
                }}
              >
                Log out
              </button>
            </div>
          ) : null}
        </div>
      </header>

      <nav className="app-nav" aria-label="Primary">
        <ul className="app-nav-list">
          {/*
            Links are plain anchors; routing is handled by the hash listener
            in App. aria-current marks the active section for screen readers.
          */}
          {navRoutes.map((route) => (
            <li key={route.id}>
              <a
                href={route.hash}
                aria-current={route.id === activeRoute.id ? "page" : undefined}
              >
                {route.label}
              </a>
            </li>
          ))}
        </ul>
      </nav>

      <main id="main-content" className="app-main">
        {children}
      </main>

      <footer className="app-footer">
        <p>{PROTOTYPE_NOTE}</p>
      </footer>
    </div>
  );
}
