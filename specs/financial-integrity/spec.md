# FI-001 — Financial Ledger & Atomic Budget Admission (G2)

Status: IMPLEMENTED_VERIFIED_PENDING_CI_AND_OWNER_SIGNOFF
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

Canonical PRD identifiers retain their original meaning:

- `AT-P02-01` boundary equality (`B=10,S=6,R=2,N=2`) admits exactly one reservation and dispatch intent.
- `AT-P02-02` an over-budget request is rejected without Attempt, reservation, outbox or provider side effect.
- `AT-P02-03` concurrent requests competing for one remaining allowance admit exactly one under the account lock.
- `AT-P02-04` same key and payload replay the same Attempt without duplicate financial state.
- `AT-P02-05` same key with changed payload returns `409 IDEMPOTENCY_CONFLICT` without writes.
- `AT-P02-06` successful billing posts the realized charge and releases the unused reservation exactly once.
- `AT-P02-07` provider overage is fully recorded, exposes negative headroom with zero available, and blocks new admissions.
- `AT-P02-08` an unknown charge remains `PENDING`; its liability stays inside the open reservation.
- `AT-P02-09` confirmed non-acceptance/no-charge releases the full reservation once and retains the failed Attempt.
- `AT-P02-10` duplicate completion/reconciliation replays one canonical settlement.
- `AT-P02-11` **PARTIAL/DEFERRED:** internal ambiguous enqueue recovery exists; external `SUBMISSION_UNCERTAIN` provider reconciliation belongs to G3.
- `AT-P02-12` a versioned budget increase appends audit evidence and never auto-launches a blocked job.
- `AT-P02-13` concurrent/stale budget edits return `409 VERSION_CONFLICT`; only the accepted edit is audited.
- `AT-P02-14` a decrease below spent plus open reservations is rejected without mutation.
- `AT-P02-15` crossing 80% warns while eligible jobs within the hard limit remain admissible.
- `AT-P02-16` missing, stale or unsupported rate-card input blocks before dispatch.
- `AT-P02-17` a later correction is append-only, links the prior charge event and recomputes projections.
- `AT-P02-18` **PARTIAL/DEFERRED:** Financial Core records realized charges; rejected-media/provider/export evidence belongs to G3+.
- `AT-P02-19` **PARTIAL/DEFERRED:** a manual retry is a new financial Attempt; rejected-media workflow belongs to a later feature.
- `AT-P02-20` **PARTIAL/DEFERRED:** internal queue redelivery has one durable claim; remotely chargeable submission guarantees depend on G3 provider support.

Supplemental FI-001 acceptance covers checked `BIGINT` overflow, state-3 to state-4
migration compatibility, append-only drift, protected API envelopes, exact JSON DTOs,
pg-boss 10.4.2 ID/null/throw recovery, active/current Story approval evidence,
projection audit, and browser persistence. These checks do not redefine the PRD IDs.

## Open Questions / Blocked Contracts

None for Financial Core implementation. `FI-04a` verified the pinned
`pg-boss@10.4.2` job-ID/null behavior, duplicate enqueue recovery, and durable single
worker claim on PostgreSQL 16. Provider-specific submission and billing evidence remain
deferred G3 obligations; this is not authorization to upgrade pg-boss, add a distributed
lock, or start provider work.

