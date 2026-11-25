# LP-001 tasks

Status: DRAFT_FOR_APPROVAL
Source: [spec](spec.md)

## Tasks

| Task | Tier | Scope & Dependency | Goal / Deliverable | Verification / Acceptance | Status |
|---|---|---|---|---|---|
| LP-00 | R0/R1 | REQUIRED (Gate) | Run FFmpeg `libx264` + `zoompan` + `ffprobe` spike in `nolen-fc001:local`, draft spec & tasks for approval | `pnpm check:evidence` PASS; container spike PASS (`ffmpeg 5.1.9-0+deb12u1`) | DONE (awaiting approval) |
| LP-01 | R1 | REQUIRED | Contracts (`LOCAL_PIPELINE` provenance, `LOCAL_STORAGE` locator, `startFrameProvenance` lineage) & `LOCAL_VERIFIED` `$0.00` rate card | `@nolen/contracts` RED → GREEN unit tests; `seed-rate-cards.ts` | PENDING |
| LP-02 | R0 | REQUIRED | `ffmpeg-pan-zoom.ts` renderer, `ffprobe` verification, pre-render terminal check, `completeLocalPanZoomAttempt()`, handled failure cleanup/settlement vs crash recovery | Container `test:media` + PG16 `local-pan-zoom.integration.test.ts` (`LP-AT-01`–`LP-AT-03`, `LP-AT-05`, `LP-AT-06`, `LP-AT-08`) | PENDING |
| LP-03 | R0/R1 | REQUIRED | `admitAttempt()` remote-LIVE block + `LOCAL_PAN_ZOOM` unlock, `worker/index.ts` `live:generation:dispatch`, `storyboard.tsx` LIVE rate-card filter & lineage badge | PG16 `worker.integration.test.ts` + Compose Playwright E2E (`LP-AT-04`, `LP-AT-07`) + full CI matrix | PENDING |

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
<!-- Recorded during LP-01..LP-03 implementation -->

## Handoff

Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
Branch: `feature/local-pan-zoom` (stacked on `feature/compose-shared-storage@cc5357d`).
`LP-00` spike passed and spec/tasks drafted; awaiting owner approval before implementing `LP-01`.
