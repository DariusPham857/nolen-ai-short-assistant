# FI-001 tasks

Status: IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF
Source: [approved specification](spec.md)

## Tasks

| Task | Scope and dependency | Verification / acceptance |
|---|---|---|
| G1-SIGNOFF | PASS: recorded accepted G1 without changing runtime | `pnpm check:evidence`; SP-001 status and merge evidence |
| FI-01 | PASS: Financial Core contracts and partial/deferred boundaries frozen | evidence validator; AT-P02-01–20 mapped |
| FI-02 | PASS: additive state-4 projection constraint; state-3 upgrade/rollback evidence | PostgreSQL 16 migration/preflight/drift tests; supplemental migration acceptance |
| FI-03 | PASS: checked micros, rates, reservation and projection domain | unit/boundary tests; AT-01/06/07/10 |
| FI-04a | PASS: pinned pg-boss 10.4.2 send/null/crash compatibility | PostgreSQL 16 + pg-boss integration; AT-14/15 |
| FI-04b | PASS: atomic admission with film row synchronization, receipts, ledger, outbox and worker claim | concurrency/interleaving tests; AT-02–05/11 |
| FI-05 | PASS: settlement, reconciliation transitions and repeatable-read audit snapshot | PostgreSQL integration; AT-12/13/18 |
| FI-06 | PASS: protected Financial API and exact JSON DTOs | Hono/PG16 tests; AT-16/20 |
| FI-07 | PASS: budget status and limit audit UI | Playwright production flow; AT-17 |
| FI-08 | PASS locally: full verification, Compose and adversarial review | no BLOCK; patch CI and owner sign-off remain external |

## Handoff

Baseline: `main@b2b16ff` (PR #8 merged). Correctness remediation v2 is isolated on
`fix/fi-001-race-and-audit`; no G3/provider work is included.

- FI-01: this spec/task pair is the canonical FI-001 behavior/evidence source.
- No provider key, paid call, G3 implementation, migration reset, dependency upgrade,
  C4 change or debt exception is authorized.
- Remediated findings:
  1. Story mutation vs. admission race: Added `FOR UPDATE OF f` to the story validation
     query in `admitAttempt`, enforcing the global lock hierarchy
     `film_budget_accounts` -> `films` -> `attempt_financial_state`. Prevents admission
     from committing on a superseded StoryRevision during concurrent mutation.
  2. Audit projection false drift: Wrapped `auditFinancialProjection` in a single
     `REPEATABLE READ READ ONLY` transaction, ensuring account, ledger and attempt
     sums are evaluated against a consistent snapshot without false drift or auto-repair.

### Registered files and interfaces

- `packages/contracts/src/financial.ts`: exact-money command and DTO contracts.
- `servers/src/db/schema/financial.ts`, immutable migration `0002_sloppy_lilandra.sql`,
  additive migration `0003_tough_quicksilver.sql`, and `state-4.json`: accounts,
  attempts, immutable ledger/audit, receipts, outbox and pending-within-reserved guards.
- `servers/src/financial/`: checked arithmetic, atomic admission with Film lock,
  reconciliation, repeatable-read audit snapshot, pinned queue relay recovery and durable claim.
- `servers/src/http/financial-api.ts`: protected budget, estimate, attempt, ledger,
  summary and reconciliation routes.
- `clients/components/budget.tsx` and `/films/[id]/budget`: exact projection and audited
  budget-limit UI.
- PostgreSQL, migration, API, Playwright and Compose checks cover AT-P02-01–20 at the
  explicit partial/deferred boundaries in the specification.

### Verification evidence (2026-11-22 correctness remediation v2)

- `pnpm test`: PASS, contracts 5/5 and server unit 21/21.
- `pnpm lint`, `pnpm typecheck`, `pnpm build`: PASS (0 errors, 0 warnings).
- `pnpm test:guardrails`: PASS 4/4; `pnpm test:evidence`: PASS 4/4;
  `pnpm check:evidence`: PASS for 22 documents; client boundary: PASS 2/2.
- PostgreSQL 16 interleaving tests in `financial.integration.test.ts`:
  1. `blocks attempt admission from committing on a superseded StoryRevision during concurrent mutation`: PASS.
  2. `guarantees consistent audit snapshot without false drift during concurrent settlement`: PASS.
- Pre-existing PR #8 CI: push run [`44878462711`](https://github.com/DariusPham857/nolen-ai-short-assistant/actions/runs/44878462711)
  passed for both `film` and `compose` jobs before merge commit `b2b16ff`.

### Delivery status

- Branch `fix/fi-001-race-and-audit` is branched directly from `origin/main` at `b2b16ff`.
- PR creation link:
  <https://github.com/DariusPham857/nolen-ai-short-assistant/pull/new/fix/fi-001-race-and-audit>.
- No BLOCK or accepted CONTAIN exception remains in local review. G2 owner
  acceptance and provider-specific G3 obligations remain external.

### Review result and deferred obligations

Read-only diff/caller/test review found no BLOCK or accepted CONTAIN exception. Queue
delivery is not provider submission or billing evidence. `AT-P02-11`, `AT-P02-18` and
`AT-P02-20` remain explicitly partial until G3/provider and benchmark work. CI evidence
will be linked from the PR; owner sign-off is external. Final status cannot exceed
`IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF` without owner acceptance.

### Review result and deferred obligations

Read-only diff/caller/test review found no BLOCK or accepted CONTAIN exception. Queue
delivery is not provider submission or billing evidence. `AT-P02-11`, `AT-P02-18` and
`AT-P02-20` remain explicitly partial until G3/provider and benchmark work. CI evidence
will be linked from the PR; owner sign-off is external. Final status cannot exceed
`IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF` without owner acceptance.
