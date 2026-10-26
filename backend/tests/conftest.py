"""Test fixtures for auth API tests.

Guarantees: every test run gets a FRESH isolated database
(bioeconomy_test_<random-hex>) created on the same PostgreSQL instance,
migrated via Alembic (environment.py reads DATABASE_URL), and dropped after
the run. The dev database (bioeconomy) is never touched.

Rate limiting is disabled via env var so repeated requests in tests are not
throttled (the limiter is already covered indirectly by its obvious
process-local behavior; pattern limits are small and would break suites).
"""

import os
import sys
import tempfile
import uuid
from pathlib import Path

import pytest
from alembic import command
from alembic.config import Config
from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.orm import sessionmaker

# Configure the app under test BEFORE importing backend modules. Settings
# read these environment variables at instantiation time.
os.environ.setdefault("RATE_LIMIT_ENABLED", "0")
os.environ.setdefault("COOKIE_SECURE", "0")
# Image files land in a throwaway temp directory during tests — never in
# the working tree's .data/ directory.
os.environ.setdefault(
    "BIOMASS_IMAGE_UPLOAD_DIR",
    tempfile.mkdtemp(prefix="bioeconomy_test_images_"),
)
os.environ.setdefault("BIOMASS_IMAGE_MAX_MB", "5")

BACKEND_ROOT = Path(__file__).resolve().parents[1]


def _base_database_url() -> str:
    # Import after env vars are set.
    from backend.config import Settings

    return Settings().database_url


@pytest.fixture(scope="session")
def test_engine():
    """Creates an isolated, fully migrated database; drops it afterwards."""
    base_url = _base_database_url()
    if base_url.startswith("sqlite"):
        pytest.fail("DATABASE_URL must point at PostgreSQL for auth tests.")

    base = make_url(base_url)
    if base.database in (None, "", "postgres") or not str(base.database).startswith(
        "bioeconomy"
    ):
        # Allow only *our* dev/test databases as the source instance.
        pytest.fail(
            "Refusing to create test databases from an unexpected source "
            f"database name: {base.database!r}"
        )

    test_db_name = f"bioeconomy_test_{uuid.uuid4().hex[:10]}"

    # Admin statements run over an autocommit connection to the dev database
    # (CREATE/DROP DATABASE cannot run inside a transaction block).
    admin_engine = create_engine(base_url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        conn.execute(text('CREATE DATABASE "%s"' % test_db_name))
    admin_engine.dispose()

    # NOTE: str(URL) masks the password with literal '***'; use
    # render_as_string(hide_password=False) to get a connectable URL string.
    test_url = base.set(database=test_db_name).render_as_string(
        hide_password=False
    )
    os.environ["DATABASE_URL"] = test_url

    # Migrate the clean test database with the real migration chain.
    alembic_cfg = Config(str(BACKEND_ROOT / "alembic.ini"))
    alembic_cfg.set_main_option("script_location", str(BACKEND_ROOT / "alembic"))
    command.upgrade(alembic_cfg, "head")

    engine = create_engine(test_url)
    yield engine

    engine.dispose()
    admin_engine = create_engine(base_url, isolation_level="AUTOCOMMIT")
    with admin_engine.connect() as conn:
        # Close any lingering connections before dropping.
        conn.execute(
            text(
                "SELECT pg_terminate_backend(pid) FROM pg_stat_activity "
                "WHERE datname = :name"
            ),
            {"name": test_db_name},
        )
        conn.execute(text('DROP DATABASE "%s"' % test_db_name))
    admin_engine.dispose()
    # Restore the dev URL for anything reading it later.
    os.environ.pop("DATABASE_URL", None)
    sys.stderr.write(f"Isolated test database {test_db_name} dropped.\n")


@pytest.fixture()
def db_session(test_engine):
    factory = sessionmaker(bind=test_engine, expire_on_commit=False)
    session = factory()
    try:
        yield session
    finally:
        session.close()


@pytest.fixture()
def client(test_engine):
    from fastapi.testclient import TestClient

    from backend.api.db_deps import get_db
    from backend.mailer import CapturingEmailSender, get_email_sender
    from backend.main import create_app

    factory = sessionmaker(bind=test_engine, expire_on_commit=False)
    app = create_app()

    capture = CapturingEmailSender()
    app.dependency_overrides[get_email_sender] = lambda: capture

    def override_get_db():
        session = factory()
        try:
            yield session
        finally:
            session.close()

    app.dependency_overrides[get_db] = override_get_db
    with TestClient(app) as test_client:
        # Let tests reach the capture without a second fixture dance.
        test_client.mail_capture = capture  # type: ignore[attr-defined]
        yield test_client
    app.dependency_overrides.clear()
