"""FastAPI application factory.

App startup performs no schema creation — the database schema is owned by
Alembic migrations exclusively (uv run alembic upgrade head).
"""

import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from backend.api.admin import router as admin_router
from backend.api.admin_biomass import router as admin_biomass_router
from backend.api.auth import router as auth_router
from backend.api.biomass import router as biomass_router
from backend.config import get_settings


def create_app() -> FastAPI:
    # Make INFO logs (e.g. MAIL[...] delivery acceptances) visible under
    # plain `uvicorn backend.main:app`, whose default root level is WARNING.
    logging.basicConfig(level=logging.INFO)
    settings = get_settings()
    sender_domain = settings.mail_from_address.rsplit("@", 1)[-1].lower()
    if settings.mail_backend == "resend" and sender_domain == "resend.dev":
        logging.getLogger("backend.startup").warning(
            "Resend shared test sender is configured; it cannot be used for "
            "ordinary user verification. Verify an owned sender domain and "
            "update MAIL_FROM_ADDRESS."
        )
    app = FastAPI(title=settings.app_name, version="0.1.0")

    app.add_middleware(
        CORSMiddleware,
        allow_origins=settings.cors_origins,
        allow_credentials=True,
        allow_methods=["GET", "POST", "PATCH", "DELETE"],
        allow_headers=["*"],
    )

    app.include_router(auth_router)
    app.include_router(admin_router)
    app.include_router(biomass_router)
    app.include_router(admin_biomass_router)

    @app.get("/api/v1/health", tags=["health"])
    def health() -> dict[str, str]:
        """Liveness only. It deliberately makes no database round-trip; use
        the auth endpoints (or logs) to diagnose database connectivity."""
        return {"status": "ok"}

    return app


app = create_app()
