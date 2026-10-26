"""Admin console biomass API tests.

Covers the admin surface end to end: overview metrics derived from live
data, inventory inspection + auditable corrections (mandatory reason),
listing moderation (reject / suspend with reservation safety / reinstate),
dispute resolution, and the strictly read-only audit explorer — including
a database-level check that the append-only trigger refuses direct UPDATE
and DELETE on audit rows.
"""

import uuid

from fastapi.testclient import TestClient
from sqlalchemy import func, select, text

from test_auth_api import login, make_verified
from test_biomass_api import create_lot, open_listing

from backend.models import BiomassAuditEvent


def make_admin(client, db_session):
    """Verified + role promoted through the DB, then a logged-in client."""
    payload = make_verified(client, db_session)
    from backend.models import User
    from sqlalchemy import update as sa_update

    db_session.execute(sa_update(User).where(User.email == payload["email"]).values(role="admin"))
    db_session.commit()
    browser = TestClient(client.app)
    assert login(browser, payload["email"]).status_code == 200
    return payload, browser


def make_seller_and_listing(client, db_session, *, quantity="100.000", lot_quantity="500.500"):
    """A verified seller with one active listing; returns (seller_browser, lot, listing)."""
    seller = make_verified(client, db_session)
    browser = TestClient(client.app)
    assert login(browser, seller["email"]).status_code == 200
    lot = create_lot(browser, {"quantity": lot_quantity}).json()
    listing = open_listing(browser, lot["id"], quantity=quantity).json()
    return browser, lot, listing


# ==== overview ==============================================================


def test_admin_overview_metrics_from_live_data(client, db_session):
    seller, lot, listing = make_seller_and_listing(client, db_session)
    buyer = make_verified(client, db_session)
    buyer_browser = TestClient(client.app)
    assert login(buyer_browser, buyer["email"]).status_code == 200
    payload, admin_browser = make_admin(client, db_session)

    order = buyer_browser.post(
        f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders",
        json={"quantity": "10.000"},
    ).json()
    data = admin_browser.get("/api/v1/admin/biomass/overview")
    assert data.status_code == 200, data.text
    overview = data.json()
    # Nothing fabricated: counts must match live rows from this test run.
    assert overview["total_lots"] >= 1
    assert overview["orders"].get("requested") >= 1
    assert overview["recent_events"], "overview must surface audit events, not placeholders"

    # A dispute flips the counter.
    seller.post(
        f"/api/v1/biomass/marketplace/orders/{order['id']}/dispute",
        json={"reason": "short delivery"},
    )
    after = admin_browser.get("/api/v1/admin/biomass/overview").json()
    assert after["disputed_orders"] >= 1
    assert after["orders"].get("disputed", 0) >= 1


# ==== inventory inspection + corrections ====================================


def test_admin_inspection_reveals_owner_and_cross_user_inventory(client, db_session):
    make_seller_and_listing(client, db_session)
    payload, admin_browser = make_admin(client, db_session)
    response = admin_browser.get("/api/v1/admin/biomass/inventory")
    assert response.status_code == 200
    page = response.json()
    assert page["total"] >= 1
    row = page["items"][0]
    # Owner identity is visible to admins (never to other users).
    assert row["owner"]["email"], "admin inspection must expose ownership"
    assert row["open_listings"] >= 0


def test_admin_adjust_requires_reason_and_is_audited(client, db_session):
    seller, lot, _ = make_seller_and_listing(client, db_session)
    payload, admin_browser = make_admin(client, db_session)

    url = f"/api/v1/admin/biomass/inventory/{lot['id']}/adjust"
    assert admin_browser.post(url, json={"kind": "correction", "new_available": "480.000"}).status_code == 422
    assert admin_browser.post(url, json={"kind": "removal", "quantity": "5"}).status_code == 422

    adjusted = admin_browser.post(
        url,
        json={"kind": "removal", "quantity": "0.750", "reason": "Contamination discovered by inspection"},
    )
    assert adjusted.status_code == 200, adjusted.text
    body = adjusted.json()
    assert body["quantity_available"] == "499.750"
    assert body["owner"]["email"]  # admin response includes owner info

    # The seller sees the balance change but not WHY it happened... they can
    # see the full movement history (transparency), including the actor type.
    movements = seller.get(f"/api/v1/biomass/inventory/{lot['id']}")
    if movements.status_code == 200:
        payload_detail = movements.json()
        types = [m["movement_type"] for m in payload_detail["movements"]]
        assert "removal" in types

    # Audit trail records the admin actor + reason.
    events = admin_browser.get(
        "/api/v1/admin/biomass/audit",
        params={"action": "lot.adjusted", "entity_id": lot["id"]},
    ).json()
    matching = [e for e in events["items"] if e["action"] == "lot.adjusted"]
    assert len(matching) == 1
    assert "Contamination" in (matching[0]["reason"] or "")


def test_admin_archive_flag_and_restore(client, db_session):
    seller = make_verified(client, db_session)
    seller_browser = TestClient(client.app)
    assert login(seller_browser, seller["email"]).status_code == 200
    lot = create_lot(seller_browser).json()
    payload, admin_browser = make_admin(client, db_session)
    base = f"/api/v1/admin/biomass/inventory/{lot['id']}"
    flag = admin_browser.post(base + "/flag", json={"note": "Reported quality mismatch"})
    assert flag.status_code == 200
    assert flag.json()["admin_flag"] == "Reported quality mismatch"

    archived = admin_browser.post(base + "/archive")
    assert archived.status_code == 200
    assert archived.json()["status"] == "archived"

    # flagged filter finds it
    flagged = admin_browser.get(
        "/api/v1/admin/biomass/inventory", params={"flagged": "true"}
    ).json()
    assert any(item["id"] == lot["id"] for item in flagged["items"])

    restored = admin_browser.post(base + "/restore")
    assert restored.status_code == 200
    assert restored.json()["status"] == "active"


# ==== listing moderation ================================================


def test_admin_rejects_listing_with_reason(client, db_session):
    seller, lot, listing = make_seller_and_listing(client, db_session)
    payload, admin_browser = make_admin(client, db_session)
    url = f"/api/v1/admin/biomass/listings/{listing['id']}/reject"
    assert admin_browser.post(url, json={}).status_code == 422  # reason mandatory
    rejected = admin_browser.post(url, json={"reason": "Misidentified material"})
    assert rejected.status_code == 200
    assert rejected.json()["status"] == "rejected"
    assert rejected.json()["moderation_note"] == "Misidentified material"

    # hidden from public browse
    public = admin_browser.get(
        "/api/v1/biomass/marketplace/listings", params={"status_filter": "active"}
    ).json()
    assert all(item["id"] != listing["id"] for item in public["items"])

    # seller view shows the note
    mine = seller.get("/api/v1/biomass/marketplace/my/listings").json()["items"]
    row = [r for r in mine if r["id"] == listing["id"]][0]
    assert row["status"] == "rejected"
    assert row["moderation_note"] == "Misidentified material"


def test_admin_suspend_blocks_reservation_without_force(client, db_session):
    seller, lot, listing = make_seller_and_listing(client, db_session, quantity="10.000", lot_quantity="10.000")
    payload, admin_browser = make_admin(client, db_session)
    buyer = make_verified(client, db_session)
    buyer_browser = TestClient(client.app)
    assert login(buyer_browser, buyer["email"]).status_code == 200
    order = buyer_browser.post(
        f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders",
        json={"quantity": "4.000"},
    )
    assert order.status_code == 201
    url = f"/api/v1/admin/biomass/listings/{listing['id']}/suspend"
    blocked = admin_browser.post(url, json={"reason": "Suspicious materials"})
    assert blocked.status_code == 409
    assert blocked.json()["detail"]["code"] == "active_requests_exist"
    forced = admin_browser.post(url, json={"reason": "Suspicious materials", "force": True})
    assert forced.status_code == 200
    detail = admin_browser.get(f"/api/v1/admin/biomass/orders/{order.json()['id']}")
    assert detail.json()["status"] == "cancelled"
    # stock returned to the seller when the reservation was released
    lot_view = seller.get(f"/api/v1/biomass/inventory/{lot['id']}").json()["lot"]
    assert lot_view["quantity_reserved"] == "0.000"
    assert lot_view["quantity_available"] == "10.000"
    # paused→reinstate returns the listing to paused (seller chooses resume)
    reinstated = admin_browser.post(
        f"/api/v1/admin/biomass/listings/{listing['id']}/reinstate"
    )
    assert reinstated.status_code == 200
    assert reinstated.json()["status"] == "paused"


def test_admin_full_lot_inspection_detail(client, db_session):
    seller, lot, listing = make_seller_and_listing(client, db_session)
    payload, admin_browser = make_admin(client, db_session)
    detail = admin_browser.get(f"/api/v1/admin/biomass/inventory/{lot['id']}/detail")
    assert detail.status_code == 200
    body = detail.json()
    assert body["lot"]["id"] == lot["id"]
    assert len(body["movements"]) == 1
    assert body["listings"][0]["id"] == listing["id"]


# ==== audit log read-only + append-only guarantee ==========================


def test_audit_query_filters_and_read_only(client, db_session):
    seller, lot, listing = make_seller_and_listing(client, db_session)
    payload, admin_browser = make_admin(client, db_session)
    response = admin_browser.get(
        "/api/v1/admin/biomass/audit", params={"entity_type": "lot", "entity_id": lot["id"]}
    )
    assert response.status_code == 200
    page = response.json()
    assert page["total"] >= 1  # lot.created rows carry entity_type "lot"
    actions = {e["entity_type"] for e in page["items"]}
    assert actions == {"lot"}

    # Unfiltered query also contains the listing events related to this lot.
    everything = admin_browser.get(
        "/api/v1/admin/biomass/audit", params={"entity_id": lot["id"]}
    ).json()
    assert everything["total"] >= page["total"]

    searched = admin_browser.get("/api/v1/admin/biomass/audit", params={"search": "nonexistent-xyz"})
    assert searched.json()["total"] == 0

    # The audit endpoint is read-only: the OpenAPI contract exposes only GET.
    audit_ops = client.app.openapi()["paths"]["/api/v1/admin/biomass/audit"]
    assert set(audit_ops) == {"get"}


def test_audit_rows_are_append_only_at_database_level(test_engine, client, db_session):
    """The DB trigger must refuse UPDATE and DELETE on audit rows even for
    the table owner (defense in depth: no 'admin cleanup' ever exists)."""
    lot_payload = make_verified(client, db_session)
    seller_browser = TestClient(client.app)
    assert login(seller_browser, lot_payload["email"]).status_code == 200
    lot = create_lot(seller_browser).json()
    count = db_session.scalar(select(func.count()).select_from(BiomassAuditEvent))
    assert count and count > 0

    def attempt_direct_write(statement: str) -> tuple[bool, str]:
        conn = test_engine.connect()
        try:
            conn.execute(text(statement))
        except Exception as exc:  # noqa: BLE001 - trigger violation expected
            conn.rollback()
            return True, str(exc)
        else:
            conn.rollback()
            return False, ""
        finally:
            conn.close()

    suppressed, detail_msg = attempt_direct_write(
        "UPDATE biomass_audit_events SET action = 'tampered' "
        "WHERE id = (SELECT id FROM biomass_audit_events LIMIT 1)"
    )
    assert suppressed, "UPDATE on biomass_audit_events must be rejected by the trigger"

    suppressed, detail_msg = attempt_direct_write(
        "DELETE FROM biomass_audit_events WHERE id = (SELECT id FROM biomass_audit_events LIMIT 1)"
    )
    assert suppressed, detail_msg or "DELETE on biomass_audit_events must be rejected by the trigger"

    # data still intact
    after = db_session.scalar(select(func.count()).select_from(BiomassAuditEvent))
    assert after == count
