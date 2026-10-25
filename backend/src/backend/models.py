"""ORM models: users and auth sessions.

Minimal schema for the authentication task; geospatial/PostGIS types are
deliberately not used. Timestamps are timezone-aware.
"""

import uuid
from datetime import datetime

from sqlalchemy import (
    Boolean,
    DateTime,
    ForeignKey,
    String,
    func,
)
from sqlalchemy.dialects.postgresql import UUID
from sqlalchemy.orm import DeclarativeBase, Mapped, mapped_column, relationship


class Base(DeclarativeBase):
    pass


class User(Base):
    __tablename__ = "users"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    full_name: Mapped[str] = mapped_column(String(200), nullable=False)
    # Emails are normalized to lowercase at the service boundary before being
    # persisted; the unique constraint enforces one account per email.
    email: Mapped[str] = mapped_column(String(320), nullable=False, unique=True)
    # Argon2id PHC string — never returned by any API response.
    password_hash: Mapped[str] = mapped_column(String(255), nullable=False)
    # Server-controlled role. Registration always writes the default; there
    # is no endpoint path from request input to a privileged role.
    role: Mapped[str] = mapped_column(
        String(32), nullable=False, default="user", server_default="user"
    )
    is_active: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=True, server_default="true"
    )
    # Email verification (Task 003): new accounts start unverified and only a
    # successful token consumption (or explicit administrative action)
    # flips this. Existing users were deliberately NOT auto-verified.
    is_email_verified: Mapped[bool] = mapped_column(
        Boolean, nullable=False, default=False, server_default="false"
    )
    email_verified_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True),
        nullable=False,
        server_default=func.now(),
        onupdate=func.now(),
    )

    sessions: Mapped[list["AuthSession"]] = relationship(
        back_populates="user", cascade="all, delete-orphan"
    )


class AuthSession(Base):
    __tablename__ = "auth_sessions"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    # SHA-256 of the random session token. The raw token lives only in the
    # browser cookie; a database leak therefore yields no usable sessions.
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    revoked_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    user: Mapped[User] = relationship(back_populates="sessions")


class AuthEmailVerificationToken(Base):
    """Single-use email verification tokens.

    Only the SHA-256 hash of the raw token is stored (raw token exists solely
    inside the emailed link). A new token issue supersedes a user's previous
    unconsumed tokens (consumed_at set via the issue path). Consumption is a
    single conditional UPDATE ... RETURNING, so concurrent requests cannot
    consume one token twice.
    """

    __tablename__ = "auth_email_verification_tokens"

    id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), primary_key=True, default=uuid.uuid4
    )
    token_hash: Mapped[str] = mapped_column(String(64), nullable=False, unique=True)
    user_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="CASCADE"), nullable=False
    )
    expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    consumed_at: Mapped[datetime | None] = mapped_column(
        DateTime(timezone=True), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    user: Mapped[User] = relationship()
