# CS-001 tasks

Status: IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF
Source: [spec](spec.md)

## Tasks

| Task | Tier | Scope & Dependency | Goal / Deliverable | Verification / Acceptance | Status |
|---|---|---|---|---|---|
| CS-01 | R0/R1 | REQUIRED | Add `StorageAdapter.checkWritable()`, wire into `GET /api/health/ready` (`503` on failure) and `startWorker()` boot check, update health unit & PG16 tests | `storage.test.ts` (2/2) + `health.test.ts` (5/5) + `shutdown.test.ts` (10/10) + PG16 `health.integration.test.ts` (1/1) (`CS-AT-01`) | DONE |
| CS-02 | R1 | REQUIRED | Configure `STORAGE_BASE_PATH: /app/storage` and shared `media_storage` volume for `web` & `worker` in `docker-compose.yml`, plus upgrade copy note | `docker compose config` PASS; `docker inspect` confirms `cs001-ci_media_storage:/app/storage` on both `web` and `worker` | DONE |
| CS-03 | R0/R1 | REQUIRED | Extend `scripts/compose-smoke.mjs` to dispatch `REPLAY` keyframe via `web`, wait for `worker` write, fetch `/api/assets/:assetId/media` with SHA-256 `ETag` check, and survive restart (`CS-AT-02`, `CS-AT-03`) | `COMPOSE_PROJECT_NAME=cs001-ci node scripts/compose-smoke.mjs` PASS; full CI gate matrix PASS | DONE |

### Test-First Evidence (R0 / R1)

- **Test**: `src/lib/storage.test.ts`, `src/routes/health.test.ts`, `src/worker/shutdown.test.ts` (`CS-AT-01`)
  - **Command**: `pnpm --filter @nolen/server test src/lib/storage.test.ts src/routes/health.test.ts src/worker/shutdown.test.ts`
  - **RED Evidence (before `checkWritable()` implementation)**:
    ```text
    FAIL  src/lib/storage.test.ts > StorageAdapter.checkWritable (CS-AT-01) > writes, syncs, and cleans up temp probe inside a writable storage root
    TypeError: adapter.checkWritable is not a function
    FAIL  src/routes/health.test.ts > Health Routes > GET /api/health/ready returns 503 when storage is unwritable (CS-AT-01)
    AssertionError: expected 200 to be 503
    FAIL  src/worker/shutdown.test.ts > CS-AT-01: aborts worker startup before pg-boss starts when storage is unwritable
    Error: checkWritable does not exist
    Test Files  3 failed (3) | Tests  5 failed | 12 passed (17)
    ```
  - **GREEN Evidence**:
    ```text
    ✓ src/lib/storage.test.ts (2 tests) 10ms
    ✓ src/routes/health.test.ts (5 tests) 15ms
    ✓ src/worker/shutdown.test.ts (10 tests) 761ms
    Test Files  3 passed (3) | Tests  17 passed (17)
    ```

- **Post-final-edit Verification Matrix (2026-11-25, branch `feature/compose-shared-storage`):**
  - `docker compose config --quiet` (`OPERATOR_TOKEN` set): **PASS**
  - `pnpm typecheck` (`@nolen/contracts`, `@nolen/server`, `@nolen/web`): **PASS**
  - `pnpm lint` (`--max-warnings 0`): **PASS**
  - `pnpm build` (host & inside `nolen-fc001:local` container): **PASS**
  - `COMPOSE_PROJECT_NAME=cs001-ci node scripts/compose-smoke.mjs`: **PASS** (`worker` wrote `keyframes/<sha256>.png` and `web` uploaded `references/<sha256>.png` into shared `/app/storage`; both served HTTP `200` with matching `ETag`/SHA-256 before and after `docker compose restart web worker`; `docker inspect` confirmed `cs001-ci_media_storage:/app/storage` on both containers; `ls -la /app/storage/keyframes /app/storage/references` matched identically)
  - `docker compose -p cs001-ci exec -T web pnpm --filter @nolen/server test:media` (`NODE_ENV=production`): **PASS** (1 file / 3 tests)
  - `docker compose -p cs001-ci exec -T web env -u STORAGE_BASE_PATH NODE_ENV=test pnpm test`: **PASS** (`@nolen/contracts`: 5 files / 20 tests; `@nolen/server`: 15 files / 73 tests)
  - `docker compose -p cs001-ci exec -T -e NODE_ENV=test -e DATABASE_URL=postgresql://nolen:nolen_dev@db:5432/nolen_int -e EXECUTION_MODE=REPLAY web pnpm --filter @nolen/server test:integration`: **PASS** (10 files / 94 tests on PG16)
  - Playwright E2E (`generation-inputs.spec.ts` 1/1, `shot-review.spec.ts` 5/5, `story.spec.ts` 4/4 against `cs001-ci`; `film.spec.ts` 6/6 against host `webServer` + PG16 `nolen_test`): **PASS** (16/16 total)
  - `pnpm --filter @nolen/web test:boundary` (2/2), `pnpm test:guardrails` (4/4), `pnpm test:evidence` (4/4), `pnpm check:evidence` (34 docs): **PASS**

## Handoff

Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
Branch: `feature/compose-shared-storage` (stacked on `feature/generation-input-contract@644f00a`).
Ready for owner sign-off and PR/merge; next milestone in the approved roadmap is **`LP-001` (Deterministic Local FFmpeg Pan/Zoom under `LIVE` + `LOCAL_PAN_ZOOM`)**.

### Registered files and interfaces

- `docker-compose.yml`: `STORAGE_BASE_PATH: /app/storage` in `&env`; named `media_storage` volume mounted at `/app/storage` on `web` and `worker`.
- `servers/src/lib/storage.ts` & `servers/src/lib/storage.test.ts`: `StorageAdapter.checkWritable()` atomic `temp/` probe.
- `servers/src/routes/health.ts`, `health.test.ts`, `health.integration.test.ts`: `GET /api/health/ready` checks both DB and writable storage (`503` on unwritable storage).
- `servers/src/worker/index.ts` & `servers/src/worker/shutdown.test.ts`: `startWorker()` runs `await storage.checkWritable()` before initializing `pg-boss`.
- `scripts/compose-smoke.mjs`: cross-container `worker`-write → `web`-serve SHA-256 media & restart persistence verification.
