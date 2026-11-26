import type postgres from 'postgres';

export const BASELINE_REPLAY_RATE_CARDS = [
  {
    id: '00000000-0000-4000-a000-000000000001',
    provider: 'GEMINI',
    model: 'gemini-3.1-flash-image',
    operation: 'IMAGE',
    rateType: 'FIXED_PER_REQUEST',
    unitPriceUsdMicros: '67000', // $0.067/image (PRD v1.0 §1265)
    sourceRef: 'MODELED_ONLY (PRD v1.0 §1265 listed Gemini 3.1 Flash Image rate for REPLAY/DEV)',
  },
  {
    id: '00000000-0000-4000-a000-000000000002',
    provider: 'RUNWAY',
    model: 'gen4_turbo',
    operation: 'VIDEO',
    rateType: 'PER_SECOND',
    unitPriceUsdMicros: '50000', // $0.05/output second (PRD v1.0 §1266)
    sourceRef: 'MODELED_ONLY (PRD v1.0 §1266 Runway Gen-4 Turbo illustrative rate for REPLAY/DEV)',
  },
  {
    id: '00000000-0000-4000-a000-000000000003',
    provider: 'FAL_KLING',
    model: 'fal-ai/kling-video/v3/pro/image-to-video',
    operation: 'VIDEO',
    rateType: 'PER_SECOND',
    unitPriceUsdMicros: '140000', // $0.14/output second (PRD v1.0 §1267)
    sourceRef: 'MODELED_ONLY (PRD v1.0 §1267 fal.ai Kling v3 Pro queue rate for REPLAY/DEV)',
  },
  {
    id: '00000000-0000-4000-a000-000000000004',
    provider: 'LOCAL_PAN_ZOOM',
    model: 'ffmpeg-pan-zoom',
    operation: 'VIDEO',
    rateType: 'FIXED_PER_REQUEST',
    unitPriceUsdMicros: '0', // $0.00 static shot bypass route (DEC-P03)
    sourceRef: 'MODELED_ONLY (DEC-P03 local FFmpeg pan/zoom static shot cost lever for REPLAY/DEV)',
  },
  {
    id: '00000000-0000-4000-a000-000000000005',
    provider: 'LOCAL_PAN_ZOOM',
    model: 'ffmpeg-pan-zoom',
    operation: 'VIDEO',
    rateType: 'FIXED_PER_REQUEST',
    unitPriceUsdMicros: '0', // $0.00 API fee local FFmpeg deterministic pan/zoom (DEC-P03 / LP-001)
    sourceRef: 'LOCAL_VERIFIED (DEC-P03 FFmpeg deterministic pan/zoom, $0.00 API fee)',
  },
] as const;

/**
 * Idempotently provisions baseline rate cards for REPLAY/DEV execution
 * and the verified $0.00 API fee LOCAL_PAN_ZOOM rate card for LIVE local renders.
 */
export async function seedBaselineRateCards(client: postgres.Sql): Promise<void> {
  for (const rc of BASELINE_REPLAY_RATE_CARDS) {
    await client`
      INSERT INTO rate_card_snapshots (
        id, provider, model, operation, rate_type, unit_price_usd_micros,
        effective_at, expires_at, source_ref
      ) VALUES (
        ${rc.id}, ${rc.provider}, ${rc.model}, ${rc.operation}, ${rc.rateType}, ${rc.unitPriceUsdMicros},
        '2026-01-01T00:00:00Z', '2030-01-01T00:00:00Z', ${rc.sourceRef}
      )
      ON CONFLICT (id) DO NOTHING
    `;
  }
}
