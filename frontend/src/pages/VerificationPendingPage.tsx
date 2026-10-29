import { useState } from "react";
import { authApi, ApiRequestError } from "../lib/api";
import { readPendingVerification, type PendingDelivery } from "../auth/pendingEmail";

interface ResendResult {
  state: "idle" | "sending" | "requested" | "error";
  message: string | null;
}

/**
 * Verification-pending screen, shown after registration and when sign-in is
 * blocked because the account is not verified yet.
 *
 * Registration reports provider acceptance. Resend stays neutral to prevent
 * account enumeration and does not claim that the provider delivered email.
 */
export function VerificationPendingPage() {
  const pending = readPendingVerification();
  const email = pending?.email ?? "";
  const registerDelivery: PendingDelivery | null = pending?.delivery ?? null;

  // Honest registration-time delivery hint; resend confirmations handle
  // everything after this point.
  const deliveryNote: string | null =
    registerDelivery === "failed"
      ? "The verification email could not be sent just now "
        + "(delivery problem at the mail provider). You can request a new one "
        + "below, or try again later."
      : registerDelivery === "unknown"
        ? "The mail provider did not confirm whether it accepted the request. "
          + "Check your inbox and spam folder first. If no email arrives, "
          + "request another link below; a resend replaces the previous link."
        : null;

  const [resend, setResend] = useState<ResendResult>({ state: "idle", message: null });

  if (email === "") {
    // Reached without a registration/pending context (e.g. direct link).
    return (
      <article className="page auth-page">
        <div className="auth-card">
          <header className="auth-header">
            <h1>Verify your email</h1>
          </header>
          <p className="auth-note">
            Open the verification link from your inbox, or sign in to see
            whether your account still needs verification.
          </p>
          <p>
            <a className="btn btn--primary" href="#/login">
              Go to sign in
            </a>
          </p>
        </div>
      </article>
    );
  }

  const onResend = async () => {
    if (resend.state === "sending") {
      return; // prevent repeat clicks while a request is pending
    }
    setResend({ state: "sending", message: null });
    try {
      const response = await authApi.resendVerification(email);
      // Neutral by design: identical text for any address.
      void response;
      setResend({
        state: "requested",
        message:
          "If this address has an account awaiting verification, "
          + "we have attempted to send a new verification email. "
          + "This message does not confirm delivery.",
      });
    } catch (error) {
      const message =
        error instanceof ApiRequestError && error.status === 429
          ? "Too many requests. Please wait a moment before trying again."
          : "Could not reach the server. Please try again later.";
      setResend({ state: "error", message });
    }
  };

  return (
    <article className="page auth-page">
      <div className="auth-card">
        <header className="auth-header">
          <h1>Verify your email</h1>
          <p>
            Your email address <strong>{email}</strong> must be confirmed
            before you can sign in.
          </p>
        </header>

        {registerDelivery === "accepted" ? (
          <p className="form-note" role="status">
            Resend accepted the verification email for processing to {email}.
            This does not confirm delivery. Check your inbox and spam folder
            for the verification link.
          </p>
        ) : null}

        {deliveryNote !== null ? (
          <p
            className={registerDelivery === "failed" ? "form-error" : "form-note"}
            role={registerDelivery === "failed" ? "alert" : "status"}
          >
            {deliveryNote}
          </p>
        ) : null}

        {resend.message !== null ? (
          <p
            className={resend.state === "error" ? "form-error" : "form-note"}
            role={resend.state === "error" ? "alert" : "status"}
          >
            {resend.message}
          </p>
        ) : null}

        <button
          type="button"
          className="btn btn--primary"
          onClick={() => {
            void onResend();
          }}
          disabled={resend.state === "sending"}
          aria-busy={resend.state === "sending"}
        >
          {resend.state === "sending" ? "Sending…" : "Resend verification email"}
        </button>

        <p className="auth-switch">
          Already verified? <a href="#/login">Sign in</a>.
        </p>
      </div>
    </article>
  );
}
