"""
Application configuration.

All environment-dependent values come from environment variables (optionally
via backend/.env, which is gitignored). backend/.env.example documents every
variable with placeholder values only — never commit real credentials.
"""

from functools import lru_cache

from pydantic import Field
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

    # Email delivery backend: "console" (dev: writes to .mail_outbox/),
    # "smtp" (generic SMTP servers), or "resend" (Resend HTTP API).
    mail_backend: str = "console"

    # Generic SMTP configuration (used when MAIL_BACKEND=smtp).
    mail_host: str = ""
    mail_port: int = 587
    mail_username: str = ""
    mail_password: str = ""
    mail_use_tls: bool = True

    # Address verification emails are sent from. For Resend test accounts
    # (no verified domain) Resend requires onboarding@resend.dev.
    mail_from_address: str = "onboarding@bioeconomy.local"

    # Resend HTTP API key (https://resend.com). Secret — .env only.
    resend_api_key: str = ""

    # Outbox directory for the console dev backend (relative to CWD when
    # running from backend/). Gitignored.
    mail_outbox_dir: str = ".mail_outbox"


@lru_cache
def get_settings() -> Settings:
    return Settings()
