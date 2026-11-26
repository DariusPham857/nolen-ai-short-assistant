import { randomUUID } from 'node:crypto';
import path from 'node:path';
import {
  generationRequestV2Schema,
  localVideoMetadataSchema,
  type GenerationRequestV2,
  type LocalVideoMetadata,
} from '@nolen/contracts';
import { pgClient } from '../db/index.js';
import { ApiFailure } from '../http/errors.js';
import { storage as defaultStorage, type StorageAdapter } from '../lib/storage.js';
import {
  LocalPanZoomError,
  renderLocalPanZoomMp4,
  type LocalPanZoomErrorCode,
  type RenderLocalPanZoomOptions,
} from '../providers/ffmpeg-pan-zoom.js';
import { computeRequestFingerprint } from './service.js';

export type LocalCrashPoint = 'AFTER_DISK_WRITE' | 'AFTER_DB_COMMIT_BEFORE_ACK';

export interface CompleteLocalPanZoomOptions {
  storage?: StorageAdapter;
  renderOptions?: RenderLocalPanZoomOptions;
  simulateCrashAt?: LocalCrashPoint;
}

export interface LocalCompletionResult {
  attemptId: string;
  state: 'SUCCEEDED' | 'FAILED' | 'CANCELED';
  assetId?: string;
  alreadyCompleted: boolean;
  alreadyTerminal?: boolean;
  errorCode?: LocalPanZoomErrorCode;
  error?: string;
}

interface OutboxPayloadEnvelope {
  request?: unknown;
  requestFingerprint?: string;
}

type AssetRow = {
  id: string;
  film_id: string;
  shot_revision_id: string;
  kind: string;
  storage_path: string;
  sha256_hash: string;
  mime_type: string;
  byte_size: string;
  metadata: Record<string, unknown>;
};

async function verifyExistingLocalAsset(
  existing: AssetRow,
  expected: {
    filmId: string;
    shotRevisionId: string;
    sha256Hash?: string;
    storagePath?: string;
    byteSize?: number;
    startFrameAssetId?: string;
    startFrameSha256?: string;
    startFrameProvenance?: 'REPLAY_FIXTURE' | 'LIVE_PROVIDER';
  },
  storage: StorageAdapter,
): Promise<void> {
  if (
    existing.kind !== 'VIDEO' ||
    existing.film_id !== expected.filmId ||
    existing.shot_revision_id !== expected.shotRevisionId ||
    existing.mime_type !== 'video/mp4'
  ) {
    throw new ApiFailure(409, 'ASSET_METADATA_MISMATCH', 'Existing asset identity disagrees with local VIDEO attempt');
  }

  if (expected.sha256Hash && existing.sha256_hash !== expected.sha256Hash) {
    throw new ApiFailure(409, 'CORRUPT_ASSET_HASH_MISMATCH', 'Existing asset SHA-256 disagrees with deterministic render');
  }
  if (expected.storagePath && existing.storage_path !== expected.storagePath) {
    throw new ApiFailure(409, 'ASSET_METADATA_MISMATCH', 'Existing asset storage_path disagrees with deterministic render');
  }
  if (expected.byteSize !== undefined && BigInt(existing.byte_size) !== BigInt(expected.byteSize)) {
    throw new ApiFailure(409, 'ASSET_METADATA_MISMATCH', 'Existing asset byte_size disagrees with deterministic render');
  }

  const expectedFilename = `${existing.sha256_hash}.mp4`;
  if (existing.storage_path !== `videos/${expectedFilename}`) {
    throw new ApiFailure(409, 'ASSET_METADATA_MISMATCH', `Existing local video path ${existing.storage_path} is non-canonical`);
  }

  const parsedMeta = localVideoMetadataSchema.safeParse(existing.metadata);
  if (!parsedMeta.success) {
    throw new ApiFailure(409, 'ASSET_METADATA_MISMATCH', 'Existing asset metadata is not valid LOCAL_PIPELINE lineage');
  }

  if (expected.startFrameAssetId && parsedMeta.data.startFrameAssetId !== expected.startFrameAssetId) {
    throw new ApiFailure(409, 'ASSET_METADATA_MISMATCH', 'Existing asset startFrameAssetId disagrees with START_FRAME');
  }
  if (expected.startFrameSha256 && parsedMeta.data.startFrameSha256 !== expected.startFrameSha256) {
    throw new ApiFailure(409, 'ASSET_METADATA_MISMATCH', 'Existing asset startFrameSha256 disagrees with START_FRAME');
  }
  if (expected.startFrameProvenance && parsedMeta.data.startFrameProvenance !== expected.startFrameProvenance) {
    throw new ApiFailure(409, 'ASSET_METADATA_MISMATCH', 'Existing asset startFrameProvenance disagrees with START_FRAME');
  }

  let verifiedOnDisk = false;
  try {
    verifiedOnDisk = await storage.verify('videos', path.basename(existing.storage_path), existing.sha256_hash);
  } catch {
    verifiedOnDisk = false;
  }
  if (!verifiedOnDisk) {
    throw new ApiFailure(409, 'CORRUPT_ASSET_HASH_MISMATCH', 'Existing local video asset failed on-disk SHA-256 verification');
  }
}

async function settleHandledLocalFailure(
  attemptId: string,
  filmId: string,
  requestFingerprint: string,
  errorCode: LocalPanZoomErrorCode,
  errorMessage: string,
): Promise<LocalCompletionResult> {
  return pgClient.begin(async tx => {
    const [lockedAtt] = await tx<{ state: string }[]>`
      SELECT state FROM attempts WHERE id = ${attemptId} FOR UPDATE
    `;
    if (!lockedAtt) {
      throw new ApiFailure(404, 'ATTEMPT_NOT_FOUND', `Attempt ${attemptId} not found`);
    }

    const [fin] = await tx<{
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
    if (!fin) {
      throw new ApiFailure(409, 'FINANCIAL_STATE_MISSING', `Financial state missing for attempt ${attemptId}`);
    }
    if (
      fin.reservation_open_usd_micros !== '0' ||
      fin.realized_usd_micros !== '0' ||
      fin.pending_liability_usd_micros !== '0'
    ) {
      throw new ApiFailure(409, 'LOCAL_FINANCIAL_INVARIANT_VIOLATION', 'LOCAL_PAN_ZOOM attempt must carry $0 micros');
    }

    if (lockedAtt.state === 'FAILED' || lockedAtt.state === 'CANCELED' || lockedAtt.state === 'SUCCEEDED') {
      await tx`
        UPDATE dispatch_outbox
        SET status = 'DELIVERED',
            enqueue_outcome = 'WORKER_CONFIRMED',
            delivered_at = COALESCE(delivered_at, now())
        WHERE attempt_id = ${attemptId}
      `;
      return {
        attemptId,
        state: lockedAtt.state as 'FAILED' | 'CANCELED' | 'SUCCEEDED',
        alreadyCompleted: true,
        alreadyTerminal: true,
      };
    }

    if (fin.billing_status !== 'FINAL') {
      await tx`
        INSERT INTO cost_ledger_events(id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence)
        VALUES(
          ${randomUUID()},
          ${filmId},
          ${attemptId},
          'RESERVATION_RELEASED',
          '0',
          'FINAL',
          ${JSON.stringify({ reason: 'LOCAL_PIPELINE_FAILED', code: errorCode, message: errorMessage })}::jsonb
        )
      `;
      await tx`
        UPDATE attempt_financial_state
        SET billing_status = 'FINAL',
            reservation_open_usd_micros = '0',
            realized_usd_micros = '0',
            pending_liability_usd_micros = '0',
            version = version + 1,
            updated_at = now()
        WHERE attempt_id = ${attemptId}
      `;
    }

    await tx`
      UPDATE attempts
      SET state = 'FAILED'
      WHERE id = ${attemptId} AND state IN ('QUEUED', 'SUBMITTED', 'RUNNING')
    `;

    await tx`
      INSERT INTO outbound_dispatches(attempt_id, state, claim_token, provider_request_fingerprint)
      VALUES(${attemptId}, 'FAILED', ${randomUUID()}, ${requestFingerprint})
      ON CONFLICT (attempt_id) DO UPDATE
      SET state = 'FAILED', updated_at = now()
      WHERE outbound_dispatches.state NOT IN ('SUCCEEDED', 'FAILED')
    `;

    await tx`
      UPDATE dispatch_outbox
      SET status = 'DELIVERED',
          enqueue_outcome = 'WORKER_CONFIRMED',
          delivered_at = COALESCE(delivered_at, now())
      WHERE attempt_id = ${attemptId}
    `;

    return {
      attemptId,
      state: 'FAILED',
      alreadyCompleted: false,
      alreadyTerminal: false,
      errorCode,
      error: errorMessage,
    };
  });
}

/**
 * Atomically executes and settles a LIVE LOCAL_PAN_ZOOM attempt with pre-render terminal safety,
 * START_FRAME SHA-256 & provenance verification, FFmpeg pan/zoom synthesis, and $0 financial settlement.
 */
export async function completeLocalPanZoomAttempt(
  attemptId: string,
  options?: CompleteLocalPanZoomOptions,
): Promise<LocalCompletionResult> {
  const storage = options?.storage ?? defaultStorage;

  const [outboxRow] = await pgClient<{ payload: unknown }[]>`
    SELECT payload FROM dispatch_outbox WHERE attempt_id = ${attemptId}
  `;
  if (!outboxRow) {
    throw new ApiFailure(404, 'OUTBOX_NOT_FOUND', `Dispatch outbox record missing for attempt ${attemptId}`);
  }

  const envelope = (outboxRow.payload ?? {}) as OutboxPayloadEnvelope;
  const parsedRequest = generationRequestV2Schema.safeParse(envelope.request);
  if (!parsedRequest.success) {
    throw new ApiFailure(422, 'INVALID_DISPATCH_PAYLOAD', `Outbox payload is not a valid GenerationRequestV2: ${parsedRequest.error.message}`);
  }
  const request: GenerationRequestV2 = parsedRequest.data;
  const computedFingerprint = computeRequestFingerprint(request);
  if (envelope.requestFingerprint && envelope.requestFingerprint !== computedFingerprint) {
    throw new ApiFailure(422, 'FINGERPRINT_VERIFICATION_FAILED', 'Dispatch request fingerprint does not match payload');
  }

  const [attInfo] = await pgClient<{
    id: string;
    film_id: string;
    shot_revision_id: string | null;
    kind: string;
    provider: string;
    model: string;
    execution_mode: string;
    state: string;
  }[]>`
    SELECT id, film_id, shot_revision_id, kind, provider, model, execution_mode, state
    FROM attempts
    WHERE id = ${attemptId}
  `;
  if (!attInfo) {
    throw new ApiFailure(404, 'ATTEMPT_NOT_FOUND', `Attempt ${attemptId} not found`);
  }
  if (request.attemptId !== attemptId) {
    throw new ApiFailure(422, 'ATTEMPT_ID_MISMATCH', 'Payload attemptId disagrees with outbox attemptId');
  }
  if (request.filmId !== attInfo.film_id) {
    throw new ApiFailure(422, 'FILM_ID_MISMATCH', 'Payload filmId disagrees with attempt film_id');
  }
  if (attInfo.execution_mode !== 'LIVE' || request.executionMode !== 'LIVE') {
    throw new ApiFailure(422, 'EXECUTION_MODE_MISMATCH', 'completeLocalPanZoomAttempt requires LIVE execution mode');
  }
  if (attInfo.kind !== 'VIDEO' || request.kind !== 'VIDEO' || !attInfo.shot_revision_id) {
    throw new ApiFailure(422, 'LOCAL_KIND_MISMATCH', 'LOCAL_PAN_ZOOM requires a shot-scoped VIDEO attempt');
  }
  const shotRevisionId = attInfo.shot_revision_id;
  if (request.provider !== 'LOCAL_PAN_ZOOM') {
    throw new ApiFailure(422, 'LOCAL_PROVIDER_MISMATCH', `Expected provider LOCAL_PAN_ZOOM, received ${request.provider}`);
  }

  // Pre-media terminal guard (LP-AT-05): confirm outbox and preserve FAILED/CANCELED without touching media or FFmpeg.
  if (attInfo.state === 'FAILED' || attInfo.state === 'CANCELED') {
    await pgClient`
      UPDATE dispatch_outbox
      SET status = 'DELIVERED',
          enqueue_outcome = 'WORKER_CONFIRMED',
          delivered_at = COALESCE(delivered_at, now())
      WHERE attempt_id = ${attemptId}
    `;
    return {
      attemptId,
      state: attInfo.state,
      alreadyCompleted: true,
      alreadyTerminal: true,
    };
  }

  const startFrameInput = request.inputAssets.find(
    a => a.role === 'START_FRAME' && a.source === 'GENERATED_ASSET',
  );

  // Redelivery after DB commit & SUCCEEDED (LP-AT-02): verify saved Asset & lineage without re-rendering or writing.
  if (attInfo.state === 'SUCCEEDED') {
    const [existingAsset] = await pgClient<AssetRow[]>`
      SELECT id, film_id, shot_revision_id, kind, storage_path, sha256_hash, mime_type, byte_size::text, metadata
      FROM assets
      WHERE attempt_id = ${attemptId}
    `;
    if (!existingAsset) {
      throw new ApiFailure(409, 'CORRUPT_ATTEMPT_ASSET_MISSING', `SUCCEEDED attempt ${attemptId} has no Asset record`);
    }
    await verifyExistingLocalAsset(
      existingAsset,
      {
        filmId: attInfo.film_id,
        shotRevisionId,
        startFrameAssetId: startFrameInput?.assetId,
        startFrameSha256: startFrameInput?.sha256Hash,
      },
      storage,
    );
    await pgClient`
      UPDATE dispatch_outbox
      SET status = 'DELIVERED',
          enqueue_outcome = 'WORKER_CONFIRMED',
          delivered_at = COALESCE(delivered_at, now())
      WHERE attempt_id = ${attemptId}
    `;
    return {
      attemptId,
      state: 'SUCCEEDED',
      assetId: existingAsset.id,
      alreadyCompleted: true,
      alreadyTerminal: false,
    };
  }

  // Validate START_FRAME asset row from DB
  if (!startFrameInput) {
    return settleHandledLocalFailure(
      attemptId,
      attInfo.film_id,
      computedFingerprint,
      'START_FRAME_MISSING',
      'LOCAL_PAN_ZOOM requires an approved START_FRAME input asset',
    );
  }

  const [startAsset] = await pgClient<{
    id: string;
    storage_path: string;
    sha256_hash: string;
    metadata: Record<string, unknown>;
  }[]>`
    SELECT id, storage_path, sha256_hash, metadata
    FROM assets
    WHERE id = ${startFrameInput.assetId}
      AND film_id = ${attInfo.film_id}
      AND shot_revision_id = ${attInfo.shot_revision_id}
      AND kind = 'IMAGE'
  `;

  if (!startAsset) {
    return settleHandledLocalFailure(
      attemptId,
      attInfo.film_id,
      computedFingerprint,
      'START_FRAME_MISSING',
      `START_FRAME DB asset ${startFrameInput.assetId} missing or mismatched`,
    );
  }

  if (startAsset.sha256_hash !== startFrameInput.sha256Hash) {
    return settleHandledLocalFailure(
      attemptId,
      attInfo.film_id,
      computedFingerprint,
      'START_FRAME_HASH_MISMATCH',
      `START_FRAME request hash ${startFrameInput.sha256Hash} disagrees with DB hash ${startAsset.sha256_hash}`,
    );
  }

  const startFrameProvenance: 'LIVE_PROVIDER' | 'REPLAY_FIXTURE' =
    startAsset.metadata?.provenance === 'LIVE_PROVIDER' ? 'LIVE_PROVIDER' : 'REPLAY_FIXTURE';

  const durationSeconds = request.durationSeconds;
  if (!durationSeconds || !Number.isInteger(durationSeconds) || durationSeconds < 1 || durationSeconds > 60) {
    return settleHandledLocalFailure(
      attemptId,
      attInfo.film_id,
      computedFingerprint,
      'LOCAL_RENDER_FAILED',
      `Invalid durationSeconds ${durationSeconds} for LOCAL_PAN_ZOOM`,
    );
  }

  const cameraMovement = request.camera?.movement ?? 'Slow push in';

  let rendered;
  try {
    rendered = await renderLocalPanZoomMp4(
      {
        attemptId,
        storage,
        startFrameStoragePath: startAsset.storage_path,
        startFrameSha256: startAsset.sha256_hash,
        durationSeconds,
        cameraMovement,
      },
      options?.renderOptions,
    );
  } catch (err) {
    if (err instanceof LocalPanZoomError) {
      return settleHandledLocalFailure(attemptId, attInfo.film_id, computedFingerprint, err.code, err.message);
    }
    throw err;
  }

  if (options?.simulateCrashAt === 'AFTER_DISK_WRITE') {
    throw new Error('SIMULATED_CRASH_AFTER_DISK_WRITE');
  }

  const metadataInput: LocalVideoMetadata = {
    provenance: 'LOCAL_PIPELINE',
    executionMode: 'LIVE',
    provider: 'LOCAL_PAN_ZOOM',
    cameraMovement,
    durationSeconds: rendered.durationSeconds,
    startFrameAssetId: startAsset.id,
    startFrameSha256: startAsset.sha256_hash,
    startFrameProvenance,
  };
  const expectedMetadata: LocalVideoMetadata = localVideoMetadataSchema.parse(metadataInput);

  const result = await pgClient.begin(async tx => {
    const [lockedAtt] = await tx<{ state: string }[]>`
      SELECT state FROM attempts WHERE id = ${attemptId} FOR UPDATE
    `;
    if (!lockedAtt) {
      throw new ApiFailure(404, 'ATTEMPT_NOT_FOUND', `Attempt ${attemptId} not found`);
    }

    // Re-check terminal transition race inside FOR UPDATE (LP-AT-05 / LP-AT-08)
    if (lockedAtt.state === 'FAILED' || lockedAtt.state === 'CANCELED') {
      await tx`
        UPDATE dispatch_outbox
        SET status = 'DELIVERED',
            enqueue_outcome = 'WORKER_CONFIRMED',
            delivered_at = COALESCE(delivered_at, now())
        WHERE attempt_id = ${attemptId}
      `;
      return {
        attemptId,
        state: lockedAtt.state as 'FAILED' | 'CANCELED',
        alreadyCompleted: true,
        alreadyTerminal: true,
      };
    }

    const [fin] = await tx<{
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
    if (!fin) {
      throw new ApiFailure(409, 'FINANCIAL_STATE_MISSING', `Financial state missing for attempt ${attemptId}`);
    }
    if (
      fin.reservation_open_usd_micros !== '0' ||
      fin.realized_usd_micros !== '0' ||
      fin.pending_liability_usd_micros !== '0'
    ) {
      throw new ApiFailure(409, 'LOCAL_FINANCIAL_INVARIANT_VIOLATION', 'LOCAL_PAN_ZOOM attempt must carry $0 micros');
    }

    const candidateAssetId = randomUUID();
    const insertedRows = await tx<{ id: string }[]>`
      INSERT INTO assets(
        id, film_id, attempt_id, shot_revision_id, kind,
        storage_path, sha256_hash, mime_type, byte_size, verified, metadata
      ) VALUES (
        ${candidateAssetId},
        ${attInfo.film_id},
        ${attemptId},
        ${shotRevisionId},
        'VIDEO',
        ${rendered.storagePath},
        ${rendered.sha256Hash},
        ${rendered.mimeType},
        ${String(rendered.byteSize)},
        true,
        ${JSON.stringify(expectedMetadata)}::jsonb
      )
      ON CONFLICT (attempt_id) DO NOTHING
      RETURNING id
    `;

    const [assetRow] = await tx<AssetRow[]>`
      SELECT id, film_id, shot_revision_id, kind, storage_path, sha256_hash, mime_type, byte_size::text, metadata
      FROM assets
      WHERE attempt_id = ${attemptId}
    `;
    if (!assetRow) {
      throw new ApiFailure(409, 'CORRUPT_ATTEMPT_ASSET_MISSING', `Asset row missing after upsert for attempt ${attemptId}`);
    }

    // Fail closed if conflicting pre-existing Asset disagrees on hash, path, byte_size, or lineage (LP-AT-06)
    await verifyExistingLocalAsset(
      assetRow,
      {
        filmId: attInfo.film_id,
        shotRevisionId,
        sha256Hash: rendered.sha256Hash,
        storagePath: rendered.storagePath,
        byteSize: rendered.byteSize,
        startFrameAssetId: startAsset.id,
        startFrameSha256: startAsset.sha256_hash,
        startFrameProvenance,
      },
      storage,
    );

    if (fin.billing_status !== 'FINAL') {
      await tx`
        INSERT INTO cost_ledger_events(id, film_id, attempt_id, event_type, amount_usd_micros, billing_status, evidence)
        VALUES(
          ${randomUUID()},
          ${attInfo.film_id},
          ${attemptId},
          'RESERVATION_RELEASED',
          '0',
          'FINAL',
          ${JSON.stringify({
            reason: 'LOCAL_PIPELINE_ZERO_API_FEE',
            assetId: assetRow.id,
            storagePath: rendered.storagePath,
            sha256Hash: rendered.sha256Hash,
            startFrameAssetId: startAsset.id,
            startFrameProvenance,
          })}::jsonb
        )
      `;
      await tx`
        UPDATE attempt_financial_state
        SET billing_status = 'FINAL',
            reservation_open_usd_micros = '0',
            realized_usd_micros = '0',
            pending_liability_usd_micros = '0',
            version = version + 1,
            updated_at = now()
        WHERE attempt_id = ${attemptId}
      `;
    }

    await tx`
      UPDATE attempts
      SET state = 'SUCCEEDED'
      WHERE id = ${attemptId} AND state IN ('QUEUED', 'SUBMITTED', 'RUNNING')
    `;

    await tx`
      INSERT INTO outbound_dispatches(attempt_id, state, claim_token, provider_request_fingerprint)
      VALUES(${attemptId}, 'SUCCEEDED', ${randomUUID()}, ${computedFingerprint})
      ON CONFLICT (attempt_id) DO UPDATE
      SET state = 'SUCCEEDED', updated_at = now()
      WHERE outbound_dispatches.state NOT IN ('SUCCEEDED', 'FAILED')
    `;

    await tx`
      UPDATE dispatch_outbox
      SET status = 'DELIVERED',
          enqueue_outcome = 'WORKER_CONFIRMED',
          delivered_at = COALESCE(delivered_at, now())
      WHERE attempt_id = ${attemptId}
    `;

    return {
      attemptId,
      state: 'SUCCEEDED' as const,
      assetId: assetRow.id,
      alreadyCompleted: insertedRows.length === 0 && lockedAtt.state === 'SUCCEEDED',
      alreadyTerminal: false,
    };
  });

  if (options?.simulateCrashAt === 'AFTER_DB_COMMIT_BEFORE_ACK') {
    throw new Error('SIMULATED_CRASH_AFTER_DB_COMMIT_BEFORE_ACK');
  }

  return result;
}
