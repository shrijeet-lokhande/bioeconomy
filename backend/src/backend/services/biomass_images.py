"""Image upload service for biomass records.

Hard rules, security first:
- 1..5 images per record — an image is COMPULSORY to register a lot or to
  create a marketplace listing; more than five is a client error.
- The client-declared content type and filename are UNTRUSTED. The real
  type is decided from magic bytes (JPEG, PNG, WebP only).
- Bytes are written under a SERVER-GENERATED name in the configured upload
  directory — a client name never touches disk, so path traversal and
  name collisions are impossible. `original_name` is sanitized to its
  basename and used for display only.
- Oversized files are rejected before full processing (413).
"""

import re
import uuid
from pathlib import Path

from fastapi import HTTPException, status
from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.models import BiomassImage

MIN_IMAGES = 1
MAX_IMAGES = 5

IMAGE_SIGNATURES: tuple[tuple[bytes, str, str], ...] = (
    # (sniffed prefix bytes, media type, file extension)
    (b"\xff\xd8\xff", "image/jpeg", "jpg"),
    (b"\x89PNG\r\n\x1a\n", "image/png", "png"),
)


def _sniff_webp(header: bytes) -> str | None:
    if header[:4] == b"RIFF" and len(header) >= 12 and header[8:12] == b"WEBP":
        return "image/webp"
    return None


def _sniff_image_type(data: bytes) -> tuple[str, str] | None:
    """Determines the ACTUAL media type from magic bytes — the declared
    content type of the upload is never trusted. Returns (type, ext)."""
    for prefix, media_type, ext in IMAGE_SIGNATURES:
        if data[: len(prefix)] == prefix:
            return media_type, ext
    webp = _sniff_webp(data[:12])
    if webp is not None:
        return webp, "webp"
    return None


def max_bytes() -> int:
    return get_settings().biomass_image_max_mb * 1024 * 1024


def upload_dir() -> Path:
    directory = Path(get_settings().biomass_image_upload_dir)
    directory.mkdir(parents=True, exist_ok=True)
    return directory


class ValidatedImage:
    """One fully validated upload, still in memory. Nothing about a client
    upload is trusted: the media type comes from magic bytes, the stored
    name is generated at persist time, and `original_name` is a sanitized
    display-only basename."""

    __slots__ = ("data", "media_type", "ext", "original_name")

    def __init__(self, data: bytes, media_type: str, ext: str, original_name: str):
        self.data = data
        self.media_type = media_type
        self.ext = ext
        self.original_name = original_name


def validate_images(files: list) -> list[ValidatedImage]:
    """Validates the whole upload set BEFORE any record is created: a record
    can never exist without its compulsory 1..5 valid images.

    Raises 422/413 with specific, safe messages.
    """
    if not files:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail="At least one image is required to register this record.",
        )
    if len(files) > MAX_IMAGES:
        raise HTTPException(
            status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
            detail=f"A record can carry at most {MAX_IMAGES} images.",
        )
    limit = max_bytes()
    validated: list[ValidatedImage] = []
    for index, upload in enumerate(files, start=1):
        data = upload.file.read(limit + 1)
        if not data:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="An uploaded image file is empty.",
            )
        if len(data) > limit:
            raise HTTPException(
                status_code=status.HTTP_413_REQUEST_ENTITY_TOO_LARGE,
                detail=(
                    f"Image {index} exceeds the "
                    f"{get_settings().biomass_image_max_mb} MB size limit."
                ),
            )
        detected = _sniff_image_type(data)
        if detected is None:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail="Unsupported image format. Only JPEG, PNG and WebP are accepted.",
            )
        media_type, ext = detected
        # The extension never drives anything; an explicit mismatch with the
        # sniffed type is a client error (e.g. .png around JPEG bytes, or a
        # document renamed blindly). No extension at all is tolerated.
        suffix = Path(upload.filename or "").suffix.lower()
        extension_matches = {".jpg", ".jpeg"} if ext == "jpg" else {f".{ext}"}
        if suffix and suffix not in extension_matches:
            raise HTTPException(
                status_code=status.HTTP_422_UNPROCESSABLE_ENTITY,
                detail=f"Image {index}'s file extension does not match its actual format.",
            )
        validated.append(
            ValidatedImage(
                data=data,
                media_type=media_type,
                ext=ext,
                original_name=_clean_original_name(upload.filename, index),
            )
        )
    return validated


def persist_images(
    db: Session,
    *,
    kind: str,  # "lot" | "listing"
    parent_id: uuid.UUID,
    validated: list[ValidatedImage],
) -> list[BiomassImage]:
    """Writes validated files to disk and queues the metadata rows into the
    caller's OPEN transaction (insert only — images are never mutated or
    deleted through any API). Called inside the record-creation transaction
    so a compulsory-image record and its gallery are committed together.

    Files are written before the commit: a crashed transaction can leave an
    orphan file (harmless); the reverse (DB row without a file) would be a
    broken record, so this ordering is deliberate."""
    directory = upload_dir()
    rows: list[BiomassImage] = []
    for index, image in enumerate(validated, start=1):
        stored_name = uuid.uuid4().hex + "." + image.ext
        (directory / stored_name).write_bytes(image.data)
        rows.append(
            BiomassImage(
                lot_id=parent_id if kind == "lot" else None,
                listing_id=parent_id if kind == "listing" else None,
                position=index,
                stored_name=stored_name,
                original_name=image.original_name,
                content_type=image.media_type,
                size_bytes=len(image.data),
            )
        )
    db.add_all(rows)
    return rows


def _clean_original_name(filename: str | None, index: int) -> str:
    """Basename only (no directories from the client), bounded length, and a
    deterministic fallback so every image has a non-empty, honest name."""
    if filename:
        base = Path(filename).name.strip()
        if base:
            return base[:255]
    return f"image-{index}"


def image_stored_path(image: BiomassImage) -> Path | None:
    path = upload_dir() / image.stored_name
    return path if path.exists() else None


# ==== reliable deletion cleanup =============================================

# Exactly what persist_images() generates: uuid4 hex + a sniffed extension.
# Anything else was never written by this service and is never deleted.
_STORED_NAME_RE = re.compile(r"^[0-9a-f]{32}\.(jpg|png|webp)$")


def safe_unlink(stored_name: str) -> str:
    """Removes ONE image file by its server-generated stored name.

    Returns "removed", "missing", or "invalid". Safety properties:
    - the name must match the generator's exact format (no separators, no
      traversal — anything else is "invalid" and untouched);
    - the resolved path must still sit inside the configured upload
      directory (symlink/renamed-directory abuse cannot escape it);
    - only a regular, non-symlink file is ever unlinked — never a
      directory, never a symlink target, never a shared root;
    - a missing file is fine (idempotent: retrying never damages anything).
    """
    if not _STORED_NAME_RE.fullmatch(stored_name):
        return "invalid"
    root = upload_dir().resolve()
    path = root / stored_name
    try:
        resolved = path.resolve()
    except OSError:
        return "invalid"
    if resolved.parent != root:
        return "invalid"
    if path.is_symlink():
        return "invalid"
    if not path.exists():
        # Already gone — missing files count as cleaned (idempotent retry).
        return "missing"
    if not path.is_file():
        return "invalid"
    try:
        resolved.unlink()
    except FileNotFoundError:
        return "missing"
    except OSError:
        return "invalid"
    return "removed"


def cleanup_files(storage_keys: list[str]) -> dict[str, int]:
    """Deletes a record's image files idempotently. Missing files count as
    cleaned; unreadable/refused keys leave the cleanup incomplete so the
    caller can report and retry. Never raises."""
    counts = {"removed": 0, "missing": 0, "invalid": 0}
    for key in storage_keys:
        counts[safe_unlink(key)] += 1
    return counts
