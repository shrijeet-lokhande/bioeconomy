/**
 * Client-side validation mirroring the server rules (backend/src/backend/
 * schemas.py). The server remains authoritative — these checks exist to
 * give the user fast, field-level feedback without a round-trip.
 */

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 200;
export const NAME_MAX_LENGTH = 200;

export const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export interface ValidationError {
  readonly field: string;
  readonly message: string;
}

function cleanText(value: string): string {
  return value.trim();
}

/** Non-revealing and fast; the server re-validates every field. */
export function validateRegistrationInput(values: RegistrationFormValues): readonly ValidationError[] {
  const errors: ValidationError[] = [];

  const fullName = cleanText(values.fullName);
  if (fullName === "") {
    errors.push({ field: "fullName", message: "Full name is required." });
  } else if (fullName.length > NAME_MAX_LENGTH) {
    errors.push({
      field: "fullName",
      message: `Full name must be at most ${NAME_MAX_LENGTH} characters.`,
    });
  }

  const email = cleanText(values.email);
  if (email === "") {
    errors.push({ field: "email", message: "Email address is required." });
  } else if (email.length > 320 || !EMAIL_PATTERN.test(email)) {
    errors.push({ field: "email", message: "Enter a valid email address." });
  }

  const password = values.password;
  if (password.length < PASSWORD_MIN_LENGTH) {
    errors.push({
      field: "password",
      message: `Password must be at least ${PASSWORD_MIN_LENGTH} characters.`,
    });
  } else if (password.length > PASSWORD_MAX_LENGTH) {
    errors.push({
      field: "password",
      message: `Password must be at most ${PASSWORD_MAX_LENGTH} characters.`,
    });
  }

  if (values.confirmPassword !== password) {
    errors.push({
      field: "confirmPassword",
      message: "Passwords do not match.",
    });
  }

  return errors;
}

export function validateLoginInput(values: { email: string; password: string }): readonly ValidationError[] {
  const errors: ValidationError[] = [];
  if (cleanText(values.email) === "") {
    errors.push({ field: "email", message: "Email address is required." });
  }
  if (values.password === "") {
    errors.push({ field: "password", message: "Password is required." });
  }
  return errors;
}

export interface RegistrationFormValues {
  readonly fullName: string;
  readonly email: string;
  readonly password: string;
  readonly confirmPassword: string;
}

export function fieldErrors(errors: readonly ValidationError[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const error of errors) {
    if (!(error.field in map)) {
      map[error.field] = error.message;
    }
  }
  return map;
}
