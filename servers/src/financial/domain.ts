import { ApiFailure } from '../http/errors.js';

export const PG_BIGINT_MAX = 9223372036854775807n;
export const PG_BIGINT_MIN = -9223372036854775808n;
export const WARNING_BPS = 8000n;
export const VARIABLE_BUFFER_BPS = 12000n;
const BPS = 10000n;

/** Reject values that PostgreSQL BIGINT cannot persist. */
export function checked(value: bigint, label = 'money'): bigint {
  if (value < PG_BIGINT_MIN || value > PG_BIGINT_MAX) {
    throw new ApiFailure(422, 'MONEY_RANGE_EXCEEDED', `${label} exceeds PostgreSQL BIGINT range`);
  }
  return value;
}

export function nonnegative(value: bigint, label = 'money'): bigint {
  checked(value, label);
  if (value < 0n) throw new ApiFailure(422, 'NEGATIVE_MONEY', `${label} cannot be negative`);
  return value;
}

export function add(...values: bigint[]): bigint {
  return checked(values.reduce((sum, value) => sum + value, 0n), 'money sum');
}

export function subtract(left: bigint, right: bigint): bigint {
  return checked(left - right, 'money difference');
}

export function multiply(left: bigint, right: bigint): bigint {
  return nonnegative(left * right, 'money product');
}

export function ceilRatio(value: bigint, numerator: bigint, denominator: bigint): bigint {
  nonnegative(value); nonnegative(numerator);
  if (denominator <= 0n) throw new Error('denominator must be positive');
  return nonnegative((value * numerator + denominator - 1n) / denominator, 'buffered reservation');
}

export type Rate = {
  id: string;
  rateType: 'FIXED_PER_REQUEST' | 'PER_SECOND';
  unitPriceUsdMicros: bigint;
  providerMaximumUsdMicros: bigint | null;
  effectiveAt: Date;
  expiresAt: Date;
};

/** Calculate an auditable estimate without floating point or hidden fallback. */
export function estimate(rate: Rate, pricingUnits: number, now = new Date()) {
  if (!Number.isSafeInteger(pricingUnits) || pricingUnits < 1) {
    throw new ApiFailure(422, 'INVALID_PRICING_UNITS', 'Pricing units must be a positive integer');
  }
  if (now < rate.effectiveAt || now >= rate.expiresAt) {
    throw new ApiFailure(409, 'RATE_CARD_STALE', 'Rate-card snapshot is not currently effective');
  }
  const units = rate.rateType === 'FIXED_PER_REQUEST' ? 1n : BigInt(pricingUnits);
  const baseEstimateUsdMicros = multiply(nonnegative(rate.unitPriceUsdMicros, 'unit price'), units);
  const buffered = rate.rateType === 'FIXED_PER_REQUEST'
    ? baseEstimateUsdMicros
    : ceilRatio(baseEstimateUsdMicros, VARIABLE_BUFFER_BPS, BPS);
  const maximum = rate.providerMaximumUsdMicros === null ? 0n : nonnegative(rate.providerMaximumUsdMicros, 'provider maximum');
  return { baseEstimateUsdMicros, reservationUsdMicros: maximum > buffered ? maximum : buffered };
}

export type Projection = {
  budgetLimitUsdMicros: bigint;
  actualSpentUsdMicros: bigint;
  reservedOpenUsdMicros: bigint;
  pendingLiabilityUsdMicros: bigint;
};

export function projection(value: Projection) {
  const budget = nonnegative(value.budgetLimitUsdMicros, 'budget limit');
  const spent = nonnegative(value.actualSpentUsdMicros, 'actual spend');
  const reserved = nonnegative(value.reservedOpenUsdMicros, 'open reservation');
  const pending = nonnegative(value.pendingLiabilityUsdMicros, 'pending liability');
  const committed = add(spent, reserved);
  const headroom = subtract(budget, committed);
  const available = subtract(headroom, pending);
  const warning = budget > 0n && add(spent, reserved, pending) * BPS >= budget * WARNING_BPS;
  return { budgetLimitUsdMicros: budget, actualSpentUsdMicros: spent, reservedOpenUsdMicros: reserved,
    pendingLiabilityUsdMicros: pending, availableUsdMicros: available, headroomUsdMicros: headroom,
    warningThresholdBps: Number(WARNING_BPS), warning };
}

export function assertAdmission(value: Projection, reservation: bigint): void {
  const requested = nonnegative(reservation, 'reservation');
  const committed = add(value.actualSpentUsdMicros, value.reservedOpenUsdMicros, requested);
  if (committed > value.budgetLimitUsdMicros) {
    throw new ApiFailure(409, 'BUDGET_EXCEEDED', 'Budget headroom is insufficient for this reservation');
  }
}

export function moneyStrings<T extends Record<string, unknown>>(value: T): T {
  return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, typeof item === 'bigint' ? item.toString() : item])) as T;
}

