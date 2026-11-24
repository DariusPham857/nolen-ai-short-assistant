import { createHash, randomUUID } from 'node:crypto';
import path from 'node:path';
import type { AssetDto, ReviewAsset, ShotAssetSelectionDto, SelectShotAsset, ShotAttemptDto } from '@nolen/contracts';
import { pgClient } from '../db/index.js';
import { ApiFailure } from '../http/errors.js';
import { storage, type AssetCategory } from '../lib/storage.js';

export type AssetRow = {
  id: string;
  film_id: string;
  attempt_id: string;
  shot_revision_id: string;
  kind: 'IMAGE' | 'VIDEO';
  storage_path: string;
  sha256_hash: string;
  mime_type: string;
  byte_size: string | bigint;
  verified: boolean;
  metadata: Record<string, unknown> | string;
  created_at: Date | string;
};

export type AssetWithStatusDto = AssetDto & {
  latestReviewDecision: 'APPROVED' | 'REJECTED' | null;
  latestReviewReason: string | null;
  reviewCount: number;
  isSelected: boolean;
};

const MAX_IMAGE_BYTES = 50 * 1024 * 1024; // 50MB
const MAX_VIDEO_BYTES = 500 * 1024 * 1024; // 500MB

const ALLOWED_MIME_EXT: Record<string, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
  'video/mp4': '.mp4',
};

export function toAssetDto(row: AssetRow): AssetDto {
  const metadata = (typeof row.metadata === 'string' ? JSON.parse(row.metadata) : (row.metadata ?? {})) as Record<string, unknown>;
  return {
    id: row.id,
    filmId: row.film_id,
    attemptId: row.attempt_id,
    shotRevisionId: row.shot_revision_id,
    kind: row.kind,
    mediaUrl: `/api/assets/${row.id}/media`,
    sha256Hash: row.sha256_hash,
    mimeType: row.mime_type,
    byteSize: String(row.byte_size),
    metadata,
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/** Store a media asset with content-addressed storage and database registration. */
export async function storeAsset(input: {
  attemptId: string;
  buffer: Buffer;
  mimeType: string;
  filmId?: string;
  shotRevisionId?: string;
  kind?: 'IMAGE' | 'VIDEO';
  metadata?: Record<string, unknown>;
}): Promise<AssetDto> {
  // Derive and verify provenance from the attempt row
  const [attempt] = await pgClient<{
    id: string;
    film_id: string;
    shot_revision_id: string | null;
    kind: 'IMAGE' | 'VIDEO' | 'TTS' | 'ASSEMBLY';
  }[]>`
    SELECT id, film_id, shot_revision_id, kind
    FROM attempts
    WHERE id = ${input.attemptId}
  `;
  if (!attempt) {
    throw new ApiFailure(404, 'ATTEMPT_NOT_FOUND', 'Attempt not found');
  }
  if (!attempt.shot_revision_id) {
    throw new ApiFailure(422, 'INVALID_ATTEMPT_KIND', 'Attempt is not tied to a shot revision');
  }
  if (!['IMAGE', 'VIDEO'].includes(attempt.kind)) {
    throw new ApiFailure(422, 'INVALID_ATTEMPT_KIND', 'Attempt kind is not eligible for media asset storage');
  }

  // Fail closed if caller supplied conflicting provenance
  if (input.filmId && input.filmId !== attempt.film_id) {
    throw new ApiFailure(422, 'ATTEMPT_PROVENANCE_MISMATCH', 'filmId does not match attempt provenance');
  }
  if (input.shotRevisionId && input.shotRevisionId !== attempt.shot_revision_id) {
    throw new ApiFailure(422, 'ATTEMPT_PROVENANCE_MISMATCH', 'shotRevisionId does not match attempt provenance');
  }
  if (input.kind && input.kind !== attempt.kind) {
    throw new ApiFailure(422, 'ATTEMPT_PROVENANCE_MISMATCH', 'kind does not match attempt provenance');
  }

  const filmId = attempt.film_id;
  const shotRevisionId = attempt.shot_revision_id;
  const kind = attempt.kind as 'IMAGE' | 'VIDEO';

  const maxBytes = kind === 'IMAGE' ? MAX_IMAGE_BYTES : MAX_VIDEO_BYTES;
  if (input.buffer.length > maxBytes) {
    throw new ApiFailure(413, 'PAYLOAD_TOO_LARGE', `Asset byte size exceeds limit of ${maxBytes} bytes`);
  }

  const ext = ALLOWED_MIME_EXT[input.mimeType];
  if (!ext) {
    throw new ApiFailure(415, 'UNSUPPORTED_MEDIA_TYPE', `Unsupported mime type: ${input.mimeType}`);
  }

  if (kind === 'IMAGE' && !input.mimeType.startsWith('image/')) {
    throw new ApiFailure(422, 'INVALID_ASSET_KIND', 'Image assets require image MIME type');
  }
  if (kind === 'VIDEO' && !input.mimeType.startsWith('video/')) {
    throw new ApiFailure(422, 'INVALID_ASSET_KIND', 'Video assets require video MIME type');
  }

  const sha256 = createHash('sha256').update(input.buffer).digest('hex');
  const filename = `${sha256}${ext}`;
  const category: AssetCategory = kind === 'IMAGE' ? 'keyframes' : 'videos';

  await storage.write(category, filename, input.buffer);
  const storagePath = `${category}/${filename}`;

  const assetId = randomUUID();
  try {
    const [row] = await pgClient<AssetRow[]>`
      INSERT INTO assets (
        id, film_id, attempt_id, shot_revision_id, kind,
        storage_path, sha256_hash, mime_type, byte_size,
        verified, metadata, created_at
      ) VALUES (
        ${assetId}, ${filmId}, ${input.attemptId}, ${shotRevisionId}, ${kind},
        ${storagePath}, ${sha256}, ${input.mimeType}, ${input.buffer.length},
        true, ${JSON.stringify(input.metadata ?? {})}::jsonb, clock_timestamp()
      )
      RETURNING *
    `;
    return toAssetDto(row);
  } catch (err: unknown) {
    const error = err as { code?: string; constraint?: string };
    if (error?.code === '23505') {
      throw new ApiFailure(409, 'ASSET_ALREADY_EXISTS', 'Asset already exists for this attempt');
    }
    if (error?.code === '23503') {
      throw new ApiFailure(422, 'INVALID_REFERENCE', 'Referenced film, attempt, or shot revision does not exist');
    }
    throw err;
  }
}

/** Review an asset, updating asset_reviews and active shot_asset_selections under the film row lock. */
export async function reviewAsset(
  assetId: string,
  actorId: string,
  input: ReviewAsset,
  expectedFilmId?: string,
): Promise<{ reviewId: string; decision: 'APPROVED' | 'REJECTED'; selection: ShotAssetSelectionDto | null }> {
  return pgClient.begin('isolation level read committed', async tx => {
    const [asset] = await tx<AssetRow[]>`
      SELECT * FROM assets
      WHERE id = ${assetId}
    `;
    if (!asset) {
      throw new ApiFailure(404, 'ASSET_NOT_FOUND', 'Asset not found');
    }

    const filmId = expectedFilmId ?? asset.film_id;
    if (expectedFilmId && asset.film_id !== expectedFilmId) {
      throw new ApiFailure(404, 'ASSET_NOT_FOUND', 'Asset not found for this film');
    }

    // Lock film row to preserve global lock order: film_budget_accounts -> films -> attempt_financial_state -> assets/reviews
    const [film] = await tx<{ id: string; operator_id: string; active_story_revision_id: string | null }[]>`
      SELECT id, operator_id, active_story_revision_id
      FROM films
      WHERE id = ${filmId} AND operator_id = ${actorId}
      FOR UPDATE
    `;
    if (!film) {
      throw new ApiFailure(404, 'FILM_NOT_FOUND', 'Film not found');
    }

    if (asset.shot_revision_id !== input.expectedShotRevisionId) {
      throw new ApiFailure(409, 'ASSET_SHOT_REVISION_MISMATCH', 'Asset does not belong to expected ShotRevision');
    }

    const [reviewCountRow] = await tx<{ count: string }[]>`
      SELECT count(*)::text as count FROM asset_reviews WHERE asset_id = ${assetId}
    `;
    const currentCount = parseInt(reviewCountRow.count, 10);
    if (currentCount !== input.expectedReviewCount) {
      throw new ApiFailure(409, 'VERSION_CONFLICT', 'Asset review state changed; reload before reviewing');
    }

    const category: AssetCategory = asset.storage_path.startsWith('keyframes') ? 'keyframes' : 'videos';
    const filename = path.basename(asset.storage_path);
    if (!storage.exists(category, filename)) {
      throw new ApiFailure(422, 'INTEGRITY_CHECK_FAILED', 'Asset file missing from storage');
    }
    let verifiedOnDisk = false;
    try {
      verifiedOnDisk = await storage.verify(category, filename, asset.sha256_hash);
    } catch {
      verifiedOnDisk = false;
    }
    if (!verifiedOnDisk) {
      throw new ApiFailure(422, 'INTEGRITY_CHECK_FAILED', 'Asset file on disk failed integrity check');
    }

    const reviewId = randomUUID();
    await tx`
      INSERT INTO asset_reviews (
        id, asset_id, film_id, shot_revision_id, actor_id, decision, reason, created_at
      ) VALUES (
        ${reviewId}, ${assetId}, ${filmId}, ${asset.shot_revision_id}, ${actorId},
        ${input.decision}, ${input.reason ?? ''}, clock_timestamp()
      )
    `;

    let selection: ShotAssetSelectionDto | null = null;
    if (film.active_story_revision_id) {
      const [shotLink] = await tx<{ story_revision_id: string; shot_id: string }[]>`
        SELECT story_revision_id, shot_id
        FROM story_revision_shots
        WHERE film_id = ${filmId}
          AND shot_revision_id = ${asset.shot_revision_id}
          AND story_revision_id = ${film.active_story_revision_id}
      `;

      if (shotLink) {
        if (input.decision === 'APPROVED') {
          const [selRow] = await tx<{
            story_revision_id: string;
            shot_id: string;
            shot_revision_id: string;
            asset_id: string;
            kind: 'IMAGE' | 'VIDEO';
            selected_at: Date | string;
          }[]>`
            INSERT INTO shot_asset_selections (
              story_revision_id, shot_id, kind, shot_revision_id,
              asset_id, film_id, selected_by, selected_at
            ) VALUES (
              ${shotLink.story_revision_id}, ${shotLink.shot_id}, ${asset.kind}, ${asset.shot_revision_id},
              ${assetId}, ${filmId}, ${actorId}, clock_timestamp()
            )
            ON CONFLICT (story_revision_id, shot_id, kind)
            DO UPDATE SET
              shot_revision_id = EXCLUDED.shot_revision_id,
              asset_id = EXCLUDED.asset_id,
              selected_by = EXCLUDED.selected_by,
              selected_at = EXCLUDED.selected_at
            RETURNING story_revision_id, shot_id, shot_revision_id, asset_id, kind, selected_at
          `;

          selection = {
            storyRevisionId: selRow.story_revision_id,
            shotId: selRow.shot_id,
            shotRevisionId: selRow.shot_revision_id,
            assetId: selRow.asset_id,
            kind: selRow.kind,
            reviewDecision: 'APPROVED',
            selectedAt: new Date(selRow.selected_at).toISOString(),
            asset: toAssetDto(asset),
          };
        } else {
          // REJECTED: remove selection if this asset was selected
          await tx`
            DELETE FROM shot_asset_selections
            WHERE story_revision_id = ${shotLink.story_revision_id}
              AND shot_id = ${shotLink.shot_id}
              AND kind = ${asset.kind}
              AND asset_id = ${assetId}
          `;
        }
      }
    }

    return { reviewId, decision: input.decision, selection };
  });
}

/** Get all assets for a shot within a film, including latest review decision and selection status. */
export async function getShotAssets(
  filmId: string,
  shotId: string,
  operatorId: string,
): Promise<AssetWithStatusDto[]> {
  const [film] = await pgClient<{ id: string; active_story_revision_id: string | null }[]>`
    SELECT id, active_story_revision_id FROM films WHERE id = ${filmId} AND operator_id = ${operatorId}
  `;
  if (!film) {
    throw new ApiFailure(404, 'FILM_NOT_FOUND', 'Film not found');
  }

  type JoinedRow = AssetRow & {
    latest_review_decision: 'APPROVED' | 'REJECTED' | null;
    latest_review_reason: string | null;
    review_count: number;
    is_selected: boolean;
  };

  const rows = await pgClient<JoinedRow[]>`
    SELECT a.*,
           lr.decision AS latest_review_decision,
           lr.reason AS latest_review_reason,
           COALESCE(rc.review_count, 0)::int AS review_count,
           (s.asset_id IS NOT NULL) AS is_selected
    FROM assets a
    JOIN story_revision_shots srs ON srs.film_id = a.film_id AND srs.shot_revision_id = a.shot_revision_id
    LEFT JOIN (
      SELECT DISTINCT ON (r.asset_id) r.asset_id, r.decision, r.reason, r.created_at, r.id
      FROM asset_reviews r
      ORDER BY r.asset_id, r.created_at DESC, r.id DESC
    ) lr ON lr.asset_id = a.id
    LEFT JOIN (
      SELECT asset_id, count(*)::int AS review_count
      FROM asset_reviews
      GROUP BY asset_id
    ) rc ON rc.asset_id = a.id
    LEFT JOIN shot_asset_selections s ON s.asset_id = a.id
      AND s.story_revision_id = srs.story_revision_id
      AND s.shot_id = srs.shot_id
      AND s.kind = a.kind
    WHERE a.film_id = ${filmId}
      AND srs.shot_id = ${shotId}
      AND srs.story_revision_id = ${film.active_story_revision_id}
    ORDER BY a.created_at DESC
  `;

  return rows.map(r => ({
    ...toAssetDto(r),
    latestReviewDecision: r.latest_review_decision,
    latestReviewReason: r.latest_review_reason,
    reviewCount: r.review_count,
    isSelected: r.is_selected,
  }));
}

/** Retrieve asset media file buffer and metadata with operator authorization check. */
export async function getAssetMedia(assetId: string, operatorId: string): Promise<{
  buffer: Buffer;
  mimeType: string;
  byteSize: string;
  sha256: string;
}> {
  const [asset] = await pgClient<AssetRow[]>`
    SELECT a.*
    FROM assets a
    JOIN films f ON f.id = a.film_id
    WHERE a.id = ${assetId} AND f.operator_id = ${operatorId}
  `;
  if (!asset) {
    throw new ApiFailure(404, 'ASSET_NOT_FOUND', 'Asset not found');
  }

  const category: AssetCategory = asset.storage_path.startsWith('keyframes') ? 'keyframes' : 'videos';
  const filename = path.basename(asset.storage_path);
  const buffer = await storage.read(category, filename);

  return {
    buffer,
    mimeType: asset.mime_type,
    byteSize: String(asset.byte_size),
    sha256: asset.sha256_hash,
  };
}

/**
 * Synthetic Test Fixture Harness:
 * Generates an in-memory test asset without external AI providers or altering financial ledgers.
 */
export async function fakeAssetProducer(input: {
  filmId: string;
  attemptId: string;
  shotRevisionId: string;
  kind?: 'IMAGE' | 'VIDEO';
}): Promise<AssetDto> {
  const kind = input.kind ?? 'IMAGE';
  let buffer: Buffer;
  let mimeType: string;

  if (kind === 'IMAGE') {
    // 1x1 valid PNG transparent pixel
    buffer = Buffer.from(
      '89504e470d0a1a0a0000000d49484452000000010000000108060000001f15c4890000000a49444154789c63000100000500010d0a2db40000000049454e44ae426082',
      'hex',
    );
    mimeType = 'image/png';
  } else {
    // Minimal mock MP4 header bytes
    buffer = Buffer.from('000000206674797069736f6d0000020069736f6d69736f32617663316d703431', 'hex');
    mimeType = 'video/mp4';
  }

  return storeAsset({
    filmId: input.filmId,
    attemptId: input.attemptId,
    shotRevisionId: input.shotRevisionId,
    kind,
    buffer,
    mimeType,
    metadata: { fixture: true, timestamp: Date.now() },
  });
}

/**
 * Select an approved asset as the authoritative selection for a shot.
 * Enforces:
 * - Film ownership & active story revision
 * - Asset belongs to film and matches requested kind
 * - Asset belongs to shot in active story revision
 * - Asset has latest review decision APPROVED
 * - Atomically upserts into shot_asset_selections
 */
export async function selectShotAsset(
  filmId: string,
  shotId: string,
  operatorId: string,
  input: SelectShotAsset,
): Promise<ShotAssetSelectionDto> {
  return pgClient.begin(async tx => {
    const [film] = await tx<{ id: string; active_story_revision_id: string | null }[]>`
      SELECT id, active_story_revision_id FROM films WHERE id = ${filmId} AND operator_id = ${operatorId} FOR UPDATE
    `;
    if (!film) {
      throw new ApiFailure(404, 'FILM_NOT_FOUND', 'Film not found');
    }
    if (!film.active_story_revision_id) {
      throw new ApiFailure(409, 'NO_ACTIVE_STORY_REVISION', 'Film has no active story revision');
    }

    const [asset] = await tx<AssetRow[]>`
      SELECT * FROM assets WHERE id = ${input.assetId} AND film_id = ${filmId}
    `;
    if (!asset) {
      throw new ApiFailure(404, 'ASSET_NOT_FOUND', 'Asset not found');
    }
    if (asset.kind !== input.kind) {
      throw new ApiFailure(422, 'ASSET_KIND_MISMATCH', `Asset kind ${asset.kind} does not match requested kind ${input.kind}`);
    }

    const [shotLink] = await tx<{ story_revision_id: string; shot_id: string }[]>`
      SELECT story_revision_id, shot_id
      FROM story_revision_shots
      WHERE film_id = ${filmId}
        AND shot_id = ${shotId}
        AND shot_revision_id = ${asset.shot_revision_id}
        AND story_revision_id = ${film.active_story_revision_id}
    `;
    if (!shotLink) {
      throw new ApiFailure(422, 'SHOT_REVISION_MISMATCH', 'Asset does not belong to the active revision of this shot');
    }

    const [latestReview] = await tx<{ decision: 'APPROVED' | 'REJECTED' }[]>`
      SELECT decision FROM asset_reviews
      WHERE asset_id = ${input.assetId}
      ORDER BY created_at DESC, id DESC
      LIMIT 1
    `;
    if (!latestReview || latestReview.decision !== 'APPROVED') {
      throw new ApiFailure(422, 'ASSET_NOT_APPROVED', 'Only approved assets can be selected');
    }

    const [selRow] = await tx<{
      story_revision_id: string;
      shot_id: string;
      shot_revision_id: string;
      asset_id: string;
      kind: 'IMAGE' | 'VIDEO';
      selected_at: Date | string;
    }[]>`
      INSERT INTO shot_asset_selections (
        story_revision_id, shot_id, kind, shot_revision_id,
        asset_id, film_id, selected_by, selected_at
      ) VALUES (
        ${shotLink.story_revision_id}, ${shotId}, ${input.kind}, ${asset.shot_revision_id},
        ${input.assetId}, ${filmId}, ${operatorId}, clock_timestamp()
      )
      ON CONFLICT (story_revision_id, shot_id, kind)
      DO UPDATE SET
        shot_revision_id = EXCLUDED.shot_revision_id,
        asset_id = EXCLUDED.asset_id,
        selected_by = EXCLUDED.selected_by,
        selected_at = EXCLUDED.selected_at
      RETURNING story_revision_id, shot_id, shot_revision_id, asset_id, kind, selected_at
    `;

    return {
      storyRevisionId: selRow.story_revision_id,
      shotId: selRow.shot_id,
      shotRevisionId: selRow.shot_revision_id,
      assetId: selRow.asset_id,
      kind: selRow.kind,
      reviewDecision: 'APPROVED',
      selectedAt: new Date(selRow.selected_at).toISOString(),
      asset: toAssetDto(asset),
    };
  });
}

/**
 * Get all attempts generated for a specific shot in the film's active story revision.
 */
export async function getShotAttempts(
  filmId: string,
  shotId: string,
  operatorId: string,
): Promise<ShotAttemptDto[]> {
  const [film] = await pgClient<{ id: string; active_story_revision_id: string | null }[]>`
    SELECT id, active_story_revision_id FROM films WHERE id = ${filmId} AND operator_id = ${operatorId}
  `;
  if (!film) {
    throw new ApiFailure(404, 'FILM_NOT_FOUND', 'Film not found');
  }

  type AttemptJoinedRow = {
    id: string;
    film_id: string;
    story_revision_id: string | null;
    shot_revision_id: string | null;
    kind: 'IMAGE' | 'VIDEO' | 'TTS' | 'ASSEMBLY';
    state: 'QUEUED' | 'RUNNING' | 'SUCCEEDED' | 'FAILED' | 'CANCELED';
    execution_mode: 'LIVE' | 'REPLAY';
    provider: string | null;
    asset_id: string | null;
    latest_review_decision: 'APPROVED' | 'REJECTED' | null;
    is_selected: boolean;
    created_at: Date | string;
  };

  const rows = await pgClient<AttemptJoinedRow[]>`
    SELECT a.id, a.film_id, a.story_revision_id, a.shot_revision_id,
           a.kind, a.state, a.execution_mode, a.created_at,
           rcs.provider,
           ast.id AS asset_id,
           lr.decision AS latest_review_decision,
           (s.asset_id IS NOT NULL) AS is_selected
    FROM attempts a
    JOIN story_revision_shots srs ON srs.film_id = a.film_id AND srs.shot_revision_id = a.shot_revision_id
    LEFT JOIN rate_card_snapshots rcs ON rcs.id = a.rate_card_snapshot_id
    LEFT JOIN assets ast ON ast.attempt_id = a.id
    LEFT JOIN (
      SELECT DISTINCT ON (r.asset_id) r.asset_id, r.decision, r.created_at, r.id
      FROM asset_reviews r
      ORDER BY r.asset_id, r.created_at DESC, r.id DESC
    ) lr ON lr.asset_id = ast.id
    LEFT JOIN shot_asset_selections s ON s.asset_id = ast.id
      AND s.story_revision_id = srs.story_revision_id
      AND s.shot_id = srs.shot_id
      AND s.kind = a.kind
    WHERE a.film_id = ${filmId}
      AND srs.shot_id = ${shotId}
      AND srs.story_revision_id = ${film.active_story_revision_id}
    ORDER BY a.created_at DESC
  `;

  return rows.map(r => ({
    id: r.id,
    filmId: r.film_id,
    storyRevisionId: r.story_revision_id,
    shotRevisionId: r.shot_revision_id,
    kind: r.kind,
    state: r.state,
    executionMode: r.execution_mode,
    provider: r.provider ?? undefined,
    assetId: r.asset_id ?? null,
    latestReviewDecision: r.latest_review_decision ?? null,
    isSelected: r.is_selected,
    createdAt: new Date(r.created_at).toISOString(),
  }));
}

