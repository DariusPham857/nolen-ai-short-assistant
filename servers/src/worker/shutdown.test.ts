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
