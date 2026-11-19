# ENG-DEC-001 — SDD-Lite

Status: ACCEPTED — owner approved implementation on 2026-11-19.

[DECIDED] One primary developer with AI assistance. Preserve DEC-P01–P09,
EP-00–EP-08 and release gates G0–G5. This decision changes engineering workflow,
not product contracts. No framework orchestration or sprint process is introduced.

## Canonical sources

| Concern | Authority |
|---|---|
| Entry point | [AGENTS](../../AGENTS.md) |
| Scope, tasks, handoff | [Workflow](../../.agents/rules/plan-breakdown-handoff.md) |
| Exceptions and review | [Exceptions](../../.agents/rules/engineering-exceptions.md) |
| Product | [PRD](../PRD/PRD_AI_Short_Film_Assistant_v1.0.md) |
| Architecture | [C4](../C4-Model/C4_MODEL_ARCHITECTURE.md) |
| Exceptions/debt records | [Debt](../DEBT.md) |
| Feature behavior/evidence | [Specs](../../specs/README.md) |

One rule has one authoritative definition. Other documents link to it. A proposal
does not override a decision. Report conflicts with source locations; resolve
them before implementing affected work. Brief obligations cannot be relaxed by
engineering preferences. Existing approved product decisions remain in force.

## Quality evidence

Record command, environment/commit, actual result, scope and one status per check:
PASS (executed successfully), FAIL (executed unsuccessfully), BLOCKED (cannot run),
NOT_IMPLEMENTED (no implementation), NOT_APPLICABLE (outside change, with reason).
Do not aggregate missing gates into an overall PASS. CI success is not release approval.

| Gate | This increment |
|---|---|
| QG-CODE | TypeScript lint, source/test typecheck, build |
| QG-ARCH | Import restrictions and positive/negative rule fixtures |
| QG-DOMAIN | Existing environment logic only; finance/jobs/continuity NOT_IMPLEMENTED |
| QG-INTEGRATION | PostgreSQL 16 health/connectivity, not financial concurrency |
| QG-EVIDENCE | Spec/task/debt structure and local links, validator fixtures |

Fixtures for absent modules prove rule behavior only. A validator checks approval
record structure, not whether the human actually approved it; reviewers verify that.
Required checks must execute successfully before the increment is DONE. A documented
environment blocker is honest evidence but does not complete the blocked work.

## Deferred contract work

[VERIFY] Before dependent implementation: normalize uncertain-submission terminology;
verify provider-specific idempotency/retry behavior; decide money serialization;
freeze Hono deployment topology; test SSRF redirects/DNS/IPv6/size/timeouts;
verify REAL/REPLAY/modeled accounting isolation. Keep existing outbox by default.
Direct transactional enqueue requires a version-pinned commit/rollback/recovery
spike first (PRD §17.4 already permits a verified alternative).

[PROPOSED] BIGINT / bigint / decimal-string JSON and additional Attempt states
remain proposals. No dependency upgrades or deferred spikes are authorized here.

## Acceptance

- Reproducible fresh installation and local/CI evidence, or precise blocker.
- No conflicting rules in scope; no fabricated PASS.
- Negative fixtures detect the violations each validator claims to detect.
- Film Creation keeps unresolved money/topology contracts explicit.
- No finance/queue/SSRF implementation, unrelated refactors or fake debt records.
- Evidence, review and handoff identify remaining blockers; blocked gates prevent DONE.

Implementation record: [tasks and evidence](../../specs/eng-dec-001/tasks.md).
