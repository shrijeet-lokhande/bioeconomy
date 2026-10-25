"""Authentication endpoints.

All state-changing routes perform an Origin check (CSRF defense in depth
alongside SameSite=Lax cookies). Errors are deliberately non-revealing.
No password hashes, session tokens, verification tokens, or logging of
credentials anywhere.
"""

import logging

from fastapi import APIRouter, Depends, HTTPException, Request, Response, status
from sqlalchemy import select
from sqlalchemy.exc import IntegrityError
from sqlalchemy.orm import Session

from backend.api.db_deps import get_db
from backend.api.dependencies import get_current_user
from backend.api.codes import (
    VERIFICATION_REQUIRED_CODE,
    VERIFICATION_REQUIRED_DETAIL,
)
from backend.config import get_settings
from backend.mailer import (
    EmailDeliveryError,
    EmailSender,
    VerificationEmailContext,
    build_verification_email,
    get_email_sender,
    verification_url,
)
from backend.models import User
from backend.rate_limit import enforce_rate_limit
from backend.schemas import (
    LoginRequest,
    RegisterRequest,
    RegisterResponse,
    ResendVerificationRequest,
    ResendVerificationResponse,
    UserPublic,
    VerifyEmailRequest,
    VerifyEmailResponse,
)
from backend.security import hash_password, verify_password
from backend.sessions import (
    SESSION_COOKIE_NAME,
    SessionService,
)
from backend.verification import VerificationService

router = APIRouter(prefix="/api/v1/auth", tags=["auth"])
logger = logging.getLogger("backend.auth")

UNAUTHENTICATED_MESSAGE = "Invalid email or password."
# One generic rejection covers unknown / expired / already-used tokens.
TOKEN_REJECTED_MESSAGE = (
    "This verification link is invalid or has expired. "
    "Request a new verification email."
)
RESEND_NEUTRAL_MESSAGE = (
    "If this address has an account awaiting verification, "
    "a new verification email has been sent."
)
VERIFY_UPDATED_MESSAGE = (
    "Email address verified. You can now sign in."
)

# Constant-time equivalence for the "unknown email" branch: verifying against
# a real Argon2id hash for a fixed dummy password removes the timing oracle
# that would otherwise reveal whether an email exists.
_DUMMY_HASH = hash_password("dummy-password-used-only-for-timing-equivalence")


def _is_allowed_origin(request: Request) -> bool:
    origin = request.headers.get("origin")
    if origin is None:
        # Non-browser clients (curl, tests, service-to-service) may omit
        # Origin. Browser same-origin requests include it.
        return True
    return origin in get_settings().cors_origins


def _untrusted_origin(request: Request) -> None:
    if not _is_allowed_origin(request):
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Request origin is not allowed.",
        )


def _set_session_cookie(response: Response, token: str) -> None:
    settings = get_settings()
    response.set_cookie(
        key=SESSION_COOKIE_NAME,
        value=token,
        max_age=settings.session_lifetime_hours * 3600,
        httponly=True,
        secure=settings.cookie_secure,
        samesite=settings.cookie_samesite,
        path="/",
    )


def _send_verification_email(
    user: User, raw_token: str, sender: EmailSender
) -> str:
    """Sends the verification email. Never raises for the "provider
    unavailable" path — failure is reported to the REGISTER caller so it can
    offer resend. Raw token never logged; link only goes into the bodies."""
    settings = get_settings()
    outgoing = build_verification_email(
        VerificationEmailContext(
            recipient=user.email,
            full_name=user.full_name,
            verification_url=verification_url(settings.app_base_url, raw_token),
            expires_in_minutes=settings.verification_token_minutes,
        )
    )
    try:
        sender.send(outgoing)
    except EmailDeliveryError as exc:
        logger.error("Verification email delivery failed for %s: %s", user.email, exc)
        return "failed"
    return "accepted"


@router.post("/register", status_code=status.HTTP_201_CREATED, response_model=RegisterResponse)
def register(
    payload: RegisterRequest,
    request: Request,
    db: Session = Depends(get_db),
    sender: EmailSender = Depends(get_email_sender),
) -> RegisterResponse:
    _untrusted_origin(request)
    enforce_rate_limit(request, "register")

    existing = db.scalar(select(User).where(User.email == payload.email))
    if existing is not None:
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This email address is already registered.",
        )

    # Role/is_active/is_email_verified are server-controlled constants;
    # RegisterRequest ignores any client-supplied fields of those names.
    user = User(
        full_name=payload.full_name,
        email=payload.email,
        password_hash=hash_password(payload.password),
        role="user",
        is_active=True,
        is_email_verified=False,
    )
    db.add(user)
    try:
        db.commit()
    except IntegrityError:
        db.rollback()
        # Safe handling of the unique-constraint race between the check
        # above and the commit.
        raise HTTPException(
            status_code=status.HTTP_409_CONFLICT,
            detail="This email address is already registered.",
        ) from None
    db.refresh(user)

    # If delivery fails the account still exists and remains recoverable via
    # resend-verification; the REGISTER response tells the creator the truth
    # so the UI never claims an email that was not accepted.
    verification = VerificationService(db)
    raw_token = verification.issue(user)
    verification.purge_stale()
    delivery = _send_verification_email(user, raw_token, sender)

    body = RegisterResponse(
        **UserPublic.model_validate(user).model_dump(),
        verification_required=True,
        email_delivery=delivery,
    )
    return body


@router.post(
    "/login",
    response_model=UserPublic,
    responses={403: {"description": "Email verification required, or inactive account"}},
)
def login(
    payload: LoginRequest,
    request: Request,
    response: Response,
    db: Session = Depends(get_db),
) -> User:
    _untrusted_origin(request)
    enforce_rate_limit(request, "login")

    service = SessionService(db)
    user = db.scalar(select(User).where(User.email == payload.email))

    if user is None:
        # Keep work comparable with the credential-verification branch.
        verify_password(payload.password, _DUMMY_HASH)
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=UNAUTHENTICATED_MESSAGE,
        )

    if not verify_password(payload.password, user.password_hash):
        raise HTTPException(
            status_code=status.HTTP_401_UNAUTHORIZED,
            detail=UNAUTHENTICATED_MESSAGE,
        )

    if not user.is_active:
        # The caller has already proven the correct password; telling the
        # legitimate owner that the account is deactivated is intended.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Account is inactive.",
        )

    if not user.is_email_verified:
        # Policy change (Task 003): NO session is created for unverified
        # accounts; the frontend keys on the structured code to route to the
        # verification-pending screen.
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail={
                "message": VERIFICATION_REQUIRED_DETAIL,
                "code": VERIFICATION_REQUIRED_CODE,
            },
        )

    token, _ = service.create(user)
    service.purge_expired()

    _set_session_cookie(response, token)
    return user


@router.post("/logout", status_code=status.HTTP_204_NO_CONTENT)
def logout(request: Request, db: Session = Depends(get_db)) -> Response:
    _untrusted_origin(request)

    token = request.cookies.get(SESSION_COOKIE_NAME)
    if token:
        SessionService(db).revoke_by_token(token)

    settings = get_settings()
    # Mutate and return the same Response; FastAPI sends it as-is.
    cleared = Response(status_code=status.HTTP_204_NO_CONTENT)
    cleared.delete_cookie(
        key=SESSION_COOKIE_NAME,
        path="/",
        secure=settings.cookie_secure,
        httponly=True,
        samesite=settings.cookie_samesite,
    )
    return cleared


@router.get("/me", response_model=UserPublic)
def me(current_user: User = Depends(get_current_user)) -> User:
    return current_user


@router.post("/verify-email", response_model=VerifyEmailResponse)
def verify_email(
    payload: VerifyEmailRequest,
    request: Request,
    db: Session = Depends(get_db),
) -> VerifyEmailResponse:
    _untrusted_origin(request)
    enforce_rate_limit(request, "verify")

    user = VerificationService(db).consume(payload.token)
    if user is None:
        # Unknown, expired, and reused tokens all collapse into one generic
        # rejection — probing tokens reveals nothing extra.
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=TOKEN_REJECTED_MESSAGE,
        )
    return VerifyEmailResponse(message=VERIFY_UPDATED_MESSAGE)


@router.post(
    "/resend-verification",
    status_code=status.HTTP_202_ACCEPTED,
    response_model=ResendVerificationResponse,
)
def resend_verification(
    payload: ResendVerificationRequest,
    request: Request,
    db: Session = Depends(get_db),
    sender: EmailSender = Depends(get_email_sender),
) -> ResendVerificationResponse:
    _untrusted_origin(request)
    enforce_rate_limit(request, "resend")

    user = db.scalar(select(User).where(User.email == payload.email))
    # The response is ALWAYS this neutral message: existence, verified state,
    # and delivery outcome are not distinguishable from the outside.
    # Delivery problems are observable server-side (logs/outbox) only.
    if (
        user is not None
        and user.is_active
        and not user.is_email_verified
    ):
        verification = VerificationService(db)
        raw_token = verification.issue(user)
        verification.purge_stale()
        _send_verification_email(user, raw_token, sender)

    return ResendVerificationResponse(message=RESEND_NEUTRAL_MESSAGE)


__all__ = [
    "SESSION_COOKIE_NAME",
    "me",
    "login",
    "logout",
    "register",
    "resend_verification",
    "router",
    "verify_email",
]
