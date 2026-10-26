"""Biomass inventory + marketplace API tests.

All scenarios run against the isolated per-run test database (conftest);
each user session is its own TestClient instance (own cookie jar) logged
in through the real auth endpoints, exactly like production traffic.
"""

import base64
import json
import threading
import uuid
from decimal import Decimal

import pytest
from fastapi import HTTPException
from fastapi.testclient import TestClient
from sqlalchemy import select
from sqlalchemy.orm import sessionmaker

from test_auth_api import login, make_verified

from backend.models import BiomassAuditEvent, BiomassOrder, StockMovement
from backend.services import biomass as svc
from backend.services import biomass_images as img_svc

LOT = {
    "title": "Wood chip lot",
    "category": "Forestry",
    "material_type": "Wood chips",
    "unit": "kg",
    "quantity": "500.500",
    "storage_location": "Barn A",
}

# A real, tiny 1x1 PNG — the smallest honest image the sniffing accepts.
PNG_1X1 = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErKOg=="
)


def image_files(count=1, filename_tpl="photo{}.png", content=PNG_1X1, content_type="image/png"):
    """httpx-style multipart file tuples for the `images` field."""
    return [
        ("images", (filename_tpl.format(i), content, content_type))
        for i in range(count)
    ]


def post_record(browser, url, payload, *, images=1, content=PNG_1X1):
    """Posts a multipart record-creation request (lot or listing). Omitting
    all images (`images=0`) exercises the compulsory-image rule."""
    files = image_files(images, content=content) if images else []
    return browser.post(url, data={"payload": json.dumps(payload)}, files=files)


def create_lot(browser, overrides=None, images=1):
    payload = {**LOT, **(overrides or {})}
    return post_record(browser, "/api/v1/biomass/inventory", payload, images=images)


def open_listing(browser, lot_id, quantity="300.000", price="25.50", images=1):
    payload = {
        "lot_id": lot_id,
        "title": "Wood chips for sale",
        "quantity": quantity,
        "price_per_unit": price,
        "fulfilment": "pickup",
        "publish_now": True,
    }
    return post_record(
        browser, "/api/v1/biomass/marketplace/listings", payload, images=images
    )


def new_user(client, db_session, prefix="u"):
    """Register + verify a fresh user. Use as a context manager; each
    ``with`` entry returns an object that forwards HTTP calls to a NEW
    TestClient (own cookie jar) logged in through the real auth endpoints,
    so re-entering a previously used user works."""

    class Ctx:
        def __init__(self):
            self.payload = make_verified(client, db_session)

        def __enter__(self):
            self.browser = TestClient(client.app)
            assert login(self.browser, self.payload["email"]).status_code == 200
            return self

        def __exit__(self, *args):
            self.browser.close()

        def request(self, *args, **kwargs):
            return self.browser.request(*args, **kwargs)

        def get(self, *args, **kwargs):
            return self.browser.get(*args, **kwargs)

        def post(self, *args, **kwargs):
            return self.browser.post(*args, **kwargs)

        def put(self, *args, **kwargs):
            return self.browser.put(*args, **kwargs)

        def patch(self, *args, **kwargs):
            return self.browser.patch(*args, **kwargs)

        def delete(self, *args, **kwargs):
            return self.browser.delete(*args, **kwargs)

    return Ctx()


# ===================================================================== 1 + 3


def test_inventory_requires_authentication(client, db_session):
    assert client.get("/api/v1/biomass/inventory").status_code == 401
    assert client.post("/api/v1/biomass/inventory", json=LOT).status_code == 401
    assert client.get("/api/v1/biomass/marketplace/listings").status_code == 401


def test_create_and_retrieve_own_lot(client, db_session):
    with new_user(client, db_session) as browser:
        response = create_lot(browser)
        assert response.status_code == 201, response.text
        lot = response.json()
        assert lot["quantity_available"] == "500.500"
        assert lot["quantity_reserved"] == "0.000"
        assert lot["status"] == "active"
        assert lot["permit_status"] == "not_provided"
        # Unknown values stay null — never silently zero.
        assert lot["moisture_percent"] is None
        assert lot["harvest_date"] is None
        detail = browser.get(f"/api/v1/biomass/inventory/{lot['id']}").json()
        assert detail["lot"]["id"] == lot["id"]
        movements = detail["movements"]
        assert len(movements) == 1
        initial = movements[0]
        assert initial["movement_type"] == "initial"
        assert initial["quantity_before"] == "0.000"
        assert initial["quantity_after"] == "500.500"


def test_quantity_and_field_validation(client, db_session):
    with new_user(client, db_session) as browser:
        for bad in ("-1", "0", "1.0005", "1e400"):
            rho = create_lot(browser, {"quantity": bad})
            assert rho.status_code == 422, rho.text
        rho = create_lot(browser, {"unit": "litres"})
        assert rho.status_code == 422
        rho = create_lot(browser, {"title": "   "})
        assert rho.status_code == 422
        rho = create_lot(browser, {"moisture_percent": "150"})
        assert rho.status_code == 422
        # permit reference is accepted but honestly labelled unverified
        rho = create_lot(browser, {"permit_reference": "PERMIT-2026-0042"})
        lot = rho.json()
        assert lot["permit_status"] == "unverified"


# ===================================================================== images


def test_record_requires_at_least_one_image(client, db_session):
    with new_user(client, db_session) as browser:
        none = create_lot(browser, images=0)
        assert none.status_code == 422, none.text
        assert "At least one image is required" in none.json()["detail"]
        listing = open_listing(browser, str(uuid.uuid4()), images=0)
        assert listing.status_code == 422
        # The failed attempts must not have persisted anything.
        page = browser.get("/api/v1/biomass/inventory").json()
        assert page["total"] == 0
        events = browser.get("/api/v1/biomass/marketplace/my/listings").json()
        assert events["total"] == 0


def test_lot_image_rules(client, db_session):
    with new_user(client, db_session) as browser:
        six = create_lot(browser, images=6)
        assert six.status_code == 422
        assert "at most 5" in six.json()["detail"]
        # A text file disguised as a photo is sniffed, not trusted.
        disguise = post_record(
            browser, "/api/v1/biomass/inventory",
            {**LOT, "title": "Not an image"},
            content=b"definitely not an image file",
        )
        assert disguise.status_code == 422
        assert "Unsupported image format" in disguise.json()["detail"]
        # Extension that contradicts the real bytes is a client error.
        mismatch = browser.post(
            "/api/v1/biomass/inventory",
            data={"payload": json.dumps({**LOT, "title": "Mismatched extension"})},
            files=image_files(1, filename_tpl="photo{}.jpg"),
        )
        assert mismatch.status_code == 422
        assert "extension does not match" in mismatch.json()["detail"]
        # A single image over the configured per-image cap is rejected (413).
        oversized = post_record(
            browser, "/api/v1/biomass/inventory",
            {**LOT, "title": "Too big"},
            content=PNG_1X1 + b"\x00" * (img_svc.max_bytes() + 1),
        )
        assert oversized.status_code == 413
        assert "size limit" in oversized.json()["detail"]
        five = create_lot(browser, {"title": "Five-image lot"}, images=5)
        assert five.status_code == 201, five.text
        images = five.json()["images"]
        assert [img["position"] for img in images] == [1, 2, 3, 4, 5]
        assert all(img["url"].startswith("/api/v1/biomass/images/") for img in images)
        assert all(img["content_type"] == "image/png" for img in images)
        # Nothing half-registered: the failures above left no lots or files.
        page = browser.get("/api/v1/biomass/inventory").json()
        assert page["total"] == 1
        # Oversized (magic bytes padded beyond the cap) is a 413.
        oversized = browser.post(
            "/api/v1/biomass/inventory",
            data={"payload": json.dumps({**LOT, "title": "Too large"})},
            files=image_files(1, content=b"\x89PNG\r\n\x1a\n" + b"0" * (6 * 1024 * 1024)),
        )
        assert oversized.status_code == 413, oversized.text
        assert "size limit" in oversized.json()["detail"]


def test_listing_image_requirements(client, db_session):
    with new_user(client, db_session) as browser:
        lot = create_lot(browser).json()
        six = open_listing(browser, lot["id"], images=6)
        assert six.status_code == 422
        assert "at most 5 images" in six.json()["detail"]
        listing = open_listing(browser, lot["id"], quantity="10.000", images=2).json()
        assert listing["status"] == "active", listing
        assert len(listing["images"]) == 2
        # The browse (public) card carries the image URLs too.
        card = browser.get(
            f"/api/v1/biomass/marketplace/listings/{listing['id']}"
        ).json()
        assert len(card["images"]) == 2


def test_image_access_rules(client, db_session):
    with new_user(client, db_session) as owner:
        lot = create_lot(owner).json()
        lot_image_url = lot["images"][0]["url"]
        listing = open_listing(owner, lot["id"], quantity="10.000").json()
        listing_image_url = listing["images"][0]["url"]
        with new_user(client, db_session) as stranger:
            # An ACTIVE listing's images are viewable by any signed-in user,
            # served with the SNIFFED content type and honest bytes.
            served = stranger.get(listing_image_url)
            assert served.status_code == 200, served.text
            assert served.headers["content-type"] == "image/png"
            assert served.content == PNG_1X1
            # Lot images are private to the owner — no existence oracle.
            assert stranger.get(lot_image_url).status_code == 404
    # Anonymous frames are rejected at the auth gate.
    assert client.get(listing_image_url).status_code == 401


def test_admin_owner_and_paused_listing_image_access(client, db_session):
    with new_user(client, db_session) as owner:
        lot = create_lot(owner).json()
        lot_image_url = lot["images"][0]["url"]
        # The owner reads their own lot image.
        assert owner.get(lot_image_url).status_code == 200
        # Admins read any lot image.
        from backend.models import User
        from sqlalchemy import update as sa_update

        admin_payload = make_verified(client, db_session)
        db_session.execute(
            sa_update(User).where(User.email == admin_payload["email"]).values(role="admin")
        )
        db_session.commit()
        admin_browser = TestClient(client.app)
        assert login(admin_browser, admin_payload["email"]).status_code == 200
        assert admin_browser.get(lot_image_url).status_code == 200
        # A paused listing's images stay seller/admin-only.
        listing = open_listing(owner, lot["id"], quantity="10.000").json()
        image_url = listing["images"][0]["url"]
        owner.post(f"/api/v1/biomass/marketplace/listings/{listing['id']}/pause")
        with new_user(client, db_session) as stranger:
            assert stranger.get(image_url).status_code == 404
        assert owner.get(image_url).status_code == 200
        assert admin_browser.get(image_url).status_code == 200


# ===================================================================== 2


def test_other_user_cannot_access_lot(client, db_session):
    with new_user(client, db_session) as owner:
        lot = create_lot(owner).json()
    with new_user(client, db_session) as stranger:
        got = stranger.get(f"/api/v1/biomass/inventory/{lot['id']}")
        assert got.status_code == 404  # indistinguishable from nonexistent
        assert got.json()["detail"] == "Inventory record not found."
        assert (
            stranger.patch(
                f"/api/v1/biomass/inventory/{lot['id']}", json={"title": "hijack"}
            ).status_code
            == 404
        )
        assert (
            stranger.post(
                f"/api/v1/biomass/inventory/{lot['id']}/adjust",
                json={"kind": "removal", "quantity": "10", "reason": "x"},
            ).status_code
            == 404
        )
        assert (
            stranger.post(f"/api/v1/biomass/inventory/{lot['id']}/archive").status_code
            == 404
        )
    # Owner can still use the lot afterwards.
    with owner as browser:
        assert browser.get(f"/api/v1/biomass/inventory/{lot['id']}").status_code == 200


# ===================================================================== 4


def test_adjustments_record_movements(client, db_session):
    with new_user(client, db_session) as browser:
        lot = create_lot(browser).json()
        lots_url = f"/api/v1/biomass/inventory/{lot['id']}"
        added = browser.post(f"{lots_url}/adjust", json={"kind": "addition", "quantity": "100.250", "reason": "Found extra pallets"})
        assert added.status_code == 200, added.text
        assert added.json()["quantity_available"] == "600.750"
        removed = browser.post(f"{lots_url}/adjust", json={"kind": "removal", "quantity": "0.750", "reason": "Spillage"})
        assert removed.status_code == 200
        assert removed.json()["quantity_available"] == "600.000"
        over = browser.post(f"{lots_url}/adjust", json={"kind": "removal", "quantity": "99999", "reason": "Too much"})
        assert over.status_code == 409
        corrected = browser.post(
            f"{lots_url}/adjust",
            json={"kind": "correction", "new_available": "480.000", "reason": "Scale recalibration"},
        )
        assert corrected.status_code == 200
        assert corrected.json()["quantity_available"] == "480.000"
        no_reason = browser.post(f"{lots_url}/adjust", json={"kind": "addition", "quantity": "1"})
        assert no_reason.status_code == 422
        history = browser.get(lots_url).json()["movements"]
        types = [m["movement_type"] for m in history]
        assert types[0:4] == ["correction", "removal", "addition", "initial"]
        # invariant: the journal reconstructs the balance — every movement
        # chains from the previous one and the deltas sum to the current
        # balance (running counters are derived, never overwritten silently).
        assert Decimal(history[0]["quantity_after"]).quantize(Decimal("0.001")) == Decimal("480.000")
        deltas = sum(Decimal(m["quantity_delta"]) for m in history)
        assert deltas.quantize(Decimal("0.001")) == Decimal("480.000")
        oldest = history[-1]
        assert oldest["quantity_before"] == "0.000"
        for newer, older in zip(history[:-1], history[1:]):
            assert newer["quantity_before"] == older["quantity_after"]


def test_metadata_edit_cannot_change_quantity(client, db_session):
    with new_user(client, db_session) as browser:
        lot = create_lot(browser).json()
        url = f"/api/v1/biomass/inventory/{lot['id']}"
        sneaky = browser.patch(url, json={"quantity": "99999", "title": "Bigger"})
        assert sneaky.status_code == 422
        ok = browser.patch(url, json={"title": "Renamed lot", "quality_grade": "A"})
        assert ok.status_code == 200
        assert ok.json()["title"] == "Renamed lot"
        assert ok.json()["quantity_available"] == "500.500"


def test_archive_restore_and_csv(client, db_session):
    with new_user(client, db_session) as browser:
        lot = create_lot(browser).json()
        url = f"/api/v1/biomass/inventory/{lot['id']}"
        archived = browser.post(f"{url}/archive")
        assert archived.status_code == 200
        assert archived.json()["status"] == "archived"
        again = browser.post(f"{url}/archive")
        assert again.status_code == 409
        restored = browser.post(f"{url}/restore")
        assert restored.status_code == 200
        csv_response = browser.get("/api/v1/biomass/inventory/export.csv")
        assert csv_response.status_code == 200
        assert csv_response.headers["content-type"].startswith("text/csv")
        assert "Wood chip lot" in csv_response.text
        assert lot["id"] in csv_response.text


# ================================================== transfer / provenance


def test_transfer_to_other_user_preserves_traceability(client, db_session):
    with new_user(client, db_session) as owner, new_user(client, db_session) as recipient_browser:
        recipient_email = None
        # need recipient's email: create an admin-verified account and read /me
        lot = create_lot(owner).json()
        payload_rec = make_verified(client, db_session)
        with TestClient(client.app) as rb:
            assert login(rb, payload_rec["email"]).status_code == 200
            recipient_email = payload_rec["email"]
            transferred = owner.post(
                f"/api/v1/biomass/inventory/{lot['id']}/transfer",
                json={"recipient_email": recipient_email, "quantity": "200.000", "note": "Shared silo batch"},
            )
            assert transferred.status_code == 201, transferred.text
            body = transferred.json()
            assert body["source_lot"]["quantity_available"] == "300.500"
            new_lot = body["transferred_lot"]
            assert new_lot["quantity_available"] == "200.000"

            received = rb.get(f"/api/v1/biomass/inventory/{new_lot['id']}")
            assert received.status_code == 200
            detail = received.json()
            assert str(lot["id"])[:8] in detail["lot"]["source_provenance"]
            in_movement = [m for m in detail["movements"] if m["movement_type"] == "transfer_in"]
            assert len(in_movement) == 1
            # The recipient cannot edit the SOURCE lot.
            assert rb.get(f"/api/v1/biomass/inventory/{lot['id']}").status_code == 404
            self_transfer = owner.post(
                f"/api/v1/biomass/inventory/{lot['id']}/transfer",
                json={"recipient_email": owner.get("/api/v1/auth/me").json()["email"], "quantity": "1"},
            )
            assert self_transfer.status_code == 400


# ===================================================================== 5


def test_listing_quantity_cannot_exceed_stock(client, db_session):
    with new_user(client, db_session) as browser:
        lot = create_lot(browser).json()
        too_much = open_listing(browser, lot["id"], quantity="500.501")
        assert too_much.status_code == 409
        one_more = open_listing(browser, lot["id"], quantity="300.000")
        assert one_more.status_code == 201
        # A second listing on the same lot can still claim the remaining 200.
        second = open_listing(browser, lot["id"], quantity="201.000")
        assert second.status_code == 409
        second = open_listing(browser, lot["id"], quantity="200.000")
        assert second.status_code == 201
        # Drafts are not visible on discovery but still RESERVE offer room:
        # a published listing can never exceed the stock that existed.
        draft = post_record(
            browser, "/api/v1/biomass/marketplace/listings",
            {"lot_id": lot["id"], "title": "Draft", "quantity": "99.999",
             "price_per_unit": "9", "publish_now": False},
        )
        assert draft.status_code == 409
        draft = post_record(
            browser, "/api/v1/biomass/marketplace/listings",
            {"lot_id": lot["id"], "title": "Draft", "quantity": "0.500",
             "price_per_unit": "9", "publish_now": False},
        )
        assert draft.status_code == 201
        assert draft.json()["status"] == "draft"
        assert draft.json()["listing_available"] == "0.500"


# ===================================================================== 6 + 7


def test_concurrent_purchases_cannot_oversell(client, db_session, test_engine):
    with new_user(client, db_session) as seller, new_user(client, db_session) as buyer:
        lot = create_lot(seller, {"quantity": "10.000"}).json()
        listing = open_listing(seller, lot["id"], quantity="10.000", price="2.00").json()
        listing_id = uuid.UUID(listing["id"])
        buyer_id = uuid.UUID(buyer.get("/api/v1/auth/me").json()["id"])

        results: list = []

        def attempt(_n: int) -> None:
            from backend.models import User

            factory = sessionmaker(bind=test_engine, expire_on_commit=False)
            session = factory()
            try:
                buyer_user = session.scalar(select(User).where(User.id == buyer_id))
                assert buyer_user is not None
                _order, created = svc.create_order(
                    session, listing_id, buyer_user,
                    quantity=Decimal("7.000"),
                    buyer_note=None, client_request_id=None,
                )
                results.append("sold" if created else "replay")
            except HTTPException as exc:
                results.append(exc.status_code)
            finally:
                session.close()

        threads = [threading.Thread(target=attempt, args=(i,)) for i in range(2)]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        assert results.count("sold") == 1, results
        assert results.count(409) == 1, results
        # exactly one unit of work: lot reflects 7 reserved / 3 available
        fresh_lot = seller.get(f"/api/v1/biomass/inventory/{lot['id']}").json()["lot"]
        assert fresh_lot["quantity_reserved"] == "7.000"
        assert fresh_lot["quantity_available"] == "3.000"
        listing_after = seller.get(
            "/api/v1/biomass/marketplace/my/listings",
            params={"status_filter": "all"},
        ).json()["items"][0]
        assert listing_after["listing_available"] == "3.000"
        assert listing_after["listing_reserved"] == "7.000"


def test_reservation_and_discovery(client, db_session):
    with new_user(client, db_session) as seller, new_user(client, db_session) as buyer:
        lot = create_lot(seller, {"quantity": "100.000"}).json()
        listing = open_listing(seller, lot["id"], quantity="50.000").json()
        data = buyer.get(f"/api/v1/biomass/marketplace/listings/{listing['id']}").json()
        assert data["seller_name"]  # a display name is exposed
        body = buyer.get("/api/v1/biomass/marketplace/listings").json()
        card = [c for c in body["items"] if c["id"] == listing["id"]][0]
        # NO seller email or id on public cards
        assert "seller_id" not in card
        assert "email" not in str(card)
        order = buyer.post(
            f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders",
            json={"quantity": "10.000"},
        )
        assert order.status_code == 201
        assert order.json()["status"] == "requested"
        assert order.json()["total_amount"] == "255.00"  # 10 * 25.50, once quantized
        # listing availability reduced for the NEXT buyer
        buyer2_card = buyer.get(f"/api/v1/biomass/marketplace/listings/{listing['id']}").json()
        assert buyer2_card["listing_available"] == "40.000"
        self_purchase = seller.post(
            f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders",
            json={"quantity": "1"},
        )
        assert self_purchase.status_code == 409


# ===================================================================== 8


def test_cancel_releases_reservation_exactly_once(client, db_session):
    with new_user(client, db_session) as seller, new_user(client, db_session) as buyer:
        lot = create_lot(seller, {"quantity": "10.000"}).json()
        listing = open_listing(seller, lot["id"], quantity="10.000").json()
        order = buyer.post(
            f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders",
            json={"quantity": "4.000"},
        ).json()
        cancelled = buyer.post(f"/api/v1/biomass/marketplace/orders/{order['id']}/cancel", json={})
        assert cancelled.status_code == 200
        assert cancelled.json()["status"] == "cancelled"
        again = buyer.post(f"/api/v1/biomass/marketplace/orders/{order['id']}/cancel", json={})
        assert again.status_code == 409
        # reservation restored exactly once
        lot_view = seller.get(f"/api/v1/biomass/inventory/{lot['id']}").json()["lot"]
        assert lot_view["quantity_available"] == "10.000"
        assert lot_view["quantity_reserved"] == "0.000"
        movements = seller.get(f"/api/v1/biomass/inventory/{lot['id']}").json()["movements"]
        releases = [m for m in movements if m["movement_type"] == "release"]
        assert len(releases) == 1


# ===================================================================== 9


def test_lifecycle_accept_fulfil_confirm(client, db_session):
    with new_user(client, db_session) as seller, new_user(client, db_session) as buyer:
        lot = create_lot(seller, {"quantity": "100.000"}).json()
        listing = open_listing(seller, lot["id"], quantity="80.000", price="2.00").json()
        order = buyer.post(
            f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders",
            json={"quantity": "30.000", "buyer_note": "Pickup Friday"},
        ).json()
        order_url = f"/api/v1/biomass/marketplace/orders/{order['id']}"

        # buyer cannot accept (role separation)
        assert buyer.post(f"{order_url}/accept", json={}).status_code == 403
        assert seller.post(f"{order_url}/accept", json={}).status_code == 200

        # seller fulfils: reserved becomes sold
        fulfil = seller.post(f"{order_url}/fulfil", json={})
        assert fulfil.status_code == 200
        once = seller.post(f"{order_url}/fulfil", json={})  # duplicate fulfilment
        assert once.status_code == 409

        lot_view = seller.get(f"/api/v1/biomass/inventory/{lot['id']}").json()["lot"]
        assert lot_view["quantity_reserved"] == "0.000"
        assert lot_view["quantity_sold"] == "30.000"
        assert lot_view["quantity_available"] == "70.000"

        # buyer confirms receipt → completed
        assert buyer.post(f"{order_url}/confirm", json={}).json()["status"] == "completed"
        # no one can re-transition a completed order
        assert seller.post(f"{order_url}/fulfil", json={}).status_code == 409
        assert buyer.post(f"{order_url}/cancel", json={}).status_code == 409
        # seller records the MANUAL off-platform settlement
        settled = seller.post(f"{order_url}/settlement", json={"note": "Received cash 60.00"})
        assert settled.status_code == 200
        assert settled.json()["settlement_status"] == "settled"
        assert buyer.post(f"{order_url}/settlement", json={}).status_code == 403
        twice = seller.post(f"{order_url}/settlement", json={})
        assert twice.status_code == 409

        # listing counters tracked the sale; 50 units still sellable
        mine = seller.get("/api/v1/biomass/marketplace/my/listings").json()["items"][0]
        assert mine["quantity_sold"] == "30.000"
        assert mine["status"] == "active"


def test_admin_cannot_cancel_fulfilled_dispute_only_resume(client, db_session):
    """Fulfilled stock has already legally moved: an administrator
    resolving such a dispute can resume it, not cancel (no un-sale)."""
    with new_user(client, db_session) as seller, new_user(client, db_session) as buyer:
        lot = create_lot(seller, {"quantity": "100.000"}).json()
        listing = open_listing(seller, lot["id"], quantity="100.000").json()
        order = buyer.post(f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders", json={"quantity": "10.000"}).json()
        order_url = f"/api/v1/biomass/marketplace/orders/{order['id']}"
        seller.post(f"{order_url}/accept", json={})
        seller.post(f"{order_url}/fulfil", json={})
        buyer.post(f"{order_url}/dispute", json={"reason": "Quality damaged"})
        admin_payload = make_verified(client, db_session)
        from sqlalchemy import update as sa_update
        from backend.models import User
        db_session.execute(sa_update(User).where(User.email == admin_payload["email"]).values(role="admin"))
        db_session.commit()
        with TestClient(client.app) as admin_browser:
            assert login(admin_browser, admin_payload["email"]).status_code == 200
            cancel = admin_browser.post(
                f"/api/v1/admin/biomass/orders/{order['id']}/resolve-dispute",
                json={"action": "cancel", "note": "Attempting to un-sell"},
            )
            assert cancel.status_code == 409
            resume = admin_browser.post(
                f"/api/v1/admin/biomass/orders/{order['id']}/resolve-dispute",
                json={"action": "resume", "note": "Verified delivery; dispute unfounded."},
            )
            assert resume.status_code == 200
            assert resume.json()["status"] == "fulfilled"


# ================================================= reservation expiry


def test_expired_reservation_is_released(client, db_session):
    with new_user(client, db_session) as seller, new_user(client, db_session) as buyer:
        lot = create_lot(seller, {"quantity": "50.000"}).json()
        listing = open_listing(seller, lot["id"], quantity="50.000").json()
        order = buyer.post(
            f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders",
            json={"quantity": "5.000"},
        ).json()
        # Force expiry directly in the DB (simulates the 72h window passing).
        from sqlalchemy import update
        import datetime
        db_session.execute(
            update(BiomassOrder)
            .where(BiomassOrder.id == uuid.UUID(order["id"]))
            .values(reservation_expires_at=datetime.datetime.now(datetime.timezone.utc) - datetime.timedelta(hours=1))
        )
        db_session.commit()
        # any listing touch (seller dashboard) releases it
        mine = seller.get("/api/v1/biomass/marketplace/my/listings").json()["items"][0]
        assert mine["listing_reserved"] == "0.000"
        assert mine["listing_available"] == "50.000"
        refreshed = buyer.get(f"/api/v1/biomass/marketplace/orders/{order['id']}").json()
        assert refreshed["status"] == "cancelled"
        assert refreshed["released_at"] is not None
        # accept-after-expiry no longer possible
        assert seller.post(f"/api/v1/biomass/marketplace/orders/{order['id']}/accept", json={}).status_code == 409


# ================================================= disputes


def test_dispute_freezes_and_admin_resolves(client, db_session):
    with new_user(client, db_session) as seller, new_user(client, db_session) as buyer:
        lot = create_lot(seller, {"quantity": "100.000"}).json()
        listing = open_listing(seller, lot["id"], quantity="100.000").json()
        order = buyer.post(
            f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders",
            json={"quantity": "10.000"},
        ).json()
        seller.post(f"/api/v1/biomass/marketplace/orders/{order['id']}/accept", json={})
        disputed = buyer.post(
            f"/api/v1/biomass/marketplace/orders/{order['id']}/dispute",
            json={"reason": "Quantity on delivery was short."},
        )
        assert disputed.status_code == 200
        assert disputed.json()["status"] == "disputed"
        # frozen: no fulfil/cancel while disputed
        assert seller.post(f"/api/v1/biomass/marketplace/orders/{order['id']}/fulfil", json={}).status_code == 409
        assert buyer.post(f"/api/v1/biomass/marketplace/orders/{order['id']}/cancel", json={}).status_code == 409
        admin_payload = make_verified(client, db_session)
        db_session.expire_all()
        from backend.models import User
        from sqlalchemy import update as sa_update
        db_session.execute(
            sa_update(User).where(User.email == admin_payload["email"]).values(role="admin")
        )
        db_session.commit()
        with TestClient(client.app) as admin_browser:
            assert login(admin_browser, admin_payload["email"]).status_code == 200
            admin_url = f"/api/v1/admin/biomass/orders/{order['id']}/resolve-dispute"
            no_note = admin_browser.post(admin_url, json={"action": "resume"})
            assert no_note.status_code == 422
            resume = admin_browser.post(
                admin_url,
                json={"action": "resume", "note": "Seller provided scale ticket; delivery confirmed complete."},
            )
            assert resume.status_code == 200
            assert resume.json()["status"] == "awaiting_fulfilment"


def test_completed_transaction_cannot_be_silently_rewritten(client, db_session):
    """Even administrators cannot rewrite a completed order's core data:
    the resolve endpoint works on disputed rows only and no PATCH exists."""
    with new_user(client, db_session) as seller, new_user(client, db_session) as buyer:
        lot = create_lot(seller, {"quantity": "100.000"}).json()
        listing = open_listing(seller, lot["id"], quantity="100.000").json()
        order = buyer.post(
            f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders",
            json={"quantity": "10.000"},
        ).json()
        order_url = f"/api/v1/biomass/marketplace/orders/{order['id']}"
        seller.post(f"{order_url}/accept", json={})
        seller.post(f"{order_url}/fulfil", json={})
        buyer.post(f"{order_url}/confirm", json={})
        admin_payload = make_verified(client, db_session)
        from sqlalchemy import update as sa_update
        from backend.models import User
        db_session.execute(
            sa_update(User).where(User.email == admin_payload["email"]).values(role="admin")
        )
        db_session.commit()
        with TestClient(client.app) as admin_browser:
            assert login(admin_browser, admin_payload["email"]).status_code == 200
            resolve = admin_browser.post(
                f"/api/v1/admin/biomass/orders/{order['id']}/resolve-dispute",
                json={"action": "cancel", "note": "Trying to erase a completed sale"},
            )
            assert resolve.status_code == 409
            still = admin_browser.get(f"/api/v1/admin/biomass/orders/{order['id']}")
            assert still.json()["status"] == "completed"


# ================================================================== 11


def test_non_admin_cannot_access_admin_biomass_api(client, db_session):
    with new_user(client, db_session) as user:
        paths = (
            "/api/v1/admin/biomass/overview",
            "/api/v1/admin/biomass/inventory",
            "/api/v1/admin/biomass/listings",
            "/api/v1/admin/biomass/orders",
            "/api/v1/admin/biomass/audit",
        )
        for path in paths:
            response = user.get(path)
            assert response.status_code == 403, path
            assert response.json()["detail"]["code"] == "admin_required"
        assert user.post(
            f"/api/v1/admin/biomass/inventory/{uuid.uuid4()}/adjust",
            json={"kind": "correction", "new_available": "1", "reason": "nope"},
        ).status_code == 403
        # non-admins also cannot read admin detail endpoints
        assert user.get(f"/api/v1/admin/biomass/inventory/{uuid.uuid4()}").status_code == 403
