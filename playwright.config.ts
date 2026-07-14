import { defineConfig, devices } from '@playwright/test';

/**
 * Auth demo e2e for @rdlabo/ionic-angular-kit.
 * Injects `window.__E2E__` before app scripts so `environment.e2e` enables confirm bypass.
 */
export default defineConfig({
  testDir: './e2e',
  fullyParallel: true,
  forbidOnly: !!process.env['CI'],
  retries: process.env['CI'] ? 2 : 0,
  workers: process.env['CI'] ? 1 : undefined,
  reporter: 'html',
  timeout: process.env['CI'] ? 60000 : 30000,
  use: {
    baseURL: process.env['PLAYWRIGHT_TEST_BASE_URL'] ?? 'http://localhost:4200',
    trace: 'on-first-retry',
  },
  projects: [
    {
      name: 'chromium',
      use: { ...devices['Desktop Chrome'] },
    },
  ],
  webServer: {
    // Other demo tabs need prebuilt libs; kit itself resolves via tsconfig paths.
    command: 'npm run prebuild && npx ng serve demo --configuration=development --port 4200 --host 0.0.0.0',
    url: 'http://localhost:4200',
    reuseExistingServer: !process.env['CI'],
    timeout: 300000,
  },
});
