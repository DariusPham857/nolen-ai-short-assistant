# Feature tasks

Status: DRAFT
Source: [spec](spec.md)

## Tasks
For each task: ID, Risk Tier (R0/R1/R2), REQUIRED/PREREQUISITE classification, goal, dependencies,
expected files/interfaces, exact verification command and acceptance mapping.
Keep tests with behavior; record blocked contracts before starting dependent work.

| Task | Tier | Scope & Dependency | Goal / Deliverable | Verification / Acceptance |
|---|---|---|---|---|
| XX-01 | R1 | REQUIRED | Contract & schema models | `pnpm check:evidence`, typecheck |
| XX-02 | R0 | REQUIRED | Core transactional logic & tests | Real PG16 integration test (XX-AT-01) |

### Test-First Evidence (R0 / R1)
<!-- For each R0/R1 behavioral change, record actual test execution evidence: -->
- **Test**: `path/to/test.ts > suite > test name` (`XX-AT-01`)
  - **Command**: `pnpm --filter @nolen/server test:integration`
  - **RED Evidence**: [Real assertion failure excerpt showing the absent behavior and why expected]
  - **GREEN Evidence**: [Pass result, elapsed time, commit/CI context]

## Handoff
Use the [canonical workflow](../../.agents/rules/plan-breakdown-handoff.md).
Record actual check statuses and remaining blockers, never anticipated results.
