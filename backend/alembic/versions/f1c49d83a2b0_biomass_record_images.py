"""biomass record images (1-5 per lot / listing)

Revision ID: f1c49d83a2b0
Revises: 5c1f2a9d7b40
Create Date: 2026-10-27

Non-destructive: creates the biomass_images table only; no existing data is
modified or removed. Downgrade drops only this table.

Image bytes themselves live on disk (upload dir, server-generated names);
the table stores metadata. A record must carry at least one and at most
five images — the count rule is enforced in the service layer (row counts
are not SQL-constraint material); the database enforces position 1..5 per
parent via unique constraints plus CHECK constraints for parentness and
type allowlisting.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID


revision: str = 'f1c49d83a2b0'
down_revision: Union[str, Sequence[str], None] = '5c1f2a9d7b40'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'biomass_images',
        sa.Column('id', UUID(as_uuid=True), nullable=False),
        sa.Column('lot_id', UUID(as_uuid=True),
                  sa.ForeignKey('biomass_lots.id', ondelete='CASCADE'), nullable=True),
        sa.Column('listing_id', UUID(as_uuid=True),
                  sa.ForeignKey('biomass_listings.id', ondelete='CASCADE'), nullable=True),
        sa.Column('position', sa.Integer(), nullable=False),
        sa.Column('stored_name', sa.String(120), nullable=False),
        sa.Column('original_name', sa.String(255), nullable=False),
        sa.Column('content_type', sa.String(80), nullable=False),
        sa.Column('size_bytes', sa.Integer(), nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint('(lot_id IS NULL) <> (listing_id IS NULL)', name='ck_biomass_images_parent'),
        sa.CheckConstraint('position >= 1 AND position <= 5', name='ck_biomass_images_position'),
        sa.CheckConstraint('size_bytes > 0', name='ck_biomass_images_size'),
        sa.CheckConstraint(
            "content_type IN ('image/jpeg','image/png','image/webp')",
            name='ck_biomass_images_type',
        ),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('stored_name', name='uq_biomass_images_stored_name'),
        sa.UniqueConstraint('lot_id', 'position', name='uq_biomass_images_lot_position'),
        sa.UniqueConstraint('listing_id', 'position', name='uq_biomass_images_listing_position'),
    )
    op.create_index('ix_biomass_images_listing', 'biomass_images', ['listing_id', 'position'])


def downgrade() -> None:
    op.drop_index('ix_biomass_images_listing', table_name='biomass_images')
    op.drop_table('biomass_images')
