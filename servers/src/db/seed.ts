/**
 * Database seed script.
 *
 * Seeds the database with minimal fixture data for local development.
 * Idempotent — safe to run multiple times.
 *
 * Usage: pnpm db:seed
 */
import "dotenv/config";
import { db, pgClient } from "./index.js";
import { films } from "./schema/index.js";

async function seed() {
  console.log("[seed] Starting database seed...");

  // Insert a sample film if none exist
  const existing = await db.select().from(films).limit(1);
  if (existing.length === 0) {
    await db.insert(films).values({
      title: "Nolen Demo Film",
      brief:
        "A 30-second product showcase demonstrating AI-assisted film production with consistent character and branding across 3 shots.",
      status: "DRAFT",
      budgetLimitUsdMicros: 5_000_000n, // $5.00
      operatorId: "local-operator",
      idempotencyKey: "a0a5ea00-0000-4000-8000-000000000001",
      requestHash: "seed",
      durationTargetSeconds: 30,
      aspectRatio: "9:16",
      styleNotes: "Modern, clean, minimal motion graphics with product focus.",
    });
    console.log("[seed] Inserted sample film.");
  } else {
    console.log("[seed] Films already exist, skipping.");
  }

  // Provision verified baseline rate card snapshots (PRD v1.0 §1265-1267, DEC-P03)
  const baselineRateCards = [
    {
      id: '00000000-0000-4000-a000-000000000001',
      provider: 'GEMINI',
      model: 'gemini-3.1-flash-image',
      operation: 'IMAGE',
      rateType: 'FIXED_PER_REQUEST',
      unitPriceUsdMicros: '67000', // $0.067/image (PRD v1.0 §1265)
      sourceRef: 'PRD v1.0 §1265 (listed Gemini 3.1 Flash Image standard rate)',
    },
    {
      id: '00000000-0000-4000-a000-000000000002',
      provider: 'RUNWAY',
      model: 'gen4_turbo',
      operation: 'VIDEO',
      rateType: 'PER_SECOND',
      unitPriceUsdMicros: '50000', // $0.05/output second (PRD v1.0 §1266)
      sourceRef: 'PRD v1.0 §1266 (Runway Dev API Gen-4 Turbo credit conversion)',
    },
    {
      id: '00000000-0000-4000-a000-000000000003',
      provider: 'FAL_KLING',
      model: 'fal-ai/kling-video/v3/pro/image-to-video',
      operation: 'VIDEO',
      rateType: 'PER_SECOND',
      unitPriceUsdMicros: '140000', // $0.14/output second (PRD v1.0 §1267)
      sourceRef: 'PRD v1.0 §1267 (fal.ai Kling v3 Pro queue rate card)',
    },
    {
      id: '00000000-0000-4000-a000-000000000004',
      provider: 'LOCAL_PAN_ZOOM',
      model: 'ffmpeg-pan-zoom',
      operation: 'VIDEO',
      rateType: 'FIXED_PER_REQUEST',
      unitPriceUsdMicros: '0', // $0.00 static shot bypass route (DEC-P03)
      sourceRef: 'DEC-P03 (local FFmpeg pan/zoom static shot cost lever)',
    },
  ];

  for (const rc of baselineRateCards) {
    await pgClient`
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
  console.log("[seed] Provisioned verified rate cards.");

  console.log("[seed] Seed complete.");
  await pgClient.end();
}

seed().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
