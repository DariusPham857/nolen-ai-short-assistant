# KF-001 tasks

Status: IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF
Source: [approved specification](spec.md)

## Tasks

| Task | Scope and dependency | Verification / acceptance |
|---|---|---|
| KF-01 | Freeze specification, link contracts, and record G2 sign-off | `pnpm check:evidence`, `spec.md` valid |
| KF-02 | Additive migration 0004 & state-5; `@nolen/contracts` schemas | Schema typecheck, migration preflight, Drizzle snapshot |
| KF-03 | Content-addressed storage publish, SHA-256 verification & asset service | Unit & storage tests; OWASP containment checks |
| KF-04 | Keyframe gating in `admitAttempt` with `films` lock & interleaving tests | PG16 integration tests (KF-AT-01–10); zero-cost rejection |
| KF-05 | Keyframe Review UI workstation modal & storyboard status badges | Playwright / Component review flow |
| KF-06 | Full quality gates, evidence verification, and PR handoff | `pnpm test`, `typecheck`, `lint`, `test:guardrails`, CI |

## Handoff

Baseline: `main@3e8ab8f` (PR #10 merged). Feature work is implemented and verified on `feature/keyframe-approval-gate`.

- KF-01: canonical specification for EP-03 / KF-001 keyframe gating and asset lifecycle.
- G2 is accepted (`G2_ACCEPTED`). G3 provider work (Gemini, Runway, fal.ai) is deferred to EP-04.
- Security & storage: media files stored content-addressed under `keyframes/<sha256>.<ext>`, served via safe API locators.

### Registered files and interfaces

- `packages/contracts/src/assets.ts`: asset, review, and selection DTO schemas (`AssetDto`, `ReviewAsset`, `ShotAssetSelectionDto`).
- `packages/contracts/src/assets.test.ts`: 4 unit tests covering enum parsing, non-negative string byte sizes, SHA-256 validation, review reasons, and DTO parsing.
- `servers/src/db/schema/assets.ts`: `assets`, `asset_reviews`, and `shot_asset_selections` tables with composite unique constraints and composite foreign keys enforcing revision and kind compatibility.
- `servers/src/db/migrations/0004_faulty_captain_stacy.sql` & `meta/state-5.json`: additive schema migration 0004 with catalog snapshot state-5, composite foreign keys (`(film_id, asset_id, shot_revision_id)` on `asset_reviews` and `(film_id, asset_id, shot_revision_id, kind)` on `shot_asset_selections`), and `kf_asset_reviews_append_only` trigger.
- `servers/src/assets/repository.ts`: asset persistence with attempt provenance enforcement, SHA-256 storage verification, authenticated media locator, optimistic review concurrency, and active selection state.
- `servers/src/http/asset-api.ts`: `/api/films/:filmId/shots/:shotId/assets`, `/api/assets/:assetId/review`, and `/api/assets/:assetId/media` (operator authenticated and film-scoped).
- `servers/src/financial/repository.ts`: deterministic keyframe gating in `admitAttempt` with `FOR UPDATE OF f` row lock, storage integrity revalidation, and defense-in-depth revision/kind join checks before VIDEO dispatch.
- `servers/src/assets/assets.integration.test.ts`: acceptance test suite covering KF-AT-01 through KF-AT-10 plus KF-BLOCK-1 through KF-BLOCK-5 against PostgreSQL 16.
- `clients/components/keyframe-review.tsx`: Producer keyframe review workstation modal with 9:16 preview, status badges, and approve/reject flow.
- `clients/components/storyboard.tsx`: Keyframe review button and modal integrated into Shot Inspector.

### Verification evidence

- `pnpm -r typecheck`: PASS (contracts, servers, clients)
- `pnpm -r lint`: PASS (0 warnings, 0 errors across contracts, servers, clients)
- `pnpm test`: PASS (30 unit tests across contracts and servers)
- `pnpm test:guardrails`: PASS (4/4 tests)
- `pnpm check:evidence`: PASS (26 engineering documents)
- `pnpm test:evidence`: PASS (4/4 tests)
- Vitest integration tests against real PostgreSQL 16:
  - `src/assets/assets.integration.test.ts`: 15/15 PASS (KF-AT-01 to KF-AT-10, KF-BLOCK-1 to KF-BLOCK-5)
  - `src/db/migrate.integration.test.ts`: 8/8 PASS (including migration 0004 & state-5 upgrade tests)
  - `src/financial/financial.integration.test.ts`: 11/11 PASS
  - `src/stories/story.integration.test.ts`: 10/10 PASS
  - `src/films/film.integration.test.ts`: 7/7 PASS
  - `src/routes/health.integration.test.ts`: 1/1 PASS
  - Total: 52/52 integration tests PASSED.
