import { expect, it } from 'vitest';
import { attemptFinancialDtoSchema, attemptReceiptSchema, createAttemptSchema, moneyProjectionSchema, reconcileAttemptSchema, signedMicrosSchema, updateBudgetSchema } from './financial.js';

it('keeps financial money as bounded decimal strings', () => {
  expect(signedMicrosSchema.parse('-9223372036854775808')).toBe('-9223372036854775808');
  expect(signedMicrosSchema.safeParse('9223372036854775808').success).toBe(false);
  expect(updateBudgetSchema.parse({budgetLimitUsdMicros:'9007199254740993',reason:'Approved increase',expectedVersion:0}).budgetLimitUsdMicros).toBe('9007199254740993');
  expect(updateBudgetSchema.safeParse({budgetLimitUsdMicros:'1',reason:'Missing version'}).success).toBe(false);
  expect(reconcileAttemptSchema.safeParse({billingStatus:'FINAL',realizedChargeUsdMicros:'1',pendingLiabilityUsdMicros:'0',evidenceRef:'invoice',expectedVersion:0}).success).toBe(true);
  expect(moneyProjectionSchema.safeParse({budgetLimitUsdMicros:'1',actualSpentUsdMicros:'2',reservedOpenUsdMicros:'0',pendingLiabilityUsdMicros:'0',availableUsdMicros:'-1',headroomUsdMicros:'-1',version:0,warningThresholdBps:8000,warning:true}).success).toBe(false);
});

it('rejects untrusted derived attempt fields', () => {
  const input={storyRevisionId:crypto.randomUUID(),shotRevisionId:null,kind:'VIDEO',rateCardSnapshotId:crypto.randomUUID(),pricingUnits:5};
  expect(createAttemptSchema.safeParse({...input,reservationUsdMicros:'1'}).success).toBe(false);
  expect(createAttemptSchema.parse(input).shotRevisionId).toBeNull();
  expect(attemptReceiptSchema.safeParse({attemptId:crypto.randomUUID(),filmId:crypto.randomUUID(),state:'QUEUED',billingStatus:'PENDING',reservationUsdMicros:'1',outboxStatus:'PENDING'}).success).toBe(true);
  expect(attemptFinancialDtoSchema.safeParse({attemptId:crypto.randomUUID(),filmId:crypto.randomUUID(),state:'QUEUED',billingStatus:'PENDING',reservationOpenUsdMicros:'1',realizedUsdMicros:'0',pendingLiabilityUsdMicros:'0',rateCardSnapshotId:crypto.randomUUID(),outboxStatus:'PENDING',enqueueOutcome:'NOT_ATTEMPTED',version:0}).success).toBe(true);
});
