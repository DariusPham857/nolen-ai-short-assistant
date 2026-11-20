import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: './tests/e2e', workers: 1, fullyParallel: false, timeout: 30000,
  use: { baseURL: 'http://127.0.0.1:3000', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'pnpm --filter @nolen/web start', url: 'http://127.0.0.1:3000/api/health/live',
    reuseExistingServer: false, timeout: 60000,
    env: { OPERATOR_TOKEN: 'test-only-operator-token-32-bytes-minimum', DATABASE_URL: process.env.DATABASE_URL ?? '', NEXT_TELEMETRY_DISABLED: '1' },
  },
});
