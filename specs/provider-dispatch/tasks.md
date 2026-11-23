# PD-001 tasks

Status: DRAFT
Source: [spec](spec.md)

## Tasks

| Task | Tier | Scope & Dependency | Goal / Deliverable | Verification / Acceptance |
|---|---|---|---|---|
| PD-01 | R1 | REQUIRED | Zod provider contracts, dispatch schemas & adapter interface | PASS: 4/4 unit tests, typecheck clean, commit `2b419d5` |
| PD-02 | R1 | REQUIRED | Fake provider adapters (Gemini, Runway, fal.ai) & SSRF validator | PASS: 8/8 unit tests (ssrf + providers), PD-AT-07 RED/GREEN verified |
| PD-03 | R0 | REQUIRED | `outbound_dispatches` table & bounded outbox relay backoff | PASS: 3/3 relay unit tests (PD-AT-08), backoff + jitter verified, commit `90baee6` |
| PD-04 | R0 | REQUIRED | Worker crash recovery & submission uncertainty hold | PASS: 2/2 unit tests, dispatch lifecycle & uncertainty hold, commit `3f01bc5` |
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

## Handoff
Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
Record actual check statuses and remaining blockers, never anticipated results.
