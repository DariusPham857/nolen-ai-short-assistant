# FC-001 localhost operation

Source: [approved Film spec](../../specs/film-creation/spec.md),
[PRD FR-01 / DEC-P05](../PRD/PRD_AI_Short_Film_Assistant_v1.0.md).

## Start

Node 22.23.0 and pnpm 11.21.0 are pinned. Generate a random operator token of at
least 32 bytes and export OPERATOR_TOKEN in the terminal (never commit it).
Run `docker compose up --build --detach --wait --wait-timeout 180` from repository root.
Only web has a build definition; migration/worker reuse the same image.
Visit **http://127.0.0.1:3000**, unlock and create a draft. Hostname localhost is
not an alias in the security contract. Cookie is host-only HttpOnly/SameSite Strict
on HTTP loopback; no __Host- prefix. This topology is for a trusted local machine.

`db` must be healthy; the one-off `migration` must complete before web/worker.
The migration service is a startup command, not a new application architecture layer.
Worker retains pg-boss initialization but has no Film handlers. It can be stopped
without affecting create/read. No generation, budget account or ledger is created.
Film budget is a draft limit only; it does not authorize a paid operation.

## Data and migrations

Default application volume is preserved. Never use `down --volumes` on an application
project. A schema previously created by db:push has no trusted journal and is
intentionally blocked with SCHEMA_MISMATCH. Back up and plan an explicit data-preserving
migration; do not reset, baseline or forge journal entries.

Generated SQL uses kit 0.31.11 / ORM 0.44.7. Applied SQL bytes are immutable and
LF-pinned via .gitattributes because the journal records SHA256 of exact content.
The finite catalog in state-1.json covers only supported application objects. Any
new migration needs its supported catalog state captured on disposable PG16 and tested.
Preflight validates all applied journal entries, not just the latest. No general diff engine.

## Sessions and uncertain create

Session IDs never persist in cleartext. Absolute expiry is 8 hours; logout deletes
the DB row. Token rotation and web restart invalidate older sessions via fingerprint.
The process-local unlock limiter resets on web restart; it is not distributed protection.
Session lookup database failure is 503, invalid credentials are 401.

A timeout/5xx may occur after a successful commit. The current tab keeps canonical
payload/key in sessionStorage and offers retry of that exact request. Do not clear
it merely because the network failed. Explicit cancellation warns a Film may exist;
it never deletes that Film. Operator tokens are not stored in browser storage.

## Verify

Fresh clone: `pnpm install --frozen-lockfile`, `pnpm build`, `pnpm lint`,
`pnpm typecheck`, `pnpm test`, `pnpm test:guardrails`,
`pnpm --filter @nolen/web test:boundary`, `pnpm test:evidence`, `pnpm check:evidence`.
Build requires no operator token. Actual web startup requires DATABASE_URL and
OPERATOR_TOKEN; explicit preflight runs before binding Next's port.

Integration requires disposable PG16 with CREATEDB permission:
`pnpm test:integration`, `pnpm db:migrate`, `pnpm exec playwright install chromium`,
`pnpm test:e2e`. Tests create/drop only random test-owned databases; never point
integration tests at application/production data.

Compose smoke: set COMPOSE_PROJECT_NAME to an explicitly disposable project,
`docker compose -p <test-project> up --build --detach --wait --wait-timeout 180`,
then `node scripts/compose-smoke.mjs`. It stops that project's worker and restarts
web to prove persistence and durable logout. CI owns its test-project cleanup.

Rollback application code without deleting Film data or automatically downgrading
BIGINT. Release G0–G5, generation/financial/continuity/media evidence remains outside FC-001.
Evidence: [feature tasks](../../specs/film-creation/tasks.md).
