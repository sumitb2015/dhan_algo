import { defineConfig } from '@playwright/test';

/**
 * Browser tests (`npm run test:e2e`). They drive the real UI against a dev server with every
 * broker-backed /api/* call MOCKED in the browser (see e2e/support.ts), so they need no Dhan
 * session and cannot place orders. Unit tests stay in lib/*.test.ts (`npm test`).
 *
 * E2E_PORT: dev-server port (default 3100, so it never collides with a dashboard on 3000).
 * PW_CHROMIUM_PATH: use an existing Chromium instead of Playwright's own download.
 */
const PORT = Number(process.env.E2E_PORT ?? 3100);

export default defineConfig({
  testDir: './e2e',
  timeout: 90_000,
  expect: { timeout: 20_000 },
  fullyParallel: true,
  workers: process.env.CI ? 2 : undefined,
  reporter: [['list']],
  use: {
    baseURL: `http://localhost:${PORT}`,
    viewport: { width: 1900, height: 1100 },
    trace: 'retain-on-failure',
    launchOptions: process.env.PW_CHROMIUM_PATH
      ? { executablePath: process.env.PW_CHROMIUM_PATH, args: ['--no-sandbox'] }
      : { args: ['--no-sandbox'] },
  },
  webServer: {
    command: `npm run dev -- -p ${PORT}`,
    url: `http://localhost:${PORT}/login`,
    reuseExistingServer: !process.env.CI,
    timeout: 180_000,
  },
});
