"""Secure, single-use password reset token lifecycle."""
import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import update
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.models import AuthPasswordResetToken, AuthSession, User
from backend.security import hash_password
from backend.sessions import hash_token


def reset_token() -> str:
    return secrets.token_urlsafe(32)


class PasswordResetService:
    def __init__(self, db: Session):
        self.db = db

    def issue(self, user: User) -> str:
        now = datetime.now(timezone.utc)
        self.db.execute(update(AuthPasswordResetToken).where(
            AuthPasswordResetToken.user_id == user.id,
            AuthPasswordResetToken.consumed_at.is_(None),
            AuthPasswordResetToken.revoked_at.is_(None),
        ).values(revoked_at=now))
        raw = reset_token()
        self.db.add(AuthPasswordResetToken(
            token_hash=hash_token(raw), user_id=user.id,
            expires_at=now + timedelta(minutes=get_settings().password_reset_token_minutes),
        ))
        self.db.commit()
        return raw

    def consume_and_reset(self, raw: str, new_password: str) -> bool:
        now = datetime.now(timezone.utc)
        row = self.db.execute(update(AuthPasswordResetToken).where(
            AuthPasswordResetToken.token_hash == hash_token(raw),
            AuthPasswordResetToken.expires_at > now,
            AuthPasswordResetToken.consumed_at.is_(None),
            AuthPasswordResetToken.revoked_at.is_(None),
        ).values(consumed_at=now).returning(
            AuthPasswordResetToken.user_id, AuthPasswordResetToken.id
        )).first()
        if row is None:
            self.db.rollback()
            return False
        user_id, token_id = row
        user = self.db.query(User).filter(User.id == user_id).with_for_update().one_or_none()
        if user is None or not user.is_active or not user.is_email_verified:
            self.db.execute(update(AuthPasswordResetToken).where(
                AuthPasswordResetToken.id == token_id
            ).values(revoked_at=now))
            self.db.commit()
            return False
        user.password_hash = hash_password(new_password)
        self.db.execute(update(AuthPasswordResetToken).where(
            AuthPasswordResetToken.user_id == user_id,
            AuthPasswordResetToken.id != token_id,
            AuthPasswordResetToken.consumed_at.is_(None),
            AuthPasswordResetToken.revoked_at.is_(None),
        ).values(revoked_at=now))
        self.db.execute(update(AuthSession).where(
            AuthSession.user_id == user_id,
            AuthSession.revoked_at.is_(None),
        ).values(revoked_at=now))
        self.db.commit()
        return True
