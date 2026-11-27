import { estimate, type Rate } from '../financial/domain.js';

export interface CanaryRateSnapshotRow {
  id: string;
  provider: string;
  model: string;
  operation: string;
  rate_type: string;
  unit_price_usd_micros: string | bigint;
  provider_maximum_usd_micros: string | bigint | null;
  effective_at: Date | string;
  expires_at: Date | string;
  source_ref: string;
}

export interface ExplicitCanaryRateInput {
  geminiModel: string;
  geminiUnitMicros: string;
  geminiMaxMicros?: string | null;
  runwayModel: string;
  runwayUnitMicros: string;
  runwayMaxMicros?: string | null;
  runwayDurationSec: number;
  maxBudgetMicros: string;
  sourceRef: string;
}

export interface PlannedCanaryRates {
  geminiRateId: string;
  geminiModel: string;
  geminiUnitMicros: string;
  geminiProviderMaxMicros: string | null;
  geminiReservationMicros: string;
  runwayRateId: string;
  runwayModel: string;
  runwayUnitMicros: string;
  runwayProviderMaxMicros: string | null;
  runwayDurationSec: number;
  runwayReservationMicros: string;
  totalReservationMicros: string;
  maxBudgetMicros: string;
  sourceRef: string;
  createSnapshots: boolean;
}

export function assertPositiveMicros(raw: string | undefined, label: string): string {
  if (!raw || !/^[1-9]\d*$/.test(raw)) {
    throw new Error(`${label} must be a positive integer USD micros string (received: ${raw ?? 'undefined'})`);
  }
  return raw;
}

export function assertOptionalPositiveMicros(raw: string | undefined | null, label: string): string | null {
  if (raw === undefined || raw === null || raw.trim() === '') {
    return null;
  }
  return assertPositiveMicros(raw.trim(), label);
}

export function assertRunwayDuration(raw: string | number): 5 | 10 {
  const duration = typeof raw === 'number' ? raw : Number(raw);
  if (duration !== 5 && duration !== 10) {
    throw new Error(`runway-duration must be 5 or 10 for gen4_turbo (received: ${String(raw)})`);
  }
  return duration;
}

function assertRateType(rateType: string, rateId: string): 'FIXED_PER_REQUEST' | 'PER_SECOND' {
  if (rateType !== 'FIXED_PER_REQUEST' && rateType !== 'PER_SECOND') {
    throw new Error(`Unsupported rate_type "${rateType}" on rate card ${rateId}`);
  }
  return rateType;
}

function toRate(row: CanaryRateSnapshotRow): Rate {
  return {
    id: row.id,
    rateType: assertRateType(row.rate_type, row.id),
    unitPriceUsdMicros: BigInt(row.unit_price_usd_micros),
    providerMaximumUsdMicros:
      row.provider_maximum_usd_micros === null ? null : BigInt(row.provider_maximum_usd_micros),
    effectiveAt: row.effective_at instanceof Date ? row.effective_at : new Date(row.effective_at),
    expiresAt: row.expires_at instanceof Date ? row.expires_at : new Date(row.expires_at),
  };
}

function assertWithinCanaryBudget(
  geminiReservation: bigint,
  runwayReservation: bigint,
  maxBudgetMicros: string,
): string {
  const total = geminiReservation + runwayReservation;
  const maxBudget = BigInt(assertPositiveMicros(maxBudgetMicros, 'max-budget-micros'));
  if (total > maxBudget) {
    throw new Error(
      `Total canary reservation (${total.toString()} = Gemini ${geminiReservation.toString()} + Runway ${runwayReservation.toString()}) exceeds max-budget-micros (${maxBudget.toString()})`,
    );
  }
  return total.toString();
}

/**
 * Compute exact admission-equivalent canary reservations using financial `estimate()`
 * for pre-existing LIVE_VERIFIED rate_card_snapshots rows.
 */
export function planCanaryFromRateRows(params: {
  geminiRow: CanaryRateSnapshotRow | undefined;
  runwayRow: CanaryRateSnapshotRow | undefined;
  geminiRateId: string;
  runwayRateId: string;
  runwayDurationSec: number;
  maxBudgetMicros: string;
  now?: Date;
}): PlannedCanaryRates {
  const { geminiRow, runwayRow, geminiRateId, runwayRateId, now = new Date() } = params;
  const runwayDurationSec = assertRunwayDuration(params.runwayDurationSec);
  const maxBudgetMicros = assertPositiveMicros(params.maxBudgetMicros, 'max-budget-micros');

  if (!geminiRow || !geminiRow.source_ref.startsWith('LIVE_VERIFIED')) {
    throw new Error(`Gemini rate card ${geminiRateId} missing or not LIVE_VERIFIED`);
  }
  if (geminiRow.provider !== 'GEMINI' || geminiRow.operation !== 'IMAGE') {
    throw new Error(
      `Gemini rate card ${geminiRateId} has unexpected provider/operation (${geminiRow.provider}/${geminiRow.operation})`,
    );
  }

  if (!runwayRow || !runwayRow.source_ref.startsWith('LIVE_VERIFIED')) {
    throw new Error(`Runway rate card ${runwayRateId} missing or not LIVE_VERIFIED`);
  }
  if (runwayRow.provider !== 'RUNWAY' || runwayRow.operation !== 'VIDEO') {
    throw new Error(
      `Runway rate card ${runwayRateId} has unexpected provider/operation (${runwayRow.provider}/${runwayRow.operation})`,
    );
  }

  const geminiRate = toRate(geminiRow);
  const runwayRate = toRate(runwayRow);

  const geminiEst = estimate(geminiRate, 1, now);
  const runwayEst = estimate(runwayRate, runwayDurationSec, now);
  const totalReservationMicros = assertWithinCanaryBudget(
    geminiEst.reservationUsdMicros,
    runwayEst.reservationUsdMicros,
    maxBudgetMicros,
  );

  return {
    geminiRateId: geminiRow.id,
    geminiModel: geminiRow.model,
    geminiUnitMicros: geminiRate.unitPriceUsdMicros.toString(),
    geminiProviderMaxMicros:
      geminiRate.providerMaximumUsdMicros === null ? null : geminiRate.providerMaximumUsdMicros.toString(),
    geminiReservationMicros: geminiEst.reservationUsdMicros.toString(),
    runwayRateId: runwayRow.id,
    runwayModel: runwayRow.model,
    runwayUnitMicros: runwayRate.unitPriceUsdMicros.toString(),
    runwayProviderMaxMicros:
      runwayRate.providerMaximumUsdMicros === null ? null : runwayRate.providerMaximumUsdMicros.toString(),
    runwayDurationSec,
    runwayReservationMicros: runwayEst.reservationUsdMicros.toString(),
    totalReservationMicros,
    maxBudgetMicros,
    sourceRef: `${geminiRow.source_ref} | ${runwayRow.source_ref}`,
    createSnapshots: false,
  };
}

/**
 * Compute exact admission-equivalent canary reservations using financial `estimate()`
 * for operator-supplied CLI/env rate inputs.
 */
export function planCanaryFromExplicitRates(
  input: ExplicitCanaryRateInput & {
    geminiRateId: string;
    runwayRateId: string;
    now?: Date;
  },
): PlannedCanaryRates {
  const now = input.now ?? new Date();
  const maxBudgetMicros = assertPositiveMicros(input.maxBudgetMicros, 'max-budget-micros');
  const runwayDurationSec = assertRunwayDuration(input.runwayDurationSec);
  const geminiModel = input.geminiModel.trim();
  if (!geminiModel) {
    throw new Error(
      'Missing --gemini-model / CANARY_GEMINI_MODEL (verify active model via GET /v1beta/models before running canary, e.g. gemini-3.1-flash-image-preview)',
    );
  }
  const runwayModel = input.runwayModel.trim();
  if (!runwayModel) {
    throw new Error('Missing --runway-model / CANARY_RUNWAY_MODEL');
  }
  const geminiUnitMicros = assertPositiveMicros(
    input.geminiUnitMicros,
    'gemini-rate-micros / CANARY_GEMINI_RESERVATION_MICROS',
  );
  const geminiProviderMaxMicros = assertOptionalPositiveMicros(
    input.geminiMaxMicros,
    'gemini-max-micros / CANARY_GEMINI_MAX_MICROS',
  );
  const runwayUnitMicros = assertPositiveMicros(
    input.runwayUnitMicros,
    'runway-rate-micros / CANARY_RUNWAY_RATE_MICROS',
  );
  const runwayProviderMaxMicros = assertOptionalPositiveMicros(
    input.runwayMaxMicros,
    'runway-max-micros / CANARY_RUNWAY_MAX_MICROS',
  );
  const sourceRef = input.sourceRef.trim();
  if (!sourceRef.startsWith('LIVE_VERIFIED ') || sourceRef.length <= 'LIVE_VERIFIED '.length + 4) {
    throw new Error(
      'Missing --rate-source-ref / CANARY_RATE_EVIDENCE_REF starting with "LIVE_VERIFIED <evidence details>"',
    );
  }

  const effectiveAt = new Date('2026-01-01T00:00:00Z');
  const expiresAt = new Date('2030-01-01T00:00:00Z');

  const geminiEst = estimate(
    {
      id: input.geminiRateId,
      rateType: 'FIXED_PER_REQUEST',
      unitPriceUsdMicros: BigInt(geminiUnitMicros),
      providerMaximumUsdMicros: geminiProviderMaxMicros === null ? null : BigInt(geminiProviderMaxMicros),
      effectiveAt,
      expiresAt,
    },
    1,
    now,
  );

  const runwayEst = estimate(
    {
      id: input.runwayRateId,
      rateType: 'PER_SECOND',
      unitPriceUsdMicros: BigInt(runwayUnitMicros),
      providerMaximumUsdMicros: runwayProviderMaxMicros === null ? null : BigInt(runwayProviderMaxMicros),
      effectiveAt,
      expiresAt,
    },
    runwayDurationSec,
    now,
  );

  const totalReservationMicros = assertWithinCanaryBudget(
    geminiEst.reservationUsdMicros,
    runwayEst.reservationUsdMicros,
    maxBudgetMicros,
  );

  return {
    geminiRateId: input.geminiRateId,
    geminiModel,
    geminiUnitMicros,
    geminiProviderMaxMicros,
    geminiReservationMicros: geminiEst.reservationUsdMicros.toString(),
    runwayRateId: input.runwayRateId,
    runwayModel,
    runwayUnitMicros,
    runwayProviderMaxMicros,
    runwayDurationSec,
    runwayReservationMicros: runwayEst.reservationUsdMicros.toString(),
    totalReservationMicros,
    maxBudgetMicros,
    sourceRef,
    createSnapshots: true,
  };
}
