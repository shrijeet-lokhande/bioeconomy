"""Process-local rate limiting for authentication endpoints.

Limitation (documented in README/SECURITY docs): this limiter lives inside a
single API process and resets on restart. It mitigates brute-force attempts
from one client in a single-process development or small deployment. A
shared limiter (e.g. Redis-backed) + proxy-aware client IP handling is a
concrete follow-up task before multi-instance production deployment.
"""

import threading
import time

from fastapi import HTTPException, Request, status

from backend.config import get_settings

_buckets: dict[str, list[float]] = {}
_lock = threading.Lock()


def client_key(request: Request, scope: str) -> str:
    host = request.client.host if request.client is not None else "unknown"
    return f"{scope}:{host}"


def enforce_rate_limit(request: Request, scope: str) -> None:
    settings = get_settings()
    if not settings.rate_limit_enabled:
        return
    key = client_key(request, scope)
    now = time.monotonic()
    window = 60.0
    with _lock:
        recent = [t for t in _buckets.get(key, []) if now - t < window]
        if len(recent) >= settings.rate_limit_per_minute:
            raise HTTPException(
                status_code=status.HTTP_429_TOO_MANY_REQUESTS,
                detail="Too many requests. Please try again later.",
            )
        recent.append(now)
        _buckets[key] = recent
