"""ORM models: users and auth sessions.

Minimal schema for the authentication task; geospatial/PostGIS types are
deliberately not used. Timestamps are timezone-aware.
"""

import uuid
from datetime import date, datetime, timedelta
from decimal import Decimal

from sqlalchemy import (
    DATE,
    Boolean,
    CheckConstraint,
    DateTime,
    ForeignKey,
    Index,
    Numeric,
    String,
    Text,
    UniqueConstraint,
    func,
)
from sqlalchemy.dialects.postgresql import JSONB, UUID
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


# ===========================================================================
# Biomass inventory and marketplace (this task)
#
# Quantity model — every mutable balance is a running counter that is ONLY
# written by the service layer inside database transactions with row locks;
# no API route ever sets a quantity directly. stock_movements records every
# change with before/after values, so any lot's history reconciles against
# its balances. NUMERIC everywhere — never floats — and unknown is NULL,
# never zero.
# ===========================================================================


ALLOWED_UNITS = ("kg", "t", "m3")
ALLOWED_PERMIT_STATUSES = ("not_provided", "unverified")
ALLOWED_LOT_STATUSES = ("active", "archived")
ALLOWED_LISTING_STATUSES = (
    "draft",
    "active",
    "paused",
    "withdrawn",
    "sold_out",
    "rejected",
)
ALLOWED_ORDER_STATUSES = (
    "requested",
    "awaiting_fulfilment",
    "fulfilled",
    "completed",
    "cancelled",
    "rejected",
    "disputed",
)
ALLOWED_MOVEMENT_TYPES = (
    "initial",
    "addition",
    "removal",
    "correction",
    "reservation",
    "release",
    "sale",
    "transfer_out",
    "transfer_in",
    "admin_correction",
)
ALLOWED_SETTLEMENT_STATUSES = ("pending", "settled")


class BiomassLot(Base):
    """A stock lot: one owner's registered quantity of a biomass material."""

    __tablename__ = "biomass_lots"
    __table_args__ = (
        CheckConstraint(
            "unit IN ('kg','t','m3')", name="ck_biomass_lots_unit"
        ),
        CheckConstraint(
            "permit_status IN ('not_provided','unverified')",
            name="ck_biomass_lots_permit_status",
        ),
        CheckConstraint("status IN ('active','archived')", name="ck_biomass_lots_status"),
        CheckConstraint(
            "quantity_available >= 0 AND quantity_reserved >= 0 "
            "AND quantity_total >= 0 AND quantity_sold >= 0 "
            "AND quantity_transferred >= 0 AND quantity_removed >= 0",
            name="ck_biomass_lots_nonneg",
        ),
        CheckConstraint(
            "moisture_percent IS NULL OR (moisture_percent >= 0 AND moisture_percent <= 100)",
            name="ck_biomass_lots_moisture_range",
        ),
        CheckConstraint(
            "price_per_unit IS NULL OR price_per_unit >= 0",
            name="ck_biomass_lots_price_nonneg",
        ),
        Index("ix_biomass_lots_owner_status", "owner_id", "status"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    owner_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    # Coarse grouping (e.g. "Forestry", "Agricultural") chosen from a fixed
    # site taxonomy; material_type is the specific material, free-form.
    category: Mapped[str] = mapped_column(String(60), nullable=False)
    material_type: Mapped[str] = mapped_column(String(80), nullable=False)
    unit: Mapped[str] = mapped_column(String(4), nullable=False)

    # Running balances (see module docstring): quantity_total is the gross ever
    # admitted; available is sellable now; reserved is committed to orders;
    # sold/transferred/removed are the outflows. Corrections change only
    # available (+ the movement record), never the gross history.
    quantity_total: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False, default=Decimal("0"))
    quantity_available: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False, default=Decimal("0"))
    quantity_reserved: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False, default=Decimal("0"))
    quantity_sold: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False, default=Decimal("0"))
    quantity_transferred: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False, default=Decimal("0"))
    quantity_removed: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False, default=Decimal("0"))

    # Unknown values stay NULL (never 0, per project data rules).
    moisture_percent: Mapped[Decimal | None] = mapped_column(Numeric(5, 2), nullable=True)
    harvest_date: Mapped[date | None] = mapped_column(DATE, nullable=True)
    # Free-text provenance/source description; NOT a verification claim.
    source_provenance: Mapped[str | None] = mapped_column(Text, nullable=True)
    storage_location: Mapped[str] = mapped_column(String(200), nullable=False)
    quality_grade: Mapped[str | None] = mapped_column(String(60), nullable=True)
    quality_note: Mapped[str | None] = mapped_column(Text, nullable=True)

    # Sustainability/permit references are recorded textually only. There is
    # no authoritative permit database in this project yet, so the status can
    # only ever be 'not_provided' or 'unverified' (review required) — nothing
    # in the system is allowed to claim a permit was verified.
    permit_reference: Mapped[str | None] = mapped_column(String(200), nullable=True)
    permit_status: Mapped[str] = mapped_column(
        String(20), nullable=False, default="not_provided", server_default="not_provided"
    )

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="active", server_default="active")
    # Set only by administrators; shown to the owner as an honest review note.
    admin_flag: Mapped[str | None] = mapped_column(String(300), nullable=True)

    price_per_unit: Mapped[Decimal | None] = mapped_column(Numeric(14, 2), nullable=True)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD", server_default="USD")

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    owner: Mapped[User] = relationship()
    movements: Mapped[list["StockMovement"]] = relationship(
        back_populates="lot", cascade="all, delete-orphan", order_by="StockMovement.created_at"
    )
    listings: Mapped[list["BiomassListing"]] = relationship(back_populates="lot")
    # Gallery of this record: 1..5 uploaded images, ordered by position.
    images: Mapped[list["BiomassImage"]] = relationship(
        cascade="all, delete-orphan",
        order_by="BiomassImage.position",
    )


class BiomassListing(Base):
    """A marketplace offer backed by an owned, active stock lot."""

    __tablename__ = "biomass_listings"
    __table_args__ = (
        CheckConstraint(
            "unit IN ('kg','t','m3')", name="ck_biomass_listings_unit"
        ),
        CheckConstraint(
            "status IN ('draft','active','paused','withdrawn','sold_out','rejected')",
            name="ck_biomass_listings_status",
        ),
        CheckConstraint(
            "fulfilment IN ('pickup','delivery','negotiable')",
            name="ck_biomass_listings_fulfilment",
        ),
        CheckConstraint(
            "listing_available >= 0 AND listing_reserved >= 0 AND quantity_sold >= 0",
            name="ck_biomass_listings_nonneg",
        ),
        CheckConstraint("price_per_unit > 0", name="ck_biomass_listings_price_positive"),
        Index("ix_biomass_listings_seller_status", "seller_id", "status"),
        Index("ix_biomass_listings_status_material", "status", "material_type"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("biomass_lots.id", ondelete="RESTRICT"), nullable=False
    )
    seller_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    title: Mapped[str] = mapped_column(String(160), nullable=False)
    description: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Denormalized display data copied from the lot at creation (tests assert
    # consistency with the lot's balances; the lot stays the source of truth).
    category: Mapped[str] = mapped_column(String(60), nullable=False)
    material_type: Mapped[str] = mapped_column(String(80), nullable=False)
    unit: Mapped[str] = mapped_column(String(4), nullable=False)
    # Seller-entered display location (district/region). Intentionally NOT
    # copied from lot.storage_location — the physical storage point of the
    # lot is owner-private information.
    location: Mapped[str | None] = mapped_column(String(200), nullable=True)

    quantity_total: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    # What is still requestable; reserved is committed to live orders; sold
    # grows when fulfilment is confirmed.
    listing_available: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    listing_reserved: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False, default=Decimal("0"))
    quantity_sold: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False, default=Decimal("0"))

    price_per_unit: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False, default="USD", server_default="USD")
    fulfilment: Mapped[str] = mapped_column(String(20), nullable=False, default="pickup", server_default="pickup")
    available_from: Mapped[date | None] = mapped_column(DATE, nullable=True)
    available_until: Mapped[date | None] = mapped_column(DATE, nullable=True)

    status: Mapped[str] = mapped_column(String(20), nullable=False, default="draft", server_default="draft")
    # Admin moderation reason (reject/suspend). Set ONLY by admin code.
    moderation_note: Mapped[str | None] = mapped_column(String(300), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    lot: Mapped[BiomassLot] = relationship(back_populates="listings")
    seller: Mapped[User] = relationship()
    orders: Mapped[list["BiomassOrder"]] = relationship(back_populates="listing")
    images: Mapped[list["BiomassImage"]] = relationship(
        cascade="all, delete-orphan",
        order_by="BiomassImage.position",
    )


class BiomassOrder(Base):
    """A purchase request carrying its own stock reservation.

    Lifecycle: requested → (seller accepts) awaiting_fulfilment → (seller
    fulfils — the ONLY point where stock ownership moves) fulfilled →
    (buyer confirms) completed. requested/awaiting may be cancelled or
    rejected, which releases the reservation exactly once. Disputed freezes
    everything until an administrator resolves it.
    """

    __tablename__ = "biomass_orders"
    __table_args__ = (
        CheckConstraint(
            "status IN ('requested','awaiting_fulfilment','fulfilled','completed',"
            "'cancelled','rejected','disputed')",
            name="ck_biomass_orders_status",
        ),
        CheckConstraint(
            "settlement_status IN ('pending','settled')",
            name="ck_biomass_orders_settlement",
        ),
        CheckConstraint("quantity > 0", name="ck_biomass_orders_quantity_positive"),
        CheckConstraint("unit_price >= 0", name="ck_biomass_orders_price_nonneg"),
        UniqueConstraint("reference", name="uq_biomass_orders_reference"),
        UniqueConstraint("client_request_id", name="uq_biomass_orders_client_request_id"),
        Index("ix_biomass_orders_buyer", "buyer_id", "status"),
        Index("ix_biomass_orders_seller", "seller_id", "status"),
        Index("ix_biomass_orders_listing", "listing_id", "status"),
        # A plain UNIQUE(listing_id, buyer_id) is deliberately NOT added — it
        # would block legitimate repeat purchases. Duplicate 'requested'
        # orders are prevented in the service layer, and client_request_id
        # makes retries idempotent.
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    # Human-usable reference generated server-side (BO-XXXXXXXX).
    reference: Mapped[str] = mapped_column(String(24), nullable=False)
    listing_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("biomass_listings.id", ondelete="RESTRICT"), nullable=False
    )
    lot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("biomass_lots.id", ondelete="RESTRICT"), nullable=False
    )
    buyer_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )
    seller_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="RESTRICT"), nullable=False
    )

    quantity: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    unit: Mapped[str] = mapped_column(String(4), nullable=False)
    # Price snapshot taken at request time — later listing re-pricing never
    # rewrites an existing order.
    unit_price: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    total_amount: Mapped[Decimal] = mapped_column(Numeric(14, 2), nullable=False)
    currency: Mapped[str] = mapped_column(String(3), nullable=False)

    status: Mapped[str] = mapped_column(String(24), nullable=False, default="requested", server_default="requested")
    buyer_note: Mapped[str | None] = mapped_column(String(300), nullable=True)
    # Optional client-generated idempotency key; replaying it returns the same
    # order rather than creating a second one.
    client_request_id: Mapped[str | None] = mapped_column(String(64), nullable=True)

    # The reservation sits on this row: while status is requested/accepted the
    # quantity is subtracted from the listing/lot available counters.
    reservation_expires_at: Mapped[datetime] = mapped_column(DateTime(timezone=True), nullable=False)
    released_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    fulfilled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    completed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    cancelled_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    rejected_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)
    disputed_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Dispute handling: previous status is kept so an administrator can resume
    # exactly where the transaction was — no silent rewriting of history.
    dispute_reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    dispute_previous_status: Mapped[str | None] = mapped_column(String(24), nullable=True)
    resolution_note: Mapped[str | None] = mapped_column(Text, nullable=True)
    resolved_by: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    resolved_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    # Manual/off-platform settlement record (there is deliberately NO payment
    # provider integration): the seller records that money actually moved.
    settlement_status: Mapped[str] = mapped_column(String(20), nullable=False, default="pending", server_default="pending")
    settlement_note: Mapped[str | None] = mapped_column(String(200), nullable=True)
    settlement_at: Mapped[datetime | None] = mapped_column(DateTime(timezone=True), nullable=True)

    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )

    listing: Mapped[BiomassListing] = relationship(back_populates="orders")
    lot: Mapped[BiomassLot] = relationship()
    buyer: Mapped[User] = relationship(foreign_keys=[buyer_id])
    seller: Mapped[User] = relationship(foreign_keys=[seller_id])


class StockMovement(Base):
    """Append-only journal of every quantity change on a lot.

    quantity_delta is the signed effect on the lot's AVAILABLE balance;
    quantity_before/quantity_after record the available balance around the
    change. No code path may write a movement without updating the lot in
    the same transaction.
    """

    __tablename__ = "stock_movements"
    __table_args__ = (
        CheckConstraint(
            "movement_type IN ('initial','addition','removal','correction','reservation',"
            "'release','sale','transfer_out','transfer_in','admin_correction')",
            name="ck_stock_movements_type",
        ),
        Index("ix_stock_movements_lot_created", "lot_id", "created_at"),
        Index("ix_stock_movements_created", "created_at"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lot_id: Mapped[uuid.UUID] = mapped_column(
        UUID(as_uuid=True), ForeignKey("biomass_lots.id", ondelete="CASCADE"), nullable=False
    )
    # Set when the movement belongs to an order (reservation/release/sale).
    order_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("biomass_orders.id", ondelete="SET NULL"), nullable=True
    )
    movement_type: Mapped[str] = mapped_column(String(24), nullable=False)
    quantity_delta: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    quantity_before: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    quantity_after: Mapped[Decimal] = mapped_column(Numeric(14, 3), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    # Actor who caused the movement (buyer/seller/admin); NULL = system.
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    lot: Mapped[BiomassLot] = relationship(back_populates="movements")


class BiomassAuditEvent(Base):
    """Append-only audit trail for biomass operations.

    Written by trusted service code only; no API endpoint can create,
    modify, or delete entries, and a DB trigger enforces append-only
    behaviour even against SQL mistakes. detail carries before/after and
    context but deliberately excludes the allowed private payload fields.
    """

    __tablename__ = "biomass_audit_events"
    __table_args__ = (
        Index("ix_biomass_audit_created", "created_at"),
        Index("ix_biomass_audit_entity", "entity_type", "entity_id"),
        Index("ix_biomass_audit_action", "action"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    actor_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("users.id", ondelete="SET NULL"), nullable=True
    )
    actor_role: Mapped[str] = mapped_column(String(20), nullable=False)
    action: Mapped[str] = mapped_column(String(50), nullable=False)
    entity_type: Mapped[str] = mapped_column(String(30), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    reason: Mapped[str | None] = mapped_column(Text, nullable=True)
    detail: Mapped[dict | None] = mapped_column(JSONB, nullable=True)
    related_entity_type: Mapped[str | None] = mapped_column(String(30), nullable=True)
    related_entity_id: Mapped[uuid.UUID | None] = mapped_column(UUID(as_uuid=True), nullable=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )


class BiomassImage(Base):
    """An uploaded image attached to EXACTLY one biomass record.

    Either a lot (inventory gallery) or a listing (marketplace gallery) —
    enforced by a CHECK constraint. File bytes live OUTSIDE the database in
    the configured upload directory under a server-generated name (the
    client-supplied filename and content type are never trusted: the actual
    type comes from magic-byte inspection, and stored names are random so
    path traversal/collisions are impossible). `original_name` is kept for
    display/fallback purposes only.

    1..5 images per record is a service-layer rule (row counts cannot be a
    constraint in SQL); `position` is 1..5 per parent via unique constraints.
    """

    __tablename__ = "biomass_images"
    __table_args__ = (
        CheckConstraint(
            "(lot_id IS NULL) <> (listing_id IS NULL)",
            name="ck_biomass_images_parent",
        ),
        CheckConstraint(
            "position >= 1 AND position <= 5", name="ck_biomass_images_position"
        ),
        CheckConstraint("size_bytes > 0", name="ck_biomass_images_size"),
        CheckConstraint(
            "content_type IN ('image/jpeg','image/png','image/webp')",
            name="ck_biomass_images_type",
        ),
        UniqueConstraint("lot_id", "position", name="uq_biomass_images_lot_position"),
        UniqueConstraint("listing_id", "position", name="uq_biomass_images_listing_position"),
        Index("ix_biomass_images_listing", "listing_id", "position"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    lot_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("biomass_lots.id", ondelete="CASCADE"), nullable=True
    )
    listing_id: Mapped[uuid.UUID | None] = mapped_column(
        UUID(as_uuid=True), ForeignKey("biomass_listings.id", ondelete="CASCADE"), nullable=True
    )
    position: Mapped[int]
    # Server-generated (uuid hex + sniffed extension); client names never touch disk.
    stored_name: Mapped[str] = mapped_column(String(120), nullable=False, unique=True)
    # Original client filename, sanitized to its basename; display only.
    original_name: Mapped[str] = mapped_column(String(255), nullable=False)
    # The sniffed media type — not the client's declared one.
    content_type: Mapped[str] = mapped_column(String(80), nullable=False)
    size_bytes: Mapped[int]
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )

    lot: Mapped[BiomassLot | None] = relationship(viewonly=True)
    listing: Mapped[BiomassListing | None] = relationship(viewonly=True)


class BiomassDeletionCleanup(Base):
    """Reliable-deletion tracking for admin purges.

    A purge commits in ONE transaction: dependent rows and the record itself
    disappear together, and this row is written listing the EXACT storage
    keys that belonged to the deleted record. File bytes are then removed
    from disk AFTER the commit (files and DB cannot share one atomic
    transaction). If that file phase fails or the process dies, the row
    stays 'pending' — the deletion is retryable and idempotent, and a
    successfully deleted record is never served again either way.
    """

    __tablename__ = "biomass_deletion_cleanups"
    __table_args__ = (
        CheckConstraint(
            "entity_type IN ('lot','listing')", name="ck_biomass_deletion_cleanups_type"
        ),
        CheckConstraint(
            "status IN ('pending','completed')",
            name="ck_biomass_deletion_cleanups_status",
        ),
        UniqueConstraint("entity_type", "entity_id", name="uq_biomass_deletion_cleanups_entity"),
    )

    id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), primary_key=True, default=uuid.uuid4)
    entity_type: Mapped[str] = mapped_column(String(10), nullable=False)
    entity_id: Mapped[uuid.UUID] = mapped_column(UUID(as_uuid=True), nullable=False)
    # The server-generated stored names of every image file that belonged to
    # the deleted record — resolved from DB metadata, never client input.
    storage_keys: Mapped[list] = mapped_column(JSONB, nullable=False, default=list)
    status: Mapped[str] = mapped_column(String(10), nullable=False, default="pending")
    attempts: Mapped[int] = mapped_column(default=0, nullable=False)
    removed_files: Mapped[int] = mapped_column(default=0, nullable=False)
    missing_files: Mapped[int] = mapped_column(default=0, nullable=False)
    failed_files: Mapped[int] = mapped_column(default=0, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now()
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime(timezone=True), nullable=False, server_default=func.now(), onupdate=func.now()
    )


# Default reservation lifetime for a freshly requested order.
RESERVATION_LIFETIME = timedelta(hours=72)
