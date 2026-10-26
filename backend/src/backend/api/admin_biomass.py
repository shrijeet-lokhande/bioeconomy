"""Server-enforced administrative biomass endpoints.

Every endpoint requires the existing `require_admin` dependency (401 →
403 verification → 403 admin_required, roles re-read per request). All
mutating actions record a biomass audit event with the actor, the reason,
and before/after context via the shared audit recorder. Administrators get
inspection and corrections — never historical rewriting: completed
transactions stay untouched, and corrections are adjustment records, not
silent balance overwrites.
"""

import uuid
from typing import Annotated

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel
from sqlalchemy import func, select

from backend.api.admin import require_admin
from backend.api.auth import _untrusted_origin
from backend.api.biomass import _listing_own, _order_out
from backend.api.db_deps import get_db
from backend.api.dependencies import get_current_user
from backend.biomass_schemas import (
    AdminAdjustRequest,
    AdminDeletionRequest,
    AdminDeletionResult,
    AdminListingActionRequest,
    AdminListingPage,
    AdminListingRow,
    AdminLotOut,
    AdminLotPage,
    AdminLotSummary,
    AdminOrderPage,
    AdminOrderRow,
    AdminOwnerInfo,
    AdminReasonRequest,
    AuditEventOut,
    AuditPage,
    LotOut,
    OrderOut,
    ResolveDisputeRequest,
)
from backend.models import (
    ALLOWED_ORDER_STATUSES,
    BiomassAuditEvent,
    BiomassListing,
    BiomassLot,
    BiomassOrder,
    StockMovement,
    User,
)
from backend.rate_limit import enforce_rate_limit
from backend.services import biomass as svc
from backend.services import purge as purge_svc

router = APIRouter(prefix="/api/v1/admin/biomass", tags=["admin-biomass"])


def _owner_info(db, user_id):
    user = db.get(User, user_id)
    return AdminOwnerInfo(id=user.id, full_name=user.full_name, email=user.email) if user else None


def _admin_lot(db, lot: BiomassLot, *, with_owner: bool = True) -> AdminLotOut:
    open_listings = int(db.scalar(
        select(func.count())
        .select_from(BiomassListing)
        .where(
            BiomassListing.lot_id == lot.id,
            BiomassListing.status.in_(["draft", "active", "paused"]),
        )
    ) or 0)
    return AdminLotOut(
        **LotOut.model_validate(lot).model_dump(),
        owner=_owner_info(db, lot.owner_id) if with_owner else None,
        open_listings=open_listings,
    )


@router.get("/overview", response_model=AdminLotSummary)
def overview(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> AdminLotSummary:
    def count(model, *conditions) -> int:
        return int(db.scalar(select(func.count()).select_from(model).where(*conditions)) or 0)

    lots_total = count(BiomassLot)
    lots_active = count(BiomassLot, BiomassLot.status == "active")
    listing_counts = {
        row[0]: int(row[1])
        for row in db.execute(
            select(BiomassListing.status, func.count()).group_by(BiomassListing.status)
        ).all()
    }
    order_counts = {
        row[0]: int(row[1])
        for row in db.execute(
            select(BiomassOrder.status, func.count()).group_by(BiomassOrder.status)
        ).all()
    }
    movements_30d = int(db.scalar(
        select(func.count())
        .select_from(StockMovement)
        .where(
            StockMovement.movement_type.in_(["correction", "admin_correction", "removal"]),
        )
    ) or 0)
    events = db.scalars(
        select(BiomassAuditEvent).order_by(BiomassAuditEvent.created_at.desc()).limit(10)
    ).all()
    return AdminLotSummary(
        total_lots=lots_total,
        active_lots=lots_active,
        archived_lots=lots_total - lots_active,
        active_listings=listing_counts.get("active", 0),
        paused_listings=listing_counts.get("paused", 0),
        withdrawn_listings=listing_counts.get("withdrawn", 0),
        rejected_listings=listing_counts.get("rejected", 0),
        orders=order_counts,
        disputed_orders=order_counts.get("disputed", 0),
        movements_30d=movements_30d,
        recent_events=[AuditEventOut.model_validate(event) for event in events],
    )


@router.get("/inventory", response_model=AdminLotPage)
def all_inventory(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
    search: str | None = Query(default=None, max_length=120),
    status_filter: Annotated[str, Query(pattern="^(active|archived|all)$")] = "all",
    flagged: bool | None = Query(default=None),
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> AdminLotPage:
    query = select(BiomassLot)
    count_query = select(func.count()).select_from(BiomassLot)
    if status_filter != "all":
        query = query.where(BiomassLot.status == status_filter)
        count_query = count_query.where(BiomassLot.status == status_filter)
    if search and search.strip():
        pattern = f"%{search.strip().lower()}%"
        owner_ids = [
            row[0] for row in db.execute(
                select(User.id).where(
                    func.lower(User.email).ilike(pattern) | func.lower(User.full_name).ilike(pattern)
                )
            ).all()
        ]
        text_filter = (
            func.lower(BiomassLot.title).ilike(pattern)
            | func.lower(BiomassLot.material_type).ilike(pattern)
            | BiomassLot.owner_id.in_(owner_ids or [uuid.UUID(int=0)])
        )
        query = query.where(text_filter)
        count_query = count_query.where(text_filter)
    if flagged is True:
        query = query.where(BiomassLot.admin_flag.isnot(None))
        count_query = count_query.where(BiomassLot.admin_flag.isnot(None))
    total = int(db.scalar(count_query) or 0)
    lots = db.scalars(
        query.order_by(BiomassLot.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return AdminLotPage(
        total=total, page=page, page_size=page_size,
        items=[_admin_lot(db, lot) for lot in lots],
    )


@router.get("/inventory/{lot_id}", response_model=AdminLotOut)
def inventory_detail(
    lot_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminLotOut:
    lot = db.get(BiomassLot, lot_id)
    if lot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory record not found.")
    return _admin_lot(db, lot)


@router.get("/inventory/{lot_id}/detail", response_model=dict)
def inventory_full(
    lot_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> dict:
    """Full inspection: lot, its movements, listings, and orders."""
    lot = db.get(BiomassLot, lot_id)
    if lot is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Inventory record not found.")
    movements = db.scalars(
        select(StockMovement).where(StockMovement.lot_id == lot.id)
        .order_by(StockMovement.created_at.desc()).limit(100)
    ).all()
    listings = db.scalars(
        select(BiomassListing).where(BiomassListing.lot_id == lot.id)
        .order_by(BiomassListing.created_at.desc())
    ).all()
    orders = db.scalars(
        select(BiomassOrder).where(BiomassOrder.lot_id == lot.id)
        .order_by(BiomassOrder.created_at.desc()).limit(100)
    ).all()
    return {
        "lot": _admin_lot(db, lot).model_dump(mode="json"),
        "movements": [
            dict(
                id=str(m.id),
                movement_type=m.movement_type,
                quantity_delta=str(m.quantity_delta),
                quantity_before=str(m.quantity_before),
                quantity_after=str(m.quantity_after),
                reason=m.reason,
                created_at=m.created_at.isoformat(),
            )
            for m in movements
        ],
        "listings": [AdminListingRow(**{**_listing_row_db(db, l).model_dump(), "seller": _owner_info(db, l.seller_id)}).model_dump(mode="json") for l in listings],
        "orders": [_admin_order_out(db, o).model_dump(mode="json") for o in orders],
    }


@router.post("/inventory/{lot_id}/adjust", response_model=AdminLotOut)
def admin_adjust(
    lot_id: uuid.UUID,
    payload: AdminAdjustRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminLotOut:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    lot = svc.get_or_404(db, lot_id)
    lot = svc.adjust_quantity(
        db, lot,
        kind=payload.kind,  # type: ignore[arg-type]
        quantity=payload.quantity,
        new_available=payload.new_available,
        reason=payload.reason,
        actor=admin,
        is_admin=True,
    )
    return _admin_lot(db, lot)


@router.post("/inventory/{lot_id}/archive", response_model=AdminLotOut)
def admin_archive_lot(
    lot_id: uuid.UUID, request: Request,
    admin: User = Depends(require_admin), db: Session = Depends(get_db),
) -> AdminLotOut:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    lot = svc.get_or_404(db, lot_id)
    return _admin_lot(db, svc.archive_lot(db, lot, admin, is_admin=True))


@router.post("/inventory/{lot_id}/restore", response_model=AdminLotOut)
def admin_restore_lot(
    lot_id: uuid.UUID, request: Request,
    admin: User = Depends(require_admin), db: Session = Depends(get_db),
) -> AdminLotOut:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    lot = svc.get_or_404(db, lot_id)
    return _admin_lot(db, svc.restore_lot(db, lot, admin, is_admin=True))


@router.post("/inventory/{lot_id}/flag", response_model=AdminLotOut)
def admin_flag_lot(
    lot_id: uuid.UUID,
    payload: AdminReasonRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminLotOut:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    lot = svc.get_or_404(db, lot_id)
    return _admin_lot(db, svc.flag_lot(db, lot, admin, note=payload.note))


# ==== permanent deletion ====================================================


@router.delete("/inventory/{lot_id}", response_model=AdminDeletionResult)
def delete_lot_permanently(
    lot_id: uuid.UUID,
    payload: AdminDeletionRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminDeletionResult:
    """PERMANENTLY deletes an inventory record: the lot, its stock-movement
    journal, its order-free listings, its image metadata, and the image
    files on disk. Refused (409) when any purchase transaction references
    the record — history is preserved, never destroyed. Repeat requests are
    safe: a fully deleted id answers 404; an interrupted purge retries its
    file cleanup and reports the true status."""
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    result = purge_svc.purge_lot(db, admin, lot_id, payload.confirm_title)
    return AdminDeletionResult(
        entity_type=result.entity_type,
        entity_id=result.entity_id,
        status=result.status,
        removed_files=result.removed,
        missing_files=result.missing,
        failed_files=result.failed,
    )


@router.delete("/listings/{listing_id}", response_model=AdminDeletionResult)
def delete_listing_permanently(
    listing_id: uuid.UUID,
    payload: AdminDeletionRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminDeletionResult:
    """PERMANENTLY deletes a marketplace listing and its image files.
    Refused (409) when any order references it; the source lot is untouched."""
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    result = purge_svc.purge_listing(db, admin, listing_id, payload.confirm_title)
    return AdminDeletionResult(
        entity_type=result.entity_type,
        entity_id=result.entity_id,
        status=result.status,
        removed_files=result.removed,
        missing_files=result.missing,
        failed_files=result.failed,
    )


# ==== listings moderation ==================================================


def _listing_row_db(db, listing: BiomassListing) -> ListingOwn:
    return _listing_own(listing)


def _admin_listing_out(db, listing: BiomassListing) -> AdminListingRow:
    return AdminListingRow(
        **_listing_own(listing).model_dump(),
        seller=_owner_info(db, listing.seller_id),
    )


@router.get("/listings", response_model=AdminListingPage)
def all_listings(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
    status_filter: Annotated[str, Query(pattern="^(all|draft|active|paused|withdrawn|sold_out|rejected)$")] = "all",
    search: str | None = Query(default=None, max_length=120),
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> AdminListingPage:
    query = select(BiomassListing)
    count_query = select(func.count()).select_from(BiomassListing)
    if status_filter != "all":
        query = query.where(BiomassListing.status == status_filter)
        count_query = count_query.where(BiomassListing.status == status_filter)
    if search and search.strip():
        pattern = f"%{search.strip().lower()}%"
        condition = func.lower(BiomassListing.title).ilike(pattern) | func.lower(BiomassListing.material_type).ilike(pattern)
        query = query.where(condition)
        count_query = count_query.where(condition)
    total = int(db.scalar(count_query) or 0)
    listings = db.scalars(
        query.order_by(BiomassListing.updated_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    return AdminListingPage(
        total=total, page=page, page_size=page_size,
        items=[_admin_listing_out(db, listing) for listing in listings],
    )


@router.post("/listings/{listing_id}/reject", response_model=AdminListingRow)
def reject_listing(
    listing_id: uuid.UUID,
    payload: AdminListingActionRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminListingRow:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    listing = svc.get_or_404_listing(db, listing_id)
    return _admin_listing_out(db, svc.admin_reject_listing(db, listing, admin, reason=payload.reason))


@router.post("/listings/{listing_id}/suspend", response_model=AdminListingRow)
def suspend_listing(
    listing_id: uuid.UUID,
    payload: AdminListingActionRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminListingRow:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    listing = svc.get_or_404_listing(db, listing_id)
    return _admin_listing_out(
        db, svc.admin_suspend_listing(db, listing, admin, reason=payload.reason, force=payload.force)
    )


@router.post("/listings/{listing_id}/reinstate", response_model=AdminListingRow)
def reinstate_listing(
    listing_id: uuid.UUID, request: Request,
    admin: User = Depends(require_admin), db: Session = Depends(get_db),
) -> AdminListingRow:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    listing = svc.get_or_404_listing(db, listing_id)
    return _admin_listing_out(db, svc.admin_reinstate_listing(db, listing, admin))


# ==== orders / disputes ====================================================


def _admin_order_out(db, order: BiomassOrder) -> AdminOrderRow:
    viewer = db.get(User, order.buyer_id)  # any party works for _order_out
    base = _order_out(db, order, viewer)
    buyer = db.get(User, order.buyer_id)
    seller = db.get(User, order.seller_id)
    return AdminOrderRow(
        **base.model_dump(exclude={"role"}),
        buyer_name=buyer.full_name if buyer else None,
        seller_name=seller.full_name if seller else None,
    )


@router.get("/orders", response_model=AdminOrderPage)
def all_orders(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
    status_filter: str | None = Query(default=None),
    search: str | None = Query(default=None, max_length=120),
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> AdminOrderPage:
    query = select(BiomassOrder)
    count_query = select(func.count()).select_from(BiomassOrder)
    if status_filter:
        if status_filter not in ALLOWED_ORDER_STATUSES:
            raise HTTPException(status_code=status.HTTP_422_UNPROCESSABLE_ENTITY, detail="Unknown status filter.")
        query = query.where(BiomassOrder.status == status_filter)
        count_query = count_query.where(BiomassOrder.status == status_filter)
    if search and search.strip():
        pattern = f"%{search.strip().upper()}%"
        condition = BiomassOrder.reference.ilike(pattern)
        query = query.where(condition)
        count_query = count_query.where(condition)
    total = int(db.scalar(count_query) or 0)
    orders = db.scalars(
        query.order_by(BiomassOrder.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).all()
    breakdown = {
        row[0]: int(row[1])
        for row in db.execute(select(BiomassOrder.status, func.count()).group_by(BiomassOrder.status)).all()
    }
    return AdminOrderPage(
        status_breakdown=breakdown or None,
        total=total, page=page, page_size=page_size,
        items=[_admin_order_out(db, order) for order in orders],
    )


@router.get("/orders/{order_id}", response_model=AdminOrderRow)
def order_detail(
    order_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminOrderRow:
    order = db.get(BiomassOrder, order_id)
    if order is None:
        raise HTTPException(status_code=status.HTTP_404_NOT_FOUND, detail="Transaction not found.")
    return _admin_order_out(db, order)


@router.post("/orders/{order_id}/resolve-dispute", response_model=AdminOrderRow)
def resolve_dispute(
    order_id: uuid.UUID,
    payload: ResolveDisputeRequest,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminOrderRow:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    order = svc.admin_resolve_dispute(db, order_id, admin, action=payload.action, note=payload.note)  # type: ignore[arg-type]
    return _admin_order_out(db, order)


# ==== audit log (read-only) ================================================


@router.get("/audit", response_model=AuditPage)
def audit_events(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
    action: str | None = Query(default=None, max_length=50),
    entity_type: Annotated[str | None, Query(max_length=30, pattern="^(lot|listing|order)$")] = None,
    entity_id: uuid.UUID | None = Query(default=None),
    search: str | None = Query(default=None, max_length=120),
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 50,
) -> AuditPage:
    """Read-only audit access. No endpoint anywhere creates or modifies
    audit rows (the DB trigger rejects UPDATE/DELETE outright)."""
    query = select(BiomassAuditEvent)
    count_query = select(func.count()).select_from(BiomassAuditEvent)
    if action:
        query = query.where(BiomassAuditEvent.action == action)
        count_query = count_query.where(BiomassAuditEvent.action == action)
    if entity_type:
        query = query.where(BiomassAuditEvent.entity_type == entity_type)
        count_query = count_query.where(BiomassAuditEvent.entity_type == entity_type)
    if entity_id is not None:
        query = query.where(BiomassAuditEvent.entity_id == entity_id)
        count_query = count_query.where(BiomassAuditEvent.entity_id == entity_id)
    if search and search.strip():
        pattern = f"%{search.strip().lower()}%"
        condition = func.lower(BiomassAuditEvent.action).ilike(pattern) | func.lower(func.coalesce(BiomassAuditEvent.reason, "")).ilike(pattern)
        query = query.where(condition)
        count_query = count_query.where(condition)
    total = int(db.scalar(count_query) or 0)
    events = db.scalars(
        query.order_by(BiomassAuditEvent.created_at.desc())
        .offset((page - 1) * page_size)
        .limit(page_size)
    ).all()
    return AuditPage(
        total=total, page=page, page_size=page_size,
        items=[AuditEventOut.model_validate(event) for event in events],
    )
