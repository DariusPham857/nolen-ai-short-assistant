# Plan-first workflow, scope and handoff

Source: [ENG-DEC-001](../../docs/development/ENG-DEC-001.md).
This is the canonical workflow; AGENTS and feature documents reference it.

## Scope control
Before code, inspect requirements/callers and define measurable acceptance.
Classify changes REQUIRED (acceptance), PREREQUISITE (evidenced dependency),
OPPORTUNISTIC or UNRELATED (defer). Architecture-changing prerequisites need
an explicit decision. Do not implement deferred spikes or unrelated debt.

## Plan and tasks
Obtain an approved plan before implementation. A task has one coherent, testable
objective. 100–150 lines, 2–3 files and multiple layers are review signals, not
hard limits. Split independent goals or changes too large to review, keeping each
step valid and verifiable. Do not separate a behavior change from its tests.
Example: validation + tests → persistence + PG tests → API + contract tests → UI + E2E.
For behavioral changes, follow [Risk-Based TDD & Lightweight AMDD](risk-based-tdd-amdd.md) (R0/R1/R2) per [ENG-DEC-002](../../docs/development/ENG-DEC-002.md). Use TDD for risky business logic and bug fixes. Preserve product invariants.
Execute approved tasks without repeatedly seeking approval for routine choices.

## Handoff
Every completed coding task records evidence before the next dependent task.
Small subtask: changed files, command/result/status, blocker and next task;
inherit PRD/architecture mapping from the parent task.
Feature, contract, schema or architecture change: full file registration with
responsibility/public interfaces, FR/DEC/AT mapping, actual tests, risks/debt,
next dependency. Link existing C4; update it only when architecture changes.
Keep handoff in feature tasks.md; do not generate separate reports per edit.
Use clickable relative Markdown links in repository docs.

## Review and completion
Use [Engineering Exceptions & Review](engineering-exceptions.md).
Use [gate statuses](../../docs/development/ENG-DEC-001.md#quality-evidence).
Never claim unexecuted checks passed. Missing required evidence blocks completion.
A passing CI run is not approval of unimplemented product invariants or release gates.
