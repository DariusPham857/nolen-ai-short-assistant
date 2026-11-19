# Scaffold verification

Source: [ENG-DEC-001](ENG-DEC-001.md). See [evidence](../../specs/eng-dec-001/tasks.md).

Toolchain: Node 22.23.0 (`.node-version`), pnpm 11.21.0 (server packageManager).
From repository root run `pnpm --dir servers install --frozen-lockfile`.
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
CI provides a service; local tests must not point to production. No schema writes
are needed for this health-only test. PostgreSQL unavailable means BLOCKED, not PASS.
Unit health tests mock connectivity; financial concurrency tests remain NOT_IMPLEMENTED.

ESLint rules use [typed linting](https://typescript-eslint.io/getting-started/typed-linting/)
and [restricted imports](https://eslint.org/docs/latest/rules/no-restricted-imports).
Scaffold lint covers server source, including tests. Client boundaries currently
have fixture evidence only: no frontend exists. Wiring future client lint and
checking dynamic imports/re-exports is required before claiming frontend isolation.
Restrictions are not a runtime security boundary or a full dependency graph analysis.

Evidence validator covers project engineering docs, specs and rule links; excludes
vendored repositories and historical PRD/C4 content. It validates relative file
targets, not anchors/remote links or semantic correctness. Approval fields do not
prove human authorization. Review checks that evidence separately.

CI success does not enforce branch protection automatically. Required-status-check
configuration must be verified separately before claiming merge enforcement.
