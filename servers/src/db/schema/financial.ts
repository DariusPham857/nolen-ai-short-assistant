import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, integer, jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core';
import { films } from './films.js';
import { shotRevisions, storyRevisions } from './stories.js';

const money = (name: string) => bigint(name, { mode: 'bigint' });

/** Locked runtime projection for DEC-P02 budget admission. */
export const filmBudgetAccounts = pgTable('film_budget_accounts', {
  filmId: uuid('film_id').primaryKey().references(() => films.id),
  operatorId: text('operator_id').notNull(),
  budgetLimitUsdMicros: money('budget_limit_usd_micros').notNull(),
  actualSpentUsdMicros: money('actual_spent_usd_micros').notNull().default(sql`0`),
  reservedOpenUsdMicros: money('reserved_open_usd_micros').notNull().default(sql`0`),
  pendingLiabilityUsdMicros: money('pending_liability_usd_micros').notNull().default(sql`0`),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('film_budget_projection_nonnegative', sql`${table.budgetLimitUsdMicros} >= 0 AND ${table.actualSpentUsdMicros} >= 0 AND ${table.reservedOpenUsdMicros} >= 0 AND ${table.pendingLiabilityUsdMicros} >= 0 AND ${table.version} >= 0`),
  check('film_budget_pending_within_reserved', sql`${table.pendingLiabilityUsdMicros} <= ${table.reservedOpenUsdMicros}`),
]);

/** Append-only budget-limit audit, including the migration baseline. */
export const budgetLimitEvents = pgTable('budget_limit_events', {
  id: uuid('id').primaryKey(),
  filmId: uuid('film_id').notNull().references(() => films.id),
  actorId: text('actor_id').notNull(),
  priorLimitUsdMicros: money('prior_limit_usd_micros').notNull(),
  newLimitUsdMicros: money('new_limit_usd_micros').notNull(),
  reason: text('reason').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('budget_limit_event_values_nonnegative', sql`${table.priorLimitUsdMicros} >= 0 AND ${table.newLimitUsdMicros} >= 0`),
  check('budget_limit_event_reason_required', sql`length(trim(${table.reason})) BETWEEN 1 AND 1000`),
]);

/** Immutable price evidence selected before any reservation. */
export const rateCardSnapshots = pgTable('rate_card_snapshots', {
  id: uuid('id').primaryKey(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  operation: text('operation').notNull(),
  rateType: text('rate_type').notNull(),
  unitPriceUsdMicros: money('unit_price_usd_micros').notNull(),
  providerMaximumUsdMicros: money('provider_maximum_usd_micros'),
  effectiveAt: timestamp('effective_at', { withTimezone: true }).notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  sourceRef: text('source_ref').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('rate_card_type_valid', sql`${table.rateType} IN ('FIXED_PER_REQUEST','PER_SECOND')`),
  check('rate_card_values_valid', sql`${table.unitPriceUsdMicros} >= 0 AND (${table.providerMaximumUsdMicros} IS NULL OR ${table.providerMaximumUsdMicros} >= 0) AND ${table.expiresAt} > ${table.effectiveAt}`),
]);

/** One atomic billable execution unit; provider submission remains a later state. */
export const attempts = pgTable('attempts', {
  id: uuid('id').primaryKey(),
  filmId: uuid('film_id').notNull().references(() => films.id),
  storyRevisionId: uuid('story_revision_id').notNull().references(() => storyRevisions.id),
  shotRevisionId: uuid('shot_revision_id').references(() => shotRevisions.id),
  kind: text('kind').notNull(),
  provider: text('provider').notNull(),
  model: text('model').notNull(),
  rateCardSnapshotId: uuid('rate_card_snapshot_id').notNull().references(() => rateCardSnapshots.id),
  pricingUnits: integer('pricing_units').notNull(),
  reservationUsdMicros: money('reservation_usd_micros').notNull(),
  state: text('state').notNull().default('QUEUED'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('attempt_kind_valid', sql`${table.kind} IN ('IMAGE','VIDEO','TTS','ASSEMBLY')`),
  check('attempt_state_valid', sql`${table.state} IN ('QUEUED','SUBMITTED','SUBMISSION_UNCERTAIN','RUNNING','SUCCEEDED','FAILED','CANCELED')`),
  check('attempt_values_valid', sql`${table.pricingUnits} > 0 AND ${table.reservationUsdMicros} >= 0`),
  foreignKey({ columns: [table.filmId, table.storyRevisionId], foreignColumns: [storyRevisions.filmId, storyRevisions.id] }),
  foreignKey({ columns: [table.filmId, table.shotRevisionId], foreignColumns: [shotRevisions.filmId, shotRevisions.id] }),
  unique().on(table.filmId, table.shotRevisionId, table.kind, table.id),
]);

export const attemptFinancialState = pgTable('attempt_financial_state', {
  attemptId: uuid('attempt_id').primaryKey().references(() => attempts.id),
  billingStatus: text('billing_status').notNull().default('PENDING'),
  reservationOpenUsdMicros: money('reservation_open_usd_micros').notNull(),
  realizedUsdMicros: money('realized_usd_micros').notNull().default(sql`0`),
  pendingLiabilityUsdMicros: money('pending_liability_usd_micros').notNull().default(sql`0`),
  version: integer('version').notNull().default(0),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('attempt_billing_status_valid', sql`${table.billingStatus} IN ('PENDING','PARTIAL','FINAL','DISPUTED')`),
  check('attempt_financial_nonnegative', sql`${table.reservationOpenUsdMicros} >= 0 AND ${table.realizedUsdMicros} >= 0 AND ${table.pendingLiabilityUsdMicros} >= 0 AND ${table.version} >= 0`),
  check('attempt_financial_pending_within_reserved', sql`${table.pendingLiabilityUsdMicros} <= ${table.reservationOpenUsdMicros}`),
]);

/** Immutable financial journal. Amount is signed only for explicit corrections/adjustments. */
export const costLedgerEvents = pgTable('cost_ledger_events', {
  id: uuid('id').primaryKey(),
  filmId: uuid('film_id').notNull().references(() => films.id),
  attemptId: uuid('attempt_id').notNull().references(() => attempts.id),
  eventType: text('event_type').notNull(),
  amountUsdMicros: money('amount_usd_micros').notNull(),
  billingStatus: text('billing_status').notNull(),
  evidence: jsonb('evidence').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('ledger_event_type_valid', sql`${table.eventType} IN ('RESERVATION_CREATED','CHARGE_POSTED','RESERVATION_RELEASED','CHARGE_CORRECTED','RESERVATION_ADJUSTED')`),
  check('ledger_billing_status_valid', sql`${table.billingStatus} IN ('PENDING','PARTIAL','FINAL','DISPUTED')`),
  check('ledger_nonzero_correction', sql`${table.eventType} IN ('CHARGE_CORRECTED','RESERVATION_ADJUSTED') OR ${table.amountUsdMicros} >= 0`),
]);

export const financialCommandReceipts = pgTable('financial_command_receipts', {
  id: uuid('id').primaryKey(),
  filmId: uuid('film_id').notNull().references(() => films.id),
  operatorId: text('operator_id').notNull(),
  key: uuid('key').notNull(),
  command: text('command').notNull(),
  requestHash: text('request_hash').notNull(),
  response: jsonb('response').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [unique('financial_receipt_key').on(table.filmId, table.operatorId, table.key)]);

/** SQL outbox is the durable dispatch intent; queue state is not billing evidence. */
export const dispatchOutbox = pgTable('dispatch_outbox', {
  id: uuid('id').primaryKey(),
  attemptId: uuid('attempt_id').notNull().unique().references(() => attempts.id),
  queueName: text('queue_name').notNull(),
  payload: jsonb('payload').notNull(),
  status: text('status').notNull().default('PENDING'),
  enqueueOutcome: text('enqueue_outcome').notNull().default('NOT_ATTEMPTED'),
  bossJobId: uuid('boss_job_id'),
  leaseOwner: text('lease_owner'),
  leaseExpiresAt: timestamp('lease_expires_at', { withTimezone: true }),
  retryCount: integer('retry_count').notNull().default(0),
  nextAttemptAt: timestamp('next_attempt_at', { withTimezone: true }).notNull().defaultNow(),
  deliveredAt: timestamp('delivered_at', { withTimezone: true }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('dispatch_outbox_status_valid', sql`${table.status} IN ('PENDING','DELIVERING','DELIVERED')`),
  check('dispatch_outcome_valid', sql`${table.enqueueOutcome} IN ('NOT_ATTEMPTED','JOB_ID','NULL_UNVERIFIED','UNKNOWN_ENQUEUE_OUTCOME','WORKER_CONFIRMED')`),
  check('dispatch_retry_nonnegative', sql`${table.retryCount} >= 0`),
]);

/** Unique worker claim separates internal delivery from external provider submission. */
export const outboundDispatches = pgTable('outbound_dispatches', {
  attemptId: uuid('attempt_id').primaryKey().references(() => attempts.id),
  state: text('state').notNull().default('NOT_STARTED'),
  claimToken: uuid('claim_token').notNull(),
  providerJobId: text('provider_job_id'),
  providerRequestFingerprint: text('provider_request_fingerprint'),
  claimedAt: timestamp('claimed_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
}, table => [
  check('outbound_dispatch_state_valid', sql`${table.state} IN ('NOT_STARTED','SUBMITTING','SUBMITTED','SUBMISSION_UNCERTAIN')`),
]);

