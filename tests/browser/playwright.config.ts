import { defineConfig } from '@playwright/test';
export default defineConfig({
  testDir: '.', testMatch: '*.spec.ts', workers: 1, retries: 0,
  timeout: 45_000, expect: { timeout: 10_000 },
  outputDir: '../../test-results/browser',
  use: { baseURL: 'http://127.0.0.1:4173', browserName: 'chromium', trace: 'retain-on-failure', screenshot: 'only-on-failure' },
  webServer: {
    command: 'node_modules/.bin/tsx tests/browser/server.mts',
    cwd: process.cwd(), url: 'http://127.0.0.1:4173/readyz',
    reuseExistingServer: false, timeout: 60_000,
    gracefulShutdown: { signal: 'SIGTERM', timeout: 15_000 },
  },
});
