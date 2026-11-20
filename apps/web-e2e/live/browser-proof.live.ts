import { expect, test, type Page, type Response } from '@playwright/test';
import {
  distinctiveGrillF,
  grillText,
  isAncestorCommit,
  readLiveEnv,
  waitForBuild,
  type LiveEnv,
} from './helpers';
import { signInWithMicrosoft } from './microsoft-sign-in';
import { startSimDevice, type SimDeviceRun } from './simdevice';

/**
 * The live browser proof (HAR-99): on the production web app, the acceptance
 * user signs in through Microsoft's real pages with a TOTP code, starts a cook
 * on the web device, sees a reading simdevice pushes through IoT Hub and
 * SignalR, and stops the cook. See "Live browser proof" in
 * docs/development/live-acceptance.md.
 *
 * Nothing secret is written out: no password, TOTP secret or code,
 * connection string or token. Trace, video and Playwright's own failure
 * screenshot and page snapshot are off (playwright.live.config.ts); this file
 * takes a screenshot on failure only once sign-in has finished, because the
 * sign-in pages show the UPN and what was typed.
 */

const DEVICE_NAME = 'Web acceptance smoker';
const PUSH_TIMEOUT_MS = 60_000;

/** One line of the run's log. Only METRIC lines and plain notes, never a value from env. */
const log = (line: string) => console.log(line);

interface DeviceSummary {
  id: string;
  name: string;
  configuration?: { temperatureUnit?: 'fahrenheit' | 'celsius' };
}
interface CookSummary {
  id: string;
  deviceId: string;
  name: string;
}

let env: LiveEnv;
let signedIn = false;

test.beforeAll(() => {
  // global-setup.ts has checked these already; this is the typed copy.
  env = readLiveEnv(process.env);
});

test.afterEach(async ({ page }, testInfo) => {
  if (testInfo.status === testInfo.expectedStatus || !signedIn || page.isClosed()) return;
  // After sign-in only: the app's pages show no typed secret.
  if (new URL(page.url()).origin !== env.webBaseUrl) return;
  // HAR-101: to a file in the test's output dir, which CI uploads. An
  // attachment given as a `body` is held in memory only, and the list
  // reporter never writes it out.
  const path = testInfo.outputPath('failure.png');
  const taken = await page
    .screenshot({ path, fullPage: true })
    .then(() => true)
    .catch(() => false);
  if (taken) await testInfo.attach('failure', { path, contentType: 'image/png' });
});

/** Keeps the newest response to each API route the proof watches. */
class ApiWatch {
  devices?: Response;
  activeCooks?: Response;
  /** The page's own Authorization header, for cleanup only. Never printed. */
  bearer?: string;

  constructor(
    page: Page,
    private readonly apiBaseUrl: string
  ) {
    page.on('request', request => {
      if (!request.url().startsWith(`${this.apiBaseUrl}/`)) return;
      const authorization = request.headers()['authorization'];
      if (authorization?.startsWith('Bearer ')) this.bearer = authorization;
    });
    page.on('response', response => {
      const request = response.request();
      if (request.method() !== 'GET' || !response.url().startsWith(`${this.apiBaseUrl}/`)) return;
      const url = new URL(response.url());
      const path = url.pathname.slice(new URL(this.apiBaseUrl).pathname.length);
      if (path === '/devices') this.devices = response;
      if (path === '/cooks' && url.searchParams.get('status') === 'active') {
        this.activeCooks = response;
      }
    });
  }
}

test('live: sign in with TOTP, start a cook, see a pushed reading, stop it', async ({ page }) => {
  const appOrigin = env.webBaseUrl;
  let cookId: string | undefined;
  let cookStopped = false;
  let sim: SimDeviceRun | undefined;
  let api: ApiWatch | undefined;
  let apiBaseUrl = '';

  try {
    await test.step('1. wait for the build', async () => {
      const versionUrl = `${appOrigin}/version.json`;
      const waited = await waitForBuild({
        versionUrl,
        expectedSha: env.expectedSha,
        fetchVersion: async () => {
          const response = await fetch(versionUrl, { cache: 'no-store' });
          if (!response.ok) throw new Error(`GET ${versionUrl} answered ${response.status}`);
          return response.text();
        },
        isAncestor: isAncestorCommit,
        sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
        now: () => Date.now(),
      });
      log(
        `Production serves ${waited.servedSha}` +
          (waited.how === 'exact' ? '' : `, which contains ${env.expectedSha}`)
      );
      log(`METRIC web-deploy-wait-s ${Math.round(waited.waitedMs / 1000)}`);

      // The API the deployed app calls, from the deployed app's own config.
      const config = await fetch(`${appOrigin}/config.json`, { cache: 'no-store' });
      expect(config.ok, `GET ${appOrigin}/config.json answered ${config.status}`).toBe(true);
      apiBaseUrl = ((await config.json()) as { apiBaseUrl: string }).apiBaseUrl.replace(/\/+$/, '');
      api = new ApiWatch(page, apiBaseUrl);
    });
    const watch = api as ApiWatch;

    await test.step('2. sign in on the real Microsoft pages', async () => {
      await page.goto(appOrigin);
      await page.getByRole('button', { name: 'Sign in', exact: true }).click();
      await signInWithMicrosoft(page, {
        upn: env.upn,
        password: env.password,
        totpSecret: env.totpSecret,
        appOrigin,
        note: log,
      });
      await expect(
        page.getByRole('banner').locator('.user-name'),
        'the app header does not show the signed-in user'
      ).toHaveText(/\S/, { timeout: 30_000 });
      signedIn = true;
      await expect
        .poll(() => watch.devices?.status(), {
          message: 'GET /devices did not answer 200 after sign-in',
          timeout: 30_000,
        })
        .toBe(200);
    });

    const row = page
      .getByRole('row')
      .filter({ has: page.locator('code').getByText(env.deviceId, { exact: true }) });

    let device: DeviceSummary | undefined;
    await test.step('3. the web device is registered', async () => {
      const listed = ((await watch.devices?.json()) as { devices: DeviceSummary[] }).devices;
      if (listed.some(device => device.id === env.deviceId)) {
        log(`Device ${env.deviceId} is already registered`);
      } else {
        const form = page.getByRole('form', { name: 'Register a device' });
        await form.getByLabel('Device ID').fill(env.deviceId);
        await form.getByLabel('Name', { exact: true }).fill(DEVICE_NAME);
        await form.getByLabel('Model').fill('simdevice');
        const registered = page.waitForResponse(
          r => r.request().method() === 'POST' && r.url() === `${apiBaseUrl}/devices`
        );
        await form.getByRole('button', { name: 'Register' }).click();
        const status = (await registered).status();
        expect(status, `registering ${env.deviceId} answered ${status}, expected 201`).toBe(201);
        log(`Registered device ${env.deviceId}`);
      }
      await expect(row, `${env.deviceId} is not on the devices page`).toBeVisible();
      // Read now: Chromium may drop a response body once the page moves on.
      const devices = ((await watch.devices?.json()) as { devices: DeviceSummary[] }).devices;
      device = devices.find(d => d.id === env.deviceId);
    });

    await test.step('4. clean slate: stop a cook left running on the device', async () => {
      await expect
        .poll(() => watch.activeCooks?.status(), {
          message: 'GET /cooks?status=active did not answer 200',
          timeout: 30_000,
        })
        .toBe(200);
      const active = ((await watch.activeCooks?.json()) as { cooks: CookSummary[] }).cooks;
      const leftover = active.find(cook => cook.deviceId === env.deviceId);
      if (!leftover) return;
      log(`Stopping cook ${leftover.id}, left running on ${env.deviceId}`);
      await row.getByRole('link', { name: /^Cooking: / }).click();
      await expect(page).toHaveURL(`${appOrigin}/cooks/${encodeURIComponent(leftover.id)}`);
      await stopThroughUi(page);
      await page
        .getByRole('navigation', { name: 'Main' })
        .getByRole('link', { name: 'Devices' })
        .click();
      await expect(row.getByRole('button', { name: 'Start cook' })).toBeVisible();
    });

    const cookName = `acceptance web ${env.runId}`;
    const panel = page.getByTestId('cook-live-panel');

    await test.step('5. start a cook', async () => {
      await row.getByRole('button', { name: 'Start cook' }).click();
      const form = page.getByRole('form', { name: /^Start a cook on / });
      await form.getByLabel('Name', { exact: true }).fill(cookName);
      await form.getByLabel('Meat type').fill('Brisket');
      await form.getByLabel('Grill target (°F)').fill('225');
      await form.getByRole('button', { name: 'Start', exact: true }).click();
      await expect(page, 'starting the cook did not open its page').toHaveURL(
        new RegExp(`^${escapeRegExp(appOrigin)}/cooks/[^/]+$`)
      );
      cookId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() as string);
      log(`Started cook ${cookId} (${cookName})`);
      await expect(page.getByRole('heading', { name: cookName })).toBeVisible();
      await expect(panel, 'the live panel is not connected').toHaveAttribute(
        'data-state',
        /^(waiting|live)$/,
        { timeout: 30_000 }
      );
    });

    await test.step('6. a pushed reading reaches the screen', async () => {
      const unit = device?.configuration?.temperatureUnit;
      const grillF = distinctiveGrillF(Date.now());
      const expected = grillText(grillF, unit);
      log(`Sending 10 readings as ${env.deviceId} with grill ${grillF} °F`);

      const run = startSimDevice(env.simdeviceBin, env.simdeviceConnectionString, [
        '--count',
        '10',
        '--interval',
        '1s',
        '--grill',
        String(grillF),
      ]);
      sim = run;
      // The browser's own clock when the panel first showed the value.
      const shown = page
        .waitForFunction(
          text => {
            const live = document.querySelector('[data-testid="cook-live-panel"]');
            const grill = live?.querySelector('[data-channel="grill"] dd');
            return live?.getAttribute('data-state') === 'live' && grill?.textContent === text
              ? Date.now()
              : false;
          },
          expected,
          { polling: 100, timeout: PUSH_TIMEOUT_MS }
        )
        .then(handle => handle.jsonValue() as Promise<number>);
      const failedSend = run.exit.then(result =>
        result.code === 0 ? new Promise<never>(() => undefined) : Promise.reject(simError(result))
      );
      let shownAt: number;
      try {
        shownAt = await Promise.race([shown, failedSend]);
      } catch (error) {
        const grill = await panel
          .locator('[data-channel="grill"] dd')
          .textContent()
          .catch(() => null);
        const state = await panel.getAttribute('data-state').catch(() => null);
        throw new Error(
          `The live panel did not show grill ${expected} within ${PUSH_TIMEOUT_MS / 1000} s ` +
            `(it shows ${grill ?? 'nothing'}, data-state ${state ?? 'none'}): ` +
            (error instanceof Error ? error.message : String(error))
        );
      }
      const first = await run.first;
      log(`METRIC web-push-ms ${Math.max(0, shownAt - Date.parse(first.timestamp))}`);

      const exit = await run.exit;
      expect(exit.code, simError(exit).message).toBe(0);
      expect(exit.lines, 'simdevice did not report 10 sent readings').toBe(10);
    });

    await test.step('7. stop the cook', async () => {
      await stopThroughUi(page);
      cookStopped = true;
      await expect(panel, 'the live panel is still on screen after the stop').toHaveCount(0);
    });
  } finally {
    sim?.kill();
    if (cookId && !cookStopped) {
      await test.step('8. cleanup: stop the cook through the API', async () => {
        await stopThroughApi(apiBaseUrl, cookId as string, api?.bearer);
      });
    }
  }
});

/** Stop the cook on screen with its confirm step; it then shows completed. */
async function stopThroughUi(page: Page) {
  await page.getByRole('button', { name: 'Stop cook' }).click();
  await page
    .getByRole('group', { name: 'Confirm stop' })
    .getByRole('button', { name: 'Yes, stop cook' })
    .click();
  await expect(page.locator('dt:text-is("Status") + dd'), 'the cook did not complete').toHaveText(
    'completed'
  );
  await expect(page.getByRole('button', { name: 'Stop cook' })).toHaveCount(0);
}

/**
 * Stop a cook this run started and could not stop on screen, with the token
 * the page itself sent. Only the status is logged. A 409 means it had stopped.
 */
async function stopThroughApi(apiBaseUrl: string, cookId: string, bearer: string | undefined) {
  if (!apiBaseUrl || !bearer) {
    log(`Cleanup: cook ${cookId} may still be active; the page sent no token to stop it with`);
    return;
  }
  try {
    const response = await fetch(`${apiBaseUrl}/cooks/${encodeURIComponent(cookId)}/stop`, {
      method: 'POST',
      headers: { authorization: bearer },
    });
    log(`Cleanup: POST /cooks/${cookId}/stop answered ${response.status}`);
  } catch (error) {
    log(`Cleanup: POST /cooks/${cookId}/stop failed: ${(error as Error).name}`);
  }
}

function simError(exit: { code: number | null; stderrFirstLine: string }): Error {
  return new Error(
    `simdevice exited ${exit.code ?? '(killed)'}` +
      (exit.stderrFirstLine ? `: ${exit.stderrFirstLine}` : '')
  );
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
