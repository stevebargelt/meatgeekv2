import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * The browser test of the main path (HAR-97): the built app (`nx build web`,
 * run by the `e2e` target first) served by `vite preview`, with Entra, the API
 * and the SignalR hub faked at the network edge by `page.route` and
 * `page.routeWebSocket`. It needs no network and no secret.
 */
const workspaceRoot = resolve(__dirname, '../..');
const outputRoot = resolve(workspaceRoot, 'dist/.playwright/web-e2e');
const PORT = 4300;
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './src',
  outputDir: resolve(outputRoot, 'test-results'),
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  timeout: 60_000,
  expect: { timeout: 10_000 },
  reporter: [['list'], ['html', { outputFolder: resolve(outputRoot, 'report'), open: 'never' }]],
  use: {
    baseURL: BASE_URL,
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    // Serves what `nx build web` wrote. Never reuse a server already on the
    // port: it could be serving a different build.
    command: `npx vite preview --outDir dist/apps/web --port ${PORT} --strictPort`,
    cwd: workspaceRoot,
    url: BASE_URL,
    reuseExistingServer: false,
    timeout: 60_000,
  },
});
