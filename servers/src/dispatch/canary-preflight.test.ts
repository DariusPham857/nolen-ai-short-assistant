import { describe, expect, it } from 'vitest';
import { assertAdmission } from '../financial/domain.js';
import {
  planCanaryFromExplicitRates,
  planCanaryFromRateRows,
  type CanaryRateSnapshotRow,
} from './canary-preflight.js';

const NOW = new Date('2026-11-27T12:00:00Z');
const EFFECTIVE_AT = new Date('2026-01-01T00:00:00Z');
const EXPIRES_AT = new Date('2030-01-01T00:00:00Z');

describe('canary-preflight', () => {
  it('blocks Gemini 100k + Runway 50k/s * 5s under 350k budget because admission adds 20% buffer (explicit CLI branch)', () => {
    expect(() =>
      planCanaryFromExplicitRates({
        geminiRateId: 'gem-1',
        runwayRateId: 'rw-1',
        geminiModel: 'gemini-3.1-flash-image-preview',
        geminiUnitMicros: '100000',
        runwayModel: 'gen4_turbo',
        runwayUnitMicros: '50000',
        runwayDurationSec: 5,
        maxBudgetMicros: '350000',
        sourceRef: 'LIVE_VERIFIED operator billing test',
        now: NOW,
      }),
    ).toThrow(/400000.*350000/);
  });

  it('blocks Gemini 100k + Runway 50k/s * 5s under 350k budget in existing rate_card_snapshots branch', () => {
    const geminiRow: CanaryRateSnapshotRow = {
      id: 'gem-db-1',
      provider: 'GEMINI',
      model: 'gemini-3.1-flash-image-preview',
      operation: 'IMAGE',
      rate_type: 'FIXED_PER_REQUEST',
      unit_price_usd_micros: '100000',
      provider_maximum_usd_micros: null,
      effective_at: EFFECTIVE_AT,
      expires_at: EXPIRES_AT,
      source_ref: 'LIVE_VERIFIED google pricing 2026-11',
    };
    const runwayRow: CanaryRateSnapshotRow = {
      id: 'rw-db-1',
      provider: 'RUNWAY',
      model: 'gen4_turbo',
      operation: 'VIDEO',
      rate_type: 'PER_SECOND',
      unit_price_usd_micros: '50000',
      provider_maximum_usd_micros: null,
      effective_at: EFFECTIVE_AT,
      expires_at: EXPIRES_AT,
      source_ref: 'LIVE_VERIFIED runway pricing 2026-11',
    };

    expect(() =>
      planCanaryFromRateRows({
        geminiRow,
        runwayRow,
        geminiRateId: geminiRow.id,
        runwayRateId: runwayRow.id,
        runwayDurationSec: 5,
        maxBudgetMicros: '350000',
        now: NOW,
      }),
    ).toThrow(/400000.*350000/);
  });

  it('accepts exact threshold 400k matching production assertAdmission after Gemini reservation', () => {
    const plan = planCanaryFromExplicitRates({
      geminiRateId: 'gem-1',
      runwayRateId: 'rw-1',
      geminiModel: 'gemini-3.1-flash-image-preview',
      geminiUnitMicros: '100000',
      runwayModel: 'gen4_turbo',
      runwayUnitMicros: '50000',
      runwayDurationSec: 5,
      maxBudgetMicros: '400000',
      sourceRef: 'LIVE_VERIFIED operator billing test',
      now: NOW,
    });

    expect(plan.geminiReservationMicros).toBe('100000');
    expect(plan.runwayReservationMicros).toBe('300000');
    expect(plan.totalReservationMicros).toBe('400000');

    // Matches sequential admitAttempt() budget accounting: Gemini open reservation 100k, then Runway 300k
    expect(() =>
      assertAdmission(
        {
          budgetLimitUsdMicros: 400000n,
          actualSpentUsdMicros: 0n,
          reservedOpenUsdMicros: BigInt(plan.geminiReservationMicros),
          pendingLiabilityUsdMicros: 0n,
        },
        BigInt(plan.runwayReservationMicros),
      ),
    ).not.toThrow();

    expect(() =>
      assertAdmission(
        {
          budgetLimitUsdMicros: 350000n,
          actualSpentUsdMicros: 0n,
          reservedOpenUsdMicros: BigInt(plan.geminiReservationMicros),
          pendingLiabilityUsdMicros: 0n,
        },
        BigInt(plan.runwayReservationMicros),
      ),
    ).toThrow(/Budget headroom is insufficient/);
  });

  it('applies providerMaximumUsdMicros ceiling in both explicit and DB-row branches', () => {
    expect(() =>
      planCanaryFromExplicitRates({
        geminiRateId: 'gem-1',
        runwayRateId: 'rw-1',
        geminiModel: 'gemini-3.1-flash-image-preview',
        geminiUnitMicros: '100000',
        geminiMaxMicros: '150000',
        runwayModel: 'gen4_turbo',
        runwayUnitMicros: '50000',
        runwayMaxMicros: '360000',
        runwayDurationSec: 5,
        maxBudgetMicros: '500000',
        sourceRef: 'LIVE_VERIFIED operator billing test',
        now: NOW,
      }),
    ).toThrow(/510000.*500000/);

    const plan = planCanaryFromRateRows({
      geminiRow: {
        id: 'gem-db-2',
        provider: 'GEMINI',
        model: 'gemini-3.1-flash-image-preview',
        operation: 'IMAGE',
        rate_type: 'FIXED_PER_REQUEST',
        unit_price_usd_micros: '100000',
        provider_maximum_usd_micros: '150000',
        effective_at: EFFECTIVE_AT,
        expires_at: EXPIRES_AT,
        source_ref: 'LIVE_VERIFIED google pricing 2026-11',
      },
      runwayRow: {
        id: 'rw-db-2',
        provider: 'RUNWAY',
        model: 'gen4_turbo',
        operation: 'VIDEO',
        rate_type: 'PER_SECOND',
        unit_price_usd_micros: '50000',
        provider_maximum_usd_micros: '360000',
        effective_at: EFFECTIVE_AT,
        expires_at: EXPIRES_AT,
        source_ref: 'LIVE_VERIFIED runway pricing 2026-11',
      },
      geminiRateId: 'gem-db-2',
      runwayRateId: 'rw-db-2',
      runwayDurationSec: 5,
      maxBudgetMicros: '510000',
      now: NOW,
    });

    expect(plan.geminiUnitMicros).toBe('100000');
    expect(plan.geminiProviderMaxMicros).toBe('150000');
    expect(plan.geminiReservationMicros).toBe('150000');
    expect(plan.runwayReservationMicros).toBe('360000');
    expect(plan.totalReservationMicros).toBe('510000');
  });

  it('rejects expired rate-card snapshots via estimate() in existing DB-row branch', () => {
    expect(() =>
      planCanaryFromRateRows({
        geminiRow: {
          id: 'gem-expired',
          provider: 'GEMINI',
          model: 'gemini-3.1-flash-image-preview',
          operation: 'IMAGE',
          rate_type: 'FIXED_PER_REQUEST',
          unit_price_usd_micros: '100000',
          provider_maximum_usd_micros: null,
          effective_at: EFFECTIVE_AT,
          expires_at: new Date('2026-11-27T11:00:00Z'),
          source_ref: 'LIVE_VERIFIED stale card',
        },
        runwayRow: {
          id: 'rw-ok',
          provider: 'RUNWAY',
          model: 'gen4_turbo',
          operation: 'VIDEO',
          rate_type: 'PER_SECOND',
          unit_price_usd_micros: '50000',
          provider_maximum_usd_micros: null,
          effective_at: EFFECTIVE_AT,
          expires_at: EXPIRES_AT,
          source_ref: 'LIVE_VERIFIED runway pricing',
        },
        geminiRateId: 'gem-expired',
        runwayRateId: 'rw-ok',
        runwayDurationSec: 5,
        maxBudgetMicros: '1000000',
        now: NOW,
      }),
    ).toThrow(/not currently effective/);
  });
});
