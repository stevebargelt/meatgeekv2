import type { InvocationContext } from '@azure/functions';

import { toTemperatureReading } from '../../shared/cosmos/temperatures-repository';
import {
  broadcastTemperatureHandler,
  decodeBody,
  type BroadcastTemperatureDeps,
} from './broadcast-temperature';
import { signalROutput, SignalRTemperatureMessage, TEMPERATURE } from './envelope';

/**
 * HAR-60 — broadcastTemperature handler. Drives the handler with a batch the
 * way the Functions host hands it over for `cardinality: 'many'`: the bodies as
 * the first argument, and per-event system properties and enqueued times in
 * `triggerMetadata`, index-aligned with the bodies. HAR-81: each device's owner
 * comes from a fake lookup; by default `smoker-a` belongs to `owner-a` and so on.
 */

interface TestEvent {
  body: unknown;
  /** The hub-stamped device id; `undefined` leaves the property out. */
  deviceId?: string;
  iothubEnqueuedTime?: string;
  enqueuedTimeUtc?: string;
}

interface Captured {
  ctx: InvocationContext;
  sets: Array<{ output: unknown; value: unknown }>;
  logs: string[];
  messages(): SignalRTemperatureMessage[];
  /** Every owner lookup, in call order. */
  lookups: string[];
}

/** `smoker-<x>` is owned by `owner-<x>`; anything else has no owner. */
function defaultOwner(deviceId: string): string | undefined {
  return deviceId.startsWith('smoker-') ? `owner-${deviceId.slice('smoker-'.length)}` : undefined;
}

function invoke(
  events: TestEvent[],
  ownerOf: (deviceId: string) => Promise<string | undefined> = async id => defaultOwner(id)
): { run: Promise<void>; captured: Captured } {
  const lookups: string[] = [];
  const deps: BroadcastTemperatureDeps = {
    ownerOf: deviceId => {
      lookups.push(deviceId);
      return ownerOf(deviceId);
    },
  };
  const sets: Array<{ output: unknown; value: unknown }> = [];
  const logs: string[] = [];
  const ctx = {
    invocationId: 'broadcast-inv',
    triggerMetadata: {
      systemPropertiesArray: events.map(e => ({
        ...(e.deviceId === undefined ? {} : { 'iothub-connection-device-id': e.deviceId }),
        ...(e.iothubEnqueuedTime === undefined
          ? {}
          : { 'iothub-enqueuedtime': e.iothubEnqueuedTime }),
      })),
      enqueuedTimeUtcArray: events.map(e => e.enqueuedTimeUtc),
    },
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    extraOutputs: {
      set: (output: unknown, value: unknown) => sets.push({ output, value }),
    },
  } as unknown as InvocationContext;
  const captured: Captured = {
    ctx,
    sets,
    logs,
    lookups,
    messages: () => {
      const forSignalR = sets.filter(s => s.output === signalROutput);
      return (forSignalR[forSignalR.length - 1]?.value ?? []) as SignalRTemperatureMessage[];
    },
  };
  return {
    run: broadcastTemperatureHandler(
      events.map(e => e.body),
      ctx,
      deps
    ),
    captured,
  };
}

/** The stored-document shape GET /temperatures/current maps. */
function asDocument(e: TestEvent) {
  return {
    SystemProperties: {
      'iothub-connection-device-id': e.deviceId,
      'iothub-enqueuedtime': e.iothubEnqueuedTime,
    },
    Body: typeof e.body === 'object' && !Buffer.isBuffer(e.body) ? e.body : decodeBody(e.body),
  };
}

const T0 = '2026-11-19T10:00:00.000Z';
const T1 = '2026-11-19T10:00:05.000Z';
const T2 = '2026-11-19T10:00:10.000Z';

describe('broadcastTemperatureHandler', () => {
  it("sends a 3-event, 2-device batch to each device's owner, found from the system property, not the body", async () => {
    const events: TestEvent[] = [
      {
        deviceId: 'smoker-a',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: { deviceId: 'someone-else', timestamp: T0, grillTemp: 225, probe1Temp: 140 },
      },
      {
        deviceId: 'smoker-b',
        iothubEnqueuedTime: T1,
        enqueuedTimeUtc: T1,
        body: { deviceId: 'smoker-a', timestamp: T1, grillTemp: 250, cookId: 'cook-1' },
      },
      {
        deviceId: 'smoker-a',
        iothubEnqueuedTime: T2,
        enqueuedTimeUtc: T2,
        body: { timestamp: T2, grillTemp: 226 },
      },
    ];
    const { run, captured } = invoke(events);
    await run;

    // One set, on the shared binding, with all of the batch's messages.
    expect(captured.sets).toHaveLength(1);
    expect(captured.sets[0].output).toBe(signalROutput);

    const messages = captured.messages();
    expect(messages).toHaveLength(3);
    expect(messages.map(m => m.userId)).toEqual(['owner-a', 'owner-b', 'owner-a']);
    expect(messages.every(m => m.target === TEMPERATURE)).toBe(true);
    expect(TEMPERATURE).toBe('temperature');
    expect(messages.map(m => m.arguments[0].deviceId)).toEqual([
      'smoker-a',
      'smoker-b',
      'smoker-a',
    ]);
    // User-addressed only (HAR-81): no group on a reading message.
    expect(messages.every(m => !('groupName' in m))).toBe(true);
    // One owner lookup per distinct device, not per reading.
    expect(captured.lookups).toEqual(['smoker-a', 'smoker-b']);
  });

  it('looks each device up once however many readings the batch holds (HAR-81)', async () => {
    const events: TestEvent[] = Array.from({ length: 50 }, (_, i) => ({
      deviceId: i % 10 === 0 ? 'smoker-b' : 'smoker-a',
      iothubEnqueuedTime: T0,
      enqueuedTimeUtc: T0,
      body: { timestamp: T0, grillTemp: 200 + i },
    }));
    const { run, captured } = invoke(events);
    await run;

    expect(captured.messages()).toHaveLength(50);
    expect([...captured.lookups].sort()).toEqual(['smoker-a', 'smoker-b']);
  });

  it("sends a device's readings to its owner only, never to another owner", async () => {
    const { run, captured } = invoke([
      {
        deviceId: 'smoker-a',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: { timestamp: T0 },
      },
      {
        deviceId: 'smoker-b',
        iothubEnqueuedTime: T1,
        enqueuedTimeUtc: T1,
        body: { timestamp: T1 },
      },
    ]);
    await run;

    const byUser = captured.messages().map(m => [m.userId, m.arguments[0].deviceId]);
    expect(byUser).toEqual([
      ['owner-a', 'smoker-a'],
      ['owner-b', 'smoker-b'],
    ]);
  });

  it('does not push a reading whose device has no owner, and counts it as unowned', async () => {
    const { run, captured } = invoke([
      {
        deviceId: 'smoker-a',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: { timestamp: T0 },
      },
      {
        deviceId: 'unregistered',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: { timestamp: T0 },
      },
      {
        deviceId: 'unregistered',
        iothubEnqueuedTime: T1,
        enqueuedTimeUtc: T1,
        body: { timestamp: T1 },
      },
    ]);
    await run;

    expect(captured.messages().map(m => m.userId)).toEqual(['owner-a']);
    expect(captured.logs).toEqual([
      'broadcastTemperature sent=1 skipped=0 unowned=2 lookupFailed=0',
    ]);
  });

  it("drops only the failed device's readings when an owner read throws, and logs no error text", async () => {
    const { run, captured } = invoke(
      [
        {
          deviceId: 'smoker-a',
          iothubEnqueuedTime: T0,
          enqueuedTimeUtc: T0,
          body: { timestamp: T0 },
        },
        {
          deviceId: 'smoker-b',
          iothubEnqueuedTime: T0,
          enqueuedTimeUtc: T0,
          body: { timestamp: T0 },
        },
        {
          deviceId: 'smoker-b',
          iothubEnqueuedTime: T1,
          enqueuedTimeUtc: T1,
          body: { timestamp: T1 },
        },
      ],
      async id => {
        if (id === 'smoker-b') {
          throw Object.assign(new Error('https://acct.documents.azure.com read failed'), {
            code: 503,
          });
        }
        return defaultOwner(id);
      }
    );
    await expect(run).resolves.toBeUndefined();

    expect(captured.messages().map(m => m.userId)).toEqual(['owner-a']);
    expect(captured.logs).toEqual([
      'broadcastTemperature sent=1 skipped=0 unowned=0 lookupFailed=2',
    ]);
    expect(captured.logs.join('\n')).not.toContain('documents.azure.com');
  });

  it('pushes exactly toTemperatureReading of the same event plus enqueuedTimeUtc', async () => {
    const events: TestEvent[] = [
      {
        deviceId: 'smoker-a',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T1,
        body: {
          deviceId: 'spoofed',
          timestamp: T0,
          cookId: 'cook-7',
          grillTemp: 225.5,
          probe1Temp: 140,
          probe2Temp: 'hot',
          extra: 'not modelled',
        },
      },
      {
        // No body timestamp: the mapper falls back to iothub-enqueuedtime.
        deviceId: 'smoker-b',
        iothubEnqueuedTime: T2,
        enqueuedTimeUtc: T2,
        body: { grillTemp: 200 },
      },
    ];
    const { run, captured } = invoke(events);
    await run;

    const payloads = captured.messages().map(m => m.arguments[0]);
    expect(payloads).toEqual([
      { ...toTemperatureReading(asDocument(events[0]), 'smoker-a'), enqueuedTimeUtc: T1 },
      { ...toTemperatureReading(asDocument(events[1]), 'smoker-b'), enqueuedTimeUtc: T2 },
    ]);
    expect(payloads[0]).toEqual({
      deviceId: 'smoker-a',
      timestamp: T0,
      cookId: 'cook-7',
      grillTemp: 225.5,
      probe1Temp: 140,
      enqueuedTimeUtc: T1,
    });
    expect(payloads[1].timestamp).toBe(T2);
  });

  it('normalizes enqueuedTimeUtc to an ISO string, falling back to iothub-enqueuedtime', async () => {
    const { run, captured } = invoke([
      {
        deviceId: 'smoker-a',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: 'Thu, 19 Nov 2026 10:00:05 GMT',
        body: { timestamp: T0 },
      },
      { deviceId: 'smoker-a', iothubEnqueuedTime: T2, body: { timestamp: T0 } },
    ]);
    await run;
    expect(captured.messages().map(m => m.arguments[0].enqueuedTimeUtc)).toEqual([T1, T2]);
  });

  it('accepts object, string and Buffer bodies alike', async () => {
    const reading = { timestamp: T0, grillTemp: 230, probe3Temp: 150 };
    const { run, captured } = invoke([
      { deviceId: 'smoker-a', iothubEnqueuedTime: T0, enqueuedTimeUtc: T0, body: reading },
      {
        deviceId: 'smoker-a',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: JSON.stringify(reading),
      },
      {
        deviceId: 'smoker-a',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: Buffer.from(JSON.stringify(reading), 'utf8'),
      },
    ]);
    await run;

    const payloads = captured.messages().map(m => m.arguments[0]);
    expect(payloads).toHaveLength(3);
    const expected = { deviceId: 'smoker-a', ...reading, enqueuedTimeUtc: T0 };
    expect(payloads).toEqual([expected, expected, expected]);
  });

  it('decodes a Buffer that is a slice of a larger allocation', () => {
    const pool = Buffer.from(`xxxx${JSON.stringify({ timestamp: T0 })}yyyy`, 'utf8');
    const slice = pool.subarray(4, pool.length - 4);
    expect(decodeBody(slice)).toEqual({ timestamp: T0 });
  });

  it('skips an event with no device id, a non-JSON body, or no timestamp, and still sends the rest', async () => {
    const good = (deviceId: string): TestEvent => ({
      deviceId,
      iothubEnqueuedTime: T0,
      enqueuedTimeUtc: T0,
      body: { timestamp: T0, grillTemp: 225 },
    });
    const { run, captured } = invoke([
      good('smoker-a'),
      // No hub-stamped device id; the body's deviceId must not be used instead.
      {
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: { deviceId: 'smoker-x', timestamp: T0, grillTemp: 1 },
      },
      // Non-JSON body, as a string and as bytes.
      { deviceId: 'smoker-a', iothubEnqueuedTime: T0, enqueuedTimeUtc: T0, body: 'not json {' },
      {
        deviceId: 'smoker-a',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: Buffer.from([0xff, 0xfe, 0x00]),
      },
      // No timestamp anywhere: neither Body.timestamp nor iothub-enqueuedtime.
      { deviceId: 'smoker-a', enqueuedTimeUtc: T0, body: { grillTemp: 225 } },
      good('smoker-b'),
    ]);
    await expect(run).resolves.toBeUndefined();

    expect(captured.messages().map(m => m.userId)).toEqual(['owner-a', 'owner-b']);
    expect(captured.logs).toEqual([
      'broadcastTemperature sent=2 skipped=4 unowned=0 lookupFailed=0',
    ]);
  });

  it('logs one sanitized line per batch: counts only, no ids, owners or bodies', async () => {
    const { run, captured } = invoke(
      [
        {
          deviceId: 'secret-device',
          iothubEnqueuedTime: T0,
          enqueuedTimeUtc: T0,
          body: { timestamp: T0, cookId: 'secret-cook', grillTemp: 225 },
        },
        { deviceId: 'secret-device', body: 'secret-body' },
      ],
      async () => 'secret-owner'
    );
    await run;

    expect(captured.logs).toEqual([
      'broadcastTemperature sent=1 skipped=1 unowned=0 lookupFailed=0',
    ]);
    const all = captured.logs.join('\n');
    expect(all).not.toContain('secret');
  });

  it('never throws on a malformed batch or missing trigger metadata', async () => {
    const sets: unknown[] = [];
    const logs: string[] = [];
    const ctx = {
      invocationId: 'broadcast-inv',
      log: (line: string) => logs.push(line),
      extraOutputs: { set: (_o: unknown, v: unknown) => sets.push(v) },
    } as unknown as InvocationContext;

    await expect(
      broadcastTemperatureHandler([{ timestamp: T0 }, null, 42], ctx)
    ).resolves.toBeUndefined();
    await expect(broadcastTemperatureHandler(undefined, ctx)).resolves.toBeUndefined();

    expect(sets).toEqual([[], []]);
    expect(logs).toEqual([
      'broadcastTemperature sent=0 skipped=3 unowned=0 lookupFailed=0',
      'broadcastTemperature sent=0 skipped=0 unowned=0 lookupFailed=0',
    ]);
  });
});
