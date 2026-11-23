import { randomUUID } from 'node:crypto';
import { pgClient } from '../db/index.js';

export type BossContract = {
  send: (name: string, data: Record<string, unknown>, options: { id: string; singletonKey: string }) => Promise<string | null>;
  getJobById: (name: string, id: string, options: { includeArchive: true }) => Promise<unknown | null>;
};

export type OutboxRow = {
  id: string;
  attempt_id: string;
  queue_name: string;
  payload: Record<string, unknown>;
  retry_count: number;
};

export const DEFAULT_OUTBOX_RETRY_CONFIG = {
  maxRetries: 5,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  maxJitterMs: 1000,
};

/**
 * Calculates bounded exponential backoff delay with jitter.
 * G3-C: max 5 retries, capped at 30s + bounded jitter.
 */
export function calculateBackoffDelay(
  retryCount: number,
  config = DEFAULT_OUTBOX_RETRY_CONFIG,
  jitterFn: (max: number) => number = (max) => Math.floor(Math.random() * max),
): { delayMs: number; isExhausted: boolean } {
  if (retryCount >= config.maxRetries) {
    return { delayMs: 0, isExhausted: true };
  }
  const exponential = config.baseDelayMs * Math.pow(2, retryCount);
  const capped = Math.min(exponential, config.maxDelayMs);
  const jitter = jitterFn(config.maxJitterMs);
  return { delayMs: capped + jitter, isExhausted: false };
}

async function lease(workerId: string): Promise<OutboxRow | null> {
  return pgClient.begin('isolation level read committed', async tx => {
    const [row] = await tx<OutboxRow[]>`SELECT id,attempt_id,queue_name,payload,retry_count FROM dispatch_outbox
      WHERE next_attempt_at<=now() AND (status='PENDING' OR (status='DELIVERING' AND lease_expires_at<now()))
      ORDER BY created_at,id FOR UPDATE SKIP LOCKED LIMIT 1`;
    if (!row) return null;
    await tx`UPDATE dispatch_outbox SET status='DELIVERING',lease_owner=${workerId},lease_expires_at=now()+interval '30 seconds' WHERE id=${row.id}`;
    return row;
  });
}

async function delivered(row: OutboxRow, outcome: 'JOB_ID' | 'WORKER_CONFIRMED', jobId: string | null) {
  await pgClient`UPDATE dispatch_outbox SET status='DELIVERED',enqueue_outcome=${outcome},boss_job_id=${jobId},delivered_at=now(),lease_owner=NULL,lease_expires_at=NULL WHERE id=${row.id}`;
}

async function retry(row: OutboxRow, outcome: 'NULL_UNVERIFIED' | 'UNKNOWN_ENQUEUE_OUTCOME'): Promise<'RETRY' | 'EXHAUSTED'> {
  const nextRetryCount = row.retry_count + 1;
  const backoff = calculateBackoffDelay(row.retry_count);

  if (backoff.isExhausted) {
    // Ceiling reached: set far in the future so lease() will not auto-select, keeping durable intent inspectable
    await pgClient`UPDATE dispatch_outbox SET status='PENDING',enqueue_outcome=${outcome},retry_count=${nextRetryCount},next_attempt_at=now()+interval '100 years',lease_owner=NULL,lease_expires_at=NULL WHERE id=${row.id}`;
    return 'EXHAUSTED';
  }

  const delaySeconds = Math.max(1, Math.round(backoff.delayMs / 1000));
  await pgClient`UPDATE dispatch_outbox SET status='PENDING',enqueue_outcome=${outcome},retry_count=${nextRetryCount},next_attempt_at=now() + (${delaySeconds} * interval '1 second'),lease_owner=NULL,lease_expires_at=NULL WHERE id=${row.id}`;
  return 'RETRY';
}

/** Relay one durable intent. Null/throw never becomes false delivery evidence. */
export async function relayOne(boss: BossContract, workerId = 'relay'): Promise<'EMPTY' | 'DELIVERED' | 'RETRY' | 'EXHAUSTED'> {
  const row = await lease(workerId);
  if (!row) return 'EMPTY';
  try {
    const jobId = await boss.send(row.queue_name, row.payload, { id: row.attempt_id, singletonKey: row.attempt_id });
    if (jobId) {
      await delivered(row, 'JOB_ID', jobId);
      return 'DELIVERED';
    }
    const existing = await boss.getJobById(row.queue_name, row.attempt_id, { includeArchive: true });
    if (existing) {
      await delivered(row, 'JOB_ID', row.attempt_id);
      return 'DELIVERED';
    }
    return await retry(row, 'NULL_UNVERIFIED');
  } catch {
    return await retry(row, 'UNKNOWN_ENQUEUE_OUTCOME');
  }
}

/** At-least-once queue deliveries compete for one durable provider-submission claim. */
export async function claimProviderSubmission(attemptId: string): Promise<{ claimToken: string } | null> {
  const claimToken = randomUUID();
  return pgClient.begin('isolation level read committed', async tx => {
    const [claim] = await tx<{ claim_token: string }[]>`INSERT INTO outbound_dispatches(attempt_id,state,claim_token)
      VALUES(${attemptId},'SUBMITTING',${claimToken}) ON CONFLICT(attempt_id) DO NOTHING RETURNING claim_token`;
    if (!claim) return null;
    await tx`UPDATE dispatch_outbox SET status='DELIVERED',enqueue_outcome='WORKER_CONFIRMED',delivered_at=COALESCE(delivered_at,now()) WHERE attempt_id=${attemptId}`;
    return { claimToken: claim.claim_token };
  });
}
