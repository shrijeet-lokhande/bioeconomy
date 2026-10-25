# AGENTS.md

## Project Identity

Bioeconomy is an open-source platform that turns agricultural and forest data into actionable value.

Core areas:
- Agriculture and farm information
- Geospatial intelligence
- Biomass marketplace
- IoT telemetry
- Data analytics and AI-assisted insights

Guiding principle: TRUSTWORTHY DATA FIRST, USEFUL DECISIONS SECOND.

## Source of Truth

Before every substantial task, inspect:
1. `context.txt`
2. `README.md`
3. `docs/PRODUCT_SPEC.md`
4. `docs/ARCHITECTURE.md`
5. `docs/ROADMAP.md`
6. Relevant feature-specific documentation
7. The actual source code and current Git state

When sources conflict, do not silently choose one. Report the conflict and prefer verified implementation facts for describing current behavior. Ask for clarification when the conflict changes product requirements or architectural direction.

Documentation is not proof that a feature exists. Verify the source code and run the relevant tests.

## Scope Control

- Work only on the explicitly requested task.
- Do not implement future roadmap phases without approval.
- Do not perform unrelated refactors.
- Do not replace the existing stack or package manager without explaining why and obtaining approval.
- Do not add dependencies unless necessary; explain their purpose and trade-offs.
- Do not modify the backend when the task is frontend-only, or vice versa, unless integration requires it.
- Preserve existing user changes and configuration.
- Never delete files, reset Git history, or run destructive commands without explicit approval.

## Implementation Workflow

For each substantial task:
1. Inspect relevant files and dependencies.
2. Summarize the plan and affected files.
3. Implement a small, coherent feature.
4. Run applicable checks and tests.
5. Fix regressions introduced by the changes.
6. Inspect the Git diff.
7. Update relevant documentation and `context.txt`.
8. Report what changed, what was tested, and what remains incomplete.

If a requirement is ambiguous and materially affects architecture, data integrity, security, or user experience, ask before making an irreversible decision. For minor details, choose a reasonable default and document it.

## Anti-Hallucination Rules

- Never claim that a feature, endpoint, integration, test, or deployment works unless verified.
- Never fabricate test results, external data sources, sensor readings, legal permissions, or AI capabilities.
- Clearly label mock data, simulated telemetry, estimates, assumptions, and placeholders.
- Never present a placeholder as a completed feature.
- If a command cannot run, explain the actual blocker.
- If uncertain about an API or library, inspect the installed version and official documentation instead of inventing methods or configuration options.

## Engineering Standards

- Prefer small modules and clear interfaces.
- Use explicit types and input validation.
- Avoid duplicated business logic and unnecessary abstractions.
- Keep configuration separate from application code.
- Handle expected failures explicitly.
- Write tests for critical business rules and data transformations.
- Use migrations for database schema changes.
- Maintain compatibility between frontend types and backend API contracts.
- Never commit secrets, credentials, private datasets, or real personal data.

## Data Integrity and Responsible AI

- Record data provenance, timestamps, limitations, and units where applicable.
- Validate and normalize quantities before calculations.
- Distinguish unknown values from zero.
- Do not let an LLM determine legal harvesting permissions or invent measurements.
- Use deterministic backend logic for authoritative calculations and eligibility rules.
- Present uncertainty and explain the source of recommendations.
- Geospatial overlays do not independently establish legal permission to harvest or extract resources.

## Security

- Enforce authentication and authorization on the server for protected operations.
- Never trust client-supplied ownership, roles, prices, quantities, or permissions without validation.
- Validate uploaded files and external inputs.
- Keep secrets in environment variables or an appropriate secret manager.
- Do not disable security checks merely to make a demonstration work.
- Do not log credentials or sensitive personal information.

## Completion Standard

A task is not complete simply because code was generated.

Report:
- Files changed
- Functionality implemented
- Tests and commands actually executed
- Passes, failures, and skipped checks
- Known limitations
- Documentation updated
- Recommended next task

Do not create commits unless explicitly requested.
