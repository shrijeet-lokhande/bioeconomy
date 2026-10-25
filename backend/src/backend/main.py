"""FastAPI application factory.

App startup performs no schema creation — the database schema is owned by
Alembic migrations exclusively (uv run alembic upgrade head).
"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.admin import router as admin_router
from backend.api.auth import router as auth_router
from backend.config import get_settings


def create_app() -> FastAPI:
    settings = get_settings()
    # Make INFO logs (e.g. MAIL[...] delivery acceptances) visible under
    # plain `uvicorn backend.main:app`, whose default root level is WARNING.
    logging.basicConfig(level=logging.INFO)
    app = FastAPI(title=settings.app_name, version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH"],
        allow_headers=["*"],
    )

    app.include_router(auth_router)
    app.include_router(admin_router)

    @app.get("/api/v1/health", tags=["health"])
    def health() -> dict[str, str]:
        """Liveness only. It deliberately makes no database round-trip; use
        the auth endpoints (or logs) to diagnose database connectivity."""
        return {"status": "ok"}

    return app


app = create_app()
