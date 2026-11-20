# FC-001 tasks and evidence

Status: LOCAL_ACCEPTANCE_BLOCKED
Source: [approved v1.1.1](spec.md)

## Tasks
| ID | Class | Goal / verification |
|---|---|---|
| FC-01 | REQUIRED | Freeze spec / docs validator |
| FC-02a | PREREQUISITE | Root workspace / frozen install, runtime version diff |
| FC-02b | PREREQUISITE | Frontend scaffold / no-secret build |
| FC-03 | REQUIRED | Money/normalization / unit boundaries |
| FC-04a | REQUIRED | Migration/preflight / PG16 drift tests |
| FC-04b | REQUIRED | Repository / PG16 20-way idempotency |
| FC-05a | REQUIRED | Sessions / rotation/revocation/expiry |
| FC-05b | REQUIRED | API security / Host/Origin/bounds/DB failure |
| FC-06a | REQUIRED | Next bridge / runtime/cache/import boundary |
| FC-06b | REQUIRED | UI / pending retry |
| FC-07 | PREREQUISITE | Compose / startup, worker independence |
| FC-08 | REQUIRED | Playwright/CI/review/handoff |

## Handoff
FC-01: replaced blocked draft with approved v1.1.1. Branch from main bff3e61.
Next FC-02a and FC-03. No implementation PASS claimed yet.

### FC-02a / FC-03 — workspace and contracts
- Root workspace and lockfile replace server-only workspace; package names unchanged.
- Verified root frozen install; original runtime versions retained: Hono 4.13.19,
  Drizzle ORM 0.44.7, kit 0.31.11, pg-boss 10.4.2.
- Next 16.4.6 / React 19.3.1 / Tailwind 4.3.5 / Playwright 1.65.1 pinned after registry checks.
- `pnpm --filter @nolen/contracts build` PASS; contracts unit tests PASS 2/2.
- Browser-safe exports: CreateFilm/FilmDto Zod schemas, normalized payload, integer money helpers.
- Tests cover bigint max/zero, precision beyond Number safe integer, malformed values,
  normalized-equivalent content and strict field validation.
- Next: persistence and API verification.

### FC-04 / FC-05 — persistence and API
- `pnpm --filter @nolen/server test:integration` PASS 11/11 against isolated PG16
  container nolen-fc001-pg16 at localhost:55432, never application data.
- Includes 20 concurrent duplicate POSTs, canonical replay/conflict, session expiry,
  rotation/revocation, DB lookup failure →503, bounds/origin/Host/method/media/rate tests.
- Migration tests create/drop only their own random test databases: fresh/repeated
  journal acceptance, unmanaged films sentinel preservation, hash and catalog drift.
- Drizzle generator failed on bigint default 0n; SQL default 0 fixes snapshot
  serialization while retaining BIGINT and domain bigint. No dependency upgrade.
- Catalog state captured only by applying generated migration to disposable PG16.
- `pnpm --filter @nolen/server test` PASS 8/8; canonical Host requests replace default
  localhost in existing health tests with assertions retained.
- Next: frontend/Compose and full CI.

### FC-06 — frontend and runtime
- `pnpm lint`, `pnpm typecheck`: PASS across server/web/contracts.
- Production Next build without OPERATOR_TOKEN: PASS.
- `pnpm --filter @nolen/web test:boundary`: PASS 2/2. Explicit start preflight added
  because Next instrumentation alone logged an error after binding a port instead
  of terminating. Runtime now refuses missing token before Next starts.
- Negative build uses the production bridge source through an indirect Client
  Component import. Fixture-only webpackBuildWorker=false keeps diagnostics in the
  tested process; asserts server-only failure and indirect/page import trace.
- First E2E run had ambiguous alert selectors (Next route announcer); error region
  now has accessible name, assertions target the intended error.
- Playwright production web + real PG16: PASS 4/4 (create/read/reload/logout,
  response loss after commit, 5xx after commit, bigint overflow/mobile).
- Next: Compose acceptance, visual review, independent CI and final file registry.

### Local environment interruption / FC-07
- Initial Linux image build PASS without runtime secrets. Parallel Compose image
  export then failed with Docker Desktop overlayfs input/output errors; Docker API
  stopped responding and the isolated PG16 port returned CONNECT_TIMEOUT.
- Corrected duplicate build definitions: only web builds; migration/worker reuse image.
  No reset/prune or application volume deletion performed.
- Latest 5-test E2E rerun BLOCKED by unavailable PG16 at unlock; earlier 4-test run
  PASS remains historical evidence, not a PASS for the new fifth case.
- Added unit regression from observed postgres-js CONNECT_TIMEOUT: session lookup
  returns safe 503, unclassified exception returns 500. Unit suite now PASS 10/10.
- Visual inspection of earlier desktop brief/mobile form screenshots: no horizontal
  overflow at 390px, zinc/amber hierarchy and real money display. Replaced Arial
  fallback with locally bundled Geist Sans/Mono per design tokens; build PASS.
- Next: independent CI on clean Ubuntu; final browser/Compose acceptance pending.

### File registration (FC-001)
Source mapping: FR-01/MVP-01 and the approved spec above; topology clarification in C4.
- [.dockerignore](../../.dockerignore): Reproducible image and private localhost topology/startup order.
- [.gitattributes](../../.gitattributes): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [.github/workflows/quality.yml](../../.github/workflows/quality.yml): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [.gitignore](../../.gitignore): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [clients/app/api/((...route))/route.ts](../../clients/app/api/[[...route]]/route.ts): Create/read/unlock UI, states and local design-system primitives.
- [clients/app/films/(id)/brief/page.tsx](../../clients/app/films/[id]/brief/page.tsx): Create/read/unlock UI, states and local design-system primitives.
- [clients/app/films/new/page.tsx](../../clients/app/films/new/page.tsx): Create/read/unlock UI, states and local design-system primitives.
- [clients/app/globals.css](../../clients/app/globals.css): Create/read/unlock UI, states and local design-system primitives.
- [clients/app/layout.tsx](../../clients/app/layout.tsx): Create/read/unlock UI, states and local design-system primitives.
- [clients/app/page.tsx](../../clients/app/page.tsx): Create/read/unlock UI, states and local design-system primitives.
- [clients/app/unlock/page.tsx](../../clients/app/unlock/page.tsx): Create/read/unlock UI, states and local design-system primitives.
- [clients/components/create-film.tsx](../../clients/components/create-film.tsx): Create/read/unlock UI, states and local design-system primitives.
- [clients/components/navigation.tsx](../../clients/components/navigation.tsx): Create/read/unlock UI, states and local design-system primitives.
- [clients/components/ui/button.tsx](../../clients/components/ui/button.tsx): Create/read/unlock UI, states and local design-system primitives.
- [clients/eslint.config.mjs](../../clients/eslint.config.mjs): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [clients/instrumentation.ts](../../clients/instrumentation.ts): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [clients/lib/api.ts](../../clients/lib/api.ts): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [clients/lib/server.ts](../../clients/lib/server.ts): server-only Hono bridge.
- [clients/next-env.d.ts](../../clients/next-env.d.ts): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [clients/next.config.mjs](../../clients/next.config.mjs): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [clients/package.json](../../clients/package.json): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [clients/postcss.config.mjs](../../clients/postcss.config.mjs): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [clients/proxy.ts](../../clients/proxy.ts): Host rejection for all Next pages/assets/API requests.
- [clients/scripts/runtime-boundary.test.mjs](../../clients/scripts/runtime-boundary.test.mjs): Automated positive/negative acceptance or regression evidence.
- [clients/scripts/start.mjs](../../clients/scripts/start.mjs): Pre-bind runtime validation or boundary fixture runner.
- [clients/tsconfig.json](../../clients/tsconfig.json): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [docker-compose.yml](../../docker-compose.yml): Reproducible image and private localhost topology/startup order.
- [Dockerfile](../../Dockerfile): Reproducible image and private localhost topology/startup order.
- [docs/C4-Model/C4_MODEL_ARCHITECTURE.md](../../docs/C4-Model/C4_MODEL_ARCHITECTURE.md): Requirements/architecture/design/evidence registration.
- [docs/design/UI_DESIGN_WORKFLOW.md](../../docs/design/UI_DESIGN_WORKFLOW.md): Requirements/architecture/design/evidence registration.
- [docs/development/FC-001-runbook.md](../../docs/development/FC-001-runbook.md): Requirements/architecture/design/evidence registration.
- [docs/development/verification.md](../../docs/development/verification.md): Requirements/architecture/design/evidence registration.
- [package.json](../../package.json): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [packages/contracts/eslint.config.mjs](../../packages/contracts/eslint.config.mjs): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [packages/contracts/package.json](../../packages/contracts/package.json): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [packages/contracts/src/index.test.ts](../../packages/contracts/src/index.test.ts): Automated positive/negative acceptance or regression evidence.
- [packages/contracts/src/index.ts](../../packages/contracts/src/index.ts): Zod input/DTO contracts, normalizeFilm, usdToMicros, formatMicros.
- [packages/contracts/tsconfig.json](../../packages/contracts/tsconfig.json): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [playwright.config.ts](../../playwright.config.ts): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [pnpm-lock.yaml](../../pnpm-lock.yaml): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [pnpm-workspace.yaml](../../pnpm-workspace.yaml): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [README.md](../../README.md): Requirements/architecture/design/evidence registration.
- [scripts/compose-smoke.mjs](../../scripts/compose-smoke.mjs): Canonical ports, worker independence, restart persistence/logout acceptance.
- [servers/package.json](../../servers/package.json): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [servers/scripts/check-guardrails.test.mjs](../../servers/scripts/check-guardrails.test.mjs): Automated positive/negative acceptance or regression evidence.
- [servers/scripts/copy-migrations.mjs](../../servers/scripts/copy-migrations.mjs): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [servers/src/app.ts](../../servers/src/app.ts): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [servers/src/auth/sessions.ts](../../servers/src/auth/sessions.ts): unlock/authenticate/revoke; opaque durable sessions and token fingerprint.
- [servers/src/config/runtime.ts](../../servers/src/config/runtime.ts): runtimeConfig and canonical origin/operator constants.
- [servers/src/db/migrate-cli.ts](../../servers/src/db/migrate-cli.ts): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [servers/src/db/migrate.integration.test.ts](../../servers/src/db/migrate.integration.test.ts): Automated positive/negative acceptance or regression evidence.
- [servers/src/db/migrate.ts](../../servers/src/db/migrate.ts): inspectSchema/preflight/migrateDatabase; finite catalog and journal verification.
- [servers/src/db/migrations/0000_magenta_hardball.sql](../../servers/src/db/migrations/0000_magenta_hardball.sql): Immutable SQL / Drizzle journal/snapshot / supported catalog evidence.
- [servers/src/db/migrations/meta/_journal.json](../../servers/src/db/migrations/meta/_journal.json): Immutable SQL / Drizzle journal/snapshot / supported catalog evidence.
- [servers/src/db/migrations/meta/0000_snapshot.json](../../servers/src/db/migrations/meta/0000_snapshot.json): Immutable SQL / Drizzle journal/snapshot / supported catalog evidence.
- [servers/src/db/migrations/meta/state-1.json](../../servers/src/db/migrations/meta/state-1.json): Immutable SQL / Drizzle journal/snapshot / supported catalog evidence.
- [servers/src/db/schema/films.ts](../../servers/src/db/schema/films.ts): Drizzle tables/types and constraints; no Story/ledger tables.
- [servers/src/db/schema/index.ts](../../servers/src/db/schema/index.ts): Drizzle tables/types and constraints; no Story/ledger tables.
- [servers/src/db/schema/sessions.ts](../../servers/src/db/schema/sessions.ts): Drizzle tables/types and constraints; no Story/ledger tables.
- [servers/src/db/seed.ts](../../servers/src/db/seed.ts): Workspace/build/lint/test configuration or entrypoint supporting FC-001.
- [servers/src/films/film.integration.test.ts](../../servers/src/films/film.integration.test.ts): Automated positive/negative acceptance or regression evidence.
- [servers/src/films/repository.ts](../../servers/src/films/repository.ts): filmDto/requestHash/createFilm/getFilm; commit-before-response idempotency.
- [servers/src/http/errors.ts](../../servers/src/http/errors.ts): ApiFailure/failure public envelope.
- [servers/src/http/film-api.ts](../../servers/src/http/film-api.ts): createFilmApi; request security, bounded parser, routes and safe errors.
- [servers/src/http/network.test.ts](../../servers/src/http/network.test.ts): Automated positive/negative acceptance or regression evidence.
- [servers/src/routes/health.integration.test.ts](../../servers/src/routes/health.integration.test.ts): Automated positive/negative acceptance or regression evidence.
- [servers/src/routes/health.test.ts](../../servers/src/routes/health.test.ts): Automated positive/negative acceptance or regression evidence.
- [specs/eng-dec-001/tasks.md](../../specs/eng-dec-001/tasks.md): Requirements/architecture/design/evidence registration.
- [specs/film-creation/spec.md](../../specs/film-creation/spec.md): Requirements/architecture/design/evidence registration.
- [specs/film-creation/tasks.md](../../specs/film-creation/tasks.md): Requirements/architecture/design/evidence registration.
- [tests/e2e/film.spec.ts](../../tests/e2e/film.spec.ts): Automated positive/negative acceptance or regression evidence.
- Removed server-local pnpm-workspace.yaml; its responsibilities moved to the root workspace. Server-local lockfile moved to root; no runtime dependency upgrade.

### FC-08 read-only author review and independent CI
- Separate read-only review inspected routes, auth/repository callers, transaction
  boundary, schema/journal checks, startup, UI uncertainty and negative fixtures.
  This is author review, not independent human approval.
- Review corrections: canonical Host guard now covers Next pages/assets as well
  as API; real browser test checks session-table outage →503 and no-store;
  definitive 422 preserves form content; browser-safe contract lint also blocks
  server package aliases. No remaining implementation BLOCK found in this pass.
- [Clean Ubuntu CI](https://github.com/DariusPham857/nolen-ai-short-assistant/actions/runs/44672044221)
  on adc46cde588c2dfeea2fe8a15fd51c59e6de8503: SUCCESS, both film and compose jobs.
- PASS: root frozen install, no-secret production build, lint, source/test typecheck.
- PASS: 2 contract tests, 10 server unit tests, 11 PG16 integration tests,
  4 architecture/typed/discovery fixtures, 2 runtime/indirect-build tests,
  4 evidence validator tests, 6 real-browser tests; 18 engineering documents.
- PASS Compose: only canonical web port published, DB private, worker stopped then
  Film creation succeeds; Film/session persist across web restart; copied cookie
  after logout remains unauthorized after another restart.
- Local Docker I/O outage remains separate environment evidence; latest browser
  behavior is verified by independent CI, not relabeled as a local PASS.
- No new accepted exception/debt, no paid calls, no release G0–G5 acceptance claimed.
- Remaining action: local Docker recovery check and owner PR review. Rollback code
  without deleting data or downgrading BIGINT. Next product work is Story Planning
  & Approval after FC-001 acceptance, not another foundation increment.

### Local acceptance blocker — final
- `docker desktop restart --timeout 60` failed to stop Desktop/backend/WSL processes
  (context deadline exceeded). A subsequent bounded API probe still timed out.
- No force-kill, Docker reset/prune, or application volume deletion attempted.
- Code and clean-CI acceptance are complete; this feature is deliberately not marked
  DONE while local demonstration remains blocked by the Docker Desktop incident.
- Restoring the local Docker installation and rerunning the runbook's fresh test
  project/Compose smoke is the remaining local acceptance step. Existing data must
  be preserved. This environment incident is not an accepted code workaround/debt.
