import { useState, type FormEvent } from "react";
import { authApi, ApiRequestError } from "../lib/api";

export function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [error, setError] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    const normalized = email.trim().toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)) { setError("Enter a valid email address."); return; }
    setBusy(true);
    try { await authApi.forgotPassword(normalized); setSent(true); }
    catch (e) { setError(e instanceof ApiRequestError ? e.message : "Request failed. Please try again."); }
    finally { setBusy(false); }
  }
  return <article className="page auth-page"><div className="auth-card">
    <header className="auth-header"><h1>Forgot password?</h1><p>Enter the email address on your account.</p></header>
    {sent ? <p role="status">If an account exists for that email address, reset instructions may be sent. If you don’t receive an email, check spam or request another link later.</p> : <>
      {error && <p className="form-error" role="alert">{error}</p>}
      <form onSubmit={submit} noValidate aria-busy={busy}><div className="field"><label htmlFor="forgot-email">Email address</label>
        <input id="forgot-email" type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} aria-invalid={Boolean(error)} />
      </div><button className="btn btn--primary" disabled={busy}>{busy ? "Sending…" : "Send reset link"}</button></form>
    </>}
    <p className="auth-switch"><a href="#/login">Back to sign in</a></p>
  </div></article>;
}
