"""Trusted audit-trail recorder for biomass operations.

Every sensitive inventory/marketplace change flows through `record_event`,
which appends one `biomass_audit_events` row inside the SAME database
transaction as the change it describes (the caller commits). There is no
API that can create, modify, or delete these rows — the table is enforced
append-only by a database trigger (see migration 5c1f2a9d7b40).

`detail` must never contain secrets, token hashes, or full private
documents — it carries small before/after context values only.
"""

from typing import TYPE_CHECKING, Any
import uuid

from sqlalchemy.orm import Session

from backend.models import BiomassAuditEvent

if TYPE_CHECKING:  # pragma: no cover - typing only
    from backend.models import User

# Closed set of audited actions; a typo must fail loudly, not silently skip.
ACTIONS = frozenset(
    {
        # user-facing stock
        "lot.created",
        "lot.metadata_updated",
        "lot.adjusted",
        "lot.archived",
        "lot.restored",
        "lot.transferred_out",
        "lot.transferred_in",
        # user-facing marketplace
        "listing.created",
        "listing.published",
        "listing.edited",
        "listing.paused",
        "listing.resumed",
        "listing.withdrawn",
        "order.created",
        "order.accepted",
        "order.rejected",
        "order.cancelled",
        "order.fulfilled",
        "order.completed",
        "order.disputed",
        "order.settlement_recorded",
        "order.reservation_expired",
        # administrative
        "admin.lot.corrected",
        "admin.lot.archived",
        "admin.lot.restored",
        "admin.lot.flagged",
        "admin.listing.rejected",
        "admin.listing.suspended",
        "admin.listing.reinstated",
        "admin.order.dispute_resolved",
        # administrative permanent deletion
        "admin.lot.deleted",
        "admin.listing.deleted",
        "admin.deletion.cleanup_completed",
    }
)


def record_event(
    db: Session,
    action: str,
    actor: "User | None",
    entity_type: str,
    entity_id: uuid.UUID,
    *,
    reason: str | None = None,
    detail: dict[str, Any] | None = None,
    related_entity_type: str | None = None,
    related_entity_id: uuid.UUID | None = None,
) -> None:
    """Appends one audit row to the caller's current transaction.

    The row is committed by the caller with everything else, so a rolled
    back operation leaves no orphan audit entry (and a committed change
    always leaves its audit entry).
    """
    if action not in ACTIONS:
        raise ValueError(f"Unknown audit action: {action}")
    db.add(
        BiomassAuditEvent(
            actor_id=None if actor is None else actor.id,
            actor_role=actor.role if actor is not None else "system",
            action=action,
            entity_type=entity_type,
            entity_id=entity_id,
            reason=reason,
            detail=detail,
            related_entity_type=related_entity_type,
            related_entity_id=related_entity_id,
        )
    )
