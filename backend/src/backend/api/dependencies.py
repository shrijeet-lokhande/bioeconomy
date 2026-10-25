"""FastAPI dependencies for authentication."""

from fastapi import Depends, HTTPException, Request, status
from sqlalchemy.orm import Session

from backend.api.db_deps import get_db
from backend.api.codes import VERIFICATION_REQUIRED_CODE, VERIFICATION_REQUIRED_DETAIL
from backend.models import User
from backend.sessions import SESSION_COOKIE_NAME, SessionService


def get_current_user(request: Request, db: Session = Depends(get_db)) -> User:
    token = request.cookies.get(SESSION_COOKIE_NAME)
    if not token:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Not authenticated.",
        )
    resolved = SessionService(db).resolve(token)
    if resolved is None:
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail="Session is invalid or expired.",
        )
    user, session_row = resolved
    if not user.is_email_verified:
        # Task 003 policy: sessions belonging to unverified accounts (also
        # ones created before this feature existed) cannot reach any
        # authenticated endpoint. Frontend keys on the structured code.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "message": VERIFICATION_REQUIRED_DETAIL,
                "code": VERIFICATION_REQUIRED_CODE,
            },
        )
    # Keep the row for logout so the session can be revoked without a
    # second lookup.
    request.state.auth_session = session_row
    return user
