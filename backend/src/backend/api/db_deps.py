"""Database session dependency (kept separate so tests can override it
without importing the whole API package)."""

from collections.abc import Iterator

from sqlalchemy.orm import Session

from backend.db import get_session_factory


def get_db() -> Iterator[Session]:
    session = get_session_factory()()
    try:
        yield session
    finally:
        session.close()
