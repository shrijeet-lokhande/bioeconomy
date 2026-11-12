"""Shared, non-destructive local database checks for the dev scripts."""

from __future__ import annotations

import argparse
import sys

from sqlalchemy import create_engine, text
from sqlalchemy.engine import make_url
from sqlalchemy.exc import SQLAlchemyError

from backend.config import Settings


def _connection_summary(url: object) -> str:
    try:
        parsed = make_url(str(url))
    except Exception:
        return "(invalid configured database URL)"
    host = parsed.host or "local socket"
    port = f":{parsed.port}" if parsed.port else ""
    return f"{host}{port}/{parsed.database or '(no database)'} as {parsed.username or 'current role'}"


def check_database(settings: Settings) -> bool:
    try:
        engine = create_engine(settings.database_url, pool_pre_ping=True)
    except Exception as exc:
        print(
            f"Database configuration is invalid ({type(exc).__name__}); "
            "review DATABASE_URL in backend/.env.",
            file=sys.stderr,
        )
        return False
    try:
        with engine.connect() as connection:
            version = connection.execute(text("SHOW server_version")).scalar_one()
            connection.execute(text("SELECT 1"))
        print(
            f"Database connection: OK (PostgreSQL {version}; "
            f"{_connection_summary(settings.database_url)})"
        )
        return True
    except SQLAlchemyError as exc:
        print(
            f"Database connection failed ({type(exc).__name__}) for "
            f"{_connection_summary(settings.database_url)}. "
            "Check backend/.env and PostgreSQL service/authentication.",
            file=sys.stderr,
        )
        return False
    finally:
        engine.dispose()


def ensure_development_database(settings: Settings) -> bool:
    try:
        target = make_url(settings.database_url)
    except Exception as exc:
        print(
            f"DATABASE_URL is invalid ({type(exc).__name__}); no database changes were made.",
            file=sys.stderr,
        )
        return False
    if settings.app_env != "development" or target.database != "bioeconomy":
        print(
            "Refusing automatic database creation: only APP_ENV=development "
            "with database name exactly 'bioeconomy' is eligible.",
            file=sys.stderr,
        )
        return False

    if check_database(settings):
        return True

    try:
        maintenance = create_engine(target.set(database="postgres"), isolation_level="AUTOCOMMIT")
    except Exception as exc:
        print(
            f"Could not prepare a PostgreSQL admin connection ({type(exc).__name__}); "
            "no database changes were made.",
            file=sys.stderr,
        )
        return False
    try:
        with maintenance.connect() as connection:
            exists = connection.execute(
                text("SELECT 1 FROM pg_database WHERE datname = :name"),
                {"name": target.database},
            ).scalar_one_or_none()
            if exists:
                print(
                    "The database exists but the configured application connection failed. "
                    "No database changes were made.",
                    file=sys.stderr,
                )
                return False
            connection.exec_driver_sql(f'CREATE DATABASE "{target.database}"')
        print("Created the missing development database 'bioeconomy'.")
    except SQLAlchemyError as exc:
        print(
            f"Could not create the development database ({type(exc).__name__}). "
            "No existing database was modified. Configure PostgreSQL and the "
            "role in backend/.env; if needed, an administrator can run: "
            "CREATE ROLE app_user LOGIN CREATEDB PASSWORD '<choose-a-local-password>'; "
            "CREATE DATABASE bioeconomy OWNER app_user;",
            file=sys.stderr,
        )
        return False
    finally:
        maintenance.dispose()

    return check_database(settings)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=("check-db", "ensure-dev-db"))
    args = parser.parse_args()
    try:
        settings = Settings()
    except Exception as exc:
        print(
            f"Backend configuration is invalid ({type(exc).__name__}). "
            "Review backend/.env against backend/.env.example.",
            file=sys.stderr,
        )
        return 2

    okay = check_database(settings) if args.command == "check-db" else ensure_development_database(settings)
    return 0 if okay else 1


if __name__ == "__main__":
    raise SystemExit(main())
