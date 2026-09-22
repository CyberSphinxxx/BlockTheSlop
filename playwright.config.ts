import { defineConfig, devices } from '@playwright/test';

// Extension E2E tests run against a persistent Chromium context with the
// unpacked production build from .output/chrome-mv3 (see tests/e2e/utils.ts).
export default defineConfig({
  testDir: './tests/e2e',
  timeout: 60_000,
  expect: { timeout: 10_000 },
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    viewport: { width: 1280, height: 800 },
    actionTimeout: 10_000,
  },
  projects: [
    {
      name: 'chromium-extension',
      testIgnore: /firefox\.smoke\.spec\.ts$/,
      use: { ...devices['Desktop Chrome'] },
    },
    {
      name: 'firefox-smoke',
      testMatch: /firefox\.smoke\.spec\.ts$/,
      use: { ...devices['Desktop Firefox'] },
    },
  ],
});
