import { z } from 'zod';

const maxMicros = 9223372036854775807n;
const microsSchema = z.string().regex(/^(0|[1-9]\d*)$/).refine(value => BigInt(value) <= maxMicros, 'Money exceeds BIGINT range');
const versionSchema = z.number().int().nonnegative();

export const signedMicrosSchema = z.string().regex(/^-?(0|[1-9]\d*)$/).refine(value => {
  const amount = BigInt(value);
  return amount >= -9223372036854775808n && amount <= 9223372036854775807n;
}, 'Money exceeds BIGINT range');

export const attemptKindSchema = z.enum(['IMAGE', 'VIDEO', 'TTS', 'ASSEMBLY']);
export const executionModeSchema = z.enum(['LIVE', 'REPLAY']);
export const billingStatusSchema = z.enum(['PENDING', 'PARTIAL', 'FINAL', 'DISPUTED']);

export const fixturePackVersionSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9._-]{0,63}$/, {
    message: 'fixturePackVersion must start with alphanumeric and contain only lowercase letters, digits, dots, underscores, or hyphens (max 64 chars)',
  })
  .refine(v => !v.includes('..') && !v.includes('/') && !v.includes('\\'), {
    message: 'fixturePackVersion cannot contain path traversal or slashes',
  });

export const fixtureIdSchema = z
  .string()
  .regex(/^[a-z0-9_-]+$/, {
    message: 'fixtureId must contain only lowercase letters, digits, underscores, or hyphens',
  })
  .min(1)
  .max(128);

export const estimateAttemptSchema = z.object({
  rateCardSnapshotId: z.string().uuid(),
  pricingUnits: z.number().int().min(1).max(86400),
}).strict();

export const createAttemptSchema = estimateAttemptSchema.extend({
  storyRevisionId: z.string().uuid(),
  shotRevisionId: z.string().uuid().nullable().optional().default(null),
  kind: attemptKindSchema,
  executionMode: executionModeSchema.optional().default('REPLAY'),
  fixtureId: fixtureIdSchema.optional(),
  fixturePackVersion: fixturePackVersionSchema.optional(),
}).strict().superRefine((data, ctx) => {
  if (data.executionMode === 'LIVE') {
    if (data.fixtureId !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LIVE mode strictly forbids fixtureId',
        path: ['fixtureId'],
      });
    }
    if (data.fixturePackVersion !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: 'LIVE mode strictly forbids fixturePackVersion',
        path: ['fixturePackVersion'],
      });
    }
  }
});

export const updateBudgetSchema = z.object({
  budgetLimitUsdMicros: microsSchema,
  reason: z.string().trim().min(1).max(1000),
  expectedVersion: versionSchema,
}).strict();

export const reconcileAttemptSchema = z.object({
  billingStatus: billingStatusSchema,
  realizedChargeUsdMicros: microsSchema,
  pendingLiabilityUsdMicros: microsSchema,
  evidenceRef: z.string().trim().min(1).max(2000),
  expectedVersion: versionSchema,
}).strict();

export const moneyProjectionSchema = z.object({
  budgetLimitUsdMicros: microsSchema,
  actualSpentUsdMicros: microsSchema,
  reservedOpenUsdMicros: microsSchema,
  pendingLiabilityUsdMicros: microsSchema,
  availableUsdMicros: microsSchema,
  headroomUsdMicros: signedMicrosSchema,
  version: versionSchema,
  warningThresholdBps: z.literal(8000),
  warning: z.boolean(),
});

export const estimateDtoSchema = z.object({
  rateCardSnapshotId: z.string().uuid(),
  baseEstimateUsdMicros: microsSchema,
  reservationUsdMicros: microsSchema,
  rateType: z.enum(['FIXED_PER_REQUEST', 'PER_SECOND']),
  expiresAt: z.string().datetime(),
});

export const attemptReceiptSchema = z.object({
  attemptId: z.string().uuid(),
  filmId: z.string().uuid(),
  state: z.literal('QUEUED'),
  billingStatus: z.enum(['PENDING', 'FINAL']),
  reservationUsdMicros: microsSchema,
  outboxStatus: z.literal('PENDING'),
});
export type AttemptReceipt = z.infer<typeof attemptReceiptSchema>;

export const attemptFinancialDtoSchema = z.object({
  attemptId: z.string().uuid(),
  filmId: z.string().uuid(),
  state: z.string(),
  billingStatus: billingStatusSchema,
  reservationOpenUsdMicros: microsSchema,
  realizedUsdMicros: microsSchema,
  pendingLiabilityUsdMicros: microsSchema,
  rateCardSnapshotId: z.string().uuid(),
  outboxStatus: z.enum(['PENDING', 'DELIVERING', 'DELIVERED']),
  enqueueOutcome: z.enum(['NOT_ATTEMPTED', 'JOB_ID', 'NULL_UNVERIFIED', 'UNKNOWN_ENQUEUE_OUTCOME', 'WORKER_CONFIRMED']),
  version: versionSchema,
});

export const ledgerEventDtoSchema = z.object({
  id: z.string().uuid(),
  attemptId: z.string().uuid(),
  eventType: z.enum(['RESERVATION_CREATED', 'CHARGE_POSTED', 'RESERVATION_RELEASED', 'CHARGE_CORRECTED', 'RESERVATION_ADJUSTED']),
  amountUsdMicros: signedMicrosSchema,
  billingStatus: billingStatusSchema,
  evidence: z.unknown(),
  createdAt: z.string().datetime(),
});

export type EstimateAttempt = z.infer<typeof estimateAttemptSchema>;
export type CreateAttempt = z.infer<typeof createAttemptSchema>;
export type UpdateBudget = z.infer<typeof updateBudgetSchema>;
export type ReconcileAttempt = z.infer<typeof reconcileAttemptSchema>;
export type MoneyProjection = z.infer<typeof moneyProjectionSchema>;

