"""Email verification token service.

Security model:
- Tokens are 256-bit cryptographically random secrets (token_urlsafe(32)).
- Only SHA-256(token) is stored; the raw token exists solely inside the
  emailed verification link.
- Default lifetime: 30 minutes (VERIFICATION_TOKEN_MINUTES).
- Single-use: consumption is ONE conditional UPDATE ... RETURNING (row-level
  atomic), so concurrent requests cannot consume a token twice.
- Supersede policy: issuing a new token marks all prior unconsumed tokens of
  that user consumed first, so stale tokens can never verify the account.
"""

import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import update
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.models import AuthEmailVerificationToken, User

# Re-export the same hashing used for sessions (documented single pattern).
from backend.sessions import hash_token  # noqa: F401


def generate_verification_token() -> str:
    return secrets.token_urlsafe(32)


class VerificationService:
    def __init__(self, db: Session):
        self.db = db
        self._settings = get_settings()

    def issue(self, user: User) -> str:
        """Creates a fresh token for the user, superseding prior unconsumed
        tokens. Returns the raw token (goes into the email link only)."""
        now = datetime.now(timezone.utc)
        # Supersede: no softly-expired pile of live tokens per user.
        self.db.execute(
            update(AuthEmailVerificationToken)
            .where(
                AuthEmailVerificationToken.user_id == user.id,
                AuthEmailVerificationToken.consumed_at.is_(None),
            )
            .values(consumed_at=now)
        )
        raw_token = generate_verification_token()
        self.db.add(
            AuthEmailVerificationToken(
                token_hash=hash_token(raw_token),
                user_id=user.id,
                expires_at=now
                + timedelta(minutes=self._settings.verification_token_minutes),
            )
        )
        self.db.commit()
        return raw_token

    def consume(self, raw_token: str) -> User | None:
        """Atomically consumes the token and verifies the user in the same
        transaction. Returns the verified user, or None when the token is
        unknown, expired, or already used (callers treat all three as one
        generic rejection — no enumeration)."""
        now = datetime.now(timezone.utc)
        matched_user_id = self.db.execute(
            update(AuthEmailVerificationToken)
            .where(
                AuthEmailVerificationToken.token_hash == hash_token(raw_token),
                AuthEmailVerificationToken.consumed_at.is_(None),
                AuthEmailVerificationToken.expires_at > now,
            )
            .values(consumed_at=now)
            .returning(AuthEmailVerificationToken.user_id)
        ).scalar()
        if matched_user_id is None:
            return None
        user = self.db.get(User, matched_user_id)
        if user is None:
            # FK guarantees existence unless the user was deleted mid-flight;
            # roll the consumed flag back so nothing is wasted.
            self.db.rollback()
            return None
        user.is_email_verified = True
        user.email_verified_at = now
        self.db.commit()
        return user

    def purge_stale(self) -> int:
        """Housekeeping: delete rows already consumed or expired. Runs
        opportunistically on register/resend."""
        now = datetime.now(timezone.utc)
        result = self.db.execute(
            AuthEmailVerificationToken.__table__.delete().where(
                (AuthEmailVerificationToken.expires_at < now)
                | AuthEmailVerificationToken.consumed_at.is_not(None)
            )
        )
        self.db.commit()
        return int(result.rowcount or 0)
