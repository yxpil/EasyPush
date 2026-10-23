import { defineConfig } from '@playwright/test';

export default defineConfig({
  testDir: 'tests/e2e',
  timeout: 150_000,
  expect: { timeout: 15_000 },
  workers: 1,
  fullyParallel: false,
  forbidOnly: Boolean(process.env['CI']),
  retries: 0,
  reporter: [['list']],
  outputDir: 'test-results',
});
