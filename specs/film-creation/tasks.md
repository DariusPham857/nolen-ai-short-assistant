# Film Creation tasks

Status: BLOCKED
Source: [spec](spec.md)

## Tasks
1. PREREQUISITE: resolve spec's blocked contracts with owner decisions.
2. REQUIRED: contract and validation tests against approved FR-01 cases.
3. REQUIRED: persistence/migration with PostgreSQL happy/negative tests.
4. REQUIRED: create/read API with contract tests; depends on 2–3 and topology decision.
5. REQUIRED: UI and reload/error scenarios; depends on API contract and design system.
6. REQUIRED: end-to-end acceptance and full handoff. No provider calls.

Exact commands and file scope are frozen in the implementation plan after contracts
are approved; none of these implementation tasks is authorized by this increment.

## Handoff
Specification only. No endpoints, migrations, UI or production types implemented.
Checks and decisions are tracked in [engineering evidence](../eng-dec-001/tasks.md).
