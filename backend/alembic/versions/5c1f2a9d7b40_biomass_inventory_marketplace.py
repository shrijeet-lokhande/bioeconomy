"""biomass inventory, marketplace and audit

Revision ID: 5c1f2a9d7b40
Revises: 3dd348b84f8a
Create Date: 2026-10-26

Non-destructive: creates new tables only; no existing data is modified or
removed. Downgrade drops only these new tables/triggers.

Conventions follow the existing chain: UUID PKs, timezone-aware timestamps
with `now()` server defaults, String CHECK constraints for closed value
sets, and NUMERIC (never float) for quantities and money.
"""
from typing import Sequence, Union

from alembic import op
import sqlalchemy as sa
from sqlalchemy.dialects.postgresql import UUID, JSONB


revision: str = '5c1f2a9d7b40'
down_revision: Union[str, Sequence[str], None] = '3dd348b84f8a'
branch_labels: Union[str, Sequence[str], None] = None
depends_on: Union[str, Sequence[str], None] = None


def upgrade() -> None:
    op.create_table(
        'biomass_lots',
        sa.Column('id', UUID(as_uuid=True), nullable=False),
        sa.Column('owner_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('title', sa.String(160), nullable=False),
        sa.Column('category', sa.String(60), nullable=False),
        sa.Column('material_type', sa.String(80), nullable=False),
        sa.Column('unit', sa.String(4), nullable=False),
        sa.Column('quantity_total', sa.Numeric(14, 3), server_default='0', nullable=False),
        sa.Column('quantity_available', sa.Numeric(14, 3), server_default='0', nullable=False),
        sa.Column('quantity_reserved', sa.Numeric(14, 3), server_default='0', nullable=False),
        sa.Column('quantity_sold', sa.Numeric(14, 3), server_default='0', nullable=False),
        sa.Column('quantity_transferred', sa.Numeric(14, 3), server_default='0', nullable=False),
        sa.Column('quantity_removed', sa.Numeric(14, 3), server_default='0', nullable=False),
        sa.Column('moisture_percent', sa.Numeric(5, 2), nullable=True),
        sa.Column('harvest_date', sa.Date(), nullable=True),
        sa.Column('source_provenance', sa.Text(), nullable=True),
        sa.Column('storage_location', sa.String(200), nullable=False),
        sa.Column('quality_grade', sa.String(60), nullable=True),
        sa.Column('quality_note', sa.Text(), nullable=True),
        sa.Column('permit_reference', sa.String(200), nullable=True),
        sa.Column('permit_status', sa.String(20), server_default='not_provided', nullable=False),
        sa.Column('status', sa.String(20), server_default='active', nullable=False),
        sa.Column('admin_flag', sa.String(300), nullable=True),
        sa.Column('price_per_unit', sa.Numeric(14, 2), nullable=True),
        sa.Column('currency', sa.String(3), server_default='USD', nullable=False),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint("unit IN ('kg','t','m3')", name='ck_biomass_lots_unit'),
        sa.CheckConstraint(
            "permit_status IN ('not_provided','unverified')", name='ck_biomass_lots_permit_status'
        ),
        sa.CheckConstraint("status IN ('active','archived')", name='ck_biomass_lots_status'),
        sa.CheckConstraint(
            'quantity_available >= 0 AND quantity_reserved >= 0 AND quantity_total >= 0 '
            'AND quantity_sold >= 0 AND quantity_transferred >= 0 AND quantity_removed >= 0',
            name='ck_biomass_lots_nonneg',
        ),
        sa.CheckConstraint(
            'moisture_percent IS NULL OR (moisture_percent >= 0 AND moisture_percent <= 100)',
            name='ck_biomass_lots_moisture_range',
        ),
        sa.CheckConstraint('price_per_unit IS NULL OR price_per_unit >= 0', name='ck_biomass_lots_price_nonneg'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_biomass_lots_owner_status', 'biomass_lots', ['owner_id', 'status'])

    op.create_table(
        'biomass_listings',
        sa.Column('id', UUID(as_uuid=True), nullable=False),
        sa.Column('lot_id', UUID(as_uuid=True), sa.ForeignKey('biomass_lots.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('seller_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('title', sa.String(160), nullable=False),
        sa.Column('description', sa.Text(), nullable=True),
        sa.Column('category', sa.String(60), nullable=False),
        sa.Column('material_type', sa.String(80), nullable=False),
        sa.Column('unit', sa.String(4), nullable=False),
        sa.Column('location', sa.String(200), nullable=True),
        sa.Column('quantity_total', sa.Numeric(14, 3), nullable=False),
        sa.Column('listing_available', sa.Numeric(14, 3), nullable=False),
        sa.Column('listing_reserved', sa.Numeric(14, 3), server_default='0', nullable=False),
        sa.Column('quantity_sold', sa.Numeric(14, 3), server_default='0', nullable=False),
        sa.Column('price_per_unit', sa.Numeric(14, 2), nullable=False),
        sa.Column('currency', sa.String(3), server_default='USD', nullable=False),
        sa.Column('fulfilment', sa.String(20), server_default='pickup', nullable=False),
        sa.Column('available_from', sa.Date(), nullable=True),
        sa.Column('available_until', sa.Date(), nullable=True),
        sa.Column('status', sa.String(20), server_default='draft', nullable=False),
        sa.Column('moderation_note', sa.String(300), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint("unit IN ('kg','t','m3')", name='ck_biomass_listings_unit'),
        sa.CheckConstraint(
            "status IN ('draft','active','paused','withdrawn','sold_out','rejected')",
            name='ck_biomass_listings_status',
        ),
        sa.CheckConstraint(
            "fulfilment IN ('pickup','delivery','negotiable')", name='ck_biomass_listings_fulfilment'
        ),
        sa.CheckConstraint(
            'listing_available >= 0 AND listing_reserved >= 0 AND quantity_sold >= 0',
            name='ck_biomass_listings_nonneg',
        ),
        sa.CheckConstraint('price_per_unit > 0', name='ck_biomass_listings_price_positive'),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_biomass_listings_seller_status', 'biomass_listings', ['seller_id', 'status'])
    op.create_index('ix_biomass_listings_status_material', 'biomass_listings', ['status', 'material_type'])

    op.create_table(
        'biomass_orders',
        sa.Column('id', UUID(as_uuid=True), nullable=False),
        sa.Column('reference', sa.String(24), nullable=False),
        sa.Column('listing_id', UUID(as_uuid=True), sa.ForeignKey('biomass_listings.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('lot_id', UUID(as_uuid=True), sa.ForeignKey('biomass_lots.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('buyer_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('seller_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='RESTRICT'), nullable=False),
        sa.Column('quantity', sa.Numeric(14, 3), nullable=False),
        sa.Column('unit', sa.String(4), nullable=False),
        sa.Column('unit_price', sa.Numeric(14, 2), nullable=False),
        sa.Column('total_amount', sa.Numeric(14, 2), nullable=False),
        sa.Column('currency', sa.String(3), nullable=False),
        sa.Column('status', sa.String(24), server_default='requested', nullable=False),
        sa.Column('buyer_note', sa.String(300), nullable=True),
        sa.Column('client_request_id', sa.String(64), nullable=True),
        sa.Column('reservation_expires_at', sa.DateTime(timezone=True), nullable=False),
        sa.Column('released_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('fulfilled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('completed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('cancelled_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('rejected_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('disputed_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('dispute_reason', sa.Text(), nullable=True),
        sa.Column('dispute_previous_status', sa.String(24), nullable=True),
        sa.Column('resolution_note', sa.Text(), nullable=True),
        sa.Column('resolved_by', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('resolved_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('settlement_status', sa.String(20), server_default='pending', nullable=False),
        sa.Column('settlement_note', sa.String(200), nullable=True),
        sa.Column('settlement_at', sa.DateTime(timezone=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.Column('updated_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint(
            "status IN ('requested','awaiting_fulfilment','fulfilled','completed',"
            "'cancelled','rejected','disputed')",
            name='ck_biomass_orders_status',
        ),
        sa.CheckConstraint("settlement_status IN ('pending','settled')", name='ck_biomass_orders_settlement'),
        sa.CheckConstraint('quantity > 0', name='ck_biomass_orders_quantity_positive'),
        sa.CheckConstraint('unit_price >= 0', name='ck_biomass_orders_price_nonneg'),
        sa.PrimaryKeyConstraint('id'),
        sa.UniqueConstraint('reference', name='uq_biomass_orders_reference'),
        sa.UniqueConstraint('client_request_id', name='uq_biomass_orders_client_request_id'),
    )
    op.create_index('ix_biomass_orders_buyer', 'biomass_orders', ['buyer_id', 'status'])
    op.create_index('ix_biomass_orders_seller', 'biomass_orders', ['seller_id', 'status'])
    op.create_index('ix_biomass_orders_listing', 'biomass_orders', ['listing_id', 'status'])

    op.create_table(
        'stock_movements',
        sa.Column('id', UUID(as_uuid=True), nullable=False),
        sa.Column('lot_id', UUID(as_uuid=True), sa.ForeignKey('biomass_lots.id', ondelete='CASCADE'), nullable=False),
        sa.Column('order_id', UUID(as_uuid=True), sa.ForeignKey('biomass_orders.id', ondelete='SET NULL'), nullable=True),
        sa.Column('movement_type', sa.String(24), nullable=False),
        sa.Column('quantity_delta', sa.Numeric(14, 3), nullable=False),
        sa.Column('quantity_before', sa.Numeric(14, 3), nullable=False),
        sa.Column('quantity_after', sa.Numeric(14, 3), nullable=False),
        sa.Column('reason', sa.Text(), nullable=True),
        sa.Column('actor_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.CheckConstraint(
            "movement_type IN ('initial','addition','removal','correction','reservation',"
            "'release','sale','transfer_out','transfer_in','admin_correction')",
            name='ck_stock_movements_type',
        ),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_stock_movements_lot_created', 'stock_movements', ['lot_id', 'created_at'])
    op.create_index('ix_stock_movements_created', 'stock_movements', ['created_at'])

    op.create_table(
        'biomass_audit_events',
        sa.Column('id', UUID(as_uuid=True), nullable=False),
        sa.Column('actor_id', UUID(as_uuid=True), sa.ForeignKey('users.id', ondelete='SET NULL'), nullable=True),
        sa.Column('actor_role', sa.String(20), nullable=False),
        sa.Column('action', sa.String(50), nullable=False),
        sa.Column('entity_type', sa.String(30), nullable=False),
        sa.Column('entity_id', UUID(as_uuid=True), nullable=False),
        sa.Column('reason', sa.Text(), nullable=True),
        sa.Column('detail', JSONB(), nullable=True),
        sa.Column('related_entity_type', sa.String(30), nullable=True),
        sa.Column('related_entity_id', UUID(as_uuid=True), nullable=True),
        sa.Column('created_at', sa.DateTime(timezone=True), server_default=sa.text('now()'), nullable=False),
        sa.PrimaryKeyConstraint('id'),
    )
    op.create_index('ix_biomass_audit_created', 'biomass_audit_events', ['created_at'])
    op.create_index('ix_biomass_audit_entity', 'biomass_audit_events', ['entity_type', 'entity_id'])
    op.create_index('ix_biomass_audit_action', 'biomass_audit_events', ['action'])

    # Append-only enforcement at the database level: even a buggy UPDATE or
    # DELETE (including any future endpoint mistake) is rejected by the
    # server. Audit rows are only ever INSERTed.
    op.execute(
        """
        CREATE OR REPLACE FUNCTION biomass_audit_no_mutation() RETURNS trigger AS $$
        BEGIN
            RAISE EXCEPTION 'biomass_audit_events is append-only';
        END;
        $$ LANGUAGE plpgsql;
        """
    )
    op.execute(
        """
        CREATE TRIGGER biomass_audit_append_only
        BEFORE UPDATE OR DELETE ON biomass_audit_events
        FOR EACH ROW EXECUTE FUNCTION biomass_audit_no_mutation();
        """
    )


def downgrade() -> None:
    op.execute('DROP TRIGGER IF EXISTS biomass_audit_append_only ON biomass_audit_events;')
    op.execute('DROP FUNCTION IF EXISTS biomass_audit_no_mutation();')
    op.drop_table('biomass_audit_events')
    op.drop_table('stock_movements')
    op.drop_table('biomass_orders')
    op.drop_table('biomass_listings')
    op.drop_table('biomass_lots')
