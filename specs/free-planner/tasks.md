# FREE-PLAN-01 tasks

Status: VERIFIED_LIVE_SMOKE_PASS
Source: [spec](spec.md)

## Tasks

| Task | Tier | Scope & Dependency | Goal / Deliverable | Verification / Acceptance |
|---|---|---|---|---|
| FP-00 | R2 | REQUIRED | Create spec, tasks, AMDD sequence, roadmap link (`specs/README.md`); preserve `LP-02` gap note | `pnpm check:evidence` (`PASS`: 38 engineering documents) |
| FP-01 | R1 | REQUIRED (depends on FP-00) | `planProposalRequestSchema`, `storyProposalV2Schema`, `proposalToStoryContentV2`, `storyDraftEnvelopeSchema`, snapshot/re-read concurrency guard | Contracts suite `PASS`, 22/22; PG16 barrier `free-planner.integration.test.ts` `PASS` at `3d5ad01` (CI evidence below) |
| FP-02a | R0 | REQUIRED (depends on FP-00) | Billing attestation guard (`=== "true"`), pinned model guard, `pnpm planner:preflight` | `servers/src/stories/free-planner.test.ts` (`PASS`, 5/5) |
| FP-02b | R1 | REQUIRED (depends on FP-01, FP-02a) | Gemini native `fetch` adapter, 512 KiB stream cap, error mapping, pure validator findings | `servers/src/stories/free-planner.test.ts` (`PASS`, 5/5) |
| FP-03 | R1 | REQUIRED (depends on FP-01, FP-02b) | Storyboard `Generate story with Gemini` UI, versioned draft envelope, stale findings | `typecheck` & `lint` `PASS`; production browser suite `PASS`, 19/19, including `FP-AT-05` / `FP-AT-05b` at `3d5ad01` (CI evidence below) |
| FP-04 | R1 | REQUIRED (depends on FP-01..FP-03) | Quality gates, evidence checks, `pnpm planner:smoke` opt-in CLI + shared transport hardening (`redirect: 'error'`, 60s body-read deadline) | Automated `vitest` (`free-planner.test.ts`, `planner-smoke.test.ts`), `typecheck`, `lint`, `check:evidence` `PASS`; live `FP-AT-06` wire/schema `PASS` (`2026-11-26T15:08:45.482Z`, `billingModel: operator-attested`; proposal có 4 `ERROR` findings, chất lượng continuity chưa đạt) |

### Test-First Evidence (R0 / R1)
- **Test**: `packages/contracts/src/story.test.ts > validates planProposalRequestSchema defaults and strict storyProposalV2Schema boundaries (FP-AT-01)`
  - **Command**: `pnpm --filter @nolen/contracts build; pnpm --filter @nolen/contracts test`
  - **RED Evidence**: `Error: NOT_IMPLEMENTED` at `proposalToStoryContentV2` (`src/story.test.ts:123:21`) — failed on real execution before `storyProposalV2Schema` and `proposalToStoryContentV2` were implemented.
  - **GREEN Evidence**: `Test Files 5 passed (5) | Tests 22 passed (22)` after implementing strict `storyProposalV2Schema` and `proposalToStoryContentV2`.
- **Test**: `servers/src/stories/free-planner.test.ts > FP-02a billing guard and preflight (R0)` & `FP-02b Gemini transport and validation (R1)` (`FP-AT-02`, `FP-AT-03`)
  - **Command**: `pnpm --filter @nolen/server exec vitest run src/stories/free-planner.test.ts`
  - **RED Evidence**: `5 failed (5)`: `AssertionError: expected Error: NOT_IMPLEMENTED to be an instance of ApiFailure` (billing guard & error mapping) and `expected 'UNKNOWN' to be true` (preflight).
  - **GREEN Evidence**: `Test Files 2 passed (2) | Tests 14 passed (14)` (`domain.test.ts` + `free-planner.test.ts`) with `pnpm typecheck` and `pnpm lint` (`--max-warnings 0`) passing.
- **Test**: `servers/src/stories/free-planner.test.ts` (redirect/stream-timeout prerequisites) & `servers/src/stories/planner-smoke.test.ts` (`FP-AT-06`)
  - **Command**: `pnpm --filter @nolen/server exec vitest run src/stories/free-planner.test.ts src/stories/planner-smoke.test.ts`
  - **RED Evidence**: `8 failed (8)`: `expected undefined to be 'error'` (`redirect` on preflight GET and generation POST) and `Error: NOT_IMPLEMENTED` / `NOT_IMPLEMENTED` across all 6 smoke runner/parser/redaction tests.
  - **GREEN Evidence**: `Test Files 3 passed (3) | Tests 21 passed (21)` (`free-planner.test.ts` 6/6, `planner-smoke.test.ts` 6/6, `domain.test.ts` 9/9) + `pnpm --filter @nolen/server typecheck` & `lint` `PASS` + `pnpm planner:smoke` default `SKIPPED` (exit 0).

## Handoff
Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
- **Changed files**:
  - [packages/contracts/src/story.ts](../../packages/contracts/src/story.ts) (`planProposalRequestSchema`, `storyProposalV2Schema`, `proposalToStoryContentV2`, `proposalProvenanceSchema`, `findingSchema`, `planProposalResponseSchema`, `storyDraftEnvelopeSchema`, `parseStoryDraftEnvelope`)
  - [packages/contracts/src/story.test.ts](../../packages/contracts/src/story.test.ts) (`FP-AT-01`)
  - [servers/src/config/env.ts](../../servers/src/config/env.ts) (`GEMINI_NO_BILLING_ATTESTED`, `GEMINI_FREE_PLANNER_MODEL`)
  - [servers/src/stories/free-planner.ts](../../servers/src/stories/free-planner.ts) (`assertFreePlannerConfig`, `checkFreePlannerPreflight`, `generateGeminiStoryProposal`, `redirect: 'error'`, 60s body-read deadline)
  - [servers/src/stories/free-planner.test.ts](../../servers/src/stories/free-planner.test.ts) (`FP-AT-02`, `FP-AT-03`, transport hardening)
  - [servers/src/stories/planner-smoke.ts](../../servers/src/stories/planner-smoke.ts) (`parsePlannerSmokeArgs`, `runPlannerSmoke`)
  - [servers/src/stories/planner-smoke.test.ts](../../servers/src/stories/planner-smoke.test.ts) (`FP-AT-06` automated runner/redaction tests)
  - [servers/src/scripts/planner-smoke.ts](../../servers/src/scripts/planner-smoke.ts) (`pnpm planner:smoke` CLI)
  - [servers/src/stories/free-planner.integration.test.ts](../../servers/src/stories/free-planner.integration.test.ts) (`FP-AT-04`)
  - [servers/src/scripts/planner-preflight.ts](../../servers/src/scripts/planner-preflight.ts) + [servers/package.json](../../servers/package.json) + [package.json](../../package.json) (`pnpm planner:preflight`)
  - [servers/src/http/story-api.ts](../../servers/src/http/story-api.ts) (snapshot + token check + Gemini call + re-read snapshot `409`/`404`)
  - [clients/components/storyboard.tsx](../../clients/components/storyboard.tsx) (`Generate story with Gemini` button, versioned draft envelope, `LIVE_LLM` provenance & stale findings)
  - [tests/e2e/story.spec.ts](../../tests/e2e/story.spec.ts) (`FP-AT-05`)
- **Limits & Blockers**:
  - Fake transport tests (`free-planner.test.ts`) verify the wire contract only; live wire/schema compatibility is verified by `FP-AT-06` below. Billing tier remains **operator-attested** (not verified by API metadata or response).
  - Earlier local sandbox PG16/E2E access failures are superseded for commit `3d5ad01` by the CI evidence below; no local runtime success is claimed.
  - Historical `LP-02` behavioral RED gap in [local-pan-zoom/tasks.md](../local-pan-zoom/tasks.md) remains open and is not exempted by `FREE-PLAN-01`.

### Live Smoke Verification (`FP-AT-06`) — 2026-11-26
- **Command**: `pnpm planner:smoke -- --run-live --confirm-free-tier` (1 call, no retry)
- **Operator Attestation**: Operator confirmed Free Tier project setup in Google AI Studio and configured `servers/.env` prior to execution (`2026-11-26T15:08Z`); billing status remains `operator-attested`.
- **Verdict**: **Live wire/schema PASS; proposal có 4 ERROR, chất lượng continuity chưa đạt.** (`PASS` chỉ xác nhận API trả JSON đúng Story v2 schema và references hợp lệ, không xác nhận story đủ điều kiện continuity/approval; runner đã được bổ sung `findings: [{ code, path, severity, waivable }]` cho các lần chạy sau mà không gọi lại Gemini cho lần chạy này.)
- **Result**: `PASS` (exit 0)
  - `timestampUtc`: `2026-11-26T15:08:45.482Z`
  - `model`: `gemini-3.5-flash-lite`
  - `billingModel`: `operator-attested`
  - `preflightStatus`: `READY`
  - `generationRequestsStarted`: `1`
  - `durationMs`: `5914`
  - `scenesCount`: `1`, `shotsCount`: `3`, `findingsBySeverity`: `{ ERROR: 4, WARNING: 0 }`, `errorCode`: `null`

### Continuity Diagnostic & Prompt Alignment — 2026-11-27
- **Changes**:
  - Added offline continuity fixtures in [servers/src/stories/domain.test.ts](../../servers/src/stories/domain.test.ts) (case-only `pose`/`lighting` mismatch, exact `end->start` match, intentional `pose`/`lighting` transition via `intendedTransitions`, and `IDENTITY_LOCK`).
  - Updated `buildPlannerPrompt()` in [servers/src/stories/free-planner.ts](../../servers/src/stories/free-planner.ts) with explicit `IDENTITY_LOCK`, verbatim `end->start` continuity, `intendedTransitions`, and `30–60s` duration rules, plus prompt assertion test in [servers/src/stories/free-planner.test.ts](../../servers/src/stories/free-planner.test.ts).
- **Verification**: `vitest` (`domain.test.ts` 11/11, `free-planner.test.ts` 7/7, `planner-smoke.test.ts` 6/6) `PASS` (`24/24`), `typecheck` `PASS`, `lint` `PASS`, `check:evidence` `PASS`, `git diff --check` `PASS`.
- **Evidence Limits**:
  - Offline fixtures prove `validate()` can report `ERROR` solely due to case differences in `pose` and `lighting`.
  - The updated prompt adds rules that were previously under-specified, and unit tests prove those instructions are included in the outgoing request.
  - This does **not** prove the cause of the 4 `ERROR`s from the earlier live run (`2026-11-26T15:08:45.482Z`), because finding details were not persisted then.
- **Live Diagnostic Run on `cdeef09` (`2026-11-27`)**:
  - **Command**: `pnpm planner:smoke -- --run-live --confirm-free-tier` (1 call, no retry, operator-authorized)
  - **Result**: `PASS` (exit 0)
    - `timestampUtc`: `2026-11-27T04:04:59.589Z`
    - `model`: `gemini-3.5-flash-lite`
    - `billingModel`: `operator-attested`
    - `preflightStatus`: `READY`
    - `generationRequestsStarted`: `1`
    - `durationMs`: `6076`
    - `scenesCount`: `1`, `shotsCount`: `3`, `findingsBySeverity`: `{ ERROR: 0, WARNING: 0 }`, `findings`: `[]`, `errorCode`: `null`
  - **Note**: Single-run diagnostic `PASS` with `0` continuity findings under `cdeef09`; producer review and story approval gates remain mandatory before downstream generation.

### CI repair verification — 2026-11-26
- **Scope**: REQUIRED R2 test-fixture/locator repairs for `FP-AT-04`, `FP-AT-05` and `FP-AT-05b`; no production behavior or public interface change.
- **Changes**: `dbfcc00` uses a bare Film fixture for the mid-flight deletion barrier, preserving production financial FK/append-only guards. `3d5ad01` filters both E2E alert locators by the expected error message, excluding Next.js route announcements while retaining content assertions.
- **Failure evidence**: [previous PR job](https://github.com/DariusPham857/nolen-ai-short-assistant/actions/runs/45780709563/job/139775184200) passed PG16, then failed both E2E assertions because `getByRole('alert')` resolved to the application error and `__next-route-announcer__`. This is test-repair evidence, not behavioral TDD RED.
- **Verified commit**: `3d5ad01b37b23a166ab91eb09ddaa399e7050600`. Both [pull-request run](https://github.com/DariusPham857/nolen-ai-short-assistant/actions/runs/45781841183) and [push run](https://github.com/DariusPham857/nolen-ai-short-assistant/actions/runs/45781834616) completed successfully.
- **Actual PR film-job results**: build, lint, typecheck, guardrails, runtime boundary, evidence checks, migrations and seed `PASS`; contracts 22/22, server unit 88/88, real PostgreSQL 16 integration 102/102 (including the free-planner barrier), production Playwright 19/19 `PASS`. The Compose job also passed topology and production-image media validation.
- **Review**: Both changed locators retain role and expected message checks, matching the existing conflict-alert pattern. No assertion or financial constraint was removed.
- **Next dependency**: `FP-04` remains open for opt-in `FP-AT-06` live smoke implementation/execution. Browser transport stubs and CI success do not establish real Gemini connectivity, no-billing eligibility, owner sign-off, or release acceptance.
