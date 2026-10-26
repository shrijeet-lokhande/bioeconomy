"""Admin permanent-deletion tests (biomass inventory + marketplace).

Runs against the isolated per-run test database AND an isolated temp upload
directory (conftest) — deletion tests never touch dev data or the real
`.data/` directory. Covers the full two-phase lifecycle: atomic DB purge,
post-commit file cleanup with tracking, authorization, explicit
confirmation, order-reference refusals, retry/idempotency, and path-safety
of the file cleanup itself.
"""

import json
import os
import threading
import uuid

from fastapi.testclient import TestClient
from sqlalchemy import func, select

from test_auth_api import login, make_verified
from test_biomass_api import PNG_1X1, create_lot, image_files, new_user, open_listing, post_record
from test_biomass_admin import make_admin

from backend.models import (
    BiomassAuditEvent,
    BiomassDeletionCleanup,
    BiomassImage,
    BiomassListing,
    BiomassLot,
    BiomassOrder,
    StockMovement,
)
from backend.services import biomass_images as img_svc
from backend.services import purge as purge_svc

LOT_URL = "/api/v1/admin/biomass/inventory"
LISTING_URL = "/api/v1/admin/biomass/listings"


def lot_files_on_disk(db_session, lot_id):
    """The upload-dir paths of every image file that belongs to the lot or
    to any listing created from it."""
    names = db_session.scalars(
        select(BiomassImage.stored_name).where(
            (BiomassImage.lot_id == lot_id)
            | (
                BiomassImage.listing_id.in_(
                    select(BiomassListing.id).where(BiomassListing.lot_id == lot_id)
                )
            )
        )
    ).all()
    return [img_svc.upload_dir() / name for name in names]


def cleanup_row(db_session, entity_type, entity_id):
    return db_session.scalar(
        select(BiomassDeletionCleanup).where(
            BiomassDeletionCleanup.entity_type == entity_type,
            BiomassDeletionCleanup.entity_id == entity_id,
        )
    )


# ===================================================================== 1 + 6


def test_admin_deletes_lot_with_images_rows_and_files(client, db_session):
    with new_user(client, db_session) as seller:
        created = create_lot(seller, images=2)
        assert created.status_code == 201, created.text
        lot = created.json()
        paths = lot_files_on_disk(db_session, uuid.UUID(lot["id"]))
        assert len(paths) == 2
        assert all(p.exists() for p in paths)

        _, admin_browser = make_admin(client, db_session)
        response = admin_browser.request(
            "DELETE", f"{LOT_URL}/{lot['id']}", json={"confirm_title": lot["title"]}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        # Honest reporting: DB purge AND file cleanup both succeeded.
        assert body["status"] == "completed"
        assert body["entity_type"] == "lot"
        assert body["removed_files"] == 2
        assert body["missing_files"] == 0
        assert body["failed_files"] == 0

        db_session.expire_all()
        # The record and every exclusively-owned row are gone.
        assert db_session.get(BiomassLot, uuid.UUID(lot["id"])) is None
        assert int(
            db_session.scalar(
                select(func.count()).select_from(BiomassImage).where(
                    BiomassImage.lot_id == uuid.UUID(lot["id"])
                )
            )
            or 0
        ) == 0
        assert int(
            db_session.scalar(
                select(func.count()).select_from(StockMovement).where(
                    StockMovement.lot_id == uuid.UUID(lot["id"])
                )
            )
            or 0
        ) == 0
        # The image files were removed from disk after the DB commit.
        assert all(not p.exists() for p in paths)
        # Tracking row records the completed cleanup.
        row = cleanup_row(db_session, "lot", uuid.UUID(lot["id"]))
        assert row is not None and row.status == "completed"


def test_admin_deletes_listing_without_touching_the_source_lot(client, db_session):
    with new_user(client, db_session) as seller:
        lot = create_lot(seller, images=1).json()
        listing = open_listing(seller, lot["id"], images=2).json()

        listing_image_rows = db_session.scalars(
            select(BiomassImage).where(BiomassImage.listing_id == uuid.UUID(listing["id"]))
        ).all()
        listing_paths = [img_svc.upload_dir() / image.stored_name for image in listing_image_rows]
        lot_paths = lot_files_on_disk(db_session, uuid.UUID(lot["id"]))
        assert len(listing_paths) == 2 and len(lot_paths) == 3  # 1 lot + 2 listing
        lot_own_paths = [
            img_svc.upload_dir() / name
            for name in db_session.scalars(
                select(BiomassImage.stored_name).where(BiomassImage.lot_id == uuid.UUID(lot["id"]))
            ).all()
        ]
        assert len(lot_own_paths) == 1

        _, admin_browser = make_admin(client, db_session)
        response = admin_browser.request(
            "DELETE", f"{LISTING_URL}/{listing['id']}", json={"confirm_title": listing["title"]}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "completed"
        assert body["entity_type"] == "listing"

        db_session.expire_all()
        # The listing and its images are gone; the lot stays untouched.
        assert db_session.get(BiomassListing, uuid.UUID(listing["id"])) is None
        assert db_session.get(BiomassLot, uuid.UUID(lot["id"])) is not None
        assert all(not p.exists() for p in listing_paths)
        assert all(p.exists() for p in lot_own_paths)


# ===================================================================== 3 + 4


def test_non_admin_cannot_delete_records(client, db_session):
    with new_user(client, db_session) as seller:
        lot = create_lot(seller).json()
        listing = open_listing(seller, lot["id"]).json()

        for url, title in (
            (f"{LOT_URL}/{lot['id']}", lot["title"]),
            (f"{LISTING_URL}/{listing['id']}", listing["title"]),
        ):
            response = seller.browser.request("DELETE", url, json={"confirm_title": title})
            assert response.status_code == 403, response.text
            # The record and its files are untouched.
            db_session.expire_all()
            paths = lot_files_on_disk(db_session, uuid.UUID(lot["id"]))
            assert all(p.exists() for p in paths)
            assert db_session.get(BiomassLot, uuid.UUID(lot["id"])) is not None


def test_unauthenticated_delete_is_rejected(client, db_session):
    assert (
        client.request("DELETE", f"{LOT_URL}/{uuid.uuid4()}", json={"confirm_title": "x"}).status_code
        == 401
    )
    assert (
        client.request(
            "DELETE", f"{LISTING_URL}/{uuid.uuid4()}", json={"confirm_title": "x"}
        ).status_code
        == 401
    )


# ===================================================================== 5


def test_unknown_record_returns_404(client, db_session):
    _, admin_browser = make_admin(client, db_session)
    assert (
        admin_browser.request("DELETE", f"{LOT_URL}/{uuid.uuid4()}", json={"confirm_title": "x"}).status_code
        == 404
    )
    assert (
        admin_browser.request(
            "DELETE", f"{LISTING_URL}/{uuid.uuid4()}", json={"confirm_title": "x"}
        ).status_code
        == 404
    )


# ===================================================================== 7


def test_unrelated_records_and_files_survive_a_purge(client, db_session):
    with new_user(client, db_session) as seller:
        kept = create_lot(seller, {"title": "Kept lot"}, images=2).json()
        deleted = create_lot(seller, {"title": "Deleted lot"}, images=1).json()

        _, admin_browser = make_admin(client, db_session)
        response = admin_browser.request(
            "DELETE", f"{LOT_URL}/{deleted['id']}", json={"confirm_title": "Deleted lot"}
        )
        assert response.status_code == 200

        db_session.expire_all()
        # The kept lot's rows AND files are intact.
        assert db_session.get(BiomassLot, uuid.UUID(kept["id"])) is not None
        kept_paths = lot_files_on_disk(db_session, uuid.UUID(kept["id"]))
        assert len(kept_paths) == 2 and all(p.exists() for p in kept_paths)


# ===================================================================== 8


def test_path_traversal_and_malformed_keys_are_refused(db_session, tmp_path):
    root = img_svc.upload_dir()
    victim = tmp_path / "victim.txt"
    victim.write_text("precious")

    # Classic traversal — the regex refuses separators entirely.
    assert img_svc.safe_unlink("../../victim.txt") == "invalid"
    assert victim.exists()
    # Not generated by persist_images → never deleted.
    assert img_svc.safe_unlink("arbitrary-file.txt") == "invalid"
    assert img_svc.safe_unlink("") == "invalid"
    # A valid-looking name that is a symlink pointing OUTSIDE the upload dir.
    evil_name = "a" * 32 + ".png"
    link = root / evil_name
    link.symlink_to(victim)
    assert img_svc.safe_unlink(evil_name) == "invalid"
    assert victim.exists()
    link.unlink()
    # A valid-looking name that is a DIRECTORY is never touched.
    (root / ("b" * 32 + ".png")).mkdir()
    assert img_svc.safe_unlink("b" * 32 + ".png") == "invalid"
    assert (root / ("b" * 32 + ".png")).is_dir()


# ===================================================================== 9 + 11


def test_missing_files_are_idempotent_and_a_retry_completes(client, db_session, monkeypatch):
    with new_user(client, db_session) as seller:
        lot = create_lot(seller, images=2).json()
        paths = lot_files_on_disk(db_session, uuid.UUID(lot["id"]))

        # Simulate an interrupted purge: the DB phase committed but the file
        # phase never ran (all keys report as still-there failures).
        monkeypatch.setattr(
            purge_svc.img_svc,
            "cleanup_files",
            lambda keys: {"removed": 0, "missing": 0, "invalid": len(keys)},
        )
        _, admin_browser = make_admin(client, db_session)
        first = admin_browser.request(
            "DELETE", f"{LOT_URL}/{lot['id']}", json={"confirm_title": lot["title"]}
        )
        assert first.status_code == 200, first.text
        body = first.json()
        # NEVER claims full deletion when file cleanup failed.
        assert body["status"] == "pending_cleanup"
        assert body["failed_files"] == 2
        assert all(p.exists() for p in paths)
        monkeypatch.undo()

        # Retry the SAME request: pending cleanup finishes; the response is
        # honest about what was removed on this run.
        second = admin_browser.request(
            "DELETE", f"{LOT_URL}/{lot['id']}", json={"confirm_title": lot["title"]}
        )
        assert second.status_code == 200, second.text
        retry = second.json()
        assert retry["status"] == "completed"
        assert retry["removed_files"] == 2
        assert all(not p.exists() for p in paths)

        db_session.expire_all()
        row = cleanup_row(db_session, "lot", uuid.UUID(lot["id"]))
        assert row.status == "completed"
        assert row.attempts == 2

        # After completion the id is simply gone: a third request is a 404.
        third = admin_browser.request(
            "DELETE", f"{LOT_URL}/{lot['id']}", json={"confirm_title": lot["title"]}
        )
        assert third.status_code == 404


def test_files_already_gone_count_as_cleaned(client, db_session):
    with new_user(client, db_session) as seller:
        lot = create_lot(seller, images=1).json()
        # Files vanish out-of-band (e.g. manual disk cleanup before the purge).
        for path in lot_files_on_disk(db_session, uuid.UUID(lot["id"])):
            os.remove(path)

        _, admin_browser = make_admin(client, db_session)
        response = admin_browser.request(
            "DELETE", f"{LOT_URL}/{lot['id']}", json={"confirm_title": lot["title"]}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "completed"
        assert body["missing_files"] == 1
        assert body["failed_files"] == 0


# ===================================================================== 10


def test_storage_refusal_reports_pending_cleanup_not_success(client, db_session):
    with new_user(client, db_session) as seller:
        lot = create_lot(seller, images=2).json()
        paths = lot_files_on_disk(db_session, uuid.UUID(lot["id"]))
        # One file is replaced by a directory: safe_unlink refuses it.
        os.remove(paths[0])
        os.mkdir(paths[0])

        _, admin_browser = make_admin(client, db_session)
        response = admin_browser.request(
            "DELETE", f"{LOT_URL}/{lot['id']}", json={"confirm_title": lot["title"]}
        )
        assert response.status_code == 200, response.text
        body = response.json()
        assert body["status"] == "pending_cleanup"
        assert body["failed_files"] == 1
        assert body["removed_files"] == 1

        db_session.expire_all()
        row = cleanup_row(db_session, "lot", uuid.UUID(lot["id"]))
        assert row.status == "pending"
        assert row.failed_files == 1


# ===================================================================== 12


def test_duplicate_deletion_requests_are_safe(client, db_session):
    with new_user(client, db_session) as seller:
        lot = create_lot(seller, images=2).json()
        listing = open_listing(seller, lot["id"]).json()

        def image_paths(where):
            names = db_session.scalars(select(BiomassImage.stored_name).where(where)).all()
            return [img_svc.upload_dir() / name for name in names]

        listing_paths = image_paths(BiomassImage.listing_id == uuid.UUID(listing["id"]))
        lot_own_paths = image_paths(BiomassImage.lot_id == uuid.UUID(lot["id"]))
        assert len(listing_paths) == 1 and len(lot_own_paths) == 2

        admin_payload, admin_browser = make_admin(client, db_session)

        # Sequential duplicate: second request finds the finished job (404).
        first = admin_browser.request(
            "DELETE", f"{LISTING_URL}/{listing['id']}", json={"confirm_title": listing["title"]}
        )
        second = admin_browser.request(
            "DELETE", f"{LISTING_URL}/{listing['id']}", json={"confirm_title": listing["title"]}
        )
        assert first.status_code == 200 and first.json()["status"] == "completed"
        assert second.status_code == 404
        db_session.expire_all()
        assert cleanup_row(db_session, "listing", uuid.UUID(listing["id"])) is not None
        assert all(not p.exists() for p in listing_paths)
        assert all(p.exists() for p in lot_own_paths)

        # Truly concurrent duplicates on a FRESH listing: serialized by the
        # FOR UPDATE row lock; exactly ONE purge happens, the DB stays
        # consistent, and files are removed idempotently (never twice).
        lot2 = create_lot(seller, {"title": "Concurrency lot"}, images=1).json()
        listing2 = open_listing(seller, lot2["id"], images=2).json()
        listing2_paths = image_paths(BiomassImage.listing_id == uuid.UUID(listing2["id"]))
        lot2_own_paths = image_paths(BiomassImage.lot_id == uuid.UUID(lot2["id"]))
        assert len(listing2_paths) == 2 and len(lot2_own_paths) == 1

        results = []
        lock = threading.Barrier(2)

        def worker():
            browser = TestClient(admin_browser.app)
            assert login(browser, admin_payload["email"]).status_code == 200
            lock.wait(timeout=10)
            results.append(
                browser.request(
                    "DELETE", f"{LISTING_URL}/{listing2['id']}", json={"confirm_title": listing2["title"]}
                )
            )
            browser.close()

        threads = [threading.Thread(target=worker) for _ in range(2)]
        for thread in threads:
            thread.start()
        for thread in threads:
            thread.join(timeout=30)

        assert len(results) == 2
        for response in results:
            assert response.status_code in (200, 404), response.text
            if response.status_code == 200:
                assert response.json()["status"] == "completed"

        db_session.expire_all()
        assert db_session.get(BiomassListing, uuid.UUID(listing2["id"])) is None
        # Exactly ONE cleanup-tracking row for the listing.
        assert int(
            db_session.scalar(
                select(func.count()).select_from(BiomassDeletionCleanup).where(
                    BiomassDeletionCleanup.entity_type == "listing",
                    BiomassDeletionCleanup.entity_id == uuid.UUID(listing2["id"]),
                )
            )
            or 0
        ) == 1
        # The listing's files are gone; the lot's own file is untouched.
        assert all(not p.exists() for p in listing2_paths)
        assert len(lot2_own_paths) == 1 and lot2_own_paths[0].exists()


# ===================================================================== 13


def test_records_referenced_by_orders_are_refused_and_untouched(client, db_session):
    with new_user(client, db_session) as seller, new_user(client, db_session) as buyer:
        lot = create_lot(seller, {"quantity": "10.000"}, images=2).json()
        listing = open_listing(seller, lot["id"], quantity="10.000", images=1).json()
        order = buyer.post(
            f"/api/v1/biomass/marketplace/listings/{listing['id']}/orders",
            json={"quantity": "4.000"},
        ).json()
        paths = lot_files_on_disk(db_session, uuid.UUID(lot["id"]))

        _, admin_browser = make_admin(client, db_session)
        for url, title, label in (
            (f"{LISTING_URL}/{listing['id']}", listing["title"], "listing"),
            (f"{LOT_URL}/{lot['id']}", lot["title"], "lot"),
        ):
            response = admin_browser.request("DELETE", url, json={"confirm_title": title})
            assert response.status_code == 409, response.text
            assert "purchase transactions" in response.json()["detail"]

        # Even a CANCELLED order is preserved history: still refused.
        cancelled = buyer.post(f"/api/v1/biomass/marketplace/orders/{order['id']}/cancel", json={})
        assert cancelled.status_code == 200
        response = admin_browser.request(
            "DELETE", f"{LOT_URL}/{lot['id']}", json={"confirm_title": lot["title"]}
        )
        assert response.status_code == 409
        # Nothing at all was deleted by the refused attempts.
        db_session.expire_all()
        assert db_session.get(BiomassLot, uuid.UUID(lot["id"])) is not None
        assert db_session.get(BiomassListing, uuid.UUID(listing["id"])) is not None
        assert int(db_session.scalar(select(func.count()).select_from(BiomassOrder)) or 0) == 1
        assert all(p.exists() for p in paths)
        assert cleanup_row(db_session, "lot", uuid.UUID(lot["id"])) is None
        assert cleanup_row(db_session, "listing", uuid.UUID(listing["id"])) is None


def test_wrong_confirmation_title_is_refused(client, db_session):
    with new_user(client, db_session) as seller:
        lot = create_lot(seller, images=1).json()
        _, admin_browser = make_admin(client, db_session)

        for wrong in ("", "wood chip lot", f"{lot['title']}x"):
            response = admin_browser.request(
                "DELETE", f"{LOT_URL}/{lot['id']}", json={"confirm_title": wrong}
            )
            assert response.status_code in (400, 422), response.text

        # Missing body / missing field is a validation error, not a deletion.
        assert admin_browser.request("DELETE", f"{LOT_URL}/{lot['id']}").status_code == 422

        db_session.expire_all()
        assert db_session.get(BiomassLot, uuid.UUID(lot["id"])) is not None
        assert all(p.exists() for p in lot_files_on_disk(db_session, uuid.UUID(lot["id"])))


# ===================================================================== audit


def test_purge_writes_minimal_audit_events_without_image_contents(client, db_session):
    with new_user(client, db_session) as seller:
        lot = create_lot(seller, images=2).json()
        listing = open_listing(seller, lot["id"], images=1).json()
        _, admin_browser = make_admin(client, db_session)

        admin_browser.request("DELETE", f"{LISTING_URL}/{listing['id']}", json={"confirm_title": listing["title"]})
        admin_browser.request("DELETE", f"{LOT_URL}/{lot['id']}", json={"confirm_title": lot["title"]})

        db_session.expire_all()
        events = db_session.scalars(
            select(BiomassAuditEvent).order_by(BiomassAuditEvent.created_at)
        ).all()
        actions = [event.action for event in events]
        assert "admin.listing.deleted" in actions
        assert "admin.lot.deleted" in actions
        assert "admin.deletion.cleanup_completed" in actions

        for event in events:
            if event.action in ("admin.lot.deleted", "admin.listing.deleted"):
                assert event.actor_role == "admin" and event.actor_id is not None
                # Minimal metadata only — never image bytes or base64 blobs.
                assert set(event.detail) <= {"title", "images", "movements", "listings"}
                serialized = json.dumps(event.detail)
                assert "base64" not in serialized
                assert len(serialized) < 400
            if event.action == "admin.deletion.cleanup_completed":
                assert set(event.detail) <= {"removed_files", "missing_files", "attempts"}
