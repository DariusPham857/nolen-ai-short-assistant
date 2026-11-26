# FREE-PLAN-01 — Gemini Free Planner Story Proposals

Status: IN_PROGRESS
Source: [PRD](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md) · [SP-001](../story-planning/spec.md)

## Goal
Allow producers to opt-in to generating a Story v2 proposal from a Film's saved `brief`, `targetDurationSeconds`, and `aspectRatio` using `gemini-3.5-flash-lite` (Free Tier attested), loading the validated proposal and pure continuity findings into the storyboard editor draft without creating any `StoryRevision`, `Attempt`, `CostLedgerEvent`, or queue job.

## Scope
- **REQUIRED (`FP-00`, R2):** Feature specification, task breakdown, sequence sketch, and acceptance mapping; preserve the existing `LP-02` behavioral RED gap note in [local-pan-zoom/tasks.md](../local-pan-zoom/tasks.md) without treating this feature as an exemption.
- **REQUIRED (`FP-01`, R1):** `planProposalRequestSchema` extending `expectedSchema` (strict), `storyProposalV2Schema` (strict v2-only, forbidding entity UUIDs, `expectedShotRevisionId`, `referenceAssetIds`, and `keyframeOverride`), snapshot/re-read concurrency guard (`409 VERSION_CONFLICT`, `404 FILM_NOT_FOUND`), and backward-compatible `FIXTURE` behavior.
- **REQUIRED (`FP-02a`, R0):** Server-only `GEMINI_API_KEY`, exact `"true"` match for `GEMINI_NO_BILLING_ATTESTED`, pinned `gemini-3.5-flash-lite` model guard, and `pnpm planner:preflight` CLI reporting credential validity, model availability, and `billingTierStatus: NO_BILLING_ATTESTED | UNKNOWN` without modifying `/api/health/ready` or `health:check`.
- **REQUIRED (`FP-02b`, R1):** Native `fetch` Gemini transport (fixed Google URL, `x-goog-api-key` header, 1 candidate, structured JSON, no tools/grounding/cache, 60s timeout, 16,384 max output tokens, 512 KiB stream byte limit before `JSON.parse`), injectable transport for contract tests, pure `referenceErrors` + `validate` findings, strict error mapping, and zero raw prompt/response/secret logging.
- **REQUIRED (`FP-03`, R1):** Storyboard UI `Generate story with Gemini` button (locked when `busy`, `dirty`, or non-editable), versioned `sessionStorage` draft envelope preserving `provenance` and `findings` across edits/reloads (marking findings stale on edit), stripping metadata before `saveStorySchema` submission, and clearing proposal metadata on saved revision load.
- **DEFER:** `PD-05b-CORE` paid media adapters, paid canary, automatic model retries/fallbacks, and `LP-02` remediation.

## Invariants
- All [SP-001](../story-planning/spec.md#invariants) and [ENG-DEC-002](../../docs/development/ENG-DEC-002.md) invariants remain canonical.
- Fixture mode remains the default (`mode` omitted → `FIXTURE`); Gemini planner is strictly opt-in and independent of media `EXECUTION_MODE` (`LIVE | REPLAY`).
- Proposal generation never creates `StoryRevision`, `Attempt`, `CostLedgerEvent`, or `pg-boss` jobs, and never auto-waives or auto-approves continuity findings.
- No automatic retries, model switching, or paid fallback on any failure.

### Behavioral and Architectural Models (Lightweight AMDD)

- **Concurrency & Transaction Sequence (`GEMINI_FREE_PLANNER`):**
  1. `authorize`: Authenticate `operator` and verify `filmId` ownership (`404 FILM_NOT_FOUND` if missing).
  2. `snapshot + check token`: Read consistent snapshot `(brief, targetDurationSeconds, aspectRatio, activeStoryRevisionId, stateVersion)` inside a read query; verify `expectedStoryRevisionId` and `expectedStateVersion` match (`409 VERSION_CONFLICT` on mismatch). Do **not** hold a DB transaction or row lock across the network call.
  3. `billing & model guard (R0)`: Verify `GEMINI_NO_BILLING_ATTESTED === 'true'` (`422 FREE_PLANNER_BILLING_UNATTESTED`), `GEMINI_API_KEY` present, and pinned model `gemini-3.5-flash-lite` (`503 FREE_PLANNER_UNAVAILABLE`).
  4. `Gemini`: Call fixed Google endpoint via `fetch` with 60s timeout and 512 KiB stream cap.
  5. `validate`: Parse JSON, validate `storyProposalV2Schema`, normalize to `StoryContent`, run `referenceErrors()` (`502 FREE_PLANNER_INVALID_OUTPUT` on failure) and pure `validate(content, targetDurationSeconds)` for `findings`.
  6. `re-read snapshot`: Re-query `films` + active `story_revisions` after Gemini returns; if `film` is gone → `404 FILM_NOT_FOUND`; if any of `(brief, targetDurationSeconds, aspectRatio, activeStoryRevisionId, stateVersion)` changed → `409 VERSION_CONFLICT`.
  7. `200`: Return `{ provenance: { source: 'LIVE_LLM', model: 'gemini-3.5-flash-lite', liveInference: true }, content, findings }`.

- **Error Mapping (`FP-02b`):**

| Condition | HTTP | Application Code |
|---|---|---|
| Missing/non-`"true"` `GEMINI_NO_BILLING_ATTESTED` | `422` | `FREE_PLANNER_BILLING_UNATTESTED` |
| Missing `GEMINI_API_KEY`, non-pinned model, or Google `401/403/404` | `503` | `FREE_PLANNER_UNAVAILABLE` |
| Google `429` | `429` | `FREE_PLANNER_RATE_LIMITED` |
| Request timeout (60s) | `504` | `FREE_PLANNER_TIMEOUT` |
| Network failure / Google `5xx` / other HTTP error | `502` | `FREE_PLANNER_UPSTREAM_FAILED` |
| Safety block (`promptFeedback.blockReason` / `SAFETY` finishReason) | `422` | `FREE_PLANNER_CONTENT_BLOCKED` |
| `MAX_TOKENS`, missing candidate, invalid JSON, schema/reference error, >512 KiB body | `502` | `FREE_PLANNER_INVALID_OUTPUT` |

## Acceptance criteria
- `FP-AT-01`: `planProposalRequestSchema` defaults `mode` to `FIXTURE`, rejects unknown fields, and `storyProposalV2Schema` rejects v1 shapes, entity UUIDs, `expectedShotRevisionId`, `referenceAssetIds`, and `keyframeOverride`.
- `FP-AT-02`: `GEMINI_FREE_PLANNER` rejects missing/non-`"true"` `GEMINI_NO_BILLING_ATTESTED` with `422 FREE_PLANNER_BILLING_UNATTESTED` and missing key / non-pinned model with `503 FREE_PLANNER_UNAVAILABLE` before any network call; `pnpm planner:preflight` reports credential, model, and `billingTierStatus` without printing secrets or affecting `/api/health/ready`.
- `FP-AT-03`: Fake transport tests verify exact request payload/headers (`x-goog-api-key`, 1 candidate, structured JSON, no tools/grounding/cache, 16,384 max tokens), all error mappings (`401/403/404`, `429`, timeout `504`, `5xx`, safety `422`, `MAX_TOKENS`/oversize >512 KiB/malformed `502`), and zero retries/fallbacks.
- `FP-AT-04`: Real PostgreSQL 16 barrier integration tests verify `409 VERSION_CONFLICT` when story revision, `brief`, `targetDurationSeconds`, or `aspectRatio` changes mid-flight, `404 FILM_NOT_FOUND` when film is deleted mid-flight, and zero writes to `story_revisions`, `attempts`, `cost_ledger_events`, or `pgboss`.
- `FP-AT-05`: Playwright E2E verifies default fixture, Gemini proposal loading into editor, error preserving existing draft, `LIVE_LLM` provenance & findings surviving reload, findings marked stale after edit, and saving revision without auto-approval.
- `FP-AT-06`: Opt-in live smoke test (1 call, no retry, redacted evidence) recorded if executed; otherwise explicitly documented as runtime integration unverified.

## Open Questions / Blocked Contracts
- `[VERIFY]` Live Free Tier eligibility on the operator's Google AI Studio project (`models.list` does not prove billing tier; verified only via opt-in smoke test `FP-AT-06`).
