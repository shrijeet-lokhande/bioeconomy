import { useState } from "react";
import { authApi, ApiRequestError } from "../lib/api";
import { readPendingVerification, type PendingDelivery } from "../auth/pendingEmail";

interface ResendResult {
  state: "idle" | "sending" | "sent" | "error";
  message: string | null;
}

/**
 * Verification-pending screen, shown after registration and when sign-in is
 * blocked because the account is not verified yet.
 *
 * Honesty rules:
 * - We never claim an email was sent unless the backend accepted it.
 * - The resend confirmation is neutral: identical whether or not the
 *   address belongs to an account (no enumeration via this screen).
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
        state: "sent",
        message:
          "If this address has an account awaiting verification, "
          + "a new verification email has been sent.",
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
          <p className="form-success" role="status">
            A verification email was sent to {email}. Open the link in that
            email to finish setting up your account.
          </p>
        ) : null}

        {deliveryNote !== null ? (
          <p className="form-error" role="alert">
            {deliveryNote}
          </p>
        ) : null}

        {resend.message !== null ? (
          <p
            className={resend.state === "error" ? "form-error" : "form-success"}
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
