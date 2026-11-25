import { createHash, randomUUID } from 'node:crypto';
import { link, open, readFile, unlink } from 'node:fs/promises';
import path from 'node:path';
import type postgres from 'postgres';
import type { ReferenceAssetDto, StoryBible } from '@nolen/contracts';
import { pgClient } from '../db/index.js';
import { ApiFailure } from '../http/errors.js';
import type { ParsedReferenceUpload } from '../http/boundary.js';
import { validateStaticReferenceImage, type MediaValidationOptions, type ReferenceImageMime } from '../lib/media-validation.js';
import { storage } from '../lib/storage.js';

type Tx = postgres.TransactionSql;

export interface ReferenceAssetRow {
  id: string;
  film_id: string;
  storage_path: string;
  sha256_hash: string;
  mime_type: ReferenceImageMime;
  byte_size: string | bigint;
  width: number;
  height: number;
  label: string;
  source_note: string;
  license_url: string | null;
  rights_confirmed_by: string;
  rights_confirmed_at: Date | string;
  created_at: Date | string;
}

export interface UploadReferenceOptions {
  mediaOptions?: MediaValidationOptions;
  simulateCrashAt?: 'BEFORE_PUBLISH' | 'AFTER_PUBLISH_BEFORE_DB';
}

const MIME_TO_EXT: Record<ReferenceImageMime, string> = {
  'image/png': '.png',
  'image/jpeg': '.jpg',
  'image/webp': '.webp',
};

export function toReferenceAssetDto(row: ReferenceAssetRow): ReferenceAssetDto {
  return {
    id: row.id,
    filmId: row.film_id,
    mediaUrl: `/api/films/${row.film_id}/reference-assets/${row.id}/media`,
    sha256Hash: row.sha256_hash,
    mimeType: row.mime_type,
    byteSize: String(row.byte_size),
    width: row.width,
    height: row.height,
    label: row.label,
    sourceNote: row.source_note,
    licenseUrl: row.license_url,
    rightsConfirmedBy: row.rights_confirmed_by,
    rightsConfirmedAt: new Date(row.rights_confirmed_at).toISOString(),
    createdAt: new Date(row.created_at).toISOString(),
  };
}

/**
 * Stages a validated reference image into a same-filesystem temp file, fsyncs,
 * verifies hash, and atomically publishes via hard-link without overwriting existing blobs.
 */
async function publishReferenceBlob(
  filename: string,
  buffer: Buffer,
  expectedSha256: string,
  simulateCrashAt?: 'BEFORE_PUBLISH' | 'AFTER_PUBLISH_BEFORE_DB',
): Promise<void> {
  storage.resolveDir('references');
  const tmpFilename = `.tmp-${randomUUID()}`;
  const tmpPath = storage.resolve('references', tmpFilename);
  const targetPath = storage.resolve('references', filename);

  const fh = await open(tmpPath, 'wx');
  try {
    await fh.writeFile(buffer);
    await fh.sync();
  } finally {
    await fh.close();
  }

  try {
    const stagedData = await readFile(tmpPath);
    const stagedHash = createHash('sha256').update(stagedData).digest('hex');
    if (stagedHash !== expectedSha256) {
      throw new ApiFailure(409, 'INTEGRITY_CHECK_FAILED', 'Staged reference blob failed hash verification');
    }

    if (simulateCrashAt === 'BEFORE_PUBLISH') {
      throw new Error('SIMULATED_CRASH_BEFORE_PUBLISH');
    }

    try {
      await link(tmpPath, targetPath);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException)?.code;
      if (code !== 'EEXIST') {
        throw err;
      }
      // Target already exists: verify hash integrity; never overwrite or delete shared blobs
      const existingData = await readFile(targetPath);
      const existingHash = createHash('sha256').update(existingData).digest('hex');
      if (existingHash !== expectedSha256) {
        throw new ApiFailure(409, 'REFERENCE_BLOB_CORRUPT', 'Existing reference blob failed integrity check');
      }
    }

    if (simulateCrashAt === 'AFTER_PUBLISH_BEFORE_DB') {
      throw new Error('SIMULATED_CRASH_AFTER_PUBLISH_BEFORE_DB');
    }
  } finally {
    await unlink(tmpPath).catch(() => undefined);
  }
}

export async function uploadReferenceAsset(
  filmId: string,
  operatorId: string,
  upload: ParsedReferenceUpload,
  options: UploadReferenceOptions = {},
): Promise<ReferenceAssetDto> {
  const [film] = await pgClient<{ id: string }[]>`
    SELECT id FROM films WHERE id = ${filmId} AND operator_id = ${operatorId}
  `;
  if (!film) {
    throw new ApiFailure(404, 'FILM_NOT_FOUND', 'Film not found');
  }

  const validated = await validateStaticReferenceImage(upload.fileBuffer, options.mediaOptions);
  const sha256Hash = createHash('sha256').update(upload.fileBuffer).digest('hex');
  const ext = MIME_TO_EXT[validated.mimeType];
  const filename = `${sha256Hash}${ext}`;
  const storagePath = `references/${filename}`;

  await publishReferenceBlob(filename, upload.fileBuffer, sha256Hash, options.simulateCrashAt);

  return pgClient.begin('isolation level read committed', async tx => {
    const [owned] = await tx<{ id: string }[]>`
      SELECT id FROM films WHERE id = ${filmId} AND operator_id = ${operatorId}
    `;
    if (!owned) {
      throw new ApiFailure(404, 'FILM_NOT_FOUND', 'Film not found');
    }

    const id = randomUUID();
    const byteSize = String(upload.fileBuffer.byteLength);

    const [inserted] = await tx<ReferenceAssetRow[]>`
      INSERT INTO film_reference_assets (
        id, film_id, storage_path, sha256_hash, mime_type, byte_size,
        width, height, label, source_note, license_url, rights_confirmed_by
      ) VALUES (
        ${id}, ${filmId}, ${storagePath}, ${sha256Hash}, ${validated.mimeType}, ${byteSize},
        ${validated.width}, ${validated.height}, ${upload.label}, ${upload.sourceNote},
        ${upload.licenseUrl}, ${operatorId}
      )
      ON CONFLICT (film_id, sha256_hash) DO NOTHING
      RETURNING *
    `;

    if (inserted) {
      return toReferenceAssetDto(inserted);
    }

    const [existing] = await tx<ReferenceAssetRow[]>`
      SELECT * FROM film_reference_assets
      WHERE film_id = ${filmId} AND sha256_hash = ${sha256Hash}
    `;
    if (!existing) {
      throw new ApiFailure(500, 'INTERNAL_ERROR', 'Failed to resolve concurrent reference asset insert');
    }

    const metadataMatches =
      existing.label === upload.label &&
      existing.source_note === upload.sourceNote &&
      (existing.license_url ?? null) === (upload.licenseUrl ?? null) &&
      existing.rights_confirmed_by === operatorId;

    if (!metadataMatches) {
      throw new ApiFailure(
        409,
        'REFERENCE_METADATA_CONFLICT',
        'An identical reference image already exists for this Film with different metadata',
      );
    }

    return toReferenceAssetDto(existing);
  });
}

export async function listReferenceAssets(filmId: string, operatorId: string): Promise<ReferenceAssetDto[]> {
  const [film] = await pgClient<{ id: string }[]>`
    SELECT id FROM films WHERE id = ${filmId} AND operator_id = ${operatorId}
  `;
  if (!film) {
    throw new ApiFailure(404, 'FILM_NOT_FOUND', 'Film not found');
  }

  const rows = await pgClient<ReferenceAssetRow[]>`
    SELECT * FROM film_reference_assets
    WHERE film_id = ${filmId}
    ORDER BY created_at DESC, id DESC
  `;
  return rows.map(toReferenceAssetDto);
}

export async function getReferenceAssetMedia(
  filmId: string,
  assetId: string,
  operatorId: string,
): Promise<{ buffer: Buffer; mimeType: ReferenceImageMime; byteSize: string; sha256: string }> {
  const [row] = await pgClient<ReferenceAssetRow[]>`
    SELECT ra.*
    FROM film_reference_assets ra
    JOIN films f ON f.id = ra.film_id
    WHERE ra.id = ${assetId} AND ra.film_id = ${filmId} AND f.operator_id = ${operatorId}
  `;
  if (!row) {
    throw new ApiFailure(404, 'REFERENCE_ASSET_NOT_FOUND', 'Reference asset not found');
  }

  if (!row.storage_path.startsWith('references/')) {
    throw new ApiFailure(409, 'INTEGRITY_CHECK_FAILED', 'Invalid reference storage path');
  }
  const filename = path.basename(row.storage_path);
  if (filename.startsWith('.tmp-')) {
    throw new ApiFailure(409, 'INTEGRITY_CHECK_FAILED', 'Temporary staging file cannot be served');
  }
  if (!storage.exists('references', filename)) {
    throw new ApiFailure(404, 'ASSET_FILE_MISSING', 'Reference image file missing from storage');
  }

  const buffer = await storage.read('references', filename);
  const actualHash = createHash('sha256').update(buffer).digest('hex');
  if (actualHash !== row.sha256_hash) {
    throw new ApiFailure(409, 'INTEGRITY_CHECK_FAILED', 'Reference asset failed disk SHA-256 verification');
  }

  return {
    buffer,
    mimeType: row.mime_type,
    byteSize: String(buffer.byteLength),
    sha256: row.sha256_hash,
  };
}

/**
 * Verifies all referenceAssetIds referenced in a StoryBible v2 belong to the Film,
 * have confirmed usage rights, and pass on-disk SHA-256 integrity.
 */
export async function verifyStoryBibleReferences(
  tx: Tx,
  filmId: string,
  bible: StoryBible,
): Promise<Map<string, ReferenceAssetRow>> {
  const result = new Map<string, ReferenceAssetRow>();
  if (bible.schemaVersion !== '2') {
    return result;
  }

  const allIds = new Set<string>();
  for (const group of ['characters', 'wardrobes', 'props', 'locations', 'styleRefs'] as const) {
    for (const def of bible[group]) {
      for (const id of def.referenceAssetIds) {
        allIds.add(id);
      }
    }
  }

  if (allIds.size === 0) {
    return result;
  }

  const idList = [...allIds];
  const rows = await tx<ReferenceAssetRow[]>`
    SELECT * FROM film_reference_assets
    WHERE film_id = ${filmId} AND id = ANY(${idList}::uuid[])
  `;

  if (rows.length !== idList.length) {
    throw new ApiFailure(422, 'REFERENCE_ASSET_INVALID', 'One or more bound reference assets do not belong to this Film');
  }

  for (const row of rows) {
    if (!row.rights_confirmed_by || !row.rights_confirmed_by.trim()) {
      throw new ApiFailure(422, 'RIGHTS_CONFIRMATION_REQUIRED', `Reference asset ${row.id} lacks usage rights confirmation`);
    }
    const filename = path.basename(row.storage_path);
    if (!row.storage_path.startsWith('references/') || filename.startsWith('.tmp-') || !storage.exists('references', filename)) {
      throw new ApiFailure(409, 'INTEGRITY_CHECK_FAILED', `Reference asset ${row.id} is missing from storage`);
    }
    const ok = await storage.verify('references', filename, row.sha256_hash).catch(() => false);
    if (!ok) {
      throw new ApiFailure(409, 'INTEGRITY_CHECK_FAILED', `Reference asset ${row.id} failed disk integrity check`);
    }
    result.set(row.id, row);
  }

  return result;
}
