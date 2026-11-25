# GI-001 tasks

Status: IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF
Source: [spec](spec.md)

## Tasks

| Task | Tier | Scope & Dependency | Goal / Deliverable | Verification / Acceptance | Status |
|---|---|---|---|---|---|
| GI-00 | R1/R0 | REQUIRED (Gate) | Freeze spec/tasks, create `feature/generation-input-contract`, verify FFprobe/FFmpeg stdin & flags inside production Docker image `nolen-fc001:local` | `pnpm check:evidence` PASS; Docker spike PASS (`ffmpeg/ffprobe 5.1.9-0+deb12u1`, `vitest 3.2.7` under `NODE_ENV=production`) | DONE |
| GI-01 | R1 | REQUIRED | Versioned `ShotSpec v2` (`camera.angle`), `StoryBible v2` (`referenceAssetIds`), mixed `storyContentSchema`, `canonicalStoryV2()`, `upgradeBibleToV2()`, `shotDependency()` normalization | `@nolen/contracts` (20/20 PASS) + `@nolen/server` unit (69/69 PASS) + PG16 `story.integration.test.ts` (10/10 PASS, `GI-AT-01`–`GI-AT-03`) | DONE |
| GI-02 | R0 | REQUIRED | `film_reference_assets` migration `0007` + `state-8.json`, `"references"` storage category, `boundedMultipart()`, FFprobe/FFmpeg stdin validator (`test:media`), atomic hard-link blob publish, `/reference-assets` API routes | Container `test:media` (3/3 PASS) + PG16 `migrate.integration.test.ts` (11/11 PASS) + PG16 `reference-assets.integration.test.ts` (2/2 PASS, `GI-AT-04`–`GI-AT-06`, `GI-AT-12`) | DONE |
| GI-03 | R0/R1 | REQUIRED | Pure `compileGenerationTemplate()` (`IMAGE` 5,000 / `VIDEO` 1,000), `VIDEO + PER_SECOND` duration guard, `POST /generation-previews`, `expectedPreviewHash` admission lock, `GenerationRequest` v1/v2 union & `TTS`/`ASSEMBLY` v1 isolation | `compiler.test.ts` (3/3 PASS) + PG16 `financial.integration.test.ts` (23/23), `completion.integration.test.ts`, `worker.integration.test.ts` (4/4), `assets.integration.test.ts` (17/17), `dispatch.integration.test.ts` (7/7) (`GI-AT-07`–`GI-AT-10`) | DONE |
| GI-04 | R1 | REQUIRED | Storyboard UI: `camera.angle` select & Add/Duplicate confirmation, Reference Library panel & Bible v1→v2 confirmation, authoritative preview before Generate, verbatim retry identity with `expectedPreviewHash`, `previewAndAdmitMediaAttempt()` migration | Playwright E2E: `generation-inputs.spec.ts` (1/1 PASS), `shot-review.spec.ts` (5/5 PASS), `story.spec.ts` (4/4 PASS), `film.spec.ts` (6/6 PASS) (`GI-AT-11`) | DONE |
| GI-05 | R0/R1 | REQUIRED | CI `quality.yml` (`ffmpeg` on runner + `test:media` inside Compose `web`), full gate run, evidence & commit handoff | `typecheck`, `lint`, `build`, `test`, `test:media`, `test:integration`, `test:e2e`, `compose-smoke`, `test:guardrails`, `test:boundary`, `test:evidence`, `check:evidence` PASS | DONE |

### GI-00 Docker Image Spike Evidence (2026-11-25)

- **Image tested:** `nolen-fc001:local` (`node:22.23.0-bookworm-slim`, `NODE_ENV=production`)
- **Binary versions:**
  - `ffmpeg version 5.1.9-0+deb12u1` (`libavutil 57.28.100`, `libavcodec 59.37.100`, `libavformat 59.27.100`)
  - `ffprobe version 5.1.9-0+deb12u1`
  - `vitest/3.2.7 linux-x64 node-v22.23.0` (`pnpm --filter @nolen/server exec vitest --version`, exit `0` under `NODE_ENV=production`)
- **Verified probe & decode commands (stdin `pipe:0`):**
  - `ffprobe -v error -protocol_whitelist pipe -show_entries format=format_name,nb_streams:stream=codec_name,width,height,nb_frames -of json -i pipe:0`
  - `ffmpeg -v error -xerror -err_detect explode -protocol_whitelist pipe -threads 1 -max_alloc 268435456 -i pipe:0 -frames:v 2 -f framecrc pipe:1`
- **Observed spike outputs:**
  - `staticPng` (`320x320`, `1146` bytes): ffprobe `format_name="png_pipe"`, `codec_name="png"`, `width=320`, `height=320`; ffmpeg decode exit `0`, `1` frame.
  - `staticJpg` (`320x320`, `824` bytes): ffprobe `format_name="jpeg_pipe"`, `codec_name="mjpeg"`, `width=320`, `height=320`; ffmpeg decode exit `0`, `1` frame.
  - `staticWebp` (`320x320`, `266` bytes): ffprobe `format_name="webp_pipe"`, `codec_name="webp"`, `width=320`, `height=320`; ffmpeg decode exit `0`, `1` frame.
  - `animWebp` (`4574` bytes, 2 frames): ffprobe `width=0, height=0`, stderr `image data not found`; ffmpeg decode exit `1` (rejected).
  - `animApng` (`4092` bytes, 2 frames): ffprobe `format_name="apng"`, `codec_name="apng"`; ffmpeg decode exit `0`, `2` frames (rejected by both format/codec and `frames !== 1`).
  - `corruptPng` (`55` bytes, truncated payload): ffprobe stderr `chunk too big`, `width=0, height=0`; ffmpeg decode exit `1` (rejected).
  - **Important flag finding:** Passing `-max_pixels 16777216` as a pre-input option on FFmpeg 5.1.9 did not abort a `4097x4097` PNG before decode (`status: 0`). Therefore `ffprobe` dimension/pixel bounds (`width >= 300`, `height >= 300`, `width <= 4096`, `height <= 4096`, `width * height <= 16,777,216`) MUST execute and fail closed **before** invoking `ffmpeg` decode, while `-max_alloc 268435456`, `-threads 1`, `-protocol_whitelist pipe`, `-xerror`, `-err_detect explode`, `-frames:v 2`, and `10s` `SIGKILL` timeout enforce subprocess containment.
  - **Subprocess kill check:** `spawn('ffmpeg', ...)` killed via `SIGKILL` at 150ms exited cleanly with `{ code: null, signal: 'SIGKILL', elapsedMs: 154 }`.

### Test-First Evidence (R0 / R1)

- **GI-02 (`test:media`) — Real FFprobe/FFmpeg fixture boundary catch (`GI-AT-05`, `GI-AT-12`)**
  - **Command**: `docker compose -p gi001-ci exec -T web pnpm --filter @nolen/server test:media`
  - **Observed failure & root cause**: Initial `color=c=black:s=4097x4097` lavfi fixture in `media-validation.media.test.ts` was silently clamped to `4096x4096` (`yuv420p` even-dimension rounding), resolving `{ mimeType: 'image/png', width: 4096, height: 4096 }` instead of rejecting. Updated fixtures to `s=298x300`, `s=4098x300` (`tooWide`), and `s=4098x4098` (`tooBig`).
  - **GREEN Evidence**: `Test Files  1 passed (1) | Tests  3 passed (3)` inside `nolen-fc001:local` (`ffmpeg 5.1.9-0+deb12u1`, `NODE_ENV=production`). Note: host Windows lacks `ffmpeg` in `PATH`, so running `test:media` on Windows host fails loudly (`spawnSync ffmpeg ENOENT`, `GI-AT-12` non-skipping invariant).

- **GI-04 (`generation-inputs.spec.ts`) — Label association fix (`GI-AT-11`)**
  - **Command**: `pnpm test:e2e tests/e2e/generation-inputs.spec.ts`
  - **Observed failure & fix**: Wrapping `<select>` directly inside `<label>Camera angle...</label>` caused `getByLabel('Camera angle', { exact: true })` to include option text and time out after `30000ms`. Switched to explicit `htmlFor="shot-camera-angle"` / `id="shot-camera-angle"` in `clients/components/storyboard.tsx`.
  - **GREEN Evidence**: Rebuilt `nolen-fc001:local` image and re-ran full container + Playwright gates (`10 passed` in `generation-inputs.spec.ts` + `shot-review.spec.ts` + `story.spec.ts`; `6 passed` in `film.spec.ts` against PG16 `nolen_test`).

- **Post-final-edit Gate Matrix (2026-11-25, branch `feature/generation-input-contract`):**
  - `pnpm typecheck` (`@nolen/contracts`, `@nolen/server`, `@nolen/web`): **PASS** (0 errors)
  - `pnpm lint` (`--max-warnings 0` across all 3 packages): **PASS** (0 warnings)
  - `pnpm build` (contracts + server + Next.js production webpack build in Docker): **PASS**
  - `NODE_ENV=test` container `pnpm test`: **PASS** (`@nolen/contracts`: 5 files / 20 tests; `@nolen/server`: 14 files / 69 tests including `media-validation.media.test.ts` 3/3)
  - `docker compose -p gi001-ci exec -T web pnpm --filter @nolen/server test:media` (`NODE_ENV=production`): **PASS** (1 file / 3 tests)
  - `COMPOSE_PROJECT_NAME=gi001-ci node scripts/compose-smoke.mjs`: **PASS**
  - Container PG16 `pnpm --filter @nolen/server test:integration` (`DATABASE_URL=postgresql://nolen:nolen_dev@db:5432/nolen_int`, `EXECUTION_MODE=REPLAY`): **PASS** (10 files / 94 tests, including `reference-assets.integration.test.ts` 2/2 and `migrate.integration.test.ts` 11/11)
  - Playwright E2E against `gi001-ci` `web` (`generation-inputs.spec.ts` 1/1, `shot-review.spec.ts` 5/5, `story.spec.ts` 4/4): **PASS** (10/10)
  - Playwright E2E against host `webServer` + PG16 (`film.spec.ts`): **PASS** (6/6)
  - `pnpm --filter @nolen/web test:boundary` (2/2), `pnpm test:guardrails` (4/4), `pnpm test:evidence` (4/4), `pnpm check:evidence` (32 docs): **PASS**

## Handoff

Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
Branch: `feature/generation-input-contract` (based on `main@b7dc8bc`).
All GI-001 tasks (`GI-00`–`GI-05`) are implemented and verified cleanly; ready for owner review / PR to `main`, followed immediately by the **Shared Compose Storage (`STORAGE_BASE_PATH=/app/storage`)** prerequisite before `LOCAL_PIPELINE` pan/zoom and `PD-05b`.

### Registered files and interfaces

- `packages/contracts/src/story.ts`: `bibleV1Schema`, `bibleV2Schema`, `bibleSchema`, `cameraAngleSchema`, `shotSpecV1Schema`, `shotSpecV2Schema`, `shotSpecSchema`, `createShotSpecV2()`, `upgradeBibleToV2()`, `canonicalStoryV1()`, `canonicalStoryV2()`.
- `packages/contracts/src/assets.ts`: `referenceMimeTypeSchema`, `referenceAssetDtoSchema`, `ReferenceAssetDto`.
- `packages/contracts/src/providers.ts` & `financial.ts`: `generationRequestV1Schema`, `generationRequestTemplateV2Schema`, `generationRequestV2Schema`, `generationRequestSchema`, preview schemas, `expectedPreviewHash` on `createAttemptSchema` (`IMAGE | VIDEO`).
- `servers/src/db/schema/assets.ts` & `servers/src/db/migrations/0007_film_reference_assets.sql` + `meta/state-8.json`: additive `film_reference_assets` schema and PG16 migration.
- `servers/src/lib/media-validation.ts` & `servers/src/http/boundary.ts`: `runStdinSubprocess()`, `validateStaticReferenceImage()`, `boundedMultipart()`.
- `servers/src/assets/reference-repository.ts` & `servers/src/http/asset-api.ts`: atomic hard-link blob publication, `/reference-assets` upload/list/media routes (`no-store`, `nosniff`, `inline`).
- `servers/src/dispatch/compiler.ts`, `servers/src/financial/repository.ts`, `servers/src/http/financial-api.ts`: `compileGenerationTemplate()`, `previewGeneration()`, `admitAttempt()` `expectedPreviewHash` & `VIDEO + PER_SECOND` duration guards, `POST /api/films/:filmId/generation-previews`.
- `servers/src/stories/domain.ts` & `repository.ts`: `shotDependency()` normalization and `verifyStoryBibleReferences()`.
- `clients/components/storyboard.tsx`: `Camera angle` control, Add/Duplicate v2 prompts, Reference Library panel & Bible v1→v2 confirmation, authoritative server preview panels, and `expectedPreviewHash` admission wiring.
- `.github/workflows/quality.yml`: runner `ffmpeg` install + Compose container `test:media` gate.
