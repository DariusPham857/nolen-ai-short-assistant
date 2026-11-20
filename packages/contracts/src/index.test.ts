import { expect, it } from 'vitest';
import { createFilmSchema, normalizeFilm, usdToMicros, formatMicros, MAX_MICROS } from './index.js';

it('preserves integer money at zero, beyond safe integers and BIGINT max', () => {
  for (const value of ['0', '9007199254740993', MAX_MICROS]) {
    expect(usdToMicros(formatMicros(value))).toBe(value);
  }
  for (const value of ['-1', '1e4', '1,000', '0.0000001', '9223372036854.775808']) {
    expect(() => usdToMicros(value)).toThrow();
  }
});

it('normalizes equivalent content with stable field order, rejects unsafe input', () => {
  const input = { title: ' Test ', brief: ' Brief ', budgetLimitUsdMicros: '0', durationTargetSeconds: 30, aspectRatio: '9:16' };
  expect(normalizeFilm(input)).toEqual(normalizeFilm({ styleNotes: ' ', ...input }));
  for (const invalid of [{ ...input, status: 'APPROVED' }, { ...input, budgetLimitUsdMicros: 1 }, { ...input, budgetLimitUsdMicros: '01' }, { ...input, durationTargetSeconds: 61 }]) {
    expect(createFilmSchema.safeParse(invalid).success).toBe(false);
  }
  for (const value of ['abc','1e3','1.2','-1','']) expect(createFilmSchema.safeParse({...input,budgetLimitUsdMicros:value}).success).toBe(false);
});
