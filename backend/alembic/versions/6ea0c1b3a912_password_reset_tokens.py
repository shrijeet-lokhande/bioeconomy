"""password reset tokens

Revision ID: 6ea0c1b3a912
Revises: b4d7e91c2a55
"""
from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects import postgresql

revision = "6ea0c1b3a912"
down_revision = "b4d7e91c2a55"
branch_labels = None
depends_on = None

def upgrade() -> None:
    op.create_table(
        "auth_password_reset_tokens",
        sa.Column("id", postgresql.UUID(as_uuid=True), primary_key=True),
        sa.Column("token_hash", sa.String(length=64), nullable=False, unique=True),
        sa.Column("user_id", postgresql.UUID(as_uuid=True), sa.ForeignKey("users.id", ondelete="CASCADE"), nullable=False),
        sa.Column("expires_at", sa.DateTime(timezone=True), nullable=False),
        sa.Column("consumed_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("revoked_at", sa.DateTime(timezone=True), nullable=True),
        sa.Column("created_at", sa.DateTime(timezone=True), server_default=sa.func.now(), nullable=False),
    )
    op.create_index("ix_auth_password_reset_tokens_user_id", "auth_password_reset_tokens", ["user_id"])
    op.create_index("ix_auth_password_reset_tokens_expires_at", "auth_password_reset_tokens", ["expires_at"])

def downgrade() -> None:
    op.drop_index("ix_auth_password_reset_tokens_expires_at", table_name="auth_password_reset_tokens")
    op.drop_index("ix_auth_password_reset_tokens_user_id", table_name="auth_password_reset_tokens")
    op.drop_table("auth_password_reset_tokens")
