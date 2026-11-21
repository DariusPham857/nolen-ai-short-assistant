# FI-001 tasks

Status: IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF
Source: [approved specification](spec.md)

## Tasks

| Task | Scope and dependency | Verification / acceptance |
|---|---|---|
| G1-SIGNOFF | PASS: recorded accepted G1 without changing runtime | `pnpm check:evidence`; SP-001 status and merge evidence |
| FI-01 | PASS: Financial Core contracts and partial/deferred boundaries frozen | evidence validator; AT-P02-01–20 mapped |
| FI-02 | PASS: additive state-3 schema, backfill and immutable guards | PostgreSQL 16 migration/preflight/drift tests; AT-08/19 |
| FI-03 | PASS: checked micros, rates, reservation and projection domain | unit/boundary tests; AT-01/06/07/10 |
| FI-04a | PASS: pinned pg-boss 10.4.2 send/null/crash compatibility | PostgreSQL 16 + pg-boss integration; AT-14/15 |
| FI-04b | PASS: atomic admission, receipts, ledger, outbox and worker claim | concurrency/integration tests; AT-02–05/11 |
| FI-05 | PASS: settlement and reconciliation transitions | PostgreSQL integration; AT-12/13/18 |
| FI-06 | PASS: protected Financial API and exact JSON DTOs | Hono/PG16 tests; AT-16/20 |
| FI-07 | PASS: budget status and limit audit UI | Playwright production flow; AT-17 |
| FI-08 | PASS locally: full verification, Compose and adversarial review | no BLOCK; CI and owner sign-off remain external |

## Handoff

Baseline: FI branch is stacked on G1 sign-off commit `15774b4`; runtime baseline is
`main@d4e59c38838776982bf3c5a9fc8be4433eef34b2` (PR #6 merged).

- G1-SIGNOFF: [SP spec](../story-planning/spec.md) and [tasks](../story-planning/tasks.md)
  updated to `G1_ACCEPTED`; `pnpm check:evidence` PASS (20 documents). Commit
  `15774b4`; branch pushed. GitHub App PR creation is BLOCKED by connector 403, so
  FI-001 preserves the commit in its branch rather than falsely claiming a merged PR.
- FI-01: this spec/task pair is the canonical FI-001 behavior/evidence source.
- No provider key, paid call, G3 implementation, migration reset, dependency upgrade,
  C4 change or debt exception is authorized.

### Registered files and interfaces

- `packages/contracts/src/financial.ts`: exact-money command and DTO contracts.
- `servers/src/db/schema/financial.ts`, migration `0002_sloppy_lilandra.sql`, and
  `state-3.json`: accounts, attempts, immutable ledger/audit, receipts and outbox.
- `servers/src/financial/`: checked arithmetic, atomic admission, reconciliation,
  pinned queue relay recovery and durable worker claim.
- `servers/src/http/financial-api.ts`: protected budget, estimate, attempt, ledger,
  summary and reconciliation routes.
- `clients/components/budget.tsx` and `/films/[id]/budget`: exact projection and audited
  budget-limit UI.
- PostgreSQL, migration, API, Playwright and Compose checks cover AT-P02-01–20 at the
  explicit partial/deferred boundaries in the specification.

### Verification evidence (2026-11-21)

- `pnpm test`: PASS, contracts 5/5 and server unit 21/21.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: PASS. The build and client negative
  boundary fixture required an unrestricted rerun after Windows sandbox `EPERM`.
- `pnpm test:guardrails`: PASS 4/4; `pnpm test:evidence`: PASS 4/4;
  `pnpm check:evidence`: PASS for 22 documents; client boundary: PASS 2/2.
- `pnpm test:integration` on PostgreSQL 16: PASS 31/31 across migration, Film, Story,
  Financial Core and health suites, including same-key concurrency, backfill,
  immutable drift, pg-boss 10.4.2 job-ID/null/throw recovery and one durable claim.
- `pnpm test:e2e`: PASS 10/10, including budget audit persistence after reload.
- isolated `fi001-review` Compose smoke: PASS for migration, web/worker health,
  Film/Story approval, FI budget persistence and restart. Test-owned containers and
  volume were removed after verification.
- GitHub Actions run
  [`44871385409`](https://github.com/DariusPham857/nolen-ai-short-assistant/actions/runs/44871385409):
  PASS for both `film` and `compose` jobs at implementation commit `d52a4fd`.

### Delivery status

- Branch `feature/financial-integrity` contains `b50eee2` (Financial Core) and
  `d52a4fd` (UI/acceptance evidence), stacked on G1 sign-off `15774b4`.
- GitHub App PR creation returned `403 Resource not accessible by integration`.
  No PR or merge is claimed; the owner can open the prepared branch at
  <https://github.com/DariusPham857/nolen-ai-short-assistant/pull/new/feature/financial-integrity>.
- No BLOCK or accepted CONTAIN exception remains in FI-001 local/CI review. G2 owner
  acceptance and provider-specific G3 obligations remain external.

### Review result and deferred obligations

Read-only diff/caller/test review found no BLOCK or accepted CONTAIN exception. Queue
delivery is not provider submission or billing evidence. `AT-P02-11`, `AT-P02-18` and
`AT-P02-20` remain explicitly partial until G3/provider and benchmark work. CI evidence
will be linked from the PR; owner sign-off is external. Final status cannot exceed
`IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF` without owner acceptance.
