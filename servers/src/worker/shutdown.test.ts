import { expect, it, vi } from "vitest";
import { shutdownHandler } from "./shutdown.js";

it("runs shutdown without reporting an error on success", async () => {
  const stop = vi.fn().mockResolvedValue(undefined);
  const report = vi.fn();
  expect(shutdownHandler(stop, report)()).toBeUndefined();
  await Promise.resolve();
  expect(stop).toHaveBeenCalledOnce();
  expect(report).not.toHaveBeenCalled();
});

it("reports cleanup failure instead of leaving a rejected promise", async () => {
  const error = new Error("fixture shutdown failure");
  const report = vi.fn();
  shutdownHandler(() => Promise.reject(error), report)();
  await Promise.resolve();
  expect(report).toHaveBeenCalledWith(error);
});

it("PD-AT-14: coordinates graceful worker shutdown by draining runners before stopping pg-boss", async () => {
  vi.useFakeTimers();
  const { WorkerLoopRunner, WorkerShutdownCoordinator } = await import("./shutdown.js");

  const executionOrder: string[] = [];
  let inFlightPassActive = false;

  const mockPass = vi.fn().mockImplementation(async () => {
    inFlightPassActive = true;
    executionOrder.push("pass:start");
    // Simulate async relay/recovery work
    await new Promise((resolve) => setTimeout(resolve, 50));
    inFlightPassActive = false;
    executionOrder.push("pass:done");
  });

  const runner = new WorkerLoopRunner({
    intervalMs: 100,
    passFn: mockPass,
  });

  const mockBoss = {
    stop: vi.fn().mockImplementation(async () => {
      executionOrder.push("boss:stopped");
    }),
  };

  const coordinator = new WorkerShutdownCoordinator({
    runners: [runner],
    boss: mockBoss,
  });

  // 1. Start loop
  runner.start();

  // 2. Advance time to trigger first pass (at 100ms)
  await vi.advanceTimersByTimeAsync(100);
  expect(mockPass).toHaveBeenCalledTimes(1);

  // 3. Advance time to mid-flight of pass (25ms into the 50ms pass)
  await vi.advanceTimersByTimeAsync(25);
  expect(inFlightPassActive).toBe(true);

  // 4. Trigger shutdown while pass is active
  const shutdownPromise = coordinator.shutdown();

  // 5. Advance timers to allow the 50ms in-flight pass to finish
  await vi.advanceTimersByTimeAsync(25);
  await shutdownPromise;

  // 6. Assertions on graceful shutdown invariants:
  // - In-flight pass completed before boss was stopped
  expect(executionOrder).toEqual(["pass:start", "pass:done", "boss:stopped"]);
  expect(mockBoss.stop).toHaveBeenCalledOnce();

  // 7. Timer cancellation verification:
  // Advance time by another 500ms; call count MUST NOT increase after shutdown
  await vi.advanceTimersByTimeAsync(500);
  expect(mockPass).toHaveBeenCalledTimes(1);

  vi.useRealTimers();
});

it("wires WorkerShutdownCoordinator into production worker lifecycle and drains runners before boss.stop", async () => {
  vi.useFakeTimers();
  const { startWorker } = await import("./index.js");
  const { WorkerLoopRunner } = await import("./shutdown.js");

  const executionOrder: string[] = [];
  let inFlightPassActive = false;

  const mockRelayPass = vi.fn().mockImplementation(async () => {
    inFlightPassActive = true;
    executionOrder.push("relay:start");
    await new Promise((resolve) => setTimeout(resolve, 50));
    inFlightPassActive = false;
    executionOrder.push("relay:done");
  });

  const mockSweepPass = vi.fn().mockImplementation(async () => {
    executionOrder.push("sweep:pass");
  });

  const relayRunner = new WorkerLoopRunner({ intervalMs: 100, passFn: mockRelayPass });
  const sweepRunner = new WorkerLoopRunner({ intervalMs: 200, passFn: mockSweepPass });

  const mockBoss = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockImplementation(async () => {
      executionOrder.push("boss:stopped");
    }),
    on: vi.fn(),
  };

  const exitCalls: number[] = [];
  const worker = await startWorker({
    boss: mockBoss as unknown as NonNullable<Parameters<typeof startWorker>[0]>["boss"],
    relayRunner,
    sweepRunner,
    registerSignals: false,
    exitFn: (code) => exitCalls.push(code),
  });

  expect(mockBoss.start).toHaveBeenCalledOnce();
  expect(relayRunner.isStopped()).toBe(false);
  expect(sweepRunner.isStopped()).toBe(false);

  // Trigger first relay pass
  await vi.advanceTimersByTimeAsync(125);
  expect(inFlightPassActive).toBe(true);

  // Signal shutdown mid-flight
  worker.signalHandler();

  // Allow in-flight pass to finish
  await vi.advanceTimersByTimeAsync(25);
  await Promise.resolve();

  // Validate strict draining order and exit
  expect(executionOrder).toEqual(["relay:start", "relay:done", "boss:stopped"]);
  expect(mockBoss.stop).toHaveBeenCalledOnce();
  expect(relayRunner.isStopped()).toBe(true);
  expect(sweepRunner.isStopped()).toBe(true);
  expect(exitCalls).toEqual([0]);

  vi.useRealTimers();
});

it("instantiates default outbox relay and sweep runners when none are provided", async () => {
  const { startWorker } = await import("./index.js");
  const { WorkerLoopRunner } = await import("./shutdown.js");

  const mockBoss = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    on: vi.fn(),
    send: vi.fn(),
    getJobById: vi.fn(),
  };

  const worker = await startWorker({
    boss: mockBoss as unknown as NonNullable<Parameters<typeof startWorker>[0]>["boss"],
    registerSignals: false,
    exitFn: () => {},
  });

  expect(worker.relayRunner).toBeInstanceOf(WorkerLoopRunner);
  expect(worker.sweepRunner).toBeInstanceOf(WorkerLoopRunner);
  expect(worker.coordinator).toBeDefined();

  await worker.shutdown();
  expect(worker.relayRunner.isStopped()).toBe(true);
  expect(worker.sweepRunner.isStopped()).toBe(true);
  expect(mockBoss.stop).toHaveBeenCalledOnce();
});

it("reports shutdown failure and exits with code 1 if coordinator shutdown rejects", async () => {
  const { startWorker } = await import("./index.js");

  const failingBoss = {
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockRejectedValue(new Error("boss stop failure")),
    on: vi.fn(),
  };

  const exitCalls: number[] = [];
  const worker = await startWorker({
    boss: failingBoss as unknown as NonNullable<Parameters<typeof startWorker>[0]>["boss"],
    registerSignals: false,
    exitFn: (code) => exitCalls.push(code),
  });

  worker.signalHandler();
  await new Promise((resolve) => setTimeout(resolve, 10));

  expect(failingBoss.stop).toHaveBeenCalledOnce();
  expect(exitCalls).toEqual([1]);
});

it("BLOCK 3: InFlightTracker tracks active promises and swallows internal rejection safely", async () => {
  const { InFlightTracker } = await import("./shutdown.js");
  const tracker = new InFlightTracker();

  let unhandledEmitted = false;
  const unhandledListener = () => {
    unhandledEmitted = true;
  };
  process.on("unhandledRejection", unhandledListener);

  try {
    const errorPromise = Promise.reject(new Error("simulated completion error"));
    const trackedPromise = tracker.track(errorPromise);

    expect(tracker.count).toBe(1);

    // Caller catches error from original promise
    await expect(trackedPromise).rejects.toThrow("simulated completion error");

    // Drain tracker
    await tracker.drain();
    expect(tracker.count).toBe(0);

    // Yield macro-task to allow any unhandled rejection to surface
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(unhandledEmitted).toBe(false);
  } finally {
    process.removeListener("unhandledRejection", unhandledListener);
  }
});

it("BLOCK 4: WorkerShutdownCoordinator times out immediately when runner hangs, setting exitCode = 1", async () => {
  vi.useFakeTimers();
  const { WorkerShutdownCoordinator } = await import("./shutdown.js");

  let passResolve: () => void = () => {};
  const hangingRunner = {
    stop: vi.fn().mockImplementation(
      () =>
        new Promise<void>((resolve) => {
          passResolve = resolve;
        })
    ),
  };

  const mockBoss = {
    stop: vi.fn().mockResolvedValue(undefined),
  };

  const coordinator = new WorkerShutdownCoordinator({
    runners: [hangingRunner],
    boss: mockBoss,
    timeoutMs: 1000,
  });

  const shutdownPromise = coordinator.shutdown({ timeout: 1000 });

  // Advance time past timeout
  await vi.advanceTimersByTimeAsync(1100);

  // Now resolve the hanging runner to allow non-severed cleanup to complete
  passResolve();
  await vi.advanceTimersByTimeAsync(100);

  const result = await shutdownPromise;
  expect(result.timedOut).toBe(true);
  expect(result.exitCode).toBe(1);
  expect(mockBoss.stop).toHaveBeenCalledOnce();

  vi.useRealTimers();
});

it("BLOCK 1 (Startup Queue Provisioning): fails closed and does not start relay or sweep runners if createQueue rejects on a LIVE queue", async () => {
  const { startWorker } = await import("./index.js");
  const { WorkerLoopRunner } = await import("./shutdown.js");

  const mockBoss = {
    start: vi.fn().mockResolvedValue(undefined),
    createQueue: vi.fn().mockImplementation(async (q: string) => {
      if (q === "live:tts:dispatch") {
        throw new Error("Simulated permission error creating live:tts:dispatch");
      }
    }),
    work: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };

  const relayRunner = new WorkerLoopRunner({ intervalMs: 100, passFn: vi.fn() });
  const sweepRunner = new WorkerLoopRunner({ intervalMs: 100, passFn: vi.fn() });
  const relayStartSpy = vi.spyOn(relayRunner, "start");
  const sweepStartSpy = vi.spyOn(sweepRunner, "start");

  await expect(
    startWorker({
      boss: mockBoss,
      relayRunner,
      sweepRunner,
      registerSignals: false,
    })
  ).rejects.toThrow("Simulated permission error creating live:tts:dispatch");

  expect(relayStartSpy).not.toHaveBeenCalled();
  expect(sweepStartSpy).not.toHaveBeenCalled();
  expect(mockBoss.work).not.toHaveBeenCalled();
});

it("CS-AT-01: aborts worker startup before pg-boss starts when storage is unwritable", async () => {
  const { storage } = await import("../lib/storage.js");
  const { startWorker } = await import("./index.js");
  const { WorkerLoopRunner } = await import("./shutdown.js");

  const checkSpy = vi.spyOn(storage, "checkWritable").mockRejectedValueOnce(new Error("EACCES: read-only storage"));
  const mockBoss = {
    start: vi.fn().mockResolvedValue(undefined),
    createQueue: vi.fn().mockResolvedValue(undefined),
    work: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
  };
  const relayRunner = new WorkerLoopRunner({ intervalMs: 100, passFn: vi.fn() });
  const sweepRunner = new WorkerLoopRunner({ intervalMs: 100, passFn: vi.fn() });
  const relayStartSpy = vi.spyOn(relayRunner, "start");
  const sweepStartSpy = vi.spyOn(sweepRunner, "start");

  try {
    await expect(
      startWorker({
        boss: mockBoss,
        relayRunner,
        sweepRunner,
        registerSignals: false,
      }),
    ).rejects.toThrow("EACCES: read-only storage");
    expect(mockBoss.start).not.toHaveBeenCalled();
    expect(mockBoss.createQueue).not.toHaveBeenCalled();
    expect(relayStartSpy).not.toHaveBeenCalled();
    expect(sweepStartSpy).not.toHaveBeenCalled();
  } finally {
    checkSpy.mockRestore();
  }
});


