# FI-001 tasks

Status: IMPLEMENTED_VERIFIED_PENDING_CI_AND_OWNER_SIGNOFF
Source: [approved specification](spec.md)

## Tasks

| Task | Scope and dependency | Verification / acceptance |
|---|---|---|
| G1-SIGNOFF | PASS: recorded accepted G1 without changing runtime | `pnpm check:evidence`; SP-001 status and merge evidence |
| FI-01 | PASS: Financial Core contracts and partial/deferred boundaries frozen | evidence validator; AT-P02-01–20 mapped |
| FI-02 | PASS: additive state-4 projection constraint; state-3 upgrade/rollback evidence | PostgreSQL 16 migration/preflight/drift tests; supplemental migration acceptance |
| FI-03 | PASS: checked micros, rates, reservation and projection domain | unit/boundary tests; AT-01/06/07/10 |
| FI-04a | PASS: pinned pg-boss 10.4.2 send/null/crash compatibility | PostgreSQL 16 + pg-boss integration; AT-14/15 |
| FI-04b | PASS: atomic admission, receipts, ledger, outbox and worker claim | concurrency/integration tests; AT-02–05/11 |
| FI-05 | PASS: settlement and reconciliation transitions | PostgreSQL integration; AT-12/13/18 |
| FI-06 | PASS: protected Financial API and exact JSON DTOs | Hono/PG16 tests; AT-16/20 |
| FI-07 | PASS: budget status and limit audit UI | Playwright production flow; AT-17 |
| FI-08 | PASS locally: full verification, Compose and adversarial review | no BLOCK; patch CI and owner sign-off remain external |

## Handoff

Baseline: `main@919d47d` (PR #7 merged). Correctness remediation is isolated on
`fix/financial-integrity-correctness-v2`; no G3/provider work is included.

- G1-SIGNOFF: [SP spec](../story-planning/spec.md) and [tasks](../story-planning/tasks.md)
  updated to `G1_ACCEPTED`; `pnpm check:evidence` PASS (20 documents). Commit
  `15774b4`; branch pushed. GitHub App PR creation is BLOCKED by connector 403, so
  FI-001 preserves the commit in its branch rather than falsely claiming a merged PR.
- FI-01: this spec/task pair is the canonical FI-001 behavior/evidence source.
- No provider key, paid call, G3 implementation, migration reset, dependency upgrade,
  C4 change or debt exception is authorized.

### Registered files and interfaces

- `packages/contracts/src/financial.ts`: exact-money command and DTO contracts.
- `servers/src/db/schema/financial.ts`, immutable migration `0002_sloppy_lilandra.sql`,
  additive migration `0003_tough_quicksilver.sql`, and `state-4.json`: accounts,
  attempts, immutable ledger/audit, receipts, outbox and pending-within-reserved guards.
- `servers/src/financial/`: checked arithmetic, atomic admission, reconciliation,
  pinned queue relay recovery and durable worker claim.
- `servers/src/http/financial-api.ts`: protected budget, estimate, attempt, ledger,
  summary and reconciliation routes.
- `clients/components/budget.tsx` and `/films/[id]/budget`: exact projection and audited
  budget-limit UI.
- PostgreSQL, migration, API, Playwright and Compose checks cover AT-P02-01–20 at the
  explicit partial/deferred boundaries in the specification.

### Verification evidence (2026-11-21 correctness remediation)

- `pnpm test`: PASS, contracts 5/5 and server unit 21/21.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: PASS. The first sandboxed build hit
  Windows `EPERM` under `.next`; the unrestricted rerun completed successfully.
- `pnpm test:guardrails`: PASS 4/4; `pnpm test:evidence`: PASS 4/4;
  `pnpm check:evidence`: PASS for 22 documents; client boundary: PASS 2/2.
- `pnpm test:integration -- --silent` on PostgreSQL 16: PASS 34/34, including
  state-3 to state-4 preservation/rollback, stale versions, current Story approval
  evidence, overage, corrections, projection audit and lock-order concurrency.
- `pnpm db:migrate`: PASS with exact state-4 preflight; applied migration `0002`
  remained unchanged.
- `pnpm test:e2e`: PASS 10/10. Isolated `fi001-correctness-v2` Compose smoke:
  PASS for migration, web/worker health, Film/Story approval, budget persistence and
  restart. Its containers/network/volume were removed after verification.
- Patch GitHub Actions: pending push; a missing run is not PASS.

### Delivery status

- Branch `fix/financial-integrity-correctness-v2` is based on merged PR #7 at
  `main@919d47d`; patch commit/PR/CI evidence will be recorded after publication.
- No BLOCK or accepted CONTAIN exception remains in the local review. Patch CI, G2
  owner acceptance and provider-specific G3 obligations remain external.

### Review result and deferred obligations

Read-only diff/caller/test review found no BLOCK or accepted CONTAIN exception. Queue
delivery is not provider submission or billing evidence. `AT-P02-11`, `AT-P02-18` and
`AT-P02-20` remain explicitly partial until G3/provider and benchmark work. CI evidence
will be linked from the PR; owner sign-off is external. Final status cannot exceed
`IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF` without owner acceptance.
