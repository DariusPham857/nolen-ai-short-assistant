# Engineering Exceptions & Review

Source: [ENG-DEC-001](../../docs/development/ENG-DEC-001.md).
Canonical policy for workarounds, debt and engineering review.

## Classification
ALLOW: correct, tested and baseline-compliant; proceed in approved scope.
CONTAIN: temporary/limited tradeoff; explain root cause or uncertainty, compare the
long-term fix, identify scope, risk, tests, safeguards and removal trigger. Record
in [DEBT](../../docs/DEBT.md) and obtain owner approval before applying. Existing
approval remains valid within its recorded scope; reassess changed conditions.
BLOCK: violates product invariants, security, data/financial correctness or honest
verification. Stop affected work/merge and fix the root cause. Debt cannot waive BLOCK.
Technical acceptability does not grant scope authorization: use the workflow's scope control.

## Non-negotiable guardrails
Reference PRD DEC-P01–P09 for approval/keyframe policy, integer-micros admission,
append-only history, dispatch idempotency, revision integrity, provenance and security.
Domain code uses provider contracts; UI/domain must not import provider transports.
No silent provider fallback, false LIVE/OBSERVED evidence, unknown-as-zero billing,
or bypassing validation. Count actual charges including charged failures, not assumed charges.
Unsafe casts/suppressions cannot hide contract errors; narrowly justified technical
exceptions need CONTAIN approval and additional verification. Do not weaken tests
for green CI. Correcting obsolete tests needs spec justification and replacement evidence.

## Failure analysis
Reproduce where possible, identify root cause, make the smallest verified repair.
After two unsuccessful fixes of the same failure class, stop speculative patches
and form a new evidence-backed hypothesis/test. This is a process heuristic.
Uncertain paid submission requires reconciliation, never blind retry.

## Debt and shortcuts
Track actual exceptions only. Single-worker FFmpeg and contract-compliant test mocks
are not automatically debt. Application fixtures follow REPLAY rules.
A shortcut comment links its TD-ID when CONTAIN applies; it does not prove approval.
Do not spread debt to new modules. Repay before dependent work if correctness or
material risk requires it; otherwise monitor safeguards and trigger, without fake deadlines.

## Read-only review
Inspect approved spec, diff, connected callers and tests in a separate review pass.
Find drift, hidden workarounds, debt expansion, duplication, needless dependencies,
missing regression coverage and unsupported success claims. No speculative findings.
For each finding provide location, evidence, impact, BLOCK/CONTAIN/IMPROVEMENT,
smallest remediation and regression test. Verify human approval evidence, not just fields.
Explain significant data flow, invariants, side effects, failure handling and rollback
with code/test references. AI review supplements, never replaces, owner responsibility.

## Completion
No DONE with failed required checks, unmet acceptance, BLOCK or unapproved CONTAIN.
Approved debt can remain only while safeguards hold and repayment trigger has not fired.
