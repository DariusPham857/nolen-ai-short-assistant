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
| PD-05 | R0 | REQUIRED | End-to-end generation dispatch & financial settlement | Full PG16 acceptance tests (PD-AT-01, PD-AT-02, PD-AT-09, PD-AT-10) |
| PD-06 | R1 | REQUIRED | Quality gates, evidence check & PR handoff | `pnpm -r lint`, `typecheck`, `test`, `test:guardrails`, `check:evidence` |

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

## Handoff
Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
Record actual check statuses and remaining blockers, never anticipated results.
