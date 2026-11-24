import { randomUUID } from 'node:crypto';
import { pgClient } from '../db/index.js';
import { storage, type AssetCategory } from '../lib/storage.js';
import { resolveFixture } from '../fixtures/resolver.js';
import { canonicalizePayload, computeRequestFingerprint } from './service.js';
import { generationRequestSchema } from '@nolen/contracts';
import { ApiFailure } from '../http/errors.js';

export type CrashPoint = 'AFTER_DISK_WRITE' | 'AFTER_DB_COMMIT_BEFORE_ACK';

export interface CompleteReplayAttemptOptions {
  simulateCrashAt?: CrashPoint;
}

export type CompleteReplayAttemptResult =
  | { attemptId: string; assetId?: string; alreadyCompleted: boolean; state: 'SUCCEEDED' | 'FAILED' | 'CANCELED'; error?: string; alreadyTerminal?: boolean };

/**
 * Handles attempts with kinds unsupported by media completion (e.g. TTS, ASSEMBLY) in REPLAY mode.
 * Preserves terminal states (CANCELED, FAILED, SUCCEEDED) via CAS, transitioning only non-terminal attempts to FAILED.
 * ACKs the outbox intent so the job does not poison or loop indefinitely in the queue.
 */
export async function handleUnsupportedKindAttempt(
  attemptId: string,
  kind: string,
): Promise<CompleteReplayAttemptResult> {
  return pgClient.begin(async tx => {
    const [att] = await tx<{ id: string; state: string; kind: string }[]>`
      SELECT id, state, kind FROM attempts WHERE id = ${attemptId} FOR UPDATE
    `;
    if (!att) throw new ApiFailure(404, 'ATTEMPT_NOT_FOUND', 'Attempt not found');

    // CAS protection: preserve existing terminal state (CANCELED, FAILED, SUCCEEDED)
    if (['CANCELED', 'FAILED', 'SUCCEEDED'].includes(att.state)) {
      await tx`
        UPDATE dispatch_outbox
        SET status = 'DELIVERED', enqueue_outcome = 'WORKER_CONFIRMED', delivered_at = COALESCE(delivered_at, now())
        WHERE attempt_id = ${attemptId}
      `;
      return {
        attemptId,
        state: att.state as 'CANCELED' | 'FAILED' | 'SUCCEEDED',
        alreadyCompleted: true,
        alreadyTerminal: true,
      };
    }

    // Only transition from non-terminal states (QUEUED, RUNNING) to FAILED
    const [updatedAtt] = await tx<{ id: string }[]>`
      UPDATE attempts
      SET state = 'FAILED'
      WHERE id = ${attemptId} AND state IN ('QUEUED', 'RUNNING')
      RETURNING id
    `;
    if (!updatedAtt) throw new Error('ATTEMPT_CAS_FAILED');

    await tx`
      INSERT INTO outbound_dispatches (attempt_id, state, claim_token, claimed_at, updated_at)
      VALUES (${attemptId}, 'FAILED', ${randomUUID()}, now(), now())
      ON CONFLICT (attempt_id) DO UPDATE
      SET state = 'FAILED', updated_at = now()
      WHERE outbound_dispatches.state != 'SUCCEEDED' AND outbound_dispatches.state != 'CANCELED'
    `;

    await tx`
      UPDATE dispatch_outbox
      SET status = 'DELIVERED', enqueue_outcome = 'WORKER_CONFIRMED', delivered_at = COALESCE(delivered_at, now())
      WHERE attempt_id = ${attemptId}
    `;

    return {
      attemptId,
      state: 'FAILED',
      alreadyCompleted: false,
      alreadyTerminal: false,
      error: `UNSUPPORTED_REPLAY_KIND: Kind ${att.kind} is not supported in REPLAY worker`,
    };
  });
}

/**
 * Idempotently completes a REPLAY attempt:
 * 1. Pre-flight snapshot, identity, mode & kind verification (outside transaction to avoid deadlocks)
 * 2. Content-addressed disk write to local storage (idempotent)
 * 3. Atomic database transaction:
 *    - Row lock on attempts FOR UPDATE
 *    - Financial preconditions check (strictly FINAL/0/0/0 and 0 ledger events)
 *    - Existing asset verification if already completed
 *    - Durable claim on outbound_dispatches
 *    - Asset insert with ON CONFLICT (attempt_id) DO NOTHING and recovery verification
 *    - CAS state transitions on attempts, outbound_dispatches, and dispatch_outbox
 */
export async function completeReplayAttempt(
  attemptId: string,
  options?: CompleteReplayAttemptOptions,
): Promise<CompleteReplayAttemptResult> {
  // ── PHASE 1: Pre-flight Verification (Outside DB transaction) ───────
  const [outboxRow] = await pgClient<{ payload: Record<string, unknown> }[]>`
    SELECT payload FROM dispatch_outbox WHERE attempt_id = ${attemptId}
  `;
  if (!outboxRow) throw new ApiFailure(404, 'OUTBOX_NOT_FOUND', `Outbox intent for attempt ${attemptId} not found`);

  const payload = outboxRow.payload as { request: unknown; requestFingerprint: string };
  const request = generationRequestSchema.parse(payload.request);
  const expectedFingerprint = computeRequestFingerprint(request as unknown as Record<string, unknown>);
  if (expectedFingerprint !== payload.requestFingerprint) {
    throw new ApiFailure(400, 'FINGERPRINT_VERIFICATION_FAILED', 'Outbox request fingerprint does not match canonical payload hash');
  }

  // Read-only attempt check outside transaction
  const [attInfo] = await pgClient<{
    id: string;
    execution_mode: string;
    kind: string;
    film_id: string;
    shot_revision_id: string | null;
  }[]>`
    SELECT id, execution_mode, kind, film_id, shot_revision_id
    FROM attempts
    WHERE id = ${attemptId}
  `;
  if (!attInfo) throw new ApiFailure(404, 'ATTEMPT_NOT_FOUND', 'Attempt not found');
  if (attInfo.execution_mode !== 'REPLAY') {
    throw new ApiFailure(400, 'LIVE_ATTEMPT_CANNOT_COMPLETE_VIA_REPLAY', `Attempt ${attemptId} has mode ${attInfo.execution_mode}, cannot complete via REPLAY`);
  }
  if (request.attemptId !== attInfo.id) {
    throw new ApiFailure(400, 'ATTEMPT_ID_MISMATCH', `Payload attemptId ${request.attemptId} !== DB id ${attInfo.id}`);
  }
  if (request.filmId !== attInfo.film_id) {
    throw new ApiFailure(400, 'FILM_ID_MISMATCH', `Payload filmId ${request.filmId} !== DB film_id ${attInfo.film_id}`);
  }

  // BLOCK 2: If kind is non-media (TTS / ASSEMBLY), delegate outside transaction to prevent self-deadlock!
  if (!['IMAGE', 'VIDEO'].includes(attInfo.kind)) {
    return handleUnsupportedKindAttempt(attemptId, attInfo.kind);
  }

  if (!attInfo.shot_revision_id) {
    throw new ApiFailure(422, 'INVALID_ATTEMPT_KIND', 'Media attempt must be associated with a shotRevisionId');
  }

  const fixturePackVersion = request.fixturePackVersion ?? 'v1';
  const fixtureId = request.fixtureId;
  if (!fixtureId) {
    throw new ApiFailure(400, 'MISSING_FIXTURE_IDENTITY', 'Replay attempt missing fixtureId');
  }

  const resolvedFixture = await resolveFixture(fixturePackVersion, fixtureId);
  if (resolvedFixture.provider !== request.provider) {
    throw new ApiFailure(422, 'FIXTURE_PROVIDER_MISMATCH', `Fixture provider ${resolvedFixture.provider} !== request provider ${request.provider}`);
  }
  if (resolvedFixture.kind !== request.kind) {
    throw new ApiFailure(422, 'FIXTURE_KIND_MISMATCH', `Fixture kind ${resolvedFixture.kind} !== request kind ${request.kind}`);
  }
  if (resolvedFixture.aspectRatio !== request.aspectRatio) {
    throw new ApiFailure(422, 'FIXTURE_ASPECT_RATIO_MISMATCH', `Fixture aspect ratio ${resolvedFixture.aspectRatio} !== request ${request.aspectRatio}`);
  }

  // ── PHASE 2: Filesystem Boundary (Idempotent Write) ───────────────
  const category: AssetCategory = attInfo.kind === 'IMAGE' ? 'keyframes' : 'videos';
  const ext = resolvedFixture.mimeType === 'video/mp4' ? '.mp4' : resolvedFixture.mimeType === 'image/png' ? '.png' : '.bin';
  const filename = `${resolvedFixture.sha256}${ext}`;
  const storagePath = `${category}/${filename}`;

  await storage.write(category, filename, resolvedFixture.buffer);

  if (options?.simulateCrashAt === 'AFTER_DISK_WRITE') {
    throw new Error('SIMULATED_CRASH_AFTER_DISK_WRITE');
  }

  const metadata = {
    provenance: 'REPLAY_FIXTURE',
    executionMode: 'REPLAY',
    fixturePackVersion,
    fixtureId: resolvedFixture.fixtureId,
    provider: resolvedFixture.provider,
    aspectRatio: resolvedFixture.aspectRatio,
  };

  // ── PHASE 3: Atomic Database Transaction ──────────────────────────
  const result = await pgClient.begin(async tx => {
    const [att] = await tx<{
      id: string;
      state: string;
      execution_mode: string;
      kind: string;
      shot_revision_id: string;
      film_id: string;
    }[]>`
      SELECT id, state, execution_mode, kind, shot_revision_id, film_id
      FROM attempts
      WHERE id = ${attemptId}
      FOR UPDATE
    `;
    if (!att) throw new ApiFailure(404, 'ATTEMPT_NOT_FOUND', 'Attempt not found');

    // Verify financial preconditions in transaction
    const [fsRow] = await tx<{
      billing_status: string;
      reservation_open_usd_micros: string;
      realized_usd_micros: string;
      pending_liability_usd_micros: string;
    }[]>`
      SELECT billing_status, reservation_open_usd_micros, realized_usd_micros, pending_liability_usd_micros
      FROM attempt_financial_state
      WHERE attempt_id = ${attemptId}
      FOR UPDATE
    `;
    if (!fsRow || fsRow.billing_status !== 'FINAL' || fsRow.reservation_open_usd_micros !== '0' || fsRow.realized_usd_micros !== '0' || fsRow.pending_liability_usd_micros !== '0') {
      throw new Error(`REPLAY_FINANCIAL_STATE_INVALID: expected FINAL/0/0/0, got ${fsRow?.billing_status}`);
    }

    const [ledgerCount] = await tx<{ count: string }[]>`
      SELECT count(*)::text as count FROM cost_ledger_events WHERE attempt_id = ${attemptId}
    `;
    if (ledgerCount.count !== '0') {
      throw new Error(`REPLAY_LEDGER_CONTAMINATED: found ledger events for attempt ${attemptId}`);
    }

    // Already completed recovery branch
    if (att.state === 'SUCCEEDED') {
      const [existingAsset] = await tx<{
        id: string;
        sha256_hash: string;
        mime_type: string;
        storage_path: string;
        byte_size: string;
        metadata: Record<string, unknown>;
      }[]>`
        SELECT id, sha256_hash, mime_type, storage_path, byte_size, metadata
        FROM assets
        WHERE attempt_id = ${attemptId}
      `;
      if (!existingAsset) throw new Error('SUCCEEDED_ATTEMPT_MISSING_ASSET');
      if (existingAsset.sha256_hash !== resolvedFixture.sha256) throw new Error('CORRUPT_ASSET_HASH_MISMATCH');
      if (existingAsset.mime_type !== resolvedFixture.mimeType) throw new Error('ASSET_MIME_MISMATCH');
      if (existingAsset.storage_path !== storagePath) throw new Error('ASSET_STORAGE_PATH_MISMATCH');
      if (BigInt(existingAsset.byte_size) !== BigInt(resolvedFixture.byteSize)) throw new Error('ASSET_BYTE_SIZE_MISMATCH');

      const meta = (existingAsset.metadata ?? {}) as Record<string, unknown>;
      if (meta.provenance !== 'REPLAY_FIXTURE') throw new Error('ASSET_PROVENANCE_MISMATCH');
      if (meta.fixtureId !== resolvedFixture.fixtureId) throw new Error('ASSET_FIXTURE_ID_MISMATCH');
      if (meta.fixturePackVersion !== fixturePackVersion) throw new Error('ASSET_FIXTURE_PACK_VERSION_MISMATCH');

      // Upsert outbound_dispatches to terminal SUCCEEDED with RETURNING
      const claimToken = randomUUID();
      const [outboundRow] = await tx<{ attempt_id: string; state: string }[]>`
        INSERT INTO outbound_dispatches (attempt_id, state, claim_token, claimed_at, updated_at)
        VALUES (${attemptId}, 'SUCCEEDED', ${claimToken}, now(), now())
        ON CONFLICT (attempt_id) DO UPDATE
        SET state = 'SUCCEEDED', updated_at = now()
        WHERE outbound_dispatches.state != 'SUCCEEDED'
           OR outbound_dispatches.attempt_id = ${attemptId}
        RETURNING attempt_id, state
      `;
      if (!outboundRow || outboundRow.state !== 'SUCCEEDED') {
        throw new Error('OUTBOUND_DISPATCH_RECOVERY_CAS_FAILED');
      }

      const [updatedOutbox] = await tx<{ id: string }[]>`
        UPDATE dispatch_outbox
        SET status = 'DELIVERED', enqueue_outcome = 'WORKER_CONFIRMED', delivered_at = COALESCE(delivered_at, now())
        WHERE attempt_id = ${attemptId}
        RETURNING id
      `;
      if (!updatedOutbox) throw new Error('OUTBOX_CONFIRMATION_FAILED');

      return { attemptId, assetId: existingAsset.id, alreadyCompleted: true, state: 'SUCCEEDED' as const };
    }

    // Normal execution path: claim outbound_dispatches
    const claimToken = randomUUID();
    await tx`
      INSERT INTO outbound_dispatches (attempt_id, state, claim_token, claimed_at, updated_at)
      VALUES (${attemptId}, 'SUBMITTING', ${claimToken}, now(), now())
      ON CONFLICT (attempt_id) DO UPDATE SET updated_at = now()
    `;

    // Insert Asset with ON CONFLICT (attempt_id) DO NOTHING
    const assetId = randomUUID();
    const [inserted] = await tx<{
      id: string;
      sha256_hash: string;
      mime_type: string;
      storage_path: string;
      byte_size: string;
      metadata: Record<string, unknown>;
    }[]>`
      INSERT INTO assets (id, film_id, attempt_id, shot_revision_id, kind, storage_path, sha256_hash, mime_type, byte_size, verified, metadata, created_at)
      VALUES (${assetId}, ${att.film_id}, ${attemptId}, ${att.shot_revision_id}, ${att.kind}, ${storagePath}, ${resolvedFixture.sha256}, ${resolvedFixture.mimeType}, ${resolvedFixture.byteSize}, true, ${JSON.stringify(metadata)}::jsonb, clock_timestamp())
      ON CONFLICT (attempt_id) DO NOTHING
      RETURNING id, sha256_hash, mime_type, storage_path, byte_size, metadata
    `;

    let assetRow = inserted;
    if (!assetRow) {
      const [existing] = await tx<{
        id: string;
        sha256_hash: string;
        mime_type: string;
        storage_path: string;
        byte_size: string;
        metadata: Record<string, unknown>;
      }[]>`
        SELECT id, sha256_hash, mime_type, storage_path, byte_size, metadata
        FROM assets WHERE attempt_id = ${attemptId}
      `;
      if (!existing) throw new Error('ASSET_INSERT_CONFLICT_RECOVERY_FAILED');
      assetRow = existing;
    }

    // Strict verification on assetRow (both freshly inserted and conflict-recovered)
    if (assetRow.sha256_hash !== resolvedFixture.sha256) throw new Error('CORRUPT_ASSET_HASH_MISMATCH');
    if (assetRow.mime_type !== resolvedFixture.mimeType) throw new Error('ASSET_MIME_MISMATCH');
    if (assetRow.storage_path !== storagePath) throw new Error('ASSET_STORAGE_PATH_MISMATCH');
    if (BigInt(assetRow.byte_size) !== BigInt(resolvedFixture.byteSize)) throw new Error('ASSET_BYTE_SIZE_MISMATCH');

    const meta = (assetRow.metadata ?? {}) as Record<string, unknown>;
    if (meta.provenance !== 'REPLAY_FIXTURE') throw new Error('ASSET_PROVENANCE_MISMATCH');
    if (meta.fixtureId !== resolvedFixture.fixtureId) throw new Error('ASSET_FIXTURE_ID_MISMATCH');
    if (meta.fixturePackVersion !== fixturePackVersion) throw new Error('ASSET_FIXTURE_PACK_VERSION_MISMATCH');

    // CAS terminal transitions
    const [updatedAtt] = await tx<{ id: string }[]>`
      UPDATE attempts
      SET state = 'SUCCEEDED'
      WHERE id = ${attemptId} AND state IN ('QUEUED', 'RUNNING')
      RETURNING id
    `;
    if (!updatedAtt) throw new Error('ATTEMPT_CAS_FAILED');

    const [updatedOutbound] = await tx<{ attempt_id: string }[]>`
      UPDATE outbound_dispatches
      SET state = 'SUCCEEDED', updated_at = now()
      WHERE attempt_id = ${attemptId} AND state IN ('NOT_STARTED', 'SUBMITTING', 'SUBMITTED')
      RETURNING attempt_id
    `;
    if (!updatedOutbound) throw new Error('OUTBOUND_DISPATCH_CAS_FAILED');

    const [updatedOutbox] = await tx<{ id: string }[]>`
      UPDATE dispatch_outbox
      SET status = 'DELIVERED', enqueue_outcome = 'WORKER_CONFIRMED', delivered_at = COALESCE(delivered_at, now())
      WHERE attempt_id = ${attemptId}
      RETURNING id
    `;
    if (!updatedOutbox) throw new Error('OUTBOX_CONFIRMATION_FAILED');

    return { attemptId, assetId: assetRow.id, alreadyCompleted: false, state: 'SUCCEEDED' as const };
  });

  if (options?.simulateCrashAt === 'AFTER_DB_COMMIT_BEFORE_ACK') {
    throw new Error('SIMULATED_CRASH_AFTER_DB_COMMIT_BEFORE_ACK');
  }

  return result;
}
