# FC-001 tasks and evidence

Status: IN_PROGRESS
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
