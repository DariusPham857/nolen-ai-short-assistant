/** Adapt async shutdown to a synchronous signal callback; report rejected cleanup. */
export function shutdownHandler(stop: () => Promise<unknown>, onError: (error: unknown) => void): () => void {
  return () => { void stop().catch(onError); };
}

export interface WorkerLoopOptions {
  intervalMs: number;
  passFn: () => Promise<void>;
  onError?: (error: unknown) => void;
}

/**
 * Controller for background worker interval loops.
 * Enforces graceful shutdown: clears timeout and awaits in-flight pass (PD-AT-14).
 */
export class WorkerLoopRunner {
  private timer: NodeJS.Timeout | null = null;
  private inFlightPromise: Promise<void> | null = null;
  private stopped = true;
  private running = false;

  constructor(private options: WorkerLoopOptions) {}

  start(): void {
    if (this.running && !this.stopped) return;
    this.stopped = false;
    this.running = true;
    this.scheduleNext();
  }

  private scheduleNext(): void {
    if (this.stopped) return;
    this.timer = setTimeout(() => {
      void this.runPass();
    }, this.options.intervalMs);
  }

  private async runPass(): Promise<void> {
    this.timer = null;
    if (this.stopped) return;

    this.inFlightPromise = (async () => {
      try {
        await this.options.passFn();
      } catch (err) {
        if (this.options.onError) {
          this.options.onError(err);
        } else {
          console.error("[WorkerLoopRunner] pass error:", err);
        }
      } finally {
        this.inFlightPromise = null;
      }
    })();

    await this.inFlightPromise;

    if (!this.stopped) {
      this.scheduleNext();
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.running = false;
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    if (this.inFlightPromise !== null) {
      await this.inFlightPromise;
    }
  }

  isStopped(): boolean {
    return this.stopped;
  }
}

/**
 * Tracks in-flight completion promises during worker lifecycle.
 * Invariant (BLOCK 3): Observes rejection internally to prevent unhandledRejection
 * while returning original promise to caller for natural error handling / retry policies.
 */
export class InFlightTracker {
  private active = new Set<Promise<unknown>>();

  track<T>(promise: Promise<T>): Promise<T> {
    this.active.add(promise);
    void promise
      .catch(() => {})
      .finally(() => {
        this.active.delete(promise);
      });
    return promise;
  }

  get count(): number {
    return this.active.size;
  }

  async drain(): Promise<void> {
    while (this.active.size > 0) {
      await Promise.allSettled(Array.from(this.active));
    }
  }
}

export interface BossStopper {
  stop: (options?: { graceful?: boolean; timeout?: number }) => Promise<void>;
  work?: (name: string, handler: (jobs: unknown) => Promise<unknown>) => Promise<unknown>;
  createQueue?: (name: string) => Promise<unknown>;
}

export interface WorkerShutdownCoordinatorDeps {
  runners?: Array<{ stop: () => Promise<void> }>;
  tracker?: InFlightTracker;
  boss: BossStopper;
  timeoutMs?: number;
}

export interface ShutdownResult {
  exitCode: number;
  timedOut: boolean;
}

/**
 * Coordinates graceful shutdown across loop runners, in-flight job completions, and pg-boss queue (PD-AT-14).
 * Order invariant: all loop runners and in-flight tasks must drain before pg-boss is stopped.
 * Invariant (BLOCK 4): Starts shutdown timer immediately at the very top of shutdown sequence.
 * If drain hangs past timeoutMs, marks exitCode = 1 and ensures graceful resolution without severing DB transactions.
 */
export class WorkerShutdownCoordinator {
  private shutdownPromise: Promise<ShutdownResult> | null = null;

  constructor(private deps: WorkerShutdownCoordinatorDeps) {}

  async shutdown(options?: { graceful?: boolean; timeout?: number }): Promise<ShutdownResult> {
    if (!this.shutdownPromise) {
      this.shutdownPromise = (async () => {
        const timeoutMs = options?.timeout ?? this.deps.timeoutMs ?? 10_000;
        let timedOut = false;

        let timer: NodeJS.Timeout | null = null;
        const timeoutPromise = new Promise<'TIMED_OUT'>((resolve) => {
          timer = setTimeout(() => {
            timedOut = true;
            process.exitCode = 1;
            console.warn(`[WorkerShutdownCoordinator] Shutdown timed out after ${timeoutMs}ms. Marking exitCode = 1.`);
            resolve('TIMED_OUT');
          }, timeoutMs);
        });

        try {
          const drainPromise = Promise.all([
            Promise.all((this.deps.runners ?? []).map((r) => r.stop())),
            this.deps.tracker ? this.deps.tracker.drain() : Promise.resolve(),
          ]);

          const outcome = await Promise.race([drainPromise, timeoutPromise]);
          if (outcome === 'TIMED_OUT') {
            // Await drain to finish so active DB transactions aren't severed
            await drainPromise.catch(() => {});
          }
        } catch (err) {
          console.error('[WorkerShutdownCoordinator] Error during shutdown drain:', err);
          timedOut = true;
          process.exitCode = 1;
        } finally {
          if (timer) clearTimeout(timer);
          try {
            await this.deps.boss.stop(options ?? { graceful: true, timeout: 5_000 });
          } catch (err) {
            console.error('[WorkerShutdownCoordinator] Error stopping pg-boss:', err);
            timedOut = true;
            process.exitCode = 1;
          }
        }

        return { exitCode: timedOut ? 1 : 0, timedOut };
      })();
    }
    return this.shutdownPromise;
  }
}
