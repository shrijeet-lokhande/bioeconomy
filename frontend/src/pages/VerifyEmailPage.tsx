import { useEffect, useRef, useState } from "react";
import { ApiRequestError, authApi } from "../lib/api";
import { clearPendingVerification } from "../auth/pendingEmail";

type VerifyState =
  | { kind: "loading" }
  | { kind: "success" }
  | { kind: "rejected"; message: string };

type VerifyOutcome = { ok: true } | { ok: false; serverReached: boolean };

/**
 * Verifies the email via the token inside the verification link.
 *
 * URL contract: #/verify-email?token=<raw token>  (hash-router query).
 * The token is read ONCE and stripped from the visible URL immediately
 * (history.replaceState), so it does not linger in the address bar, browser
 * history, or screen shares. Tokens are never written to storage.
 *
 * React StrictMode (dev) invokes effects mount→cleanup→mount. The refs
 * below make that double invocation safe: the second run reuses the token
 * read by the first run (the URL is already stripped) and attaches to the
 * SAME in-flight request instead of issuing a second POST — the token is
 * single-use, so a duplicate request would corrupt the flow.
 */
const TOKEN_PATTERN = /token=([A-Za-z0-9_\-]+)/;

export function VerifyEmailPage() {
  const [state, setState] = useState<VerifyState>({ kind: "loading" });
  const tokenReadRef = useRef<string | null>(null);
  const verifyPromiseRef = useRef<Promise<VerifyOutcome> | null>(null);

  useEffect(() => {
    // 1. Obtain the token: live from the URL on the first run; from the
    //    earlier read on StrictMode's second run (URL already stripped).
    const hash = window.location.hash;
    const match = TOKEN_PATTERN.exec(hash);
    if (match) {
      window.history.replaceState(
        null,
        "",
        window.location.pathname + hash.replace(/\?token=[^&]*$/, ""),
      );
      tokenReadRef.current = match[1];
    }
    const token = match?.[1] ?? tokenReadRef.current;

    if (token === null) {
      setState({
        kind: "rejected",
        message:
          "This verification link is malformed. Please request a new "
          + "verification email from the sign-in screen.",
      });
      return;
    }

    // 2. Exactly one POST per token, shared across StrictMode's two runs.
    if (verifyPromiseRef.current === null) {
      // The promise never rejects; failures are mapped into the outcome so
      // every effect run can attach safely.
      verifyPromiseRef.current = authApi
        .verifyEmail(token)
        .then(() => {
          clearPendingVerification();
          return { ok: true } as VerifyOutcome;
        })
        .catch((error: unknown) => ({
          ok: false,
          // Network-level failures get a different message than explicit
          // rejections from the backend (invalid/expired/used token).
          serverReached: error instanceof ApiRequestError,
        }) satisfies VerifyOutcome);
    }

    // 3. Attach with this run's own cancellation flag.
    let cancelled = false;
    verifyPromiseRef.current.then((outcome) => {
      if (cancelled) {
        return;
      }
      if (outcome.ok) {
        setState({ kind: "success" });
      } else {
        setState({
          kind: "rejected",
          message: outcome.serverReached
            ? "This verification link is invalid or has expired. "
              + "Please request a new verification email."
            : "Could not reach the server. Please try again later.",
        });
      }
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return (
    <article className="page auth-page">
      <div className="auth-card">
        <header className="auth-header">
          <h1>Email verification</h1>
        </header>

        {state.kind === "loading" ? (
          <p role="status" aria-live="polite">
            Checking your verification link…
          </p>
        ) : null}

        {state.kind === "success" ? (
          <>
            <p className="form-success" role="status">
              Your email address is verified. You can sign in now.
            </p>
            <p>
              <a className="btn btn--primary" href="#/login">
                Go to sign in
              </a>
            </p>
          </>
        ) : null}

        {state.kind === "rejected" ? (
          <>
            <p className="form-error" role="alert">
              {state.message}
            </p>
            <p>
              <a className="btn btn--primary" href="#/verification-pending">
                Request a new verification email
              </a>
              {" "}
              <a className="btn" href="#/login">
                Back to sign in
              </a>
            </p>
          </>
        ) : null}
      </div>
    </article>
  );
}
