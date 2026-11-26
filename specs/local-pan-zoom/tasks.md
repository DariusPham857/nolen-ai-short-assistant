# LP-001 tasks

Status: BLOCKED (runtime verification PASS; LP-02 historical behavioral RED missing)
Source: [spec](spec.md)

## Tasks

| Task | Tier | Scope & Dependency | Goal / Deliverable | Verification / Acceptance | Status |
|---|---|---|---|---|---|
| LP-00 | R0/R1 | REQUIRED (Gate) | Run FFmpeg `libx264` + `zoompan` + `ffprobe` spike in `nolen-fc001:local`, draft spec & tasks for approval | `pnpm check:evidence` PASS; container spike PASS (`ffmpeg 5.1.9-0+deb12u1`) | DONE |
| LP-01 | R1 | REQUIRED | Contracts (`LOCAL_PIPELINE` provenance, `LOCAL_STORAGE` locator, `startFrameProvenance` lineage) & `LOCAL_VERIFIED` `$0.00` rate card | `@nolen/contracts` RED → GREEN (5 files / 21 tests PASS); `seed-rate-cards.ts` | DONE |
| LP-02 | R0 | REQUIRED | `ffmpeg-pan-zoom.ts` renderer, `ffprobe` verification, pre-render terminal check, `completeLocalPanZoomAttempt()`, handled failure cleanup/settlement vs crash recovery | Unit renderer 8/8 + container media 5/5 + PG16 local completion 6/6 PASS at `8a02e26`; historical behavioral RED was not recorded | BLOCKED (test-first evidence) |
| LP-03 | R0/R1 | REQUIRED | `admitAttempt()`/`resolveAuthoritativeMediaTemplate()` remote-LIVE block + `LOCAL_PAN_ZOOM` unlock, `worker/index.ts` `live:generation:dispatch`, `storyboard.tsx` + `video-review.tsx` LIVE rate-card filter & lineage badge | Full PG16 101/101 + Compose E2E 11/11 + host Film E2E 6/6 PASS at `8a02e26`; whole-feature workflow completion remains blocked by LP-02 | VERIFIED; pending sign-off |
| LP-04 | R2 | REQUIRED (review follow-up) | Reverify `8a02e26` on isolated PG16/Compose and host browser environments; separate historical evidence from current checks and record the RED gap without reconstruction | Current-head verification matrix and completion limitation below; documentation/evidence checks | DONE |
| LP-05 | R2 | REQUIRED (CI follow-up) | Give the two-render real-media test an explicit 15-second Vitest timeout; preserve assertions, renderer limits and other test timeouts | Docker full unit/media suite: contracts 21/21 + server 83/83; server typecheck/lint; evidence checks | DONE |

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
  - **Initial Failure (setup/import only, NOT behavioral RED)**: `Cannot find module './ffmpeg-pan-zoom.js'` (module did not exist yet; gap noted: no separate behavioral-assertion RED run was recorded before implementing `ffmpeg-pan-zoom.ts`).
  - **GREEN Evidence**: `2 passed (2)` files / `15 passed (15)` tests (`ffmpeg-pan-zoom.test.ts` 8/8 including atomic non-overwrite `fs.link`, `BEFORE_PUBLISH` crash, and `LIVE` `LocalPanZoomAdapter` contract/schema tests; `providers.test.ts` 7/7).
- **Historical implementation Verification Matrix (`abda84e`, 2026-11-26, branch `feature/local-pan-zoom`; not evidence for the later `8a02e26` fixes):**
  - `pnpm typecheck` (`@nolen/contracts`, `@nolen/server`, `@nolen/web`): **PASS**
  - `pnpm lint` (`--max-warnings 0`): **PASS**
  - `pnpm build`: **PASS**
  - `COMPOSE_PROJECT_NAME=lp001-ci node scripts/compose-smoke.mjs`: **PASS**
  - Container `docker run --rm nolen-fc001:local sh -c "env -u STORAGE_BASE_PATH NODE_ENV=test pnpm test"`: **PASS** (`@nolen/contracts`: 5/5 files, 21/21 tests; `@nolen/server`: 17/17 files, 81/81 tests including `test:media`)
  - Container `docker run --rm nolen-fc001:local sh -c "env -u STORAGE_BASE_PATH NODE_ENV=test pnpm --filter @nolen/server test:media"`: **PASS** (2/2 files, 5/5 tests: `media-validation.media.test.ts` 3/3 + `ffmpeg-pan-zoom.media.test.ts` 2/2)
  - Container PG16 `docker compose -p lp001-ci run --rm --no-deps ... pnpm --filter @nolen/server test:integration` (`ffmpeg 5.1.9-0+deb12u1`): **PASS** (`11/11` files, `101/101` tests, including `local-pan-zoom.integration.test.ts` 6/6, `worker.integration.test.ts`, `completion.integration.test.ts`, `assets.integration.test.ts`, `financial.integration.test.ts`)
  - Playwright E2E against `lp001-ci` (`local-pan-zoom.spec.ts` 1/1, `generation-inputs.spec.ts` 1/1, `shot-review.spec.ts` 5/5, `story.spec.ts` 4/4): **PASS** (11/11)
  - Playwright E2E `tests/e2e/film.spec.ts` against temporary host PG16: **PASS** (6/6)

### LP-04 current-head verification (2026-11-26)

[DECIDED] Scope: verify the review fixes at source commit `8a02e26f1440229f4c25ffb1d0e965f1b0852a93` and correct the handoff. No runtime, schema, dependency or test assertion changed in this follow-up. The test build used `nolen-fc001:local`, image `sha256:e82f6d99da5dbf313962583c236321a2582fd0e1011e90ac48307df9fc65a90a`, rebuilt from that source using `docker compose -p lp001-verify-8a02e26 up --build --detach --wait --wait-timeout 180`. All media inputs were fixtures/local files; no external provider was invoked.

| Check | Status | Exact command / environment and observed result |
|---|---|---|
| QG-CODE | PASS | Host `pnpm typecheck`, `pnpm lint`, `pnpm build`; production image also rebuilt successfully |
| QG-ARCH | PASS | `pnpm --filter @nolen/web test:boundary`: 2/2; `pnpm test:guardrails`: 4/4 |
| QG-DOMAIN / media | PASS | `docker run --rm nolen-fc001:local sh -c 'env -u STORAGE_BASE_PATH NODE_ENV=test pnpm test'`: contracts 21/21 (5 files), server 83/83 (17 files), including both real media suites (5 tests) |
| QG-INTEGRATION | PASS | After `docker compose -p lp001-verify-8a02e26 exec -T db psql -U nolen -d postgres -c 'CREATE DATABASE nolen_int'`, run `docker compose -p lp001-verify-8a02e26 run --rm --no-deps -e NODE_ENV=test -e DATABASE_URL=postgresql://nolen:nolen_dev@db:5432/nolen_int -e STORAGE_BASE_PATH=/tmp/lp001-verify-int-storage -e EXECUTION_MODE=REPLAY web pnpm --filter @nolen/server test:integration`: 11 files, 101/101 PASS on PostgreSQL 16 with real FFmpeg |
| Shared-storage smoke | PASS | `COMPOSE_PROJECT_NAME=lp001-verify-8a02e26 node scripts/compose-smoke.mjs` (test-only operator token): worker write / web read SHA-256 checks and restart persistence passed |
| Browser generation/review | PASS | `pnpm test:e2e tests/e2e/local-pan-zoom.spec.ts tests/e2e/generation-inputs.spec.ts tests/e2e/shot-review.spec.ts tests/e2e/story.spec.ts` against Compose localhost: 11/11 |
| Browser Film regression | PASS | After Compose teardown, host `pnpm db:migrate`, `pnpm db:seed`, then `pnpm test:e2e tests/e2e/film.spec.ts` against a separate `postgres:16-alpine` test container `lp001-verify-hostpg-8a02e26` (localhost port 59186, database `nolen_test`): 6/6; see teardown limitation below |
| QG-EVIDENCE | PASS | `pnpm test:evidence`: 4/4; `pnpm check:evidence`: 36 documents (structure and local file links only) |
| LP-02 historical behavioral RED | BLOCKED | No recorded assertion-failure run from before the renderer implementation. Import/module discovery failure is not behavioral RED; current passing tests do not establish earlier chronology |

- **Initial unit invocation:** passing `STORAGE_BASE_PATH=/tmp/lp001-verify-unit-storage` into Compose unit tests caused the default-environment test to fail (expected `./storage`). Reran in a disposable container with that variable unset, as required by the test contract: 21/21 + 83/83 PASS. No assertion was removed or weakened; the initial environment error is not RED evidence.
- **Windows Film teardown:** all six tests reported `ok`, but the test-owned Next process remained alive during Playwright web-server teardown. Verified its process identity/parent and stopped only that Next process; Playwright then exited 0 with `6 passed`. Assertions passed; unattended Windows teardown is not claimed verified.
- **Cleanup:** removed only this follow-up's Compose project/volumes and temporary host PostgreSQL container. Existing unrelated Docker services and the pre-existing untracked `QUICKSTART.md` / `scripts/quick_start.ps1` were preserved. Diagnostic logs remain locally under `%TEMP%/lp001-verify-*.log`.
- **Completion limitation:** [ENG-DEC-002](../../docs/development/ENG-DEC-002.md) and the [test-first completion guard](../../.agents/rules/risk-based-tdd-amdd.md) prohibit marking applicable R0/R1 work DONE without genuine RED evidence. LP-02 therefore remains BLOCKED despite current runtime PASS. No retrospective RED, owner acceptance, policy waiver or accepted debt is inferred from verification authorization. Resolving that historical process gap requires a separate explicit owner decision under the canonical workflow; this documentation follow-up does not alter that policy.

### LP-05 real-media CI timeout (2026-11-26)

- **Trigger:** owner supplied a CI failure for `ffmpeg-pan-zoom.media.test.ts` / `LP-AT-01`: the two-render test exceeded Vitest's default 5-second timeout at approximately 5.034 seconds (82 server tests passed, one failed). This is supplied CI evidence, not a locally reproduced behavioral RED.
- **Scope / risk:** REQUIRED, R2 test-harness timing only. `servers/src/providers/ffmpeg-pan-zoom.media.test.ts` now passes `15_000` to this single `it()` because it performs two real 1080p encodes. Output assertions, test discovery, renderer subprocess timeout/kill safeguards and other tests are unchanged. No historical LP-02 RED evidence is inferred from this fix.
- **Verification:** `docker run --rm --mount 'type=bind,source=D:\nolen-ai-short-assistant\servers\src\providers\ffmpeg-pan-zoom.media.test.ts,target=/app/servers/src/providers/ffmpeg-pan-zoom.media.test.ts,readonly' nolen-fc001:local sh -c 'env -u STORAGE_BASE_PATH NODE_ENV=test pnpm test'`: PASS, contracts 21/21 and server 83/83, including real media 5/5; `LP-AT-01` took 2.676 seconds locally while the full suite ran concurrently. The read-only mount ensures the modified test, rather than the older test baked into the image, was executed.
- **Checks:** `pnpm --filter @nolen/server typecheck`, `pnpm --filter @nolen/server lint`, `pnpm test:evidence`, `pnpm check:evidence` and `git diff --check`: PASS. Log: `%TEMP%/lp001-media-timeout-unit.log`.
- **Limits / next step:** no production behavior changed, so PG16/E2E were not repeated for this timeout-only follow-up. Local PASS does not claim a hosted CI result; assess the next workflow run separately. Revert the explicit test timeout to roll back this follow-up.

## Handoff

Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
Branch: `feature/local-pan-zoom` (stacked on `feature/compose-shared-storage@cc5357d`).
`LP-001` runtime at `8a02e26` is verified across unit, real media, full PG16 integration and 17 Playwright E2E tests. Review fixes for atomic publication and LIVE adapter outputs are covered by renderer/adapter regressions. LP-04 changes only this handoff and the specification status. LP-02 workflow completion remains BLOCKED by the historical behavioral RED gap; do not treat runtime PASS or PR review as feature completion/owner sign-off. Next dependency: resolve the recorded workflow decision before marking LP-001 DONE or advancing dependent milestone acceptance.
