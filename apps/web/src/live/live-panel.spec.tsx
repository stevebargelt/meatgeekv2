import { act, render, screen, waitFor } from '@testing-library/react';
import { ApiProvider } from '../api/api-context';
import type { Cook, Device } from '../api/client';
import {
  BRISKET_BOX,
  OFFSET,
  apiPath,
  createFakeHubs,
  installFetch,
  jsonResponse,
  makeCook,
  makeTemperature,
  trackGets,
  type FakeHubs,
  type RecordedRequest,
} from '../test/fakes';
import { createTestClient, renderPages } from '../test/render';
import type { components } from '@meatgeekv2/api-specs/types';
import { HubFactoryProvider } from './hub-context';
import { LivePanel } from './live-panel';

type TemperatureReading = components['schemas']['TemperatureReading'];

const COOK = makeCook({ id: 'cook-1' });
const BACKFILL = '/temperatures/current/{deviceId}';

/** Every test runs on a fake clock that starts here; nowIso() reads it. */
const T0 = new Date('2026-11-20T15:00:00.000Z');

/** Stops Date at T0 and leaves the timers real: for tests that are not about time. */
function stopTheClock() {
  jest.useFakeTimers({
    now: T0,
    doNotFake: [
      'hrtime',
      'nextTick',
      'performance',
      'queueMicrotask',
      'requestAnimationFrame',
      'cancelAnimationFrame',
      'requestIdleCallback',
      'cancelIdleCallback',
      'setImmediate',
      'clearImmediate',
      'setInterval',
      'clearInterval',
      'setTimeout',
      'clearTimeout',
    ],
  });
}

/** Fakes Date and the timers from T0: for tests about time, which advance them. */
function fakeTimers() {
  jest.useFakeTimers({ now: T0 });
}
const COMPLETED: Cook = { ...COOK, status: 'completed', endTime: '2026-11-20T23:15:00.000Z' };

interface ServerState {
  cook: Cook;
  device: Device;
  /** Answers POST /negotiate; the default is 200 with a token numbered by call. */
  negotiate?: (call: number) => Response;
  /** Answers GET /temperatures/current/{deviceId}; the default is 404 (no reading yet). */
  current?: () => Response;
}

/** The fake API: the cook, the device, negotiate and the current reading. */
function fakeServer(server: ServerState) {
  let negotiations = 0;
  const fetch = installFetch((req: RecordedRequest) => {
    const path = apiPath(req);
    if (req.method === 'GET' && path === '/cooks/cook-1') return jsonResponse(200, server.cook);
    // The page's chart (src/cooks/cook-chart.spec.tsx tests it): not drawn here.
    if (req.method === 'GET' && path === '/cooks/cook-1/chart') {
      return jsonResponse(404, { error: 'NOT_FOUND', message: 'Cook not found' });
    }
    if (req.method === 'GET' && path === '/devices') {
      return jsonResponse(200, { devices: [server.device] });
    }
    if (req.method === 'GET' && path === `/devices/${server.device.id}`) {
      return jsonResponse(200, server.device);
    }
    if (req.method === 'POST' && path === '/negotiate') {
      negotiations += 1;
      return server.negotiate
        ? server.negotiate(negotiations)
        : jsonResponse(200, {
            url: 'https://mg.service.signalr.net/client/?hub=temperatureHub',
            accessToken: `tok-${negotiations}`,
          });
    }
    if (req.method === 'GET' && path === `/temperatures/current/${server.device.id}`) {
      return server.current
        ? server.current()
        : jsonResponse(404, { error: 'NO_READINGS', message: 'No reading', requestId: 'r-404' });
    }
    return jsonResponse(500, { error: 'INTERNAL_SERVER_ERROR', message: 'unexpected' });
  });
  const count = (method: string, path: string) =>
    fetch.requests.filter(r => r.method === method && apiPath(r) === path).length;
  return {
    ...fetch,
    negotiations: () => count('POST', '/negotiate'),
    backfills: () => count('GET', `/temperatures/current/${server.device.id}`),
    cookReads: () => count('GET', '/cooks/cook-1'),
  };
}

function panel(): HTMLElement {
  return screen.getByTestId('cook-live-panel');
}

function state(): string | null {
  return panel().getAttribute('data-state');
}

function badge(): string | null {
  return screen.getByTestId('live-badge').textContent;
}

function channel(name: string): string | null | undefined {
  return panel().querySelector(`[data-channel="${name}"] dd`)?.textContent;
}

function device(configuration?: Device['configuration']): Device {
  return { ...BRISKET_BOX, configuration };
}

/**
 * Renders /cooks/cook-1 and waits until its first hub connection has started.
 * `gets` holds the answer to each GET the page sent (see trackGets).
 */
async function openCook(server: ServerState, hubs: FakeHubs = createFakeHubs()) {
  const api = fakeServer(server);
  const { client, gets } = trackGets(createTestClient());
  const view = renderPages('/cooks/cook-1', { createHub: hubs.createHub, client });
  await waitFor(() => expect(hubs.hubs.length).toBeGreaterThan(0));
  await waitFor(() => expect(hubs.latest().start).toHaveBeenCalled());
  return { api, hubs, view, gets };
}

function push(hubs: FakeHubs, reading: Partial<TemperatureReading> = {}) {
  act(() => hubs.latest().emit('temperature', makeTemperature(reading)));
}

/** The fake clock's now, plus `offsetMs`, as an ISO timestamp. */
const nowIso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString();

describe('live cook panel', () => {
  beforeEach(stopTheClock);
  afterEach(() => jest.useRealTimers());

  it('shows waiting until the first reading, then live with the pushed values of the cook device only', async () => {
    const { api, hubs } = await openCook({ cook: COOK, device: device() });

    await waitFor(() => expect(state()).toBe('waiting'));
    expect(panel().textContent).toContain('Waiting for the first reading…');
    expect(panel().textContent).toContain('up to about 20 s');
    expect(channel('grill')).toBe('—');
    expect(screen.getByTestId('live-reading-time').textContent).toBe('No reading yet');
    // The connection was negotiated once and backfilled once (404: no reading yet).
    await waitFor(() => expect(api.backfills()).toBe(1));
    expect(api.negotiations()).toBe(1);
    expect(hubs.latest().info.accessToken).toBe('tok-1');

    push(hubs, { deviceId: OFFSET.id, timestamp: nowIso(), grillTemp: 999 });
    expect(state()).toBe('waiting');
    expect(channel('grill')).toBe('—');

    push(hubs, { timestamp: nowIso(), grillTemp: 225.04, probe1Temp: 150, probe3Temp: 98.6 });
    expect(state()).toBe('live');
    expect(badge()).toBe('Live');
    expect(channel('grill')).toBe('225 °F');
    expect(channel('probe1')).toBe('150 °F');
    expect(channel('probe2')).toBe('—');
    expect(channel('probe3')).toBe('98.6 °F');
    expect(channel('probe4')).toBe('—');
    expect(panel().textContent).not.toContain('Waiting for the first reading');

    push(hubs, { timestamp: nowIso(), grillTemp: 231 });
    expect(channel('grill')).toBe('231 °F');
    expect(channel('probe1')).toBe('150 °F');
  });

  it("shows readings in a celsius device's unit", async () => {
    const { hubs } = await openCook({
      cook: COOK,
      device: device({ temperatureUnit: 'celsius' }),
    });
    await waitFor(() => expect(state()).toBe('waiting'));
    // The device answer can land after the hub starts; wait for the unit.
    push(hubs, { timestamp: nowIso(), grillTemp: 212, probe1Temp: 32 });
    await waitFor(() => expect(channel('grill')).toBe('100 °C'));
    expect(channel('probe1')).toBe('0 °C');
  });

  it('shows the reading time and its age, updated every second', async () => {
    fakeTimers();
    const { hubs } = await openCook({ cook: COOK, device: device({ pollingInterval: 10 }) });
    await waitFor(() => expect(state()).toBe('waiting'));

    const readingAt = nowIso(-12_000);
    push(hubs, { timestamp: readingAt });
    act(() => jest.advanceTimersByTime(1000));
    const time = screen.getByTestId('live-reading-time').textContent ?? '';
    expect(time).toContain(new Date(readingAt).toLocaleString());
    expect(time).toMatch(/\(1[34] s ago\)$/);
    const before = time;
    act(() => jest.advanceTimersByTime(1000));
    expect(screen.getByTestId('live-reading-time').textContent).not.toBe(before);
  });

  it('goes stale once the reading is older than 3 × the device pollingInterval', async () => {
    fakeTimers();
    const { hubs, gets } = await openCook({
      cook: COOK,
      device: device({ pollingInterval: 10 }),
    });
    await waitFor(() => expect(state()).toBe('waiting'));
    // Wait until the panel has applied GET /devices/{id}, so the 10 s interval is in effect.
    await waitFor(() => expect(gets('/devices/{id}')).not.toHaveLength(0));
    await act(async () => {
      await Promise.all(gets('/devices/{id}'));
    });

    push(hubs, { timestamp: nowIso() });
    expect(state()).toBe('live');

    act(() => jest.advanceTimersByTime(29_000));
    expect(state()).toBe('live');
    act(() => jest.advanceTimersByTime(2_000));
    expect(state()).toBe('stale');
    expect(badge()).toMatch(/^No reading for 3[01] s$/);

    // A new reading makes it live again.
    push(hubs, { timestamp: nowIso() });
    expect(state()).toBe('live');
  });

  it('uses a 30 s polling interval (90 s stale threshold) when the device sets none', async () => {
    fakeTimers();
    const { hubs } = await openCook({ cook: COOK, device: device() });
    await waitFor(() => expect(state()).toBe('waiting'));

    push(hubs, { timestamp: nowIso() });
    act(() => jest.advanceTimersByTime(89_000));
    expect(state()).toBe('live');
    act(() => jest.advanceTimersByTime(2_000));
    expect(state()).toBe('stale');
    act(() => jest.advanceTimersByTime(9_000));
    expect(badge()).toMatch(/^No reading for 1 min (39|40) s$/);
  });

  it('is stale with "Reconnecting…" during an automatic reconnect, then live again after a backfill', async () => {
    const reading = { timestamp: nowIso(), grillTemp: 225 };
    let current: TemperatureReading | undefined;
    const { api, hubs } = await openCook({
      cook: COOK,
      device: device(),
      current: () =>
        current ? jsonResponse(200, current) : jsonResponse(404, { error: 'NO_READINGS' }),
    });
    await waitFor(() => expect(api.backfills()).toBe(1));
    push(hubs, reading);
    expect(state()).toBe('live');

    act(() => hubs.latest().reconnecting());
    expect(state()).toBe('stale');
    expect(badge()).toBe('Reconnecting…');
    expect(channel('grill')).toBe('225 °F');

    current = { deviceId: BRISKET_BOX.id, timestamp: nowIso(1), grillTemp: 240 };
    act(() => hubs.latest().reconnected());
    await waitFor(() => expect(channel('grill')).toBe('240 °F'));
    expect(api.backfills()).toBe(2);
    expect(state()).toBe('live');
    expect(api.negotiations()).toBe(1);
  });

  it('shows the backfilled reading on connect, and an older backfill never replaces a newer push', async () => {
    let current: TemperatureReading = {
      deviceId: BRISKET_BOX.id,
      timestamp: nowIso(),
      grillTemp: 210,
      probe2Temp: 120,
    };
    const { api, hubs, gets } = await openCook({
      cook: COOK,
      device: device(),
      current: () => jsonResponse(200, current),
    });
    await waitFor(() => expect(channel('grill')).toBe('210 °F'));
    expect(channel('probe2')).toBe('120 °F');
    expect(state()).toBe('live');

    push(hubs, { timestamp: nowIso(5_000), grillTemp: 215 });
    current = { ...current, grillTemp: 1 };
    act(() => hubs.latest().reconnected());
    // The reconnect sent the second backfill. Wait until the panel has applied its answer.
    expect(gets(BACKFILL)).toHaveLength(2);
    let answer: unknown;
    await act(async () => {
      answer = await gets(BACKFILL)[1];
    });
    expect(answer).toMatchObject({ data: { grillTemp: 1 } });
    expect(api.backfills()).toBe(2);
    expect(channel('grill')).toBe('215 °F');
  });

  it('after a close negotiates again and starts a new connection', async () => {
    fakeTimers();
    const { api, hubs } = await openCook({ cook: COOK, device: device() });
    await waitFor(() => expect(state()).toBe('waiting'));
    const first = hubs.latest();

    act(() => first.close());
    expect(state()).toBe('stale');
    expect(badge()).toBe('Reconnecting…');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(hubs.hubs).toHaveLength(2));
    expect(api.negotiations()).toBe(2);
    expect(hubs.latest().info.accessToken).toBe('tok-2');
    await waitFor(() => expect(hubs.latest().start).toHaveBeenCalled());
    await waitFor(() => expect(state()).toBe('waiting'));
    await waitFor(() => expect(api.backfills()).toBe(2));
  });

  it('retries a 503 or 429 from negotiate, and connects when it succeeds', async () => {
    fakeTimers();
    const hubs = createFakeHubs();
    const api = fakeServer({
      cook: COOK,
      device: device(),
      negotiate: call =>
        call === 1
          ? jsonResponse(503, { error: 'SIGNALR_UNAVAILABLE', message: 'down' })
          : call === 2
            ? jsonResponse(429, { error: 'TOO_MANY_REQUESTS', message: 'slow down' })
            : jsonResponse(200, {
                url: 'https://mg.service.signalr.net/client/',
                accessToken: 't',
              }),
    });
    renderPages('/cooks/cook-1', { createHub: hubs.createHub });
    await waitFor(() => expect(api.negotiations()).toBe(1));
    await waitFor(() => expect(badge()).toBe('Reconnecting…'));
    expect(state()).toBe('stale');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(2_000);
    });
    await waitFor(() => expect(api.negotiations()).toBe(2));
    await act(async () => {
      await jest.advanceTimersByTimeAsync(5_000);
    });
    await waitFor(() => expect(api.negotiations()).toBe(3));
    await waitFor(() => expect(state()).toBe('waiting'));
    expect(hubs.hubs).toHaveLength(1);
  });

  it('shows "Sign in again" on a 401 from negotiate and stops retrying', async () => {
    fakeTimers();
    const hubs = createFakeHubs();
    const api = fakeServer({
      cook: COOK,
      device: device(),
      negotiate: () => jsonResponse(401, { error: 'UNAUTHENTICATED', reason: 'NO_PRINCIPAL' }),
    });
    renderPages('/cooks/cook-1', { createHub: hubs.createHub });
    await waitFor(() => expect(badge()).toBe('Sign in again'));
    expect(state()).toBe('stale');
    expect(panel().textContent).toContain('Sign out and sign in again');

    await act(async () => {
      await jest.advanceTimersByTimeAsync(120_000);
    });
    expect(api.negotiations()).toBe(1);
    expect(hubs.hubs).toHaveLength(0);
  });

  it('on cook_stopped for this cook stops the connection, re-reads the cook and removes the panel', async () => {
    const server: ServerState = { cook: COOK, device: device() };
    const { api, hubs } = await openCook(server);
    await waitFor(() => expect(state()).toBe('waiting'));
    const hub = hubs.latest();
    expect(api.cookReads()).toBe(1);

    const envelope = {
      type: 'cook_stopped' as const,
      timestamp: nowIso(),
      messageId: '6c0f8a43-8d9b-4f4f-9d3e-2b1d7a1f0c11',
      deviceId: BRISKET_BOX.id,
      userId: COOK.userId,
      correlation: { id: 'req-1' },
    };
    // Another cook's stop is ignored, as is cook_started.
    act(() => hub.emit('cook_stopped', { ...envelope, payload: { ...COMPLETED, id: 'cook-2' } }));
    act(() =>
      hub.emit('cook_started', {
        ...envelope,
        type: 'cook_started',
        cookId: 'cook-3',
        payload: { ...COOK, id: 'cook-3' },
      })
    );
    expect(hub.stop).not.toHaveBeenCalled();
    expect(api.cookReads()).toBe(1);

    server.cook = COMPLETED;
    act(() => hub.emit('cook_stopped', { ...envelope, payload: COMPLETED }));
    expect(hub.stop).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('cook-live-panel')).toBeNull());
    expect(api.cookReads()).toBe(2);
    const status = screen.getByText('Status', { selector: 'dt' }).nextElementSibling;
    expect(status?.textContent).toBe('completed');
    expect(screen.queryByRole('button', { name: 'Stop cook' })).toBeNull();
  });

  it('passes each temperature message it accepts to onReading, and no other', async () => {
    fakeServer({ cook: COOK, device: device() });
    const hubs = createFakeHubs();
    const onReading = jest.fn();
    render(
      <ApiProvider client={createTestClient()}>
        <HubFactoryProvider createHub={hubs.createHub}>
          <LivePanel cook={COOK} onCookStopped={jest.fn()} onReading={onReading} />
        </HubFactoryProvider>
      </ApiProvider>
    );
    await waitFor(() => expect(hubs.latest().start).toHaveBeenCalled());
    await waitFor(() => expect(state()).toBe('waiting'));

    push(hubs, { deviceId: OFFSET.id, timestamp: nowIso(), grillTemp: 999 });
    expect(onReading).not.toHaveBeenCalled();

    const first = makeTemperature({ timestamp: nowIso(), grillTemp: 226 });
    const second = makeTemperature({ timestamp: nowIso(1000), grillTemp: 227 });
    act(() => hubs.latest().emit('temperature', first));
    act(() => hubs.latest().emit('temperature', second));
    expect(onReading.mock.calls).toEqual([[first], [second]]);
    // The backfill (GET /temperatures/current) is not a pushed message.
    expect(channel('grill')).toBe('227 °F');
  });

  it('unmount stops the connection and leaves no timers running', async () => {
    fakeTimers();
    const { hubs, view } = await openCook({ cook: COOK, device: device() });
    await waitFor(() => expect(state()).toBe('waiting'));
    const hub = hubs.latest();

    view.unmount();
    expect(hub.stop).toHaveBeenCalledTimes(1);
    expect(jest.getTimerCount()).toBe(0);
  });

  it('unmount while waiting to negotiate again cancels the retry', async () => {
    fakeTimers();
    const { api, hubs, view } = await openCook({ cook: COOK, device: device() });
    await waitFor(() => expect(state()).toBe('waiting'));
    act(() => hubs.latest().close());
    expect(badge()).toBe('Reconnecting…');

    view.unmount();
    expect(jest.getTimerCount()).toBe(0);
    await act(async () => {
      await jest.advanceTimersByTimeAsync(60_000);
    });
    expect(api.negotiations()).toBe(1);
  });
});
