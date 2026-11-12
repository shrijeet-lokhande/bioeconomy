<div align="center">

# 🌱 Bioeconomy

**Turning agricultural and forest data into actionable value.**

A data-driven platform connecting farmers, biomass resources, geospatial intelligence, IoT, and AI.

<br />

![Status](https://img.shields.io/badge/status-in%20development-789C82?style=flat-square)
![Python](https://img.shields.io/badge/Python-FastAPI-3776AB?style=flat-square&logo=python&logoColor=white)
![Frontend](https://img.shields.io/badge/Frontend-React%20%2B%20TypeScript-3178C6?style=flat-square&logo=typescript&logoColor=white)
![Database](https://img.shields.io/badge/Database-PostgreSQL%20%2B%20PostGIS-4169E1?style=flat-square&logo=postgresql&logoColor=white)

</div>

---

## Overview

Bioeconomy is a platform designed to help users understand, manage, and exchange biomass resources through a unified digital system.

It brings together:

- **Agriculture** — farm and crop information, with room for data-backed recommendations.
- **Geospatial intelligence** — map-based exploration of land and forest datasets.
- **Biomass marketplace** — listings that connect resource providers with potential buyers.
- **IoT monitoring** — sensor telemetry for relevant field measurements.
- **AI-assisted insights** — analysis and recommendations based on available data.

> **Principle:** trustworthy data first, useful decisions second.

## Architecture

```text
React + TypeScript
        │
        ▼
   FastAPI backend
        │
        ├── PostgreSQL + PostGIS
        ├── Geospatial data services
        ├── AI / analytics services
        └── IoT telemetry ingestion
                  ▲
                  │
             ESP32 devices
```

## Tech Stack

| Layer            | Technology                |
| ---------------- | ------------------------- |
| Frontend         | React, TypeScript, Vite   |
| API              | Python, FastAPI, Pydantic |
| Database         | PostgreSQL, PostGIS       |
| ORM & migrations | SQLAlchemy, Alembic       |
| Maps             | Leaflet / React Leaflet   |
| IoT              | ESP32, MQTT               |
| Testing          | pytest, Vitest (planned)  |
| Local services   | Docker Compose            |

## Project Structure

```text
bioeconomy/
├── backend/
│   ├── app/
│   │   ├── api/
│   │   ├── core/
│   │   ├── models/
│   │   ├── schemas/
│   │   ├── services/
│   │   └── main.py
│   ├── tests/
│   └── pyproject.toml
├── frontend/
├── firmware/
│   └── esp32/
├── data/
│   ├── raw/
│   └── processed/
├── docs/
├── docker-compose.yml
├── .gitignore
└── README.md
```

## Installation and Setup

The supported local development environments are Windows 10/11 (PowerShell), Arch Linux, Ubuntu, and Debian. The app uses Python 3.14 managed by uv, Node.js 20.19+ or 22.12+ with npm, PostgreSQL, and Git. Docker is not required. Setup scripts install available prerequisites from winget or official distribution repositories, sync locked dependencies, preserve existing `.env` files, and apply Alembic migrations without dropping data.

### Prerequisites

- Git, PowerShell on Windows or Bash on supported Linux.
- Internet access for official package repositories and dependency downloads.
- PostgreSQL and a local role. Automatic database creation is limited to a development database named `bioeconomy` and requires that role to have `CREATEDB` permission.

### Windows Installation

```powershell
git clone https://github.com/shrijeet-lokhande/bioeconomy.git
cd bioeconomy
powershell -ExecutionPolicy Bypass -File .\scripts\setup.ps1
```

The script detects or installs Git, Node.js LTS, Python 3.14, uv, and PostgreSQL 18 when official winget packages are available. PostgreSQL may require an interactive installer to set an administrator password. If winget cannot find an official package, install it from the vendor URL provided by the script and rerun setup. Reopen PowerShell if new tools are not yet on PATH.

### Linux Installation

```bash
git clone https://github.com/shrijeet-lokhande/bioeconomy.git
cd bioeconomy
chmod +x scripts/setup.sh scripts/start.sh
./scripts/setup.sh
```

Arch uses pacman and systemd; initialize PostgreSQL first if a fresh Arch install reports the cluster is not initialized. Ubuntu and Debian use apt and systemd. The scripts do not use AUR or remote root shell installers. uv supplies Python 3.14 if needed. If the distribution Node package is too old for Vite, install a supported LTS version from [nodejs.org](https://nodejs.org/en/download/) and rerun setup.

### Environment Configuration

Setup creates `backend/.env` and `frontend/.env` from their examples only when missing. Existing files are preserved. Both are gitignored; examples contain placeholders only.

Set `DATABASE_URL` in `backend/.env` to a PostgreSQL role/database you control, for example:

```text
DATABASE_URL=postgresql+psycopg://bioeconomy_app:<your-local-password>@localhost:5432/bioeconomy
```

URL-encode reserved characters in passwords. Example `app_user` and `app_password` values are placeholders, not pre-created PostgreSQL credentials. On Linux, open the PostgreSQL administrator console with `sudo -u postgres psql`; on Windows, open `psql` as the PostgreSQL administrator. Choose a local password and execute:

```sql
CREATE ROLE bioeconomy_app LOGIN CREATEDB PASSWORD '<choose-a-local-password>';
CREATE DATABASE bioeconomy OWNER bioeconomy_app;
```

If the role cannot connect or create the development DB, setup reports a sanitized error and preserves existing databases. Fix the URL/role permission and rerun.

Local email defaults to `MAIL_BACKEND=console`; messages are written to gitignored `backend/.mail_outbox`. For real delivery, configure Mailgun (`MAILGUN_API_KEY`, `MAILGUN_DOMAIN`, `MAILGUN_REGION`, matching `MAIL_FROM_ADDRESS`) or SMTP as documented in [backend/README.md](backend/README.md). Never commit credentials or put them in frontend `VITE_` variables.

Map tiles use the default keyless OpenFreeMap style. Optional providers use `VITE_MAP_TERRAIN_STYLE_URL` or `VITE_MAP_SATELLITE_STYLE_URL` in `frontend/.env`; restrict browser-visible provider keys to the app's origins. See [docs/MAP.md](docs/MAP.md).

### Starting Bioeconomy

Windows:

```powershell
powershell -ExecutionPolicy Bypass -File .\scripts\start.ps1
```

Linux:

```bash
./scripts/start.sh
```

The launcher checks the database, applies pending Alembic migrations, then starts FastAPI and Vite. It streams tagged logs, detects port conflicts, avoids duplicate instances, and stops only its own child processes on Ctrl+C.

### Accessing the application

- Frontend: <http://127.0.0.1:5173>
- Backend: <http://127.0.0.1:49173>
- API documentation: <http://127.0.0.1:49173/docs>
- Liveness: <http://127.0.0.1:49173/api/v1/health>

Vite proxies `/api` to FastAPI. The health route is liveness-only; the launcher separately verifies database connectivity.

### Troubleshooting

| Issue | Windows | Linux |
| --- | --- | --- |
| Node.js missing/old | `node --version; npm --version`; install supported LTS from nodejs.org | Same commands; install Node.js 20.19+ or 22.12+ |
| Python/uv missing | `uv --version; uv python list` | `uv --version; uv python list` |
| PostgreSQL stopped | `Get-Service *postgres*`; `Start-Service <service>` in elevated PowerShell | `systemctl status postgresql`; `sudo systemctl start postgresql` |
| Database auth failure | `psql -h localhost -U bioeconomy_app -d bioeconomy` | Same command |
| Migration failure | `cd backend; uv run alembic current; uv run alembic upgrade head` | `cd backend && uv run alembic current && uv run alembic upgrade head` |
| Port occupied | `Get-NetTCPConnection -State Listen -LocalPort 5173,49173` | `ss -ltnp '( sport = :5173 or sport = :49173 )'` |
| API proxy errors | Check `http://127.0.0.1:49173/api/v1/health` and launcher logs | Same URL; inspect tagged API logs |
| Map tiles missing | Check browser access to `tiles.openfreemap.org`; restart Vite after `.env` edits | Same |
| Mail errors | Console mail is in `backend/.mail_outbox`; check `MAIL_*`/`MAILGUN_*` | Same; inspect Mailgun Events if applicable |

Scripts do not print database URLs or provider secrets. Real mail credentials are unnecessary with the local console outbox.

### Manual Development Mode

After setup and database configuration, use separate terminals:

```bash
cd backend
uv run --locked alembic upgrade head
uv run --locked uvicorn backend.main:app --host 127.0.0.1 --port 49173
```

```bash
cd frontend
npm run dev:frontend
```

The `dev` command starts both services; `dev:frontend` starts only Vite for
this separate-terminal workflow. Use the launcher scripts for port/database
checks and coordinated cleanup. Backend tests: `uv run --locked pytest -q` in
`backend`; frontend tests: `npm test -- --run` in `frontend`.

### Production Deployment

These scripts and Vite's dev server are for local development only. They do not configure TLS, production secrets, process supervision, or production frontend hosting. Deploy built frontend assets and the API through an appropriately secured platform; do not expose the Vite dev server publicly.

Authentication endpoints are under `/api/v1/auth`; the role-gated admin API is under `/api/v1/admin/*`. See [backend/README.md](backend/README.md) and [docs/SECURITY.md](docs/SECURITY.md). Biomass uploads require 1–5 images. MapLibre is integrated, but no official forest or biomass data layers are configured yet.

## Development Principles

- **Security by default:** enforce authorization on the server, not just in the UI.
- **Data provenance:** record the source, date, and limitations of geospatial and agricultural data.
- **Responsible mapping:** mapped zones are informational and do not independently establish legal permission to harvest or extract resources.
- **Reliable telemetry:** validate sensor payloads and account for duplicate, delayed, or missing readings.
- **Honest AI:** communicate uncertainty and avoid presenting unsupported predictions as facts.
- **Maintainability:** keep services modular, test core workflows, and document decisions.

## Roadmap

- [ ] Establish the local development environment
- [ ] Implement authentication and role-based access
- [ ] Build farm and biomass listing workflows
- [ ] Integrate geospatial datasets and map layers
- [ ] Connect ESP32 sensor telemetry
- [ ] Add analytics and AI-assisted insights
- [ ] Deploy and validate an end-to-end MVP

## Contributing

This project is under active development. Keep changes focused, document setup changes, and never commit secrets or private datasets.

## License

A license has not been selected yet. Until one is added, all rights remain with the project owner.

---

<div align="center">

**Built for a more connected, data-informed bioeconomy.** 🌿

</div>
