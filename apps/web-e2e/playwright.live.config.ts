import { defineConfig, devices } from '@playwright/test';
import { resolve } from 'node:path';

/**
 * The live browser proof (HAR-99): the production web app, Microsoft's real
 * sign-in, the dev API, IoT Hub and SignalR. Inputs come from the environment
 * (see live/helpers.ts and docs/development/live-acceptance.md); a missing one
 * stops the run in global setup, before a browser starts.
 *
 * Nothing that could hold a secret is recorded: no trace, no video, no
 * Playwright failure screenshot (the sign-in pages show the UPN and what was
 * typed; the proof takes its own, after sign-in), no HTML report (it would
 * list every step), and no failure page snapshot (`error-context.md`).
 */
process.env['PLAYWRIGHT_NO_COPY_PROMPT'] = '1';

const workspaceRoot = resolve(__dirname, '../..');
const outputRoot = resolve(workspaceRoot, 'dist/.playwright/web-e2e-live');

export default defineConfig({
  testDir: './live',
  testMatch: '**/*.live.ts',
  outputDir: resolve(outputRoot, 'test-results'),
  globalSetup: './live/global-setup.ts',
  fullyParallel: false,
  forbidOnly: true,
  retries: 0,
  workers: 1,
  // Up to 15 min waiting for the Vercel build, then a few minutes of proof.
  timeout: 25 * 60_000,
  expect: { timeout: 30_000 },
  reporter: [['list']],
  use: {
    headless: true,
    trace: 'off',
    video: 'off',
    screenshot: 'off',
    actionTimeout: 30_000,
    navigationTimeout: 60_000,
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
});
