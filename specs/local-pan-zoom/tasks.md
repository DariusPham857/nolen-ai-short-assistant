# LP-001 tasks

Status: IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF
Source: [spec](spec.md)

## Tasks

| Task | Tier | Scope & Dependency | Goal / Deliverable | Verification / Acceptance | Status |
|---|---|---|---|---|---|
| LP-00 | R0/R1 | REQUIRED (Gate) | Run FFmpeg `libx264` + `zoompan` + `ffprobe` spike in `nolen-fc001:local`, draft spec & tasks for approval | `pnpm check:evidence` PASS; container spike PASS (`ffmpeg 5.1.9-0+deb12u1`) | DONE |
| LP-01 | R1 | REQUIRED | Contracts (`LOCAL_PIPELINE` provenance, `LOCAL_STORAGE` locator, `startFrameProvenance` lineage) & `LOCAL_VERIFIED` `$0.00` rate card | `@nolen/contracts` RED → GREEN (5 files / 21 tests PASS); `seed-rate-cards.ts` | DONE |
| LP-02 | R0 | REQUIRED | `ffmpeg-pan-zoom.ts` renderer, `ffprobe` verification, pre-render terminal check, `completeLocalPanZoomAttempt()`, handled failure cleanup/settlement vs crash recovery | Unit (6/6) + Container `test:media` (5/5) + PG16 `local-pan-zoom.integration.test.ts` (6/6) (`LP-AT-01`–`LP-AT-03`, `LP-AT-05`, `LP-AT-06`, `LP-AT-08`) | DONE |
| LP-03 | R0/R1 | REQUIRED | `admitAttempt()`/`resolveAuthoritativeMediaTemplate()` remote-LIVE block + `LOCAL_PAN_ZOOM` unlock, `worker/index.ts` `live:generation:dispatch`, `storyboard.tsx` + `video-review.tsx` LIVE rate-card filter & lineage badge | PG16 `worker.integration.test.ts` + Compose Playwright E2E `local-pan-zoom.spec.ts` (`LP-AT-04`, `LP-AT-07`) + full CI matrix PASS | DONE |

### LP-00 Docker Image Spike Evidence (2026-11-25)

- **Image tested:** `nolen-fc001:local` (`node:22.23.0-bookworm-slim`, `ffmpeg version 5.1.9-0+deb12u1`, `ffprobe version 5.1.9-0+deb12u1`).
- **Verified H.264 Encoders:** `libx264`, `libx264rgb`, `mpeg4` present in Debian Bookworm package build.
- **Spike 1 (9:16 `720x1280` PNG → 5s `1080x1920` MP4):**
  - Filter: `scale=2160:3840:flags=bicubic,zoompan=z=min(zoom+0.0015\,1.18):d=150:x=iw/2-(iw/zoom/2):y=ih/2-(ih/zoom/2):s=1080x1920:fps=30,format=yuv420p`
  - Encode args: `-protocol_whitelist file,pipe -threads 2 -t 5 -c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -movflags +faststart -an`
  - `ffprobe` result: `format_name="mov,mp4,m4a,3gp,3g2,mj2"`, `duration="5.000000"`, `size="15149"`, single stream `codec_name="h264"`, `codec_type="video"`, `width=1080`, `height=1920`, `pix_fmt="yuv420p"`, `r_frame_rate="30/1"`, `avg_frame_rate="30/1"`, `nb_frames="150"`.
- **Spike 2 (Square `320x320` PNG → crop-safe 3s `1080x1920` pan MP4):**
  - Filter: `scale=2160:3840:force_original_aspect_ratio=increase:flags=bicubic,crop=2160:3840,setsar=1,zoompan=z=1.15:d=90:x=on/(90-1)*(iw-iw/zoom):y=ih/2-(ih/zoom/2):s=1080x1920:fps=30,format=yuv420p`
  - `ffprobe` result: `duration="3.000000"`, `size="171075"`, single stream `codec_name="h264"`, `width=1080`, `height=1920`, `pix_fmt="yuv420p"`, `nb_frames="90"`.
  - **Finding:** Always apply `force_original_aspect_ratio=increase,crop=2160:3840,setsar=1` before `zoompan` so `1:1` / non-`9:16` keyframes center-crop cleanly instead of stretching subjects.

### Test-First Evidence (R0 / R1)

- **LP-01 Contracts (`packages/contracts/src/providers.test.ts`):**
  - **Command**: `pnpm --filter @nolen/contracts build && pnpm --filter @nolen/contracts test`
  - **RED Evidence (before `LOCAL_PIPELINE` / `LOCAL_STORAGE` / `localVideoMetadataSchema`)**:
    `1 failed | 20 passed` (`Invalid enum value. Expected 'LIVE_PROVIDER' | 'REPLAY_FIXTURE', received 'LOCAL_PIPELINE'`)
  - **GREEN Evidence**: `5 passed (5)` files / `21 passed (21)` tests.
- **LP-02 Unit Renderer (`servers/src/providers/ffmpeg-pan-zoom.test.ts`):**
  - **Command**: `pnpm --filter @nolen/server test src/providers/providers.test.ts src/providers/ffmpeg-pan-zoom.test.ts`
  - **RED Evidence (before `ffmpeg-pan-zoom.ts`)**: `Cannot find module './ffmpeg-pan-zoom.js'`
  - **GREEN Evidence**: `2 passed (2)` files / `13 passed (13)` tests (`ffmpeg-pan-zoom.test.ts` 6/6, `providers.test.ts` 7/7).
- **Post-final-edit Verification Matrix (2026-11-26, branch `feature/local-pan-zoom`):**
  - `pnpm typecheck` (`@nolen/contracts`, `@nolen/server`, `@nolen/web`): **PASS**
  - `pnpm lint` (`--max-warnings 0`): **PASS**
  - `pnpm build`: **PASS**
  - `COMPOSE_PROJECT_NAME=lp001-ci node scripts/compose-smoke.mjs`: **PASS**
  - Container `docker run --rm nolen-fc001:local sh -c "env -u STORAGE_BASE_PATH NODE_ENV=test pnpm test"`: **PASS** (`@nolen/contracts`: 5/5 files, 21/21 tests; `@nolen/server`: 17/17 files, 81/81 tests including `test:media`)
  - Container `docker run --rm nolen-fc001:local sh -c "env -u STORAGE_BASE_PATH NODE_ENV=test pnpm --filter @nolen/server test:media"`: **PASS** (2/2 files, 5/5 tests: `media-validation.media.test.ts` 3/3 + `ffmpeg-pan-zoom.media.test.ts` 2/2)
  - Container PG16 `docker compose -p lp001-ci run --rm --no-deps ... pnpm --filter @nolen/server test:integration` (`ffmpeg 5.1.9-0+deb12u1`): **PASS** (`11/11` files, `101/101` tests, including `local-pan-zoom.integration.test.ts` 6/6, `worker.integration.test.ts`, `completion.integration.test.ts`, `assets.integration.test.ts`, `financial.integration.test.ts`)
  - Playwright E2E against `lp001-ci` (`local-pan-zoom.spec.ts` 1/1, `generation-inputs.spec.ts` 1/1, `shot-review.spec.ts` 5/5, `story.spec.ts` 4/4): **PASS** (11/11)
  - Playwright E2E `tests/e2e/film.spec.ts` against temporary host PG16: **PASS** (6/6)

## Handoff

Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
Branch: `feature/local-pan-zoom` (stacked on `feature/compose-shared-storage@cc5357d`).
`LP-001` (`LP-00`–`LP-03`) implemented and verified across unit, media, PG16 integration, and Playwright E2E; ready for PR/review and owner sign-off.
