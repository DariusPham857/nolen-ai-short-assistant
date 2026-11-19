/**
 * Background worker entry point.
 *
 * Uses pg-boss for durable job queue processing.
 * Handles: provider dispatch, media download, render jobs, exports.
 *
 * Worker safety invariants (DEC-P06, PRD §20):
 * - Every job carries an idempotent attemptId
 * - Crash after remote submission → SUBMISSION_UNCERTAIN (never blind resubmit)
 * - Deduplicates by attemptId on at-least-once delivery
 *
 * @see PRD §8 Architecture Baseline, §20 DEC-P06
 */
import "dotenv/config";
import PgBoss from "pg-boss";
import { getEnv } from "../config/env.js";

const env = getEnv();

async function startWorker() {
  console.log("[worker] Initializing pg-boss worker...");
  console.log(`[worker] Execution mode: ${env.EXECUTION_MODE}`);

  const boss = new PgBoss({
    connectionString: env.DATABASE_URL,
    schema: env.PGBOSS_SCHEMA,
  });

  boss.on("error", (error) => {
    console.error("[worker] pg-boss error:", error);
  });

  await boss.start();
  console.log("[worker] pg-boss started successfully.");

  // ── Register job handlers ─────────────────────────────
  // Future handlers (EP-02, EP-04):
  // await boss.work("generation:dispatch", { teamConcurrency: env.WORKER_CONCURRENCY }, handleDispatch);
  // await boss.work("generation:poll", { teamConcurrency: env.WORKER_CONCURRENCY }, handlePoll);
  // await boss.work("media:download", { teamConcurrency: env.WORKER_CONCURRENCY }, handleDownload);
  // await boss.work("render:assemble", { teamConcurrency: 1 }, handleAssemble);

  console.log("[worker] Ready and waiting for jobs.");

  // Graceful shutdown
  const shutdown = async () => {
    console.log("[worker] Shutting down...");
    await boss.stop({ graceful: true, timeout: 30_000 });
    process.exit(0);
  };

  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
}

startWorker().catch((err) => {
  console.error("[worker] Failed to start:", err);
  process.exit(1);
});
