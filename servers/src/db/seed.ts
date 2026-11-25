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
import { seedBaselineRateCards } from "./seed-rate-cards.js";

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

  // Provision illustrative baseline rate card snapshots (PRD v1.0 §1265-1267, DEC-P03)
  await seedBaselineRateCards(pgClient);
  console.log("[seed] Provisioned verified rate cards.");

  console.log("[seed] Seed complete.");
  await pgClient.end();
}

seed().catch((err) => {
  console.error("[seed] Failed:", err);
  process.exit(1);
});
