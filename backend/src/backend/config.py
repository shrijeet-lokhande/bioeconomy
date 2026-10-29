"""
Application configuration.

All environment-dependent values come from environment variables (optionally
via backend/.env, which is gitignored). backend/.env.example documents every
variable with placeholder values only — never commit real credentials.
"""

from functools import lru_cache
import re

from email_validator import EmailNotValidError, validate_email
from pydantic import Field, field_validator, model_validator
from pydantic_settings import BaseSettings, SettingsConfigDict

# Default login page origin of the Vite dev server; extendable via CORS_ORIGINS.
DEFAULT_CORS_ORIGINS = [
    "http://localhost:5173",
    "http://127.0.0.1:5173",
]

class Settings(BaseSettings):
    model_config = SettingsConfigDict(
        env_file=".env",
        env_file_encoding="utf-8",
        extra="ignore",
    )

    app_name: str = "Bioeconomy API"

    # Explicit deployment environment. Production mail settings are checked
    # before FastAPI starts so sandbox senders cannot be used
    # accidentally for real users.
    app_env: str = "development"

    # SQLAlchemy URL using the psycopg 3 dialect, e.g.
    # postgresql+psycopg://user:password@localhost:5432/bioeconomy
    database_url: str = "postgresql+psycopg://localhost:5432/bioeconomy"

    # Origins allowed for CORS and for the Origin check on unsafe methods.
    cors_origins: list[str] = Field(default=DEFAULT_CORS_ORIGINS)

    # Cookie flags. COOKIE_SECURE must be 1 in any environment served over
    # HTTPS (production). SameSite=Lax is the CSRF baseline for this API.
    cookie_secure: bool = False
    cookie_samesite: str = "lax"

    # Server-side session lifetime (absolute, enforced by the DB row).
    session_lifetime_hours: int = 24 * 7

    # Process-local rate limiting for register/login. Single-instance only;
    # a shared limiter (e.g. Redis) is a documented follow-up task.
    rate_limit_enabled: bool = True
    rate_limit_per_minute: int = 5

    # --- Email verification (Task 003) ---

    # Trusted base URL used to build verification links. Never derived from
    # an untrusted request Host header. Dev: http://localhost:5173
    app_base_url: str = "http://localhost:5173"

    # Verification token lifetime in minutes (default 30).
    verification_token_minutes: int = 30
    password_reset_token_minutes: int = 30
    password_reset_email_limit_per_hour: int = 3
    verification_email_limit_per_hour: int = Field(default=3, ge=1)

    # Email delivery backend: "console", "smtp", or "mailgun".
    mail_backend: str = "console"

    # Generic SMTP configuration (used when MAIL_BACKEND=smtp).
    mail_host: str = ""
    mail_port: int = 587
    mail_username: str = ""
    mail_password: str = ""
    mail_use_tls: bool = True

    # Sender identity configured with the selected provider.
    mail_from_address: str = "onboarding@example.org"
    mail_from_name: str = "Bioeconomy"

    # Mailgun HTTP API. Use a domain sending key, stored in .env only.
    mailgun_api_key: str = Field(default="", repr=False)
    mailgun_domain: str = ""
    mailgun_region: str = "us"

    # Outbox directory for the console dev backend (relative to CWD when
    # running from backend/). Gitignored.
    mail_outbox_dir: str = ".mail_outbox"

    # --- Biomass record images (1–5 compulsory uploads per lot/listing) ---

    # Directory for uploaded biomass images (absolute, or relative to CWD
    # when running from backend/). Gitignored; files keep server-generated
    # names and are served exclusively through the authorized image
    # endpoint — never as static files.
    biomass_image_upload_dir: str = ".data/biomass_images"

    # Per-file upload cap in MB (5 MB); at most 5 images per record.
    biomass_image_max_mb: int = 5

    @field_validator("app_env", "mail_backend", "mailgun_region", mode="before")
    @classmethod
    def normalize_environment_labels(cls, value: object) -> str:
        return str(value).strip().lower()

    @field_validator("app_env")
    @classmethod
    def validate_app_env(cls, value: str) -> str:
        if value not in {"development", "test", "production"}:
            raise ValueError("APP_ENV must be development, test, or production.")
        return value

    @field_validator("mail_backend")
    @classmethod
    def validate_mail_backend(cls, value: str) -> str:
        if value not in {"console", "smtp", "mailgun"}:
            raise ValueError("MAIL_BACKEND must be console, smtp, or mailgun.")
        return value

    @field_validator("mailgun_region")
    @classmethod
    def validate_mailgun_region(cls, value: str) -> str:
        if value not in {"us", "eu"}:
            raise ValueError("MAILGUN_REGION must be us or eu.")
        return value

    @model_validator(mode="after")
    def validate_mail_configuration(self) -> "Settings":
        if self.mail_backend in {"smtp", "mailgun"}:
            try:
                validate_email(
                    self.mail_from_address.strip(),
                    check_deliverability=False,
                    allow_smtputf8=False,
                )
            except EmailNotValidError as exc:
                raise ValueError(
                    "MAIL_FROM_ADDRESS must be a valid email address."
                ) from exc

        if self.mail_backend == "mailgun":
            if not self.mailgun_api_key.strip():
                raise ValueError("MAILGUN_API_KEY is required when MAIL_BACKEND=mailgun.")
            if not self.mailgun_domain.strip():
                raise ValueError("MAILGUN_DOMAIN is required when MAIL_BACKEND=mailgun.")
            if not re.fullmatch(r"(?=.{1,253}$)(?:[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?\.)+[A-Za-z]{2,63}", self.mailgun_domain.strip()):
                raise ValueError("MAILGUN_DOMAIN must be a valid sending domain.")
            if self.mail_from_address.rsplit("@", 1)[-1].lower() != self.mailgun_domain.strip().lower():
                raise ValueError("MAIL_FROM_ADDRESS domain must match MAILGUN_DOMAIN.")

        if self.mail_backend == "smtp":
            if not self.mail_host.strip():
                raise ValueError("MAIL_HOST is required when MAIL_BACKEND=smtp.")
            if self.mail_username and not self.mail_password:
                raise ValueError(
                    "MAIL_PASSWORD is required when MAIL_USERNAME is configured."
                )

        if self.app_env == "production":
            if self.mail_backend == "console":
                raise ValueError(
                    "MAIL_BACKEND=console is not allowed when APP_ENV=production."
                )
            if not self.app_base_url.lower().startswith("https://"):
                raise ValueError("APP_BASE_URL must use HTTPS in production.")
            if not self.cookie_secure:
                raise ValueError("COOKIE_SECURE must be enabled in production.")
            sender_domain = self.mail_from_address.rsplit("@", 1)[-1].lower()
            reserved_domain = (
                sender_domain in {"example.com", "example.org", "example.net"}
                or sender_domain.endswith(
                    (".example", ".invalid", ".test", ".localhost", ".local")
                )
            )
            if reserved_domain or (
                self.mail_backend == "mailgun"
                and self.mailgun_domain.lower().startswith("sandbox")
            ):
                raise ValueError(
                    "Production mail requires MAIL_FROM_ADDRESS on a real sender "
                    "domain; shared test and placeholder domains are not allowed."
                )

        return self


@lru_cache
def get_settings() -> Settings:
    return Settings()
