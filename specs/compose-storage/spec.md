# CS-001 — Shared Compose Storage Prerequisite

Status: APPROVED
Source: [PRD v1.0](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md), [AGENTS.md](../../AGENTS.md), [FC-001](../film-creation/spec.md)

## Goal

[DECIDED] Unify `web` and `worker` services in [docker-compose.yml](../../docker-compose.yml) onto a single shared persistent media volume (`media_storage` mounted at `/app/storage` via `STORAGE_BASE_PATH=/app/storage`) so media assets written by `worker` are immediately readable and verifiable by `web` (`GET /api/assets/:assetId/media`), while failing closed when configured storage is unwritable.

## Scope

- **REQUIRED (CS-001):**
  - **CS-01 (R1/R0):** Add `STORAGE_BASE_PATH: /app/storage` to shared `&env` and mount named volume `media_storage:/app/storage` on both `web` and `worker` in [docker-compose.yml](../../docker-compose.yml), plus document one-time volume migration for existing DB-referenced media.
  - **CS-02 (R0):** Add `StorageAdapter.checkWritable()` in `servers/src/lib/storage.ts`, enforce it in `GET /api/health/ready` (`503` if unwritable) and on worker boot in `servers/src/worker/index.ts`, with R0 RED→GREEN unit and PG16 integration coverage.
  - **CS-03 (R1):** Extend [compose-smoke.mjs](../../scripts/compose-smoke.mjs) to prove real cross-container storage visibility (`web` admits `REPLAY` keyframe → `worker` writes `keyframes/<sha256>.png` → `web` serves `GET /api/assets/:assetId/media` HTTP `200` with matching SHA-256 `ETag`).
- **PREREQUISITE:**
  - `GI-001` (`generation-inputs`) baseline on `feature/generation-input-contract@644f00a`.
- **DEFER:**
  - Local FFmpeg Pan/Zoom rendering (`LP-001`), live LLM planner (`FREE-PLAN-01`), `PD-05b` live provider adapters, and `EP-06` assembly.
  - Dedicated mount-point heuristic (not needed for MVP because `compose-smoke.mjs` detects missing/misconfigured shared volumes directly).

### Behavioral and Architectural Models (Lightweight AMDD)

- **Risk Tiers ([ENG-DEC-002](../../docs/development/ENG-DEC-002.md)):**
  - **R0 (Critical):** `StorageAdapter.checkWritable()` atomic temp probe & fail-closed `/api/health/ready` (`503`) + worker boot abort; cross-container SHA-256 media integrity.
  - **R1 (Important):** `docker-compose.yml` shared named volume + env inheritance and `compose-smoke.mjs` cross-container verification.
- **Upgrade Note for Existing Local Compose Databases:**
  - Prior Compose setups without `media_storage` wrote container-local files inside `web` (`/app/clients/storage`) or `worker` (`/app/servers/storage`). If upgrading an existing non-empty PostgreSQL `pgdata` volume with committed `assets` or `film_reference_assets` rows, copy existing subdirectories (`keyframes`, `videos`, `references`, `audio`, `exports`) into the `media_storage` volume at `/app/storage` before removing old containers so `storage.verify()` continues to pass.

## Invariants

- [DECIDED] **Single Storage Root Across Services:** Both `web` and `worker` read and write media strictly through `StorageAdapter` configured with `STORAGE_BASE_PATH=/app/storage` inside Docker Compose.
- [DECIDED] **Fail-Closed Writability:** Unwritable `STORAGE_BASE_PATH` fails `GET /api/health/ready` with `503` and aborts `startWorker()` before starting `pg-boss` or background runners.
- [DECIDED] **Zero External Paid Calls:** Verification uses `REPLAY` fixtures only (`$0 phí API phát sinh`).

## Acceptance criteria

- `CS-AT-01`: Unwritable `STORAGE_BASE_PATH` fails `GET /api/health/ready` (`503`, `checks.storage: "unwritable: ..."`) and aborts `startWorker()` before `pg-boss` starts.
- `CS-AT-02`: Missing or misconfigured shared volume fails cross-container `compose-smoke.mjs` (`worker` write to `/app/storage` → `web` `GET /api/assets/:assetId/media` HTTP `200` with matching SHA-256 `ETag`).
- `CS-AT-03`: Both `web` reference uploads (`POST /api/films/:filmId/reference-assets`) and `worker`-written assets remain accessible via `web` across `docker compose restart web worker`.

## Open Questions / Blocked Contracts

- None.
