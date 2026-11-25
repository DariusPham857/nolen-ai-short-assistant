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
import path from "node:path";
import PgBoss from "pg-boss";
import { getEnv } from "../config/env.js";
import { storage } from "../lib/storage.js";
import {
  shutdownHandler,
  WorkerLoopRunner,
  WorkerShutdownCoordinator,
  InFlightTracker,
  type BossStopper,
  type ShutdownResult,
} from "./shutdown.js";
import { relayOne, type BossContract } from "../financial/outbox.js";
import { recoverStaleSubmissions } from "../dispatch/service.js";
import { completeReplayAttempt, handleUnsupportedKindAttempt } from "../dispatch/completion.js";
import { ApiFailure } from "../http/errors.js";

const env = getEnv();

export const REPLAY_QUEUES = [
  'replay:generation:dispatch',
  'replay:tts:dispatch',
  'replay:assembly:dispatch',
] as const;

export const LIVE_QUEUES = [
  'live:generation:dispatch',
  'live:tts:dispatch',
  'live:assembly:dispatch',
] as const;

export const ALL_PRODUCTION_QUEUES = [
  ...REPLAY_QUEUES,
  ...LIVE_QUEUES,
] as const;

export interface BossJob<T = Record<string, unknown>> {
  id: string;
  name?: string;
  data: T;
}

export interface WorkerOptions {
  boss?: BossStopper & Partial<BossContract> & {
    start?: () => Promise<unknown>;
    on?: (event: string, handler: (err: unknown) => void) => void;
    work?: (name: string, handler: (jobs: unknown) => Promise<unknown>) => Promise<unknown>;
    createQueue?: (name: string) => Promise<unknown>;
  };
  tracker?: InFlightTracker;
  relayRunner?: WorkerLoopRunner;
  sweepRunner?: WorkerLoopRunner;
  registerSignals?: boolean;
  exitFn?: (code: number) => void;
}

export interface RunningWorker {
  boss: BossStopper;
  tracker: InFlightTracker;
  coordinator: WorkerShutdownCoordinator;
  relayRunner: WorkerLoopRunner;
  sweepRunner: WorkerLoopRunner;
  shutdown: () => Promise<ShutdownResult>;
  signalHandler: () => void;
}

interface EventEmitterLike {
  on(event: string, handler: (error: unknown) => void): void;
}

function isEventEmitterLike(target: unknown): target is EventEmitterLike {
  return (
    typeof target === "object" &&
    target !== null &&
    "on" in target &&
    typeof (target as { on: unknown }).on === "function"
  );
}

export async function startWorker(options: WorkerOptions = {}): Promise<RunningWorker> {
  console.log("[worker] Initializing pg-boss worker...");
  console.log(`[worker] Execution mode: ${env.EXECUTION_MODE}`);

  await storage.checkWritable();
  console.log(`[worker] Storage verified writable at ${path.resolve(env.STORAGE_BASE_PATH)}`);

  const boss =
    options.boss ??
    new PgBoss({
      connectionString: env.DATABASE_URL,
      schema: env.PGBOSS_SCHEMA,
    });

  if (isEventEmitterLike(boss)) {
    boss.on("error", (error: unknown) => {
      console.error("[worker] pg-boss error:", error);
    });
  }

  if (boss.start) {
    await boss.start();
    console.log("[worker] pg-boss started successfully.");
  }

  const tracker = options.tracker ?? new InFlightTracker();

  // ── Create production queues (both replay:* and live:*) ──
  // Fail closed: pg-boss createQueue is idempotent (ON CONFLICT DO NOTHING); any rejection is a genuine failure.
  if (boss.createQueue) {
    for (const q of ALL_PRODUCTION_QUEUES) {
      await boss.createQueue(q);
    }
  }

  if (boss.work) {
    const normalizeJobs = (jobs: unknown): BossJob[] => {
      const arr = Array.isArray(jobs) ? jobs : [jobs];
      return arr.filter((j): j is BossJob => typeof j === 'object' && j !== null && 'id' in j);
    };

    // Media generations (IMAGE / VIDEO)
    await boss.work('replay:generation:dispatch', async (jobs: unknown) => {
      for (const job of normalizeJobs(jobs)) {
        const payload = job.data as { request?: { attemptId?: string } } | undefined;
        const attemptId = payload?.request?.attemptId ?? job.id;
        if (job.id && job.id !== attemptId) {
          throw new ApiFailure(400, 'JOB_IDENTITY_MISMATCH', `Job ID ${job.id} does not match attemptId ${attemptId}`);
        }
        await tracker.track(completeReplayAttempt(attemptId));
      }
    });

    // Audio TTS (Unsupported in REPLAY -> transitions to FAILED, preserving terminal CAS)
    await boss.work('replay:tts:dispatch', async (jobs: unknown) => {
      for (const job of normalizeJobs(jobs)) {
        const payload = job.data as { request?: { attemptId?: string } } | undefined;
        const attemptId = payload?.request?.attemptId ?? job.id;
        if (job.id && job.id !== attemptId) {
          throw new ApiFailure(400, 'JOB_IDENTITY_MISMATCH', `Job ID ${job.id} does not match attemptId ${attemptId}`);
        }
        await tracker.track(handleUnsupportedKindAttempt(attemptId, 'TTS'));
      }
    });

    // Assembly (Unsupported in REPLAY -> transitions to FAILED, preserving terminal CAS)
    await boss.work('replay:assembly:dispatch', async (jobs: unknown) => {
      for (const job of normalizeJobs(jobs)) {
        const payload = job.data as { request?: { attemptId?: string } } | undefined;
        const attemptId = payload?.request?.attemptId ?? job.id;
        if (job.id && job.id !== attemptId) {
          throw new ApiFailure(400, 'JOB_IDENTITY_MISMATCH', `Job ID ${job.id} does not match attemptId ${attemptId}`);
        }
        await tracker.track(handleUnsupportedKindAttempt(attemptId, 'ASSEMBLY'));
      }
    });
  }

  // ── Register background loop runners ──────────────────
  const relayRunner =
    options.relayRunner ??
    new WorkerLoopRunner({
      intervalMs: 1_000,
      passFn: async () => {
        try {
          await relayOne(boss as unknown as BossContract);
        } catch (error) {
          console.error("[worker] Outbox relay pass failed:", error);
        }
      },
    });

  const sweepRunner =
    options.sweepRunner ??
    new WorkerLoopRunner({
      intervalMs: 10_000,
      passFn: async () => {
        try {
          await recoverStaleSubmissions();
        } catch (error) {
          console.error("[worker] Stale submission sweeper pass failed:", error);
        }
      },
    });

  relayRunner.start();
  sweepRunner.start();
  console.log("[worker] Background runners started (relay, sweeper).");

  console.log("[worker] Ready and waiting for jobs.");

  // ── Coordinated Graceful Shutdown ─────────────────────
  const coordinator = new WorkerShutdownCoordinator({
    runners: [relayRunner, sweepRunner],
    tracker,
    boss,
  });

  const exitFn = options.exitFn ?? ((code: number) => process.exit(code));

  const shutdown = async (): Promise<ShutdownResult> => {
    console.log("[worker] Shutting down...");
    const result = await coordinator.shutdown();
    console.log(`[worker] Graceful shutdown complete (exitCode: ${result.exitCode}).`);
    exitFn(result.exitCode);
    return result;
  };

  const signalHandler = shutdownHandler(shutdown, (error: unknown) => {
    console.error("[worker] Shutdown failed:", error);
    exitFn(1);
  });

  if (options.registerSignals ?? true) {
    process.on("SIGTERM", signalHandler);
    process.on("SIGINT", signalHandler);
  }

  return {
    boss,
    tracker,
    coordinator,
    relayRunner,
    sweepRunner,
    shutdown,
    signalHandler,
  };
}

if (!process.env.VITEST && process.env.NODE_ENV !== "test") {
  startWorker().catch((err) => {
    console.error("[worker] Failed to start:", err);
    process.exit(1);
  });
}
