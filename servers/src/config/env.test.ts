import { describe, it, expect, beforeEach } from "vitest";
import { getEnv, resetEnvCache } from "../config/env.js";

describe("Environment Config", () => {
  beforeEach(() => {
    resetEnvCache();
  });

  it("returns default values when env vars are not set", () => {
    const env = getEnv();
    expect(env.EXECUTION_MODE).toBe("REPLAY");
    expect(env.PORT).toBe(3001);
    expect(env.HOST).toBe("127.0.0.1");
    // vitest sets NODE_ENV=test automatically
    expect(env.NODE_ENV).toBe("test");
    expect(env.STORAGE_BASE_PATH).toBe("./storage");
    expect(env.WORKER_CONCURRENCY).toBe(2);
  });

  it("caches the parsed env on subsequent calls", () => {
    const env1 = getEnv();
    const env2 = getEnv();
    expect(env1).toBe(env2); // same reference
  });
});
