import type { InvocationContext } from '@azure/functions';

import { FakeTwinHub } from '../../shared/iothub/fake-device-twin.testing';
import {
  DEVICE_SILENCE_MARKER,
  DEVICE_SILENCE_SCHEDULE,
  SILENT_AFTER_MS,
  checkDeviceSilence,
  deviceSilenceHandler,
  formatDeviceSilence,
  isSilent,
  type DeviceSilenceDeps,
} from './device-silence';

const NOW = new Date('2026-11-28T12:00:00.000Z');
const minutesAgo = (minutes: number) => new Date(NOW.getTime() - minutes * 60_000).toISOString();

function deps(hub: FakeTwinHub, deviceIds: string[]): DeviceSilenceDeps {
  return {
    listActiveCookDevices: async () => deviceIds,
    getTwins: () => hub,
    now: () => NOW,
  };
}

function fakeContext(): InvocationContext & { lines: string[]; errors: string[] } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    invocationId: 'inv-1',
    log: (message: string) => lines.push(message),
    error: (message: string) => errors.push(message),
  } as unknown as InvocationContext & { lines: string[]; errors: string[] };
}

describe('isSilent', () => {
  it('is silent when disconnected and last heard from at least SILENT_AFTER_MS ago', () => {
    expect(SILENT_AFTER_MS).toBe(10 * 60_000);
    expect(isSilent({ state: 'disconnected', lastActivityAt: minutesAgo(10) }, NOW)).toBe(true);
    expect(isSilent({ state: 'disconnected', lastActivityAt: minutesAgo(45) }, NOW)).toBe(true);
  });

  it('is silent when disconnected and never heard from', () => {
    expect(isSilent({ state: 'disconnected', lastActivityAt: null }, NOW)).toBe(true);
  });

  it('is not silent for a short drop (a network blip the device reconnects from)', () => {
    expect(isSilent({ state: 'disconnected', lastActivityAt: minutesAgo(9) }, NOW)).toBe(false);
  });

  it('is never silent while connected, however stale lastActivityAt is (it lags by minutes)', () => {
    expect(isSilent({ state: 'connected', lastActivityAt: minutesAgo(60) }, NOW)).toBe(false);
    expect(isSilent({ state: 'connected', lastActivityAt: null }, NOW)).toBe(false);
  });

  it('is not silent when the twin could not be read', () => {
    expect(isSilent({ state: 'unknown', lastActivityAt: null }, NOW)).toBe(false);
  });
});

describe('checkDeviceSilence', () => {
  it('counts only devices that hold an active cook', async () => {
    const hub = new FakeTwinHub()
      .addDevice('pi-cooking-ok')
      .setConnection('pi-cooking-ok', {
        connectionState: 'Connected',
        lastActivityTime: minutesAgo(1),
      })
      .addDevice('pi-cooking-dead')
      .setConnection('pi-cooking-dead', {
        connectionState: 'Disconnected',
        lastActivityTime: minutesAgo(20),
      })
      .addDevice('pi-blip')
      .setConnection('pi-blip', {
        connectionState: 'Disconnected',
        lastActivityTime: minutesAgo(2),
      })
      // Off between cooks: silent for days, but holds no active cook, so never read.
      .addDevice('pi-off')
      .setConnection('pi-off', {
        connectionState: 'Disconnected',
        lastActivityTime: minutesAgo(3000),
      });

    const counts = await checkDeviceSilence(
      deps(hub, ['pi-cooking-ok', 'pi-cooking-dead', 'pi-blip'])
    );

    expect(counts).toEqual({ activeCooks: 3, silent: 1, reporting: 2, unknown: 0 });
    expect(hub.gets).not.toContain('pi-off');
  });

  it('reads each device once even when it holds more than one active cook', async () => {
    const hub = new FakeTwinHub()
      .addDevice('pi-1')
      .setConnection('pi-1', { connectionState: 'Disconnected', lastActivityTime: minutesAgo(30) });

    const counts = await checkDeviceSilence(deps(hub, ['pi-1', 'pi-1']));

    expect(counts).toEqual({ activeCooks: 2, silent: 1, reporting: 0, unknown: 0 });
    expect(hub.gets).toEqual(['pi-1']);
  });

  it('counts a device whose twin cannot be read as unknown, not silent', async () => {
    const hub = new FakeTwinHub().addDevice('pi-1');
    hub.failNext('get_twin', 503);

    const counts = await checkDeviceSilence(deps(hub, ['pi-1', 'pi-missing']));

    expect(counts).toEqual({ activeCooks: 2, silent: 0, reporting: 0, unknown: 2 });
  });

  it('with no active cooks reads no twin', async () => {
    const hub = new FakeTwinHub();
    const counts = await checkDeviceSilence(deps(hub, []));
    expect(counts).toEqual({ activeCooks: 0, silent: 0, reporting: 0, unknown: 0 });
    expect(hub.gets).toEqual([]);
  });
});

describe('formatDeviceSilence', () => {
  it('is the marker and counts only: the alert query extracts silent=<n>', () => {
    expect(DEVICE_SILENCE_MARKER).toBe('deviceSilence');
    expect(formatDeviceSilence({ activeCooks: 3, silent: 1, reporting: 2, unknown: 0 })).toBe(
      'deviceSilence activeCooks=3 silent=1 reporting=2 unknown=0'
    );
  });
});

describe('deviceSilenceHandler', () => {
  it('runs every 5 minutes', () => {
    expect(DEVICE_SILENCE_SCHEDULE).toBe('0 */5 * * * *');
  });

  it('logs one line of counts and no device id', async () => {
    const hub = new FakeTwinHub()
      .addDevice('pi-secret-id')
      .setConnection('pi-secret-id', {
        connectionState: 'Disconnected',
        lastActivityTime: minutesAgo(20),
      });
    const context = fakeContext();

    await deviceSilenceHandler({} as never, context, deps(hub, ['pi-secret-id']));

    expect(context.lines).toEqual(['deviceSilence activeCooks=1 silent=1 reporting=0 unknown=0']);
    expect(context.lines.join(' ')).not.toContain('pi-secret-id');
  });

  it('logs an error and does not throw when the active cooks cannot be listed', async () => {
    const context = fakeContext();
    const failing: DeviceSilenceDeps = {
      listActiveCookDevices: async () => {
        throw Object.assign(new Error('secret cosmos text'), { statusCode: 503 });
      },
      getTwins: () => new FakeTwinHub(),
      now: () => NOW,
    };

    await expect(deviceSilenceHandler({} as never, context, failing)).resolves.toBeUndefined();

    expect(context.lines).toEqual([]);
    expect(context.errors).toEqual(['deviceSilence failed: active cooks not listed']);
  });
});
