/**
 * HAR-143 — reading each device's connection from its IoT Hub twin. No Azure,
 * no clock: the concurrency cap is asserted with a fake twin client whose
 * reads stay open until the test releases them.
 */
import type { Device } from '@meatgeekv2/api-interfaces';

import {
  DeviceTwinError,
  type DeviceTwin,
  type DeviceTwinPort,
} from '../../shared/iothub/device-twin';
import {
  CONNECTION_READ_CONCURRENCY,
  connectionFromTwin,
  formatConnectionCounts,
  withConnections,
} from './device-connection';

function device(id: string): Device {
  return { id, userId: 'tid:oid', name: id, model: 'MeatGeek', isActive: true };
}

function twin(connection: Pick<DeviceTwin, 'connectionState' | 'lastActivityTime'>): DeviceTwin {
  return { etag: 'e', desired: {}, reported: {}, ...connection };
}

describe('connectionFromTwin', () => {
  it('maps Connected and Disconnected', () => {
    expect(
      connectionFromTwin({ connectionState: 'Connected', lastActivityTime: '2026-11-20T12:00:00Z' })
    ).toEqual({ state: 'connected', lastActivityAt: '2026-11-20T12:00:00.000Z' });
    expect(
      connectionFromTwin({
        connectionState: 'Disconnected',
        lastActivityTime: '2026-11-20T12:00:00Z',
      })
    ).toEqual({ state: 'disconnected', lastActivityAt: '2026-11-20T12:00:00.000Z' });
  });

  it('is unknown for a missing or unexpected connectionState', () => {
    expect(connectionFromTwin({}).state).toBe('unknown');
    expect(connectionFromTwin({ connectionState: 'connected' }).state).toBe('unknown');
    expect(connectionFromTwin({ connectionState: '' }).state).toBe('unknown');
  });

  it('normalises IoT Hub’s 7-digit fractions to millisecond ISO-8601 UTC', () => {
    expect(
      connectionFromTwin({ lastActivityTime: '2026-11-20T12:34:56.9876543Z' }).lastActivityAt
    ).toBe('2026-11-20T12:34:56.987Z');
  });

  it('is null for 0001-01-01T00:00:00Z (never heard from), a missing value and garbage', () => {
    expect(
      connectionFromTwin({
        connectionState: 'Disconnected',
        lastActivityTime: '0001-01-01T00:00:00Z',
      })
    ).toEqual({ state: 'disconnected', lastActivityAt: null });
    expect(
      connectionFromTwin({ lastActivityTime: '0001-01-01T00:00:00.0000000Z' }).lastActivityAt
    ).toBeNull();
    expect(connectionFromTwin({ connectionState: 'Connected' }).lastActivityAt).toBeNull();
    expect(connectionFromTwin({ lastActivityTime: 'not a time' }).lastActivityAt).toBeNull();
  });
});

describe('withConnections', () => {
  it('keeps the input order and counts each outcome', async () => {
    const answers: Record<string, () => Promise<DeviceTwin>> = {
      a: async () =>
        twin({ connectionState: 'Connected', lastActivityTime: '2026-11-20T12:00:00Z' }),
      b: async () => twin({ connectionState: 'Disconnected' }),
      c: async () => twin({}),
      d: async () => {
        throw new DeviceTwinError('get_twin', 404);
      },
      e: async () => {
        throw new DeviceTwinError('get_twin', 500);
      },
      f: async () => {
        throw new Error('not even a DeviceTwinError');
      },
    };
    const twins: DeviceTwinPort = {
      getTwin: id => answers[id](),
      patchDesired: async () => undefined,
    };

    const result = await withConnections(['a', 'b', 'c', 'd', 'e', 'f'].map(device), () => twins);

    expect(result.devices.map(d => [d.id, d.connection])).toEqual([
      ['a', { state: 'connected', lastActivityAt: '2026-11-20T12:00:00.000Z' }],
      ['b', { state: 'disconnected', lastActivityAt: null }],
      ['c', { state: 'unknown', lastActivityAt: null }],
      ['d', { state: 'unknown', lastActivityAt: null }],
      ['e', { state: 'unknown', lastActivityAt: null }],
      ['f', { state: 'unknown', lastActivityAt: null }],
    ]);
    expect(result.counts).toEqual({
      connected: 1,
      disconnected: 1,
      unknown: 1,
      no_twin: 1,
      failed: 2,
    });
    expect(formatConnectionCounts(result.counts)).toBe(
      'connected=1 disconnected=1 unknown=1 no_twin=1 failed=2'
    );
  });

  it('makes every device unknown when the twin client cannot be built', async () => {
    const result = await withConnections([device('a'), device('b')], () => {
      throw new DeviceTwinError('configuration');
    });
    expect(result.devices.map(d => d.connection)).toEqual([
      { state: 'unknown', lastActivityAt: null },
      { state: 'unknown', lastActivityAt: null },
    ]);
    expect(result.counts.failed).toBe(2);
  });

  it('reads nothing for an empty list', async () => {
    const getTwin = jest.fn();
    const result = await withConnections([], () => ({ getTwin, patchDesired: jest.fn() }));
    expect(result.devices).toEqual([]);
    expect(getTwin).not.toHaveBeenCalled();
  });

  it(`runs at most ${CONNECTION_READ_CONCURRENCY} twin reads at once, one per device`, async () => {
    expect(CONNECTION_READ_CONCURRENCY).toBe(8);
    const total = 21;
    let inFlight = 0;
    let maxInFlight = 0;
    const started: string[] = [];
    const pending: Array<() => void> = [];
    let wake: (() => void) | undefined;
    const twins: DeviceTwinPort = {
      getTwin: id =>
        new Promise<DeviceTwin>(resolve => {
          started.push(id);
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          pending.push(() => {
            inFlight -= 1;
            resolve(twin({ connectionState: 'Connected' }));
          });
          wake?.();
        }),
      patchDesired: async () => undefined,
    };
    /** Resolves once `count` reads have started. */
    const startedAtLeast = (count: number) =>
      new Promise<void>(resolve => {
        const check = () => {
          if (started.length >= count) {
            wake = undefined;
            resolve();
          }
        };
        wake = check;
        check();
      });

    const ids = Array.from({ length: total }, (_, i) => `d${i}`);
    const result = withConnections(ids.map(device), () => twins);

    // The first 8 start; no ninth until one of them finishes.
    await startedAtLeast(8);
    await Promise.resolve();
    expect(inFlight).toBe(8);
    expect(started).toHaveLength(8);

    // Release reads one at a time: each finished read lets exactly one more in.
    while (pending.length > 0) {
      const before = started.length;
      pending.shift()?.();
      if (before < total) {
        await startedAtLeast(before + 1);
        expect(started).toHaveLength(before + 1);
      } else {
        await Promise.resolve();
      }
      expect(inFlight).toBeLessThanOrEqual(8);
    }

    const { devices, counts } = await result;
    expect(maxInFlight).toBe(8);
    expect([...started].sort()).toEqual([...ids].sort());
    expect(devices.map(d => d.id)).toEqual(ids);
    expect(counts.connected).toBe(total);
  });
});
