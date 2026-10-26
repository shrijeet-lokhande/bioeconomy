"""Request/response schemas for the biomass inventory and marketplace API.

Security posture, matching the auth schemas:
- `extra="ignore"` everywhere: client-supplied fields that are not part of
  a contract (notably `owner_id`, `quantity_reserved`, `role`, audit
  fields) are silently dropped and never mapped onto models.
- Quantities are Decimal and serialize as JSON strings (precision-preserving,
  never floats). `null` means unknown — zero is never fabricated.
- Response shapes control what is public: marketplace payloads never carry
  the seller's email or internal identifiers.
"""

from datetime import date, datetime
from decimal import Decimal
from uuid import UUID

from pydantic import BaseModel, ConfigDict, Field, computed_field, field_validator

QTY_PLACES_HINT = "at most three decimal places"


def _clean_text(value: str | None, max_length: int, field_name: str) -> str | None:
    if value is None:
        return None
    stripped = value.strip()
    if not stripped:
        return None
    if len(stripped) > max_length:
        raise ValueError(f"{field_name} must be at most {max_length} characters.")
    return stripped


def _present_text(value: str, max_length: int, field_name: str) -> str:
    stripped = (value or "").strip()
    if not stripped:
        raise ValueError(f"{field_name} must not be blank.")
    if len(stripped) > max_length:
        raise ValueError(f"{field_name} must be at most {max_length} characters.")
    return stripped


# ==== shared response building blocks ======================================


class ImageOut(BaseModel):
    """One record image. `url` points at the authorized image endpoint —
    the endpoints authenticate the caller; there are no static file URLs."""

    model_config = ConfigDict(from_attributes=True)

    id: UUID
    position: int
    original_name: str
    content_type: str
    size_bytes: int
    created_at: datetime

    @computed_field  # type: ignore[prop-decorator]
    @property
    def url(self) -> str:
        return f"/api/v1/biomass/images/{self.id}"


class QuantitySummary(BaseModel):
    """Balance summary per unit — quantities of different units are NEVER
    summed together."""

    kg: str | None = None
    t: str | None = None
    m3: str | None = None


class InventorySummary(BaseModel):
    total_lots: int
    active_lots: int
    available_by_unit: QuantitySummary
    reserved_by_unit: QuantitySummary
    sold_period_by_unit: QuantitySummary
    period_days: int
    estimated_value_by_currency: dict[str, str] | None = None
    priced_lots: int = 0
    low_stock_lot_ids: list[UUID] = []


class LotOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    owner_id: UUID
    title: str
    category: str
    material_type: str
    unit: str
    quantity_total: Decimal
    quantity_available: Decimal
    quantity_reserved: Decimal
    quantity_sold: Decimal
    quantity_transferred: Decimal
    quantity_removed: Decimal
    moisture_percent: Decimal | None
    harvest_date: date | None
    source_provenance: str | None
    storage_location: str
    quality_grade: str | None
    quality_note: str | None
    permit_reference: str | None
    permit_status: str
    status: str
    admin_flag: str | None
    price_per_unit: Decimal | None
    currency: str
    created_at: datetime
    updated_at: datetime
    images: list[ImageOut] = []


class MovementOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    movement_type: str
    quantity_delta: Decimal
    quantity_before: Decimal
    quantity_after: Decimal
    reason: str | None
    created_at: datetime


class LotDetail(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    lot: LotOut
    movements: list[MovementOut]


class LotPage(BaseModel):
    summary: InventorySummary | None
    total: int
    page: int
    page_size: int
    items: list[LotOut]


class LotCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str = Field(min_length=1, max_length=160)
    category: str = Field(min_length=1, max_length=60)
    material_type: str = Field(min_length=1, max_length=80)
    unit: str = Field(pattern="^(kg|t|m3)$")
    # Accepts int/float/str from JSON; the service validates and quantizes.
    quantity: Decimal = Field(gt=0)
    storage_location: str = Field(min_length=1, max_length=200)
    moisture_percent: Decimal | None = None
    harvest_date: date | None = None
    source_provenance: str | None = Field(default=None, max_length=2000)
    quality_grade: str | None = Field(default=None, max_length=60)
    quality_note: str | None = Field(default=None, max_length=2000)
    permit_reference: str | None = Field(default=None, max_length=200)
    price_per_unit: Decimal | None = Field(default=None, ge=0)
    currency: str = Field(default="USD", pattern="^[A-Z]{3}$")

    @field_validator("title", "category", "material_type", "storage_location")
    @classmethod
    def clean_required(cls, value: str, info) -> str:
        return _present_text(value, 200 if "storage" in info.field_name else 160, info.field_name)

    @field_validator("source_provenance", "quality_note")
    @classmethod
    def clean_optional(cls, value: str | None, info) -> str | None:
        return _clean_text(value, 2000, info.field_name)

    @field_validator("quality_grade", "permit_reference")
    @classmethod
    def clean_short_optional(cls, value: str | None, info) -> str | None:
        return _clean_text(value, 60 if info.field_name == "quality_grade" else 200, info.field_name)

    @field_validator("moisture_percent")
    @classmethod
    def moisture_range(cls, value: Decimal | None) -> Decimal | None:
        if value is None:
            return None
        if value < 0 or value > 100:
            raise ValueError("Moisture content must be between 0 and 100 percent.")
        return value


class LotUpdateRequest(BaseModel):
    """Metadata-only edit. A nonexistent QuantityLiteral is explicit so a
    client that tries to overwrite a quantity gets an honest 400 instead of
    silent no-op; unknown unrelated fields stay ignored."""
    model_config = ConfigDict(extra="ignore")

    title: str | None = Field(default=None, min_length=1, max_length=160)
    category: str | None = Field(default=None, min_length=1, max_length=60)
    material_type: str | None = Field(default=None, min_length=1, max_length=80)
    storage_location: str | None = Field(default=None, min_length=1, max_length=200)
    moisture_percent: Decimal | None = Field(default=None, ge=0, le=100)
    harvest_date: date | None = None
    source_provenance: str | None = Field(default=None, max_length=2000)
    quality_grade: str | None = Field(default=None, max_length=60)
    quality_note: str | None = Field(default=None, max_length=2000)
    permit_reference: str | None = Field(default=None, max_length=200)
    price_per_unit: Decimal | None = Field(default=None, ge=0)
    currency: str | None = Field(default=None, pattern="^[A-Z]{3}$")
    quantity: Decimal | None = Field(default=None, exclude=True)

    @field_validator("quantity")
    @classmethod
    def quantity_never_direct(cls, value: Decimal | None) -> Decimal | None:
        if value is not None:
            raise ValueError("Quantity cannot be edited directly; record a stock adjustment instead.")
        return value


class AdjustRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    kind: str = Field(pattern="^(addition|removal|correction)$")
    quantity: Decimal | None = Field(default=None, gt=0)
    new_available: Decimal | None = Field(default=None, ge=0)
    reason: str = Field(min_length=1, max_length=500)

    @field_validator("reason")
    @classmethod
    def clean_reason(cls, value: str) -> str:
        return _present_text(value, 500, "reason")


class TransferRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    recipient_email: str
    quantity: Decimal = Field(gt=0)
    note: str | None = Field(default=None, max_length=500)


class TransferResult(BaseModel):
    source_lot: LotOut
    transferred_lot: LotOut


# ==== listings ==============================================================


class ListingCard(BaseModel):
    """Marketplace discovery card — deliberately exposes NO seller id,
    email, or private lot data."""

    id: UUID
    title: str
    description: str | None
    category: str
    material_type: str
    unit: str
    location: str | None
    quantity_total: Decimal
    listing_available: Decimal
    price_per_unit: Decimal
    currency: str
    fulfilment: str
    available_from: date | None
    available_until: date | None
    quality_grade: str | None
    source_provenance: str | None
    moisture_percent: Decimal | None
    permit_status: str
    seller_name: str
    created_at: datetime
    images: list[ImageOut] = []


class ListingPage(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[ListingCard]


class ListingOwn(BaseModel):
    """Seller's own management view."""

    id: UUID
    lot_id: UUID
    title: str
    description: str | None
    category: str
    material_type: str
    unit: str
    location: str | None
    quantity_total: Decimal
    listing_available: Decimal
    listing_reserved: Decimal
    quantity_sold: Decimal
    price_per_unit: Decimal
    currency: str
    fulfilment: str
    available_from: date | None
    available_until: date | None
    status: str
    moderation_note: str | None
    # Lot-derived display facts for the seller (kept out of public cards
    # except the attributes explicitly copied there).
    permit_status: str | None = None
    quality_grade: str | None = None
    moisture_percent: Decimal | None = None
    created_at: datetime
    updated_at: datetime
    images: list[ImageOut] = []


class ListingOwnPage(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[ListingOwn]


class ListingCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    lot_id: UUID
    title: str = Field(min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    quantity: Decimal = Field(gt=0)
    price_per_unit: Decimal = Field(gt=0)
    fulfilment: str = Field(default="pickup", pattern="^(pickup|delivery|negotiable)$")
    available_from: date | None = None
    available_until: date | None = None
    location: str | None = Field(default=None, max_length=200)
    publish_now: bool = False

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str) -> str:
        return _present_text(value, 160, "title")

    @field_validator("description")
    @classmethod
    def clean_description(cls, value: str | None) -> str | None:
        return _clean_text(value, 2000, "description")

    @field_validator("location")
    @classmethod
    def clean_location(cls, value: str | None) -> str | None:
        return _clean_text(value, 200, "location")


class ListingUpdateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    title: str | None = Field(default=None, min_length=1, max_length=160)
    description: str | None = Field(default=None, max_length=2000)
    quantity_total: Decimal | None = Field(default=None, gt=0)
    price_per_unit: Decimal | None = Field(default=None, gt=0)
    fulfilment: str | None = Field(default=None, pattern="^(pickup|delivery|negotiable)$")
    available_from: date | None = None
    available_until: date | None = None
    location: str | None = Field(default=None, max_length=200)

    @field_validator("title")
    @classmethod
    def clean_title(cls, value: str | None) -> str | None:
        return None if value is None else _present_text(value, 160, "title")

    @field_validator("description", "location")
    @classmethod
    def clean_optional(cls, value: str | None, info) -> str | None:
        return _clean_text(value, 2000 if info.field_name == "description" else 200, info.field_name)


# ==== orders ================================================================


class OrderCreateRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    quantity: Decimal = Field(gt=0)
    buyer_note: str | None = Field(default=None, max_length=300)
    client_request_id: str | None = Field(default=None, max_length=64)


class OrderOut(BaseModel):
    """Participant's transaction view (buyer and seller share this)."""

    id: UUID
    reference: str
    listing_id: UUID
    lot_id: UUID
    buyer_id: UUID
    seller_id: UUID
    quantity: Decimal
    unit: str
    unit_price: Decimal
    total_amount: Decimal
    currency: str
    status: str
    buyer_note: str | None
    reservation_expires_at: datetime | None
    released_at: datetime | None
    fulfilled_at: datetime | None
    completed_at: datetime | None
    cancelled_at: datetime | None
    rejected_at: datetime | None
    disputed_at: datetime | None
    dispute_reason: str | None
    resolution_note: str | None
    settlement_status: str
    settlement_note: str | None
    settlement_at: datetime | None
    listing_title: str | None = None
    counterparty_name: str | None = None
    role: str  # "buyer" | "seller" for this viewer
    created_at: datetime
    updated_at: datetime


class OrderPage(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[OrderOut]


class OrderActionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    reason: str | None = Field(default=None, min_length=1, max_length=500)


class SettlementRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    note: str | None = Field(default=None, max_length=200)


class ResolveDisputeRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    action: str = Field(pattern="^(resume|cancel)$")
    note: str = Field(min_length=1, max_length=500)

    @field_validator("note")
    @classmethod
    def clean_note(cls, value: str) -> str:
        return _present_text(value, 500, "note")


# ==== admin-only shapes =====================================================


class AdminOwnerInfo(BaseModel):
    id: UUID
    full_name: str
    email: str


class AdminLotOut(LotOut):
    owner: AdminOwnerInfo | None = None
    open_listings: int = 0


class AdminLotPage(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[AdminLotOut]


class AdminListingRow(ListingOwn):
    seller: AdminOwnerInfo | None = None


class AdminListingPage(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[AdminListingRow]


class AdminOrderRow(OrderOut):
    role: str | None = None  # meaningless for admins (they are not a party)
    buyer_name: str | None = None
    seller_name: str | None = None


class AdminOrderPage(BaseModel):
    status_breakdown: dict[str, int] | None = None
    total: int
    page: int
    page_size: int
    items: list[AdminOrderRow]


class AdminListingActionRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    reason: str = Field(min_length=1, max_length=500)
    force: bool = False

    @field_validator("reason")
    @classmethod
    def clean_reason(cls, value: str) -> str:
        return _present_text(value, 500, "reason")


class AdminAdjustRequest(AdjustRequest):
    reason: str = Field(min_length=1, max_length=500)


class AdminReasonRequest(BaseModel):
    model_config = ConfigDict(extra="ignore")

    note: str | None = Field(default=None, max_length=300)


class AuditEventOut(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: UUID
    actor_id: UUID | None
    actor_role: str
    action: str
    entity_type: str
    entity_id: UUID
    reason: str | None
    detail: dict | None
    related_entity_type: str | None
    related_entity_id: UUID | None
    created_at: datetime


class AdminLotSummary(BaseModel):
    """Admin biomass overview metrics. All values derive from live DB
    queries — nothing here is a hardcoded stat."""

    total_lots: int
    active_lots: int
    archived_lots: int
    active_listings: int
    paused_listings: int
    withdrawn_listings: int
    rejected_listings: int
    orders: dict[str, int]
    disputed_orders: int
    movements_30d: int
    recent_events: list[AuditEventOut]


class AuditPage(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[AuditEventOut]


# ==== admin permanent deletion ==============================================


class AdminDeletionRequest(BaseModel):
    """The explicit confirmation: the record's exact title, retyped."""

    confirm_title: str = Field(min_length=1, max_length=160)


class AdminDeletionResult(BaseModel):
    """Deletion outcome, honest about the two-phase (DB + files) process.

    `status` is "completed" when the database purge and the file cleanup
    both succeeded, and "pending_cleanup" when the record is gone but some
    image files could not be removed yet (retryable via a repeated
    request). """

    entity_type: str
    entity_id: UUID
    status: str
    removed_files: int
    missing_files: int
    failed_files: int
