import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import {
  generationRequestSchema,
  type BillingEvidence,
  type PollContinuationPayload,
} from '@nolen/contracts';
import { pgClient } from '../db/index.js';
import { ApiFailure } from '../http/errors.js';
import { downloadRemoteAsset, type PinnedTransportFn } from '../lib/remote-download.js';
import type { DnsLookupFn } from '../lib/ssrf.js';
import { StorageAdapter, storage as defaultStorage, type AssetCategory } from '../lib/storage.js';
import { createProviderAdapter, type LiveProviderAdapterOptions, type ProviderAdapter } from '../providers/index.js';
import { computeRequestFingerprint, markSubmissionUncertain, reconcileUncertainDispatch } from './service.js';

export const DEFAULT_TURN_POLL_BUDGET_MS = 600_000; // 10 minutes
export const DEFAULT_POLL_INTERVAL_MS = 10_000;
export const DEFAULT_TURN_RESCHEDULE_DELAY_SEC = 30;
export const DEFAULT_SHUTDOWN_RESCHEDULE_DELAY_SEC = 5;

export interface PollScheduler {
  send: (
    name: string,
    data: Record<string, unknown>,
    options?: { startAfter?: number; singletonKey?: string; retryLimit?: number; retryDelay?: number },
  ) => Promise<string | null>;
}

export type LiveCrashPoint =
  | 'DURING_HTTP_BEFORE_PERSIST'
  | 'AFTER_SUBMIT_PERSIST'
  | 'AFTER_MEDIA_BEFORE_SETTLEMENT'
  | 'AFTER_DB_COMMIT_BEFORE_ACK';

export interface CompleteLiveAttemptOptions {
  adapter?: ProviderAdapter;
  adapterOptions?: LiveProviderAdapterOptions;
  storage?: StorageAdapter;
  boss?: PollScheduler;
  signal?: AbortSignal;
  turnNumber?: number;
  expectedProviderJobId?: string;
  turnPollBudgetMs?: number;
  pollIntervalMs?: number;
  turnRescheduleDelaySec?: number;
  shutdownRescheduleDelaySec?: number;
  lookupFn?: DnsLookupFn;
  downloadTransportFn?: PinnedTransportFn;
  simulateCrashAt?: LiveCrashPoint;
  onBeforeSettlementLock?: () => Promise<void>;
  onBeforePreSubmitRelease?: () => Promise<void>;
}

export type LiveCompletionOutcome =
  | { attemptId: string; outcome: 'ALREADY_COMPLETED'; state: 'SUCCEEDED' | 'FAILED' | 'CANCELED'; assetId?: string }
  | { attemptId: string; outcome: 'ALREADY_CLAIMED' }
  | { attemptId: string; outcome: 'SUBMISSION_UNCERTAIN'; providerJobId?: string }
  | { attemptId: string; outcome: 'POLL_TURN_RESCHEDULED'; providerJobId: string }
  | { attemptId: string; outcome: 'WORKER_SHUTDOWN_PAUSED_RESCHEDULED'; providerJobId: string }
  | { attemptId: string; outcome: 'SETTLED'; state: 'SUCCEEDED' | 'FAILED'; assetId?: string; billingStatus: 'FINAL' | 'PENDING' | 'PARTIAL' | 'DISPUTED' };

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  if (ms <= 0 || signal?.aborted) return Promise.resolve();
  return new Promise(resolve => {
    const onAbort = () => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

async function schedulePollContinuation(
  boss: PollScheduler | undefined,
  attemptId: string,
  providerJobId: string,
  nextTurn: number,
  delaySeconds: number,
): Promise<void> {
  if (!boss) {
    throw new Error(`POLL_SCHEDULER_UNAVAILABLE: Cannot schedule poll continuation for attempt ${attemptId}`);
  }
  const jobId = await boss.send(
    'live:generation:poll',
    {
      kind: 'POLL_CONTINUATION',
      attemptId,
      providerJobId,
      turnNumber: nextTurn,
    } satisfies PollContinuationPayload,
    {
      startAfter: delaySeconds,
      singletonKey: attemptId,
      retryLimit: 5,
      retryDelay: 10,
    },
  );
  if (!jobId) {
    throw new Error(`FAILED_TO_SCHEDULE_POLL_CONTINUATION: null jobId for attempt ${attemptId}`);
  }
}

/**
 * Idempotent LIVE provider execution, media acquisition, and dual-track PG16 settlement.
 */
export async function completeLiveAttempt(
  attemptId: string,
  options: CompleteLiveAttemptOptions = {},
): Promise<LiveCompletionOutcome> {
  const storageAdapter = options.storage ?? defaultStorage;
  const turnNumber = options.turnNumber ?? 1;
  const turnPollBudgetMs = options.turnPollBudgetMs ?? DEFAULT_TURN_POLL_BUDGET_MS;
  const pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
  const turnRescheduleDelaySec = options.turnRescheduleDelaySec ?? DEFAULT_TURN_RESCHEDULE_DELAY_SEC;
  const shutdownRescheduleDelaySec = options.shutdownRescheduleDelaySec ?? DEFAULT_SHUTDOWN_RESCHEDULE_DELAY_SEC;

  // 1. Pre-flight verification outside DB lock transaction
  const [outboxRow] = await pgClient<{ payload: Record<string, unknown>; status: string }[]>`
    SELECT payload, status FROM dispatch_outbox WHERE attempt_id = ${attemptId}
  `;
  if (!outboxRow) {
    throw new ApiFailure(404, 'OUTBOX_NOT_FOUND', `Outbox intent for attempt ${attemptId} not found`);
  }

  const payload = outboxRow.payload as { request: unknown; requestFingerprint: string };
  const request = generationRequestSchema.parse(payload.request);
  const expectedFingerprint = computeRequestFingerprint(request as unknown as Record<string, unknown>);
  if (expectedFingerprint !== payload.requestFingerprint) {
    throw new ApiFailure(400, 'FINGERPRINT_VERIFICATION_FAILED', 'Outbox request fingerprint does not match canonical payload hash');
  }

  const [attInfo] = await pgClient<{
    id: string;
    execution_mode: string;
    kind: string;
    film_id: string;
    shot_revision_id: string | null;
    provider: string;
    model: string;
    state: string;
  }[]>`
    SELECT id, execution_mode, kind, film_id, shot_revision_id, provider, model, state
    FROM attempts
    WHERE id = ${attemptId}
  `;
  if (!attInfo) throw new ApiFailure(404, 'ATTEMPT_NOT_FOUND', 'Attempt not found');
  if (attInfo.execution_mode !== 'LIVE') {
    throw new ApiFailure(400, 'REPLAY_ATTEMPT_CANNOT_COMPLETE_VIA_LIVE', `Attempt ${attemptId} has mode ${attInfo.execution_mode}`);
  }
  if (!['IMAGE', 'VIDEO'].includes(attInfo.kind)) {
    throw new ApiFailure(422, 'UNSUPPORTED_LIVE_KIND', `Unsupported LIVE attempt kind: ${attInfo.kind}`);
  }
  if (request.provider === 'LOCAL_PAN_ZOOM') {
    throw new ApiFailure(400, 'LOCAL_PAN_ZOOM_MUST_USE_LOCAL_COMPLETION', 'LOCAL_PAN_ZOOM must route to completeLocalPanZoomAttempt');
  }
  if (!attInfo.shot_revision_id) {
    throw new ApiFailure(422, 'INVALID_ATTEMPT_KIND', 'Media attempt must have shotRevisionId');
  }

  // Redelivery fast-path if already terminal in DB
  if (['SUCCEEDED', 'FAILED', 'CANCELED'].includes(attInfo.state)) {
    let existingAssetId: string | undefined;
    if (attInfo.state === 'SUCCEEDED') {
      const [asset] = await pgClient<{ id: string; storage_path: string; sha256_hash: string }[]>`
        SELECT id, storage_path, sha256_hash FROM assets WHERE attempt_id = ${attemptId}
      `;
      if (!asset) {
        throw new Error(`SUCCEEDED_ATTEMPT_MISSING_ASSET: ${attemptId}`);
      }
      const category = asset.storage_path.startsWith('keyframes/') ? 'keyframes' : 'videos';
      const filename = asset.storage_path.slice(category.length + 1);
      const ok = await storageAdapter.verify(category, filename, asset.sha256_hash).catch(() => false);
      if (!ok) {
        throw new Error(`CORRUPT_ASSET_HASH_MISMATCH: ${attemptId}`);
      }
      existingAssetId = asset.id;
    }

    await pgClient`
      UPDATE dispatch_outbox
      SET status = 'DELIVERED', enqueue_outcome = 'WORKER_CONFIRMED', delivered_at = COALESCE(delivered_at, now())
      WHERE attempt_id = ${attemptId}
    `;
    return {
      attemptId,
      outcome: 'ALREADY_COMPLETED',
      state: attInfo.state as 'SUCCEEDED' | 'FAILED' | 'CANCELED',
      assetId: existingAssetId,
    };
  }

  // 2. Durable Submission Claim & Milestone A/B Resumption
  const [existingDispatch] = await pgClient<{
    state: string;
    provider_job_id: string | null;
    claim_token: string;
  }[]>`
    SELECT state, provider_job_id, claim_token
    FROM outbound_dispatches
    WHERE attempt_id = ${attemptId}
  `;

  if (existingDispatch?.state === 'SUBMISSION_UNCERTAIN') {
    return { attemptId, outcome: 'SUBMISSION_UNCERTAIN' };
  }

  let adapter: ProviderAdapter;
  try {
    adapter =
      options.adapter ??
      createProviderAdapter(request.provider, 'LIVE', {
        storage: storageAdapter,
        ...options.adapterOptions,
      });
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : '';
    const isPreSubmitNoCreds =
      msg.includes('LIVE_PROVIDER_UNAVAILABLE') &&
      (!existingDispatch || existingDispatch.state === 'NOT_STARTED');
    if (!isPreSubmitNoCreds) {
      throw err;
    }

    if (options.onBeforePreSubmitRelease) {
      await options.onBeforePreSubmitRelease();
    }

    // Fail closed prior to any external HTTP call ONLY if atomic CAS proves no worker claimed/submitted.
    await pgClient.begin('isolation level read committed', async tx => {
      const [casClaimed] = await tx<{ attempt_id: string }[]>`
        INSERT INTO outbound_dispatches (attempt_id, state, claim_token, claimed_at, updated_at)
        VALUES (${attemptId}, 'FAILED', ${randomUUID()}, now(), now())
        ON CONFLICT (attempt_id) DO UPDATE
        SET state = 'FAILED', updated_at = now()
        WHERE outbound_dispatches.state = 'NOT_STARTED'
        RETURNING attempt_id
      `;
      if (!casClaimed) {
        throw err;
      }

      await tx`SELECT * FROM film_budget_accounts WHERE film_id = ${attInfo.film_id} FOR UPDATE`;
      const [afs] = await tx<{
        billing_status: string;
        reservation_open_usd_micros: string;
        pending_liability_usd_micros: string;
      }[]>`
        SELECT billing_status, reservation_open_usd_micros, pending_liability_usd_micros
        FROM attempt_financial_state WHERE attempt_id = ${attemptId} FOR UPDATE
      `;
      const [att] = await tx<{ state: string }[]>`SELECT state FROM attempts WHERE id = ${attemptId} FOR UPDATE`;
      if (att && !['SUCCEEDED', 'FAILED', 'CANCELED'].includes(att.state)) {
        await tx`UPDATE attempts SET state = 'FAILED' WHERE id = ${attemptId}`;
      }
      if (afs && afs.billing_status === 'PENDING') {
        const oldOpen = BigInt(afs.reservation_open_usd_micros);
        const oldPending = BigInt(afs.pending_liability_usd_micros);
        if (oldOpen > 0n) {
          await tx`
            INSERT INTO cost_ledger_events (id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence, created_at)
            VALUES (${randomUUID()}, ${attInfo.film_id}, ${attemptId}, 'RESERVATION_RELEASED', ${oldOpen.toString()}, 'FINAL', ${JSON.stringify({ reason: msg })}::jsonb, clock_timestamp())
          `;
        }
        await tx`
          UPDATE film_budget_accounts
          SET reserved_open_usd_micros = reserved_open_usd_micros - ${oldOpen.toString()},
              pending_liability_usd_micros = pending_liability_usd_micros - ${oldPending.toString()},
              version = version + 1, updated_at = now()
          WHERE film_id = ${attInfo.film_id}
        `;
        await tx`
          UPDATE attempt_financial_state
          SET billing_status = 'FINAL', reservation_open_usd_micros = '0', pending_liability_usd_micros = '0', version = version + 1, updated_at = now()
          WHERE attempt_id = ${attemptId}
        `;
      }
      await tx`
        UPDATE dispatch_outbox
        SET status = 'DELIVERED', enqueue_outcome = 'WORKER_CONFIRMED', delivered_at = COALESCE(delivered_at, now())
        WHERE attempt_id = ${attemptId}
      `;
    });
    return { attemptId, outcome: 'SETTLED', state: 'FAILED', billingStatus: 'FINAL' };
  }

  let providerJobId: string | null = null;
  if (existingDispatch?.state === 'SUBMITTED' && existingDispatch.provider_job_id) {
    if (options.expectedProviderJobId && existingDispatch.provider_job_id !== options.expectedProviderJobId) {
      throw new ApiFailure(409, 'PROVIDER_JOB_ID_MISMATCH', 'Poll continuation providerJobId does not match outbound_dispatches');
    }
    providerJobId = existingDispatch.provider_job_id;
  } else {
    // Attempt atomic claim to SUBMITTING
    const claimToken = randomUUID();
    const [claimed] = await pgClient<{ attempt_id: string }[]>`
      INSERT INTO outbound_dispatches (
        attempt_id, state, claim_token, provider_request_fingerprint, claimed_at, updated_at
      )
      VALUES (
        ${attemptId}, 'SUBMITTING', ${claimToken}, ${expectedFingerprint}, now(), now()
      )
      ON CONFLICT (attempt_id) DO UPDATE
      SET state = 'SUBMITTING',
          claim_token = ${claimToken},
          provider_request_fingerprint = ${expectedFingerprint},
          claimed_at = now(),
          updated_at = now()
      WHERE outbound_dispatches.state = 'NOT_STARTED'
      RETURNING attempt_id
    `;

    if (!claimed) {
      // Another worker already claimed or submitted; re-read safely without blind resubmit
      const [reread] = await pgClient<{ state: string; provider_job_id: string | null }[]>`
        SELECT state, provider_job_id FROM outbound_dispatches WHERE attempt_id = ${attemptId}
      `;
      if (reread?.state === 'SUBMITTED' && reread.provider_job_id) {
        providerJobId = reread.provider_job_id;
      } else if (reread?.state === 'SUBMISSION_UNCERTAIN') {
        return { attemptId, outcome: 'SUBMISSION_UNCERTAIN' };
      } else {
        return { attemptId, outcome: 'ALREADY_CLAIMED' };
      }
    } else {
      // Execute external paid submit
      let submissionResult;
      try {
        if (options.simulateCrashAt === 'DURING_HTTP_BEFORE_PERSIST') {
          await adapter.submit({ ...request, requestFingerprint: expectedFingerprint });
          throw new Error('SIMULATED_CRASH_DURING_HTTP_BEFORE_PERSIST');
        }
        submissionResult = await adapter.submit({ ...request, requestFingerprint: expectedFingerprint });
      } catch (err: unknown) {
        if (options.simulateCrashAt === 'DURING_HTTP_BEFORE_PERSIST') {
          throw err;
        }
        const reason = err instanceof Error ? err.message : 'Remote submit failed';
        await markSubmissionUncertain(attemptId, reason, { claimToken, expectedState: 'SUBMITTING' });
        return { attemptId, outcome: 'SUBMISSION_UNCERTAIN' };
      }

      // Persist provider_job_id via CAS
      const [submittedRow] = await pgClient<{ attempt_id: string }[]>`
        UPDATE outbound_dispatches
        SET state = 'SUBMITTED',
            provider_job_id = ${submissionResult.providerJobId},
            updated_at = now()
        WHERE attempt_id = ${attemptId}
          AND state = 'SUBMITTING'
          AND claim_token = ${claimToken}
        RETURNING attempt_id
      `;

      if (!submittedRow) {
        // Sweeper transitioned to SUBMISSION_UNCERTAIN while HTTP was in-flight
        await reconcileUncertainDispatch(attemptId, adapter);
        return { attemptId, outcome: 'SUBMISSION_UNCERTAIN', providerJobId: submissionResult.providerJobId };
      }

      await pgClient`
        UPDATE attempts SET state = 'SUBMITTED'
        WHERE id = ${attemptId} AND state = 'QUEUED'
      `;

      providerJobId = submissionResult.providerJobId;

      if (options.simulateCrashAt === 'AFTER_SUBMIT_PERSIST') {
        throw new Error('SIMULATED_CRASH_AFTER_SUBMIT_PERSIST');
      }
    }
  }

  if (!providerJobId) {
    return { attemptId, outcome: 'SUBMISSION_UNCERTAIN' };
  }

  // 3. Turn-Bounded Polling Loop with Heartbeat & Durable Continuation Rescheduling
  const turnStartTime = Date.now();
  let pollStatus = await adapter.pollStatus(providerJobId);

  while (pollStatus.state === 'RUNNING') {
    await pgClient`
      UPDATE attempts SET state = 'RUNNING'
      WHERE id = ${attemptId} AND state = 'SUBMITTED'
    `;
    await pgClient`
      UPDATE outbound_dispatches SET updated_at = now()
      WHERE attempt_id = ${attemptId} AND state = 'SUBMITTED'
    `;

    if (options.signal?.aborted) {
      await schedulePollContinuation(
        options.boss,
        attemptId,
        providerJobId,
        turnNumber + 1,
        shutdownRescheduleDelaySec,
      );
      return { attemptId, outcome: 'WORKER_SHUTDOWN_PAUSED_RESCHEDULED', providerJobId };
    }

    if (Date.now() - turnStartTime >= turnPollBudgetMs) {
      await schedulePollContinuation(
        options.boss,
        attemptId,
        providerJobId,
        turnNumber + 1,
        turnRescheduleDelaySec,
      );
      return { attemptId, outcome: 'POLL_TURN_RESCHEDULED', providerJobId };
    }

    await abortableSleep(pollIntervalMs, options.signal);

    if (options.signal?.aborted) {
      await schedulePollContinuation(
        options.boss,
        attemptId,
        providerJobId,
        turnNumber + 1,
        shutdownRescheduleDelaySec,
      );
      return { attemptId, outcome: 'WORKER_SHUTDOWN_PAUSED_RESCHEDULED', providerJobId };
    }

    await pgClient`
      UPDATE outbound_dispatches SET updated_at = now()
      WHERE attempt_id = ${attemptId} AND state = 'SUBMITTED'
    `;
    pollStatus = await adapter.pollStatus(providerJobId);
  }

  // 4. Media Ingestion (Pathway A Inline vs Pathway B SSRF Pinned Remote Download)
  const billingEvidence: BillingEvidence = pollStatus.billingEvidence ?? {
    status: 'PENDING',
    evidenceRef: `live:${request.provider}:${providerJobId}`,
  };

  let mediaSuccess = false;
  let mediaAsset: {
    storagePath: string;
    sha256: string;
    mimeType: string;
    byteSize: number;
  } | null = null;

  if (pollStatus.state === 'SUCCEEDED') {
    try {
      if (pollStatus.locator?.kind === 'LOCAL_STORAGE') {
        const { category, filename, sha256 } = pollStatus.locator;
        if (!storageAdapter.exists(category, filename)) {
          throw new Error(`LOCAL_STORAGE_MISSING: ${category}/${filename}`);
        }
        const ok = await storageAdapter.verify(category, filename, sha256);
        if (!ok) {
          throw new Error(`LOCAL_STORAGE_HASH_MISMATCH: ${category}/${filename}`);
        }
        const fullPath = storageAdapter.resolve(category, filename);
        const stat = await fs.stat(fullPath);
        mediaAsset = {
          storagePath: `${category}/${filename}`,
          sha256,
          mimeType: category === 'keyframes' ? 'image/png' : 'video/mp4',
          byteSize: stat.size,
        };
        mediaSuccess = true;
      } else {
        const remoteUrl =
          pollStatus.mediaUrl ??
          (pollStatus.locator?.kind === 'REMOTE_URL' ? pollStatus.locator.url : undefined);
        if (!remoteUrl) {
          throw new Error('LIVE_PROVIDER_MISSING_MEDIA_URL');
        }
        const category: AssetCategory = attInfo.kind === 'IMAGE' ? 'keyframes' : 'videos';
        const downloaded = await downloadRemoteAsset({
          url: remoteUrl,
          category: category as 'keyframes' | 'videos',
          storage: storageAdapter,
          lookupFn: options.lookupFn,
          transportFn: options.downloadTransportFn,
          signal: options.signal,
        });
        mediaAsset = {
          storagePath: downloaded.storagePath,
          sha256: downloaded.sha256,
          mimeType: downloaded.contentType,
          byteSize: downloaded.byteSize,
        };
        mediaSuccess = true;
      }
    } catch {
      // Media acquisition failed (SSRF block, corrupt hash, payload size limit, etc.)
      // Keep billingEvidence intact so confirmed charges are still settled!
      mediaSuccess = false;
      mediaAsset = null;
    }
  }

  if (options.simulateCrashAt === 'AFTER_MEDIA_BEFORE_SETTLEMENT') {
    throw new Error('SIMULATED_CRASH_AFTER_MEDIA_BEFORE_SETTLEMENT');
  }

  if (options.onBeforeSettlementLock) {
    await options.onBeforeSettlementLock();
  }

  // 5. Atomic PG16 Settlement Transaction (Strict Lock Order: FBA -> AFS -> ATT)
  const settled = await pgClient.begin('isolation level read committed', async tx => {
    const [fba] = await tx<{
      film_id: string;
      actual_spent_usd_micros: string;
      reserved_open_usd_micros: string;
      pending_liability_usd_micros: string;
    }[]>`
      SELECT film_id, actual_spent_usd_micros, reserved_open_usd_micros, pending_liability_usd_micros
      FROM film_budget_accounts
      WHERE film_id = ${attInfo.film_id}
      FOR UPDATE
    `;
    if (!fba) throw new ApiFailure(404, 'BUDGET_ACCOUNT_NOT_FOUND', 'Budget account not found');

    const [afs] = await tx<{
      attempt_id: string;
      billing_status: 'PENDING' | 'PARTIAL' | 'FINAL' | 'DISPUTED';
      reservation_open_usd_micros: string;
      realized_usd_micros: string;
      pending_liability_usd_micros: string;
      version: number;
    }[]>`
      SELECT attempt_id, billing_status, reservation_open_usd_micros, realized_usd_micros, pending_liability_usd_micros, version
      FROM attempt_financial_state
      WHERE attempt_id = ${attemptId}
      FOR UPDATE
    `;
    if (!afs) throw new ApiFailure(404, 'ATTEMPT_FINANCIAL_NOT_FOUND', 'Attempt financial state not found');

    const [att] = await tx<{
      id: string;
      state: string;
      provider: string;
      model: string;
    }[]>`
      SELECT id, state, provider, model
      FROM attempts
      WHERE id = ${attemptId}
      FOR UPDATE
    `;
    if (!att) throw new ApiFailure(404, 'ATTEMPT_NOT_FOUND', 'Attempt not found');

    // A. Terminal Immutability Guard (protects SUCCEEDED, FAILED, CANCELED)
    let finalAttemptState: 'SUCCEEDED' | 'FAILED' | 'CANCELED';
    let assetId: string | undefined;
    const isTerminalAttempt = ['SUCCEEDED', 'FAILED', 'CANCELED'].includes(att.state);

    if (!isTerminalAttempt) {
      if (mediaSuccess && mediaAsset) {
        const newAssetId = randomUUID();
        const assetMetadata = {
          provenance: 'LIVE_PROVIDER',
          executionMode: 'LIVE',
          provider: att.provider,
          model: att.model,
          providerJobId,
        };
        const [insertedAsset] = await tx<{ id: string }[]>`
          INSERT INTO assets (
            id, film_id, attempt_id, shot_revision_id, kind,
            storage_path, sha256_hash, mime_type, byte_size, verified, metadata, created_at
          )
          VALUES (
            ${newAssetId}, ${attInfo.film_id}, ${attemptId}, ${attInfo.shot_revision_id}, ${attInfo.kind},
            ${mediaAsset.storagePath}, ${mediaAsset.sha256}, ${mediaAsset.mimeType}, ${mediaAsset.byteSize},
            true, ${JSON.stringify(assetMetadata)}::jsonb, clock_timestamp()
          )
          ON CONFLICT (attempt_id) DO NOTHING
          RETURNING id
        `;
        if (insertedAsset) {
          assetId = insertedAsset.id;
        } else {
          const [existing] = await tx<{ id: string }[]>`SELECT id FROM assets WHERE attempt_id = ${attemptId}`;
          assetId = existing?.id;
        }

        await tx`
          UPDATE attempts SET state = 'SUCCEEDED'
          WHERE id = ${attemptId} AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELED')
        `;
        await tx`
          UPDATE outbound_dispatches SET state = 'SUCCEEDED', updated_at = now()
          WHERE attempt_id = ${attemptId} AND state NOT IN ('SUCCEEDED', 'FAILED')
        `;
        finalAttemptState = 'SUCCEEDED';
      } else {
        await tx`
          UPDATE attempts SET state = 'FAILED'
          WHERE id = ${attemptId} AND state NOT IN ('SUCCEEDED', 'FAILED', 'CANCELED')
        `;
        await tx`
          UPDATE outbound_dispatches SET state = 'FAILED', updated_at = now()
          WHERE attempt_id = ${attemptId} AND state NOT IN ('SUCCEEDED', 'FAILED')
        `;
        finalAttemptState = 'FAILED';
      }
    } else {
      finalAttemptState = att.state as 'SUCCEEDED' | 'FAILED' | 'CANCELED';
      if (finalAttemptState === 'SUCCEEDED') {
        const [existing] = await tx<{ id: string }[]>`SELECT id FROM assets WHERE attempt_id = ${attemptId}`;
        assetId = existing?.id;
      }
    }

    // B. Financial Settlement Guard (v8.1: includes operator_reconciled receipt check under tx lock)
    let resultingBillingStatus = afs.billing_status;
    let operatorPreservedState =
      billingEvidence.status === 'PENDING' &&
      (afs.billing_status === 'DISPUTED' || afs.billing_status === 'PARTIAL');

    if (
      !operatorPreservedState &&
      billingEvidence.status === 'PENDING' &&
      afs.billing_status === 'PENDING'
    ) {
      const [receiptCheck] = await tx<{ operator_reconciled: boolean }[]>`
        SELECT EXISTS (
          SELECT 1
          FROM financial_command_receipts
          WHERE film_id = ${attInfo.film_id}
            AND command = 'RECONCILE_ATTEMPT'
            AND response->>'attemptId' = ${attemptId}
        ) AS operator_reconciled
      `;
      if (receiptCheck?.operator_reconciled) {
        operatorPreservedState = true;
      }
    }

    if (afs.billing_status !== 'FINAL' && !operatorPreservedState) {
      const oldRealized = BigInt(afs.realized_usd_micros);
      const oldOpen = BigInt(afs.reservation_open_usd_micros);
      const oldPending = BigInt(afs.pending_liability_usd_micros);

      let nextRealized = oldRealized;
      let nextOpen = oldOpen;
      let nextPending = oldPending;
      let targetBilling: 'FINAL' | 'PENDING' = 'PENDING';

      if (billingEvidence.status === 'CONFIRMED_CHARGED') {
        nextRealized = BigInt(billingEvidence.realizedChargeUsdMicros);
        nextOpen = 0n;
        nextPending = 0n;
        targetBilling = 'FINAL';
      } else if (billingEvidence.status === 'CONFIRMED_UNCHARGED') {
        nextRealized = 0n;
        nextOpen = 0n;
        nextPending = 0n;
        targetBilling = 'FINAL';
      } else {
        nextRealized = oldRealized;
        nextOpen = oldOpen;
        nextPending = oldOpen;
        targetBilling = 'PENDING';
      }

      if (nextRealized > oldRealized) {
        await tx`
          INSERT INTO cost_ledger_events (id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence, created_at)
          VALUES (
            ${randomUUID()}, ${attInfo.film_id}, ${attemptId}, 'CHARGE_POSTED',
            ${(nextRealized - oldRealized).toString()}, ${targetBilling},
            ${JSON.stringify({ evidenceRef: billingEvidence.evidenceRef ?? `live:${att.provider}` })}::jsonb,
            GREATEST(clock_timestamp(), COALESCE((SELECT max(created_at) + interval '1 microsecond' FROM cost_ledger_events WHERE attempt_id = ${attemptId}), '-infinity'::timestamptz))
          )
        `;
      } else if (nextRealized < oldRealized) {
        const [prior] = await tx<{ id: string }[]>`
          SELECT id FROM cost_ledger_events
          WHERE attempt_id = ${attemptId} AND event_type IN ('CHARGE_POSTED', 'CHARGE_CORRECTED')
          ORDER BY created_at DESC, id DESC LIMIT 1
        `;
        if (!prior) {
          throw new ApiFailure(409, 'FINANCIAL_INTEGRITY', 'Negative correction requires a prior charge event');
        }
        await tx`
          INSERT INTO cost_ledger_events (id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence, created_at)
          VALUES (
            ${randomUUID()}, ${attInfo.film_id}, ${attemptId}, 'CHARGE_CORRECTED',
            ${(nextRealized - oldRealized).toString()}, ${targetBilling},
            ${JSON.stringify({ evidenceRef: billingEvidence.evidenceRef ?? `live:${att.provider}`, correctionOfEventId: prior.id })}::jsonb,
            GREATEST(clock_timestamp(), COALESCE((SELECT max(created_at) + interval '1 microsecond' FROM cost_ledger_events WHERE attempt_id = ${attemptId}), '-infinity'::timestamptz))
          )
        `;
      }

      if (nextOpen < oldOpen) {
        await tx`
          INSERT INTO cost_ledger_events (id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence, created_at)
          VALUES (
            ${randomUUID()}, ${attInfo.film_id}, ${attemptId}, 'RESERVATION_RELEASED',
            ${(oldOpen - nextOpen).toString()}, ${targetBilling},
            ${JSON.stringify({ evidenceRef: billingEvidence.evidenceRef ?? `live:${att.provider}` })}::jsonb,
            GREATEST(clock_timestamp(), COALESCE((SELECT max(created_at) + interval '1 microsecond' FROM cost_ledger_events WHERE attempt_id = ${attemptId}), '-infinity'::timestamptz))
          )
        `;
      } else if (nextOpen > oldOpen) {
        await tx`
          INSERT INTO cost_ledger_events (id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence, created_at)
          VALUES (
            ${randomUUID()}, ${attInfo.film_id}, ${attemptId}, 'RESERVATION_ADJUSTED',
            ${(nextOpen - oldOpen).toString()}, ${targetBilling},
            ${JSON.stringify({ evidenceRef: billingEvidence.evidenceRef ?? `live:${att.provider}` })}::jsonb,
            GREATEST(clock_timestamp(), COALESCE((SELECT max(created_at) + interval '1 microsecond' FROM cost_ledger_events WHERE attempt_id = ${attemptId}), '-infinity'::timestamptz))
          )
        `;
      }

      const realizedDelta = nextRealized - oldRealized;
      const openDelta = nextOpen - oldOpen;
      const pendingDelta = nextPending - oldPending;

      if (realizedDelta !== 0n || openDelta !== 0n || pendingDelta !== 0n) {
        await tx`
          UPDATE film_budget_accounts
          SET actual_spent_usd_micros = actual_spent_usd_micros + ${realizedDelta.toString()},
              reserved_open_usd_micros = reserved_open_usd_micros + ${openDelta.toString()},
              pending_liability_usd_micros = pending_liability_usd_micros + ${pendingDelta.toString()},
              version = version + 1,
              updated_at = now()
          WHERE film_id = ${attInfo.film_id}
        `;
      }

      if (
        targetBilling !== afs.billing_status ||
        nextRealized !== oldRealized ||
        nextOpen !== oldOpen ||
        nextPending !== oldPending
      ) {
        await tx`
          UPDATE attempt_financial_state
          SET billing_status = ${targetBilling},
              realized_usd_micros = ${nextRealized.toString()},
              reservation_open_usd_micros = ${nextOpen.toString()},
              pending_liability_usd_micros = ${nextPending.toString()},
              version = version + 1,
              updated_at = now()
          WHERE attempt_id = ${attemptId}
        `;
      }

      resultingBillingStatus = targetBilling;
    }

    await tx`
      UPDATE dispatch_outbox
      SET status = 'DELIVERED', enqueue_outcome = 'WORKER_CONFIRMED', delivered_at = COALESCE(delivered_at, now())
      WHERE attempt_id = ${attemptId}
    `;

    return {
      attemptId,
      outcome: 'SETTLED' as const,
      state: finalAttemptState === 'CANCELED' ? ('FAILED' as const) : finalAttemptState,
      assetId,
      billingStatus: resultingBillingStatus,
    };
  });

  if (options.simulateCrashAt === 'AFTER_DB_COMMIT_BEFORE_ACK') {
    throw new Error('SIMULATED_CRASH_AFTER_DB_COMMIT_BEFORE_ACK');
  }

  return settled;
}
