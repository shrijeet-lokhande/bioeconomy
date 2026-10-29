"""Email delivery for verification messages.

Design:
- Authentication business logic depends only on EmailSender; provider
  specifics live in the backend classes below.
- Backends (MAIL_BACKEND env): "console" (dev outbox), "smtp" (generic
  SMTP over STARTTLS/TLS), and "mailgun" (Mailgun Messages HTTP API).
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
import re
import smtplib
import ssl
from html import escape as html_escape
from dataclasses import dataclass, field
from datetime import datetime, timezone
from email import policy as email_policy
from email.message import EmailMessage as MIMEMessage
from uuid import uuid4

import httpx
from smtplib import SMTPAuthenticationError, SMTPException

from backend.config import get_settings, Settings

logger = logging.getLogger("backend.mailer")


class EmailDeliveryError(Exception):
    """Safe, structured failure raised when a provider did not accept mail."""

    def __init__(
        self,
        message: str,
        *,
        kind: str = "provider_error",
        status_code: int | None = None,
        provider_code: str | None = None,
    ):
        super().__init__(message)
        self.kind = kind
        self.status_code = status_code
        self.provider_code = provider_code


@dataclass(frozen=True)
class OutgoingEmail:
    to_address: str
    subject: str
    text_body: str
    html_body: str
    # A random, non-secret identifier used for application/provider
    # correlation. It is never derived from user data or authentication data.
    correlation_id: str = field(default_factory=lambda: uuid4().hex)


@dataclass(frozen=True)
class EmailSendReceipt:
    """Confirms provider acceptance, never mailbox delivery."""

    provider: str
    provider_email_id: str | None = None


@dataclass(frozen=True)
class VerificationEmailContext:
    recipient: str
    full_name: str
    verification_url: str
    expires_in_minutes: int


@dataclass(frozen=True)
class PasswordResetEmailContext:
    recipient: str
    full_name: str
    reset_url: str
    expires_in_minutes: int


def build_password_reset_email(context: PasswordResetEmailContext) -> OutgoingEmail:
    name = context.full_name or "there"
    safe_name = html_escape(name)
    expiry = f"This link expires in {context.expires_in_minutes} minutes and can be used only once."
    plain = (f"Hi {name},\n\nA password reset was requested for your Bioeconomy account.\n\n"
             f"Set a new password: {context.reset_url}\n\n{expiry}\n\n"
             "If you did not request this, ignore this email. Support staff will never need your current password.\n")
    html = (f"<p>Hi <strong>{safe_name}</strong>,</p><p>A password reset was requested for your Bioeconomy account.</p>"
            f'<p><a href="{context.reset_url}">Set a new password</a></p><p>{expiry}</p>'
            "<p>If you did not request this, ignore this email. Support staff will never need your current password.</p>")
    return OutgoingEmail(context.recipient, "Reset your Bioeconomy password", plain, html)


def build_password_changed_email(recipient: str, full_name: str) -> OutgoingEmail:
    name = full_name or "there"
    safe_name = html_escape(name)
    plain = (f"Hi {name},\n\nYour Bioeconomy account password was changed. "
             "All other active sessions have been signed out.\n\n"
             "If you did not make this change, contact support immediately.\n")
    html = (f"<p>Hi <strong>{safe_name}</strong>,</p><p>Your Bioeconomy account password was changed. "
            "All other active sessions have been signed out.</p><p>If you did not make this change, contact support immediately.</p>")
    return OutgoingEmail(recipient, "Your Bioeconomy password was changed", plain, html)


def build_verification_email(
    context: VerificationEmailContext,
    settings: Settings | None = None,
) -> OutgoingEmail:
    """Renders the verification email. The link is built from the trusted
    configured base URL by the caller (who owns APP_BASE_URL). This function
    embeds it verbatim into the bodies."""
    name = context.full_name or "there"
    subject = "Verify email for bioeconomy"
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

    def send(self, message: OutgoingEmail) -> EmailSendReceipt:
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

    def send(self, message: OutgoingEmail) -> EmailSendReceipt:
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
            "MAIL[console] email written to outbox correlation_id=%s",
            message.correlation_id,
        )
        return EmailSendReceipt(provider="console")


class SmtpEmailSender(EmailSender):
    """Generic SMTP client (e.g. Mailgun SMTP relay, self-hosted SMTP).

    Uses STARTTLS when MAIL_USE_TLS=1 with the standard encrypted-context
    policy; requires MAIL_HOST/MAIL_PORT/MAIL_USERNAME/MAIL_PASSWORD and
    MAIL_FROM_ADDRESS. Credentials come from environment only."""

    def __init__(self, settings: Settings):
        self._settings = settings

    def describe(self) -> str:
        return f"smtp ({self._settings.mail_host}:{self._settings.mail_port})"

    def send(self, message: OutgoingEmail) -> EmailSendReceipt:
        s = self._settings
        if not s.mail_host:
            raise EmailDeliveryError(
                "SMTP backend is missing configuration.", kind="configuration"
            )
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
                            "SMTP server does not support required STARTTLS.",
                            kind="tls_unavailable",
                        )
                    server.starttls(context=ssl.create_default_context())
                    server.ehlo()
                if s.mail_username:
                    try:
                        server.login(s.mail_username, s.mail_password)
                    except SMTPAuthenticationError as exc:
                        raise EmailDeliveryError(
                            "SMTP authentication failed; check mail credentials.",
                            kind="authentication",
                        ) from exc
                server.send_message(mime)
        except EmailDeliveryError:
            raise
        except SMTPException as exc:
            raise EmailDeliveryError(
                "SMTP server rejected or failed to accept the message.",
                kind="smtp_error",
            ) from exc
        except OSError as exc:
            raise EmailDeliveryError(
                "SMTP server could not be reached.", kind="transport_error"
            ) from exc
        return EmailSendReceipt(provider="smtp")


class MailgunEmailSender(EmailSender):
    """Mailgun Messages API client. HTTP acceptance is not inbox delivery."""

    US_API = "https://api.mailgun.net"
    EU_API = "https://api.eu.mailgun.net"

    def __init__(self, settings: Settings, http_client: httpx.Client | None = None):
        self._settings = settings
        self._client = http_client

    @property
    def api_url(self) -> str:
        base = self.EU_API if self._settings.mailgun_region == "eu" else self.US_API
        return f"{base}/v3/{self._settings.mailgun_domain}/messages"

    def describe(self) -> str:
        return f"mailgun ({self._settings.mailgun_region}; domain configured)"

    def send(self, message: OutgoingEmail) -> EmailSendReceipt:
        s = self._settings
        if not s.mailgun_api_key or not s.mailgun_domain:
            raise EmailDeliveryError(
                "Mailgun backend is missing its API key or sending domain.",
                kind="configuration",
            )
        client = self._client or httpx.Client(
            timeout=httpx.Timeout(15.0, connect=5.0)
        )
        try:
            response = client.post(
                self.api_url,
                auth=("api", s.mailgun_api_key),
                files={
                    key: (None, value)
                    for key, value in {
                        "from": f"{s.mail_from_name} <{s.mail_from_address}>",
                        "to": message.to_address,
                        "subject": message.subject,
                        "text": message.text_body,
                        "html": message.html_body,
                        "v:correlation_id": message.correlation_id,
                        "o:tag": "bioeconomy-transactional",
                    }.items()
                },
            )
        except httpx.TimeoutException as exc:
            raise EmailDeliveryError(
                "Mailgun request timed out; acceptance is unknown.", kind="timeout"
            ) from exc
        except httpx.HTTPError as exc:
            raise EmailDeliveryError(
                "Mailgun API could not be reached; acceptance is unknown.",
                kind="transport_error",
            ) from exc
        finally:
            if self._client is None:
                client.close()

        if 200 <= response.status_code < 300:
            provider_email_id = None
            try:
                response_id = response.json().get("id")
                if isinstance(response_id, str) and re.fullmatch(
                    r"<[A-Za-z0-9_.@+-]{1,248}>", response_id
                ):
                    provider_email_id = response_id
            except (ValueError, AttributeError):
                pass
            return EmailSendReceipt(
                provider="mailgun", provider_email_id=provider_email_id
            )

        if response.status_code == 401:
            failure = "authentication"
        elif response.status_code == 429:
            failure = "rate_limited"
        elif response.status_code == 408 or response.status_code >= 500:
            failure = "transient_provider_error"
        else:
            failure = "provider_rejected"
        # Do not log or forward Mailgun's response body; it may contain
        # recipient data or account-specific diagnostics.
        raise EmailDeliveryError(
            f"Mailgun did not accept the message (HTTP {response.status_code}).",
            kind=failure,
            status_code=response.status_code,
            provider_code=f"http_{response.status_code}",
        )


class CapturingEmailSender(EmailSender):
    """Test double: records every outgoing email in memory. Never used
    outside tests."""

    def __init__(self, *, fail: bool = False):
        self.sent: list[OutgoingEmail] = []
        self._fail = fail

    def describe(self) -> str:
        return "capturing (tests)"

    def send(self, message: OutgoingEmail) -> EmailSendReceipt:
        if self._fail:
            raise EmailDeliveryError("Capturing sender configured to fail.")
        self.sent.append(message)
        return EmailSendReceipt(provider="capturing")


def create_email_sender(settings: Settings | None = None) -> EmailSender:
    """Factory used by the FastAPI dependency; tests override the dependency
    itself, which keeps provider code out of request handlers."""
    chosen = settings or get_settings()
    backend = chosen.mail_backend.lower()
    if backend == "console":
        return ConsoleEmailSender(chosen.mail_outbox_dir, chosen.mail_from_address)
    if backend == "smtp":
        return SmtpEmailSender(chosen)
    if backend == "mailgun":
        return MailgunEmailSender(chosen)
    raise EmailDeliveryError(
        f"Unsupported MAIL_BACKEND={chosen.mail_backend!r} "
        "(expected console, smtp, or mailgun)."
    )


def get_email_sender() -> EmailSender:
    # Fresh instance per request is cheap; instances hold no user state.
    return create_email_sender()
