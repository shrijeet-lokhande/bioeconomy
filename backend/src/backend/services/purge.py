"""Admin permanent record deletion (biomass inventory + marketplace).

Hard rules:

- ADMIN ONLY. Callers must already hold the verified admin session; this
  module re-checks the actor role as defense in depth.
- EXPLICIT CONFIRMATION. The request must repeat the record's exact title —
  a bare ID click can never purge anything.
- BUSINESS-CRITICAL HISTORY IS NEVER DESTROYED. A record referenced by any
  order (any status — orders are the platform's transaction ledger) is
  refused with 409; archive/withdraw remain the available options there.
- ONE ATOMIC DATABASE PURGE, THEN FILE CLEANUP. Dependent rows that belong
  exclusively to the record (its image metadata, and for lots also its
  stock movements and its listings) are deleted in the same transaction as
  the record itself, together with a tracking row (BiomassDeletionCleanup)
  that lists the exact storage keys to remove. Files are deleted AFTER the
  commit — a failure there leaves the tracking row 'pending' and the
  deletion is retryable and idempotent. The reverse (metadata row without
  a record) can never happen because the record is already gone.
- RETAINED, SEPARATELY: the append-only audit log (a DB trigger forbids
  its modification) keeps a minimal event per purge — actor, timestamp,
  title, and counts. No image contents, no full personal data.
"""

import uuid

from fastapi import HTTPException, status
from sqlalchemy import delete, func, select
from sqlalchemy.orm import Session

from backend.models import (
    BiomassDeletionCleanup,
    BiomassImage,
    BiomassListing,
    BiomassLot,
    BiomassOrder,
    StockMovement,
    User,
)
from backend.services import audit
from backend.services import biomass_images as img_svc

# Sentinel that matches no row when a record simply has no listings.
_NO_IDS = [uuid.UUID(int=0)]


class DeletionResult:
    __slots__ = ("entity_type", "entity_id", "status", "removed", "missing", "failed")

    def __init__(
        self, entity_type: str, entity_id: uuid.UUID, status: str,
        removed: int, missing: int, failed: int,
    ):
        self.entity_type = entity_type
        self.entity_id = entity_id
        # "completed" = DB purged AND all files removed;
        # "pending_cleanup" = DB purged, some files still to retry.
        self.status = status
        self.removed = removed
        self.missing = missing
        self.failed = failed


def _require_admin_actor(actor: User) -> None:
    if actor.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Administrator privileges are required for this action.",
        )


def _require_confirmation(confirm_title: str | None, actual_title: str) -> None:
    if confirm_title is None or confirm_title.strip() != actual_title:
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=(
                "Confirmation failed: repeat the record's exact title to "
                "delete it permanently."
            ),
        )


def _refuse_when_ordered(
    db: Session, listing_ids: list[uuid.UUID], lot_id: uuid.UUID | None,
) -> None:
    """Any order referencing the record (directly or through its listings)
    makes hard deletion a destruction of transaction history — refused."""
    conditions = []
    if lot_id is not None:
        conditions.append(BiomassOrder.lot_id == lot_id)
    if listing_ids:
        conditions.append(BiomassOrder.listing_id.in_(listing_ids))
    ordered = int(db.scalar(
        select(func.count()).select_from(BiomassOrder).where(*conditions)
    ) or 0)
    if ordered > 0:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail=(
                "This record is referenced by purchase transactions. "
                "Permanent deletion is refused to preserve transaction "
                "history — archive or withdraw it instead."
            ),
        )


def _finish(db: Session, row: BiomassDeletionCleanup) -> DeletionResult:
    """Runs the file-cleanup phase for a tracking row (idempotent: every
    key is attempted every run; missing files count as cleaned), updates
    the row, and appends the completion audit event when fully done."""
    counts = img_svc.cleanup_files(row.storage_keys)
    row.attempts += 1
    row.removed_files += counts["removed"]
    row.missing_files += counts["missing"]
    row.failed_files = counts["invalid"]
    if counts["invalid"] == 0:
        row.status = "completed"
        audit.record_event(
            db, "admin.deletion.cleanup_completed", None,
            row.entity_type, row.entity_id,
            detail={
                "removed_files": row.removed_files,
                "missing_files": row.missing_files,
                "attempts": row.attempts,
            },
        )
    db.commit()
    return DeletionResult(
        row.entity_type, row.entity_id,
        "completed" if row.status == "completed" else "pending_cleanup",
        counts["removed"], counts["missing"], counts["invalid"],
    )


def _already_gone(db: Session, entity_type: str, entity_id: uuid.UUID) -> DeletionResult:
    """The record is already gone: either a retry of an interrupted purge
    (finish the pending file cleanup) or an unknown/finished id (404)."""
    row = db.scalar(
        select(BiomassDeletionCleanup).where(
            BiomassDeletionCleanup.entity_type == entity_type,
            BiomassDeletionCleanup.entity_id == entity_id,
        ).with_for_update()
    )
    if row is None or row.status == "completed":
        kind = "Inventory record" if entity_type == "lot" else "Marketplace listing"
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail=f"{kind} not found.",
        )
    return _finish(db, row)


def purge_lot(
    db: Session, actor: User, lot_id: uuid.UUID, confirm_title: str | None,
) -> DeletionResult:
    """Permanently deletes an inventory lot, its gallery files, its stock
    movements, and its listings (which themselves must be order-free)."""
    _require_admin_actor(actor)
    lot = db.scalar(select(BiomassLot).where(BiomassLot.id == lot_id).with_for_update())
    if lot is None:
        return _already_gone(db, "lot", lot_id)
    _require_confirmation(confirm_title, lot.title)

    listings = db.scalars(
        select(BiomassListing).where(BiomassListing.lot_id == lot.id)
    ).all()
    listing_ids = [listing.id for listing in listings]
    _refuse_when_ordered(db, listing_ids, lot.id)

    images = db.scalars(
        select(BiomassImage).where(
            (BiomassImage.lot_id == lot.id)
            | (BiomassImage.listing_id.in_(listing_ids or _NO_IDS))
        )
    ).all()
    storage_keys = [image.stored_name for image in images]
    movement_count = int(db.scalar(
        select(func.count())
        .select_from(StockMovement)
        .where(StockMovement.lot_id == lot.id)
    ) or 0)

    audit.record_event(db, "admin.lot.deleted", actor, "lot", lot.id, detail={
        "title": lot.title,
        "images": len(storage_keys),
        "movements": movement_count,
        "listings": len(listing_ids),
    })
    for image in images:
        db.delete(image)
    for listing in listings:
        db.delete(listing)
    db.execute(delete(StockMovement).where(StockMovement.lot_id == lot.id))
    db.add(BiomassDeletionCleanup(
        entity_type="lot", entity_id=lot.id, storage_keys=storage_keys,
    ))
    db.delete(lot)
    db.commit()
    return _finish(db, _reload_cleanup(db, "lot", lot.id))


def purge_listing(
    db: Session, actor: User, listing_id: uuid.UUID, confirm_title: str | None,
) -> DeletionResult:
    """Permanently deletes a marketplace listing and its gallery files.
    The source lot and its images are NOT touched (they belong to the lot)."""
    _require_admin_actor(actor)
    listing = db.scalar(
        select(BiomassListing).where(BiomassListing.id == listing_id).with_for_update()
    )
    if listing is None:
        return _already_gone(db, "listing", listing_id)
    _require_confirmation(confirm_title, listing.title)
    _refuse_when_ordered(db, [listing.id], None)

    images = db.scalars(
        select(BiomassImage).where(BiomassImage.listing_id == listing.id)
    ).all()
    storage_keys = [image.stored_name for image in images]

    audit.record_event(db, "admin.listing.deleted", actor, "listing", listing.id, detail={
        "title": listing.title,
        "images": len(storage_keys),
    })
    for image in images:
        db.delete(image)
    db.add(BiomassDeletionCleanup(
        entity_type="listing", entity_id=listing.id, storage_keys=storage_keys,
    ))
    db.delete(listing)
    db.commit()
    return _finish(db, _reload_cleanup(db, "listing", listing_id))


def _reload_cleanup(db: Session, entity_type: str, entity_id: uuid.UUID) -> BiomassDeletionCleanup:
    row = db.scalar(
        select(BiomassDeletionCleanup).where(
            BiomassDeletionCleanup.entity_type == entity_type,
            BiomassDeletionCleanup.entity_id == entity_id,
        )
    )
    if row is None:  # pragma: no cover - insert+commit just happened
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail="Deletion tracking row is missing.",
        )
    return row
