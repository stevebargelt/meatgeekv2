import { expect, test, type Page } from '@playwright/test';
import { expectLivePanelConnected } from '../live/live-panel';
import { FakeApi, type Device, type FakeApiOptions } from './fakes/api';
import { freezeClock, frozenIso } from './fakes/clock';
import { FakeEntra } from './fakes/entra';
import { FakeSignalRHub } from './fakes/signalr-hub';
import { TEST_CONFIG, TEST_USER } from './fakes/test-config';

/**
 * The live proof's step 5 (live/live-panel.ts) against the built app. HAR-101:
 * on a standing device the panel backfills the last run's reading and opens
 * stale while connected; the check must pass that and still fail when the
 * panel is not connected.
 *
 * HAR-121: the page's clock is frozen (fakes/clock.ts), so the seeded reading
 * is exactly 24 min old however long the run takes, and neither check has a
 * deadline of its own.
 */

const DEVICE: Device = {
  id: 'e2e-smoker-web',
  userId: `${TEST_CONFIG.tenantId}:${TEST_USER.oid}`,
  name: 'Standing Smoker',
  model: 'MeatGeek V1',
  location: 'Patio',
  isActive: true,
  configuration: { temperatureUnit: 'fahrenheit', pollingInterval: 30 },
};

/** Sign in, start a cook on DEVICE and open its page. */
async function openCookPage(
  page: Page,
  baseURL: string | undefined,
  options: Partial<FakeApiOptions>
): Promise<FakeSignalRHub> {
  const appOrigin = new URL(baseURL as string).origin;
  const hub = new FakeSignalRHub();
  const api = new FakeApi({
    apiBaseUrl: TEST_CONFIG.apiBaseUrl,
    device: DEVICE,
    negotiate: hub.connectionInfo,
    ...options,
  });
  await page.route('**/*', route =>
    new URL(route.request().url()).origin === appOrigin
      ? route.continue()
      : route.abort('blockedbyclient')
  );
  await page.route(`${appOrigin}/config.json`, route => route.fulfill({ json: TEST_CONFIG }));
  await freezeClock(page);
  await new FakeEntra(TEST_CONFIG, TEST_USER).install(page);
  await api.install(page);
  await hub.install(page);

  await page.goto('/');
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('banner')).toContainText(TEST_USER.name);
  const row = page.getByRole('row').filter({ hasText: DEVICE.name });
  await row.getByRole('button', { name: 'Start cook' }).click();
  const form = page.getByRole('form', { name: `Start a cook on ${DEVICE.name}` });
  await form.getByLabel('Name', { exact: true }).fill('acceptance web');
  await form.getByLabel('Meat type').fill('Brisket');
  await form.getByRole('button', { name: 'Start', exact: true }).click();
  await expect(page).toHaveURL(/\/cooks\/[^/]+$/);
  return hub;
}

test('passes a connected panel whose backfilled reading is an old one', async ({
  page,
  baseURL,
}) => {
  const old = frozenIso(-24 * 60_000);
  const hub = await openCookPage(page, baseURL, {
    currentReading: { deviceId: DEVICE.id, timestamp: old, grillTemp: 312.3 },
  });
  const panel = page.getByTestId('cook-live-panel');

  // What run 44833909340 saw: connected, but stale with the last run's reading.
  await expect(panel).toHaveAttribute('data-state', 'stale');
  await expect(panel.getByTestId('live-badge')).toHaveText('No reading for 24 min 0 s');
  await expectLivePanelConnected(panel);
  expect(hub.connectedCount).toBe(1);
});

test('fails a panel that cannot connect ("Sign in again")', async ({ page, baseURL }) => {
  await openCookPage(page, baseURL, { negotiateError: 401 });
  const panel = page.getByTestId('cook-live-panel');

  await expect(panel.getByTestId('live-badge')).toHaveText('Sign in again');
  // Rejects on what the panel shows, not after a wait: "Sign in again" is final.
  await expect(expectLivePanelConnected(panel)).rejects.toThrow(
    'the live panel is not connected, and has stopped trying: ' +
      'not connected (data-state stale, badge "Sign in again")'
  );
});
