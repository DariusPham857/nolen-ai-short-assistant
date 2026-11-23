import { randomUUID } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { pgClient } from '../db/index.js';
import { migrateDatabase } from '../db/migrate.js';
import {
  dispatchAttempt,
  markSubmissionUncertain,
  recoverStaleSubmissions,
} from './service.js';
import { relayOne, resetExhaustedOutbox } from '../financial/outbox.js';
import type { ProviderAdapter } from '../providers/index.js';
import type { GenerationRequest } from '@nolen/contracts';

const isLiveDb = Boolean(process.env.DATABASE_URL);

describe.runIf(isLiveDb)('Dispatch & Recovery Integration Tests (PostgreSQL 16) — BLOCK 1, 2, 4', () => {
  beforeAll(async () => {
    await migrateDatabase(process.env.DATABASE_URL!);
  });

  afterAll(async () => {
    await pgClient.end();
  });

  async function seedAttemptFixture(openReservation = '500000') {
    const filmId = randomUUID();
    const storyRevisionId = randomUUID();
    const rateCardSnapshotId = randomUUID();
    const attemptId = randomUUID();

    await pgClient.begin(async tx => {
      await tx`INSERT INTO films(id, title, brief, budget_limit_usd_micros, operator_id, idempotency_key, request_hash)
        VALUES(${filmId}, 'Dispatch Test', 'Integration fixture', 10000000, 'operator-1', ${randomUUID()}, 'fixture-hash')`;

      await tx`INSERT INTO film_budget_accounts(film_id, operator_id, budget_limit_usd_micros, reserved_open_usd_micros, pending_liability_usd_micros)
        VALUES(${filmId}, 'operator-1', 10000000, ${openReservation}, 0)`;

      await tx`INSERT INTO story_revisions(id, film_id, revision_no, state, content, content_hash)
        VALUES(${storyRevisionId}, ${filmId}, 1, 'APPROVED', '{}'::jsonb, 'fixture-hash')`;

      await tx`INSERT INTO rate_card_snapshots(id, provider, model, operation, rate_type, unit_price_usd_micros, effective_at, expires_at, source_ref)
        VALUES(${rateCardSnapshotId}, 'GEMINI', 'gemini-3.1-flash-image', 'IMAGE', 'FIXED_PER_REQUEST', ${openReservation}, '2026-01-01', '2027-01-01', 'fixture')`;

      await tx`INSERT INTO attempts(id, film_id, story_revision_id, shot_revision_id, kind, provider, model, rate_card_snapshot_id, pricing_units, reservation_usd_micros, state)
        VALUES(${attemptId}, ${filmId}, ${storyRevisionId}, null, 'IMAGE', 'GEMINI', 'gemini-3.1-flash-image', ${rateCardSnapshotId}, 1, ${openReservation}, 'QUEUED')`;

      await tx`INSERT INTO attempt_financial_state(attempt_id, billing_status, reservation_open_usd_micros, realized_usd_micros, pending_liability_usd_micros)
        VALUES(${attemptId}, 'PENDING', ${openReservation}, 0, 0)`;
    });

    const request: GenerationRequest = {
      attemptId,
      filmId,
      kind: 'IMAGE',
      provider: 'GEMINI',
      executionMode: 'REPLAY',
      prompt: 'Test prompt for dispatch integration',
      aspectRatio: '9:16',
    };

    return { filmId, attemptId, request };
  }

  it('BLOCK 1: markSubmissionUncertain locks hierarchy and sets pending liability without SQL errors', async () => {
    const { filmId, attemptId } = await seedAttemptFixture('500000');

    // Seed outbound dispatch
    await pgClient`INSERT INTO outbound_dispatches(attempt_id, state, claim_token)
      VALUES(${attemptId}, 'SUBMITTING', ${randomUUID()})`;

    // Call markSubmissionUncertain
    const result = await markSubmissionUncertain(attemptId, 'Simulated transport exception');
    expect(result.state).toBe('SUBMISSION_UNCERTAIN');
    expect(result.pendingLiabilityHeld).toBe('500000');

    // Verify database state: attempt, attempt_financial_state, film_budget_accounts, outbound_dispatches
    const [att] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptId}`;
    expect(att.state).toBe('SUBMISSION_UNCERTAIN');

    const [fin] = await pgClient<{
      pending_liability_usd_micros: string;
      reservation_open_usd_micros: string;
    }[]>`SELECT pending_liability_usd_micros, reservation_open_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId}`;
    expect(fin.pending_liability_usd_micros).toBe('500000');
    expect(fin.reservation_open_usd_micros).toBe('500000');

    const [budget] = await pgClient<{
      pending_liability_usd_micros: string;
      reserved_open_usd_micros: string;
    }[]>`SELECT pending_liability_usd_micros, reserved_open_usd_micros FROM film_budget_accounts WHERE film_id = ${filmId}`;
    expect(budget.pending_liability_usd_micros).toBe('500000');
    expect(budget.reserved_open_usd_micros).toBe('500000');

    const [dispatch] = await pgClient<{ state: string }[]>`SELECT state FROM outbound_dispatches WHERE attempt_id = ${attemptId}`;
    expect(dispatch.state).toBe('SUBMISSION_UNCERTAIN');
  });

  it('BLOCK 1: dispatchAttempt transitions cleanly to SUBMISSION_UNCERTAIN on provider transport exception', async () => {
    const { attemptId, request } = await seedAttemptFixture('750000');

    const failingAdapter: ProviderAdapter = {
      kind: 'GEMINI',
      executionMode: 'REPLAY',
      isFake: true,
      submit: vi.fn().mockRejectedValue(new Error('ETIMEDOUT: Connection dropped during POST')),
      pollStatus: vi.fn(),
      reconcile: vi.fn(),
    };

    const outcome = await dispatchAttempt(request, failingAdapter);
    expect(outcome.outcome).toBe('SUBMISSION_UNCERTAIN');

    // Pending liability held
    const [fin] = await pgClient<{
      pending_liability_usd_micros: string;
    }[]>`SELECT pending_liability_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId}`;
    expect(fin.pending_liability_usd_micros).toBe('750000');
  });

  it('BLOCK 2: stale SUBMITTING lease transitions to SUBMISSION_UNCERTAIN without provider resubmission', async () => {
    const { attemptId, request } = await seedAttemptFixture('600000');

    // Seed stale SUBMITTING claim older than 30s
    await pgClient`INSERT INTO outbound_dispatches(attempt_id, state, claim_token, claimed_at)
      VALUES(${attemptId}, 'SUBMITTING', ${randomUUID()}, now() - interval '60 seconds')`;

    const adapter: ProviderAdapter = {
      kind: 'GEMINI',
      executionMode: 'REPLAY',
      isFake: true,
      submit: vi.fn(),
      pollStatus: vi.fn(),
      reconcile: vi.fn(),
    };

    // Dispatch attempt encountering stale claim
    const outcome = await dispatchAttempt(request, adapter, { staleLeaseTimeoutMs: 30000 });
    expect(outcome.outcome).toBe('SUBMISSION_UNCERTAIN');
    expect((outcome as { reason: string }).reason).toBe('RECOVERED_STALE_SUBMITTING');

    // CRITICAL: submit was NEVER called
    expect(adapter.submit).not.toHaveBeenCalled();

    // Check DB state
    const [dispatch] = await pgClient<{ state: string }[]>`SELECT state FROM outbound_dispatches WHERE attempt_id = ${attemptId}`;
    expect(dispatch.state).toBe('SUBMISSION_UNCERTAIN');
  });

  it('BLOCK 2: recoverStaleSubmissions sweeper detects and recovers expired claims', async () => {
    const { attemptId } = await seedAttemptFixture('400000');

    await pgClient`INSERT INTO outbound_dispatches(attempt_id, state, claim_token, claimed_at)
      VALUES(${attemptId}, 'SUBMITTING', ${randomUUID()}, now() - interval '45 seconds')`;

    const recovered = await recoverStaleSubmissions(30000);
    expect(recovered.some(r => r.attemptId === attemptId && r.recovered)).toBe(true);

    const [dispatch] = await pgClient<{ state: string }[]>`SELECT state FROM outbound_dispatches WHERE attempt_id = ${attemptId}`;
    expect(dispatch.state).toBe('SUBMISSION_UNCERTAIN');
  });

  it('CAS Race: slow submit returning after sweeper execution does not overwrite SUBMISSION_UNCERTAIN and triggers reconciliation', async () => {
    const { attemptId, request } = await seedAttemptFixture('800000');

    // Slow adapter: during submit, interleaves a sweeper run that marks submission uncertain!
    const slowAdapter: ProviderAdapter = {
      kind: 'GEMINI',
      executionMode: 'REPLAY',
      isFake: true,
      submit: vi.fn().mockImplementation(async () => {
        // Interleaved race condition: while HTTP is in flight, sweeper marks attempt uncertain!
        await markSubmissionUncertain(attemptId, 'Sweeper expired stale lease during slow HTTP response');
        return {
          attemptId,
          providerJobId: 'slow-job-recovered-123',
          state: 'SUBMITTED',
          executionMode: 'REPLAY',
          provenance: 'REPLAY_FIXTURE',
          submittedAt: new Date().toISOString(),
        };
      }),
      pollStatus: vi.fn(),
      reconcile: vi.fn().mockResolvedValue({
        attemptId,
        providerJobId: 'slow-job-recovered-123',
        outcome: 'CONFIRMED_RUNNING',
        evidence: 'Reconciled in-flight job verified with remote provider',
      }),
    };

    const outcome = await dispatchAttempt(request, slowAdapter);
    expect(outcome.outcome).toBe('SUBMISSION_UNCERTAIN');
    expect((outcome as { reason: string }).reason).toContain('CAS lost to concurrent transition');

    // Verify reconciliation was triggered
    expect(slowAdapter.reconcile).toHaveBeenCalledWith(attemptId, 'slow-job-recovered-123');

    // Verify database state: outbound_dispatches has provider_job_id and is SUBMITTED
    const [dispatch] = await pgClient<{ state: string; provider_job_id: string }[]>`
      SELECT state, provider_job_id FROM outbound_dispatches WHERE attempt_id = ${attemptId}
    `;
    expect(dispatch.state).toBe('SUBMITTED');
    expect(dispatch.provider_job_id).toBe('slow-job-recovered-123');

    // Verify attempts table state is updated to RUNNING (via CONFIRMED_RUNNING reconciliation)
    const [att] = await pgClient<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptId}`;
    expect(att.state).toBe('RUNNING');

    // Verify pending liability on attempt_financial_state was safely reset to 0 (since now confirmed running)
    const [fin] = await pgClient<{ pending_liability_usd_micros: string }[]>`
      SELECT pending_liability_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId}
    `;
    expect(fin.pending_liability_usd_micros).toBe('0');
  });

  it('BLOCK 4: outbox relay exhaustion transitions row to EXHAUSTED and resetExhaustedOutbox unfreezes it', async () => {
    // Clear outbox to ensure hermetic lease
    await pgClient`DELETE FROM dispatch_outbox`;

    const { attemptId } = await seedAttemptFixture('300000');
    const outboxId = randomUUID();

    // Seed outbox with retry_count = 5 (ceiling)
    await pgClient`INSERT INTO dispatch_outbox(
      id, attempt_id, queue_name, payload, status, retry_count, next_attempt_at
    ) VALUES (
      ${outboxId}, ${attemptId}, 'provider-dispatch', ${JSON.stringify({ attemptId })}::jsonb,
      'PENDING', 5, now() - interval '1 second'
    )`;

    const failingBoss = {
      send: vi.fn().mockRejectedValue(new Error('pg-boss broker offline')),
      getJobById: vi.fn().mockResolvedValue(null),
    };

    const outcome = await relayOne(failingBoss);
    expect(outcome).toBe('EXHAUSTED');

    // Check durable DB state
    const [row] = await pgClient<{
      status: string;
      retry_count: number;
      exhausted_at: Date | null;
      last_error: string | null;
    }[]>`SELECT status, retry_count, exhausted_at, last_error FROM dispatch_outbox WHERE id = ${outboxId}`;

    expect(row.status).toBe('EXHAUSTED');
    expect(row.retry_count).toBe(6);
    expect(row.exhausted_at).not.toBeNull();
    expect(row.last_error).toContain('pg-boss broker offline');

    // Next lease attempt ignores EXHAUSTED row
    const nextOutcome = await relayOne(failingBoss);
    expect(nextOutcome).toBe('EMPTY');

    // Operator unfreezes exhausted row
    const resetSuccess = await resetExhaustedOutbox(outboxId);
    expect(resetSuccess).toBe(true);

    const [resetRow] = await pgClient<{
      status: string;
      retry_count: number;
      exhausted_at: Date | null;
    }[]>`SELECT status, retry_count, exhausted_at FROM dispatch_outbox WHERE id = ${outboxId}`;

    expect(resetRow.status).toBe('PENDING');
    expect(resetRow.retry_count).toBe(0);
    expect(resetRow.exhausted_at).toBeNull();
  });
});
