import { createFakeHubs, makeTemperature, type FakeHub, type FakeHubs } from '../test/fakes';
import { openLiveConnection, type ConnectionStatus, type NegotiateResult } from './live-connection';

function info(n: number) {
  return {
    url: 'https://mg.service.signalr.net/client/?hub=temperatureHub',
    accessToken: `tok-${n}`,
  };
}

/** Opens a connection whose negotiate answers from `answers` in turn (then 200s). */
function open(answers: NegotiateResult[] = []) {
  const fakes: FakeHubs = createFakeHubs();
  const statuses: ConnectionStatus[] = [];
  let calls = 0;
  const negotiate = jest.fn(async (): Promise<NegotiateResult> => {
    calls += 1;
    return answers.shift() ?? { ok: true, info: info(calls) };
  });
  const onConnected = jest.fn();
  const onTemperature = jest.fn();
  const onCookStopped = jest.fn();
  const stop = openLiveConnection({
    negotiate,
    createHub: fakes.createHub,
    onStatus: status => statuses.push(status),
    onConnected,
    onTemperature,
    onCookStopped,
  });
  return { fakes, statuses, negotiate, onConnected, onTemperature, onCookStopped, stop };
}

/** Runs due timers and settles the promises they start. */
async function advance(ms: number) {
  await jest.advanceTimersByTimeAsync(ms);
}

const last = <T>(list: T[]) => list[list.length - 1];

describe('openLiveConnection', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('negotiates, builds the hub from the negotiate answer, starts it, then reports connected', async () => {
    const c = open();
    expect(c.statuses).toEqual(['connecting']);
    await advance(0);

    expect(c.negotiate).toHaveBeenCalledTimes(1);
    expect(c.fakes.hubs).toHaveLength(1);
    expect(c.fakes.latest().info).toEqual(info(1));
    expect(c.fakes.latest().start).toHaveBeenCalledTimes(1);
    expect(c.statuses).toEqual(['connecting', 'connected']);
    expect(c.onConnected).toHaveBeenCalledTimes(1);

    const reading = makeTemperature();
    c.fakes.latest().emit('temperature', reading);
    expect(c.onTemperature).toHaveBeenCalledWith(reading);
    c.stop();
  });

  it('reports an automatic reconnect, and calls onConnected again after it', async () => {
    const c = open();
    await advance(0);
    const hub = c.fakes.latest();

    hub.reconnecting();
    expect(last(c.statuses)).toBe('reconnecting');
    hub.reconnected();
    expect(last(c.statuses)).toBe('connected');
    expect(c.onConnected).toHaveBeenCalledTimes(2);
    expect(c.negotiate).toHaveBeenCalledTimes(1);
    c.stop();
  });

  it('after a close, negotiates again 2 s later and starts a new connection with the new token', async () => {
    const c = open();
    await advance(0);
    c.fakes.latest().close();
    expect(last(c.statuses)).toBe('reconnecting');

    await advance(1_999);
    expect(c.negotiate).toHaveBeenCalledTimes(1);
    await advance(1);
    expect(c.negotiate).toHaveBeenCalledTimes(2);
    expect(c.fakes.hubs).toHaveLength(2);
    expect(c.fakes.latest().info.accessToken).toBe('tok-2');
    expect(c.fakes.latest().start).toHaveBeenCalledTimes(1);
    expect(last(c.statuses)).toBe('connected');
    expect(c.onConnected).toHaveBeenCalledTimes(2);
    c.stop();
  });

  it('retries a failing negotiate (429, 503, network) after 2, 5, 10, then every 30 s', async () => {
    const c = open([
      { ok: false, status: 503 },
      { ok: false, status: 429 },
      { ok: false, status: 503 },
      { ok: false },
      { ok: false, status: 500 },
      { ok: false, status: 503 },
    ]);
    await advance(0);
    expect(c.negotiate).toHaveBeenCalledTimes(1);
    expect(last(c.statuses)).toBe('reconnecting');

    for (const [delay, callsAfter] of [
      [2_000, 2],
      [5_000, 3],
      [10_000, 4],
      [30_000, 5],
      [30_000, 6],
      [30_000, 7],
    ] as const) {
      await advance(delay - 1);
      expect(c.negotiate).toHaveBeenCalledTimes(callsAfter - 1);
      await advance(1);
      expect(c.negotiate).toHaveBeenCalledTimes(callsAfter);
    }
    expect(c.fakes.hubs).toHaveLength(1);
    expect(last(c.statuses)).toBe('connected');
    c.stop();
  });

  it('starts the backoff over after a successful connection', async () => {
    const c = open([
      { ok: false, status: 503 },
      { ok: false, status: 503 },
    ]);
    await advance(0);
    await advance(2_000);
    await advance(5_000);
    expect(last(c.statuses)).toBe('connected');

    c.fakes.latest().close();
    await advance(2_000);
    expect(c.negotiate).toHaveBeenCalledTimes(4);
    c.stop();
  });

  it('a hub that fails to start is retried like a close', async () => {
    const c = open();
    const createHub = c.fakes.createHub as jest.Mock;
    const realCreate = createHub.getMockImplementation() as (i: unknown) => FakeHub;
    createHub.mockImplementationOnce(i => {
      const hub = realCreate(i);
      hub.failStart = true;
      return hub;
    });
    await advance(0);
    expect(c.fakes.hubs).toHaveLength(1);
    expect(last(c.statuses)).toBe('reconnecting');

    await advance(2_000);
    expect(c.fakes.hubs).toHaveLength(2);
    expect(last(c.statuses)).toBe('connected');
    c.stop();
  });

  it('a 401 from negotiate reports signed-out and stops retrying', async () => {
    const c = open([{ ok: false, status: 401 }]);
    await advance(0);
    expect(last(c.statuses)).toBe('signed-out');
    expect(jest.getTimerCount()).toBe(0);
    await advance(120_000);
    expect(c.negotiate).toHaveBeenCalledTimes(1);
    expect(c.fakes.hubs).toHaveLength(0);
  });

  it('a 401 when negotiating again after a close also stops', async () => {
    const c = open();
    await advance(0);
    c.fakes.latest().close();
    // The next negotiate (after 2 s) answers 401.
    (c.negotiate as jest.Mock).mockResolvedValueOnce({ ok: false, status: 401 });
    await advance(2_000);
    expect(last(c.statuses)).toBe('signed-out');
    await advance(120_000);
    expect(c.negotiate).toHaveBeenCalledTimes(2);
  });

  it('stop() stops the hub, clears a pending retry, and ignores later callbacks', async () => {
    const c = open();
    await advance(0);
    const hub = c.fakes.latest();
    c.stop();
    expect(hub.stop).toHaveBeenCalledTimes(1);

    hub.emit('temperature', makeTemperature());
    hub.close();
    expect(c.onTemperature).not.toHaveBeenCalled();
    expect(jest.getTimerCount()).toBe(0);

    const d = open([{ ok: false, status: 503 }]);
    await advance(0);
    expect(jest.getTimerCount()).toBe(1);
    d.stop();
    expect(jest.getTimerCount()).toBe(0);
    await advance(60_000);
    expect(d.negotiate).toHaveBeenCalledTimes(1);
  });

  it('stop() during negotiate never builds a hub', async () => {
    const c = open();
    c.stop();
    await advance(0);
    expect(c.negotiate).toHaveBeenCalledTimes(1);
    expect(c.fakes.hubs).toHaveLength(0);
  });

  it('ignores a replaced connection', async () => {
    const c = open();
    await advance(0);
    const first = c.fakes.latest();
    first.close();
    await advance(2_000);

    first.emit('temperature', makeTemperature());
    first.reconnecting();
    expect(c.onTemperature).not.toHaveBeenCalled();
    expect(last(c.statuses)).toBe('connected');
    c.stop();
  });
});
