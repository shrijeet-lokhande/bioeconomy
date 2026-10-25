"""Email delivery for verification messages.

Design:
- Authentication business logic depends only on EmailSender; provider
  specifics live in the backend classes below.
- Backends (MAIL_BACKEND env): "console" (dev: writes .eml files to a
  clearly labeled, gitignored outbox), "smtp" (generic SMTP over
  STARTTLS/TLS), "resend" (Resend HTTP API).
- Failures raise EmailDeliveryError and are NEVER reported to callers as a
  successful send.
- Verification links are built ONLY from the configured APP_BASE_URL —
  never an untrusted request Host header.
- The raw token appears solely inside the emailed link; log lines and
  diagnostics contain recipient/subject and error descriptions only —
  never tokens or full URLs.
"""

import logging
import pathlib
import smtplib
import ssl
from dataclasses import dataclass
from datetime import datetime, timezone
from email import policy as email_policy
from email.message import EmailMessage as MIMEMessage

import httpx
from smtplib import SMTPAuthenticationError, SMTPException

from backend.config import get_settings, Settings

logger = logging.getLogger("backend.mailer")


class EmailDeliveryError(Exception):
    """Raised when the provider did not accept the message for delivery."""


@dataclass(frozen=True)
class OutgoingEmail:
    to_address: str
    subject: str
    text_body: str
    html_body: str


@dataclass(frozen=True)
class VerificationEmailContext:
    recipient: str
    full_name: str
    verification_url: str
    expires_in_minutes: int


def build_verification_email(
    context: VerificationEmailContext,
    settings: Settings | None = None,
) -> OutgoingEmail:
    """Renders the verification email. The link is built from the trusted
    configured base URL by the caller (who owns APP_BASE_URL). This function
    embeds it verbatim into the bodies."""
    name = context.full_name or "there"
    subject = "Verify your Bioeconomy email address"
    expiry_note = (
        f"This link expires in {context.expires_in_minutes} minutes and can be "
        "used only once. If it has expired, request a new email from the "
        "verification screen."
    )
    plain = (
        f"Hi {name},\n\n"
        "Please confirm your email address to activate your Bioeconomy "
        "account:\n\n"
        f"{context.verification_url}\n\n"
        f"{expiry_note}\n\n"
        "If you did not create a Bioeconomy account, you can safely ignore "
        "this email.\n\n"
        "— The Bioeconomy team\n"
    )
    html = (
        f"<p>Hi <strong>{name}</strong>,</p>"
        "<p>Please confirm your email address to activate your Bioeconomy "
        "account:</p>"
        f'<p><a href="{context.verification_url}">'
        "Verify my email address</a></p>"
        f"<p><small>{expiry_note}</small></p>"
        "<p>If you did not create a Bioeconomy account, you can safely "
        "ignore this email.</p>"
        "<p>— The Bioeconomy team</p>"
    )
    return OutgoingEmail(
        to_address=context.recipient,
        subject=subject,
        text_body=plain,
        html_body=html,
    )


def verification_url(base_url: str, raw_token: str) -> str:
    """Trusted-URL link builder. base_url must come from APP_BASE_URL."""
    return f"{base_url.rstrip('/')}/#/verify-email?token={raw_token}"


class EmailSender:
    """Interface implemented by every delivery backend."""

    def send(self, message: OutgoingEmail) -> None:
        raise NotImplementedError

    def describe(self) -> str:  # human-safe backend name for logging/responses
        raise NotImplementedError


class ConsoleEmailSender(EmailSender):
    """Development backend: writes clearly labeled .eml files into a
    gitignored outbox directory. Never used implicitly in production —
    MAIL_BACKEND=console is a deliberate, documented choice.

    Messages are written with a relaxed 998-char line policy so the
    verification URL is never quoted-printable-wrapped inside the outbox —
    copying the link straight from the .eml file therefore works. (Delivery
    backends use standard wrapping; mail clients decode it correctly.)"""

    def __init__(self, outbox_dir: str, from_address: str):
        self._path = pathlib.Path(outbox_dir)
        self._path.mkdir(parents=True, exist_ok=True)
        self._from = from_address
        self._policy = email_policy.SMTP.clone(max_line_length=998)

    def describe(self) -> str:
        return f"console ({self._path})"

    def send(self, message: OutgoingEmail) -> None:
        mime = MIMEMessage(policy=self._policy)
        mime["From"] = self._from
        mime["To"] = message.to_address
        mime["Subject"] = message.subject
        mime.set_content(message.text_body)
        mime.add_alternative(message.html_body, subtype="html")
        stamped = datetime.now(timezone.utc).strftime("%Y%m%d-%H%M%S-%f")
        target = self._path / f"{stamped}.eml"
        target.write_bytes(mime.as_bytes())
        logger.info(
            "MAIL[console] verification email written to outbox for %s "
            "(subject: %s)",
            message.to_address,
            message.subject,
        )


class SmtpEmailSender(EmailSender):
    """Generic SMTP client (e.g. Mailgun SMTP relay, self-hosted SMTP).

    Uses STARTTLS when MAIL_USE_TLS=1 with the standard encrypted-context
    policy; requires MAIL_HOST/MAIL_PORT/MAIL_USERNAME/MAIL_PASSWORD and
    MAIL_FROM_ADDRESS. Credentials come from environment only."""

    def __init__(self, settings: Settings):
        self._settings = settings

    def describe(self) -> str:
        return f"smtp ({self._settings.mail_host}:{self._settings.mail_port})"

    def send(self, message: OutgoingEmail) -> None:
        s = self._settings
        if not s.mail_host:
            raise EmailDeliveryError("SMTP backend configured without MAIL_HOST.")
        mime = MIMEMessage()
        mime["From"] = s.mail_from_address
        mime["To"] = message.to_address
        mime["Subject"] = message.subject
        mime.set_content(message.text_body)
        mime.add_alternative(message.html_body, subtype="html")
        try:
            with smtplib.SMTP(s.mail_host, s.mail_port, timeout=15) as server:
                if s.mail_use_tls:
                    # STARTTLS explicitly enforced for port 587-style relays.
                    server.ehlo()
                    if not server.has_extn("starttls"):
                        raise EmailDeliveryError(
                            "SMTP server does not support STARTTLS while "
                            "MAIL_USE_TLS=1."
                        )
                    server.starttls(context=ssl.create_default_context())
                    server.ehlo()
                if s.mail_username:
                    try:
                        server.login(s.mail_username, s.mail_password)
                    except SMTPAuthenticationError as exc:
                        raise EmailDeliveryError(
                            "SMTP authentication failed — check MAIL_USERNAME/"
                            "MAIL_PASSWORD."
                        ) from exc
                server.send_message(mime)
        except SMTPException as exc:
            logger.warning("SMTP delivery failed: %s", exc)
            raise EmailDeliveryError(f"SMTP delivery failed: {exc}") from exc


class ResendEmailSender(EmailSender):
    """Resend (https://resend.com) HTTP API backend.

    Behavior of the provider (documented, observed):
    - Accounts without a verified domain may send only to the account
      owner's own email address (HTTP 403, "testing" restriction).
    - The recommended start address for testing is onboarding@resend.dev.
    A rejection is surfaced as EmailDeliveryError — never as success."""

    API_URL = "https://api.resend.com/emails"

    def __init__(self, settings: Settings, http_client: httpx.Client | None = None):
        self._settings = settings
        self._client = http_client

    def describe(self) -> str:
        from_masked = bool(self._settings.resend_api_key)
        return f"resend (key configured: {from_masked})"

    def send(self, message: OutgoingEmail) -> None:
        s = self._settings
        if not s.resend_api_key:
            raise EmailDeliveryError(
                "Resend backend selected but RESEND_API_KEY is not configured."
            )
        payload = {
            "from": s.mail_from_address,
            "to": [message.to_address],
            "subject": message.subject,
            "text": message.text_body,
            "html": message.html_body,
        }
        headers = {
            "Authorization": f"Bearer {s.resend_api_key}",
            "Content-Type": "application/json",
        }
        client = self._client or httpx.Client(timeout=15.0)
        try:
            response = client.post(
                self.API_URL, json=payload, headers=headers
            )
        except httpx.HTTPError as exc:
            logger.warning("Resend delivery transport error: %s", exc)
            raise EmailDeliveryError(
                "Resend API is unreachable — delivery has NOT been confirmed."
            ) from exc
        finally:
            if self._client is None:
                client.close()

        if response.status_code in (200, 201):
            logger.info(
                "MAIL[resend] verification email accepted for %s (subject: %s)",
                message.to_address,
                message.subject,
            )
            return

        try:
            detail = response.json().get("message", "")
        except Exception:  # noqa: BLE001 — provider error body is advisory
            detail = ""
        logger.warning(
            "Resend delivery rejected (HTTP %s): %s",
            response.status_code,
            detail or "no provider detail",
        )
        raise EmailDeliveryError(
            f"Resend rejected the message (HTTP {response.status_code})."
            + (f" Provider said: {detail}" if detail else "")
        )


class CapturingEmailSender(EmailSender):
    """Test double: records every outgoing email in memory. Never used
    outside tests."""

    def __init__(self, *, fail: bool = False):
        self.sent: list[OutgoingEmail] = []
        self._fail = fail

    def describe(self) -> str:
        return "capturing (tests)"

    def send(self, message: OutgoingEmail) -> None:
        if self._fail:
            raise EmailDeliveryError("Capturing sender configured to fail.")
        self.sent.append(message)


def create_email_sender(settings: Settings | None = None) -> EmailSender:
    """Factory used by the FastAPI dependency; tests override the dependency
    itself, which keeps provider code out of request handlers."""
    chosen = settings or get_settings()
    backend = chosen.mail_backend.lower()
    if backend == "console":
        return ConsoleEmailSender(chosen.mail_outbox_dir, chosen.mail_from_address)
    if backend == "smtp":
        return SmtpEmailSender(chosen)
    if backend == "resend":
        return ResendEmailSender(chosen)
    raise EmailDeliveryError(
        f"Unsupported MAIL_BACKEND={chosen.mail_backend!r} "
        "(expected console, smtp, or resend)."
    )


def get_email_sender() -> EmailSender:
    # Fresh instance per request is cheap; instances hold no user state.
    return create_email_sender()
