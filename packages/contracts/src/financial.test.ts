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

it('rejects untrusted derived attempt fields and enforces preview hash only for media kinds', () => {
  const ttsInput={storyRevisionId:crypto.randomUUID(),shotRevisionId:null,kind:'TTS' as const,rateCardSnapshotId:crypto.randomUUID(),pricingUnits:5};
  expect(createAttemptSchema.safeParse({...ttsInput,reservationUsdMicros:'1'}).success).toBe(false);
  expect(createAttemptSchema.parse(ttsInput).shotRevisionId).toBeNull();
  expect(createAttemptSchema.safeParse({
    storyRevisionId:crypto.randomUUID(),
    shotRevisionId:crypto.randomUUID(),
    kind:'IMAGE',
    rateCardSnapshotId:crypto.randomUUID(),
    pricingUnits:1,
  }).success).toBe(false);
  expect(createAttemptSchema.safeParse({
    storyRevisionId:crypto.randomUUID(),
    shotRevisionId:null,
    kind:'VIDEO',
    rateCardSnapshotId:crypto.randomUUID(),
    pricingUnits:5,
    expectedPreviewHash:'a'.repeat(64),
  }).success).toBe(false);
  expect(attemptReceiptSchema.safeParse({attemptId:crypto.randomUUID(),filmId:crypto.randomUUID(),state:'QUEUED',billingStatus:'PENDING',reservationUsdMicros:'1',outboxStatus:'PENDING'}).success).toBe(true);
  expect(attemptReceiptSchema.safeParse({attemptId:crypto.randomUUID(),filmId:crypto.randomUUID(),state:'QUEUED',billingStatus:'FINAL',reservationUsdMicros:'0',outboxStatus:'PENDING'}).success).toBe(true);
  expect(attemptReceiptSchema.safeParse({attemptId:crypto.randomUUID(),filmId:crypto.randomUUID(),state:'QUEUED',billingStatus:'DISPUTED',reservationUsdMicros:'0',outboxStatus:'PENDING'}).success).toBe(false);
  expect(attemptFinancialDtoSchema.safeParse({attemptId:crypto.randomUUID(),filmId:crypto.randomUUID(),state:'QUEUED',billingStatus:'PENDING',reservationOpenUsdMicros:'1',realizedUsdMicros:'0',pendingLiabilityUsdMicros:'0',rateCardSnapshotId:crypto.randomUUID(),outboxStatus:'PENDING',enqueueOutcome:'NOT_ATTEMPTED',version:0}).success).toBe(true);
});

it('enforces execution mode and conditional fixture fields on createAttemptSchema (PD-05a.1)', () => {
  const base = {
    storyRevisionId: crypto.randomUUID(),
    shotRevisionId: crypto.randomUUID(),
    kind: 'IMAGE' as const,
    rateCardSnapshotId: crypto.randomUUID(),
    pricingUnits: 1,
    expectedPreviewHash: 'b'.repeat(64),
  };

  // Defaults to REPLAY mode
  const defaultParsed = createAttemptSchema.parse(base);
  expect(defaultParsed.executionMode).toBe('REPLAY');

  // REPLAY allows optional fixtureId & fixturePackVersion
  const replayWithFixture = createAttemptSchema.parse({
    ...base,
    executionMode: 'REPLAY',
    fixtureId: 'gemini-kf-01',
    fixturePackVersion: 'v1',
  });
  expect(replayWithFixture.fixtureId).toBe('gemini-kf-01');
  expect(replayWithFixture.fixturePackVersion).toBe('v1');

  // LIVE mode strictly rejects fixtureId or fixturePackVersion
  expect(() => createAttemptSchema.parse({
    ...base,
    executionMode: 'LIVE',
    fixtureId: 'gemini-kf-01',
  })).toThrow(/fixture/i);

  expect(() => createAttemptSchema.parse({
    ...base,
    executionMode: 'LIVE',
    fixturePackVersion: 'v1',
  })).toThrow(/fixture/i);

  // Invalid execution mode fails
  expect(() => createAttemptSchema.parse({
    ...base,
    executionMode: 'INVALID_MODE',
  })).toThrow();

  // BLOCK 2: Strictly rejects directory traversal in fixturePackVersion
  expect(() => createAttemptSchema.parse({
    ...base,
    fixturePackVersion: 'x/../replay-pack-v1',
  })).toThrow(/fixturePackVersion/i);

  expect(() => createAttemptSchema.parse({
    ...base,
    fixturePackVersion: '../v1',
  })).toThrow(/fixturePackVersion/i);

  expect(() => createAttemptSchema.parse({
    ...base,
    fixturePackVersion: '/v1',
  })).toThrow(/fixturePackVersion/i);

  expect(() => createAttemptSchema.parse({
    ...base,
    fixturePackVersion: 'v1/..',
  })).toThrow(/fixturePackVersion/i);

  // Valid versions pass
  expect(createAttemptSchema.parse({ ...base, fixturePackVersion: 'v1' }).fixturePackVersion).toBe('v1');
  expect(createAttemptSchema.parse({ ...base, fixturePackVersion: 'v1.0.0' }).fixturePackVersion).toBe('v1.0.0');
  expect(createAttemptSchema.parse({ ...base, fixturePackVersion: 'pack_2026-v1' }).fixturePackVersion).toBe('pack_2026-v1');
});
