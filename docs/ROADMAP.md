# Bioeconomy Development Roadmap

The project is developed over approximately six monthly phases. Each phase allows three weeks for development and one week for integration, testing, and stabilization.

Testing must also happen continuously during development.

## Phase 1: Foundation and First Vertical Slice
- Verify repository structure and development commands.
- Establish frontend conventions and reusable UI components.
- Build the initial dashboard and biomass listing workflow.
- Define the data model and future API boundary.
- Acceptance: listing workflow functions with clearly labelled demo data.

## Phase 2: Backend and Persistence
- Establish the FastAPI application and configuration.
- Define validated API schemas and error handling.
- Implement database integration and migrations.
- Connect the listing workflow to persistent storage.
- Acceptance: listing operations pass automated API and database tests.

## Phase 3: Identity and Access Control
- Define roles, permissions, and ownership rules.
- Implement authentication and server-side authorization.
- Test unauthorized and cross-user access.
- Acceptance: protected operations enforce permissions on the server.

## Phase 4: Geospatial Intelligence
- Integrate suitable, documented geospatial datasets.
- Record source, date, coverage, and limitations.
- Add map layers and spatial queries.
- Acceptance: map data is traceable and uncertainty is communicated.

## Phase 5: IoT and Analytics
- Establish a validated telemetry ingestion workflow.
- Handle duplicate, delayed, missing, and invalid readings.
- Build useful deterministic analytics.
- Acceptance: telemetry and analytics behavior is tested using reproducible data.

## Phase 6: AI, Integration, and MVP Validation
- Add AI-assisted insights using a replaceable provider interface.
- Ground outputs in retrieved data and validated calculations.
- Test failure behavior, data handling, and integration.
- Document setup and deployment.
- Acceptance: a reproducible end-to-end demonstration with documented limitations.

## Change Control

Do not move features between phases silently. If a dependency or feasibility issue requires changing the order, document the reason and proposed alternative before implementation.

Every phase must have measurable acceptance criteria before being considered complete.
