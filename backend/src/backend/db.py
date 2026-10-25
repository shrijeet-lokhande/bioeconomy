"""SQLAlchemy 2 database access. Synchronous stack with psycopg 3, matching
the existing dependency set — no architectural rewrite required."""

from sqlalchemy import create_engine
from sqlalchemy.orm import Session, sessionmaker

from backend.config import get_settings

_session_factory: sessionmaker[Session] | None = None


def get_session_factory(database_url: str | None = None) -> sessionmaker[Session]:
    """Builds (once) the application session factory for the configured DB."""
    global _session_factory
    if _session_factory is None or database_url is not None:
        url = database_url or get_settings().database_url
        engine = create_engine(url, pool_pre_ping=True)
        _session_factory = sessionmaker(bind=engine, expire_on_commit=False)
    return _session_factory
