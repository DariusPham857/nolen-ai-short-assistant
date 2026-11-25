import { randomUUID } from 'node:crypto';
import type { CreateAttempt } from '@nolen/contracts';
import { admitAttempt, previewGeneration, type AttemptReceipt } from '../financial/repository.js';

/**
 * Positive-path test helper for media attempts (`IMAGE` / `VIDEO`):
 * calls `previewGeneration` first to obtain authoritative `previewHash`,
 * then admits the attempt with `expectedPreviewHash`.
 * Do NOT use this helper in tests proving missing/stale preview rejection.
 */
export async function previewAndAdmitMediaAttempt(
  filmId: string,
  operatorId: string,
  idempotencyKey: string,
  input: Omit<CreateAttempt, 'expectedPreviewHash'> & { kind: 'IMAGE' | 'VIDEO'; shotRevisionId: string },
): Promise<{ previewHash: string; receipt: AttemptReceipt }> {
  const preview = await previewGeneration(filmId, operatorId, {
    storyRevisionId: input.storyRevisionId,
    shotRevisionId: input.shotRevisionId,
    kind: input.kind,
    rateCardSnapshotId: input.rateCardSnapshotId,
    pricingUnits: input.pricingUnits,
    executionMode: input.executionMode ?? 'REPLAY',
    fixturePackVersion: input.fixturePackVersion,
    fixtureId: input.fixtureId,
  });

  const receipt = await admitAttempt(filmId, operatorId, idempotencyKey, {
    ...input,
    executionMode: input.executionMode ?? 'REPLAY',
    expectedPreviewHash: preview.previewHash,
  });

  return { previewHash: preview.previewHash, receipt };
}
