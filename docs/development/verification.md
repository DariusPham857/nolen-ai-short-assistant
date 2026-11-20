# Scaffold verification

Source: [ENG-DEC-001](ENG-DEC-001.md). See [evidence](../../specs/eng-dec-001/tasks.md).

Toolchain: Node 22.23.0 (`.node-version`), pnpm 11.21.0 (root packageManager).
FC-001 adds a root workspace/lockfile. From repository root run `pnpm install --frozen-lockfile`
and `pnpm build` before the server checks below. Full product commands and database
constraints: [FC-001 runbook](FC-001-runbook.md).
Then run each command separately (a failure must not be hidden by a later command):

```text
pnpm --dir servers lint
pnpm --dir servers typecheck
pnpm --dir servers test
pnpm --dir servers build
pnpm --dir servers test:guardrails
pnpm --dir servers test:evidence
pnpm --dir servers check:evidence
pnpm --dir servers test:integration
```

Integration requires DATABASE_URL pointing to a disposable PostgreSQL 16 database.
CI provides a service; local tests must not point to production. The health test
only reads; Film/Story integration suites perform schema/data writes and create
test-owned disposable databases. Run integration files serially because security
negative cases temporarily rename the session table. PostgreSQL unavailable means BLOCKED, not PASS.
Unit health tests mock connectivity; financial concurrency tests remain NOT_IMPLEMENTED.
FC-001 integration additionally verifies Film/session/migration behavior on PG16.
SP-001 adds snapshot concurrency/receipts, Bible dependencies, continuity/waivers,
approval evidence, same-Film FKs and application guard-trigger drift. Browser
tests cover canonical fixture approval, history and uncertain retries; fixtures
do not prove LIVE planning. VIDEO_DISPATCH and financial invariants remain NOT_IMPLEMENTED.

ESLint rules use [typed linting](https://typescript-eslint.io/getting-started/typed-linting/)
and [restricted imports](https://eslint.org/docs/latest/rules/no-restricted-imports).
Scaffold lint covers server source including tests. FC-001 adds client lint,
browser-safe contracts restrictions and a Next negative build for indirect
Client Component imports through the server-only bridge.
Restrictions are not a runtime security boundary or a full dependency graph analysis.

Evidence validator covers project engineering docs, specs and rule links; excludes
vendored repositories and historical PRD/C4 content. It validates relative file
targets, not anchors/remote links or semantic correctness. Approval fields do not
prove human authorization. Review checks that evidence separately.

CI success does not enforce branch protection automatically. Required-status-check
configuration must be verified separately before claiming merge enforcement.
