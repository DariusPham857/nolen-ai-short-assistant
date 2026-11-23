# Risk-Based TDD & Lightweight AMDD — Agent Execution Rule

**Status:** PROPOSED — effective only when owner approves [ENG-DEC-002](../../docs/development/ENG-DEC-002.md).  
**Authority:** [ENG-DEC-002](../../docs/development/ENG-DEC-002.md) defines risk tiers and obligations; [SDD-Lite plan/handoff](plan-breakdown-handoff.md) remains the canonical implementation workflow; [exceptions/review](engineering-exceptions.md) remains canonical for BLOCK/CONTAIN decisions.

## Before writing code

1. Read the approved feature spec, applicable FR/DEC/AT, callers, interfaces and tests. Identify real behavior changes and classify their engineering risk **R0 / R1 / R2** using ENG-DEC-002 (not PRD feature priorities P0/P1/P2).
2. Mark scope REQUIRED / evidenced PREREQUISITE / OPPORTUNISTIC / UNRELATED in the approved task plan. Do not begin implementation merely because this rule exists.
3. In `specs/<feature>/spec.md`, record only relevant models: state transitions; transaction, lease and remote-side-effect boundaries; contract changes; error paths and explicit prohibited transitions. Reuse the product PRD for invariants instead of restating them.
4. Map each observable acceptance case to a test identifier. For provider, money or concurrency changes, include negative and crash/interleaving cases before implementation.

## The R0 / R1 development loop

**RED** — First add a focused behavioral test that fails for the intended missing rule or bug. Execute it and inspect the failure. Record in the feature's existing `tasks.md`: `test identifier | FR/DEC/AT | command/environment | actual assertion-failure excerpt | reason`. Compilation failure, unavailable PostgreSQL, flaky timeout, invalid fixture or missing secret does **not** count as valid RED. Do not manufacture logs or retrospective RED evidence.

**GREEN** — Make the smallest contract-compliant code change. Run the focused test and relevant negative cases; never suppress a failing test or weaken an assertion just to pass.

**REFACTOR** — Simplify without altering behavior, then rerun affected tests. Execute the required project quality gates at the documented scope, with real PostgreSQL 16 for financial/transactional claims and Playwright for user-visible workflows when applicable.

**HANDOFF** — Record changed files/public interfaces, FR/DEC/AT links, commands, actual results, environment/commit/CI evidence, risks/debt, remaining blockers and next dependency in the **same feature `tasks.md`**. Run an independent read-only review and follow the established PR process.

For R2, select appropriate checks rather than enforcing a token RED phase. A high-risk behavioral change inside a UI or config file still uses R0/R1. Do not retroactively recreate RED runs for unchanged legacy code. Separate RED commits are optional, including on squash-merge branches; only record a stronger reproduction when the reviewed task specifically needs it.

## Provider Dispatch pilot review prompts

Before accepting G3 test cases or code, answer all of the following with a concrete model and regression evidence:

| Question | Required evidence |
|---|---|
| Could the provider have received this paid request? | Distinct pre-claim versus post-claim crash transitions; no blind second submission after durable `SUBMITTING` claim |
| Does `SUBMISSION_UNCERTAIN` preserve financial exposure? | PostgreSQL evidence that unresolved `reserved_open_usd_micros` remains held, pending is contained within reserved, and new admission cannot reuse held capacity |
| How is stale `SUBMITTING` resolved? | Bounded detection, provider lookup/reconciliation if safe, otherwise observable operator-review hold; no silent indefinite state |
| Is this an internal outbox retry or remote HTTP retry? | Separate policies: internal bounded backoff/exhaustion with durable inspectability; paid HTTP retry only after provider-specific safety evidence |
| Do 429/5xx/timeouts prove no remote side effect? | Explicit verification before retry; uncertainty and financial retention if not provable |
| Are concurrent claims actually exercised? | Deterministic barriers/interleavings against PostgreSQL 16; duplicate messages and restart tests |
| Are the claims backed by genuine execution? | Fake adapter CI evidence distinct from authorized LIVE smoke evidence, and from REPLAY/MODELED_ONLY |

Do not invent operational thresholds, provider idempotency guarantees, schema states, canonical G3 AT identifiers or remote status endpoints. Record unresolved items as `[VERIFY]`/blocked contracts in the feature spec, and do not implement dependent behavior until approved. Consult the [G2 financial specification](../../specs/financial-integrity/spec.md) and the current `servers/src/financial/outbox.ts` / `repository.ts` rather than copying their internals into a competing rule.

## Completion guard

Never mark a task DONE with a required FAIL/BLOCKED/NOT_IMPLEMENTED gate, missing genuine RED evidence for applicable changed R0/R1 behavior, unresolved BLOCK, or unapproved CONTAIN. A passing test suite or documentation validator is not owner sign-off. For cases where a behavioral RED test cannot yet execute, report the blocker; do not relabel an environment failure as test-first proof.
