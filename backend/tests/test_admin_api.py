"""Admin endpoint tests (Task 005).

Authorization model under test:
- Unauthenticated → 401 (inherited from get_current_user).
- Authenticated non-admin → 403 {code: "admin_required"}.
- Admin (role set the documented bootstrap way, i.e. directly in the DB)
  → full access, with the self-protection rules enforced server-side.
No endpoint can create an admin; tests promote rows directly via the DB,
exactly like the documented operator procedure.
"""

import datetime
import uuid

import pytest
from fastapi.testclient import TestClient
from sqlalchemy import select

from test_auth_api import (
    SESSION_COOKIE_NAME,
    generate_session_token,
    hash_token,
    login,
    make_verified,
    register,
    unique_email,
)

from backend.models import AuthSession, User


def promote(db_session, email: str) -> None:
    """Performs exactly what the documented operator SQL does
    (docs/DATABASE.md): UPDATE users SET role='admin' WHERE email=…)."""
    row = db_session.scalar(select(User).where(User.email == email))
    row.role = "admin"
    db_session.commit()
    db_session.expire_all()


def make_admin(client, db_session):
    """Register + verify a user, then promote via the bootstrap path."""
    payload = make_verified(client, db_session)
    promote(db_session, payload["email"])
    return payload


def admin_signin(client, admin_payload):
    """Signs the promoted admin in: role changes apply to new logins."""
    response = login(client, admin_payload["email"])
    assert response.status_code == 200
    assert response.json()["role"] == "admin"


def target_user_id(client, email: str) -> str:
    listing = client.get("/api/v1/admin/users", params={"search": email})
    assert listing.status_code == 200
    items = listing.json()["items"]
    assert len(items) == 1
    return items[0]["id"]


@pytest.fixture()
def second_client(client):
    """An independent browser (own cookie jar) sharing the same test app."""
    with TestClient(client.app) as fresh:
        yield fresh


# --------------------------------------------------------------- the gate


def test_admin_endpoints_reject_anonymous(client):
    assert client.get("/api/v1/admin/overview").status_code == 401
    assert client.get("/api/v1/admin/users").status_code == 401
    assert client.patch(
        "/api/v1/admin/users/" + str(uuid.uuid4()), json={"is_active": False}
    ).status_code == 401


def test_admin_endpoints_reject_authenticated_non_admin(client, db_session):
    payload = make_verified(client, db_session)
    with TestClient(client.app) as browser:
        assert login(browser, payload["email"]).status_code == 200

        for path in ("/admin/overview", "/admin/users"):
            response = browser.get(f"/api/v1{path}")
            assert response.status_code == 403
            detail = response.json()["detail"]
            assert detail["code"] == "admin_required"
            assert detail["message"] == "Administrator access is required."

        # Mutations are equally blocked for non-admins — authorization runs
        # BEFORE any target-user existence check.
        patched = browser.patch(
            f"/api/v1/admin/users/{uuid.uuid4()}", json={"is_active": False}
        )
        assert patched.status_code == 403
        assert patched.json()["detail"]["code"] == "admin_required"
        _ = payload


def test_documented_promotion_grants_admin_access(client, db_session):
    payload = make_admin(client, db_session)
    admin_signin(client, payload)

    overview = client.get("/api/v1/admin/overview")
    assert overview.status_code == 200
    body = overview.json()
    assert body["admin_users"] >= 1
    assert body["total_users"] >= 1
    assert body["active_users"] >= 1
    assert len(body["recent_registrations"]) >= 1

    listing = client.get("/api/v1/admin/users?page=1&page_size=10")
    assert listing.status_code == 200
    listed = listing.json()
    assert listed["total"] >= 1
    assert payload["email"] in [row["email"] for row in listed["items"]]

    # No secret material anywhere in any admin payload.
    dumped = str(listed) + str(body)
    assert "token_hash" not in dumped
    assert "password_hash" not in dumped
    assert "password" not in dumped


def test_role_flips_are_live_per_request(client, db_session, second_client):
    """A session created BEFORE promotion gains admin access afterwards —
    roles are checked per request, not frozen into the session row."""
    payload = make_verified(client, db_session)
    with second_client:
        assert login(second_client, payload["email"]).status_code == 200
        assert second_client.get("/api/v1/admin/overview").status_code == 403
        promote(db_session, payload["email"])
        assert second_client.get("/api/v1/admin/overview").status_code == 200


# ------------------------------------------------------------- user tools


def test_users_search_and_pagination(client, db_session):
    admin_payload = make_admin(client, db_session)
    admin_signin(client, admin_payload)

    marker = unique_email("pagetest")
    for suffix in ("alpha", "bravo"):
        created, _ = register(client, email=marker.replace("pagetest", f"pagetest-{suffix}"))
        assert created.status_code == 201

    found = client.get("/api/v1/admin/users", params={"search": "pagetest-"})
    assert found.status_code == 200
    emails = [row["email"] for row in found.json()["items"]]
    assert any("pagetest-alpha" in email for email in emails)
    assert any("pagetest-bravo" in email for email in emails)

    paged = client.get("/api/v1/admin/users", params={"page": 1, "page_size": 2})
    assert paged.status_code == 200
    assert len(paged.json()["items"]) <= 2
    assert paged.json()["page"] == 1

    # Validation of the query parameters themselves.
    assert (
        client.get("/api/v1/admin/users", params={"page": 0}).status_code == 422
    )
    assert (
        client.get(
            "/api/v1/admin/users", params={"page_size": "nope"}
        ).status_code
        == 422
    )


def test_admin_deactivates_target_user(client, db_session, second_client):
    admin_payload = make_admin(client, db_session)
    admin_signin(client, admin_payload)

    created, target_payload = register(second_client)
    assert created.status_code == 201
    target_id = target_user_id(client, target_payload["email"])

    deactivated = client.patch(f"/api/v1/admin/users/{target_id}", json={"is_active": False})
    assert deactivated.status_code == 200
    assert deactivated.json()["is_active"] is False

    # Deactivated target cannot use a login at all (verification gate runs
    # after the active check — the generic account path stays intact).
    with second_client:
        denied = login(second_client, target_payload["email"])
        assert denied.status_code == 403

    reactivated = client.patch(f"/api/v1/admin/users/{target_id}", json={"is_active": True})
    assert reactivated.status_code == 200
    assert reactivated.json()["is_active"] is True


def test_admin_unverify_revokes_live_sessions(client, db_session, second_client):
    admin_payload = make_admin(client, db_session)
    admin_signin(client, admin_payload)
    _ = admin_payload

    created, target_payload = register(second_client)
    assert created.status_code == 201
    target_id = target_user_id(client, target_payload["email"])

    # Admin force-verifies the account so the target can sign in.
    verified = client.patch(
        f"/api/v1/admin/users/{target_id}", json={"is_email_verified": True}
    )
    assert verified.status_code == 200
    assert verified.json()["is_email_verified"] is True
    assert verified.json()["email_verified_at"] is not None

    with second_client:
        assert login(second_client, target_payload["email"]).status_code == 200
        assert second_client.get("/api/v1/auth/me").status_code == 200

        # Admin flips verification off; sessions revoked in the same action.
        unverified = client.patch(
            f"/api/v1/admin/users/{target_id}", json={"is_email_verified": False}
        )
        assert unverified.status_code == 200
        assert unverified.json()["is_email_verified"] is False
        assert unverified.json()["email_verified_at"] is None

        assert second_client.get("/api/v1/auth/me").status_code == 401
        blocked = login(second_client, target_payload["email"])
        assert blocked.status_code == 403
        assert blocked.json()["detail"]["code"] == "email_verification_required"

    # Sessions are revoked in the DB, not merely filtered.
    db_session.expire_all()
    user = db_session.scalar(select(User).where(User.email == target_payload["email"]))
    rows = db_session.scalars(
        select(AuthSession).where(AuthSession.user_id == user.id)
    ).all()
    assert rows
    assert all(row.revoked_at is not None for row in rows)


def test_revoke_sessions_endpoint_and_valves(client, db_session, second_client):
    admin_payload = make_admin(client, db_session)
    admin_signin(client, admin_payload)

    created, target_payload = register(second_client)
    assert created.status_code == 201
    target_id = target_user_id(client, target_payload["email"])

    # Unknown session id on a real user: 200 with zero revocations.
    one = client.post(
        f"/api/v1/admin/users/{target_id}/sessions/revoke",
        json={"session_id": str(uuid.uuid4())},
    )
    assert one.status_code == 200
    assert one.json() == {"revoked": 0}

    # Unknown user: 404, generic message, no existence oracle beyond that.
    unknown = client.post(f"/api/v1/admin/users/{uuid.uuid4()}/sessions/revoke", json={})
    assert unknown.status_code == 404
    assert unknown.json()["detail"] == "User not found."

    # Actual revocation covered in test_revoke_all_sessions_runs_live.
    _ = second_client


def test_revoke_all_sessions_runs_live(client, db_session, second_client):
    admin_payload = make_admin(client, db_session)
    admin_signin(client, admin_payload)

    created, target_payload = register(second_client)
    assert created.status_code == 201
    target_id = target_user_id(client, target_payload["email"])
    client.patch(f"/api/v1/admin/users/{target_id}", json={"is_email_verified": True})

    with second_client:
        assert login(second_client, target_payload["email"]).status_code == 200
        assert second_client.get("/api/v1/auth/me").status_code == 200

        response = client.post(f"/api/v1/admin/users/{target_id}/sessions/revoke", json={})
        assert response.status_code == 200
        assert response.json()["revoked"] >= 1

        assert second_client.get("/api/v1/auth/me").status_code == 401


def test_self_protection_rules(client, db_session):
    admin_payload = make_admin(client, db_session)
    admin_signin(client, admin_payload)
    self_id = target_user_id(client, admin_payload["email"])

    assert (
        client.patch(f"/api/v1/admin/users/{self_id}", json={"is_active": False}).status_code
        == 400
    )
    assert (
        client.patch(
            f"/api/v1/admin/users/{self_id}", json={"is_email_verified": False}
        ).status_code
        == 400
    )
    assert (
        client.post(
            f"/api/v1/admin/users/{self_id}/role", json={"role": "user"}
        ).status_code
        == 400
    )

    # Still fully functional after the rejected self-damage attempts.
    assert client.get("/api/v1/admin/overview").status_code == 200


def test_role_promotion_validation(client, db_session, second_client):
    admin_payload = make_admin(client, db_session)
    admin_signin(client, admin_payload)
    created, target_payload = register(second_client)
    assert created.status_code == 201
    target_id = target_user_id(client, target_payload["email"])

    promoted = client.post(f"/api/v1/admin/users/{target_id}/role", json={"role": "admin"})
    assert promoted.status_code == 200
    assert promoted.json()["role"] == "admin"

    # The promoted admin's login reaches admin endpoints — unless the
    # verification gate applies first (target is unverified here).
    with second_client:
        blocked = login(second_client, target_payload["email"])
        assert blocked.status_code == 403
        # Forge a LIVE session for the unverified (but promoted) user to
        # prove the verification gate outranks the admin gate.
        db_session.expire_all()
        user = db_session.scalar(
            select(User).where(User.email == target_payload["email"])
        )
        forged = generate_session_token()
        db_session.add(
            AuthSession(
                token_hash=hash_token(forged),
                user_id=user.id,
                expires_at=datetime.datetime.now(datetime.timezone.utc)
                + datetime.timedelta(hours=1),
            )
        )
        db_session.commit()
        second_client.cookies.set(SESSION_COOKIE_NAME, forged)
        probe = second_client.get("/api/v1/admin/overview")
        assert probe.status_code == 403
        assert probe.json()["detail"]["code"] == "email_verification_required"

    demoted = client.post(f"/api/v1/admin/users/{target_id}/role", json={"role": "user"})
    assert demoted.status_code == 200
    assert demoted.json()["role"] == "user"

    invalid = client.post(
        f"/api/v1/admin/users/{target_id}/role", json={"role": "superadmin"}
    )
    assert invalid.status_code == 422


def test_unknown_user_is_404_and_never_leaks(client, db_session):
    admin_payload = make_admin(client, db_session)
    admin_signin(client, admin_payload)
    ghost = uuid.uuid4()
    detail = client.get(f"/api/v1/admin/users/{ghost}")
    assert detail.status_code == 404
    assert detail.json()["detail"] == "User not found."

    patched = client.patch(f"/api/v1/admin/users/{ghost}", json={"is_active": False})
    assert patched.status_code == 404


def test_admin_mutations_reject_untrusted_origin(client, db_session):
    admin_payload = make_admin(client, db_session)
    admin_signin(client, admin_payload)
    self_id = target_user_id(client, admin_payload["email"])

    csrf = client.patch(
        f"/api/v1/admin/users/{self_id}",
        json={"is_active": False},
        headers={"Origin": "http://evil.example"},
    )
    assert csrf.status_code == 403


def test_admin_paths_registered(client):
    response = client.get("/openapi.json")
    assert response.status_code == 200
    paths = response.json()["paths"]
    for path in (
        "/api/v1/admin/overview",
        "/api/v1/admin/users",
        "/api/v1/admin/users/{user_id}",
        "/api/v1/admin/users/{user_id}/sessions/revoke",
        "/api/v1/admin/users/{user_id}/role",
    ):
        assert path in paths, path
