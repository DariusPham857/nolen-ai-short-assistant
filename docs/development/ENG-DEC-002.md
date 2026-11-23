# ENG-DEC-002 — Risk-Based TDD & Lightweight AMDD

**Status:** ACCEPTED — owner approved implementation on 2026-11-23  
**Type:** Engineering workflow amendment, subordinate to [ENG-DEC-001 — SDD-Lite](ENG-DEC-001.md)  
**Scope:** New or modified engineering work; G3 Provider Dispatch is the first pilot. No runtime implementation is authorized by this decision alone.

## 1. Decision and boundaries

[DECIDED] Improve SDD-Lite through risk-based test-first development and lightweight, just-enough modeling. Keep the existing plan-first workflow, feature specifications, handoff, review, evidence statuses, branch/PR practices and release gates. Do **not** introduce a competing delivery process, new orchestration framework or mandatory sprint cadence.

- Product requirements, approved DEC-P01–P09, security/financial invariants and G0–G5 remain unchanged. This document **does not** authorize G3 provider calls, migrations, dependencies, or alterations to G2 financial behavior.
- Use the [plan/scope/handoff workflow](../../.agents/rules/plan-breakdown-handoff.md) for authorization and task sizing, and the [exceptions/review policy](../../.agents/rules/engineering-exceptions.md) for ALLOW / CONTAIN / BLOCK decisions.
- The [execution rule](../../.agents/rules/risk-based-tdd-amdd.md) is the operational reference for agents; this decision defines its scope and acceptance. Do not duplicate this policy in `AGENTS.md` or feature specs.
- Existing validated features are **not** subject to retrospective rewriting of tests or reconstructed RED evidence. Apply the policy to a feature when its behavior changes.

## 2. Authority and model ownership

| Concern | Canonical authority |
|---|---|
| Product obligations and approved invariants | [PRD v1.0](../PRD/PRD_AI_Short_Film_Assistant_v1.0.md) and approved product decisions |
| Scope, implementation tasks, handoff | [SDD-Lite workflow](../../.agents/rules/plan-breakdown-handoff.md) |
| Engineering exceptions, human review | [Engineering exceptions](../../.agents/rules/engineering-exceptions.md) |
| Feature behavior and acceptance | `specs/<feature>/spec.md`; evidence in corresponding `tasks.md` |
| Runtime input/output validation | Versioned contracts in `packages/contracts/` (Zod and TypeScript) |
| Persisted schema and migration history | `servers/src/db/schema/` and versioned migrations |
| Service/container boundaries | [C4 architecture](../C4-Model/C4_MODEL_ARCHITECTURE.md) |

Zod and Drizzle are executable contract/schema models, **not** substitutes for business requirements or approved invariants. When sources disagree, report the conflict and resolve it under SDD-Lite before coding the affected behavior.

## 3. Risk tiers and required method

Use **R0/R1/R2** for *engineering risk* to avoid conflating them with product-feature priorities P0/P1/P2.

| Tier | Typical change | Test-first obligation | Evidence |
|---|---|---|---|
| **R0 — Critical** | Monetary arithmetic, budget admission/settlement, approval authorization, immutable history, idempotency, concurrency, worker crash recovery, paid provider submission and security boundaries | RED → GREEN → REFACTOR for behavioral changes; real PostgreSQL 16 for transactional/concurrent claims | Expected RED assertion + subsequent GREEN/verification + failure/interleaving coverage |
| **R1 — Important** | Public Zod/API contracts, lifecycle/state transitions, continuity guardrails, retry/recovery policy, integration-facing rules | Test-first for changed observable behavior and incompatible input; contract tests before dependent implementation | Expected RED assertion + GREEN/verification, mapped to acceptance |
| **R2 — Flexible** | Styling, layout-only UI, prose, straightforward maintenance with no changed runtime contract | Targeted test/visual/E2E as warranted; no mandatory RED phase | Verification appropriate to changed scope |

Classification is based on the **risk of the behavior changed**, not solely the filename. A UI action that authorizes payment or approval is R0; changing CSS within the same component may be R2. Mixed changes take the highest applicable tier for the affected behavior. Security and financial correctness may not be downgraded to expedite delivery.

## 4. Minimum test-first evidence

For R0/R1 changed behavior, preserve a concise record in the **existing feature** `specs/<feature>/tasks.md`:

1. Test identifier (file/test name) and mapped FR/DEC/AT or feature acceptance identifier.
2. Exact command and environment needed to execute it.
3. A **real** assertion failure excerpt showing the absent/incorrect behavior; state why the failure is expected.
4. The GREEN run result, commit/CI context if available, and all required verification gate statuses.

An unavailable database, broken compilation, incorrect test setup, or network failure is **not** valid behavioral RED evidence. Do not claim a test was executed if it was not. A preserved RED commit is **optional**, including for squash-merge PRs; do not require a commit per failed test. Where independent review specifically needs a stronger reproduction, record the requested reproducible fixture or commit as an evidenced prerequisite.

Test and implementation belong to the same reviewable task/PR. Do not weaken, skip, remove or rewrite assertions merely to obtain GREEN. Record all verification using the status vocabulary in [ENG-DEC-001](ENG-DEC-001.md): PASS, FAIL, BLOCKED, NOT_IMPLEMENTED or NOT_APPLICABLE. A RED run expected during development is **not** a PASS for the final quality gate.

## 5. Lightweight AMDD: model only meaningful behavior

Before R0/R1 implementation, add only the model needed to remove ambiguity from the feature specification:

- A **state-transition table/diagram** if lifecycle, timeouts, or crash recovery changes; specify owner, event, precondition, side effect and prohibited transitions.
- A **transaction/sequence sketch** if atomicity, row locks, outbox or remote side effects change; identify durable commit boundaries and the uncertainty window.
- Input/output schema and compatibility notes if contract or migration changes.
- Error/recovery cases and acceptance-to-test mapping for the changed behavior.

The model should be reviewable in minutes and embedded in `specs/<feature>/spec.md`; no standalone UML repository or exhaustive component diagrams. Keep C4 current **only** when service, queue or data-flow boundaries materially change, not at a calendar interval. Update models when verified behavior differs from the proposal.

## 6. G3 Provider Dispatch pilot: mandatory contracts to specify and test

These are **acceptance obligations for a future approved G3 spec**, not permission to implement G3 in PR-01. Assign canonical scenario IDs and provider-specific details when G3 is scoped.

### G3-A — Financial hold under submission uncertainty

If a chargeable request may have reached a provider but its outcome is unknown, the Attempt must not release the portion of `reservation_open_usd_micros` covering unresolved exposure. `pending_liability_usd_micros` is included **within** open reservations, not added again to available-budget arithmetic. Keep `pending_liability <= reservation_open` and preserve the budget admission invariant `actual_spent + reserved_open + next_reservation <= budget_limit`.

No transition to `FINAL` / release of unresolved exposure without sufficient provider or independently auditable operator evidence of final charges or confirmed non-acceptance/no-charge. A provider result may produce `PARTIAL`, `PENDING` or `DISPUTED` as warranted; do not equate transport failure with no charge. Test uncertain submission, partial settlement, duplicate reconciliation, provider overage and concurrent new admission with real PostgreSQL 16. Reference [FI-001](../../specs/financial-integrity/spec.md) rather than redefining its calculations.

### G3-B — Stale `SUBMITTING` claims after a worker crash

Distinguish (a) crash before a durable provider-submission claim, when an expired `dispatch_outbox` delivery lease can be reprocessed safely through existing idempotent queue semantics, from (b) crash **after** an `outbound_dispatches` `SUBMITTING` claim exists, when network transmission may already have occurred. Case (b) must not become an automatic second paid HTTP request.

Specify durable claim correlation, stale-claim detection, a reconciliation/operational-review path and a non-terminal uncertainty state. Where the provider supports safe job/status lookup or an explicitly verified idempotent request, use that capability under a documented contract. When it does not, hold the request for operator review and retain financial exposure; do not leave an unobservable permanent `SUBMITTING` row or blindly resubmit. Ensure transitions are auditable and crash/restart tests have deterministic ordering barriers.

### G3-C — Bounded outbox delivery retry versus remote provider retry

The existing outbox relay currently schedules delivery retries after one second without an exhaustion ceiling. G3 must specify bounded exponential backoff (including a testable jitter policy), a retry threshold and a durable exhausted/needs-attention outcome **for the internal relay**, with metrics or other observable evidence; thresholds are parameters to approve in G3, not numbers silently invented here. An exhausted message must remain inspectable/recoverable, never silently dropped or treated as remotely submitted.

**Separate** the internal `pg-boss` enqueue/relay retry from a paid provider HTTP submission retry. HTTP 429, 5xx, timeout or disconnect do not by themselves prove non-acceptance; only auto-retry a chargeable operation if provider-specific semantics and duplicate protection have been verified. Otherwise record uncertainty and reconcile. Test repeated relay errors, saturation/backoff, exhaustion, recovery and ambiguous provider responses.

### G3-D — Provider-safe evidence and deterministic tests

Use fake adapter transports for reliable CI contract tests; use PostgreSQL 16 for transaction/locking assertions. Test `submission -> crash -> restart -> reconcile`, duplicate queue delivery, delayed callback, SSRF redirects/DNS/IPv6/timeouts/size restrictions, provider rate-card mismatch and ledger conservation. Keep LIVE smoke tests separately authorized and budget-bounded; REPLAY/fixtures must never be labeled LIVE or OBSERVED benchmark results. A fixed `sleep` is not a substitute for a deterministic concurrency barrier.

## 7. Delivery plan and dependencies

1. **PR-00 / housekeeping (optional):** synchronize G2 owner-acceptance status only with **actual owner approval evidence**; otherwise retain `IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF`. Update the index in `specs/README.md` independently of sign-off. Do not reinterpret CI PASS as owner approval.
2. **PR-01 (docs-only):** add this decision and its execution rule; link from `AGENTS.md` and the existing workflow without rewriting canonical policies. Await owner authorization before changing decision status to ACCEPTED.
3. **PR-02 (docs-only):** extend `specs/_template/spec.md` and `tasks.md` with optional state/transaction model fields, risk tier and RED/GREEN evidence; no template-wide migration or historical evidence backfill.
4. **PR-03 (G3 pilot):** separately approved, reviewable slices: contracts/state model → fake adapter/security and retry semantics → outbox/financial integration and crash recovery. Tests ship with each behavioral change.
5. **PR-04 (conditional):** after pilot review, add only automatable, low-noise validation. Do not claim that CI can prove chronological RED-before-GREEN from a final commit alone.

## 8. Decision acceptance and abort conditions

**PR-01 ready for review** when both Markdown files exist with valid relative links, the existing policy sources remain canonical, no runtime files/schema/dependencies change, and the repository evidence/link checks have been **executed** and recorded truthfully in the PR handoff. Documentation-only checks do not imply G3 readiness or G2/G3 release approval.

**Pilot accepted** only when its approved G3 acceptance cases map to tests and observed evidence; required CI gates pass; no BLOCK or unapproved CONTAIN exists; financial and remote-submission uncertainty never silently turn into free capacity or duplicate paid calls; and an independent review verifies the actual commit/environment evidence.

**Stop or reduce scope** if repeated flaky barriers, duplicate rule registries, unsustainable maintenance/CI overhead, provider-specific idempotency uncertainty or lack of reproducible results defeats the stated benefits. Apply [exceptions/review](../../.agents/rules/engineering-exceptions.md) and resolve correctness BLOCKs before dependent work.
