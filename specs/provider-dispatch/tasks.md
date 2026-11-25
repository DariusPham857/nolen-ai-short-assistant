# PD-001 tasks

Status: DRAFT
Source: [spec](spec.md)

## Tasks

| Task | Tier | Scope & Dependency | Goal / Deliverable | Verification / Acceptance |
|---|---|---|---|---|
| PD-01 | R1 | REQUIRED | Zod provider contracts, dispatch schemas, execution mode & provenance | PASS: 4/4 unit tests, typecheck clean, commit `2b419d5` |
| PD-02 | R1 | REQUIRED | Fake provider adapters (Gemini, Runway, fal.ai) with REPLAY provenance & SSRF containment | PASS: 10/10 unit tests (ssrf + providers), PD-AT-07 verified |
| PD-03 | R0 | REQUIRED | `outbound_dispatches` table & bounded outbox relay backoff | PASS: 3/3 relay unit tests (PD-AT-08), backoff + jitter verified |
| PD-04 | R0 | REQUIRED | Worker crash recovery, lock hierarchy & submission uncertainty hold | PASS: 3/3 unit tests, dispatch lifecycle & uncertainty hold |
| PD-05a.1 | R1 | REQUIRED | Spec correction, RED contracts & domain tests (mode, fixture, zero-cost, overage, shutdown) | RED contract & domain test suite |
| PD-05a.2 | R0 | REQUIRED | Mode-aware admission & additive DB migration (`attempts.execution_mode`, terminal states) | PG16 admission tests (zero reservation, overage tolerance, frozen snapshot) |
| PD-05a.3 | R1 | REQUIRED | Replay fixture pack v1 (manifest schema, sample vertical media, path containment via relative check, SHA-256) | PASS: 9/9 unit tests (fixtures.test.ts with binary and ffprobe codec checks) |
| PD-05a.4 | R0 | REQUIRED | Idempotent completion service (mode-prefixed queue routing, deadlock-free pre-flight kind check, durable Asset registration via `ON CONFLICT (attempt_id)`, strict provenance/fixture validation, alreadyCompleted invariant recovery, CAS terminal state protection, financial preconditions) | PASS: 11/11 PG16 integration tests (completion.integration.test.ts, PD-AT-01a, PD-AT-02a, crash recovery, CAS, queue routing, provenance, deadlock-free) |
| PD-05a.5 | R1 | REQUIRED | Worker runtime integration (replay:* queue consumers for IMAGE/VIDEO/TTS/ASSEMBLY, strict job identity, single InFlightTracker with rejection safety, immediate shutdown timeout covering runners, graceful shutdown) | PASS: 8/8 unit tests (shutdown.test.ts) + 3/3 PG16 integration tests (worker.integration.test.ts, 4-kind E2E, LIVE queue isolation, cold-start) |
| PD-05a.6 | R1 | REQUIRED | Review, evidence checks & PR handoff | PASS: `pnpm -r typecheck` (0 errors), 16/16 contracts unit, 55/55 server unit, 81/81 PG16 integration (100% GREEN) |
| PD-05b | R0 | DEFERRED | LIVE provider execution, remote download, and financial ledger settlement | Deferred to live provider credentials checkpoint (blocks final G3 signoff) |
| PD-06 | R1 | REQUIRED | Final milestone quality gates & handoff | `pnpm -r lint`, `typecheck`, `test`, `test:guardrails`, `check:evidence` |

### Test-First Evidence (R0 / R1)
<!-- For each R0/R1 behavioral change, record actual test execution evidence: -->
- **Test**: `PD-AT-08: Bounded Outbox Relay Backoff & Retry Ceiling`
  - **Command**: `pnpm --filter @nolen/server test src/financial/outbox.test.ts`
  - **RED Evidence**:
    ```
    FAIL src/financial/outbox.test.ts > Bounded Outbox Relay Backoff (G3-C / PD-AT-08) > calculates exponential backoff delay with ceiling
    TypeError: (0 , calculateBackoffDelay) is not a function
    FAIL src/financial/outbox.test.ts > Bounded Outbox Relay Backoff (G3-C / PD-AT-08) > enforces retry ceiling and transitions to exhausted
    TypeError: (0 , calculateBackoffDelay) is not a function
    ```
  - **GREEN Evidence**:
    ```
    ✓ src/financial/outbox.test.ts (3 tests) 4ms
    Test Files: 1 passed (1), Tests: 3 passed (3), Duration: 1.70s
    ```

- **Test**: `PD-AT-07: SSRF validator blocks private / loopback IP address ingestion`
  - **Command**: `pnpm --filter @nolen/server test src/lib/ssrf.test.ts`
  - **RED Evidence**:
    ```
    FAIL src/lib/ssrf.test.ts > SSRF Protection (PD-AT-07) > identifies private, loopback, and link-local IP addresses
    AssertionError: expected false to be true // Object.is equality
    FAIL src/lib/ssrf.test.ts > SSRF Protection (PD-AT-07) > rejects disallowed schemes and private loopback/metadata targets
    AssertionError: promise resolved instead of rejecting
    ```
  - **GREEN Evidence**:
    ```
    ✓ src/lib/ssrf.test.ts (3 tests) 72ms
    Test Files: 1 passed (1), Tests: 3 passed (3), Duration: 688ms
    ```

- **Test**: `PD-BLOCK-01 & 02: Lock hierarchy, pending liability hold, and stale SUBMITTING lease recovery`
  - **Command**: `pnpm --filter @nolen/server test:integration src/dispatch/dispatch.integration.test.ts`
  - **Verification**:
    - `markSubmissionUncertain` queries `film_id` from `attempts` (not from `attempt_financial_state`), locks `film_budget_accounts` then `attempt_financial_state`, and writes pending liability on both tables.
    - Stale `SUBMITTING` lease recovers cleanly as `SUBMISSION_UNCERTAIN` without secondary HTTP call.
    - `recoverStaleSubmissions` sweeps expired worker claims.

- **Test**: `PD-BLOCK-03: Provider execution mode separation and fail-closed LIVE guard`
  - **Command**: `pnpm --filter @nolen/server test src/providers/providers.test.ts src/dispatch/service.test.ts`
  - **Verification**:
    - `createProviderAdapter(kind, 'LIVE')` throws `LIVE_PROVIDER_UNAVAILABLE`.
    - Fake adapters output `provenance: 'REPLAY_FIXTURE'` and reject requests with `executionMode: 'LIVE'`.
    - `dispatchAttempt` throws `LIVE_EXECUTION_MODE_VIOLATION` if fake adapter is dispatched in LIVE mode.

- **Test**: `PD-BLOCK-04: Durable Outbox EXHAUSTED state, migration 0005, and manual recovery`
  - **Command**: `pnpm --filter @nolen/server test:integration src/db/migrate.integration.test.ts`
  - **Verification**:
    - Migration 0005 adds `EXHAUSTED` to check constraint and `exhausted_at`, `last_error` columns.
    - Outbox relay exhaustion transitions row to durable `EXHAUSTED` state and skips future leases.
    - `resetExhaustedOutbox` unfreezes row back to `PENDING` with `retry_count = 0`.

- **Test**: `PD-BLOCK-05: CAS state barrier on provider submit persist & sweeper interleaving`
  - **Command**: `pnpm --filter @nolen/server test:integration src/dispatch/dispatch.integration.test.ts`
  - **Verification**:
    - Worker persists `SUBMITTED` only via CAS matching `WHERE attempt_id = ... AND state = 'SUBMITTING' AND claim_token = ...`.
    - If sweeper expired lease and marked `SUBMISSION_UNCERTAIN` while HTTP was in flight, CAS safely fails and passes `providerJobId` directly to `reconcileUncertainDispatch`.
    - Reconciliation resets pending liability and synchronizes `attempts` and `outbound_dispatches` without state divergence.
    - Reverse race: Sweeper CAS ensures `recoverStaleSubmissions` and `markSubmissionUncertain` check `WHERE attempt_id = ... AND state = 'SUBMITTING' AND claim_token = ... AND claimed_at = ...`. If worker finishes and succeeds CAS first, sweeper CAS fails with `{ state: null, skipped: true }`, completely preventing revert to `SUBMISSION_UNCERTAIN` and avoiding spurious pending liability holds.

- **Test**: `PD-05a.1: RED contracts & Domain Invariants (Execution Mode, Fixture Freeze, Non-Reconcilable Replay, Overage Tolerance, Worker Drain)`
  - **Command 1 (Contracts)**: `pnpm --filter @nolen/contracts test`
  - **RED Evidence 1**:
    ```
    FAIL src/financial.test.ts > enforces execution mode and conditional fixture fields on createAttemptSchema (PD-05a.1)
    AssertionError: expected undefined to be 'REPLAY' // Object.is equality
    - Expected: "REPLAY"
    + Received: undefined

    FAIL src/providers.test.ts > Provider Dispatch Contracts (PD-01) > validates discriminated asset locator (REPLAY_FIXTURE vs REMOTE_URL) on ProviderStatusUpdate (PD-05a.1)
    ZodError: [
      {
        "code": "unrecognized_keys",
        "keys": ["locator"],
        "path": [],
        "message": "Unrecognized key(s) in object: 'locator'"
      }
    ]

    FAIL src/providers.test.ts > Provider Dispatch Contracts (PD-01) > validates GenerationRequest with frozen fixture identity and 64-char hex requestFingerprint (PD-05a.1)
    ZodError: [
      {
        "code": "unrecognized_keys",
        "keys": ["fixturePackVersion", "fixtureId", "requestFingerprint"],
        "path": [],
        "message": "Unrecognized key(s) in object: 'fixturePackVersion', 'fixtureId', 'requestFingerprint'"
      }
    ]
    Test Files  2 failed | 3 passed (5)
    Tests  3 failed | 13 passed (16)
    ```
  - **Command 2 (PD-AT-13: Default Fixture Resolution & Snapshot Freezing)**: `pnpm --filter @nolen/server test -- src/dispatch/service.test.ts`
  - **RED Evidence 2**:
    ```
    FAIL src/dispatch/service.test.ts > Dispatch Service Contracts & Outcomes (PD-04 / BLOCK 1-3) > PD-AT-13: resolves deterministic default fixture and freezes snapshot at admission
    AssertionError: expected '' to be 'v1' // Object.is equality
    - Expected: "v1"
    + Received: ""
    Test Files  1 failed (1)
    Tests  1 failed | 5 passed (6)
    ```
  - **Command 3 (PD-AT-14: Graceful Loop Shutdown & Drain with Fake Timers)**: `pnpm --filter @nolen/server test -- src/worker/shutdown.test.ts`
  - **RED Evidence 3**:
    ```
    FAIL src/worker/shutdown.test.ts > PD-AT-14: coordinates graceful worker shutdown by draining runners before stopping pg-boss
    AssertionError: expected "spy" to be called 1 times, but got 0 times
    Test Files  1 failed (1)
    Tests  1 failed | 2 passed (3)
    ```
  - **Command 4 (PD-AT-11, PD-AT-12a/b/c, PD-AT-13: PG16 Replay Overage Gate, Keyframe Gate, Outbox Payload Freeze & Non-Reconcilable Replay)**: `docker compose exec web pnpm --filter @nolen/server test:integration src/financial/financial.integration.test.ts`
  - **RED Evidence 4**:
    ```
    FAIL src/financial/financial.integration.test.ts > FI-001 PostgreSQL 16 financial core > PD-AT-12a: rejects REPLAY under genuine negative headroom when StoryRevision is unapproved
    AssertionError: expected 422 to be 409 // Object.is equality

    FAIL src/financial/financial.integration.test.ts > FI-001 PostgreSQL 16 financial core > PD-AT-12b: rejects REPLAY under genuine negative headroom when VIDEO attempt lacks approved keyframe
    AssertionError: expected 422 to be 409 // Object.is equality

    FAIL src/financial/financial.integration.test.ts > FI-001 PostgreSQL 16 financial core > PD-AT-12c: admits REPLAY under genuine negative headroom with zero reservation and zero ledger events
    AssertionError: expected 422 to be 201 // Object.is equality

    FAIL src/financial/financial.integration.test.ts > FI-001 PostgreSQL 16 financial core > PD-AT-13: freezes deterministic default fixture identity and 64-char sha256 request snapshot into dispatch_outbox.payload at admission
    AssertionError: expected 422 to be 201 // Object.is equality

    FAIL src/financial/financial.integration.test.ts > FI-001 PostgreSQL 16 financial core > PD-AT-11: strictly forbids reconcileAttempt on REPLAY attempts with 409 REPLAY_ATTEMPT_NON_RECONCILABLE
    AssertionError: expected 422 to be 201 // Object.is equality
    Test Files  1 failed (1)
    Tests  5 failed | 11 passed (16)
    ```
  - **Verification Targets (BLOCK 1, 2, 3 Addressed)**:
    - BLOCK 1: Every RED test runs through real production entry points and executes real assertions (no missing module/uncollected tests).
    - BLOCK 2: Integration test enforces that REPLAY under overage STILL fails closed with 409 on unapproved StoryRevision (`CURRENT_APPROVAL_REQUIRED`) or missing keyframe (`KEYFRAME_APPROVAL_REQUIRED`), while admitting valid attempts with 0 reservation.
    - BLOCK 3: Contract test enforces discriminated union coupling `provenance` and `locator`, and rejects cross-pairs (`REPLAY_FIXTURE` with `REMOTE_URL`, and `LIVE_PROVIDER` with `REPLAY_FIXTURE`).
  - **GREEN Evidence & Review Blocks Resolved (2026-11-24)**:
    - **BLOCK 1 (`executionMode` persistence on `attempts` & historical backfill)**: Added `execution_mode text NOT NULL DEFAULT 'REPLAY'` and check constraint to `attempts` via migration `0006_mode_and_terminal_states.sql` and `state-7.json`. Migration preserves financial semantics by backfilling historical attempts with `reservation_usd_micros > 0` or ledger events as `LIVE` (preventing reconciliation deadlock), while subsequent inserts default to `REPLAY`. Updated `reconcileAttempt` to query `a.execution_mode` directly from `attempts` and strictly reject REPLAY with `409 REPLAY_ATTEMPT_NON_RECONCILABLE`.
    - **BLOCK 2 (REPLAY forbids remote URLs & SSRF)**: Updated `providerStatusUpdateSchema` superRefine to strictly reject `mediaUrl` when `provenance === 'REPLAY_FIXTURE'` and require `locator` with `kind: 'REPLAY_FIXTURE'`. Updated `dispatchAttempt` to resolve local fixture directly without SSRF/network calls. Updated fake adapters (`FakeGeminiAdapter`, `FakeRunwayAdapter`, `FakeFalKlingAdapter`, `LocalPanZoomAdapter`) to omit `mediaUrl` and return deterministic fixture locators.
    - **BLOCK 3 (Authoritative provider mapping & prompt extraction)**: In `admitAttempt`, normalized supported provider names (`GEMINI`, `RUNWAY`, `FAL_KLING`, `LOCAL_PAN_ZOOM`) and fail closed with `422 UNSUPPORTED_PROVIDER` rather than silently defaulting to `LOCAL_PAN_ZOOM`. Extracted authoritative prompt from `shot_revisions.spec.prompt` (or `films.brief`), failing closed with `422 EMPTY_PROMPT` if empty.
    - **Financial Integrity BLOCK (Receipt REPLAY billingStatus FINAL consistency)**: Expanded `attemptReceiptSchema.billingStatus` to `z.enum(['PENDING', 'FINAL'])`. Updated `admitAttempt` to return `billingStatus: 'FINAL'` for REPLAY and `'PENDING'` for LIVE, ensuring API receipts are strictly consistent with persistent `attempt_financial_state.billing_status` in PostgreSQL.
    - **Execution Results**:
      - `pnpm -r typecheck`: PASS (0 errors across packages/contracts, servers, clients).
      - `pnpm --filter @nolen/contracts test`: 16/16 PASS.
      - `pnpm --filter @nolen/server test`: 44/44 PASS.
      - `docker compose exec web pnpm --filter @nolen/server test:integration`: 67/67 PASS across all 7 test files in real PostgreSQL 16 (including 17 financial tests and 10 migration tests).

## Handoff
Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
Record actual check statuses and remaining blockers, never anticipated results.

- **2026-11-24 PD-05a.1 Review Blocks Resolution & Green Evidence**:
  - `executionMode` persisted on `attempts` table with conservative historical `LIVE` backfill; migration upgrade verified.
  - REPLAY remote URL leakage prevented; fake adapters return local fixture locators.
  - Authoritative provider normalization and ShotRevision prompt extraction enforced.
  - Receipt `billingStatus` consistency enforced: REPLAY returns `FINAL`, LIVE returns `PENDING`.
  - All unit, typecheck, and PG16 integration tests green (67/67).

- **2026-11-24 PD-05a.3 – PD-05a.5 Replay Worker Slice Completion & Evidence**:
  - **PD-05a.3 (Fixture Pack v1 & Resolver)**:
    - 4 vertical 9:16 files (`images/default-gemini-image-9-16.png`, `videos/default-runway-video-9-16.mp4`, `videos/default-fal_kling-video-9-16.mp4`, `videos/default-local_pan_zoom-video-9-16.mp4`) with pre-computed SHA-256 and byte sizes in `manifest.json`.
    - Path containment resolver prevents directory traversal and symlink escapes via relative checks against canonical realpaths.
    - Verified via `pnpm --filter @nolen/server test src/fixtures/fixtures.test.ts`: 9/9 PASS (including binary header parsing and `ffprobe` codec validation).
  - **PD-05a.4 (Idempotent Asset Completion Service)**:
    - Mode-prefixed queue routing (`resolveOutboxQueue`) separates `replay:*` and `live:*` queues at admission.
    - Pre-flight kind inspection outside transaction eliminates nested transaction row-lock self-deadlock.
    - Durable Asset insertion with `ON CONFLICT (attempt_id) DO NOTHING` and strict provenance/fixture validation on recovered assets.
    - CAS terminal state preservation for unsupported kinds (preserves `CANCELED`, `FAILED`, `SUCCEEDED`).
    - Verified via `docker compose exec web pnpm --filter @nolen/server exec vitest run --config vitest.integration.config.ts src/dispatch/completion.integration.test.ts`: 11/11 PASS (PostgreSQL 16).
  - **PD-05a.5 (Worker Runtime Integration & Shutdown)**:
    - `InFlightTracker` with rejection safety: `void promise.catch(() => {}).finally(...)` prevents `unhandledRejection` while returning the original promise to callers.
    - `WorkerShutdownCoordinator`: Immediate 10s timeout timer started before drain; propagates `exitCode: 1` if drain hangs past timeout without severing active transactions.
    - Replay worker subscribes to `replay:generation:dispatch`, `replay:tts:dispatch`, and `replay:assembly:dispatch`.
    - Strict job identity assertion prevents queue/job identity bypass.
    - Verified via `pnpm --filter @nolen/server test src/worker/shutdown.test.ts` (8/8 PASS) and `docker compose exec web pnpm --filter @nolen/server exec vitest run --config vitest.integration.config.ts src/worker/worker.integration.test.ts`: 3/3 PASS (4-kind E2E, LIVE queue isolation, cold-start recovery).
  - **Full Monorepo Regression (Gate 4)**:
    - `pnpm -r typecheck`: PASS (0 errors across packages/contracts, servers, clients).
    - `pnpm -r lint`: PASS (0 warnings across all workspaces).
    - `pnpm --filter @nolen/contracts test`: 16/16 PASS.
    - `pnpm --filter @nolen/server test`: 57/57 PASS.
    - `docker compose exec web pnpm --filter @nolen/server test:integration`: 82/82 PASS across all 9 test suites in real PostgreSQL 16.

- **2026-11-24 PD-05a Review Blocks (BLOCK 1 & BLOCK 2) Resolution**:
  - **BLOCK 1 (Production LIVE Queues Initialized on Startup)**:
    - `startWorker` now initializes `ALL_PRODUCTION_QUEUES = [...REPLAY_QUEUES, ...LIVE_QUEUES]` on startup.
    - Prevents relay delivery failures and outbox `EXHAUSTED` state for LIVE intents.
    - Verified in `worker.integration.test.ts`: 3 LIVE attempts (`IMAGE`, `TTS`, `ASSEMBLY`) admitted and relayed successfully with `status = 'DELIVERED'`, `outcome = 'JOB_ID'` without any manual `boss.createQueue()` calls in tests.
  - **BLOCK 2 (`fixturePackVersion` Path Traversal Containment)**:
    - Defined `fixturePackVersionSchema` in contracts with strict regex `/^[a-z0-9][a-z0-9._-]{0,63}$/` and rejected path traversal tokens (`..`, `/`, `\\`).
    - Enforced in `createAttemptSchema`, `generationRequestSchema`, and `assetLocatorSchema`.
    - Resolver asserts `assertValidPackVersion()` and strictly checks `manifest.version === requestedPackVersion`.
    - Added unit test cases verifying rejection of traversal variants in contracts and resolver.
    - Added API integration test verifying `POST /api/films/:id/attempts` rejects traversal pack versions with `422 UNPROCESSABLE_ENTITY`.
  - **Verification Evidence**:
    - `pnpm -r typecheck`: 0 errors.
    - `pnpm -r lint`: 0 warnings, 0 errors.
    - `pnpm --filter @nolen/contracts test`: 16/16 PASS.
    - `pnpm --filter @nolen/server test`: 58/58 PASS.
    - `docker compose exec web pnpm --filter @nolen/server test:integration`: 83/83 PASS across all 9 test suites in PostgreSQL 16.

- **2026-11-24 PD-05a Queue Provisioning Fail-Closed BLOCK Resolution**:
  - **BLOCK 1 (Fail-Closed Queue Provisioning)**:
    - Removed `try/catch` around `await boss.createQueue(q)` in `servers/src/worker/index.ts`. `pg-boss.createQueue()` is idempotent (`ON CONFLICT DO NOTHING`), so any exception is a genuine failure (permission, connectivity).
    - If any queue creation fails, `startWorker()` rejects immediately: neither relay runner nor sweep runner is started, no workers are registered, and worker never advertises ready.
    - Added unit test in `servers/src/worker/shutdown.test.ts` asserting fail-closed rejection on `live:tts:dispatch` failure with zero runner starts.
    - Added integration test in `servers/src/worker/worker.integration.test.ts` asserting fail-closed behavior against PostgreSQL 16 runtime.
    - Verified all 83 integration tests pass across 9 test suites in Docker PostgreSQL 16.
