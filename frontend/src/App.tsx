import { useEffect, useState, type ReactNode } from "react";
import { AppShell } from "./components/AppShell";
import { PagePlaceholder } from "./components/PagePlaceholder";
import { OverviewPage } from "./pages/OverviewPage";
import { LoginPage } from "./pages/LoginPage";
import { RegisterPage } from "./pages/RegisterPage";
import { VerificationPendingPage } from "./pages/VerificationPendingPage";
import { VerifyEmailPage } from "./pages/VerifyEmailPage";
import { AdminPage } from "./pages/AdminPage";
import { useAuth } from "./auth/AuthContext";
import {
  findRoute,
  routeIdFromLocation,
  type RouteId,
} from "./routes";

function renderPage(routeId: RouteId): ReactNode {
  switch (routeId) {
    case "overview":
      return <OverviewPage />;
    case "login":
      return <LoginPage />;
    case "register":
      return <RegisterPage />;
    case "verify-email":
      return <VerifyEmailPage />;
    case "verification-pending":
      return <VerificationPendingPage />;
    case "admin":
      return <AdminPage />;
    default:
      return <PagePlaceholder route={findRoute(routeId)} />;
  }
}

function CheckingSession() {
  return (
    <div className="auth-loading" role="status" aria-live="polite">
      <p>Checking your session…</p>
    </div>
  );
}

/**
 * Route gating:
 * - While the session is being restored, nothing app-specific renders —
 *   protected content never flash-renders unauthenticated.
 * - Protected routes require a user; unauthenticated access shows the
 *   sign-in page instead of the requested content.
 * - Login/register screens redirect signed-in users to the dashboard.
 */
export default function App() {
  const { status, user } = useAuth();
  const [routeId, setRouteId] = useState<RouteId>(() => routeIdFromLocation());

  useEffect(() => {
    const onHashChange = () => setRouteId(routeIdFromLocation());
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);

  const route = findRoute(routeId);
  const signedIn = status === "ready" && user !== null;

  // Signed-in users hitting login/register or the default hash redirect.
  useEffect(() => {
    if (status === "ready" && signedIn && route.access === "auth") {
      window.location.hash = "#/";
    }
  }, [status, signedIn, route]);

  if (status === "loading") {
    return <CheckingSession />;
  }

  if (signedIn && route.access === "auth") {
    const overview = findRoute("overview");
    return (
      <AppShell activeRoute={overview}>
        <OverviewPage />
      </AppShell>
    );
  }

  // Protected routes: unauthenticated users see the sign-in screen only.
  if (!signedIn && route.access === "protected") {
    return (
      <AppShell activeRoute={findRoute("login")}>
        <LoginPage />
      </AppShell>
    );
  }

  return <AppShell activeRoute={route}>{renderPage(routeId)}</AppShell>;
}
