# LP-001 — Deterministic Local FFmpeg Pan/Zoom (`LIVE` + `LOCAL_PAN_ZOOM`)

Status: DRAFT_FOR_APPROVAL
Source: [PRD v1.0 §12, §17, §20](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md), [AGENTS.md](../../AGENTS.md), [CS-001](../compose-storage/spec.md), [PD-001](../provider-dispatch/spec.md)

## Goal

[DECIDED] Deliver deterministic `$0 phí API phát sinh` local `9:16` MP4 video synthesis for static/low-motion shots (`Cost Lever #2` in [AGENTS.md](../../AGENTS.md)) under `executionMode: 'LIVE'` with `provider: 'LOCAL_PAN_ZOOM'`, transforming a Producer-approved `START_FRAME` asset into a `1080x1920`, `30 fps`, `yuv420p`, `libx264` MP4 with zero audio streams while preserving terminal-state invariants, `$0` financial settlement, and full upstream `START_FRAME` provenance lineage.

## Scope

- **REQUIRED (`LP-00`..`LP-03`, broken into reviewable sub-tasks):**
  - **LP-00 (R0/R1 Gate — Complete):** Run FFmpeg/FFprobe `libx264` + `zoompan` spike inside `nolen-fc001:local` (`ffmpeg 5.1.9-0+deb12u1`) and freeze spec/tasks before coding.
  - **LP-01 (R1 — Contracts & Verified Local Rate Card):**
    - Keep `executionModeSchema` strictly `'LIVE' | 'REPLAY'` (`packages/contracts/src/financial.ts`).
    - Extend `provenanceSchema` with `'LOCAL_PIPELINE'` (`LIVE_PROVIDER | REPLAY_FIXTURE | LOCAL_PIPELINE`) and `assetLocatorSchema` with `LOCAL_STORAGE` (`{ kind: 'LOCAL_STORAGE', category: 'videos', filename, sha256 }`) in `packages/contracts/src/providers.ts`.
    - Add explicit `START_FRAME` lineage schema/metadata fields (`startFrameAssetId`, `startFrameSha256`, `startFrameProvenance: 'REPLAY_FIXTURE' | 'LIVE_PROVIDER'`) propagated into generated video `Asset.metadata`.
    - Provision verified `$0.00` `LOCAL_VERIFIED` local rate card (`source_ref: 'LOCAL_VERIFIED (DEC-P03 FFmpeg deterministic pan/zoom, $0.00 API fee)'`) in `seed-rate-cards.ts`.
  - **LP-02 (R0 — FFmpeg Runner & Atomic Completion Service):**
    - Implement `servers/src/providers/ffmpeg-pan-zoom.ts`: reads `START_FRAME` strictly via `StorageAdapter`, verifies SHA-256 against DB/request before spawning FFmpeg, applies crop-safe `scale=2160:3840:force_original_aspect_ratio=increase:flags=bicubic,crop=2160:3840,setsar=1,zoompan=...,format=yuv420p` (`-c:v libx264 -preset fast -crf 20 -pix_fmt yuv420p -movflags +faststart -an`), enforces bounded timeout + `SIGKILL`, validates output MP4 with `ffprobe` (`1080x1920`, `h264`, `yuv420p`, exact frame/duration match, 0 audio streams), and writes `videos/<sha256>.mp4` via `StorageAdapter`.
    - Implement `completeLocalPanZoomAttempt()` mirroring [completion.ts](../provider-dispatch/spec.md) invariants: terminal `FAILED`/`CANCELED` state preservation on duplicate delivery, `ON CONFLICT (attempt_id) DO NOTHING` **plus** strict existing `Asset` hash/path/provenance/`startFrameSha256` verification, `$0` financial settlement (`PENDING → FINAL`, `0` micros), and CAS updates on `attempts`, `outbound_dispatches`, `dispatch_outbox`.
  - **LP-03 (R0/R1 — Worker Routing, Admission Guard & UI Lineage):**
    - Update `admitAttempt()` in `servers/src/financial/repository.ts` so `LIVE` admission of remote providers (`GEMINI`, `RUNWAY`, `FAL_KLING`) remains explicitly rejected (`422 LIVE_PROVIDER_UNAVAILABLE`) before `PD-05b`, while `LIVE` `LOCAL_PAN_ZOOM` admits against the `LOCAL_VERIFIED` rate card.
    - Register `boss.work('live:generation:dispatch', ...)` in `servers/src/worker/index.ts` dispatching `LOCAL_PAN_ZOOM` via `completeLocalPanZoomAttempt()` (and rejecting/failing unimplemented remote `LIVE` providers until `PD-05b`).
    - Update `clients/components/storyboard.tsx` rate-card lookup to pick non-`MODELED_ONLY` cards in `LIVE` mode and surface both `LOCAL_PIPELINE` provenance and upstream `startFrameProvenance` (`REPLAY_FIXTURE` vs `LIVE_PROVIDER`) in Storyboard / `VideoReviewModal`.
- **PREREQUISITE:**
  - `GI-001` (`generation-inputs`) and `CS-001` (`compose-storage`: shared `/app/storage` volume between `web` and `worker`).
- **DEFER:**
  - Remote paid `LIVE` adapters (`GEMINI`, `RUNWAY`, `FAL_KLING`) and `PD-05b-CORE`.
  - Free-tier LLM planner (`FREE-PLAN-01`).
  - Promoting `film_reference_assets` directly to `START_FRAME` without generated keyframe approval (would require a separate contract change).
  - Multi-shot timeline concatenation, VO/BGM mixing, and subtitle burn (`EP-06`).

### Behavioral and Architectural Models (Lightweight AMDD)

- **Risk Tiers ([ENG-DEC-002](../../docs/development/ENG-DEC-002.md)):**
  - **R0 (Critical):** `START_FRAME` on-disk SHA-256 verification before render, FFmpeg subprocess timeout + `SIGKILL`, `ffprobe` MP4 output validation, duplicate `pg-boss` terminal state preservation (`FAILED`/`CANCELED`), existing `Asset` mismatch fail-closed check, `$0` `PENDING → FINAL` financial transition, and `LIVE` fail-closed barrier for unimplemented remote providers.
  - **R1 (Important):** `provenanceSchema` / `assetLocatorSchema` extension, upstream `startFrameProvenance` metadata propagation, `LOCAL_VERIFIED` rate-card snapshot, and UI lineage display.
- **Keyframe Source & Lineage:**
  - `LP-001` does **not** bypass `GI-001` / `KF-001` keyframe gating: `START_FRAME` MUST be a Producer-approved, `ShotRevision`-compatible `IMAGE` `Asset` (`source: 'GENERATED_ASSET'`) selected in `shot_asset_selections` (in `$0 phí API phát sinh` mode, generated via `REPLAY` `REPLAY_FIXTURE`).
  - Output `Asset.metadata` records `{ provenance: 'LOCAL_PIPELINE', executionMode: 'LIVE', provider: 'LOCAL_PAN_ZOOM', cameraMovement, durationSeconds, startFrameAssetId, startFrameSha256, startFrameProvenance }` so exports and reviewers always see whether the start image was a fixture or live asset.
- **Financial & Completion Sequence (`$0` `LIVE`):**
  1. `admitAttempt()` (`executionMode: 'LIVE'`, `provider: 'LOCAL_PAN_ZOOM'`, `LOCAL_VERIFIED` card `0` micros) writes `attempts(execution_mode='LIVE', reservation_usd_micros='0')`, `attempt_financial_state(billing_status='PENDING', reservation_open='0')`, `cost_ledger_events(RESERVATION_CREATED, '0', 'PENDING')`, and `dispatch_outbox(queue='live:generation:dispatch')`.
  2. **Pre-media Terminal & Identity Guard:** Worker validates outbox request fingerprint, `attemptId`/`filmId`, `attempts.execution_mode === 'LIVE'`, and `provider === 'LOCAL_PAN_ZOOM'`. Before reading `START_FRAME` or invoking `ffmpeg`, worker checks `attempts.state`: if already `'FAILED'` or `'CANCELED'`, it immediately confirms `dispatch_outbox` (`DELIVERED`, `WORKER_CONFIRMED`) and returns `{ alreadyTerminal: true }` without touching disk media or FFmpeg.
  3. **Media Render & Verification:** Reads `START_FRAME` via `StorageAdapter`, verifies on-disk SHA-256 against DB/request, runs deterministic FFmpeg pan/zoom in a scoped temp file (`temp/`), enforces timeout + `SIGKILL`, validates output MP4 via `ffprobe` (`1080x1920`, `h264`, `yuv420p`, `0` audio streams, exact duration/frames), writes `videos/<sha256>.mp4` via `StorageAdapter`, and removes any temp render file.
  4. **Atomic Completion (Happy Path + Race Guard):** Inside transaction (`attempts FOR UPDATE` → `attempt_financial_state FOR UPDATE`): re-verify `attempts.state` against concurrent terminal transitions (`FAILED`/`CANCELED` → preserve terminal state & ACK outbox without writing `Asset`); if `SUCCEEDED`, verify existing `Asset` hash/path/lineage; else insert `Asset` (`ON CONFLICT (attempt_id) DO NOTHING`), verify inserted/conflicting row, append `RESERVATION_RELEASED` (`0` micros, `FINAL`, `evidence: { reason: 'LOCAL_PIPELINE_ZERO_API_FEE' }`), settle `attempt_financial_state` to `FINAL/0/0/0`, and CAS-update `attempts` (`SUCCEEDED`), `outbound_dispatches` (`SUCCEEDED`), `dispatch_outbox` (`WORKER_CONFIRMED`).
  5. **Handled Local Failure Path vs Unhandled Crash:**
     - **Handled failure** (`START_FRAME` missing/hash mismatch, FFmpeg non-zero exit or timeout+`SIGKILL`, `ffprobe` invalid/incompatible output): clean up any temp render file immediately; insert zero `Asset` rows; inside transaction (`attempts FOR UPDATE` → `attempt_financial_state FOR UPDATE`), if already terminal (`FAILED`/`CANCELED`/`SUCCEEDED`) due to race, preserve existing state and ACK outbox; else CAS-transition `attempts` (`QUEUED | RUNNING → FAILED`), `outbound_dispatches` (`→ FAILED`), append `RESERVATION_RELEASED` (`0` micros, `FINAL`, `evidence: { reason: 'LOCAL_PIPELINE_FAILED', code }`), settle `attempt_financial_state` (`PENDING → FINAL`, `0/0/0`), and confirm `dispatch_outbox` (`DELIVERED`, `WORKER_CONFIRMED`) so deterministic failures do not poison-loop `pg-boss`.
     - **Unhandled process crash** (`LP-AT-02`):
       - **Before DB commit** (`AFTER_DISK_WRITE`): DB rolls back (`dispatch_outbox` unconfirmed, `attempts` non-terminal); `pg-boss` redelivery executes full recovery idempotently.
       - **After DB commit before `pg-boss` job ACK** (`AFTER_DB_COMMIT_BEFORE_ACK`): DB transaction has already committed (`dispatch_outbox = WORKER_CONFIRMED`, `attempts = SUCCEEDED`, `Asset` & `$0` settlement persisted); `pg-boss` redelivery verifies the saved result/Asset without creating any duplicate `Asset` or ledger event.

## Invariants

- [DECIDED] **Mode Boundary Preserved:** `executionMode` remains strictly `'LIVE' | 'REPLAY'`; local FFmpeg renders use `LIVE` with `LOCAL_PAN_ZOOM` and `LOCAL_PIPELINE` provenance, while `REPLAY` stays strictly `REPLAY_FIXTURE`.
- [DECIDED] **Pre-Render Terminal Safety & Conflict Integrity:** Duplicate deliveries for `FAILED` or `CANCELED` terminate and ACK outbox **before** any media read or FFmpeg spawn (even when `START_FRAME` is missing), re-checking terminal status inside `FOR UPDATE`; `ON CONFLICT (attempt_id)` conflicts always verify stored `sha256_hash`, `storage_path`, `byte_size`, `provenance`, and `startFrameSha256`.
- [DECIDED] **Handled Failure Settlement:** Timeout, FFmpeg error, `ffprobe` validation failure, and missing/corrupt `START_FRAME` clean up temp outputs, create zero `Asset` rows, finalize `$0` financial state (`FINAL/0/0/0`), mark `FAILED`, and ACK outbox cleanly without overwriting concurrent terminal states.
- [DECIDED] **Transparent Keyframe Lineage:** Every `LOCAL_PIPELINE` video asset records and exposes `startFrameProvenance` so Replay keyframes are never misrepresented as live provider media.
- [DECIDED] **Remote Providers Fail Closed:** Until `PD-05b-CORE` lands, `LIVE` admission of `GEMINI`, `RUNWAY`, and `FAL_KLING` rejects with `422 LIVE_PROVIDER_UNAVAILABLE`.

## Acceptance criteria

- `LP-AT-01`: `LIVE` `LOCAL_PAN_ZOOM` attempt from an approved `REPLAY` `START_FRAME` renders a real `1080x1920`, `h264`, `yuv420p`, `0`-audio-stream MP4 matching `ShotRevision.spec.durationSeconds`, registered with `LOCAL_PIPELINE` + `startFrameProvenance: 'REPLAY_FIXTURE'` and `$0` settled financial state (`FINAL / 0 / 0 / 0`).
- `LP-AT-02`: Simulated unhandled crash recovers cleanly on duplicate `pg-boss` delivery without duplicating `Asset` rows or ledger events:
  - `AFTER_DISK_WRITE` (before DB commit): rolls back, redelivery completes recovery.
  - `AFTER_DB_COMMIT_BEFORE_ACK` (after DB commit, before `pg-boss` ACK): redelivery verifies saved `Asset`/lineage idempotently without duplicate writes.
- `LP-AT-03`: Corrupted or missing `START_FRAME` file on disk is a handled failure before invoking `ffmpeg`: zero `Asset` rows, `attempts = FAILED`, `$0` settled (`FINAL/0/0/0`), outbox `WORKER_CONFIRMED`.
- `LP-AT-04`: `LIVE` admission of `GEMINI`, `RUNWAY`, or `FAL_KLING` rejects with `422 LIVE_PROVIDER_UNAVAILABLE` until `PD-05b-CORE`.
- `LP-AT-05`: Duplicate delivery arriving after attempt is already `FAILED` or `CANCELED` (including when `START_FRAME` is missing/deleted on disk) preserves terminal state, never reads media or spawns `ffmpeg`, and ACKs outbox (`alreadyTerminal: true`).
- `LP-AT-06`: Existing `Asset` row on `attempt_id` conflict whose `sha256_hash`, `storage_path`, `provenance`, or `startFrameSha256` disagrees with the deterministic render fails closed (`CORRUPT_ASSET_HASH_MISMATCH` / `ASSET_METADATA_MISMATCH`), never returning `SUCCEEDED`.
- `LP-AT-07`: Real FFmpeg `test:media` and Compose E2E pass inside Docker (`nolen-fc001:local` sharing `/app/storage`), displaying `LOCAL_PIPELINE` + `Start frame: REPLAY_FIXTURE` lineage and `$0.00` spent in UI.
- `LP-AT-08`: FFmpeg timeout (`SIGKILL` + temp file cleanup) and invalid/wrong-duration `ffprobe` MP4 output settle cleanly as handled failures (`attempts = FAILED`, zero `Asset`, `$0` `FINAL/0/0/0`, outbox `WORKER_CONFIRMED`, terminal race state preserved).

## Open Questions / Blocked Contracts

- Pending owner approval of `LP-00` spec/tasks before starting `LP-01` implementation.
