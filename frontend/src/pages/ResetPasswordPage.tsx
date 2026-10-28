import { useEffect, useState, type FormEvent } from "react";
import { PASSWORD_MAX_LENGTH, PASSWORD_MIN_LENGTH } from "../auth/validation";
import { ApiRequestError, authApi } from "../lib/api";

function readToken(): string {
  const query = window.location.hash.split("?")[1] ?? "";
  return new URLSearchParams(query).get("token") ?? "";
}

function stripTokenFromUrl(): void {
  window.history.replaceState(null, "", `${window.location.pathname}${window.location.search}#/reset-password`);
}

export function ResetPasswordPage() {
  const [token] = useState(readToken);
  const [password, setPassword] = useState("");
  const [confirmation, setConfirmation] = useState("");
  const [error, setError] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { stripTokenFromUrl(); }, []);
  async function submit(event: FormEvent) {
    event.preventDefault(); setError("");
    if (!token) { setError("This password reset link is invalid or has expired."); return; }
    if (password.length < PASSWORD_MIN_LENGTH || password.length > PASSWORD_MAX_LENGTH) { setError(`Password must be ${PASSWORD_MIN_LENGTH}–${PASSWORD_MAX_LENGTH} characters.`); return; }
    if (password !== confirmation) { setError("Passwords do not match."); return; }
    setBusy(true);
    try { await authApi.resetPassword(token, password); setDone(true); }
    catch (e) { setError(e instanceof ApiRequestError ? e.message : "This password reset link is invalid or has expired."); }
    finally { setBusy(false); }
  }
  return <article className="page auth-page"><div className="auth-card">
    <header className="auth-header"><h1>Choose a new password</h1><p>Use at least {PASSWORD_MIN_LENGTH} characters.</p></header>
    {done ? <><p role="status">Your password was updated. Sign in with your new password.</p><p className="auth-switch"><a href="#/login">Go to sign in</a></p></> : <>
      {error && <p className="form-error" role="alert">{error}</p>}
      <form onSubmit={submit} noValidate aria-busy={busy} autoComplete="new-password">
        <div className="field"><label htmlFor="reset-password">New password</label><input id="reset-password" type="password" autoComplete="new-password" maxLength={PASSWORD_MAX_LENGTH} value={password} onChange={e => setPassword(e.target.value)} /></div>
        <div className="field"><label htmlFor="reset-confirm">Confirm new password</label><input id="reset-confirm" type="password" autoComplete="new-password" maxLength={PASSWORD_MAX_LENGTH} value={confirmation} onChange={e => setConfirmation(e.target.value)} /></div>
        <button className="btn btn--primary" disabled={busy}>{busy ? "Updating…" : "Reset password"}</button>
      </form><p className="auth-switch"><a href="#/login">Back to sign in</a></p>
    </>}
  </div></article>;
}
