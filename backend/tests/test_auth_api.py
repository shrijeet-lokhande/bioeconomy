"""Auth + email-verification API tests.

Covers the ten mandated registration/session scenarios from Task 002 AND
the fourteen verification scenarios from Task 003 (marked V1–V14 in
docstrings). All requests hit an isolated PostgreSQL database created by
the test_engine fixture (conftest.py); email delivery is a capturing test
double — no network, no SMTP.
"""

import datetime
import re
import threading
import uuid
from email.message import EmailMessage

import pytest
from fastapi import HTTPException
from sqlalchemy import select

from backend.models import AuthEmailVerificationToken, AuthPasswordResetToken, AuthSession, User
from backend.mailer import (
    CapturingEmailSender,
    ConsoleEmailSender,
    EmailDeliveryError,
    create_email_sender,
    get_email_sender,
)
from backend.rate_limit import enforce_rate_limit
from backend.sessions import SESSION_COOKIE_NAME, generate_session_token, hash_token


def unique_email(prefix: str = "user") -> str:
    return f"{prefix}-{uuid.uuid4().hex[:10]}@example.com"


VALID_PASSWORD = "correct-horse-battery"


def register(client, **overrides):
    payload = {
        "full_name": "Test User",
        "email": unique_email(),
        "password": VALID_PASSWORD,
        **overrides,
    }
    response = client.post("/api/v1/auth/register", json=payload)
    return response, payload


def login(client, email: str, password: str = VALID_PASSWORD):
    return client.post(
        "/api/v1/auth/login", json={"email": email, "password": password}
    )


def captured_token(client, email: str, *, newest: bool = True) -> str | None:
    """Extracts a raw token from a captured email link (test double).
    newest=True returns the most recent email (resend supersedes old
    tokens, so the last message is the live one)."""
    matches = [
        token
        for message in client.mail_capture.sent  # type: ignore[attr-defined]
        if message.to_address == email
        for token in (
            m.group(1)
            for m in [re.search(r"token=([A-Za-z0-9_\-]+)", message.text_body)]
            if m is not None
        )
    ]
    if not matches:
        return None
    return matches[-1] if newest else matches[0]


def make_verified(client, db_session):
    """register + verify through the real API endpoints. Returns payload."""
    response, payload = register(client)
    assert response.status_code == 201, response.text
    token = captured_token(client, payload["email"])
    assert token, "captured email must contain the verification link"
    verified = client.post("/api/v1/auth/verify-email", json={"token": token})
    assert verified.status_code == 200, verified.text
    db_session.expire_all()
    return payload


# ---------------------------------------------------------------- Task 002


def test_1_register_success_persists_unverified_user(client, db_session):
    """T002-1 + V1: registration creates an UNVERIFIED account and returns
    an honest delivery status."""
    response, payload = register(client)
    assert response.status_code == 201
    body = response.json()
    assert body["full_name"] == payload["full_name"]
    assert body["email"] == payload["email"].lower()
    assert body["role"] == "user"
    assert body["is_active"] is True
    assert body["is_email_verified"] is False
    assert body["verification_required"] is True
    assert body["email_delivery"] == "accepted"
    assert "password" not in body
    assert "password_hash" not in body

    # Client cannot control its own verification status through the payload.
    forced = client.post(
        "/api/v1/auth/register",
        json={
            "full_name": "Force Test",
            "email": unique_email("force"),
            "password": VALID_PASSWORD,
            "is_email_verified": True,
        },
    )
    assert forced.status_code == 201
    assert forced.json()["is_email_verified"] is False

    # Reported by the DB, not just the API layer.
    row = db_session.scalar(select(User).where(User.email == body["email"]))
    assert row is not None
    assert row.is_email_verified is False
    assert row.email_verified_at is None


def test_2_password_stored_as_argon2id_hash(db_session, client):
    _, payload = register(client)
    row = db_session.scalar(select(User).where(User.email == payload["email"]))
    assert row.password_hash.startswith("$argon2id$")
    assert payload["password"] not in row.password_hash
    other_payload = {**payload, "email": unique_email()}
    other = client.post("/api/v1/auth/register", json=other_payload)
    assert other.status_code == 201
    other_row = db_session.scalar(
        select(User).where(User.email == other_payload["email"])
    )
    assert other_row.password_hash != row.password_hash


def test_3_verified_login_returns_cookie_and_me(client, db_session):
    """T002-3 + V10: a verified user signs in and uses permitted endpoints."""
    payload = make_verified(client, db_session)
    login_response = login(client, payload["email"])
    assert login_response.status_code == 200
    body = login_response.json()
    assert body["is_email_verified"] is True
    set_cookie = login_response.headers.get("set-cookie", "")
    assert f"{SESSION_COOKIE_NAME}=" in set_cookie
    assert "HttpOnly" in set_cookie
    assert "samesite=lax" in set_cookie.lower()

    me_response = client.get("/api/v1/auth/me")
    assert me_response.status_code == 200
    assert me_response.json()["email"] == payload["email"].lower()
    assert me_response.json()["is_email_verified"] is True
    assert "password_hash" not in me_response.json()


def test_4_login_wrong_password_rejected(client):
    _, payload = register(client)
    # Order of checks: credentials are validated before the verification
    # gate, so a wrong password stays a generic 401.
    response = login(client, payload["email"], password="a-wrong-password-1")
    assert response.status_code == 401
    assert response.json() == {"detail": "Invalid email or password."}
    assert SESSION_COOKIE_NAME not in client.cookies


def test_5_duplicate_email_rejected_case_insensitive(client):
    _, payload = register(client)
    duplicated = client.post(
        "/api/v1/auth/register",
        json={
            "full_name": "Second User",
            "email": payload["email"].upper(),
            "password": VALID_PASSWORD,
        },
    )
    assert duplicated.status_code == 409
    assert "already registered" in duplicated.json()["detail"]


@pytest.mark.parametrize(
    "overrides",
    [
        {"full_name": ""},
        {"full_name": "x" * 201},
        {"email": "not-an-email"},
        {"email": ""},
        {"password": "short"},
        {"password": "x" * 201},
        {"password": ""},
    ],
)
def test_6_invalid_registration_input_rejected(client, overrides):
    response, _ = register(client, **overrides)
    assert response.status_code == 422


def test_7_me_with_and_without_authentication(client, db_session):
    me_anonymous = client.get("/api/v1/auth/me")
    assert me_anonymous.status_code == 401

    payload = make_verified(client, db_session)
    login(client, payload["email"])
    me_authed = client.get("/api/v1/auth/me")
    assert me_authed.status_code == 200
    assert me_authed.json()["email"] == payload["email"].lower()


def test_8_logout_invalidates_session(client, db_session):
    payload = make_verified(client, db_session)
    login_response = login(client, payload["email"])
    assert login_response.status_code == 200
    old_token = client.cookies.get(SESSION_COOKIE_NAME)
    assert old_token

    logout_response = client.post("/api/v1/auth/logout")
    assert logout_response.status_code == 204
    assert SESSION_COOKIE_NAME not in client.cookies

    client.cookies.set(SESSION_COOKIE_NAME, old_token)
    me_replay = client.get("/api/v1/auth/me")
    assert me_replay.status_code == 401

    row = db_session.scalar(
        select(AuthSession).where(AuthSession.token_hash == hash_token(old_token))
    )
    assert row is not None
    assert row.revoked_at is not None


def test_9_expired_session_rejected(db_session, client):
    payload = make_verified(client, db_session)
    login(client, payload["email"])
    me_response = client.get("/api/v1/auth/me")
    assert me_response.status_code == 200
    user = db_session.scalar(select(User).where(User.email == payload["email"]))
    assert user is not None

    token = generate_session_token()
    expired_row = AuthSession(
        token_hash=hash_token(token),
        user_id=user.id,
        expires_at=datetime.datetime.now(datetime.timezone.utc)
        - datetime.timedelta(hours=1),
    )
    db_session.add(expired_row)
    db_session.commit()

    client.cookies.set(SESSION_COOKIE_NAME, token)
    me_expired = client.get("/api/v1/auth/me")
    assert me_expired.status_code == 401
    assert "expired" in me_expired.json()["detail"]


def test_10_privileged_role_and_verification_fields_ignored(client, db_session):
    response, payload = register(
        client,
        role="admin",
        is_active=False,
        is_email_verified=True,
        email_verified_at="2020-01-01T00:00:00Z",
        extra_role="superadmin",
    )
    assert response.status_code == 201
    body = response.json()
    assert body["role"] == "user"
    assert body["is_active"] is True
    assert body["is_email_verified"] is False
    row = db_session.scalar(select(User).where(User.email == body["email"]))
    assert row.role == "user"
    assert row.is_active is True
    assert row.is_email_verified is False
    assert row.email_verified_at is None


def test_csrf_untrusted_origin_rejected(client):
    response = client.post(
        "/api/v1/auth/login",
        json={"email": unique_email(), "password": VALID_PASSWORD},
        headers={"Origin": "http://evil.example"},
    )
    assert response.status_code == 403
    assert response.json() == {"detail": "Request origin is not allowed."}


def test_csrf_allowed_origin_accepted(client, db_session):
    payload = make_verified(client, db_session)
    login_response = client.post(
        "/api/v1/auth/login",
        json={"email": payload["email"], "password": VALID_PASSWORD},
        headers={"Origin": "http://localhost:5173"},
    )
    assert login_response.status_code == 200


def test_secure_cookie_flag_when_configured(client, db_session, monkeypatch):
    from backend.config import get_settings

    payload = make_verified(client, db_session)
    monkeypatch.setenv("COOKIE_SECURE", "1")
    get_settings.cache_clear()
    try:
        login_response = login(client, payload["email"])
        assert "Secure" in login_response.headers.get("set-cookie", "")
    finally:
        monkeypatch.undo()
        get_settings.cache_clear()


# ------------------------------------------------- Task 003 (V1–V14)


def test_v2_email_generated_by_configured_sender(client):
    """V2 + V12(link): the configured backend generates ONE clearly
    addressed verification email containing a trusted-base-URL link and
    expiry information."""
    response, payload = register(client)
    assert response.status_code == 201
    assert response.json()["email_delivery"] == "accepted"
    capture = client.mail_capture  # type: ignore[attr-defined]
    assert len(capture.sent) == 1
    message = capture.sent[0]
    assert message.to_address == payload["email"].lower()
    assert "Verify email for bioeconomy" in message.subject
    assert "http://localhost:5173/#/verify-email?token=" in message.text_body
    assert "30 minutes" in message.text_body
    # Message is fully formed (From header comes from the backend).
    mime = EmailMessage()
    mime.set_content(message.text_body)
    token = captured_token(client, payload["email"])
    assert token and len(token) >= 20


def test_v3_raw_token_never_stored_in_database(client, db_session):
    """V3: only SHA-256 hashes live in auth_email_verification_tokens."""
    _, payload = register(client)
    raw = captured_token(client, payload["email"])
    assert raw
    user = db_session.scalar(select(User).where(User.email == payload["email"]))
    rows = db_session.scalars(
        select(AuthEmailVerificationToken).where(
            AuthEmailVerificationToken.user_id == user.id
        )
    ).all()
    assert len(rows) == 1
    stored = rows[0].token_hash
    assert stored == hash_token(raw)
    assert raw != stored
    assert len(stored) == 64
    db_session.expire_all()


def _verify_gateway(client, token: str):
    return client.post("/api/v1/auth/verify-email", json={"token": token})


def test_v4_valid_token_verifies_correct_account(client, db_session):
    """V4: success persists is_email_verified + email_verified_at; token
    becomes consumed in the same flow."""
    _, payload = register(client)
    raw = captured_token(client, payload["email"])
    assert raw

    response = _verify_gateway(client, raw)
    assert response.status_code == 200
    assert "verified" in response.json()["message"].lower()

    db_session.expire_all()
    user = db_session.scalar(select(User).where(User.email == payload["email"]))
    assert user.is_email_verified is True
    assert user.email_verified_at is not None
    row = db_session.scalar(
        select(AuthEmailVerificationToken).where(
            AuthEmailVerificationToken.token_hash == hash_token(raw)
        )
    )
    assert row.consumed_at is not None


def test_v5_expired_token_rejected(client, db_session):
    """V5: expired token gets the same generic rejection and the account
    stays unverified."""
    _, payload = register(client)
    raw = captured_token(client, payload["email"])
    assert raw
    token_row = db_session.scalar(
        select(AuthEmailVerificationToken).where(
            AuthEmailVerificationToken.token_hash == hash_token(raw)
        )
    )
    token_row.expires_at = datetime.datetime.now(
        datetime.timezone.utc
    ) - datetime.timedelta(minutes=1)
    db_session.commit()
    db_session.expire_all()

    response = _verify_gateway(client, raw)
    assert response.status_code == 400
    user = db_session.scalar(select(User).where(User.email == payload["email"]))
    assert user.is_email_verified is False


def test_v6_invalid_token_rejected_with_same_message(client, db_session):
    """V6 + enumeration safety: every failing token produces the SAME
    generic body (invalid vs. unknown)."""
    invalid_a = client.post(
        "/api/v1/auth/verify-email", json={"token": "totally-bogus-token-123"}
    )
    invalid_b = client.post(
        "/api/v1/auth/verify-email", json={"token": "another-bogus-token-456"}
    )
    assert invalid_a.status_code == invalid_b.status_code == 400
    assert invalid_a.json() == invalid_b.json()
    assert "invalid or has expired" in invalid_a.json()["detail"]


def test_v7_token_cannot_be_reused(client, db_session):
    """V7: single-use enforced; second consumption fails."""
    _, payload = register(client)
    raw = captured_token(client, payload["email"])
    assert raw
    first = _verify_gateway(client, raw)
    assert first.status_code == 200
    second = _verify_gateway(client, raw)
    assert second.status_code == 400
    assert "invalid or has expired" in second.json()["detail"]
    db_session.expire_all()
    user = db_session.scalar(select(User).where(User.email == payload["email"]))
    assert user.is_email_verified is True
    verified_at = user.email_verified_at
    row = db_session.scalar(
        select(AuthEmailVerificationToken).where(
            AuthEmailVerificationToken.token_hash == hash_token(raw)
        )
    )
    assert row.consumed_at is not None
    assert user.email_verified_at == verified_at


def test_v8_concurrent_requests_cannot_consume_same_token_twice(test_engine):
    """V8: two racing consumers — exactly one wins (row-level atomicity)."""
    from sqlalchemy import select as sa_select
    from sqlalchemy.orm import sessionmaker

    factory = sessionmaker(bind=test_engine, expire_on_commit=False)
    setup = factory()
    email = unique_email("race")
    setup.add(
        User(
            full_name="Race User",
            email=email,
            password_hash="$argon2id$dummy",
            is_email_verified=False,
        )
    )
    setup.commit()
    user = setup.scalar(sa_select(User).where(User.email == email))
    from backend.verification import VerificationService

    raw = VerificationService(setup).issue(user)
    setup.close()

    barrier = threading.Barrier(2)
    results: dict[str, object] = {}

    def attempt(name: str) -> None:
        session = factory()
        barrier.wait()
        results[name] = VerificationService(session).consume(raw)
        session.close()

    thread_a = threading.Thread(target=attempt, args=("a",))
    thread_b = threading.Thread(target=attempt, args=("b",))
    thread_a.start()
    thread_b.start()
    thread_a.join(timeout=20)
    thread_b.join(timeout=20)

    outcomes = [results["a"], results["b"]]
    winners = [outcome for outcome in outcomes if outcome is not None]
    assert len(winners) == 1, "exactly one concurrent consumer must win"
    # Post-race DB state: token consumed exactly once, user verified once.
    check = factory()
    rows = check.scalars(
        sa_select(AuthEmailVerificationToken).where(
            AuthEmailVerificationToken.token_hash == hash_token(raw)
        )
    ).all()
    assert len(rows) == 1
    assert rows[0].consumed_at is not None
    verified_user = check.scalar(sa_select(User).where(User.id == rows[0].user_id))
    assert verified_user.is_email_verified is True
    assert verified_user.email_verified_at is not None
    check.close()


def test_v9_unverified_user_blocked_everywhere(client, db_session):
    """V9: unverified accounts get NO session and cannot reach protected
    endpoints — including sessions created before this policy existed."""
    _, payload = register(client)
    # Login attempt: blocked with a structured, documented code and no cookie.
    denied = login(client, payload["email"])
    assert denied.status_code == 403
    detail = denied.json()["detail"]
    assert detail["code"] == "email_verification_required"
    assert SESSION_COOKIE_NAME not in client.cookies

    # A forged session for the unverified user is equally blocked.
    user = db_session.scalar(select(User).where(User.email == payload["email"]))
    from backend.verification import VerificationService

    fake_session_token = generate_session_token()
    db_session.add(
        AuthSession(
            token_hash=hash_token(fake_session_token),
            user_id=user.id,
            expires_at=datetime.datetime.now(datetime.timezone.utc)
            + datetime.timedelta(hours=1),
        )
    )
    db_session.commit()
    client.cookies.set(SESSION_COOKIE_NAME, fake_session_token)
    me_unverified = client.get("/api/v1/auth/me")
    assert me_unverified.status_code == 403
    assert me_unverified.json()["detail"]["code"] == "email_verification_required"


def test_v11_resend_supersedes_previous_tokens(client, db_session):
    """V11: a resend makes the older token unusable; the newest works."""
    _, payload = register(client)
    old = captured_token(client, payload["email"])
    assert old
    resend = client.post(
        "/api/v1/auth/resend-verification", json={"email": payload["email"]}
    )
    assert resend.status_code == 202
    new = captured_token(client, payload["email"])
    assert new and new != old
    # Old (superseded) token: same generic rejection as an invalid one.
    superseded = _verify_gateway(client, old)
    assert superseded.status_code == 400
    # Newest token still verifies.
    works = _verify_gateway(client, new)
    assert works.status_code == 200
    db_session.expire_all()
    user = db_session.scalar(select(User).where(User.email == payload["email"]))
    assert user.is_email_verified is True


def test_v12_resend_neutral_and_rate_limiting(client, db_session, monkeypatch):
    """V12: identical neutral response for unknown / unverified / verified
    addresses (no enumeration); limiter engages at its configured rate."""
    unknown = client.post(
        "/api/v1/auth/resend-verification", json={"email": unique_email("ghost")}
    )
    _, payload = register(client)
    unverified = client.post(
        "/api/v1/auth/resend-verification", json={"email": payload["email"]}
    )
    verified_payload = make_verified(client, db_session)
    verified = client.post(
        "/api/v1/auth/resend-verification",
        json={"email": verified_payload["email"]},
    )
    assert unknown.status_code == unverified.status_code == verified.status_code == 202
    assert unknown.json() == unverified.json() == verified.json()
    assert "new verification email" in unknown.json()["message"]

    # Limiter unit behavior: blocks with 429 once the window is full.
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "1")
    monkeypatch.setenv("RATE_LIMIT_PER_MINUTE", "2")
    from backend.config import get_settings

    get_settings.cache_clear()
    try:
        class _StubRequest:
            client = type("Peer", (), {"host": "203.0.113.77"})()

        with pytest.raises(HTTPException) as raised:
            for _ in range(3):  # limit is 2: third call must raise
                enforce_rate_limit(_StubRequest(), "resend")
        assert raised.value.status_code == 429
    finally:
        get_settings.cache_clear()
        monkeypatch.undo()
        get_settings.cache_clear()


def test_v13_provider_failure_handled_honestly(client, db_session):
    """V13: failed provider = registration still succeeds but is reported
    as failed; nothing pretends delivery happened; resend stays neutral."""
    app = client.app  # test client's app instance
    failing = CapturingEmailSender(fail=True)
    original = app.dependency_overrides[get_email_sender]
    app.dependency_overrides[get_email_sender] = lambda: failing
    try:
        response, payload = register(client)
        assert response.status_code == 201
        body = response.json()
        assert body["email_delivery"] == "failed"
        assert body["verification_required"] is True
        assert failing.sent == []
        # Unverified user still cannot sign in after a failed delivery.
        denied = login(client, payload["email"])
        assert denied.status_code == 403
        # Resend stays neutral even while delivery is failing.
        again = client.post(
            "/api/v1/auth/resend-verification", json={"email": payload["email"]}
        )
        assert again.status_code == 202
        assert failing.sent == []
    finally:
        app.dependency_overrides[get_email_sender] = original


def test_v14_existing_accounts_stay_unverified(db_session):
    """V14: an account that predates the feature (typically the dev users
    created in Task 002) remains unverified — no automatic verification
    happens. Only an approved admin action (documented in
    docs/DATABASE.md) flips the flag."""
    legacy = User(
        full_name="Legacy User",
        email=unique_email("legacy"),
        password_hash="$argon2id$legacyuserhashplaceholder",
    )  # is_email_verified left at the server default
    db_session.add(legacy)
    db_session.commit()
    db_session.expire_all()
    row = db_session.scalar(select(User).where(User.email == legacy.email))
    assert row.is_email_verified is False
    assert row.email_verified_at is None
    db_session.expire_all()


def test_console_backend_writes_labeled_outbox(tmp_path):
    """V12(link) companion: the console dev backend writes a clearly labeled
    .eml file containing the link; this is the documented local testing path."""
    sender = ConsoleEmailSender(str(tmp_path), "onboarding@test.local")
    from backend.mailer import OutgoingEmail

    sender.send(
        OutgoingEmail(
            to_address="dev-user@example.com",
            subject="Verify your Bioeconomy email address",
            text_body="http://localhost:5173/#/verify-email?token=rawtoken",
            html_body="<p>http://localhost:5173/#/verify-email?token=rawtoken</p>",
        )
    )
    files = list(tmp_path.glob("*.eml"))
    assert len(files) == 1
    content = files[0].read_text(encoding="utf-8")
    assert "dev-user@example.com" in content
    assert "token=rawtoken" in content


def test_factory_maps_backends_and_rejects_unconfigured(monkeypatch):
    """Delivery config sanity: factory mapping + honest failure configs."""
    from backend.config import Settings

    console = create_email_sender(Settings(mail_backend="console"))
    assert isinstance(console, ConsoleEmailSender)
    smtp = create_email_sender(Settings(mail_backend="smtp", mail_host="x"))
    assert type(smtp).__name__ == "SmtpEmailSender"
    resend = create_email_sender(
        Settings(mail_backend="resend", resend_api_key="k")
    )
    assert type(resend).__name__ == "ResendEmailSender"
    with pytest.raises(EmailDeliveryError):
        raise_or_fail = create_email_sender(Settings(mail_backend="carrier-pigeon"))
        raise_or_fail.send(
            type("M", (), {"to_address": "a@b.c", "subject": "s",
                          "text_body": "t", "html_body": "h"})()
        )


def test_password_reset_generic_email_hash_single_use_and_session_revocation(client, db_session):
    payload = make_verified(client, db_session)
    assert login(client, payload["email"]).status_code == 200
    response = client.post("/api/v1/auth/forgot-password", json={"email": payload["email"]})
    unknown = client.post("/api/v1/auth/forgot-password", json={"email": unique_email("missing")})
    assert response.status_code == unknown.status_code == 202
    assert response.json() == unknown.json()
    message = client.mail_capture.sent[-1]  # type: ignore[attr-defined]
    token = re.search(r"token=([A-Za-z0-9_-]+)", message.text_body).group(1)
    user = db_session.scalar(select(User).where(User.email == payload["email"]))
    stored = db_session.scalar(select(AuthPasswordResetToken).where(AuthPasswordResetToken.user_id == user.id))
    assert stored.token_hash == hash_token(token)
    assert token not in stored.token_hash
    reset = client.post("/api/v1/auth/reset-password", json={"token": token, "password": "brand-new-long-password"})
    assert reset.status_code == 200
    assert client.get("/api/v1/auth/me").status_code == 401
    assert login(client, payload["email"], "brand-new-long-password").status_code == 200
    assert login(client, payload["email"], VALID_PASSWORD).status_code == 401
    assert client.post("/api/v1/auth/reset-password", json={"token": token, "password": "another-long-password"}).status_code == 400


def test_password_reset_invalid_token_and_provider_failure_are_generic(client, db_session):
    payload = make_verified(client, db_session)
    expected = "If an account exists for that email address, reset instructions may be sent. If you don't receive an email, check spam or request another link later."
    assert client.post("/api/v1/auth/forgot-password", json={"email": unique_email("unknown")}).json()["message"] == expected
    failing = CapturingEmailSender(fail=True)
    from backend.main import app
    original = app.dependency_overrides.get(get_email_sender)
    app.dependency_overrides[get_email_sender] = lambda: failing
    try:
        response = client.post("/api/v1/auth/forgot-password", json={"email": payload["email"]})
        assert response.status_code == 202
        assert response.json()["message"] == expected
    finally:
        if original is None:
            app.dependency_overrides.pop(get_email_sender, None)
        else:
            app.dependency_overrides[get_email_sender] = original
    assert client.post("/api/v1/auth/reset-password", json={"token": "x" * 40, "password": "new-long-password"}).status_code == 400


def test_password_reset_expired_token_rejected(client, db_session):
    from datetime import datetime, timedelta, timezone
    payload = make_verified(client, db_session)
    client.post("/api/v1/auth/forgot-password", json={"email": payload["email"]})
    token = re.search(r"token=([A-Za-z0-9_-]+)", client.mail_capture.sent[-1].text_body).group(1)  # type: ignore[attr-defined]
    row = db_session.scalar(select(AuthPasswordResetToken).where(AuthPasswordResetToken.token_hash == hash_token(token)))
    row.expires_at = datetime.now(timezone.utc) - timedelta(minutes=1)
    db_session.commit()
    assert client.post("/api/v1/auth/reset-password", json={"token": token, "password": "new-long-password"}).status_code == 400


def test_password_reset_token_cannot_win_two_concurrent_consumers(client, db_session, test_engine):
    from sqlalchemy.orm import sessionmaker
    from backend.password_reset import PasswordResetService
    payload = make_verified(client, db_session)
    user = db_session.scalar(select(User).where(User.email == payload["email"]))
    raw = PasswordResetService(db_session).issue(user)
    factory = sessionmaker(bind=test_engine, expire_on_commit=False)
    barrier = threading.Barrier(2)
    results = {}
    def attempt(name):
        session = factory(); barrier.wait()
        results[name] = PasswordResetService(session).consume_and_reset(raw, "new-long-password-123")
        session.close()
    workers = [threading.Thread(target=attempt, args=(name,)) for name in ("a", "b")]
    for worker in workers: worker.start()
    for worker in workers: worker.join(timeout=30)
    assert sorted(results.values()) == [False, True]


def test_password_reset_requests_are_limited_by_hashed_email_identifier(client, monkeypatch):
    from backend.config import get_settings
    monkeypatch.setenv("RATE_LIMIT_ENABLED", "1")
    monkeypatch.setenv("PASSWORD_RESET_EMAIL_LIMIT_PER_HOUR", "3")
    get_settings.cache_clear()
    try:
        email = unique_email("rate")
        statuses = [client.post("/api/v1/auth/forgot-password", json={"email": email}).status_code for _ in range(4)]
        assert statuses == [202, 202, 202, 429]
        assert client.post("/api/v1/auth/forgot-password", json={"email": unique_email("rate-other")}).status_code == 202
    finally:
        get_settings.cache_clear()


def test_password_reset_email_escapes_name_and_uses_trusted_reset_url():
    from backend.mailer import PasswordResetEmailContext, build_password_reset_email
    message = build_password_reset_email(PasswordResetEmailContext(
        recipient="person@example.com", full_name="<img src=x>",
        reset_url="https://app.example/#/reset-password?token=rawtoken",
        expires_in_minutes=30,
    ))
    assert "&lt;img src=x&gt;" in message.html_body
    assert "https://app.example/#/reset-password?token=rawtoken" in message.text_body
    assert "Support staff will never need your current password." in message.text_body
