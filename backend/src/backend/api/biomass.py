"""User-facing biomass inventory and marketplace endpoints.

Structure follows the existing backend conventions: thin route handlers
that validate payloads and delegate to the service layer; authentication
and object-level ownership enforced server-side; mutations run the shared
Origin allow-list check; the shared process-local limiter protects the
order-creation path.
"""

import csv
import io
import uuid
from datetime import timedelta
from decimal import Decimal
from typing import Annotated

from fastapi import (
    APIRouter,
    Depends,
    File,
    Form,
    HTTPException,
    Query,
    Request,
    Response,
    UploadFile,
    status,
)
from fastapi.responses import FileResponse
from pydantic import ValidationError
from sqlalchemy import func, select
from sqlalchemy.orm import Session, joinedload, selectinload

from backend.api.auth import _untrusted_origin
from backend.api.db_deps import get_db
from backend.api.dependencies import get_current_user
from backend.biomass_schemas import (
    AdjustRequest,
    ImageOut,
    InventorySummary,
    ListingCard,
    ListingCreateRequest,
    ListingOwn,
    ListingOwnPage,
    ListingPage,
    ListingUpdateRequest,
    LotCreateRequest,
    LotDetail,
    LotOut,
    LotPage,
    LotUpdateRequest,
    MovementOut,
    OrderActionRequest,
    OrderCreateRequest,
    OrderOut,
    OrderPage,
    QuantitySummary,
    SettlementRequest,
    TransferRequest,
    TransferResult,
)
from backend.config import get_settings
from backend.models import (
    BiomassImage,
    BiomassListing,
    BiomassLot,
    BiomassOrder,
    StockMovement,
    User,
)
from backend.rate_limit import enforce_rate_limit
from backend.services import biomass as svc
from backend.services import biomass_images as img_svc

router = APIRouter(prefix="/api/v1/biomass", tags=["biomass"])

LOT_MAX_MOVEMENTS = 50


# ==== image/payload helpers ================================================


def _parse_payload[T](raw_payload: str, model: type[T]) -> T:
    """The JSON half of a multipart create request. validation failures are
    surfaced as the same 422 semantics as a JSON body."""
    try:
        return model.model_validate_json(raw_payload)
    except ValidationError as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"Invalid record payload: {exc.errors()[0].get('msg', 'validation failed')}",
        ) from exc


# ==== summary helpers ======================================================


def _summary_by_unit(lots: list[BiomassLot], attr: str) -> QuantitySummary:
    totals: dict[str, Decimal] = {"kg": Decimal("0"), "t": Decimal("0"), "m3": Decimal("0")}
    used: set[str] = set()
    for lot in lots:
        value = getattr(lot, attr) or Decimal("0")
        totals[lot.unit] = (totals.get(lot.unit, Decimal("0")) + value).quantize(Decimal("0.001"))
        if value > 0:
            used.add(lot.unit)
    # Quantities of different units are never summed together.
    return QuantitySummary(
        kg=str(totals["kg"]) if "kg" in used else None,
        t=str(totals["t"]) if "t" in used else None,
        m3=str(totals["m3"]) if "m3" in used else None,
    )


def build_summary(db: Session, owner: User, period_days: int) -> InventorySummary:
    lots = db.scalars(select(BiomassLot).where(BiomassLot.owner_id == owner.id)).all()
    cutoff = svc.now_utc() - timedelta(days=period_days)
    sold_rows = db.execute(
        select(BiomassLot.unit, func.sum(-StockMovement.quantity_delta))
        .join(BiomassLot, StockMovement.lot_id == BiomassLot.id)
        .where(
            BiomassLot.owner_id == owner.id,
            StockMovement.movement_type.in_(["sale", "transfer_out"]),
            StockMovement.created_at >= cutoff,
        )
        .group_by(BiomassLot.unit)
    ).all()
    sold_by_unit = {row[0]: (row[1] or Decimal("0")).quantize(Decimal("0.001")) for row in sold_rows}

    estimated: dict[str, Decimal] = {}
    priced = 0
    for lot in lots:
        if lot.price_per_unit is not None:
            priced += 1
            value = (lot.quantity_available or Decimal("0")) * lot.price_per_unit
            estimated.setdefault(lot.currency, Decimal("0"))
            estimated[lot.currency] = (estimated[lot.currency] + value).quantize(Decimal("0.01"))

    low_stock = [
        lot.id
        for lot in lots
        if lot.status == "active"
        and lot.quantity_total > 0
        and lot.quantity_available <= svc.LOW_STOCK_FRACTION * lot.quantity_total
    ]
    return InventorySummary(
        total_lots=len(lots),
        active_lots=sum(1 for lot in lots if lot.status == "active"),
        available_by_unit=_summary_by_unit(lots, "quantity_available"),
        reserved_by_unit=_summary_by_unit(lots, "quantity_reserved"),
        sold_period_by_unit=(
            QuantitySummary(**{unit: str(amount) for unit, amount in sold_by_unit.items()})
            if sold_by_unit else QuantitySummary()
        ),
        period_days=period_days,
        estimated_value_by_currency=(
            {cur: str(val) for cur, val in sorted(estimated.items())} or None
        ),
        priced_lots=priced,
        low_stock_lot_ids=low_stock,
    )


# ==== inventory ============================================================


@router.get("/inventory", response_model=LotPage)
def list_inventory(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    search: str | None = Query(default=None, max_length=120),
    status_filter: Annotated[str, Query(pattern="^(active|archived|all)$")] = "active",
    unit: str | None = Query(default=None, pattern="^(kg|t|m3)$"),
    sort: Annotated[str, Query(pattern="^(recent|updated|quantity|price)$")] = "recent",
    period_days: Annotated[int, Query(ge=1, le=365)] = 30,
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> LotPage:
    query = select(BiomassLot).where(BiomassLot.owner_id == current.id)
    count_query = select(func.count()).select_from(BiomassLot).where(BiomassLot.owner_id == current.id)
    if status_filter != "all":
        query = query.where(BiomassLot.status == status_filter)
        count_query = count_query.where(BiomassLot.status == status_filter)
    if search and search.strip():
        pattern = f"%{search.strip().lower()}%"
        text_filter = (
            func.lower(BiomassLot.title).ilike(pattern)
            | func.lower(BiomassLot.material_type).ilike(pattern)
            | func.lower(BiomassLot.category).ilike(pattern)
            | func.lower(BiomassLot.storage_location).ilike(pattern)
        )
        query = query.where(text_filter)
        count_query = count_query.where(text_filter)
    if unit:
        query = query.where(BiomassLot.unit == unit)
        count_query = count_query.where(BiomassLot.unit == unit)
    sort_clauses = {
        "recent": BiomassLot.created_at.desc(),
        "updated": BiomassLot.updated_at.desc(),
        "quantity": BiomassLot.quantity_available.desc(),
        "price": BiomassLot.price_per_unit.desc(),
    }
    total = int(db.scalar(count_query) or 0)
    lots = db.scalars(
        query.options(selectinload(BiomassLot.images))
        .order_by(sort_clauses[sort]).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return LotPage(
        summary=build_summary(db, current, period_days),
        total=total,
        page=page,
        page_size=page_size,
        items=[LotOut.model_validate(lot) for lot in lots],
    )


@router.post("/inventory", response_model=LotOut, status_code=status.HTTP_201_CREATED)
def create_lot(
    request: Request,
    payload: Annotated[str, Form(description="LotCreateRequest JSON")],
    images: Annotated[list[UploadFile] | None, File()] = None,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LotOut:
    """Registers a lot with its 1–5 images (multipart/form-data).

    An image is COMPULSORY: a record without at least one image is rejected.
    Files are validated by content (magic bytes), stored under server-
    generated names, and every row keeps position 1..5 on the record."""
    _untrusted_origin(request)
    enforce_rate_limit(request, "biomass")
    data = _parse_payload(payload, LotCreateRequest)
    lot = svc.create_lot(
        db, current,
        title=data.title,
        category=data.category,
        material_type=data.material_type,
        unit=data.unit,
        quantity=data.quantity,
        storage_location=data.storage_location,
        moisture_percent=data.moisture_percent,
        harvest_date=data.harvest_date,
        source_provenance=data.source_provenance,
        quality_grade=data.quality_grade,
        quality_note=data.quality_note,
        permit_reference=data.permit_reference,
        price_per_unit=data.price_per_unit,
        currency=data.currency,
        images=list(images or []),
    )
    return LotOut.model_validate(lot)


@router.get("/inventory/export.csv")
def export_inventory_csv(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    """CSV export of the caller's OWN inventory (server-side ownership)."""
    lots = db.scalars(
        select(BiomassLot)
        .where(BiomassLot.owner_id == current.id)
        .order_by(BiomassLot.created_at.desc())
    ).all()
    buffer = io.StringIO()
    writer = csv.writer(buffer)
    writer.writerow([
        "id", "title", "category", "material_type", "unit",
        "quantity_total", "quantity_available", "quantity_reserved",
        "quantity_sold", "quantity_transferred", "quantity_removed",
        "moisture_percent", "harvest_date", "source_provenance",
        "storage_location", "quality_grade", "permit_reference",
        "permit_status", "status", "price_per_unit", "currency",
        "created_at", "updated_at",
    ])
    for lot in lots:
        writer.writerow([
            str(lot.id), lot.title, lot.category, lot.material_type, lot.unit,
            lot.quantity_total, lot.quantity_available, lot.quantity_reserved,
            lot.quantity_sold, lot.quantity_transferred, lot.quantity_removed,
            "" if lot.moisture_percent is None else lot.moisture_percent,
            "" if lot.harvest_date is None else lot.harvest_date.isoformat(),
            lot.source_provenance or "", lot.storage_location,
            lot.quality_grade or "", lot.permit_reference or "",
            lot.permit_status, lot.status,
            "" if lot.price_per_unit is None else lot.price_per_unit,
            lot.currency, lot.created_at.isoformat(), lot.updated_at.isoformat(),
        ])
    return Response(
        content=buffer.getvalue(),
        media_type="text/csv; charset=utf-8",
        headers={"Content-Disposition": 'attachment; filename="biomass_inventory.csv"'},
    )


@router.get("/inventory/{lot_id}", response_model=LotDetail)
def get_lot(
    lot_id: uuid.UUID,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LotDetail:
    lot = svc.get_for_owner_or_404(db, lot_id, current)
    movements = db.scalars(
        select(StockMovement)
        .where(StockMovement.lot_id == lot.id)
        .order_by(StockMovement.created_at.desc())
        .limit(LOT_MAX_MOVEMENTS)
    ).all()
    return LotDetail(
        lot=LotOut.model_validate(lot),
        movements=[MovementOut.model_validate(m) for m in movements],
    )


@router.patch("/inventory/{lot_id}", response_model=LotOut)
def update_lot(
    lot_id: uuid.UUID,
    payload: LotUpdateRequest,
    request: Request,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LotOut:
    """Metadata edits only. A payload that tries to set `quantity` is
    rejected with 422 by the schema (never silently ignored) — quantities
    change exclusively through recorded adjustments."""
    _untrusted_origin(request)
    svc.get_for_owner_or_404(db, lot_id, current)
    changes = payload.model_dump(exclude_unset=True)
    changes.pop("quantity", None)
    if not changes:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="No changes requested.")
    lot = svc.update_metadata(db, svc.get_or_404(db, lot_id), current, changes)
    return LotOut.model_validate(lot)


@router.post("/inventory/{lot_id}/adjust", response_model=LotOut)
def adjust_lot(
    lot_id: uuid.UUID,
    payload: AdjustRequest,
    request: Request,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LotOut:
    _untrusted_origin(request)
    enforce_rate_limit(request, "biomass")
    lot = svc.get_for_owner_or_404(db, lot_id, current)
    lot = svc.adjust_quantity(
        db, lot,
        kind=payload.kind,  # type: ignore[arg-type]
        quantity=payload.quantity,
        new_available=payload.new_available,
        reason=payload.reason,
        actor=current,
        is_admin=False,
    )
    return LotOut.model_validate(lot)


@router.post("/inventory/{lot_id}/archive", response_model=LotOut)
def archive_lot(
    lot_id: uuid.UUID,
    request: Request,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LotOut:
    _untrusted_origin(request)
    lot = svc.get_for_owner_or_404(db, lot_id, current)
    return LotOut.model_validate(svc.archive_lot(db, lot, current, is_admin=False))


@router.post("/inventory/{lot_id}/restore", response_model=LotOut)
def restore_lot(
    lot_id: uuid.UUID,
    request: Request,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> LotOut:
    _untrusted_origin(request)
    lot = svc.get_for_owner_or_404(db, lot_id, current)
    return LotOut.model_validate(svc.restore_lot(db, lot, current, is_admin=False))


@router.post("/inventory/{lot_id}/transfer", response_model=TransferResult, status_code=status.HTTP_201_CREATED)
def transfer_lot(
    lot_id: uuid.UUID,
    payload: TransferRequest,
    request: Request,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> TransferResult:
    _untrusted_origin(request)
    enforce_rate_limit(request, "biomass")
    lot = svc.get_for_owner_or_404(db, lot_id, current)
    recipient_email = payload.recipient_email.strip().lower()
    recipient = db.scalar(select(User).where(User.email == recipient_email))
    if recipient is None or not recipient.is_active:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="Recipient account could not be found or is not active.",
        )
    if recipient.id == current.id:
        raise HTTPException(status_code=status.HTTP_400_BAD_REQUEST, detail="You cannot transfer stock to yourself.")
    source, received = svc.transfer_lot(
        db, lot, current, recipient=recipient,
        quantity=payload.quantity, note=payload.note,
    )
    return TransferResult(
        source_lot=LotOut.model_validate(source),
        transferred_lot=LotOut.model_validate(received),
    )


# ==== marketplace ==========================================================


def _listing_card(listing: BiomassListing, lot: BiomassLot, seller_name: str) -> ListingCard:
    return ListingCard(
        id=listing.id,
        title=listing.title,
        description=listing.description,
        category=listing.category,
        material_type=listing.material_type,
        unit=listing.unit,
        location=listing.location,
        quantity_total=listing.quantity_total,
        listing_available=listing.listing_available,
        price_per_unit=listing.price_per_unit,
        currency=listing.currency,
        fulfilment=listing.fulfilment,
        available_from=listing.available_from,
        available_until=listing.available_until,
        quality_grade=lot.quality_grade,
        source_provenance=lot.source_provenance,
        moisture_percent=lot.moisture_percent,
        permit_status=lot.permit_status,
        seller_name=seller_name,
        created_at=listing.created_at,
        images=[ImageOut.model_validate(image) for image in listing.images],
    )


@router.get("/marketplace/listings", response_model=ListingPage)
def browse_listings(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    search: str | None = Query(default=None, max_length=120),
    category: str | None = Query(default=None, max_length=60),
    material_type: str | None = Query(default=None, max_length=80),
    unit: str | None = Query(default=None, pattern="^(kg|t|m3)$"),
    min_quantity: Decimal | None = Query(default=None, gt=0),
    max_price: Decimal | None = Query(default=None, gt=0),
    sort: Annotated[str, Query(pattern="^(recent|price_asc|price_desc|quantity_desc)$")] = "recent",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> ListingPage:
    svc.release_expired_reservations(db)  # availability honesty sweep
    db.commit()
    conditions = [BiomassListing.status == "active", BiomassLot.status == "active"]
    if search and search.strip():
        pattern = f"%{search.strip().lower()}%"
        conditions.append(
            func.lower(BiomassListing.title).ilike(pattern)
            | func.lower(BiomassListing.description).ilike(pattern)
            | func.lower(BiomassListing.material_type).ilike(pattern)
            | func.lower(func.coalesce(BiomassListing.location, "")).ilike(pattern)
        )
    if category:
        conditions.append(BiomassListing.category == category)
    if material_type:
        conditions.append(BiomassListing.material_type == material_type)
    if unit:
        conditions.append(BiomassListing.unit == unit)
    if min_quantity is not None:
        conditions.append(BiomassListing.listing_available >= min_quantity)
    if max_price is not None:
        conditions.append(BiomassListing.price_per_unit <= max_price)
    total = int(db.scalar(
        select(func.count())
        .select_from(BiomassListing)
        .join(BiomassLot, BiomassListing.lot_id == BiomassLot.id)
        .where(*conditions)
    ) or 0)
    sort_clauses = {
        "recent": BiomassListing.created_at.desc(),
        "price_asc": BiomassListing.price_per_unit.asc(),
        "price_desc": BiomassListing.price_per_unit.desc(),
        "quantity_desc": BiomassListing.listing_available.desc(),
    }
    rows = db.execute(
        select(BiomassListing, BiomassLot, User)
        .join(BiomassLot, BiomassListing.lot_id == BiomassLot.id)
        .join(User, BiomassListing.seller_id == User.id)
        .options(selectinload(BiomassListing.images))
        .where(*conditions)
        .order_by(sort_clauses[sort])
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return ListingPage(
        total=total, page=page, page_size=page_size,
        items=[_listing_card(listing, lot, seller.full_name) for listing, lot, seller in rows],
    )


@router.get("/marketplace/listings/{listing_id}", response_model=ListingCard)
def listing_detail(
    listing_id: uuid.UUID,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ListingCard:
    listing = svc.get_visible_listing_or_404(db, listing_id, current)
    if listing.listing_reserved > 0 or listing.seller_id == current.id:
        # Keep the seller's/visitor's view of availability honest: stale
        # expired reservations are released before the numbers are shown.
        svc.release_expired_reservations(db, listing_id=listing.id)
        db.commit()
        db.refresh(listing)
    lot = svc.get_or_404(db, listing.lot_id)
    seller = db.get(User, listing.seller_id)
    return _listing_card(listing, lot, seller.full_name if seller else "Unknown seller")


@router.post("/marketplace/listings", response_model=ListingOwn, status_code=status.HTTP_201_CREATED)
def create_listing(
    request: Request,
    payload: Annotated[str, Form(description="ListingCreateRequest JSON")],
    images: Annotated[list[UploadFile] | None, File()] = None,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ListingOwn:
    """Creates a listing with its 1–5 compulsory images (multipart)."""
    _untrusted_origin(request)
    enforce_rate_limit(request, "biomass")
    data = _parse_payload(payload, ListingCreateRequest)
    listing = svc.create_listing(
        db, data.lot_id, current,
        title=data.title,
        description=data.description,
        quantity=data.quantity,
        price_per_unit=data.price_per_unit,
        fulfilment=data.fulfilment,
        available_from=data.available_from,
        available_until=data.available_until,
        location=data.location,
        publish_now=data.publish_now,
        currency="USD",
        images=list(images or []),
    )
    return _listing_own(listing)


def _listing_own(listing: BiomassListing) -> ListingOwn:
    return ListingOwn(
        id=listing.id,
        lot_id=listing.lot_id,
        title=listing.title,
        description=listing.description,
        category=listing.category,
        material_type=listing.material_type,
        unit=listing.unit,
        location=listing.location,
        quantity_total=listing.quantity_total,
        listing_available=listing.listing_available,
        listing_reserved=listing.listing_reserved,
        quantity_sold=listing.quantity_sold,
        price_per_unit=listing.price_per_unit,
        currency=listing.currency,
        fulfilment=listing.fulfilment,
        available_from=listing.available_from,
        available_until=listing.available_until,
        status=listing.status,
        moderation_note=listing.moderation_note,
        created_at=listing.created_at,
        updated_at=listing.updated_at,
        images=[ImageOut.model_validate(image) for image in listing.images],
    )


@router.get("/marketplace/my/listings", response_model=ListingOwnPage)
def my_listings(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    status_filter: Annotated[
        str, Query(pattern="^(all|draft|active|paused|withdrawn|sold_out|rejected)$")
    ] = "all",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> ListingOwnPage:
    svc.release_expired_reservations(db)
    db.commit()
    query = select(BiomassListing).where(BiomassListing.seller_id == current.id)
    count_query = select(func.count()).select_from(BiomassListing).where(
        BiomassListing.seller_id == current.id
    )
    if status_filter != "all":
        query = query.where(BiomassListing.status == status_filter)
        count_query = count_query.where(BiomassListing.status == status_filter)
    total = int(db.scalar(count_query) or 0)
    listings = db.scalars(
        query.options(selectinload(BiomassListing.images))
        .order_by(BiomassListing.updated_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return ListingOwnPage(
        total=total, page=page, page_size=page_size,
        items=[_listing_own(listing) for listing in listings],
    )


@router.patch("/marketplace/listings/{listing_id}", response_model=ListingOwn)
def edit_listing(
    listing_id: uuid.UUID,
    payload: ListingUpdateRequest,
    request: Request,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> ListingOwn:
    _untrusted_origin(request)
    listing = svc.get_listing_for_seller_or_404(db, listing_id, current)
    changes = payload.model_dump(exclude_unset=True)
    # Fields the seller may deliberately clear keep an explicit None.
    changes = {
        key: (value if value is not None else None)
        for key, value in changes.items()
        if value is not None or key in ("description", "location", "available_from", "available_until")
    }
    listing = svc.edit_listing(db, listing, current, changes)
    return _listing_own(listing)


@router.post("/marketplace/listings/{listing_id}/publish", response_model=ListingOwn)
def publish_listing(
    listing_id: uuid.UUID, request: Request,
    current: User = Depends(get_current_user), db: Session = Depends(get_db),
) -> ListingOwn:
    _untrusted_origin(request)
    listing = svc.listing_transition(
        db, svc.get_listing_for_seller_or_404(db, listing_id, current), current, "active"
    )
    return _listing_own(listing)


@router.post("/marketplace/listings/{listing_id}/pause", response_model=ListingOwn)
def pause_listing(
    listing_id: uuid.UUID, request: Request,
    current: User = Depends(get_current_user), db: Session = Depends(get_db),
) -> ListingOwn:
    _untrusted_origin(request)
    listing = svc.listing_transition(
        db, svc.get_listing_for_seller_or_404(db, listing_id, current), current, "paused"
    )
    return _listing_own(listing)


@router.post("/marketplace/listings/{listing_id}/resume", response_model=ListingOwn)
def resume_listing(
    listing_id: uuid.UUID, request: Request,
    current: User = Depends(get_current_user), db: Session = Depends(get_db),
) -> ListingOwn:
    _untrusted_origin(request)
    listing = svc.listing_transition(
        db, svc.get_listing_for_seller_or_404(db, listing_id, current), current, "active"
    )
    return _listing_own(listing)


@router.post("/marketplace/listings/{listing_id}/withdraw", response_model=ListingOwn)
def withdraw_listing(
    listing_id: uuid.UUID, request: Request,
    current: User = Depends(get_current_user), db: Session = Depends(get_db),
) -> ListingOwn:
    _untrusted_origin(request)
    listing = svc.listing_transition(
        db, svc.get_listing_for_seller_or_404(db, listing_id, current), current, "withdrawn"
    )
    return _listing_own(listing)


# ==== record images ========================================================


@router.get("/images/{image_id}")
def get_image(
    image_id: uuid.UUID,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> FileResponse:
    """Serves one record image to authorized viewers only.

    Lot images: owner (or admin). Listing images: seller (or admin) always;
    any verified user while the listing is active. Everything else is 404 —
    indistinguishable from a nonexistent image, no existence oracle."""
    image = db.get(BiomassImage, image_id)
    if image is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found.")
    if image.lot_id is not None:
        lot = db.get(BiomassLot, image.lot_id)
        if lot is not None and (lot.owner_id == current.id or current.role == "admin"):
            pass
        else:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found.")
    else:
        listing = db.get(BiomassListing, image.listing_id)
        if listing is None:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found.")
        viewer_allowed = (
            listing.seller_id == current.id
            or current.role == "admin"
            or listing.status == "active"
        )
        if not viewer_allowed:
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Image not found.")
    served = img_svc.image_stored_path(image)
    if served is None:
        # Honest failure: metadata without bytes is a broken record.
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="Image file is missing from storage.",
        )
    return FileResponse(served, media_type=image.content_type)


# ==== orders ===============================================================


@router.post(
    "/marketplace/listings/{listing_id}/orders",
    responses={200: {"model": OrderOut}, 201: {"model": OrderOut}},
)
def create_order(
    listing_id: uuid.UUID,
    payload: OrderCreateRequest,
    request: Request,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> Response:
    _untrusted_origin(request)
    enforce_rate_limit(request, "biomass")
    order, created = svc.create_order(
        db, listing_id, current,
        quantity=payload.quantity,
        buyer_note=payload.buyer_note,
        client_request_id=payload.client_request_id,
    )
    return Response(
        content=OrderOut.model_dump_json(_order_out(db, order, current)),
        status_code=status.HTTP_201_CREATED if created else status.HTTP_200_OK,
        media_type="application/json",
    )


@router.get("/marketplace/orders", response_model=OrderPage)
def my_orders(
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
    role: Annotated[str, Query(pattern="^(buying|selling)$")] = "buying",
    status_filter: Annotated[
        str,
        Query(pattern="^(all|open|requested|awaiting_fulfilment|fulfilled|completed|cancelled|rejected|disputed)$"),
    ] = "all",
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> OrderPage:
    svc.release_expired_reservations(db)
    db.commit()
    column = BiomassOrder.buyer_id if role == "buying" else BiomassOrder.seller_id
    query = select(BiomassOrder).where(column == current.id)
    count_query = select(func.count()).select_from(BiomassOrder).where(column == current.id)
    if status_filter != "all":
        condition = (
            BiomassOrder.status.in_(["requested", "awaiting_fulfilment", "fulfilled"])
            if status_filter == "open"
            else BiomassOrder.status == status_filter
        )
        query = query.where(condition)
        count_query = count_query.where(condition)
    total = int(db.scalar(count_query) or 0)
    orders = db.scalars(
        query.order_by(BiomassOrder.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return OrderPage(
        total=total, page=page, page_size=page_size,
        items=[_order_out(db, order, current) for order in orders],
    )


@router.get("/marketplace/orders/{order_id}", response_model=OrderOut)
def order_detail(
    order_id: uuid.UUID,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OrderOut:
    order = svc.get_order_for_participant_or_404(db, order_id, current)
    svc.release_expired_reservations(db, listing_id=order.listing_id)
    if order.status == "requested":
        db.refresh(order)
    db.commit()
    return _order_out(db, order, current)


def _order_out(db: Session, order: BiomassOrder, viewer: User) -> OrderOut:
    counterparty_id = order.seller_id if viewer.id == order.buyer_id else order.buyer_id
    counterparty = db.get(User, counterparty_id)
    listing = db.get(BiomassListing, order.listing_id)
    return OrderOut(
        id=order.id,
        reference=order.reference,
        listing_id=order.listing_id,
        lot_id=order.lot_id,
        buyer_id=order.buyer_id,
        seller_id=order.seller_id,
        quantity=order.quantity,
        unit=order.unit,
        unit_price=order.unit_price,
        total_amount=order.total_amount,
        currency=order.currency,
        status=order.status,
        buyer_note=order.buyer_note,
        # The expiry deadline is only meaningful while the request is open.
        reservation_expires_at=order.reservation_expires_at if order.status == "requested" else None,
        released_at=order.released_at,
        fulfilled_at=order.fulfilled_at,
        completed_at=order.completed_at,
        cancelled_at=order.cancelled_at,
        rejected_at=order.rejected_at,
        disputed_at=order.disputed_at,
        dispute_reason=order.dispute_reason,
        resolution_note=order.resolution_note,
        settlement_status=order.settlement_status,
        settlement_note=order.settlement_note,
        settlement_at=order.settlement_at,
        listing_title=listing.title if listing else None,
        counterparty_name=counterparty.full_name if counterparty else None,
        role="buyer" if viewer.id == order.buyer_id else "seller",
        created_at=order.created_at,
        updated_at=order.updated_at,
    )


def _participant_transition(
    db: Session, order_id: uuid.UUID, current: User, action: str,
    payload: OrderActionRequest | None = None,
) -> OrderOut:
    order = svc.get_order_for_participant_or_404(db, order_id, current)
    if order.status == "disputed" and action != "dispute":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This transaction is frozen while a dispute is open.",
        )
    is_buyer = order.buyer_id == current.id
    if action == "accept" and not is_buyer:
        return _order_out(db, svc.accept_order(db, order_id, current), current)
    if action == "reject" and not is_buyer:
        return _order_out(db, svc.reject_order(db, order_id, current), current)
    if action == "cancel":
        return _order_out(db, svc.cancel_order(db, order_id, current), current)
    if action == "fulfil" and not is_buyer:
        return _order_out(db, svc.fulfil_order(db, order_id, current), current)
    if action == "confirm" and is_buyer:
        return _order_out(db, svc.confirm_order(db, order_id, current), current)
    if action == "dispute":
        reason = ((payload.reason if payload else None) or "").strip()
        if reason == "":
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A dispute reason is required.",
            )
        return _order_out(db, svc.dispute_order(db, order_id, current, reason=reason), current)
    raise HTTPException(
        status_code=status.HTTP_403_FORBIDDEN,
        detail="This action is not available to your role in this transaction.",
    )


@router.post("/marketplace/orders/{order_id}/accept", response_model=OrderOut)
def accept_order(order_id: uuid.UUID, request: Request, current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> OrderOut:
    _untrusted_origin(request)
    return _participant_transition(db, order_id, current, "accept")


@router.post("/marketplace/orders/{order_id}/reject", response_model=OrderOut)
def reject_order(order_id: uuid.UUID, request: Request, current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> OrderOut:
    _untrusted_origin(request)
    return _participant_transition(db, order_id, current, "reject")


@router.post("/marketplace/orders/{order_id}/cancel", response_model=OrderOut)
def cancel_order(order_id: uuid.UUID, request: Request, current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> OrderOut:
    _untrusted_origin(request)
    return _participant_transition(db, order_id, current, "cancel")


@router.post("/marketplace/orders/{order_id}/fulfil", response_model=OrderOut)
def fulfil_order(order_id: uuid.UUID, request: Request, current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> OrderOut:
    _untrusted_origin(request)
    return _participant_transition(db, order_id, current, "fulfil")


@router.post("/marketplace/orders/{order_id}/confirm", response_model=OrderOut)
def confirm_order(order_id: uuid.UUID, request: Request, current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> OrderOut:
    _untrusted_origin(request)
    return _participant_transition(db, order_id, current, "confirm")


@router.post("/marketplace/orders/{order_id}/dispute", response_model=OrderOut)
def dispute_order(order_id: uuid.UUID, payload: OrderActionRequest, request: Request, current: User = Depends(get_current_user), db: Session = Depends(get_db)) -> OrderOut:
    _untrusted_origin(request)
    return _participant_transition(db, order_id, current, "dispute", payload)


@router.post("/marketplace/orders/{order_id}/settlement", response_model=OrderOut)
def settlement_order(
    order_id: uuid.UUID,
    payload: SettlementRequest,
    request: Request,
    current: User = Depends(get_current_user),
    db: Session = Depends(get_db),
) -> OrderOut:
    """The seller records that payment ACTUALLY moved off-platform. This
    project intentionally has no payment provider, so settlement is a
    manual, evidenced-by-note record — never an automatic 'paid' claim."""
    _untrusted_origin(request)
    order = svc.get_order_for_participant_or_404(db, order_id, current)
    if order.buyer_id == current.id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Only the seller can record that payment was received.",
        )
    return _order_out(db, svc.record_settlement(db, order_id, current, note=payload.note), current)
