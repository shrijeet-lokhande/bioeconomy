import { useState, type FormEvent } from "react";
import { useAuth } from "../auth/AuthContext";
import { fieldErrors, validateLoginInput } from "../auth/validation";
import { ApiRequestError, VERIFICATION_REQUIRED_CODE } from "../lib/api";
import { setPendingVerification } from "../auth/pendingEmail";

/**
 * Sign-in page. Errors are deliberately non-revealing: the backend returns
 * one generic message for unknown email and wrong password. An unverified
 * account produces the structured `email_verification_required` code and
 * routes to the verification-pending screen instead of showing an error.
 */
export function LoginPage() {
  const { login } = useAuth();
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const validation = validateLoginInput({ email, password });
    if (validation.length > 0) {
      setErrors(fieldErrors(validation));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      await login({ email: email.trim().toLowerCase(), password });
      // AuthProvider updates global state; App then renders the dashboard.
    } catch (error) {
      if (error instanceof ApiRequestError) {
        if (error.code === VERIFICATION_REQUIRED_CODE) {
          setPendingVerification(email.trim().toLowerCase(), null);
          window.location.hash = "#/verification-pending";
          setSubmitting(false);
          return;
        }
        setFormError(error.message);
      } else {
        setFormError("Sign-in failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <article className="page auth-page">
      <div className="auth-card">
        <header className="auth-header">
          <h1>Sign in</h1>
          <p>Use your Bioeconomy account to access the dashboard.</p>
        </header>

        {formError ? (
          <p className="form-error" role="alert">
            {formError}
          </p>
        ) : null}

        <form onSubmit={handleSubmit} noValidate aria-busy={submitting}>
          <div className="field">
            <label htmlFor="login-email">Email address</label>
            <input
              id="login-email"
              type="email"
              autoComplete="email"
              value={email}
              onChange={(event) => setEmail(event.target.value)}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={errors.email ? "login-email-error" : undefined}
            />
            {errors.email ? (
              <p className="field-error" id="login-email-error" role="alert">
                {errors.email}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="login-password">Password</label>
            <input
              id="login-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              aria-invalid={Boolean(errors.password)}
              aria-describedby={
                errors.password ? "login-password-error" : undefined
              }
            />
            {errors.password ? (
              <p className="field-error" id="login-password-error" role="alert">
                {errors.password}
              </p>
            ) : null}
          </div>

          <p className="auth-switch"><a href="#/forgot-password">Forgot password?</a></p>

          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? "Signing in…" : "Sign in"}
          </button>
        </form>

        <p className="auth-switch">
          No account yet? <a href="#/register">Create one</a>.
        </p>
      </div>
    </article>
  );
}
