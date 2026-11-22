import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * The browser test of the main path (HAR-97): the built app (`nx build web`,
 * run by the `e2e` target first) served by `vite preview`, with Entra, the API
 * and the SignalR hub faked at the network edge by `page.route` and
 * `page.routeWebSocket`. It needs no network and no secret.
 *
 * HAR-121: no wait here has a deadline of its own. Every `expect` and action
 * waits for its event, bounded only by the test timeout (`expect.timeout: 0`;
 * actions have no timeout by default), and the specs freeze the browser's
 * clock and the fakes' on one instant (src/fakes/clock.ts).
 *
 * The port is WEB_E2E_PORT, 4300 when unset (`nx e2e web-e2e`). test-repeat
 * gives each concurrent copy its own (tools/test-repeat/suites.mjs).
 * `--strictPort` stays, so a port already taken fails the run loudly. A run
 * on a port of its own also writes its results and report under
 * `port-<port>/`, since Playwright empties its output dir when it starts and
 * would delete a concurrent copy's traces.
 */
const workspaceRoot = resolve(__dirname, '../..');
const portSetting = process.env['WEB_E2E_PORT'] ?? '';
const PORT = webE2ePort(portSetting);
const outputRoot = resolve(
  workspaceRoot,
  'dist/.playwright/web-e2e',
  portSetting === '' ? '' : `port-${PORT}`
);
const BASE_URL = `http://localhost:${PORT}`;

export default defineConfig({
  testDir: './src',
  outputDir: resolve(outputRoot, 'test-results'),
  fullyParallel: false,
  forbidOnly: !!process.env['CI'],
  retries: 0,
  workers: 1,
  // The one real-time bound: a hang guard far above a run (about 5 s a test
  // on one copy). A failing expect reports the locator it was waiting for.
  timeout: 60_000,
  expect: { timeout: 0 },
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
    // How long `vite preview` may take to answer: a hang guard, not a test
    // verdict (it starts in about a second).
    timeout: 60_000,
  },
});

function webE2ePort(value: string): number {
  if (value === '') return 4300;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`WEB_E2E_PORT must be a port number from 1024 to 65535, got ${value}`);
  }
  return port;
}
