"""Session creation, resolution, expiration, and revocation.

Design: the browser cookie carries a cryptographically random token
(secrets.token_urlsafe(32), i.e. 256 bits). Only SHA-256(token) is stored in
auth_sessions, together with a UTC expiry and an optional revocation stamp.
Resolution invalidates expired or revoked rows, and sessions of deactivated
users.
"""

import hashlib
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import delete, select
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.models import AuthSession, User

SESSION_COOKIE_NAME = "bio_session"


def generate_session_token() -> str:
    return secrets.token_urlsafe(32)


def hash_token(token: str) -> str:
    return hashlib.sha256(token.encode("utf-8")).hexdigest()


class SessionService:
    def __init__(self, db: Session):
        self.db = db
        self._settings = get_settings()

    def create(self, user: User) -> tuple[str, AuthSession]:
        """Creates a new session row; returns (raw token, row)."""
        token = generate_session_token()
        expires_at = datetime.now(timezone.utc) + timedelta(
            hours=self._settings.session_lifetime_hours
        )
        session_row = AuthSession(
            token_hash=hash_token(token), user_id=user.id, expires_at=expires_at
        )
        self.db.add(session_row)
        self.db.commit()
        return token, session_row

    def resolve(self, token: str) -> tuple[User, AuthSession] | None:
        """Returns (user, row) for a live session, otherwise None."""
        row = self.db.scalar(
            select(AuthSession).where(AuthSession.token_hash == hash_token(token))
        )
        now = datetime.now(timezone.utc)
        if row is None:
            return None
        if row.revoked_at is not None:
            return None
        expires_at: datetime = row.expires_at
        if expires_at.tzinfo is None:
            # Defensive: DB should always return tz-aware datetimes.
            expires_at = expires_at.replace(tzinfo=timezone.utc)
        if expires_at <= now:
            return None
        user = self.db.get(User, row.user_id)
        if user is None or not user.is_active:
            return None
        return user, row

    def revoke(self, row: AuthSession) -> None:
        if row.revoked_at is None:
            row.revoked_at = datetime.now(timezone.utc)
            self.db.commit()

    def purge_expired(self) -> int:
        """Hard-deletes rows expired more than a day ago (housekeeping)."""
        cutoff = datetime.now(timezone.utc) - timedelta(hours=24)
        result = self.db.execute(
            delete(AuthSession).where(AuthSession.expires_at < cutoff)
        )
        self.db.commit()
        return int(result.rowcount or 0)

    def revoke_by_token(self, token: str) -> bool:
        row = self.db.scalar(
            select(AuthSession).where(AuthSession.token_hash == hash_token(token))
        )
        if row is None:
            return False
        self.revoke(row)
        return True
