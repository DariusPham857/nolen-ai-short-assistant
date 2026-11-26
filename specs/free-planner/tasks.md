# FREE-PLAN-01 tasks

Status: IMPLEMENTED_PENDING_SANDBOX_INTEGRATION_AND_LIVE_SMOKE
Source: [spec](spec.md)

## Tasks

| Task | Tier | Scope & Dependency | Goal / Deliverable | Verification / Acceptance |
|---|---|---|---|---|
| FP-00 | R2 | REQUIRED | Create spec, tasks, AMDD sequence, roadmap link (`specs/README.md`); preserve `LP-02` gap note | `pnpm check:evidence` (`PASS`: 38 engineering documents) |
| FP-01 | R1 | REQUIRED (depends on FP-00) | `planProposalRequestSchema`, `storyProposalV2Schema`, `proposalToStoryContentV2`, `storyDraftEnvelopeSchema`, snapshot/re-read concurrency guard | `packages/contracts/src/story.test.ts` (`PASS`, 22/22); PG16 barrier `free-planner.integration.test.ts` (`BLOCKED` in sandbox: `EACCES 127.0.0.1:5432`) |
| FP-02a | R0 | REQUIRED (depends on FP-00) | Billing attestation guard (`=== "true"`), pinned model guard, `pnpm planner:preflight` | `servers/src/stories/free-planner.test.ts` (`PASS`, 5/5) |
| FP-02b | R1 | REQUIRED (depends on FP-01, FP-02a) | Gemini native `fetch` adapter, 512 KiB stream cap, error mapping, pure validator findings | `servers/src/stories/free-planner.test.ts` (`PASS`, 5/5) |
| FP-03 | R1 | REQUIRED (depends on FP-01, FP-02b) | Storyboard `Generate story with Gemini` UI, versioned draft envelope, stale findings | `clients/components/storyboard.tsx` (`typecheck` & `lint` `PASS`); `tests/e2e/story.spec.ts` (`FP-AT-05` added, `BLOCKED` in sandbox without local server/DB) |
| FP-04 | R1 | REQUIRED (depends on FP-01..FP-03) | Quality gates, evidence checks, opt-in live smoke test | `typecheck` `PASS`, `lint` `PASS`, `check:evidence` `PASS`; `FP-AT-06` live smoke test `NOT_IMPLEMENTED` (runtime integration unverified) |

### Test-First Evidence (R0 / R1)
- **Test**: `packages/contracts/src/story.test.ts > validates planProposalRequestSchema defaults and strict storyProposalV2Schema boundaries (FP-AT-01)`
  - **Command**: `pnpm --filter @nolen/contracts build; pnpm --filter @nolen/contracts test`
  - **RED Evidence**: `Error: NOT_IMPLEMENTED` at `proposalToStoryContentV2` (`src/story.test.ts:123:21`) — failed on real execution before `storyProposalV2Schema` and `proposalToStoryContentV2` were implemented.
  - **GREEN Evidence**: `Test Files 5 passed (5) | Tests 22 passed (22)` after implementing strict `storyProposalV2Schema` and `proposalToStoryContentV2`.
- **Test**: `servers/src/stories/free-planner.test.ts > FP-02a billing guard and preflight (R0)` & `FP-02b Gemini transport and validation (R1)` (`FP-AT-02`, `FP-AT-03`)
  - **Command**: `pnpm --filter @nolen/server exec vitest run src/stories/free-planner.test.ts`
  - **RED Evidence**: `5 failed (5)`: `AssertionError: expected Error: NOT_IMPLEMENTED to be an instance of ApiFailure` (billing guard & error mapping) and `expected 'UNKNOWN' to be true` (preflight).
  - **GREEN Evidence**: `Test Files 2 passed (2) | Tests 14 passed (14)` (`domain.test.ts` + `free-planner.test.ts`) with `pnpm typecheck` and `pnpm lint` (`--max-warnings 0`) passing.

## Handoff
Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
- **Changed files**:
  - [packages/contracts/src/story.ts](../../packages/contracts/src/story.ts) (`planProposalRequestSchema`, `storyProposalV2Schema`, `proposalToStoryContentV2`, `proposalProvenanceSchema`, `findingSchema`, `planProposalResponseSchema`, `storyDraftEnvelopeSchema`, `parseStoryDraftEnvelope`)
  - [packages/contracts/src/story.test.ts](../../packages/contracts/src/story.test.ts) (`FP-AT-01`)
  - [servers/src/config/env.ts](../../servers/src/config/env.ts) (`GEMINI_NO_BILLING_ATTESTED`, `GEMINI_FREE_PLANNER_MODEL`)
  - [servers/src/stories/free-planner.ts](../../servers/src/stories/free-planner.ts) (`assertFreePlannerConfig`, `checkFreePlannerPreflight`, `generateGeminiStoryProposal`)
  - [servers/src/stories/free-planner.test.ts](../../servers/src/stories/free-planner.test.ts) (`FP-AT-02`, `FP-AT-03`)
  - [servers/src/stories/free-planner.integration.test.ts](../../servers/src/stories/free-planner.integration.test.ts) (`FP-AT-04`)
  - [servers/src/scripts/planner-preflight.ts](../../servers/src/scripts/planner-preflight.ts) + [servers/package.json](../../servers/package.json) + [package.json](../../package.json) (`pnpm planner:preflight`)
  - [servers/src/http/story-api.ts](../../servers/src/http/story-api.ts) (snapshot + token check + Gemini call + re-read snapshot `409`/`404`)
  - [clients/components/storyboard.tsx](../../clients/components/storyboard.tsx) (`Generate story with Gemini` button, versioned draft envelope, `LIVE_LLM` provenance & stale findings)
  - [tests/e2e/story.spec.ts](../../tests/e2e/story.spec.ts) (`FP-AT-05`)
- **Limits & Blockers**:
  - Fake transport tests (`free-planner.test.ts`) verify the wire contract only, not live Google API connectivity.
  - PG16 barrier test (`free-planner.integration.test.ts`) and Playwright E2E (`tests/e2e/story.spec.ts`) were blocked in the sandbox (`EACCES 127.0.0.1:5432`) and must be run against local PostgreSQL 16 + Next.js server outside the sandbox.
  - Opt-in live smoke test (`FP-AT-06`) was not executed: **runtime integration chưa xác minh**.
  - Historical `LP-02` behavioral RED gap in [local-pan-zoom/tasks.md](../local-pan-zoom/tasks.md) remains open and is not exempted by `FREE-PLAN-01`.
