import type { InvocationContext } from '@azure/functions';

import { toTemperatureReading } from '../../shared/cosmos/temperatures-repository';
import { broadcastTemperatureHandler, decodeBody } from './broadcast-temperature';
import { signalROutput, SignalRGroupMessage, TEMPERATURE } from './envelope';

/**
 * HAR-60 — broadcastTemperature handler. Drives the handler with a batch the
 * way the Functions host hands it over for `cardinality: 'many'`: the bodies as
 * the first argument, and per-event system properties and enqueued times in
 * `triggerMetadata`, index-aligned with the bodies.
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
  messages(): SignalRGroupMessage[];
}

function invoke(events: TestEvent[]): { run: Promise<void>; captured: Captured } {
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
    messages: () => {
      const forSignalR = sets.filter(s => s.output === signalROutput);
      return (forSignalR[forSignalR.length - 1]?.value ?? []) as SignalRGroupMessage[];
    },
  };
  return {
    run: broadcastTemperatureHandler(
      events.map(e => e.body),
      ctx
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
  it('sends a 3-event, 2-device batch to device-<id> from the system property, not the body, one message per device', async () => {
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

    // HAR-81: one message per device, smoker-a's carrying its newer reading.
    const messages = captured.messages();
    expect(messages).toHaveLength(2);
    expect(messages.map(m => m.groupName)).toEqual(['device-smoker-a', 'device-smoker-b']);
    expect(messages.every(m => m.target === TEMPERATURE)).toBe(true);
    expect(TEMPERATURE).toBe('temperature');
    expect(messages.map(m => m.arguments[0].deviceId)).toEqual(['smoker-a', 'smoker-b']);
    expect(messages.map(m => m.arguments[0].timestamp)).toEqual([T2, T1]);
    // Group-scoped only: no userId on a reading message.
    expect(messages.every(m => !('userId' in m))).toBe(true);
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
      { deviceId: 'smoker-b', iothubEnqueuedTime: T2, body: { timestamp: T0 } },
    ]);
    await run;
    expect(captured.messages().map(m => m.arguments[0].enqueuedTimeUtc)).toEqual([T1, T2]);
  });

  it('accepts object, string and Buffer bodies alike', async () => {
    const reading = { timestamp: T0, grillTemp: 230, probe3Temp: 150 };
    const { run, captured } = invoke([
      { deviceId: 'smoker-a', iothubEnqueuedTime: T0, enqueuedTimeUtc: T0, body: reading },
      {
        deviceId: 'smoker-b',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: JSON.stringify(reading),
      },
      {
        deviceId: 'smoker-c',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: Buffer.from(JSON.stringify(reading), 'utf8'),
      },
    ]);
    await run;

    const payloads = captured.messages().map(m => m.arguments[0]);
    expect(payloads).toEqual(
      ['smoker-a', 'smoker-b', 'smoker-c'].map(deviceId => ({
        deviceId,
        ...reading,
        enqueuedTimeUtc: T0,
      }))
    );
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

    expect(captured.messages().map(m => m.groupName)).toEqual([
      'device-smoker-a',
      'device-smoker-b',
    ]);
    expect(captured.logs).toEqual(['broadcastTemperature sent=2 coalesced=0 skipped=4']);
  });

  it('logs one sanitized line per batch: counts only, no ids and no bodies', async () => {
    const { run, captured } = invoke([
      {
        deviceId: 'secret-device',
        iothubEnqueuedTime: T0,
        enqueuedTimeUtc: T0,
        body: { timestamp: T0, cookId: 'secret-cook', grillTemp: 225 },
      },
      { deviceId: 'secret-device', body: 'secret-body' },
    ]);
    await run;

    expect(captured.logs).toEqual(['broadcastTemperature sent=1 coalesced=0 skipped=1']);
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
      'broadcastTemperature sent=0 coalesced=0 skipped=3',
      'broadcastTemperature sent=0 coalesced=0 skipped=0',
    ]);
  });
  describe('HAR-81: coalesces the push to the newest reading per device', () => {
    /** Reading `i` of `deviceId`, enqueued `i` seconds after T0. */
    const reading = (deviceId: string, i: number): TestEvent => {
      const at = new Date(Date.parse(T0) + i * 1000).toISOString();
      return {
        deviceId,
        iothubEnqueuedTime: at,
        enqueuedTimeUtc: at,
        body: { timestamp: at, grillTemp: 200 + i },
      };
    };
    const secondsAfterT0 = (seconds: number) =>
      new Date(Date.parse(T0) + seconds * 1000).toISOString();

    it('a batch of 50 readings for A and 3 for B sends exactly 2 messages, each the newest of its device', async () => {
      const a = Array.from({ length: 50 }, (_, i) => reading('smoker-a', i));
      const b = Array.from({ length: 3 }, (_, i) => reading('smoker-b', i * 10));
      // Interleaved, and out of order, as a burst across partitions can arrive.
      const events = [...a.slice(0, 20), b[2], ...a.slice(40), b[0], ...a.slice(20, 40), b[1]];
      expect(events).toHaveLength(53);
      const { run, captured } = invoke(events);
      await run;

      const messages = captured.messages();
      expect(messages).toHaveLength(2);
      expect(messages.map(m => m.groupName)).toEqual(['device-smoker-a', 'device-smoker-b']);
      expect(messages.every(m => m.target === TEMPERATURE)).toBe(true);
      expect(messages[0].arguments[0]).toEqual({
        deviceId: 'smoker-a',
        timestamp: secondsAfterT0(49),
        grillTemp: 249,
        enqueuedTimeUtc: secondsAfterT0(49),
      });
      expect(messages[1].arguments[0]).toEqual({
        deviceId: 'smoker-b',
        timestamp: secondsAfterT0(20),
        grillTemp: 220,
        enqueuedTimeUtc: secondsAfterT0(20),
      });
      expect(captured.logs).toEqual(['broadcastTemperature sent=2 coalesced=51 skipped=0']);
    });

    it('still skips and counts bad events, and a bad event never displaces a good reading', async () => {
      const events: TestEvent[] = [
        reading('smoker-a', 1),
        reading('smoker-a', 5),
        // Newer than every good reading, but bad: no hub-stamped device id …
        { enqueuedTimeUtc: secondsAfterT0(9), body: { deviceId: 'smoker-a', timestamp: T2 } },
        // … a non-JSON body …
        { deviceId: 'smoker-a', enqueuedTimeUtc: secondsAfterT0(9), body: 'not json {' },
        // … and no timestamp anywhere.
        { deviceId: 'smoker-b', enqueuedTimeUtc: secondsAfterT0(9), body: { grillTemp: 1 } },
        reading('smoker-b', 2),
        reading('smoker-a', 3),
      ];
      const { run, captured } = invoke(events);
      await expect(run).resolves.toBeUndefined();

      expect(captured.messages().map(m => [m.groupName, m.arguments[0].timestamp])).toEqual([
        ['device-smoker-a', secondsAfterT0(5)],
        ['device-smoker-b', secondsAfterT0(2)],
      ]);
      expect(captured.logs).toEqual(['broadcastTemperature sent=2 coalesced=2 skipped=3']);
    });

    it('picks the newest by enqueued time, not body timestamp, and the later event on a tie', async () => {
      const { run, captured } = invoke([
        // Enqueued later, but with an older body timestamp: it is still the newest.
        { deviceId: 'smoker-a', enqueuedTimeUtc: T2, body: { timestamp: T0, grillTemp: 1 } },
        { deviceId: 'smoker-a', enqueuedTimeUtc: T1, body: { timestamp: T2, grillTemp: 2 } },
        { deviceId: 'smoker-b', enqueuedTimeUtc: T1, body: { timestamp: T1, grillTemp: 3 } },
        { deviceId: 'smoker-b', enqueuedTimeUtc: T1, body: { timestamp: T1, grillTemp: 4 } },
      ]);
      await run;

      expect(captured.messages().map(m => m.arguments[0].grillTemp)).toEqual([1, 4]);
    });
  });
});
