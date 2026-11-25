# EP-05 Tasks: Shot Video Generation, Attempt History & Review Workstation (T-026, T-027)

Status: IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF
Source: [approved specification](spec.md)

## Tasks

| Task | Scope and dependency | Verification / acceptance | Status |
|---|---|---|---|
| EP05-01 | Freeze specification, link contracts, and record dependencies | `pnpm check:evidence`, `spec.md` valid | DONE |
| EP05-02 | Add `@nolen/contracts` schemas: `selectShotAssetSchema` and `shotAttemptDtoSchema` | `pnpm --filter @nolen/contracts test` (18/18 PASS) | DONE |
| EP05-03 | Backend repository methods: `selectShotAsset`, `getShotAttempts`, read-only `listRateCards` | PG16 integration tests in `assets.integration.test.ts` & `financial.integration.test.ts` (40/40 PASS) | DONE |
| EP05-04 | Authenticated API routes: `/selections`, `/attempts`, and read-only `/api/rate-cards` | 401 unauthenticated check, read-only assertion (EP05-AT-04) | DONE |
| EP05-05 | Storyboard workstation UI: exact provider selection, keyframe gating, preserved retry identity | E2E Playwright test `tests/e2e/shot-review.spec.ts` (5/5 PASS) | DONE |
| EP05-06 | `VideoReviewModal`: 9:16 viewport, attempt history, approve/reject/set active controls | E2E Playwright test `tests/e2e/shot-review.spec.ts` (5/5 PASS) | DONE |
| EP05-07 | Full quality gates, evidence verification, and PR handoff | `pnpm test` (76/76 PASS), `typecheck` (0 errors), `test:guardrails` (4/4 PASS), `check:evidence` (30/30 PASS), PG16 integration (90/90 PASS) | DONE |

## Handoff

Feature work is implemented on branch `feature/shot-generation-review`.
PR targets base branch `feature/provider-replay-worker` (which contains PD-05a).

### Registered files and interfaces

- `packages/contracts/src/assets.ts`: `selectShotAssetSchema` (`assetId`, `kind`), `shotAttemptDtoSchema`.
- `packages/contracts/src/assets.test.ts`: Unit test assertions for select and attempt DTO schemas.
- `servers/src/assets/repository.ts`: `selectShotAsset` with exclusive selection upsert and `getShotAttempts` with review/selection joins.
- `servers/src/financial/repository.ts`: read-only `listRateCards` querying active snapshots with zero database writes.
- `servers/src/http/asset-api.ts`: `/api/films/:filmId/shots/:shotId/selections` (POST) and `/api/films/:filmId/shots/:shotId/attempts` (GET).
- `servers/src/http/financial-api.ts`: `/api/rate-cards` (GET) protected by `requireOperator(c)`.
- `servers/src/db/seed.ts`: Idempotent seeding of verified baseline rate cards with PRD v1.0 references.
- `clients/components/video-review.tsx`: 9:16 video review modal with attempt history and active selection controls.
- `clients/components/storyboard.tsx`: Media generation card with exact provider lookup, keyframe gating for all video routes, and preserved retry identity recovery.
- `tests/e2e/shot-review.spec.ts`: Focused Playwright workflow test covering exact provider selection, keyframe gating, retry identity preservation, review, and active selection.
