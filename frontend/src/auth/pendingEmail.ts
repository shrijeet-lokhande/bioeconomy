/**
 * Session-scoped state for the email-verification flow.
 *
 * Only the email address and the honest delivery status of the most recent
 * attempt are stored — NEVER verification tokens. sessionStorage is used so
 * the state does not survive the browser session (nothing lands in
 * localStorage and nothing leaks to analytics).
 */

const PENDING_EMAIL_KEY = "bioeconomy.pending-verification-email";
const PENDING_DELIVERY_KEY = "bioeconomy.pending-verification-delivery";

export type PendingDelivery = "accepted" | "failed";

export function setPendingVerification(
  email: string,
  delivery: PendingDelivery | null,
): void {
  try {
    sessionStorage.setItem(PENDING_EMAIL_KEY, email.toLowerCase());
    if (delivery === null) {
      sessionStorage.removeItem(PENDING_DELIVERY_KEY);
    } else {
      sessionStorage.setItem(PENDING_DELIVERY_KEY, delivery);
    }
  } catch {
    // storage unavailable (private mode) — the flow still works without
    // the convenience of remembering the address across screens.
  }
}

export function readPendingVerification(): {
  email: string;
  delivery: PendingDelivery | null;
} | null {
  try {
    const email = sessionStorage.getItem(PENDING_EMAIL_KEY);
    if (email === null) {
      return null;
    }
    const deliveryRaw = sessionStorage.getItem(PENDING_DELIVERY_KEY);
    const delivery: PendingDelivery | null =
      deliveryRaw === "failed" ? "failed" : deliveryRaw === "accepted" ? "accepted" : null;
    return { email, delivery };
  } catch {
    return null;
  }
}

export function clearPendingVerification(): void {
  try {
    sessionStorage.removeItem(PENDING_EMAIL_KEY);
    sessionStorage.removeItem(PENDING_DELIVERY_KEY);
  } catch {
    // ignore — same rationale as above
  }
}
