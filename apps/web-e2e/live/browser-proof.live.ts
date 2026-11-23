import { expect, test, type Locator, type Page, type Response } from '@playwright/test';
import {
  distinctiveGrillF,
  grillText,
  isAncestorCommit,
  LAST_HEARD_TEXT,
  readLiveEnv,
  waitForBuild,
  type LiveEnv,
} from './helpers';
import { expectLivePanelConnected } from './live-panel';
import { signInWithMicrosoft } from './microsoft-sign-in';
import { readClaimCode, startSimDevice, type SimDeviceRun } from './simdevice';

/**
 * The live browser proof (HAR-99): on the production web app, the acceptance
 * user signs in through Microsoft's real pages with a TOTP code, claims the
 * web device with the code it reports (HAR-141), starts a cook on it, sees a
 * reading simdevice pushes through IoT Hub and SignalR, stops the cook, sees
 * on the devices page when IoT Hub last heard from the device (HAR-143) and
 * releases the device. See "Live browser proof" in
 * docs/development/live-acceptance.md.
 *
 * Nothing secret is written out: no password, TOTP secret or code, claim
 * code, connection string or token. Trace, video and Playwright's own failure
 * screenshot and page snapshot are off (playwright.live.config.ts); this file
 * takes a screenshot on failure only once sign-in has finished, because the
 * sign-in pages show the UPN and what was typed, and never on the claim page,
 * whose form can hold the claim code.
 */

const DEVICE_NAME = 'Web acceptance smoker';
/**
 * Every bound below is a row of "Real-time waits" in
 * docs/development/live-acceptance.md, with the runs it was measured on.
 */
const PUSH_TIMEOUT_MS = 60_000;
/** The app-side waits after sign-in: the header, GET /devices, GET /cooks, a claim, a release,
 *  the device row's connection text. */
const APP_TIMEOUT_MS = 30_000;
const APP_TIMEOUT_S = APP_TIMEOUT_MS / 1000;
/** simdevice's own bound on the twin sync before the claim (`--twin --timeout`). */
const TWIN_SYNC_TIMEOUT = '60s';
/** The claim page: its form can hold the claim code, so no screenshot is taken there. */
const CLAIM_PATH = '/devices/claim';

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
  // After sign-in only: the app's pages show no typed secret, except the claim
  // page, whose form can still hold the claim code.
  const at = new URL(page.url());
  if (at.origin !== env.webBaseUrl) return;
  if (at.pathname === CLAIM_PATH) {
    log('No failure screenshot: the claim page can show the claim code');
    return;
  }
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

test('live: sign in with TOTP, claim the device, start a cook, see a pushed reading, stop it, release the device', async ({
  page,
}, testInfo) => {
  const appOrigin = env.webBaseUrl;
  let cookId: string | undefined;
  let cookStopped = false;
  /** This run claimed the device and has not released it yet. */
  let claimed = false;
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
        // HAR-121: next to failure.png, which CI uploads. Text only, scrubbed.
        diagnosticPath: testInfo.outputPath('sign-in-diagnostic.txt'),
      });
      await expect(
        page.getByRole('banner').locator('.user-name'),
        `the app header did not show the signed-in user within ${APP_TIMEOUT_S} s`
      ).toHaveText(/\S/, { timeout: APP_TIMEOUT_MS });
      signedIn = true;
      await expect
        .poll(() => watch.devices?.status(), {
          message: `GET /devices did not answer 200 within ${APP_TIMEOUT_S} s of sign-in`,
          timeout: APP_TIMEOUT_MS,
        })
        .toBe(200);
    });

    const row = page
      .getByRole('row')
      .filter({ has: page.locator('code').getByText(env.deviceId, { exact: true }) });

    await test.step('3. clean slate: release the device if an earlier run left it claimed', async () => {
      const listed = ((await watch.devices?.json()) as { devices: DeviceSummary[] }).devices;
      if (!listed.some(d => d.id === env.deviceId)) {
        log(`Device ${env.deviceId} is not the acceptance user's: nothing to release`);
        return;
      }
      log(`Device ${env.deviceId} is still the acceptance user's from an earlier run`);
      // Release answers 409 COOK_ACTIVE while a cook runs: stop a leftover first.
      await expect
        .poll(() => watch.activeCooks?.status(), {
          message: `GET /cooks?status=active did not answer 200 within ${APP_TIMEOUT_S} s`,
          timeout: APP_TIMEOUT_MS,
        })
        .toBe(200);
      const active = ((await watch.activeCooks?.json()) as { cooks: CookSummary[] }).cooks;
      const leftover = active.find(cook => cook.deviceId === env.deviceId);
      if (leftover) {
        log(`Stopping cook ${leftover.id}, left running on ${env.deviceId}`);
        await row.getByRole('link', { name: /^Cooking: / }).click();
        await expect(page).toHaveURL(`${appOrigin}/cooks/${encodeURIComponent(leftover.id)}`);
        await stopThroughUi(page);
        await openDevicesPage(page);
      }
      await releaseThroughUi(page, row, apiBaseUrl, env.deviceId);
      log(`Released device ${env.deviceId}`);
    });

    let device: DeviceSummary | undefined;
    await test.step('4. claim the web device with its code', async () => {
      const credential = env.simdevice;
      if (credential.mode !== 'dps') {
        throw new Error(
          'Claiming the web device needs simdevice in DPS mode, where the device mints its ' +
            'claim code: set ACCEPTANCE_WEB_STATE_DIR and ACCEPTANCE_DPS_ID_SCOPE in place of ' +
            'SIMDEVICE_WEB_CONNECTION_STRING'
        );
      }
      // A full twin sync: a device released since its last sync (step 3, or
      // an earlier run's end) sees the new claim generation and mints a code.
      const sync = startSimDevice(env.simdeviceBin, credential, [
        '--twin',
        '--count',
        '0',
        '--timeout',
        TWIN_SYNC_TIMEOUT,
      ]);
      sim = sync;
      const synced = await sync.exit;
      expect(synced.code, `the twin sync failed: ${simError(synced).message}`).toBe(0);

      // A secret until used: never logged, never in an expect's message.
      const read = await readClaimCode(env.simdeviceBin, credential.stateDir);
      if (read.state !== 'unclaimed' || read.claimCode === undefined) {
        throw new Error(
          `simdevice claim-code reports ${read.state} for ${env.deviceId} after a twin sync, so ` +
            'there is no code to claim with. ' +
            (read.state === 'claimed'
              ? 'Its code was used and the device not released, yet it is not on the ' +
                "acceptance user's devices page: another user holds it. Release it as that user."
              : 'Expected unclaimed, with a code.')
        );
      }
      const claimCode = read.claimCode;

      await page.goto(`${appOrigin}${CLAIM_PATH}?deviceId=${encodeURIComponent(env.deviceId)}`);
      const form = page.getByRole('form', { name: 'Claim a device' });
      await expect(
        form.getByLabel('Device ID'),
        'the claim page did not take ?deviceId='
      ).toHaveValue(env.deviceId);
      await form.getByLabel('Claim code').fill(claimCode);
      await form.getByLabel('Name', { exact: true }).fill(DEVICE_NAME);
      const answered = page
        .waitForResponse(
          r => r.request().method() === 'POST' && r.url() === `${apiBaseUrl}/devices/claim`,
          { timeout: APP_TIMEOUT_MS }
        )
        .catch(() => {
          throw new Error(
            `POST /devices/claim (claiming ${env.deviceId}) did not answer within ${APP_TIMEOUT_S} s`
          );
        });
      await form.getByRole('button', { name: 'Claim device' }).click();
      const status = (await answered).status();
      if (status === 403) {
        throw new Error(
          `POST /devices/claim refused ${env.deviceId} (403) with the code the device just ` +
            `reported: ${await whyRefused(apiBaseUrl, env.deviceId, watch.bearer)}`
        );
      }
      expect(status, `claiming ${env.deviceId} answered ${status}, expected 201`).toBe(201);
      claimed = true;
      log(`Claimed device ${env.deviceId}`);

      await expect(page, 'a successful claim did not open the devices page').toHaveURL(
        `${appOrigin}/`
      );
      await expect(row, `${env.deviceId} is not on the devices page after the claim`).toBeVisible();
      // Read now: Chromium may drop a response body once the page moves on.
      const devices = ((await watch.devices?.json()) as { devices: DeviceSummary[] }).devices;
      device = devices.find(d => d.id === env.deviceId);
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
      // A standing device keeps the last run's reading, so a connected panel
      // can open stale. Step 6 proves a fresh reading arrives.
      await expectLivePanelConnected(panel, APP_TIMEOUT_MS);
    });

    await test.step('6. a pushed reading reaches the screen', async () => {
      const unit = device?.configuration?.temperatureUnit;
      const grillF = distinctiveGrillF(Date.now());
      const expected = grillText(grillF, unit);
      log(`Sending 10 readings as ${env.deviceId} with grill ${grillF} °F`);

      const run = startSimDevice(env.simdeviceBin, env.simdevice, [
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

    await test.step('8. the devices page says when the device was last heard from', async () => {
      // HAR-143: a fresh GET /devices, which reads the device's IoT Hub twin.
      // The device synced its twin in step 4 and sent in step 6, so the hub
      // has heard from it: the row must say when, not "never heard from" (no
      // activity) or "Status unknown" (the twin could not be read).
      await openDevicesPage(page);
      const status = row.getByTestId('device-connection');
      await expect(
        status,
        `${env.deviceId}'s row did not say when it was last heard from within ${APP_TIMEOUT_S} s`
      ).toHaveText(LAST_HEARD_TEXT, { timeout: APP_TIMEOUT_MS });
      log(`The devices page says ${env.deviceId} is: ${(await status.textContent()) ?? ''}`);
    });

    await test.step('9. release the device', async () => {
      await releaseThroughUi(page, row, apiBaseUrl, env.deviceId);
      claimed = false;
      log(`Released device ${env.deviceId}`);
    });
  } finally {
    sim?.kill();
    if (cookId && !cookStopped) {
      await test.step('10. cleanup: stop the cook through the API', async () => {
        await stopThroughApi(apiBaseUrl, cookId as string, api?.bearer);
      });
    }
    if (claimed) {
      await test.step('10. cleanup: release the device through the API', async () => {
        await releaseThroughApi(apiBaseUrl, env.deviceId, api?.bearer);
      });
    }
  }
});

/** Back to the devices page through the nav. */
async function openDevicesPage(page: Page) {
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Devices' })
    .click();
  await expect(page).toHaveURL(`${env.webBaseUrl}/`);
}

/**
 * Release the device on the devices page, with its confirm step: DELETE
 * /devices/{id} must answer 204 and the row leave the list.
 */
async function releaseThroughUi(page: Page, row: Locator, apiBaseUrl: string, deviceId: string) {
  await row.getByRole('button', { name: 'Release' }).click();
  const confirm = page.getByRole('group', { name: /^Confirm release of / });
  const url = `${apiBaseUrl}/devices/${encodeURIComponent(deviceId)}`;
  const answered = page
    .waitForResponse(r => r.request().method() === 'DELETE' && r.url() === url, {
      timeout: APP_TIMEOUT_MS,
    })
    .catch(() => {
      throw new Error(
        `DELETE /devices/${deviceId} (releasing it) did not answer within ${APP_TIMEOUT_S} s`
      );
    });
  await confirm.getByRole('button', { name: 'Yes, release' }).click();
  const status = (await answered).status();
  expect(status, `releasing ${deviceId} answered ${status}, expected 204`).toBe(204);
  await expect(row, `${deviceId} is still on the devices page after the release`).toHaveCount(0);
}

/**
 * Why a claim was refused, for the failure message. Every refusal is the same
 * 403, so ask DELETE /devices/{id}, which tells another user's device (403
 * DEVICE_NOT_OWNED) from one nobody holds (404). The device is not this
 * user's (it was not on their page), so the DELETE changes nothing. Only the
 * status and error code are used.
 */
async function whyRefused(
  apiBaseUrl: string,
  deviceId: string,
  bearer: string | undefined
): Promise<string> {
  const unsure = 'the code may not match, or the device may belong to another user';
  if (!bearer) return unsure;
  try {
    const response = await fetch(`${apiBaseUrl}/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { authorization: bearer },
    });
    const body = (await response.json().catch(() => ({}))) as { error?: unknown };
    if (response.status === 403 && body.error === 'DEVICE_NOT_OWNED') {
      return (
        'it belongs to another user (DELETE /devices/{id} answers 403 DEVICE_NOT_OWNED). ' +
        'Release it as that user.'
      );
    }
    if (response.status === 404) {
      return 'nobody holds it (DELETE /devices/{id} answers 404), so the API refused the code itself';
    }
    return `${unsure} (DELETE /devices/{id} answered ${response.status})`;
  } catch (error) {
    return `${unsure} (DELETE /devices/{id} failed: ${(error as Error).name})`;
  }
}

/**
 * Release a device this run claimed and could not release on screen, with
 * the token the page itself sent. Only the status is logged. A device left
 * claimed is released by the next run's step 3 all the same.
 */
async function releaseThroughApi(apiBaseUrl: string, deviceId: string, bearer: string | undefined) {
  if (!apiBaseUrl || !bearer) {
    log(
      `Cleanup: device ${deviceId} may still be claimed; the page sent no token to release it with`
    );
    return;
  }
  try {
    const response = await fetch(`${apiBaseUrl}/devices/${encodeURIComponent(deviceId)}`, {
      method: 'DELETE',
      headers: { authorization: bearer },
    });
    log(`Cleanup: DELETE /devices/${deviceId} answered ${response.status}`);
  } catch (error) {
    log(`Cleanup: DELETE /devices/${deviceId} failed: ${(error as Error).name}`);
  }
}

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
