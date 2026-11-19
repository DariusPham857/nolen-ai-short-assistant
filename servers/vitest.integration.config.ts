import { defineConfig } from "vitest/config";
import path from "path";

/**
 * Integration test config — runs against real PostgreSQL 16.
 * Financial ledger, concurrency, and outbox tests MUST use this config.
 * SQLite mocks are prohibited for ledger/locking tests (AGENTS.md).
 */
export default defineConfig({
  test: {
    globals: true,
    environment: "node",
    include: ["src/**/*.integration.test.ts"],
    testTimeout: 30_000,
    hookTimeout: 30_000,
    coverage: {
      provider: "v8",
      include: ["src/**/*.ts"],
    },
  },
  resolve: {
    alias: {
      "@": path.resolve(__dirname, "src"),
    },
  },
});
