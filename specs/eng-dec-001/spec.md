# ENG-DEC-001 implementation

Status: IN_PROGRESS
Source: [accepted decision](../../docs/development/ENG-DEC-001.md)

## Goal
Make existing engineering rules consistent and scaffold checks executable.

## Scope
REQUIRED: rules, templates, validators, scaffold health tests, CI and Film spec.
PREREQUISITE: reproducible toolchain, typed ESLint support and baseline fixes
needed by those checks. No product feature, financial engine or deferred spike.

## Invariants
Preserve PRD DEC-P01–P09 and deployment choices; no paid provider calls.

## Acceptance criteria
- Existing rule conflicts are reconciled with explicit mapping.
- Negative fixtures prove validator behavior; empty suites fail.
- Gate statuses distinguish missing implementation from executed checks.
- Fresh checkout and CI evidence are recorded without hiding baseline failures.
- Film Creation remains blocked on unresolved contracts.

## Open Questions / Blocked Contracts
See the decision's deferred contract work; it does not block independent documentation.
