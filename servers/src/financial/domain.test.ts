import { describe, expect, it } from 'vitest';
import { add, assertAdmission, estimate, PG_BIGINT_MAX, projection } from './domain.js';

const active = { id:'rate', rateType:'PER_SECOND' as const, unitPriceUsdMicros:1n,
  providerMaximumUsdMicros:null, effectiveAt:new Date('2026-01-01'), expiresAt:new Date('2027-01-01') };

describe('checked financial arithmetic', () => {
  it('uses integer ceil for variable buffer and provider maximum', () => {
    expect(estimate(active, 3, new Date('2026-06-01'))).toEqual({baseEstimateUsdMicros:3n,reservationUsdMicros:4n});
    expect(estimate({...active,providerMaximumUsdMicros:9n},3,new Date('2026-06-01')).reservationUsdMicros).toBe(9n);
    expect(estimate({...active,rateType:'FIXED_PER_REQUEST',unitPriceUsdMicros:5n},99,new Date('2026-06-01')).reservationUsdMicros).toBe(5n);
  });

  it('blocks stale rates, invalid units and BIGINT overflow', () => {
    expect(() => estimate(active, 1, new Date('2027-01-01'))).toThrow('not currently effective');
    expect(() => estimate(active, 0, new Date('2026-06-01'))).toThrow('positive integer');
    expect(() => add(PG_BIGINT_MAX,1n)).toThrow('BIGINT range');
    expect(() => estimate({...active,unitPriceUsdMicros:PG_BIGINT_MAX},2,new Date('2026-06-01'))).toThrow('BIGINT range');
  });

  it('computes exact signed headroom, 80% warning and admission', () => {
    expect(projection({budgetLimitUsdMicros:100n,actualSpentUsdMicros:60n,reservedOpenUsdMicros:20n,pendingLiabilityUsdMicros:0n})).toMatchObject({availableUsdMicros:20n,headroomUsdMicros:20n,warning:true});
    expect(() => assertAdmission({budgetLimitUsdMicros:100n,actualSpentUsdMicros:60n,reservedOpenUsdMicros:20n,pendingLiabilityUsdMicros:0n},21n)).toThrow('insufficient');
    expect(() => projection({budgetLimitUsdMicros:0n,actualSpentUsdMicros:-1n,reservedOpenUsdMicros:0n,pendingLiabilityUsdMicros:0n})).toThrow('cannot be negative');
  });
});

