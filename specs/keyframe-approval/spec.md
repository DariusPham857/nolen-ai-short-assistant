# KF-001 — Risk-Based Keyframe Approval Gate & Asset Lifecycle (EP-03)

Status: IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF
Source: [PRD v1.0 §19](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md)

## Goal

[DECIDED] An authenticated Producer can inspect generated image assets, perform append-only reviews
(`APPROVED` or `REJECTED` with reason), and select an active keyframe for a shot. Video generation
attempts (`kind: 'VIDEO'`) are deterministically gated: admission is rejected (`409 KEYFRAME_APPROVAL_REQUIRED`)
prior to budget reservation or outbox creation if the shot's effective policy is `REQUIRED` and no
approved, revision-compatible, verified keyframe asset is linked.

## Scope

- **REQUIRED:**
  - Relational schema and Drizzle migration for `assets`, `asset_reviews`, and `shot_asset_selections`.
  - Content-addressed storage publish protocol with SHA-256 integrity and OWASP path containment.
  - Deterministic latest-decision review semantics (`ORDER BY created_at DESC, id DESC`).
  - Video attempt admission gate under the global `films` row lock (`FOR UPDATE OF f`).
  - Safe API media locator (`/api/assets/:id/media`) without exposing internal filesystem paths.
  - Keyframe review & selection workstation UI.
  - Internal synthetic asset producer fixture seam for offline/integration testing.
- **PREREQUISITE:**
  - G1 Story Planning (`SP-001`) approved StoryRevisions and ShotSpecs.
  - G2 Financial Core (`FI-001`) atomic budget admission and lock ordering.
- **DEFER:**
  - Live API integration with Google Gemini, Runway Gen-4, or fal.ai (deferred to EP-04).
  - Automated model capability auto-routing (deferred to EP-04).
  - Production REPLAY execution daemon and separate ledger events (deferred to EP-04).
  - Final FFmpeg short film assembly (deferred to EP-06).

## Invariants

- [DECIDED] Composite ownership: every `Asset`, `AssetReview`, and `ShotAssetSelection` must belong
  to the same `film_id` as the active `Film`, and match the immutable `shot_revision_id`. Cross-film
  asset references are structurally prevented by composite foreign keys.
- [DECIDED] Global transaction lock hierarchy:
  `film_budget_accounts` -> `films` -> `attempt_financial_state` -> `assets / reviews / selections`.
  `reviewAsset` and `selectAsset` acquire a row lock on `films` (`SELECT id FROM films WHERE id = ... FOR UPDATE`)
  to prevent concurrency races with video attempt admission.
- [DECIDED] Reserve-before-dispatch: unapproved required keyframes block at the API admission layer
  before any money is reserved or queue intents created. Zero-cost rejection.
- [DECIDED] Content-addressed immutable media: files are published to `keyframes/<sha256>.<ext>`.
  On-disk SHA-256 checksum must match database records before approval or dispatch.
- [DECIDED] Review auditability: `asset_reviews` is an immutable, append-only journal. Reviews require
  a mandatory reason when `REJECTED`, an optional reason when `APPROVED`, and track `actor_id` and timestamp.
- [DECIDED] Deterministic latest-decision: active approval state evaluates `DISTINCT ON (r.asset_id) ... ORDER BY r.asset_id, r.created_at DESC, r.id DESC`.
- [DECIDED] Shot revision invalidation: editing an approved shot creates a new immutable `ShotRevision`,
  marking previously approved keyframes incompatible until revalidated or re-approved.

## Acceptance criteria

- `KF-AT-01`: Asset previously APPROVED, later REJECTED -> Latest decision semantics (`REJECTED`) strictly block `VIDEO` admission (status 409).
- `KF-AT-02`: Asset review/selection mutated concurrently with `VIDEO` admission -> Deterministic interleaving test (using `pg_blocking_pids`) proves admission cannot commit on superseded selection due to serialized `films` lock.
- `KF-AT-03`: Attempting review or selection using an asset belonging to another Film -> Rejected with 404/403; composite FK and WHERE clause prevent cross-film linkage.
- `KF-AT-04`: Asset file missing on disk or SHA-256 mismatch -> Review and video dispatch reject with `INTEGRITY_CHECK_FAILED`.
- `KF-AT-05`: Duplicate provider completion for the same attempt -> Idempotent materialization ensures exactly one canonical `assets` record (`UNIQUE(attempt_id)`).
- `KF-AT-06`: Shot edited after keyframe approval (new `ShotRevision`) -> Prior keyframe asset is marked incompatible; `VIDEO` admission blocked until re-reviewed or regenerated.
- `KF-AT-07`: Target video model does not support image reference inputs -> Gating blocks dispatch prior to paid attempt enqueue (`MODEL_CAPABILITY_MISMATCH`).
- `KF-AT-08`: Synthetic fixture asset passed without valid verified flag -> Strictly blocked by `a.verified = true` check unless verified storage integrity passes.
- `KF-AT-09`: Crash between disk write and DB commit -> Safe recovery leaves content-addressed file on disk without corrupting DB state.
- `KF-AT-10`: `VIDEO` admission fails due to unapproved keyframe -> Zero budget reservation, zero `cost_ledger_events`, zero `dispatch_outbox` entries created.

## Open Questions / Blocked Contracts

- None. G2 owner sign-off has been accepted on 2026-11-22. Real paid provider integrations and billing
  reconciliation are explicitly scoped to EP-04.
