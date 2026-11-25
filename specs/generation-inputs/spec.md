# GI-001 — Generation Input Contract, Exact Preview & Reference Library

Status: APPROVED
Source: [PRD v1.0](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md), [AGENTS.md](../../AGENTS.md)

## Goal

[DECIDED] Upgrade `IMAGE` and `VIDEO` generation inputs to versioned `GenerationRequestV2` while preserving v1 compatibility for historical outbox records and `TTS`/`ASSEMBLY` attempts. An authenticated Producer can author structured camera angles (`ShotSpec v2`), upload and bind rights-confirmed static reference images (`film_reference_assets`) to Story Bible v2 definitions, inspect an authoritative server-compiled `generation-previews` template, and admit media attempts bound to that exact `expectedPreviewHash` for deterministic Replay execution.

## Scope

- **REQUIRED (GI-001):**
  - **GI-00 (R1/R0 Gate):** Spec, tasks, and FFmpeg/FFprobe stdin verification inside the production Docker image (`nolen-fc001:local`).
  - **GI-01 (R1):** Versioned `ShotSpec v2` (`camera.angle`) and `StoryBible v2` (`referenceAssetIds`), mixed v1/v2 `storyContentSchema`, `canonicalStoryV2()`, explicit creation paths, `upgradeBibleToV2()`, and history-safe `shotDependency()` normalization under unchanged `RULESET = 'story-approval-2'`.
  - **GI-02 (R0):** `film_reference_assets` Drizzle schema + additive PostgreSQL 16 migration, `"references"` `AssetCategory`, `boundedMultipart()` stream limit + Web API `formData()`, FFprobe/FFmpeg stdin validation (static PNG/JPEG/WebP, 300–4096 px, ≤ 16,777,216 pixels, single frame, 10s timeout + kill), atomic same-directory hard-link blob publication, and authenticated media response with explicit `no-store` / `nosniff` / `inline` headers.
  - **GI-03 (R1/R0):** Pure server-side `compileGenerationTemplate()` (`IMAGE` ≤ 5,000 chars; `VIDEO` I2V ≤ 1,000 chars), `VIDEO + PER_SECOND` pricing-duration equality guard, `POST /api/films/:filmId/generation-previews`, `expectedPreviewHash` concurrency binding in `admitAttempt()`, and `GenerationRequestV2` / `v1` union compatibility.
  - **GI-04 (R1):** Storyboard UI for `camera.angle`, Reference Library upload/preview/binding, explicit Bible v1→v2 upgrade confirmation, authoritative preview display before Generate, verbatim retry identity with `expectedPreviewHash`, and migration of existing media admission callers.
  - **GI-05 (R0/R1):** Full quality gates (`pnpm test`, `test:integration`, `test:e2e`, `typecheck`, `lint`, `build`, `test:guardrails`, `check:evidence`, `test:evidence`, and `test:media` on both host/CI runner and production Docker container).
- **PREREQUISITE:**
  - `SP-001` (`G1_ACCEPTED`), `FI-001` (`G2_ACCEPTED`), `KF-001`, `PD-05a`, and `EP-05` merged on `main@b7dc8bc`.
  - Media test fixtures stored under `servers/` (never root `references/`, which is excluded by `.dockerignore`).
- **DEFER:**
  - Shared Compose `STORAGE_BASE_PATH=/app/storage` volume across `web` and `worker` (mandatory infra prerequisite immediately after GI-001, before Local FFmpeg pan/zoom and `PD-05b`).
  - Live AI providers (`PD-05b`), explainable model router (`T-024`/`T-025`), Live LLM structured planner (`T-009`), TTS/BGM/FFmpeg export (`EP-06`), and advanced cinematography rules (180° rule, lens, gaze).

### Behavioral and Architectural Models (Lightweight AMDD)

- **Risk Tiers ([ENG-DEC-002](../../docs/development/ENG-DEC-002.md)):**
  - **R0 (Critical):** `boundedMultipart()` stream cap, FFmpeg/FFprobe stdin validation, atomic same-filesystem blob publication, `POST /api/films/:filmId/generation-previews` vs `admitAttempt()` `expectedPreviewHash` concurrency guard, `VIDEO + PER_SECOND` `pricingUnits === durationSeconds`, `GenerationRequest` v1/v2 outbox compatibility, and `TTS`/`ASSEMBLY` v1 isolation.
  - **R1 (Important):** `ShotSpec v2` / `StoryBible v2` contracts, `shotDependency()` empty-ref normalization, `compileGenerationTemplate()` determinism, and Storyboard UI preview/angle/reference flows.
- **Concurrency & Transaction Sequence:**
  1. `POST /api/films/:filmId/generation-previews` runs read-only against active `APPROVED` `StoryRevision` + `ShotRevision`, resolves approved `START_FRAME` and `film_reference_assets`, validates `VIDEO + PER_SECOND` pricing units, freezes default Replay fixture if omitted, compiles `GenerationRequestTemplateV2`, and returns `previewHash = sha256(canonical(template))`.
  2. `POST /api/films/:filmId/attempts` with `kind` in `IMAGE | VIDEO` runs idempotent command-receipt lookup first; if new, locks `film_budget_accounts` then `films` (`FOR UPDATE OF f`), re-resolves all authoritative inputs, re-compiles template, checks `compiledHash === expectedPreviewHash` (else `409 GENERATION_PREVIEW_STALE` with full rollback), then binds `attemptId` + `requestFingerprint` and inserts `attempts`, ledger/state, and `dispatch_outbox`.
- **Contract / Schema Changes:**
  - `ShotSpec`: union of `shotSpecV1Schema` (`schemaVersion: '1'`) and `shotSpecV2Schema` (`schemaVersion: '2'`, `camera.angle`).
  - `StoryBible`: union of `bibleV1Schema` (`schemaVersion: '1'`) and `bibleV2Schema` (`schemaVersion: '2'`, `referenceAssetIds: UUID[]`).
  - `GenerationRequest`: union of `generationRequestV2Schema` (`schemaVersion: '2'`, `IMAGE | VIDEO` only) and unchanged `generationRequestV1Schema` (`TTS | ASSEMBLY` and legacy v1 media outbox rows).
  - DB migration `0007`: `film_reference_assets` table (`FK film_id ON DELETE RESTRICT`, `UNIQUE (film_id, sha256_hash)`), application-immutable (no UPDATE/DELETE endpoints, no new trigger prefix required).

## Invariants

- [DECIDED] **v2 Media Scope Boundary:** Only `IMAGE` and `VIDEO` emit `GenerationRequestV2` and require `expectedPreviewHash`. `TTS` and `ASSEMBLY` remain on `GenerationRequestV1`, require no `shotRevisionId` or `expectedPreviewHash`, and keep their controlled REPLAY unsupported `FAILED` CAS behavior.
- [DECIDED] **History-Preserving Story Versioning:** Historical v1 `StoryRevision` JSON parses without injecting v2 fields; `RULESET` remains `'story-approval-2'`. `shotDependency()` omits empty `referenceAssetIds: []` so `upgradeBibleToV2()` does not invalidate unrelated `ShotRevision` hashes. Selection badges (`shot_asset_selections`) never auto-copy to a successor `StoryRevision`.
- [DECIDED] **Authoritative Preview Binding & Pricing Equality:** UI never compiles prompts or resolves assets locally. For `VIDEO` with `PER_SECOND` rate card, `pricingUnits` must equal `ShotRevision.spec.durationSeconds` (`422 PRICING_UNITS_DURATION_MISMATCH`). Any change to revision, selection, reference asset, rate card, or fixture between preview and admission fails with `409 GENERATION_PREVIEW_STALE` before any financial write.
- [DECIDED] **Bounded Upload & Subprocess Media Containment:** `boundedMultipart()` enforces `10 MiB + 64 KiB` on the raw request stream before passing to Web API `formData()`, enforcing 1 file ≤ 10 MiB. Static PNG/JPEG/WebP (300–4096 px per side, ≤ 16,777,216 pixels, single frame) is verified via `ffprobe` + `ffmpeg` stdin (`-protocol_whitelist pipe`, `-threads 1`, `-max_alloc 268435456`, `-frames:v 2`, `-xerror`, 10s timeout + `SIGKILL`). Missing binary returns `503 MEDIA_TOOL_UNAVAILABLE`; timeout/unsafe/animated/corrupt returns `422`.
- [DECIDED] **Atomic Blob Publication & Direct Response Headers:** Reference blobs stage in `references/.tmp-<uuid>` (same directory), `fsync`, verify, and publish via atomic `link()` to `references/<sha256>.<ext>` without overwriting existing files (`REFERENCE_BLOB_CORRUPT` on hash mismatch). Direct `new Response(...)` on `/media` sets `Cache-Control: no-store`, `X-Content-Type-Options: nosniff`, and `Content-Disposition: inline`.
- [DECIDED] **No Truncation & Rate-Card Snapshot:** `compileGenerationTemplate()` rejects `IMAGE` > 5,000 chars or `VIDEO` > 1,000 chars with `422 COMPILED_PROMPT_TOO_LONG`. `loadRate()` remains an immutable snapshot read without `FOR UPDATE`.

## Acceptance criteria

- `GI-AT-01`: Historical v1 `StoryRevision` parses unchanged with identical `contentHash`, `shotDependency`, and approval evidence under `story-approval-2`.
- `GI-AT-02`: New v2 shots require a valid `camera.angle`; unknown angles are rejected with `422`.
- `GI-AT-03`: `upgradeBibleToV2()` and editing one shot only create new `ShotRevision`s for shots referencing modified definitions; unaffected shots keep `shotRevisionId`, while successor `StoryRevision` starts with empty `shot_asset_selections` until reselected.
- `GI-AT-04`: Valid static PNG/JPEG/WebP upload (≥ 300 px, ≤ 4096 px, ≤ 16.7 MP) publishes atomically to `references/<sha256>.<ext>`, passes DB round-trip, and serves via `/media` with `no-store`, `nosniff`, and `inline` headers.
- `GI-AT-05`: Spoofed MIME, oversized body (> 10 MiB + 64 KiB stream abort), animated WebP/APNG, corrupt tail, out-of-range dimensions, path traversal, cross-Film reference binding, unconfirmed rights, subprocess timeout, and unavailable binary fail closed with exact status/codes.
- `GI-AT-06`: Concurrent uploads of identical blob within a Film and across Films handle `link()` `EEXIST` safely; matching metadata returns existing record, conflicting metadata returns `409 REFERENCE_METADATA_CONFLICT`; corrupt existing target fails closed without overwrite/delete; crash before publish leaves no DB row/visible blob.
- `GI-AT-07`: `compileGenerationTemplate()` produces deterministic output (`IMAGE` ≤ 5,000 chars; `VIDEO` ≤ 1,000 chars from action/camera/transitions without repeating static `START_FRAME` prose), excludes unreferenced Bible entities, keeps `negativePrompt` separate, rejects overflow with `422 COMPILED_PROMPT_TOO_LONG`, and preserves `UNSPECIFIED` angle for v1 shots.
- `GI-AT-08`: `VIDEO + PER_SECOND` rejects `pricingUnits !== durationSeconds` (`422 PRICING_UNITS_DURATION_MISMATCH`) in both preview and admission.
- `GI-AT-09`: `previewHash` matches canonical admitted template; changing selection, revision, reference blob, rate card, or fixture between preview and admission returns `409 GENERATION_PREVIEW_STALE` with zero financial/outbox rows; retrying a committed request with the same `Idempotency-Key` replays the original receipt.
- `GI-AT-10`: `IMAGE`/`VIDEO` admit `GenerationRequestV2` (with `attemptId` included in `requestFingerprint`); `TTS`/`ASSEMBLY` still admit v1 without `expectedPreviewHash`; legacy persisted v1 media outbox payloads still verify fingerprint and complete in Replay; Replay executes zero network calls and zero financial charges.
- `GI-AT-11`: Playwright E2E verifies upload reference → bind to Bible (with v1→v2 confirmation) → pick camera angle → save & approve story → preview compiled template → generate Replay keyframe & video.
- `GI-AT-12`: `test:media` passes non-skipped on both the CI/host runner and inside the production Docker image (`docker compose exec -T web pnpm --filter @nolen/server test:media` under `NODE_ENV=production`).

## Open Questions / Blocked Contracts

- None for `GI-001`. Shared Compose storage (`STORAGE_BASE_PATH=/app/storage` across `web` and `worker`) is explicitly scheduled immediately after `GI-001` before Local FFmpeg pan/zoom and `PD-05b`.
