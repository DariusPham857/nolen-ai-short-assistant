## Description

<!-- Briefly describe the goal and functional changes introduced in this PR -->

## PRD & Architecture References

- **PRD Requirements**: <!-- e.g., FR-02 (Storyboard), FR-09 (Ledger), DEC-P01 (Co-pilot), DEC-P02 (Budget Guardrail) -->
- **Acceptance Tests**: <!-- e.g., AT-P01-01, AT-P02-03, AT-P04-08 -->
- **IT Ownership**: <!-- IT 1 (Backend/Finance/Jobs) | IT 2 (Frontend/Media/Reporting) | Shared -->

## Key Changes

- [ ] Domain / Schema / Migrations: <!-- Summarize if applicable -->
- [ ] API & Server Endpoints: <!-- Summarize if applicable -->
- [ ] UI & Components: <!-- Adheres to Three-Pane Workstation, DESIGN.md tokens, and Anti-Slop rules -->
- [ ] Invariants Preserved: <!-- Integer-micros, reserve-before-dispatch, append-only ledger, distinct state machines -->

## Verification & Testing Performed

- [ ] Automated Unit Tests: `pnpm test` <!-- Paste relevant output or test filenames -->
- [ ] Integration Tests: <!-- Real PostgreSQL 16 tested for concurrency/locking -->
- [ ] UI / Visual Verification: <!-- Desktop & responsive layout checked -->
- [ ] Preflight / Health Checks: `/api/health/live` & `/api/health/ready` verified

## Checklist

- [ ] Branch follows `feature/<name>` (or `fix/<name>`).
- [ ] Commits adhere to Conventional Commits (`feat(...)`, `fix(...)`, `docs(...)`).
- [ ] No secrets, `.env`, or sensitive credentials committed.
- [ ] `REPLAY` mode explicitly labeled where mock fixtures are used.
