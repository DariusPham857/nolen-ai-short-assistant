import { expect, it } from 'vitest';
import { attemptReceiptSchema, createAttemptSchema, signedMicrosSchema, updateBudgetSchema } from './financial.js';

it('keeps financial money as bounded decimal strings', () => {
  expect(signedMicrosSchema.parse('-9223372036854775808')).toBe('-9223372036854775808');
  expect(signedMicrosSchema.safeParse('9223372036854775808').success).toBe(false);
  expect(updateBudgetSchema.parse({budgetLimitUsdMicros:'9007199254740993',reason:'Approved increase'}).budgetLimitUsdMicros).toBe('9007199254740993');
});

it('rejects untrusted derived attempt fields', () => {
  const input={storyRevisionId:crypto.randomUUID(),shotRevisionId:null,kind:'VIDEO',rateCardSnapshotId:crypto.randomUUID(),pricingUnits:5};
  expect(createAttemptSchema.safeParse({...input,reservationUsdMicros:'1'}).success).toBe(false);
  expect(createAttemptSchema.parse(input).shotRevisionId).toBeNull();
  expect(attemptReceiptSchema.safeParse({attemptId:crypto.randomUUID(),filmId:crypto.randomUUID(),state:'QUEUED',billingStatus:'PENDING',reservationUsdMicros:'1',outboxStatus:'PENDING'}).success).toBe(true);
});
