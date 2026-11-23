import { expect, test, type Page } from '@playwright/test';
import { CHART_BUCKETS, FakeApi, type Device } from './fakes/api';
import { freezeClock, frozenIso } from './fakes/clock';
import { FakeEntra } from './fakes/entra';
import { FakeSignalRHub } from './fakes/signalr-hub';
import { TEST_CONFIG, TEST_USER } from './fakes/test-config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DEVICE: Device = {
  id: 'e2e-smoker-1',
  userId: `${TEST_CONFIG.tenantId}:${TEST_USER.oid}`,
  name: 'Backyard Smoker',
  model: 'MeatGeek',
  location: 'Patio',
  isActive: true,
  // HAR-143: the fake API lists it as the real one does, with the connection
  // it read from IoT Hub: connected, heard from 12 s before the frozen now.
  connection: { state: 'connected', lastActivityAt: frozenIso(-12_000) },
  configuration: { temperatureUnit: 'fahrenheit', pollingInterval: 30 },
};

/**
 * Every request leaves the browser through a fake. This route is registered
 * first, so it only sees what no fake claimed (Playwright tries the newest
 * route first): the app's own origin goes to `vite preview`; anything else is
 * aborted and recorded.
 */
async function blockTheInternet(page: Page, appOrigin: string, escaped: string[]) {
  await page.route('**/*', route => {
    const url = route.request().url();
    if (new URL(url).origin === appOrigin) return route.continue();
    escaped.push(`${route.request().method()} ${url}`);
    return route.abort('blockedbyclient');
  });
}

/** The code the fake device shows; the spec's example, not a real device's. */
const CLAIM_CODE = '7K3M-9QXR-2HTV';

test('sign in, claim the device, start a cook, see a pushed reading and the chart, stop the cook, release the device', async ({
  page,
  baseURL,
}) => {
  const appOrigin = new URL(baseURL as string).origin;
  const escaped: string[] = [];
  const entra = new FakeEntra(TEST_CONFIG, TEST_USER);
  const hub = new FakeSignalRHub();
  const api = new FakeApi({
    apiBaseUrl: TEST_CONFIG.apiBaseUrl,
    device: DEVICE,
    negotiate: hub.connectionInfo,
    claimCode: CLAIM_CODE,
  });

  await blockTheInternet(page, appOrigin, escaped);
  await page.route(`${appOrigin}/config.json`, route => route.fulfill({ json: TEST_CONFIG }));
  // HAR-121: the browser and the fakes share one frozen instant, so the pushed
  // reading is 0 s old (live, never stale) however long the run takes.
  await freezeClock(page);
  await entra.install(page);
  await api.install(page);
  await hub.install(page);

  // Sign in: the real loginRedirect, authorize redirect and PKCE code exchange.
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Sign in to MeatGeek' })).toBeVisible();
  await page.getByRole('button', { name: 'Sign in' }).click();
  await expect(page.getByRole('banner')).toContainText(TEST_USER.name);
  expect(entra.authorizeRequests).toHaveLength(1);
  expect(entra.tokenRequests.map(body => body.get('grant_type'))).toEqual(['authorization_code']);

  // Claim: no device yet. The onboarding link carries the id, never the code.
  await expect(page.getByText(/You have no devices yet/)).toBeVisible();
  await page.getByRole('link', { name: 'Claim a device' }).click();
  await expect(page).toHaveURL(/\/devices\/claim$/);
  await page.goto(`/devices/claim?deviceId=${encodeURIComponent(DEVICE.id)}`);
  const claim = page.getByRole('form', { name: 'Claim a device' });
  await expect(claim.getByLabel('Device ID')).toHaveValue(DEVICE.id);
  // A wrong code first: refused, the form stays.
  await claim.getByLabel('Claim code').fill('0000-0000-0000');
  await claim.getByLabel('Name', { exact: true }).fill(DEVICE.name);
  await claim.getByRole('button', { name: 'Claim device' }).click();
  await expect(claim.getByRole('alert')).toContainText("That code doesn't match this device");
  // Typed lower case with spaces, shown as the device shows it.
  await claim.getByLabel('Claim code').fill('');
  await claim.getByLabel('Claim code').pressSequentially('7k3m 9qxr 2htv');
  await expect(claim.getByLabel('Claim code')).toHaveValue(CLAIM_CODE);
  await claim.getByRole('button', { name: 'Claim device' }).click();

  // Devices: the claimed device, and a cook started on it.
  await expect(page).toHaveURL(/\/$/);
  const row = page.getByRole('row').filter({ hasText: DEVICE.name });
  await expect(row).toContainText(DEVICE.id);
  await expect(row.getByTestId('device-connection')).toHaveText('Connected · last heard 12 s ago');
  await row.getByRole('button', { name: 'Start cook' }).click();
  const form = page.getByRole('form', { name: `Start a cook on ${DEVICE.name}` });
  await form.getByLabel('Name', { exact: true }).fill('Saturday brisket');
  await form.getByLabel('Meat type').fill('Brisket');
  await form.getByLabel('Weight (lb)').fill('14.5');
  await form.getByLabel('Grill target (°F)').fill('225');
  await form.getByRole('button', { name: 'Start', exact: true }).click();

  await expect(page).toHaveURL(/\/cooks\/[^/]+$/);
  const cookId = decodeURIComponent(new URL(page.url()).pathname.split('/').pop() as string);
  expect(cookId).toMatch(UUID);
  await expect(page.getByRole('heading', { name: 'Saturday brisket' })).toBeVisible();

  // Live panel: connected, no reading yet.
  const panel = page.getByTestId('cook-live-panel');
  await expect(panel).toHaveAttribute('data-state', 'waiting');
  expect(hub.connectedCount).toBe(1);

  // One pushed `temperature` message makes it live.
  hub.push('temperature', {
    deviceId: DEVICE.id,
    cookId,
    timestamp: frozenIso(),
    enqueuedTimeUtc: frozenIso(),
    grillTemp: 231.4,
    probe1Temp: 141.2,
  });
  await expect(panel).toHaveAttribute('data-state', 'live');
  await expect(panel.locator('[data-channel="grill"] dd')).toHaveText('231.4 °F');
  await expect(panel.locator('[data-channel="probe1"] dd')).toHaveText('141.2 °F');

  // Chart: the fake's buckets, then the pushed reading after them.
  const chart = page.getByTestId('cook-chart');
  await expect(chart).toHaveAttribute('data-state', 'loaded');
  await expect(chart.locator('.chart-frame')).toHaveAttribute(
    'data-rows',
    String(CHART_BUCKETS + 1)
  );
  await expect(chart.locator('.recharts-wrapper > svg.recharts-surface')).toBeVisible();
  // One line per channel; the grill line's path has a vertex per row (M, then an L each).
  const vertices = new RegExp(`^M[^ML]+(L[^ML]+){${CHART_BUCKETS}}$`);
  await expect(chart.locator('.chart-line-grill path.recharts-line-curve')).toHaveAttribute(
    'd',
    vertices
  );
  await expect(chart.locator('.chart-line-probe1 path.recharts-line-curve')).toHaveCount(1);

  // Stop, with the confirm step.
  await page.getByRole('button', { name: 'Stop cook' }).click();
  await page
    .getByRole('group', { name: 'Confirm stop' })
    .getByRole('button', { name: 'Yes, stop cook' })
    .click();
  await expect(page.locator('dt:text-is("Status") + dd')).toHaveText('completed');
  await expect(panel).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop cook' })).toHaveCount(0);

  // Release, with the confirm step: the device leaves the list.
  await page
    .getByRole('navigation', { name: 'Main' })
    .getByRole('link', { name: 'Devices' })
    .click();
  await row.getByRole('button', { name: 'Release' }).click();
  const confirmRelease = page.getByRole('group', { name: `Confirm release of ${DEVICE.name}` });
  await expect(confirmRelease).toContainText("You'll need a new code from the device");
  await confirmRelease.getByRole('button', { name: 'Yes, release' }).click();
  await expect(row).toHaveCount(0);
  await expect(page.getByText(/You have no devices yet/)).toBeVisible();

  // What the fake API received.
  expect(api.calls('POST', '/devices/claim').map(r => r.body)).toEqual([
    { deviceId: DEVICE.id, claimCode: '0000-0000-0000', name: DEVICE.name },
    { deviceId: DEVICE.id, claimCode: CLAIM_CODE, name: DEVICE.name },
  ]);
  expect(api.calls('DELETE', `/devices/${DEVICE.id}`)).toHaveLength(1);
  expect(api.claimed).toBe(false);
  expect(api.calls('POST', `/cooks/${cookId}/stop`)).toHaveLength(1);
  const starts = api.calls('POST', '/cooks');
  expect(starts).toHaveLength(1);
  expect(starts[0].body).toEqual({
    id: cookId,
    deviceId: DEVICE.id,
    name: 'Saturday brisket',
    meatType: 'Brisket',
    weight: 14.5,
    targetTemps: { grill: 225 },
  });
  expect(api.requests.filter(r => r.authorization !== `Bearer ${entra.accessToken}`)).toEqual([]);
  expect(api.unexpected).toEqual([]);
  expect(entra.unexpected).toEqual([]);
  expect(hub.unexpected).toEqual([]);
  expect(escaped).toEqual([]);
});
