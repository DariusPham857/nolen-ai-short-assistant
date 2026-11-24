# EP-05 — Shot Video Generation, Attempt History & Review Workstation (T-026, T-027)

Status: IN_PROGRESS
Source: [PRD v1.0 §19, §25, §29, §30.3](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md)

## Goal

[DECIDED] An authenticated Producer can generate video attempts for individual shots, inspect generation attempt history, enforce keyframe prerequisites deterministically across all image-driven video providers (Runway I2V, fal Kling I2V, Local Pan/Zoom), review 9:16 vertical video assets with append-only sign-offs (`APPROVED` or `REJECTED` with reason), switch the active video selection for timeline assembly, and safely retry failed or uncertain network attempts without duplicate financial charges.

## Scope

- **REQUIRED:**
  - `T-026` (IT1): Asset selection and shot attempt query APIs (`POST /api/films/:filmId/shots/:shotId/selections`, `GET /api/films/:filmId/shots/:shotId/attempts`).
  - `T-026` (IT1): Authenticated, strictly read-only rate card discovery (`GET /api/rate-cards`) with zero runtime mutations.
  - `T-027` (IT2): Three-pane workstation Storyboard integration with per-shot status badges (`KF✓`, `KF?`, `VID✓`, `VID?`).
  - `T-027` (IT2): Media generation controls with REPLAY/LIVE mode selection, provider choice (Runway, fal Kling, Local Pan/Zoom), and fail-closed exact rate-card lookup (no silent provider fallback).
  - `T-027` (IT2): Video provider keyframe gating: all current video paths are image-driven and require an approved keyframe prior to video generation.
  - `T-027` (IT2): Preserved retry identity: pending attempt keys and payloads are saved before dispatch to prevent double-charging on network dropouts.
  - `T-027` (IT2): `VideoReviewModal` with dedicated 9:16 vertical video viewport, attempt history, approve/reject controls, and active selection override.
- **PREREQUISITE:**
  - `KF-001` (EP-03): Keyframe approval gate and asset lifecycle.
  - `PD-05a` (EP-04): Provider replay worker runtime, idempotent asset completion, and fixture pack v1.
- **DEFER:**
  - Final timeline FFmpeg video assembly and export (deferred to EP-06 / T-028, T-029).
  - AI Usage Manifest and licensing audit report export (deferred to EP-07 / T-031, T-032).

## Invariants

- [DECIDED] **Fail-Closed Exact Provider Match**: Generation requests must locate the exact rate card corresponding to the producer-selected provider. Silent provider fallback is strictly prohibited.
- [DECIDED] **Provider Capability Gating**: All currently offered video routes (Runway Gen-4 Turbo I2V, fal.ai Kling v3 Pro I2V, and Local Pan/Zoom) require a source image. Video dispatch is deterministically blocked if no approved, revision-compatible keyframe exists, regardless of whether the shot narrative policy is classified as `REQUIRED` or `OPTIONAL`.
- [DECIDED] **Retry Identity Preservation**: Prior to submitting `POST /api/films/:filmId/attempts`, the idempotency key and exact payload must be persisted in tab storage. Network dropouts or uncertain responses must preserve this identity so subsequent attempts retry the identical key rather than creating duplicate financial reservations.
- [DECIDED] **Read-Only Rate Card Discovery**: `GET /api/rate-cards` is protected by `requireOperator(c)` and performs zero database writes. Rate cards are provisioned through verified database migrations/seeds with documented pricing provenance.
- [DECIDED] **Selection Exclusivity**: A shot revision may have at most one active selected asset per media kind (`IMAGE` or `VIDEO`). Reviewing an asset as `APPROVED` automatically sets it as active, while `selectShotAsset` allows manual switching among previously approved assets.

## Acceptance criteria

- `EP05-AT-01` (Exact Provider Lookup): Selecting Runway, fal Kling, or Local Pan/Zoom dispatches with that exact rate card; missing card fails closed without silent substitution.
- `EP05-AT-02` (Keyframe Prerequisite Gate): Attempting to generate video without an approved keyframe is blocked at the UI and API layer with explicit feedback.
- `EP05-AT-03` (Retry Identity Persistence): Aborted or dropped attempt requests retain their idempotency key in storage; the recovery banner offers "Retry same attempt" with the exact same key.
- `EP05-AT-04` (Read-Only Rate Card Route): `GET /api/rate-cards` returns 401 without operator authentication, and authenticated calls perform zero database writes.
- `EP05-AT-05` (Video Review & Selection): Reviewing a video asset as `APPROVED` updates its status to active selection; producers can inspect attempt history and toggle active selection among approved assets.

## Open Questions / Blocked Contracts

- None. EP-05 is designed to operate on top of PD-05a (Replay worker & idempotent completion). Real live provider API credential verification is tracked under EP-04 / PD-05b.
