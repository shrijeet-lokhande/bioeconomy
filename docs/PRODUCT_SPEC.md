# Bioeconomy Product Specification

## Mission

Provide an open-source platform that helps farmers and landowners organize agricultural and biomass information, explore relevant geospatial datasets, and connect resources with potential uses and buyers.

## Users

- Farmers and landowners
- Biomass buyers and processors
- Researchers and analysts
- Platform administrators
- Authorized data contributors

## Core Product Modules

### 1. Agriculture
Manage farm profiles and relevant crop information. Recommendations must be grounded in suitable data and clearly disclose limitations.

### 2. Geospatial Intelligence
Display geographic datasets with source, publication or update date, coverage, and known limitations.

A displayed boundary or zone is informational unless the relevant authority and applicable rules establish otherwise.

### 3. Biomass Marketplace
Allow authorized users to create, view, update, and manage biomass listings.

Listings should identify biomass type, quantity, unit, location, availability, condition or quality when known, and listing status.

Never represent demo listings as verified real-world supply.

### 4. IoT Monitoring
Accept validated sensor readings with timestamps, units, device identity, and quality indicators.

Account for duplicate, delayed, missing, and invalid readings.

### 5. Analytics and AI
Generate insights only from available, relevant data.

Distinguish measured values, calculated estimates, model outputs, and assumptions. Provide explanations and data sources where possible.

### 6. Administration and Trust
Support appropriate access controls, data provenance, auditability, and correction of inaccurate information.

## Product Principles

- Open source and designed for community deployment.
- Usable without a paid AI provider.
- Core workflows should not depend on an LLM.
- Do not collect unnecessary personal data.
- Do not imply regulatory approval or legal eligibility without authoritative verification.
- Prefer useful, reliable workflows over an excessive feature count.

## MVP Boundary

The initial prototype should establish one complete biomass listing workflow.

Later modules must be added in roadmap order and only when the current milestone meets its acceptance criteria.

## Definition of a Real Feature

A feature is considered implemented only when its expected behavior is defined, its success and failure paths are handled, and the relevant checks have been executed.

A visual mockup, hardcoded result, or simulated integration must be identified as such.
