import { randomUUID } from 'node:crypto';
import { pgClient } from '../db/index.js';
import type { ProviderAdapter } from '../providers/index.js';
import type { GenerationRequest, SubmissionResult, ReconciliationResult } from '@nolen/contracts';
import { assertSafeRemoteUrl } from '../lib/ssrf.js';

export interface DispatchExecutionOptions {
  simulateCrashAt?: 'BEFORE_CLAIM' | 'DURING_HTTP_RAW_CRASH' | 'AFTER_SUBMIT';
  operatorId?: string;
  staleLeaseTimeoutMs?: number;
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
 * Invariant (G3-A / DEC-P02):
 * - Lock hierarchy: film_budget_accounts FOR UPDATE must precede attempt_financial_state FOR UPDATE.
 * - Film ID is read from `attempts` (not attempt_financial_state).
 * - Financial hold is preserved: no money is released, and pending_liability is set
 *   on both attempt_financial_state and film_budget_accounts to cover the open reservation.
 */
export async function markSubmissionUncertain(
  attemptId: string,
  reason: string,
): Promise<{ state: 'SUBMISSION_UNCERTAIN'; pendingLiabilityHeld: string }> {
  return pgClient.begin('isolation level read committed', async tx => {
    // 1. Look up film_id from attempts
    const [att] = await tx<{
      film_id: string;
    }[]>`SELECT film_id FROM attempts WHERE id = ${attemptId}`;

    if (!att) {
      throw new Error(`Attempt ${attemptId} not found`);
    }
    const filmId = att.film_id;

    // 2. Lock film_budget_accounts FIRST (hierarchical lock ordering DEC-P02)
    const [budget] = await tx<{
      pending_liability_usd_micros: string;
      reserved_open_usd_micros: string;
    }[]>`SELECT pending_liability_usd_micros, reserved_open_usd_micros FROM film_budget_accounts WHERE film_id = ${filmId} FOR UPDATE`;

    if (!budget) {
      throw new Error(`Budget account for film ${filmId} not found`);
    }

    // 3. Lock attempt_financial_state SECOND
    const [fin] = await tx<{
      reservation_open_usd_micros: string;
      pending_liability_usd_micros: string;
    }[]>`SELECT reservation_open_usd_micros, pending_liability_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId} FOR UPDATE`;

    if (!fin) {
      throw new Error(`Attempt ${attemptId} not found in financial state`);
    }

    const openReservation = BigInt(fin.reservation_open_usd_micros);
    const priorAttemptPending = BigInt(fin.pending_liability_usd_micros);
    const deltaPending = openReservation - priorAttemptPending;

    // 4. Update attempt_financial_state: pending liability equal to open reservation
    await tx`UPDATE attempt_financial_state
      SET pending_liability_usd_micros = ${openReservation.toString()},
          updated_at = now()
      WHERE attempt_id = ${attemptId}`;

    // 5. Update film_budget_accounts: adjust pending liability by deltaPending
    if (deltaPending !== 0n) {
      const newFilmPending = BigInt(budget.pending_liability_usd_micros) + deltaPending;
      await tx`UPDATE film_budget_accounts
        SET pending_liability_usd_micros = ${newFilmPending.toString()},
            version = version + 1,
            updated_at = now()
        WHERE film_id = ${filmId}`;
    }

    // 6. Update attempts table state to SUBMISSION_UNCERTAIN
    await tx`UPDATE attempts
      SET state = 'SUBMISSION_UNCERTAIN'
      WHERE id = ${attemptId}`;

    // 7. Update outbound_dispatches state to SUBMISSION_UNCERTAIN
    await tx`UPDATE outbound_dispatches
      SET state = 'SUBMISSION_UNCERTAIN',
          updated_at = now()
      WHERE attempt_id = ${attemptId}`;

    return {
      state: 'SUBMISSION_UNCERTAIN',
      pendingLiabilityHeld: openReservation.toString(),
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
      // 1. Look up film_id from attempts
      const [att] = await tx<{
        film_id: string;
      }[]>`SELECT film_id FROM attempts WHERE id = ${attemptId}`;

      if (!att) {
        throw new Error(`Attempt ${attemptId} not found`);
      }
      const filmId = att.film_id;

      // 2. Lock film_budget_accounts FIRST
      const [budget] = await tx<{
        reserved_open_usd_micros: string;
        pending_liability_usd_micros: string;
      }[]>`SELECT reserved_open_usd_micros, pending_liability_usd_micros FROM film_budget_accounts WHERE film_id = ${filmId} FOR UPDATE`;

      // 3. Lock attempt_financial_state SECOND
      const [fin] = await tx<{
        reservation_open_usd_micros: string;
        pending_liability_usd_micros: string;
      }[]>`SELECT reservation_open_usd_micros, pending_liability_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId} FOR UPDATE`;

      if (budget && fin) {
        const releasedAmount = fin.reservation_open_usd_micros;
        // Post RESERVATION_RELEASED
        await tx`INSERT INTO cost_ledger_events(
          id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence, created_at
        ) VALUES (
          ${randomUUID()}, ${filmId}, ${attemptId}, 'RESERVATION_RELEASED',
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
          SET reserved_open_usd_micros = GREATEST(0, reserved_open_usd_micros - ${releasedAmount}::bigint),
              pending_liability_usd_micros = GREATEST(0, pending_liability_usd_micros - ${releasedAmount}::bigint),
              version = version + 1,
              updated_at = now()
          WHERE film_id = ${filmId}`;

        // Update attempt state to FAILED
        await tx`UPDATE attempts
          SET state = 'FAILED'
          WHERE id = ${attemptId}`;
      }

      await tx`UPDATE outbound_dispatches
        SET state = 'NOT_STARTED',
            updated_at = now()
        WHERE attempt_id = ${attemptId}`;
    });
  } else if (result.outcome === 'CONFIRMED_SUCCEEDED' || result.outcome === 'CONFIRMED_RUNNING') {
    await pgClient.begin('isolation level read committed', async tx => {
      const [att] = await tx<{
        film_id: string;
      }[]>`SELECT film_id FROM attempts WHERE id = ${attemptId}`;

      if (att) {
        const filmId = att.film_id;
        // Lock budget accounts then attempt financial state
        const [budget] = await tx<{
          pending_liability_usd_micros: string;
        }[]>`SELECT pending_liability_usd_micros FROM film_budget_accounts WHERE film_id = ${filmId} FOR UPDATE`;

        const [fin] = await tx<{
          pending_liability_usd_micros: string;
        }[]>`SELECT pending_liability_usd_micros FROM attempt_financial_state WHERE attempt_id = ${attemptId} FOR UPDATE`;

        if (budget && fin) {
          const priorAttemptPending = BigInt(fin.pending_liability_usd_micros);
          if (priorAttemptPending > 0n) {
            await tx`UPDATE attempt_financial_state
              SET pending_liability_usd_micros = 0,
                  updated_at = now()
              WHERE attempt_id = ${attemptId}`;

            const newFilmPending = BigInt(budget.pending_liability_usd_micros) - priorAttemptPending;
            await tx`UPDATE film_budget_accounts
              SET pending_liability_usd_micros = ${newFilmPending >= 0n ? newFilmPending.toString() : '0'},
                  version = version + 1,
                  updated_at = now()
              WHERE film_id = ${filmId}`;
          }
        }

        const targetState = result.outcome === 'CONFIRMED_RUNNING' ? 'RUNNING' : 'SUBMITTED';
        await tx`UPDATE attempts SET state = ${targetState} WHERE id = ${attemptId}`;
      }

      await tx`UPDATE outbound_dispatches
        SET state = 'SUBMITTED',
            updated_at = now()
        WHERE attempt_id = ${attemptId}
          AND state = 'SUBMISSION_UNCERTAIN'`;
    });
  }

  return result;
}

/**
 * Sweeps and recovers stale SUBMITTING claims across all active dispatches.
 * Used by recovery workers and scheduled health tasks.
 *
 * Invariant (G3-B):
 * Transitions expired SUBMITTING leases to SUBMISSION_UNCERTAIN without
 * calling provider submit() or releasing financial holds.
 */
export async function recoverStaleSubmissions(
  staleThresholdMs = 30_000,
): Promise<Array<{ attemptId: string; recovered: boolean }>> {
  const staleRows = await pgClient<{
    attempt_id: string;
    claimed_at: Date;
  }[]>`SELECT attempt_id, claimed_at FROM outbound_dispatches
    WHERE state = 'SUBMITTING' AND claimed_at <= now() - (${staleThresholdMs} * interval '1 millisecond')`;

  const results: Array<{ attemptId: string; recovered: boolean }> = [];
  for (const row of staleRows) {
    try {
      await markSubmissionUncertain(
        row.attempt_id,
        'Swept stale SUBMITTING claim without remote submission confirmation',
      );
      results.push({ attemptId: row.attempt_id, recovered: true });
    } catch {
      results.push({ attemptId: row.attempt_id, recovered: false });
    }
  }
  return results;
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

  // Strict Fail-Closed Execution Mode Barrier (DEC-P05 / BLOCK 3)
  if (request.executionMode === 'LIVE' && (adapter.isFake || adapter.executionMode !== 'LIVE')) {
    throw new Error(
      `LIVE_EXECUTION_MODE_VIOLATION: Attempt ${attemptId} requested LIVE execution mode, but adapter ${adapter.kind} is a fake/fixture transport. Fake transports are strictly prohibited in LIVE mode.`,
    );
  }

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
    // Claim collision: an existing claim exists in outbound_dispatches!
    const [existing] = await pgClient<{
      state: string;
      claimed_at: Date;
      provider_job_id: string | null;
    }[]>`SELECT state, claimed_at, provider_job_id FROM outbound_dispatches WHERE attempt_id = ${attemptId}`;

    if (!existing) {
      return { outcome: 'ALREADY_CLAIMED', claimToken: null };
    }

    if (existing.state === 'SUBMITTING') {
      const leaseAgeMs = Date.now() - new Date(existing.claimed_at).getTime();
      const thresholdMs = options?.staleLeaseTimeoutMs ?? 30_000;
      if (leaseAgeMs >= thresholdMs) {
        // Stale claim detected (G3-B / BLOCK 2):
        // Worker crashed before completing submit. NEVER execute a blind second paid call.
        // Instead, transition stale SUBMITTING to SUBMISSION_UNCERTAIN and hold pending liability.
        await markSubmissionUncertain(
          attemptId,
          `Stale SUBMITTING lease expired (${Math.round(leaseAgeMs / 1000)}s old); recovered without re-submitting`,
        );
        return {
          outcome: 'SUBMISSION_UNCERTAIN',
          reason: 'RECOVERED_STALE_SUBMITTING',
        };
      }
      return { outcome: 'ALREADY_CLAIMED', claimToken: null };
    }

    if (existing.state === 'SUBMISSION_UNCERTAIN') {
      return {
        outcome: 'SUBMISSION_UNCERTAIN',
        reason: 'ALREADY_SUBMISSION_UNCERTAIN',
      };
    }

    if (existing.state === 'SUBMITTED' && existing.provider_job_id) {
      return {
        outcome: 'SUBMITTED',
        providerJobId: existing.provider_job_id,
      };
    }

    return { outcome: 'ALREADY_CLAIMED', claimToken: null };
  }

  // Mark outbox delivered
  await pgClient`UPDATE dispatch_outbox
    SET status = 'DELIVERED',
        enqueue_outcome = 'WORKER_CONFIRMED',
        delivered_at = COALESCE(delivered_at, now())
    WHERE attempt_id = ${attemptId}`;

  // Crash point 2: simulated unhandled crash during HTTP transmission (leaves SUBMITTING in DB)
  if (options?.simulateCrashAt === 'DURING_HTTP_RAW_CRASH') {
    throw new Error('SIMULATED_PROCESS_CRASH_DURING_HTTP');
  }

  let submission: SubmissionResult;
  try {
    submission = await adapter.submit(request);
  } catch (err: unknown) {
    // Provider transport failure / timeout: transition safely to SUBMISSION_UNCERTAIN
    await markSubmissionUncertain(attemptId, `Provider HTTP exception: ${err instanceof Error ? err.message : String(err)}`);
    return {
      outcome: 'SUBMISSION_UNCERTAIN',
      reason: 'Provider transport failure; preserved as SUBMISSION_UNCERTAIN',
    };
  }

  // Persist provider job id via CAS (Compare-And-Swap)
  // CAS condition: state MUST still be 'SUBMITTING' and claim_token MUST match our token!
  const [updated] = await pgClient<{ attempt_id: string }[]>`
    UPDATE outbound_dispatches
    SET state = 'SUBMITTED',
        provider_job_id = ${submission.providerJobId},
        updated_at = now()
    WHERE attempt_id = ${attemptId}
      AND state = 'SUBMITTING'
      AND claim_token = ${claimToken}
    RETURNING attempt_id
  `;

  if (!updated) {
    // CAS failed! A sweeper or concurrent actor transitioned this row (e.g. to SUBMISSION_UNCERTAIN).
    // Invariant (G3-B): Never blindly overwrite outbound_dispatches to SUBMITTED while attempts is SUBMISSION_UNCERTAIN!
    // Instead, attach the confirmed provider_job_id to outbound_dispatches and route directly into reconciliation.
    await pgClient`
      UPDATE outbound_dispatches
      SET provider_job_id = ${submission.providerJobId},
          updated_at = now()
      WHERE attempt_id = ${attemptId}
    `;

    const recResult = await reconcileUncertainDispatch(attemptId, adapter);

    return {
      outcome: 'SUBMISSION_UNCERTAIN',
      reason: `CAS lost to concurrent transition; reconciled with provider_job_id ${submission.providerJobId} (outcome: ${recResult.outcome})`,
    };
  }

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
