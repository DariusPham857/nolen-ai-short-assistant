import { z } from 'zod';

export const assetKindSchema = z.enum(['IMAGE', 'VIDEO']);
export const assetReviewDecisionSchema = z.enum(['APPROVED', 'REJECTED']);

export const assetDtoSchema = z.object({
  id: z.string().uuid(),
  filmId: z.string().uuid(),
  attemptId: z.string().uuid(),
  shotRevisionId: z.string().uuid(),
  kind: assetKindSchema,
  mediaUrl: z.string().min(1),
  sha256Hash: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string().min(1).max(64),
  byteSize: z.string().regex(/^(0|[1-9]\d*)$/),
  metadata: z.record(z.unknown()),
  createdAt: z.string().datetime(),
});

export const reviewAssetSchema = z.object({
  decision: assetReviewDecisionSchema,
  reason: z.string().trim().max(1000).optional().default(''),
  expectedShotRevisionId: z.string().uuid(),
  expectedReviewCount: z.number().int().nonnegative(),
}).strict().superRefine((val, ctx) => {
  if (val.decision === 'REJECTED' && (!val.reason || val.reason.trim().length === 0)) {
    ctx.addIssue({
      code: 'custom',
      path: ['reason'],
      message: 'Reason is required when rejecting an asset',
    });
  }
});

export const shotAssetSelectionDtoSchema = z.object({
  storyRevisionId: z.string().uuid(),
  shotId: z.string().uuid(),
  shotRevisionId: z.string().uuid(),
  assetId: z.string().uuid(),
  kind: assetKindSchema,
  reviewDecision: assetReviewDecisionSchema,
  selectedAt: z.string().datetime(),
  asset: assetDtoSchema,
});

export const selectShotAssetSchema = z.object({
  assetId: z.string().uuid(),
  kind: assetKindSchema,
  expectedStateVersion: z.number().int().nonnegative().optional(),
});

export const shotAttemptDtoSchema = z.object({
  id: z.string().uuid(),
  filmId: z.string().uuid(),
  storyRevisionId: z.string().uuid().nullable(),
  shotRevisionId: z.string().uuid().nullable(),
  kind: z.enum(['IMAGE', 'VIDEO', 'TTS', 'ASSEMBLY']),
  state: z.enum(['QUEUED', 'RUNNING', 'SUCCEEDED', 'FAILED', 'CANCELED']),
  executionMode: z.enum(['LIVE', 'REPLAY']),
  provider: z.string().optional(),
  assetId: z.string().uuid().nullable().optional(),
  latestReviewDecision: assetReviewDecisionSchema.nullable().optional(),
  isSelected: z.boolean().optional(),
  createdAt: z.string().datetime(),
});

export type AssetDto = z.infer<typeof assetDtoSchema>;
export type ReviewAsset = z.infer<typeof reviewAssetSchema>;
export type ShotAssetSelectionDto = z.infer<typeof shotAssetSelectionDtoSchema>;
export type SelectShotAsset = z.infer<typeof selectShotAssetSchema>;
export type ShotAttemptDto = z.infer<typeof shotAttemptDtoSchema>;
