import { useState, type FormEvent } from "react";
import {
  fieldErrors,
  validateRegistrationInput,
  type RegistrationFormValues,
} from "../auth/validation";
import { ApiRequestError, authApi } from "../lib/api";
import { setPendingVerification } from "../auth/pendingEmail";

/**
 * Registration page. On success the user is NOT signed in and CANNOT use
 * the platform yet: the dedicated verification-pending screen explains the
 * required next step. The email-delivery status from the backend is passed
 * along honestly — the UI never claims a message was sent when it was not.
 */
export function RegisterPage() {
  const [values, setValues] = useState<RegistrationFormValues>({
    fullName: "",
    email: "",
    password: "",
    confirmPassword: "",
  });
  const [errors, setErrors] = useState<Record<string, string>>({});
  const [formError, setFormError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  const setField = (field: keyof RegistrationFormValues, value: string) =>
    setValues((current) => ({ ...current, [field]: value }));

  const handleSubmit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setFormError(null);

    const validation = validateRegistrationInput(values);
    if (validation.length > 0) {
      setErrors(fieldErrors(validation));
      return;
    }
    setErrors({});
    setSubmitting(true);
    try {
      const created = await authApi.register({
        full_name: values.fullName.trim(),
        email: values.email.trim().toLowerCase(),
        password: values.password,
      });
      setPendingVerification(
        created.email,
        created.email_delivery === "failed" ? "failed" : "accepted",
      );
      // Route to the verification-pending screen (hash router picks up
      // the change through the hashchange listener).
      window.location.hash = "#/verification-pending";
    } catch (error) {
      if (error instanceof ApiRequestError) {
        setFormError(error.message);
      } else {
        setFormError("Registration failed. Please try again.");
      }
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <article className="page auth-page">
      <div className="auth-card">
        <header className="auth-header">
          <h1>Create account</h1>
          <p>
            Register to use the Bioeconomy dashboard. A verification email
            will need to be confirmed before your first sign-in. Fields
            marked * are required.
          </p>
        </header>

        {formError ? (
          <p className="form-error" role="alert">
            {formError}
          </p>
        ) : null}

        <form onSubmit={handleSubmit} noValidate aria-busy={submitting}>
          <div className="field">
            <label htmlFor="register-name">Full name *</label>
            <input
              id="register-name"
              autoComplete="name"
              maxLength={200}
              value={values.fullName}
              onChange={(event) => setField("fullName", event.target.value)}
              aria-invalid={Boolean(errors.fullName)}
              aria-describedby={
                errors.fullName ? "register-name-error" : undefined
              }
            />
            {errors.fullName ? (
              <p className="field-error" id="register-name-error" role="alert">
                {errors.fullName}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="register-email">Email address *</label>
            <input
              id="register-email"
              type="email"
              autoComplete="email"
              maxLength={320}
              value={values.email}
              onChange={(event) => setField("email", event.target.value)}
              aria-invalid={Boolean(errors.email)}
              aria-describedby={
                errors.email ? "register-email-error" : undefined
              }
            />
            {errors.email ? (
              <p className="field-error" id="register-email-error" role="alert">
                {errors.email}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="register-password">Password *</label>
            <input
              id="register-password"
              type="password"
              autoComplete="new-password"
              value={values.password}
              onChange={(event) => setField("password", event.target.value)}
              aria-invalid={Boolean(errors.password)}
              aria-describedby="register-password-hint"
            />
            <p className="field-hint" id="register-password-hint">
              At least 10 characters.
            </p>
            {errors.password ? (
              <p
                className="field-error"
                id="register-password-error"
                role="alert"
              >
                {errors.password}
              </p>
            ) : null}
          </div>

          <div className="field">
            <label htmlFor="register-confirm">Confirm password *</label>
            <input
              id="register-confirm"
              type="password"
              autoComplete="new-password"
              value={values.confirmPassword}
              onChange={(event) =>
                setField("confirmPassword", event.target.value)
              }
              aria-invalid={Boolean(errors.confirmPassword)}
              aria-describedby={
                errors.confirmPassword
                  ? "register-confirm-error"
                  : undefined
              }
            />
            {errors.confirmPassword ? (
              <p
                className="field-error"
                id="register-confirm-error"
                role="alert"
              >
                {errors.confirmPassword}
              </p>
            ) : null}
          </div>

          <button type="submit" className="btn btn--primary" disabled={submitting}>
            {submitting ? "Creating account…" : "Create account"}
          </button>
        </form>

        <p className="auth-switch">
          Already have an account? <a href="#/login">Sign in</a>.
        </p>
      </div>
    </article>
  );
}
