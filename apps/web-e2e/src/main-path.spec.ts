import { expect, test, type Page } from '@playwright/test';
import { CHART_BUCKETS, FakeApi, type Device } from './fakes/api';
import { FakeEntra } from './fakes/entra';
import { FakeSignalRHub } from './fakes/signalr-hub';
import { TEST_CONFIG, TEST_USER } from './fakes/test-config';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const DEVICE: Device = {
  id: 'e2e-smoker-1',
  userId: `${TEST_CONFIG.tenantId}:${TEST_USER.oid}`,
  name: 'Backyard Smoker',
  model: 'MeatGeek V1',
  location: 'Patio',
  isActive: true,
  connectionStatus: 'online',
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

test('sign in, start a cook, see a pushed reading and the chart, stop the cook', async ({
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
  });

  await blockTheInternet(page, appOrigin, escaped);
  await page.route(`${appOrigin}/config.json`, route => route.fulfill({ json: TEST_CONFIG }));
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

  // Devices: the fake device, and a cook started on it.
  const row = page.getByRole('row').filter({ hasText: DEVICE.name });
  await expect(row).toContainText(DEVICE.id);
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
  await expect(page.getByRole('heading', { name: 'HAR-98 deliberate failure' })).toBeVisible();

  // Live panel: connected, no reading yet.
  const panel = page.getByTestId('cook-live-panel');
  await expect(panel).toHaveAttribute('data-state', 'waiting');
  expect(hub.connectedCount).toBe(1);

  // One pushed `temperature` message makes it live.
  hub.push('temperature', {
    deviceId: DEVICE.id,
    cookId,
    timestamp: new Date().toISOString(),
    enqueuedTimeUtc: new Date().toISOString(),
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

  // What the fake API received.
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
