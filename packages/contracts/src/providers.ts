import { z } from 'zod';
import { attemptKindSchema } from './financial.js';

export const providerKindSchema = z.enum([
  'GEMINI',
  'RUNWAY',
  'FAL_KLING',
  'LOCAL_PAN_ZOOM',
]);

export const executionModeSchema = z.enum([
  'LIVE',
  'REPLAY',
]);

export const provenanceSchema = z.enum([
  'LIVE_PROVIDER',
  'REPLAY_FIXTURE',
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

export const generationRequestSchema = z.object({
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

export const providerStatusUpdateSchema = z.object({
  providerJobId: z.string().min(1).max(500),
  state: dispatchStateSchema,
  provenance: provenanceSchema,
  mediaUrl: z.string().url().optional(),
  errorMessage: z.string().max(2000).optional(),
  rawResponse: z.unknown().optional(),
}).strict();

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
export type GenerationRequest = z.infer<typeof generationRequestSchema>;
export type SubmissionResult = z.infer<typeof submissionResultSchema>;
export type ProviderStatusUpdate = z.infer<typeof providerStatusUpdateSchema>;
export type ReconciliationResult = z.infer<typeof reconciliationResultSchema>;
