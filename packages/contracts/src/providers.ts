import { z } from 'zod';
import { attemptKindSchema, executionModeSchema, fixturePackVersionSchema, fixtureIdSchema } from './financial.js';
import { cameraAngleSchema } from './story.js';

export { executionModeSchema, fixturePackVersionSchema, fixtureIdSchema };

export const providerKindSchema = z.enum([
  'GEMINI',
  'RUNWAY',
  'FAL_KLING',
  'LOCAL_PAN_ZOOM',
]);

export const provenanceSchema = z.enum([
  'LIVE_PROVIDER',
  'REPLAY_FIXTURE',
  'LOCAL_PIPELINE',
]);

export const dispatchStateSchema = z.enum([
  'PENDING',
  'CLAIMED',
  'SUBMITTING',
  'SUBMITTED',
  'SUBMISSION_UNCERTAIN',
  'RUNNING',
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'EXHAUSTED',
]);

export const assetLocatorSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('REPLAY_FIXTURE'),
    packVersion: fixturePackVersionSchema,
    fixtureId: fixtureIdSchema,
  }),
  z.object({
    kind: z.literal('REMOTE_URL'),
    url: z.string().url(),
  }),
  z.object({
    kind: z.literal('LOCAL_STORAGE'),
    category: z.enum(['keyframes', 'videos']),
    filename: z.string().min(1).max(255).refine(
      v => !v.includes('..') && !v.includes('/') && !v.includes('\\'),
      { message: 'filename must be a basename without path separators' },
    ),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
]);

export const localVideoMetadataSchema = z.object({
  provenance: z.literal('LOCAL_PIPELINE'),
  executionMode: z.literal('LIVE'),
  provider: z.literal('LOCAL_PAN_ZOOM'),
  cameraMovement: z.string().min(1).max(2000),
  durationSeconds: z.number().int().min(1).max(60),
  startFrameAssetId: z.string().uuid(),
  startFrameSha256: z.string().regex(/^[a-f0-9]{64}$/),
  startFrameProvenance: z.enum(['LIVE_PROVIDER', 'REPLAY_FIXTURE']),
}).strict();

/** Legacy v1 GenerationRequest retained for historical outbox compatibility and TTS/ASSEMBLY. */
export const generationRequestV1Schema = z.object({
  attemptId: z.string().uuid(),
  filmId: z.string().uuid(),
  shotRevisionId: z.string().uuid().nullable().optional(),
  kind: attemptKindSchema,
  provider: providerKindSchema,
  executionMode: executionModeSchema.default('REPLAY'),
  prompt: z.string().trim().min(1).max(5000),
  aspectRatio: z.enum(['9:16', '16:9']).default('9:16'),
  seed: z.number().int().optional(),
  keyframeAssetId: z.string().uuid().optional(),
  keyframeUrl: z.string().url().optional(),
  durationSeconds: z.number().int().min(1).max(60).optional(),
  fixturePackVersion: fixturePackVersionSchema.optional(),
  fixtureId: fixtureIdSchema.optional(),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict();

export const inputAssetSourceSchema = z.enum(['REFERENCE_UPLOAD', 'GENERATED_ASSET']);
export const inputAssetRoleSchema = z.enum([
  'START_FRAME',
  'CHARACTER_REFERENCE',
  'WARDROBE_REFERENCE',
  'PROP_REFERENCE',
  'LOCATION_REFERENCE',
  'STYLE_REFERENCE',
]);

export const inputAssetSchema = z.object({
  source: inputAssetSourceSchema,
  role: inputAssetRoleSchema,
  assetId: z.string().uuid(),
  sha256Hash: z.string().regex(/^[a-f0-9]{64}$/),
  mimeType: z.string().min(1).max(64),
}).strict();

export const structuredIntentSchema = z.object({
  shotType: z.enum(['CHARACTER', 'ACTION', 'DIALOGUE', 'ESTABLISHING', 'BROLL', 'INSERT', 'PRODUCT', 'OTHER']),
  authoredPrompt: z.string().min(1).max(2000),
  camera: z.object({
    angle: z.union([cameraAngleSchema, z.literal('UNSPECIFIED')]),
    framing: z.string().min(1).max(2000),
    movement: z.string().min(1).max(2000),
  }).strict(),
  location: z.object({ id: z.string(), name: z.string(), description: z.string() }).strict(),
  styleRef: z.object({ id: z.string(), name: z.string(), description: z.string() }).strict(),
  subjects: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() }).strict()),
  wardrobes: z.array(z.object({ id: z.string(), name: z.string(), description: z.string() }).strict()),
  props: z.array(z.object({ id: z.string(), name: z.string(), description: z.string(), hero: z.boolean() }).strict()),
  continuity: z.object({
    startLighting: z.string(),
    endLighting: z.string(),
    startCharacters: z.array(z.object({ characterId: z.string(), wardrobeId: z.string(), pose: z.string(), heldPropIds: z.array(z.string()) }).strict()),
    endCharacters: z.array(z.object({ characterId: z.string(), wardrobeId: z.string(), pose: z.string(), heldPropIds: z.array(z.string()) }).strict()),
  }).strict(),
  intendedTransitions: z.array(z.object({ field: z.string(), reason: z.string() }).strict()),
}).strict();

const generationTemplateV2Base = z.object({
  filmId: z.string().uuid(),
  storyRevisionId: z.string().uuid(),
  shotRevisionId: z.string().uuid(),
  kind: z.enum(['IMAGE', 'VIDEO']),
  provider: providerKindSchema,
  modelId: z.string().trim().min(1).max(200),
  rateCardSnapshotId: z.string().uuid(),
  executionMode: executionModeSchema,
  prompt: z.string().trim().min(1).max(5000),
  negativePrompt: z.string().max(1000),
  promptCompilerVersion: z.literal('generation-intent-1'),
  shotDependencyHash: z.string().min(1).max(128),
  camera: z.object({
    angle: z.union([cameraAngleSchema, z.literal('UNSPECIFIED')]),
    framing: z.string().min(1).max(2000),
    movement: z.string().min(1).max(2000),
  }).strict(),
  aspectRatio: z.literal('9:16'),
  durationSeconds: z.number().int().min(1).max(60).optional(),
  inputAssets: z.array(inputAssetSchema).max(64),
  structuredIntent: structuredIntentSchema,
  fixturePackVersion: fixturePackVersionSchema.optional(),
  fixtureId: fixtureIdSchema.optional(),
}).strict();

function validateV2Invariants(
  data: z.infer<typeof generationTemplateV2Base>,
  ctx: z.RefinementCtx,
): void {
  if (data.kind === 'IMAGE') {
    if (data.durationSeconds !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['durationSeconds'], message: 'IMAGE requests must not specify durationSeconds' });
    }
    if (data.prompt.length > 5000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prompt'], message: 'IMAGE prompt exceeds 5000 characters' });
    }
  } else if (data.kind === 'VIDEO') {
    if (data.durationSeconds === undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['durationSeconds'], message: 'VIDEO requests require durationSeconds' });
    }
    if (data.prompt.length > 1000) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['prompt'], message: 'VIDEO prompt exceeds 1000 characters' });
    }
  }
  if (data.executionMode === 'REPLAY') {
    if (!data.fixturePackVersion || !data.fixtureId) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fixtureId'], message: 'REPLAY requests require fixturePackVersion and fixtureId' });
    }
  } else if (data.executionMode === 'LIVE') {
    if (data.fixturePackVersion !== undefined || data.fixtureId !== undefined) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fixtureId'], message: 'LIVE requests strictly forbid fixture identity' });
    }
  }
}

export const generationRequestTemplateV2Schema = generationTemplateV2Base.superRefine(validateV2Invariants);

export const generationRequestV2Schema = generationTemplateV2Base.extend({
  schemaVersion: z.literal('2'),
  attemptId: z.string().uuid(),
  requestFingerprint: z.string().regex(/^[a-f0-9]{64}$/).optional(),
}).strict().superRefine(validateV2Invariants);

export const generationRequestSchema = z.union([generationRequestV2Schema, generationRequestV1Schema]);

export const generationPreviewRequestSchema = z.object({
  storyRevisionId: z.string().uuid(),
  shotRevisionId: z.string().uuid(),
  kind: z.enum(['IMAGE', 'VIDEO']),
  rateCardSnapshotId: z.string().uuid(),
  pricingUnits: z.number().int().min(1).max(86400),
  executionMode: executionModeSchema.optional().default('REPLAY'),
  fixturePackVersion: fixturePackVersionSchema.optional(),
  fixtureId: fixtureIdSchema.optional(),
}).strict().superRefine((data, ctx) => {
  if (data.executionMode === 'LIVE' && (data.fixtureId !== undefined || data.fixturePackVersion !== undefined)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['fixtureId'], message: 'LIVE mode strictly forbids fixture identity' });
  }
});

export const generationPreviewResponseSchema = z.object({
  previewHash: z.string().regex(/^[a-f0-9]{64}$/),
  compilerVersion: z.literal('generation-intent-1'),
  template: generationRequestTemplateV2Schema,
  generatedAt: z.string().datetime(),
}).strict();

export const submissionResultSchema = z.object({
  attemptId: z.string().uuid(),
  providerJobId: z.string().min(1).max(500),
  state: dispatchStateSchema,
  executionMode: executionModeSchema,
  provenance: provenanceSchema,
  submittedAt: z.string().datetime(),
  estimatedCompletionSeconds: z.number().int().nonnegative().optional(),
}).strict();

export const billingEvidenceSchema = z.discriminatedUnion('status', [
  z.object({
    status: z.literal('CONFIRMED_CHARGED'),
    realizedChargeUsdMicros: z.string().regex(/^\d+$/),
    evidenceRef: z.string().min(1).max(500),
  }).strict(),
  z.object({
    status: z.literal('CONFIRMED_UNCHARGED'),
    evidenceRef: z.string().min(1).max(500),
  }).strict(),
  z.object({
    status: z.literal('PENDING'),
    evidenceRef: z.string().max(500).optional(),
  }).strict(),
]);

export const pollContinuationPayloadSchema = z.object({
  kind: z.literal('POLL_CONTINUATION'),
  attemptId: z.string().uuid(),
  providerJobId: z.string().min(1).max(500),
  turnNumber: z.number().int().min(2),
}).strict();

export const falQueueSubmitResponseSchema = z.object({
  request_id: z.string().min(1),
  status_url: z.string().url(),
  response_url: z.string().url(),
});

export const falQueueStatusResponseSchema = z.object({
  status: z.enum(['IN_QUEUE', 'IN_PROGRESS', 'COMPLETED', 'FAILED']),
});

export const falQueueResultResponseSchema = z.object({
  video: z.object({
    url: z.string().url(),
    content_type: z.string().optional(),
    file_size: z.number().int().nonnegative().optional(),
  }),
});

export const providerStatusUpdateSchema = z.object({
  providerJobId: z.string().min(1).max(500),
  state: dispatchStateSchema,
  provenance: provenanceSchema,
  mediaUrl: z.string().url().optional(),
  errorMessage: z.string().max(2000).optional(),
  rawResponse: z.unknown().optional(),
  locator: assetLocatorSchema.optional(),
  billingEvidence: billingEvidenceSchema.optional(),
}).strict().superRefine((data, ctx) => {
  if (data.provenance === 'REPLAY_FIXTURE') {
    if (data.mediaUrl !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REPLAY_FIXTURE must not have mediaUrl (remote URL forbidden in REPLAY mode)',
        path: ['mediaUrl'],
      });
    }
    if (!data.locator || data.locator.kind !== 'REPLAY_FIXTURE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'REPLAY_FIXTURE provenance requires a valid REPLAY_FIXTURE locator',
        path: ['locator'],
      });
    }
  } else if (data.provenance === 'LIVE_PROVIDER') {
    if (data.locator && data.locator.kind !== 'REMOTE_URL' && data.locator.kind !== 'LOCAL_STORAGE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LIVE_PROVIDER provenance requires REMOTE_URL or LOCAL_STORAGE locator',
        path: ['locator'],
      });
    }
  } else if (data.provenance === 'LOCAL_PIPELINE') {
    if (data.mediaUrl !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LOCAL_PIPELINE must not have mediaUrl (remote URL forbidden)',
        path: ['mediaUrl'],
      });
    }
    if (data.locator && data.locator.kind !== 'LOCAL_STORAGE') {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LOCAL_PIPELINE provenance requires LOCAL_STORAGE locator',
        path: ['locator'],
      });
    }
  }
});

export const reconciliationResultSchema = z.object({
  attemptId: z.string().uuid(),
  providerJobId: z.string().max(500).nullable(),
  outcome: z.enum([
    'CONFIRMED_RUNNING',
    'CONFIRMED_SUCCEEDED',
    'CONFIRMED_FAILED_NO_CHARGE',
    'CONFIRMED_FAILED_CHARGED',
    'UNRESOLVED_MANUAL_REVIEW',
  ]),
  evidence: z.string().trim().min(1).max(2000),
}).strict();

export type ProviderKind = z.infer<typeof providerKindSchema>;
export type ExecutionMode = z.infer<typeof executionModeSchema>;
export type Provenance = z.infer<typeof provenanceSchema>;
export type DispatchState = z.infer<typeof dispatchStateSchema>;
export type InputAssetSource = z.infer<typeof inputAssetSourceSchema>;
export type InputAssetRole = z.infer<typeof inputAssetRoleSchema>;
export type InputAsset = z.infer<typeof inputAssetSchema>;
export type GenerationRequestTemplateV2 = z.infer<typeof generationRequestTemplateV2Schema>;
export type GenerationRequestV1 = z.infer<typeof generationRequestV1Schema>;
export type GenerationRequestV2 = z.infer<typeof generationRequestV2Schema>;
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type GenerationPreviewRequest = z.infer<typeof generationPreviewRequestSchema>;
export type GenerationPreviewResponse = z.infer<typeof generationPreviewResponseSchema>;
export type SubmissionResult = z.infer<typeof submissionResultSchema>;
export type ProviderStatusUpdate = z.infer<typeof providerStatusUpdateSchema>;
export type ReconciliationResult = z.infer<typeof reconciliationResultSchema>;
export type AssetLocator = z.infer<typeof assetLocatorSchema>;
export type LocalVideoMetadata = z.infer<typeof localVideoMetadataSchema>;
export type BillingEvidence = z.infer<typeof billingEvidenceSchema>;
export type PollContinuationPayload = z.infer<typeof pollContinuationPayloadSchema>;
export type FalQueueSubmitResponse = z.infer<typeof falQueueSubmitResponseSchema>;
export type FalQueueStatusResponse = z.infer<typeof falQueueStatusResponseSchema>;
export type FalQueueResultResponse = z.infer<typeof falQueueResultResponseSchema>;
