# FI-001 — Financial Ledger & Atomic Budget Admission (G2)

Status: IMPLEMENTED_VERIFIED_PENDING_OWNER_SIGNOFF
Source: [PRD v1.0 §17](../../docs/PRD/PRD_AI_Short_Film_Assistant_v1.0.md)

## Goal

[DECIDED] An authenticated Producer can inspect a Film budget, estimate a supported
billable attempt, atomically reserve funds before durable dispatch intent, and audit
append-only financial events using exact integer USD micros. This slice establishes
the Financial Core only; it does not submit to a paid provider or claim G3.

## Scope

- **REQUIRED:** budget account/backfill, budget-limit audit, versioned rate cards,
  checked money arithmetic, Attempt financial admission, append-only ledger,
  financial command receipts, durable dispatch outbox, settlement/reconciliation,
  protected API/read projection, budget UI, PostgreSQL 16 and browser evidence.
- **PREREQUISITE:** record accepted G1 status; verify the pinned `pg-boss@10.4.2`
  queue contract before relying on its enqueue result.
- **DEFER:** paid provider calls, provider-specific exactly-once guarantees,
  `SUBMISSION_UNCERTAIN` external reconciliation, media/export and benchmark reports.

## Invariants

- [DECIDED] Money is PostgreSQL `BIGINT`, TypeScript `bigint`, and decimal strings
  in JSON. Arithmetic is range checked against signed 64-bit bounds; projections,
  reservations and confirmed spend cannot become negative.
- [DECIDED] Admission runs at `READ COMMITTED`, locks one `film_budget_accounts`
  row, then rechecks durable receipt and budget state. Same key/same normalized
  payload returns one Attempt; changed payload conflicts. Unique constraints are the
  second concurrency barrier. No automatic transaction retry changes the key.
- [DECIDED] Reserve before dispatch:
  `actualSpent + reservedOpen + nextReservation <= budgetLimit`.
  A variable estimate reserves `max(providerMaximum, ceil(baseEstimate * 12000/10000))`.
  Fixed rates reserve the quoted amount. Missing, stale or unsupported rates block.
- [DECIDED] `cost_ledger_events` and `budget_limit_events` are append-only.
  `film_budget_accounts` is the locked runtime projection; immutable events remain
  audit evidence. Corrections are new events and cannot make spend/reservations negative.
- [DECIDED] Warning threshold is 8000 basis points. Budget decrease is allowed only
  when the new limit covers confirmed spend plus open reservations.
- [DECIDED] Queue delivery, provider submission and financial reconciliation are
  distinct. Queue acknowledgement is never billing evidence. One Attempt owns one
  reservation and one durable outbox intent.
- [DECIDED] `dispatch_outbox.attempt_id` and worker claims are durable correctness
  boundaries. `singletonKey` is only an optimization. A duplicate queue message cannot
  create Attempt, reservation, ledger or a second submission claim.
- [DECIDED] Verified against pinned `pg-boss@10.4.2`: a job ID is enqueue evidence; `null` requires
  independent queue evidence before `DELIVERED`; throw/timeout records an unknown
  enqueue outcome. Crash recovery reuses the existing outbox intent.

## API contract

All routes share the current Host/Origin/session/error boundary and `no-store` policy.
Mutations require UUID-v4 `Idempotency-Key`; all money fields are decimal strings.

- `GET /api/films/:filmId/budget`
- `POST /api/films/:filmId/budget/estimate`
- `PATCH /api/films/:filmId/budget`
- `POST /api/films/:filmId/attempts`
- `GET /api/films/:filmId/costs/ledger`
- `GET /api/films/:filmId/costs/summary`
- `GET /api/attempts/:attemptId/financials`
- `POST /api/attempts/:attemptId/reconcile`

Attempt admission accepts an approved Story/Shot revision, attempt type, supported
rate-card snapshot and pricing units. It creates Attempt, reservation ledger event,
projection update, command receipt and outbox row in one transaction. Runtime has no
implicit fake provider/rate card; deterministic fixtures are test-only.

## Acceptance criteria

- `AT-P02-01` exact micros survive create, projection, ledger and JSON beyond JS safe integers.
- `AT-P02-02` admission atomically creates one Attempt/reservation/outbox and never overspends.
- `AT-P02-03` 20 concurrent same-key requests return one Attempt and one financial admission.
- `AT-P02-04` different keys competing for insufficient headroom admit only the valid subset.
- `AT-P02-05` changed payload under a used key returns conflict without writes.
- `AT-P02-06` missing/stale/unsupported rate card blocks before reservation.
- `AT-P02-07` checked arithmetic rejects overflow and invalid negative projections.
- `AT-P02-08` append-only guards reject UPDATE/DELETE of ledger and budget-limit events.
- `AT-P02-09` budget limit changes are audited; unsafe decrease is rejected.
- `AT-P02-10` 80% warning and available/pending/reserved projections are exact.
- `AT-P02-11` PARTIAL: internal duplicate delivery/claim safety only; provider exactly-once is G3.
- `AT-P02-12` charge/release/adjust/correct settlement preserves projection invariants.
- `AT-P02-13` unknown/delayed charge remains PENDING or DISPUTED, never assumed zero.
- `AT-P02-14` outbox `send()` ID/null/throw paths do not create another admission.
- `AT-P02-15` crash after enqueue but before acknowledgement is recoverable by attempt ID.
- `AT-P02-16` all APIs enforce auth/ownership/Host/Origin/idempotency/error envelopes.
- `AT-P02-17` browser shows Limit, Spent, Reserved, Pending and Available after reload.
- `AT-P02-18` PARTIAL: deterministic billing-adapter reconciliation only; provider evidence is G3.
- `AT-P02-19` migration backfills one account/audit baseline per existing Film without reset.
- `AT-P02-20` PARTIAL: ledger JSON/API evidence only; benchmark export is a later feature.

## Open Questions / Blocked Contracts

None for Financial Core implementation. `FI-04a` verified the pinned
`pg-boss@10.4.2` job-ID/null behavior, duplicate enqueue recovery, and durable single
worker claim on PostgreSQL 16. Provider-specific submission and billing evidence remain
deferred G3 obligations; this is not authorization to upgrade pg-boss, add a distributed
lock, or start provider work.

