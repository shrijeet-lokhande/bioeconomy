"""Biomass inventory, marketplace and order lifecycle services.

Design rules enforced here (NOT in the routers):
- Quantities/money are Decimal (NUMERIC(14,3)/(14,2) in the DB). No float.
- No API may overwrite a quantity directly. Every change is a recorded
  StockMovement inside the same DB transaction, with before/after values.
- State-changing operations lock the affected rows with SELECT … FOR UPDATE
  (listing row first, then lot row, consistently) and RE-VALIDATE the
  current status/quantities from those locked rows, so concurrent requests
  cannot oversell or double-release.
- Reservations live on BiomassOrder rows; releasing is done exactly once,
  guarded by released_at plus the status check on the locked order.
- Unknown values are None end-to-end; zero means measured zero.
- Domain errors raise HTTPException with safe, actionable messages.
"""

import secrets
import uuid
from datetime import datetime, timezone
from decimal import ROUND_HALF_UP, Decimal, InvalidOperation
from typing import Literal

from fastapi import HTTPException, status
from sqlalchemy import func, select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session, selectinload

from backend.models import (
    RESERVATION_LIFETIME,
    BiomassListing,
    BiomassLot,
    BiomassOrder,
    StockMovement,
    User,
)
from backend.services.audit import record_event

# ==== constants and small helpers ==========================================

QTY_SCALE = Decimal("0.001")  # kg/m3 precision: thousands, not float math
PRICE_SCALE = Decimal("0.01")
QTY_MAX = Decimal("100000000")  # 100e6 units — a sane sanity bound
PRICE_MAX = Decimal("1000000")
ALLOWED_UNIT_VALUES = ("kg", "t", "m3")
LOW_STOCK_FRACTION = Decimal("0.20")  # ≤20% of the gross ever admitted


def q(value: Decimal | str | int) -> Decimal:
    """Validates/normalizes a user-entered quantity to the storage scale.

    Rejects negative, zero where not allowed, NaN/Infinity, and values
    that need more than 3 decimals (float-style noise is a client error).
    """
    try:
        dec = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Quantity is not a valid number.",
        ) from exc
    if not dec.is_finite():
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Quantity must be a finite number.",
        )
    if dec < 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Quantity cannot be negative.",
        )
    if dec > QTY_MAX:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Quantity exceeds the supported maximum.",
        )
    if dec != dec.quantize(QTY_SCALE):
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Quantity supports at most three decimal places.",
        )
    return dec.quantize(QTY_SCALE)


def money(value: Decimal | str | int) -> Decimal:
    """Validates/normalizes a price to money scale (2 decimals, ≥ 0)."""
    try:
        dec = value if isinstance(value, Decimal) else Decimal(str(value))
    except (InvalidOperation, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Price is not a valid number.",
        ) from exc
    if not dec.is_finite() or dec < 0 or dec > PRICE_MAX:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Price must be a number between 0 and 1,000,000.",
        )
    return dec.quantize(PRICE_SCALE, rounding=ROUND_HALF_UP)


def now_utc() -> datetime:
    return datetime.now(timezone.utc)


def _positive(amount: Decimal, field: str) -> Decimal:
    if amount <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"{field} must be greater than zero.",
        )
    return amount


# ==== movement application =================================================


def _apply_movement(
    db: Session,
    lot: BiomassLot,
    movement_type: str,
    delta: Decimal,
    *,
    actor: User | None,
    reason: str | None = None,
    order: BiomassOrder | None = None,
) -> StockMovement:
    """Records one movement and updates the lot's AVAILABLE balance.

    The caller must already hold the row lock on `lot` and must have
    validated the transition; this function raises only if the invariant
    would be violated (never silently).
    """
    delta = delta.quantize(QTY_SCALE)
    before = lot.quantity_available.quantize(QTY_SCALE)
    after = (before + delta).quantize(QTY_SCALE)
    if after < 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Not enough available quantity for this operation.",
        )
    lot.quantity_available = after
    if movement_type in {"reservation", "release", "sale"}:
        # reserved counter moves with the reservation; sale converts the
        # reserved commitment into a shipped quantity (available unchanged).
        if movement_type == "reservation":
            lot.quantity_reserved = (lot.quantity_reserved + (-delta)).quantize(QTY_SCALE)
        elif movement_type == "release":
            lot.quantity_reserved = (lot.quantity_reserved - delta).quantize(QTY_SCALE)
            if lot.quantity_reserved < 0:
                raise HTTPException(
                    status_code=status.HTTP_409_CONFLICT,
                    detail="Reservation bookkeeping error — nothing to release.",
                )
        elif movement_type == "sale":
            lot.quantity_sold = (lot.quantity_sold + (-delta)).quantize(QTY_SCALE)
            lot.quantity_reserved = (lot.quantity_reserved - (-delta)).quantize(QTY_SCALE)
    if movement_type in {"initial", "addition", "transfer_in"}:
        lot.quantity_total = (lot.quantity_total + delta).quantize(QTY_SCALE)
    elif movement_type == "removal":
        lot.quantity_total = (lot.quantity_total - (-delta)).quantize(QTY_SCALE)
        lot.quantity_removed = (lot.quantity_removed + (-delta)).quantize(QTY_SCALE)
    elif movement_type == "transfer_out":
        lot.quantity_transferred = (lot.quantity_transferred + (-delta)).quantize(QTY_SCALE)
        lot.quantity_total = (lot.quantity_total - (-delta)).quantize(QTY_SCALE)
    movement = StockMovement(
        lot_id=lot.id,
        order_id=None if order is None else order.id,
        movement_type=movement_type,
        quantity_delta=delta,
        quantity_before=before,
        quantity_after=after,
        reason=reason,
        actor_id=None if actor is None else actor.id,
    )
    db.add(movement)
    return movement


def _lock_lot(db: Session, lot_id: uuid.UUID) -> BiomassLot:
    lot = db.scalars(
        select(BiomassLot).where(BiomassLot.id == lot_id).with_for_update()
    ).first()
    if lot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory record not found.")
    return lot


def _lock_listing(db: Session, listing_id: uuid.UUID) -> BiomassListing:
    listing = db.scalars(
        select(BiomassListing).where(BiomassListing.id == listing_id).with_for_update()
    ).first()
    if listing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found.")
    return listing


# ==== inventory (user) =====================================================


def create_lot(
    db: Session,
    owner: User,
    *,
    title: str,
    category: str,
    material_type: str,
    unit: str,
    quantity: Decimal,
    storage_location: str,
    moisture_percent: Decimal | None,
    harvest_date,
    source_provenance: str | None,
    quality_grade: str | None,
    quality_note: str | None,
    permit_reference: str | None,
    price_per_unit: Decimal | None,
    currency: str,
    images: list | None = None,
) -> BiomassLot:
    """Registers a lot. `images` are the uploads validated by
    services.biomass_images.validate_images — a record NEVER exists without
    its compulsory 1..5 images: they are validated first (client errors
    raise before anything is written), then persisted inside THIS
    transaction, so the gallery and the lot commit together."""
    from backend.services import biomass_images as img_svc

    # Validate FIRST: a client error raises before any record exists.
    validated = img_svc.validate_images(images or [])
    qty = _positive(q(quantity), "Quantity")
    if unit not in ALLOWED_UNIT_VALUES:
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unsupported unit.")
    # Balances start at zero; the 'initial' movement below is the single
    # writer that brings both up to the registered quantity.
    lot = BiomassLot(
        owner_id=owner.id,
        title=title,
        category=category,
        material_type=material_type,
        unit=unit,
        quantity_total=Decimal("0"),
        quantity_available=Decimal("0"),
        moisture_percent=moisture_percent,
        harvest_date=harvest_date,
        source_provenance=source_provenance,
        storage_location=storage_location,
        quality_grade=quality_grade,
        quality_note=quality_note,
        permit_reference=permit_reference,
        permit_status="unverified" if permit_reference else "not_provided",
        price_per_unit=None if price_per_unit is None else money(price_per_unit),
        currency=currency,
        status="active",
    )
    db.add(lot)
    db.flush()
    _apply_movement(
        db, lot, "initial", qty, actor=owner, reason="Initial registered quantity"
    )
    record_event(db, "lot.created", owner, "lot", lot.id, detail={
        "title": lot.title, "quantity": str(qty), "unit": unit,
        "images": len(validated),
    })
    # Gallery rows join the SAME transaction — the record never exists
    # without its compulsory images.
    img_svc.persist_images(db, kind="lot", parent_id=lot.id, validated=validated)
    db.commit()
    db.refresh(lot)
    return lot


def get_or_404(db: Session, lot_id: uuid.UUID) -> BiomassLot:
    lot = db.get(BiomassLot, lot_id)
    if lot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory record not found.")
    return lot


def get_for_owner_or_404(db: Session, lot_id: uuid.UUID, owner: User) -> BiomassLot:
    """Object-level authorization: a lot that isn't the caller's is
    indistinguishable from one that doesn't exist (404, no oracle)."""
    lot = get_or_404(db, lot_id)
    if lot.owner_id != owner.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory record not found.")
    return lot


def update_metadata(
    db: Session, lot: BiomassLot, actor: User, changes: dict
) -> BiomassLot:
    """Edits permitted metadata only — never a quantity (adjust instead)."""
    allowed = {
        "title", "category", "material_type", "storage_location",
        "moisture_percent", "harvest_date", "source_provenance",
        "quality_grade", "quality_note", "permit_reference",
        "price_per_unit", "currency",
    }
    before = {k: getattr(lot, k) for k in changes}
    for key, value in changes.items():
        if key not in allowed:  # defensive; schemas restrict already
            continue
        if key == "price_per_unit" and value is not None:
            value = money(value)
        if key == "moisture_percent" and value is not None:
            value = value.quantize(Decimal("0.01"))
        setattr(lot, key, value)
    if changes.get("permit_reference") is not None:
        lot.permit_status = "unverified"
    record_event(
        db, "lot.metadata_updated", actor, "lot", lot.id,
        detail={
            "before": {k: str(v) if v is not None else None for k, v in before.items()},
            "after": {k: str(getattr(lot, k)) for k in changes},
        },
    )
    db.commit()
    db.refresh(lot)
    return lot


def adjust_quantity(
    db: Session,
    lot: BiomassLot,
    *,
    kind: Literal["addition", "removal", "correction"],
    quantity: Decimal | None,
    new_available: Decimal | None,
    reason: str,
    actor: User,
    is_admin: bool,
) -> BiomassLot:
    lot = _lock_lot(db, lot.id)
    if lot.status != "active":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Archived inventory cannot be adjusted."
        )
    if kind == "correction":
        if new_available is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="A correction requires the corrected available quantity.",
            )
        target = q(new_available)
        delta = (target - lot.quantity_available).quantize(QTY_SCALE)
        action = "admin.lot.corrected" if is_admin else "lot.adjusted"
        movement_type = "admin_correction" if is_admin else "correction"
        if delta == 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Corrected quantity equals the current balance.",
            )
    else:
        if quantity is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"An {kind} requires a quantity.",
            )
        amount = _positive(q(quantity), "Quantity")
        delta = amount if kind == "addition" else -amount
        if kind == "removal" and amount > lot.quantity_available:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Removal exceeds the available quantity.",
            )
        action = "lot.adjusted"
        movement_type = kind
    before = lot.quantity_available.quantize(QTY_SCALE)
    _apply_movement(db, lot, movement_type, delta, actor=actor, reason=reason)
    record_event(
        db, action, actor, "lot", lot.id, reason=reason,
        detail={
            "movement_type": movement_type,
            "delta": str(delta),
            "available_before": str(before),
            "available_after": str(lot.quantity_available),
        },
    )
    db.commit()
    db.refresh(lot)
    return lot


def archive_lot(db: Session, lot: BiomassLot, actor: User, *, is_admin: bool) -> BiomassLot:
    lot = _lock_lot(db, lot.id)
    if lot.status == "archived":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Record is already archived.")
    _ensure_no_active_listings(db, lot.id)
    if lot.quantity_reserved > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Reserved quantity must be released before archiving.",
        )
    lot.status = "archived"
    record_event(
        db, "admin.lot.archived" if is_admin else "lot.archived", actor, "lot", lot.id,
        detail={"previous_status": "active"},
    )
    db.commit()
    db.refresh(lot)
    return lot


def restore_lot(db: Session, lot: BiomassLot, actor: User, *, is_admin: bool) -> BiomassLot:
    lot = _lock_lot(db, lot.id)
    if lot.status != "archived":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Record is not archived.")
    lot.status = "active"
    record_event(
        db, "admin.lot.restored" if is_admin else "lot.restored", actor, "lot", lot.id,
        detail={"previous_status": "archived"},
    )
    db.commit()
    db.refresh(lot)
    return lot


def flag_lot(db: Session, lot: BiomassLot, admin: User, *, note: str | None) -> BiomassLot:
    lot = _lock_lot(db, lot.id)
    lot.admin_flag = note
    record_event(db, "admin.lot.flagged", admin, "lot", lot.id, reason=note)
    db.commit()
    db.refresh(lot)
    return lot


def transfer_lot(
    db: Session, lot: BiomassLot, actor: User, *,
    recipient: User, quantity: Decimal, note: str | None,
) -> tuple[BiomassLot, BiomassLot]:
    """Transfers custody of a quantity: the source records an audited
    transfer_out; a NEW lot owned by the recipient records transfer_in with
    the source lot's provenance preserved. Traceability is never lost."""
    lot = _lock_lot(db, lot.id)
    if lot.status != "active":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT, detail="Archived inventory cannot be transferred."
        )
    amount = _positive(q(quantity), "Quantity")
    if amount > lot.quantity_available:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Transfer exceeds the available quantity.",
        )
    provenance = lot.source_provenance or "Provenance not provided by the previous owner."
    new_lot = BiomassLot(
        owner_id=recipient.id,
        title=lot.title,
        category=lot.category,
        material_type=lot.material_type,
        unit=lot.unit,
        quantity_total=Decimal("0"),  # set by the transfer_in movement below
        quantity_available=Decimal("0"),
        moisture_percent=lot.moisture_percent,
        harvest_date=lot.harvest_date,
        source_provenance=(
            f"{provenance} Received via platform transfer from lot {str(lot.id)[:8]}"
            f"{' — ' + note if note else ''}"
        ),
        storage_location=lot.storage_location,
        quality_grade=lot.quality_grade,
        quality_note=lot.quality_note,
        permit_reference=lot.permit_reference,
        permit_status=lot.permit_status,
        price_per_unit=None,  # price is the recipient's decision, not inherited
        currency=lot.currency,
        status="active",
    )
    db.add(new_lot)
    db.flush()
    _apply_movement(
        db, lot, "transfer_out", -amount, actor=actor,
        reason=note or f"Transferred to account {str(recipient.id)[:8]}"
    )
    _apply_movement(
        db, new_lot, "transfer_in", amount, actor=actor,
        reason=f"Received from lot {str(lot.id)[:8]}"
    )
    record_event(
        db, "lot.transferred_out", actor, "lot", lot.id,
        detail={"quantity": str(amount), "unit": lot.unit, "recipient_id": str(recipient.id)},
        related_entity_type="lot", related_entity_id=new_lot.id,
    )
    record_event(
        db, "lot.transferred_in", actor, "lot", new_lot.id,
        detail={"quantity": str(amount), "unit": lot.unit, "source_lot": str(lot.id)},
        related_entity_type="lot", related_entity_id=lot.id,
    )
    db.commit()
    db.refresh(lot)
    db.refresh(new_lot)
    return lot, new_lot


def _ensure_no_active_listings(db: Session, lot_id: uuid.UUID) -> None:
    count = db.scalar(
        select(func.count())
        .select_from(BiomassListing)
        .where(
            BiomassListing.lot_id == lot_id,
            BiomassListing.status.in_(["draft", "active", "paused"]),
        )
    )
    if int(count or 0) > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Withdraw or reject the marketplace listings using this stock first.",
        )


# ==== listings =============================================================


def _other_offered_on_lot(db: Session, lot_id: uuid.UUID, exclude: uuid.UUID | None) -> Decimal:
    rows = db.execute(
        select(BiomassListing.listing_available).where(
            BiomassListing.lot_id == lot_id,
            BiomassListing.status.in_(["draft", "active", "paused"]),
            BiomassListing.id != exclude,
        )
    ).all()
    total = sum((row[0] for row in rows), Decimal("0"))
    return total.quantize(QTY_SCALE)


def create_listing(
    db: Session, lot_id: uuid.UUID, seller: User, *,
    title: str, description: str | None, quantity: Decimal,
    price_per_unit: Decimal, fulfilment: str, available_from, available_until,
    publish_now: bool, currency: str, location: str | None = None,
    images: list | None = None,
) -> BiomassListing:
    """Creates a marketplace listing. `images` are the uploads validated by
    services.biomass_images.validate_images — 1..5 images are COMPULSORY for
    a listing; validation runs FIRST (before even the lot lookup), and the
    gallery is persisted inside the same transaction as the listing row."""
    from backend.services import biomass_images as img_svc

    validated = img_svc.validate_images(images or [])
    lot = _lock_lot(db, lot_id)
    if lot.owner_id != seller.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory record not found.")
    if lot.status != "active":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only active inventory can be listed on the marketplace.",
        )
    price = money(price_per_unit)
    if price <= 0:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Asking price must be greater than zero.",
        )
    if fulfilment not in ("pickup", "delivery", "negotiable"):
        raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unsupported fulfilment preference.")
    if available_from and available_until and available_until < available_from:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="Availability end date cannot be before the start date.",
        )
    amount = _positive(q(quantity), "Quantity")
    cap = (lot.quantity_available - _other_offered_on_lot(db, lot.id, None)).quantize(QTY_SCALE)
    if amount > cap:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Offered quantity exceeds the stock still available on this lot.",
        )
    listing = BiomassListing(
        lot_id=lot.id,
        seller_id=seller.id,
        title=title,
        description=description,
        category=lot.category,
        material_type=lot.material_type,
        unit=lot.unit,
        location=location,
        quantity_total=amount,
        listing_available=amount,
        price_per_unit=price,
        currency=currency,
        fulfilment=fulfilment,
        available_from=available_from,
        available_until=available_until,
        status="active" if publish_now else "draft",
    )
    db.add(listing)
    db.flush()
    record_event(
        db, "listing.created", seller, "listing", listing.id,
        detail={"title": listing.title, "quantity": str(amount), "unit": lot.unit,
                "published": publish_now, "images": len(validated)},
        related_entity_type="lot", related_entity_id=lot.id,
    )
    if publish_now:
        record_event(db, "listing.published", seller, "listing", listing.id)
    img_svc.persist_images(db, kind="listing", parent_id=listing.id, validated=validated)
    db.commit()
    db.refresh(listing)
    return listing


def get_or_404_listing(db: Session, listing_id: uuid.UUID) -> BiomassListing:
    """Alias used by the admin API — same 404 semantics for a missing or
    hidden listing."""
    return get_listing_or_404(db, listing_id)


def get_listing_or_404(db: Session, listing_id: uuid.UUID) -> BiomassListing:
    listing = db.get(BiomassListing, listing_id)
    if listing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found.")
    return listing


def get_listing_for_seller_or_404(db: Session, listing_id: uuid.UUID, seller: User) -> BiomassListing:
    listing = db.get(BiomassListing, listing_id)
    if listing is None or listing.seller_id != seller.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found.")
    return listing


def get_visible_listing_or_404(db: Session, listing_id: uuid.UUID, viewer: User) -> BiomassListing:
    listing = db.get(BiomassListing, listing_id)
    if listing is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found.")
    if listing.seller_id != viewer.id and listing.status != "active":
        # Draft/paused/withdrawn/rejected/sold-out listings are visible to
        # their seller only (404 keeps it indistinguishable from unknown).
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found.")
    return listing


def edit_listing(
    db: Session, listing: BiomassListing, seller: User, changes: dict
) -> BiomassListing:
    listing = _lock_listing(db, listing.id)
    if listing.seller_id != seller.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found.")
    if listing.status in ("withdrawn", "rejected", "sold_out"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This listing can no longer be edited.",
        )
    before = {k: getattr(listing, k) for k in changes}
    # Quantity: grow only with actually-free stock on the lot; shrink only
    # down to what is already committed (reserved + sold). The listed
    # quantity is bookkeeping; the LOT stays the source of truth.
    if changes.get("quantity_total") is not None:
        wanted = q(changes["quantity_total"])
        committed = listing.quantity_sold + listing.listing_reserved
        if wanted < committed:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Offered quantity cannot fall below what is already reserved or sold.",
            )
        lot = _lock_lot(db, listing.lot_id)
        offered_elsewhere = _other_offered_on_lot(db, listing.lot_id, listing.id)
        extra_needed = (wanted - listing.listing_available).quantize(QTY_SCALE)
        room = (lot.quantity_available - offered_elsewhere).quantize(QTY_SCALE)
        if extra_needed > room:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="The lot does not have enough free stock for this quantity.",
            )
        listing.quantity_total = wanted
        listing.listing_available = (listing.listing_available + extra_needed).quantize(QTY_SCALE)
        changes = {k: v for k, v in changes.items() if k != "quantity_total"}
    if changes.get("price_per_unit") is not None:
        listing.price_per_unit = money(changes["price_per_unit"])
        changes.pop("price_per_unit", None)
    for key in ("title", "description", "fulfilment", "available_from", "available_until", "location"):
        if key in changes:
            setattr(listing, key, changes[key])
    if "available_from" in changes or "available_until" in changes:
        if (
            listing.available_from is not None
            and listing.available_until is not None
            and listing.available_until < listing.available_from
        ):
            db.rollback()
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Availability end date cannot be before the start date.",
            )
    if changes or before:
        record_event(
            db, "listing.edited", seller, "listing", listing.id,
            detail={
                "before": {
                    k: str(v) if v is not None else None
                    for k, v in before.items() if k in changes or k == "quantity_total"
                },
                "after": {
                    k: str(getattr(listing, k)) if getattr(listing, k) is not None else None
                    for k in before if k in changes or k == "quantity_total"
                },
            },
        )
    db.commit()
    db.refresh(listing)
    return listing


def listing_transition(
    db: Session, listing: BiomassListing, seller: User,
    to: Literal["active", "paused", "withdrawn"],
) -> BiomassListing:
    listing = _lock_listing(db, listing.id)
    if listing.seller_id != seller.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Listing not found.")
    current = listing.status
    if to == "active":
        if current not in ("draft", "paused"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Listing cannot be published from its current status.")
        listing.status = "active"
        record_event(
            db, "listing.resumed" if current == "paused" else "listing.published",
            seller, "listing", listing.id,
        )
    elif to == "paused":
        if current != "active":
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only active listings can be paused.")
        listing.status = "paused"
        record_event(db, "listing.paused", seller, "listing", listing.id)
    elif to == "withdrawn":
        if current not in ("draft", "active", "paused"):
            raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Listing cannot be withdrawn from its current status.")
        if listing.listing_reserved > 0:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Resolve the active purchase requests before withdrawing this listing.",
            )
        listing.status = "withdrawn"
        record_event(db, "listing.withdrawn", seller, "listing", listing.id)
    db.commit()
    db.refresh(listing)
    return listing


# ==== reservations and order lifecycle =====================================


def release_expired_reservations(db: Session, *, lot_id: uuid.UUID | None = None,
                                 listing_id: uuid.UUID | None = None) -> int:
    """Releases reservations whose request window expired, exactly once.

    Runs inside the caller's transaction before further checks. Expired
    orders move to 'cancelled' with released_at (guarded by released_at IS
    NULL + the row lock), and the lot/listing reserved counters are given
    back.
    """
    conditions = [
        BiomassOrder.status == "requested",
        BiomassOrder.reservation_expires_at < now_utc(),
        BiomassOrder.released_at.is_(None),
    ]
    if lot_id is not None:
        conditions.append(BiomassOrder.lot_id == lot_id)
    if listing_id is not None:
        conditions.append(BiomassOrder.listing_id == listing_id)
    expired = db.scalars(
        select(BiomassOrder).where(*conditions).with_for_update(skip_locked=True)
    ).all()
    released = 0
    for order in expired:
        listing = _lock_listing(db, order.listing_id)
        lot = _lock_lot(db, order.lot_id)
        listing.listing_reserved = (listing.listing_reserved - order.quantity).quantize(QTY_SCALE)
        listing.listing_available = (listing.listing_available + order.quantity).quantize(QTY_SCALE)
        order.status = "cancelled"
        order.released_at = now_utc()
        order.cancelled_at = order.released_at
        _apply_movement(
            db, lot, "release", order.quantity, actor=None,
            reason="Reservation expired without seller acceptance",
            order=order,
        )
        record_event(db, "order.reservation_expired", None, "order", order.id)
        released += 1
    return released


def _generate_reference(db: Session) -> str:
    for _ in range(5):
        candidate = "BO-" + secrets.token_hex(4).upper()
        clash = db.scalar(select(BiomassOrder.id).where(BiomassOrder.reference == candidate))
        if clash is None:
            return candidate
    raise HTTPException(status_code=status.HTTP_503_SERVICE_UNAVAILABLE, detail="Could not allocate a transaction reference.")


def create_order(
    db: Session, listing_id: uuid.UUID, buyer: User, *,
    quantity: Decimal, buyer_note: str | None, client_request_id: str | None,
) -> tuple[BiomassOrder, bool]:
    """Patient-side purchase request: validates and reserves atomically.

    Returns (order, created) — created=False means the client_request_id
    replayed an existing order (retry-safe duplicate).
    """
    if client_request_id:
        existing = db.scalar(
            select(BiomassOrder).where(
                BiomassOrder.client_request_id == client_request_id,
                BiomassOrder.buyer_id == buyer.id,
            )
        )
        if existing is not None:
            return existing, False
    amount = _positive(q(quantity), "Quantity")
    listing = _lock_listing(db, listing_id)
    if listing.status != "active":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This listing is not accepting requests.")
    if listing.seller_id == buyer.id:
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="You cannot purchase your own listing.")
    duplicate = db.scalar(
        select(BiomassOrder.id).where(
            BiomassOrder.listing_id == listing_id,
            BiomassOrder.buyer_id == buyer.id,
            BiomassOrder.status == "requested",
        )
    )
    if duplicate is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="You already have an open request on this listing.",
        )
    if amount > listing.listing_available:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Requested quantity exceeds what is currently available.",
        )
    lot = _lock_lot(db, listing.lot_id)
    if lot.quantity_available < amount:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Requested quantity exceeds what is currently available.",
        )
    unit_price = listing.price_per_unit
    total = (amount * unit_price).quantize(PRICE_SCALE, rounding=ROUND_HALF_UP)
    order = BiomassOrder(
        reference=_generate_reference(db),
        listing_id=listing.id,
        lot_id=lot.id,
        buyer_id=buyer.id,
        seller_id=listing.seller_id,
        quantity=amount,
        unit=listing.unit,
        unit_price=unit_price,
        total_amount=total,
        currency=listing.currency,
        status="requested",
        buyer_note=buyer_note,
        client_request_id=client_request_id,
        reservation_expires_at=now_utc() + RESERVATION_LIFETIME,
    )
    db.add(order)
    db.flush()
    _apply_movement(
        db, lot, "reservation", -amount, actor=buyer,
        reason=f"Reserved for order {order.reference}", order=order,
    )
    listing.listing_reserved = (listing.listing_reserved + amount).quantize(QTY_SCALE)
    listing.listing_available = (listing.listing_available - amount).quantize(QTY_SCALE)
    record_event(
        db, "order.created", buyer, "order", order.id,
        detail={"quantity": str(amount), "unit": listing.unit, "total": str(total), "currency": listing.currency},
        related_entity_type="listing", related_entity_id=listing.id,
    )
    db.commit()
    db.refresh(order)
    return order, True


def get_order_for_participant_or_404(db: Session, order_id: uuid.UUID, user: User) -> BiomassOrder:
    order = db.get(BiomassOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    if user.id not in (order.buyer_id, order.seller_id):
        if user.role != "admin":
            # Non-participants get the same 404 as an unknown id — no
            # participant-enumeration oracle. Admins are gated separately
            # by require_admin in /api/v1/admin/biomass.
            raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    return order


def _locked_order(db: Session, order_id: uuid.UUID, user: User, role: Literal["buyer", "seller", "any"]) -> BiomassOrder:
    order = db.scalars(select(BiomassOrder).where(BiomassOrder.id == order_id).with_for_update()).first()
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    if order.buyer_id != user.id and order.seller_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    if role == "buyer" and order.buyer_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    if role == "seller" and order.seller_id != user.id:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    return order


def accept_order(db: Session, order_id: uuid.UUID, seller: User) -> BiomassOrder:
    order = _locked_order(db, order_id, seller, "seller")
    if order.status not in ("requested",):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only a requested transaction can be accepted.")
    order.status = "awaiting_fulfilment"
    record_event(db, "order.accepted", seller, "order", order.id)
    db.commit()
    db.refresh(order)
    return order


def reject_order(db: Session, order_id: uuid.UUID, seller: User) -> BiomassOrder:
    order = _locked_order(db, order_id, seller, "seller")
    if order.status != "requested":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only a requested transaction can be rejected.")
    order.status = "rejected"
    order.rejected_at = now_utc()
    _release(db, order)
    record_event(db, "order.rejected", seller, "order", order.id)
    db.commit()
    db.refresh(order)
    return order


def cancel_order(db: Session, order_id: uuid.UUID, user: User) -> BiomassOrder:
    order = _locked_order(db, order_id, user, "any")
    is_seller = order.seller_id == user.id
    if order.status not in ("requested", "awaiting_fulfilment"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This transaction can no longer be cancelled. Open a dispute instead.",
        )
    pre_cancel_status = order.status
    order.status = "cancelled"
    order.cancelled_at = now_utc()
    _release(db, order)
    record_event(
        db, "order.cancelled", user, "order", order.id,
        detail={"by": "seller" if is_seller else "buyer", "previous_status": pre_cancel_status},
    )
    db.commit()
    db.refresh(order)
    return order


def _release(db: Session, order: BiomassOrder) -> None:
    """Releases the reservation of an un-fulfilled order exactly once."""
    if order.released_at is not None:
        return
    listing = _lock_listing(db, order.listing_id)
    lot = _lock_lot(db, order.lot_id)
    assert listing.listing_reserved >= order.quantity  # invariant guard
    listing.listing_reserved = (listing.listing_reserved - order.quantity).quantize(QTY_SCALE)
    listing.listing_available = (listing.listing_available + order.quantity).quantize(QTY_SCALE)
    order.released_at = now_utc()
    _apply_movement(db, lot, "release", order.quantity, actor=None,
                    reason=f"Reservation released for {order.reference}", order=order)


def fulfil_order(db: Session, order_id: uuid.UUID, seller: User) -> BiomassOrder:
    """Seller marks delivery/pick-up as done — the ONLY point where the
    reserved quantity becomes a recorded sale (ownership movement)."""
    order = _locked_order(db, order_id, seller, "seller")
    if order.status != "awaiting_fulfilment":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only a transaction awaiting fulfilment can be fulfilled.",
        )
    listing = _lock_listing(db, order.listing_id)
    lot = _lock_lot(db, order.lot_id)
    # Reservation → sale on the lot: reserved down, sold up, available unchanged.
    lot.quantity_reserved = (lot.quantity_reserved - order.quantity).quantize(QTY_SCALE)
    lot.quantity_sold = (lot.quantity_sold + order.quantity).quantize(QTY_SCALE)
    before = lot.quantity_available.quantize(QTY_SCALE)
    db.add(
        StockMovement(
            lot_id=lot.id,
            order_id=order.id,
            movement_type="sale",
            quantity_delta=Decimal("0.000"),  # available unchanged; reserved became sold
            quantity_before=before,
            quantity_after=before,
            reason=f"Sale fulfilled for {order.reference} ({order.quantity} {order.unit})",
            actor_id=seller.id,
        )
    )
    listing.listing_reserved = (listing.listing_reserved - order.quantity).quantize(QTY_SCALE)
    listing.quantity_sold = (listing.quantity_sold + order.quantity).quantize(QTY_SCALE)
    if listing.listing_available <= 0 and listing.listing_reserved <= 0:
        listing.status = "sold_out"
    order.status = "fulfilled"
    order.fulfilled_at = now_utc()
    record_event(
        db, "order.fulfilled", seller, "order", order.id,
        detail={"quantity": str(order.quantity), "unit": order.unit},
        related_entity_type="lot", related_entity_id=lot.id,
    )
    db.commit()
    db.refresh(order)
    return order


def confirm_order(db: Session, order_id: uuid.UUID, buyer: User) -> BiomassOrder:
    order = _locked_order(db, order_id, buyer, "buyer")
    if order.status != "fulfilled":
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Only a fulfilled transaction can be confirmed complete.",
        )
    order.status = "completed"
    order.completed_at = now_utc()
    record_event(db, "order.completed", buyer, "order", order.id)
    db.commit()
    db.refresh(order)
    return order


def record_settlement(db: Session, order_id: uuid.UUID, seller: User, *, note: str | None) -> BiomassOrder:
    """Seller records that payment was RECEIVED off-platform. No payment
    provider exists in this project, so this is a clearly-labelled manual
    settlement record — never an automatic 'paid' claim."""
    order = _locked_order(db, order_id, seller, "seller")
    if order.status not in ("fulfilled", "completed"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Settlement can be recorded only after fulfilment.",
        )
    if order.settlement_status == "settled":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Settlement is already recorded.")
    order.settlement_status = "settled"
    order.settlement_note = note
    order.settlement_at = now_utc()
    record_event(
        db, "order.settlement_recorded", seller, "order", order.id,
        detail={"settlement_note": note}, reason="Manual off-platform settlement recorded by seller",
    )
    db.commit()
    db.refresh(order)
    return order


def dispute_order(db: Session, order_id: uuid.UUID, user: User, *, reason: str) -> BiomassOrder:
    order = _locked_order(db, order_id, user, "any")
    if order.status not in ("requested", "awaiting_fulfilment", "fulfilled"):
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This transaction cannot be disputed in its current state.",
        )
    order.dispute_previous_status = order.status
    order.dispute_reason = reason
    order.disputed_at = now_utc()
    order.status = "disputed"
    record_event(db, "order.disputed", user, "order", order.id, reason=reason)
    db.commit()
    db.refresh(order)
    return order


# ==== admin actions ========================================================


def admin_reject_listing(
    db: Session, listing: BiomassListing, admin: User, *, reason: str
) -> BiomassListing:
    listing = _lock_listing(db, listing.id)
    if listing.status in ("rejected",):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Listing is already rejected.")
    if listing.listing_reserved > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="Active purchase requests must be resolved before rejecting this listing.",
        )
    previous = listing.status
    listing.status = "rejected"
    listing.moderation_note = reason
    record_event(
        db, "admin.listing.rejected", admin, "listing", listing.id, reason=reason,
        detail={"previous_status": previous},
    )
    db.commit()
    db.refresh(listing)
    return listing


def admin_suspend_listing(
    db: Session, listing: BiomassListing, admin: User, *, reason: str, force: bool
) -> BiomassListing:
    listing = _lock_listing(db, listing.id)
    if listing.status in ("withdrawn", "rejected"):
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Listing is already inactive.")
    if listing.listing_reserved > 0 and not force:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail={
                "message": "This listing has active purchase requests. Retry with force to also cancel them.",
                "code": "active_requests_exist",
            },
        )
    if force and listing.listing_reserved > 0:
        orders = db.scalars(
            select(BiomassOrder).where(
                BiomassOrder.listing_id == listing.id,
                BiomassOrder.status.in_(["requested", "awaiting_fulfilment"]),
            ).with_for_update()
        ).all()
        for order in orders:
            order.status = "cancelled"
            order.cancelled_at = now_utc()
            _release(db, order)
            record_event(db, "order.cancelled", admin, "order", order.id,
                         reason="Cancelled by administrator during listing suspension")
    listing.status = "withdrawn"
    listing.moderation_note = reason
    record_event(db, "admin.listing.suspended", admin, "listing", listing.id, reason=reason)
    db.commit()
    db.refresh(listing)
    return listing


def admin_reinstate_listing(db: Session, listing: BiomassListing, admin: User) -> BiomassListing:
    listing = _lock_listing(db, listing.id)
    if listing.status != "withdrawn" and listing.status != "rejected":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="Only a withdrawn or rejected listing can be reinstated.")
    listing.status = "paused"  # seller decides when to resume from pause
    listing.moderation_note = None
    record_event(db, "admin.listing.reinstated", admin, "listing", listing.id)
    db.commit()
    db.refresh(listing)
    return listing


def admin_resolve_dispute(
    db: Session, order_id: uuid.UUID, admin: User, *,
    action: Literal["resume", "cancel"], note: str
) -> BiomassOrder:
    """Resolves a disputed transaction. No completed transaction is ever
    rewritten: 'cancel' is only possible before fulfilment (the reservation
    is then released exactly once); a fulfilled transaction can only be
    resumed or left recorded. The resolution note is mandatory and stored
    on the order — the original row keeps its full history."""
    order = db.scalars(
        select(BiomassOrder).where(BiomassOrder.id == order_id).with_for_update()
    ).first()
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    return _set_admin_resolution(db, order, admin, action=action, note=note)


def _set_admin_resolution(db: Session, order: BiomassOrder, admin: User, *,
                          action: str, note: str) -> BiomassOrder:
    if order.status != "disputed":
        raise HTTPException(status_code=status.HTTP_409_CONFLICT, detail="This transaction is not disputed.")
    if action == "resume":
        order.status = order.dispute_previous_status or "awaiting_fulfilment"
    else:  # cancel
        if order.dispute_previous_status in (None, "awaiting_fulfilment", "requested"):
            order.status = "cancelled"
            order.cancelled_at = now_utc()
            _release(db, order)
        else:
            raise HTTPException(
                status_code=status.HTTP_409_CONFLICT,
                detail="Fulfilled stock cannot be cancelled anymore; resume the transaction instead.",
            )
    order.resolution_note = note
    order.resolved_by = admin.id
    order.resolved_at = now_utc()
    order.dispute_previous_status = None
    record_event(
        db, "admin.order.dispute_resolved", admin, "order", order.id,
        reason=note, detail={"action": action, "new_status": order.status},
    )
    db.commit()
    db.refresh(order)
    return order
