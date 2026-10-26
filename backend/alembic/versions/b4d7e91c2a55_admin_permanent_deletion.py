"""admin permanent deletion cleanup tracking

Revision ID: b4d7e91c2a55
Revises: f1c49d83a2b0
Create Date: 2026-10-27

Non-destructive: creates the biomass_deletion_cleanups table only; no
existing data is modified or removed. Downgrade drops only this table.

The table tracks the FILE-cleanup phase of admin permanent deletions: the
database purge commits atomically (record + dependents + this tracking row
listing the exact storage keys), then image files are deleted from the
upload directory. If that second phase fails or is interrupted, the row
stays 'pending' and deletion can be retried safely and idempotently.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import JSONB, UUID


revision: str = 'b4d7e91c2a55'
down_revision: Union[str, Sequence[str], None] = 'f1c49d83a2b0'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'biomass_deletion_cleanups',
        sa.Column('id', UUID(as_uuid=True), nullable=False),
        sa.Column('entity_type', sa.String(10), nullable=False),
        sa.Column('entity_id', UUID(as_uuid=True), nullable=False),
        sa.Column('storage_keys', JSONB(astext_type=sa.Text()), nullable=False,
                  server_default=sa.text("'[]'::jsonb")),
        sa.Column('status', sa.String(10), nullable=False, server_default='pending'),
        sa.Column('attempts', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('removed_files', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('missing_files', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('failed_files', sa.Integer(), nullable=False, server_default='0'),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint("entity_type IN ('lot','listing')", name='ck_biomass_deletion_cleanups_type'),
        sa.CheckConstraint("status IN ('pending','completed')", name='ck_biomass_deletion_cleanups_status'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('entity_type', 'entity_id', name='uq_biomass_deletion_cleanups_entity'),
    )


def downgrade() -> None:
    op.drop_table('biomass_deletion_cleanups')
