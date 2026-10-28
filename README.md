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

## Getting Started

### Prerequisites

- Python and [uv](https://docs.astral.sh/uv/)
- Node.js and npm
- Docker Engine and Docker Compose
- Git

### 1. Clone the Repository

```bash
git clone <your-repository-url>
cd bioeconomy
```

### 2. Start the Backend

```bash
cd backend
cp .env.example .env        # then edit .env with your real database URL
uv sync
uv run alembic upgrade head # create users + auth_sessions tables
uv run uvicorn backend.main:app --reload
```

The backend exposes `backend/main.py:app` in the src layout (README history
documented `backend/app/main.py` — that layout does not exist; see docs/CURRENT_STATE.md).

Authentication endpoints live under `/api/v1/auth` (register, login,
logout, me, verify-email, resend-verification, forgot-password,
reset-password). Registration requires email
confirmation before first sign-in: configure a mail backend (`MAIL_BACKEND`:
`console` for a local gitignored outbox, `resend`, or `smtp`; see
backend/README.md). Only run this after `alembic upgrade head` — the app
never creates tables itself.

A role-gated admin supervision API lives under `/api/v1/admin/*`
(overview stats, user list/detail, account actions, session revocation,
role changes). The server enforces the role on every request (403
`admin_required` otherwise) — no endpoint can create an admin; the first
admin is granted by operator SQL only:

```sql
UPDATE users SET role = 'admin' WHERE email = '<address>';
```

See backend/README.md (Admin section) and docs/SECURITY.md for the full
authorization model and the self-protection rules.

API documentation is available at `/docs` when the server is running.

### 3. Start the Frontend

In a separate terminal:

```bash
cd frontend
npm install
npm run dev
```

Vite proxies `/api` to the backend during development. Sign up at the
Create account page, sign in, and the dashboard shows your account; the
biomass inventory and marketplace pages run against the real backend API
(the Overview dashboard remains a small, clearly-labelled local demo).

Registering a lot or publishing a marketplace listing requires uploading
1–5 images (JPEG/PNG/WebP, up to 5 MB each) together with the record;
image files are stored server-side under generated names and are served
only through the authorized image endpoint (`docs/SECURITY.md`,
Task 007 section).

Vite prints the local development URL in the terminal.

### 4. Start Supporting Services

Once `docker-compose.yml` is configured:

```bash
docker compose up -d
```

Check service status:

```bash
docker compose ps
```

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
