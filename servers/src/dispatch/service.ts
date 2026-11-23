import { randomUUID } from 'node:crypto';
import { pgClient } from '../db/index.js';
import type { ProviderAdapter } from '../providers/index.js';
import type { GenerationRequest, SubmissionResult, ReconciliationResult } from '@nolen/contracts';
import { assertSafeRemoteUrl } from '../lib/ssrf.js';

export interface DispatchExecutionOptions {
  simulateCrashAt?: 'BEFORE_CLAIM' | 'DURING_HTTP' | 'AFTER_SUBMIT';
  operatorId?: string;
}

export type DispatchOutcome =
  | { outcome: 'ALREADY_CLAIMED'; claimToken: null }
  | { outcome: 'SUBMITTED'; providerJobId: string }
  | { outcome: 'SUBMISSION_UNCERTAIN'; reason: string }
  | { outcome: 'SUCCEEDED'; assetMediaUrl: string }
  | { outcome: 'FAILED'; error: string };

/**
 * Marks an in-flight dispatch as SUBMISSION_UNCERTAIN following worker crash,
 * network drop, or ambiguous 5xx/429 response.
 *
 * Invariant (G3-A): Financial hold is preserved. No money is released,
 * and pending_liability is set to cover the open reservation.
 */
export async function markSubmissionUncertain(
  attemptId: string,
  reason: string,
): Promise<{ state: 'SUBMISSION_UNCERTAIN'; pendingLiabilityHeld: string }> {
  return pgClient.begin('isolation level read committed', async tx => {
    // Lock attempt financial state
    const [fin] = await tx<{
      film_id: string;
      reservation_open_usd_micros: string;
    }[]>`SELECT film_id, reservation_open_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId} FOR UPDATE`;

    if (!fin) {
      throw new Error(`Attempt ${attemptId} not found in financial state`);
    }

    // Set pending liability equal to open reservation to guarantee no capacity leak
    const openReservation = fin.reservation_open_usd_micros;
    await tx`UPDATE attempt_financial_state
      SET pending_liability_usd_micros = ${openReservation},
          updated_at = now()
      WHERE attempt_id = ${attemptId}`;

    // Update dispatch state to SUBMISSION_UNCERTAIN
    await tx`UPDATE outbound_dispatches
      SET state = 'SUBMISSION_UNCERTAIN',
          updated_at = now()
      WHERE attempt_id = ${attemptId}`;

    return {
      state: 'SUBMISSION_UNCERTAIN',
      pendingLiabilityHeld: openReservation,
    };
  });
}

/**
 * Reconciles an attempt held in SUBMISSION_UNCERTAIN.
 * Calls provider adapter's safe status/reconciliation endpoint.
 *
 * If CONFIRMED_FAILED_NO_CHARGE: safely releases reservation without charge.
 * If CONFIRMED_SUCCEEDED / RUNNING: marks SUBMITTED and preserves reservation.
 * If UNRESOLVED_MANUAL_REVIEW: leaves financial hold intact.
 */
export async function reconcileUncertainDispatch(
  attemptId: string,
  adapter: ProviderAdapter,
): Promise<ReconciliationResult> {
  const [dispatch] = await pgClient<{
    state: string;
    provider_job_id: string | null;
  }[]>`SELECT state, provider_job_id FROM outbound_dispatches WHERE attempt_id = ${attemptId}`;

  if (!dispatch || dispatch.state !== 'SUBMISSION_UNCERTAIN') {
    throw new Error(`Attempt ${attemptId} is not in SUBMISSION_UNCERTAIN state (current: ${dispatch?.state ?? 'none'})`);
  }

  const result = await adapter.reconcile(attemptId, dispatch.provider_job_id);

  if (result.outcome === 'CONFIRMED_FAILED_NO_CHARGE') {
    // Release full reservation safely
    await pgClient.begin('isolation level read committed', async tx => {
      const [fin] = await tx<{
        film_id: string;
        reservation_open_usd_micros: string;
      }[]>`SELECT film_id, reservation_open_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId} FOR UPDATE`;

      if (fin) {
        const releasedAmount = fin.reservation_open_usd_micros;
        // Post RESERVATION_RELEASED
        await tx`INSERT INTO cost_ledger_events(
          id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence, created_at
        ) VALUES (
          ${randomUUID()}, ${fin.film_id}, ${attemptId}, 'RESERVATION_RELEASED',
          ${releasedAmount}, 'FINAL',
          ${JSON.stringify({ reason: 'RECONCILED_FAILED_NO_CHARGE', evidence: result.evidence })}::jsonb,
          now()
        )`;

        // Reset financial state
        await tx`UPDATE attempt_financial_state
          SET billing_status = 'FINAL',
              reservation_open_usd_micros = 0,
              pending_liability_usd_micros = 0,
              updated_at = now()
          WHERE attempt_id = ${attemptId}`;

        // Reset account open reservations
        await tx`UPDATE film_budget_accounts
          SET reserved_open_usd_micros = GREATEST(0, reserved_open_usd_micros - ${releasedAmount}),
              pending_liability_usd_micros = GREATEST(0, pending_liability_usd_micros - ${releasedAmount}),
              updated_at = now()
          WHERE film_id = ${fin.film_id}`;
      }

      await tx`UPDATE outbound_dispatches
        SET state = 'NOT_STARTED',
            updated_at = now()
        WHERE attempt_id = ${attemptId}`;
    });
  } else if (result.outcome === 'CONFIRMED_SUCCEEDED' || result.outcome === 'CONFIRMED_RUNNING') {
    await pgClient`UPDATE outbound_dispatches
      SET state = 'SUBMITTED',
          updated_at = now()
      WHERE attempt_id = ${attemptId}`;
  }

  return result;
}

/**
 * Executes full dispatch lifecycle with crash recovery and SSRF safety.
 */
export async function dispatchAttempt(
  request: GenerationRequest,
  adapter: ProviderAdapter,
  options?: DispatchExecutionOptions,
): Promise<DispatchOutcome> {
  const attemptId = request.attemptId;

  // Crash point 1: before claim
  if (options?.simulateCrashAt === 'BEFORE_CLAIM') {
    throw new Error('SIMULATED_CRASH_BEFORE_CLAIM');
  }

  // Acquire durable claim in outbound_dispatches
  const claimToken = randomUUID();
  const [claim] = await pgClient<{ claim_token: string }[]>`
    INSERT INTO outbound_dispatches(attempt_id, state, claim_token)
    VALUES(${attemptId}, 'SUBMITTING', ${claimToken})
    ON CONFLICT(attempt_id) DO NOTHING
    RETURNING claim_token
  `;

  if (!claim) {
    return { outcome: 'ALREADY_CLAIMED', claimToken: null };
  }

  // Mark outbox delivered
  await pgClient`UPDATE dispatch_outbox
    SET status = 'DELIVERED',
        enqueue_outcome = 'WORKER_CONFIRMED',
        delivered_at = COALESCE(delivered_at, now())
    WHERE attempt_id = ${attemptId}`;

  // Crash point 2: during HTTP submission call
  if (options?.simulateCrashAt === 'DURING_HTTP') {
    await markSubmissionUncertain(attemptId, 'Simulated worker crash during HTTP transmission');
    return {
      outcome: 'SUBMISSION_UNCERTAIN',
      reason: 'Crash during HTTP transmission; financial hold preserved',
    };
  }

  let submission: SubmissionResult;
  try {
    submission = await adapter.submit(request);
  } catch (err: unknown) {
    await markSubmissionUncertain(attemptId, `Provider HTTP exception: ${err instanceof Error ? err.message : String(err)}`);
    return {
      outcome: 'SUBMISSION_UNCERTAIN',
      reason: 'Provider transport failure; preserved as SUBMISSION_UNCERTAIN',
    };
  }

  // Persist provider job id
  await pgClient`UPDATE outbound_dispatches
    SET state = 'SUBMITTED',
        provider_job_id = ${submission.providerJobId},
        updated_at = now()
    WHERE attempt_id = ${attemptId}`;

  // Crash point 3: after submit persist
  if (options?.simulateCrashAt === 'AFTER_SUBMIT') {
    return { outcome: 'SUBMITTED', providerJobId: submission.providerJobId };
  }

  // Poll status to completion
  const status = await adapter.pollStatus(submission.providerJobId);

  if (status.state === 'SUCCEEDED' && status.mediaUrl) {
    // SSRF validation before asset download
    try {
      await assertSafeRemoteUrl(status.mediaUrl);
    } catch (err: unknown) {
      await pgClient`UPDATE outbound_dispatches SET state = 'SUBMISSION_UNCERTAIN', updated_at = now() WHERE attempt_id = ${attemptId}`;
      return {
        outcome: 'FAILED',
        error: `SSRF_BLOCKED: ${err instanceof Error ? err.message : String(err)}`,
      };
    }

    return {
      outcome: 'SUCCEEDED',
      assetMediaUrl: status.mediaUrl,
    };
  }

  return {
    outcome: 'FAILED',
    error: status.errorMessage ?? 'Provider generation failed',
  };
}
