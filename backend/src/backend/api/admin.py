"""Server-enforced admin endpoints (Task 005).

Everything under this router requires an authenticated, verified session
owned by a user with role == "admin". There is NO endpoint anywhere in the
application that can create an admin: the first (and any) admin is created
exclusively by the operator through the documented SQL:

    UPDATE users SET role = 'admin' WHERE email = '<address>';

(client-supplied role fields are ignored everywhere else).

Self-protection rules (deliberate, applied to the CURRENT admin only):
- An admin cannot deactivate or un-verify their own account (both would
  immediately cut them off from these endpoints).
- An admin cannot demote their own role (prevents a locked-out last admin).
Other admins are fair game.
"""

import uuid
from datetime import datetime, timezone
from typing import Annotated, Literal

from fastapi import APIRouter, Depends, HTTPException, Query, Request, status
from pydantic import BaseModel, ConfigDict, Field
from sqlalchemy import func, select, update
from sqlalchemy.exc import SQLAlchemyError
from sqlalchemy.orm import Session

from backend.api.auth import _untrusted_origin
from backend.api.codes import ADMIN_REQUIRED_CODE, ADMIN_REQUIRED_MESSAGE
from backend.api.db_deps import get_db
from backend.api.dependencies import get_current_user
from backend.models import AuthSession, User
from backend.rate_limit import enforce_rate_limit

router = APIRouter(prefix="/api/v1/admin", tags=["admin"])

ADMIN_MAX_SESSION_ROWS = 50


def require_admin(
    request: Request,
    current_user: User = Depends(get_current_user),
) -> User:
    """Authorization gate (the first in this app): only role == 'admin'
    passes; everyone else — including normal authenticated users — gets a
    structured 403. Unauthenticated callers keep the 401 from
    get_current_user."""
    if current_user.role != "admin":
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={"message": ADMIN_REQUIRED_MESSAGE, "code": ADMIN_REQUIRED_CODE},
        )
    return current_user


class AdminUserSummary(BaseModel):
    model_config = ConfigDict(from_attributes=True)

    id: uuid.UUID
    full_name: str
    email: str
    role: str
    is_active: bool
    is_email_verified: bool
    email_verified_at: datetime | None
    created_at: datetime
    updated_at: datetime
    live_session_count: int = 0


class AdminSessionRow(BaseModel):
    """Session metadata WITHOUT token hashes — identifiers and times only."""

    id: uuid.UUID
    created_at: datetime
    expires_at: datetime
    revoked_at: datetime | None
    live: bool


class AdminUserDetail(AdminUserSummary):
    sessions: list[AdminSessionRow]


class AdminUserList(BaseModel):
    total: int
    page: int
    page_size: int
    items: list[AdminUserSummary]


class AdminOverview(BaseModel):
    total_users: int
    verified_users: int
    active_users: int
    admin_users: int
    live_sessions: int
    recent_registrations: list[AdminUserSummary]


class AdminUserPatch(BaseModel):
    model_config = ConfigDict(extra="ignore")

    is_active: bool | None = None
    is_email_verified: bool | None = None


class AdminRolePatch(BaseModel):
    model_config = ConfigDict(extra="ignore")

    role: Literal["user", "admin"]


class AdminSessionRevoke(BaseModel):
    model_config = ConfigDict(extra="ignore")

    session_id: uuid.UUID | None = Field(
        default=None,
        description="Revoke this one session; omit to revoke ALL live sessions.",
    )


class AdminRevokedCount(BaseModel):
    revoked: int


def _now() -> datetime:
    return datetime.now(timezone.utc)


def _live_sessions(db: Session) -> int:
    return int(
        db.scalar(
            select(func.count())
            .select_from(AuthSession)
            .where(
                AuthSession.revoked_at.is_(None),
                AuthSession.expires_at > _now(),
            )
        )
        or 0
    )


def _session_counts(db: Session, user_ids: list[uuid.UUID]) -> dict[uuid.UUID, int]:
    """Live-session counts for a set of users in ONE grouped query."""
    if not user_ids:
        return {}
    rows = db.execute(
        select(AuthSession.user_id, func.count())
        .where(
            AuthSession.user_id.in_(user_ids),
            AuthSession.revoked_at.is_(None),
            AuthSession.expires_at > _now(),
        )
        .group_by(AuthSession.user_id)
    ).all()
    return {user_id: int(count) for user_id, count in rows}


def _summary(db: Session, user: User, counts: dict[uuid.UUID, int] | None = None) -> AdminUserSummary:
    if counts is None:
        counts = _session_counts(db, [user.id])
    return AdminUserSummary(
        id=user.id,
        full_name=user.full_name,
        email=user.email,
        role=user.role,
        is_active=user.is_active,
        is_email_verified=user.is_email_verified,
        email_verified_at=user.email_verified_at,
        created_at=user.created_at,
        updated_at=user.updated_at,
        live_session_count=counts.get(user.id, 0),
    )


def _get_user_or_404(db: Session, user_id: uuid.UUID) -> User:
    user = db.get(User, user_id)
    if user is None:
        raise HTTPException(
            status_code=status.HTTP_404_NOT_FOUND,
            detail="User not found.",
        )
    return user


@router.get("/overview", response_model=AdminOverview)
def overview(admin: User = Depends(require_admin), db: Session = Depends(get_db)) -> AdminOverview:
    total = int(db.scalar(select(func.count()).select_from(User)) or 0)
    verified = int(
        db.scalar(select(func.count()).select_from(User).where(User.is_email_verified.is_(True))) or 0
    )
    active = int(
        db.scalar(select(func.count()).select_from(User).where(User.is_active.is_(True))) or 0
    )
    admins = int(
        db.scalar(select(func.count()).select_from(User).where(User.role == "admin")) or 0
    )
    recent_rows = db.scalars(
        select(User).order_by(User.created_at.desc()).limit(5)
    ).all()
    return AdminOverview(
        total_users=total,
        verified_users=verified,
        active_users=active,
        admin_users=admins,
        live_sessions=_live_sessions(db),
        recent_registrations=[
            _summary(db, row) for row in recent_rows
        ],
    )


@router.get("/users", response_model=AdminUserList)
def list_users(
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
    search: str | None = Query(default=None, max_length=120),
    page: Annotated[int, Query(ge=1)] = 1,
    page_size: Annotated[int, Query(ge=1, le=100)] = 20,
) -> AdminUserList:
    query = select(User)
    # Ordering is always server-defined; search is a substring match over
    # email/full_name only and reveals nothing beyond its matches.
    total_query = select(func.count()).select_from(User)
    if search:
        pattern = f"%{search.strip().lower()}%"
        filters = User.email.ilike(pattern) | User.full_name.ilike(pattern)
        query = query.where(filters)
        total_query = total_query.where(filters)
    total = int(db.scalar(total_query) or 0)
    rows = db.scalars(
        query.order_by(User.created_at.desc()).offset((page - 1) * page_size).limit(page_size)
    ).unique().all()
    counts = _session_counts(db, [row.id for row in rows])
    return AdminUserList(
        total=total,
        page=page,
        page_size=page_size,
        items=[_summary(db, row, counts) for row in rows],
    )


@router.get("/users/{user_id}", response_model=AdminUserDetail)
def get_user(
    user_id: uuid.UUID,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminUserDetail:
    user = _get_user_or_404(db, user_id)
    now = _now()
    rows = db.scalars(
        select(AuthSession)
        .where(AuthSession.user_id == user.id)
        .order_by(AuthSession.created_at.desc())
        .limit(ADMIN_MAX_SESSION_ROWS)
    ).all()
    sessions = [
        AdminSessionRow(
            id=row.id,
            created_at=row.created_at,
            expires_at=row.expires_at,
            revoked_at=row.revoked_at,
            live=bool(
                row.revoked_at is None
                and row.expires_at.tzinfo is not None
                and row.expires_at > now
            ),
        )
        for row in rows
    ]
    detail = AdminUserDetail(
        **_summary(db, user).model_dump(),
        sessions=sessions,
    )
    return detail


@router.patch("/users/{user_id}", response_model=AdminUserSummary)
def patch_user(
    user_id: uuid.UUID,
    payload: AdminUserPatch,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminUserSummary:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    user = _get_user_or_404(db, user_id)

    # Self-protection: deactivate/un-verify of the CURRENT admin is always a
    # 400. Deactivating an account while its owner has a session is
    # meaningless (resolve() rejects inactive users) — sessions are also
    # revoked for an immediate, observable effect.
    if user.id == admin.id:
        if payload.is_active is False:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You cannot deactivate your own account.",
            )
        if payload.is_email_verified is False:
            raise HTTPException(
                status_code=status.HTTP_400_BAD_REQUEST,
                detail="You cannot un-verify your own account.",
            )

    changed = False
    if payload.is_active is not None and payload.is_active != user.is_active:
        user.is_active = payload.is_active
        changed = True
    if (
        payload.is_email_verified is not None
        and payload.is_email_verified != user.is_email_verified
    ):
        user.is_email_verified = payload.is_email_verified
        user.email_verified_at = (
            _now() if payload.is_email_verified else None
        )
        changed = True
    if not changed:
        return _summary(db, user)
    db.commit()
    db.refresh(user)

    # Server-side gate teeth: flipped flags affect the user's sessions the
    # same way they affect future logins.
    if not user.is_active or not user.is_email_verified:
        revoked = db.execute(
            update(AuthSession)
            .where(
                AuthSession.user_id == user.id,
                AuthSession.revoked_at.is_(None),
            )
            .values(revoked_at=_now())
        )
        db.commit()
        _ = revoked.rowcount
    return _summary(db, user)


@router.post("/users/{user_id}/sessions/revoke", response_model=AdminRevokedCount)
def revoke_sessions(
    user_id: uuid.UUID,
    payload: AdminSessionRevoke,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminRevokedCount:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    _get_user_or_404(db, user_id)  # existence check; unknown id → 404
    conditions = [
        AuthSession.user_id == user_id,
        AuthSession.revoked_at.is_(None),
    ]
    if payload.session_id is not None:
        conditions.append(AuthSession.id == payload.session_id)
    result = db.execute(
        update(AuthSession).where(*conditions).values(revoked_at=_now())
    )
    try:
        db.commit()
    except SQLAlchemyError as exc:  # pragma: no cover - unexpected DB failure
        db.rollback()
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="Database error. Please try again.",
        ) from exc
    return AdminRevokedCount(revoked=int(result.rowcount or 0))


@router.post("/users/{user_id}/role", response_model=AdminUserSummary)
def set_role(
    user_id: uuid.UUID,
    payload: AdminRolePatch,
    request: Request,
    admin: User = Depends(require_admin),
    db: Session = Depends(get_db),
) -> AdminUserSummary:
    _untrusted_origin(request)
    enforce_rate_limit(request, "admin")
    user = _get_user_or_404(db, user_id)
    if user.id == admin.id and payload.role != "admin":
        # No self-demotion: prevents the last admin from locking themselves
        # out of authorization entirely.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail="You cannot demote your own account.",
        )
    if user.role != payload.role:
        user.role = payload.role
        db.commit()
        db.refresh(user)
    return _summary(db, user)
