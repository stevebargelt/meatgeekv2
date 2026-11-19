import type {
  Device,
  RegisterDeviceRequest,
  TemperatureHistoryResponse,
  TemperatureReading,
} from '@meatgeekv2/api-interfaces';

import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { expectErrorCode, expectNoSystemProperties } from '../lib/checks';
import { defineProofs, ProofFailure } from '../lib/proof';

/**
 * HAR-44 (MG-79, the live criterion) — a reading sent to IoT Hub the way the Pi
 * sends it comes back through the API in its mapped contract shape, and the run
 * records how long that took.
 *
 *   1. the standing simulated device (`api.simulatedDeviceId`) is registered to
 *      the caller: `201`, or `409 DEVICE_CONFLICT` and then `GET /devices/{id}`
 *      `200` (that route answers `404` for a device someone else owns);
 *   2. `simdevice --count 1` sends one reading through IoT Hub, as that device,
 *      using data-pusher's own payload and property code (the runner starts it
 *      and hands it the credential; this file never sees it);
 *   3. `GET /temperatures/current/{deviceId}` is polled until it returns that
 *      reading, matched on its body `timestamp` as an instant, then `METRIC roundtrip-ms` is
 *      printed: send acknowledgement (`sentAt`) to that `200`;
 *   4. `GET /temperatures/history` from `sentAt − 5 min` (the window is on the
 *      hub's enqueued time, never before the send) holds the same reading.
 *
 * Readings are not cleaned up: they expire on the temperatures container TTL.
 */

/** Poll pacing for step 3. The self-test shortens these; nothing else should. */
export const ROUNDTRIP_POLL = {
  intervalMs: 1_000,
  capMs: 120_000,
};

/** How far before `sentAt` the history window opens. */
const HISTORY_LOOKBACK_MS = 5 * 60 * 1000;

const DEVICE_NAME = 'Simulated smoker (acceptance)';

interface SentReading {
  readonly timestamp: string;
  readonly sentAt: string;
}

const sleep = (ms: number) => new Promise<void>(resolve => setTimeout(resolve, ms));

const isDate = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

/**
 * True when `value` is the same instant as `sent`. Compared as instants, not
 * strings: simdevice prints `timestamp` with three fractional digits
 * (`…05.120Z`), but the payload is Go's RFC3339Nano, which drops trailing
 * zeros (`…05.12Z`), and the API returns the payload's string verbatim.
 */
const sameInstant = (value: unknown, sent: string): boolean =>
  isDate(value) && Date.parse(value) === Date.parse(sent);

/** Fail unless `value` is the sent reading in its contract shape. */
function expectSentReading(
  api: AcceptanceApi,
  response: AcceptanceResponse,
  value: unknown,
  deviceId: string
): void {
  const reading = value as Partial<TemperatureReading>;
  api.check(
    response,
    reading.deviceId === deviceId,
    `reading.deviceId is ${JSON.stringify(reading.deviceId)}, not ${deviceId}`
  );
  api.check(
    response,
    typeof reading.grillTemp === 'number' && Number.isFinite(reading.grillTemp),
    `reading.grillTemp is ${JSON.stringify(reading.grillTemp)}, not a number`
  );
  expectNoSystemProperties(api, response);
}

export default defineProofs('telemetry round-trip', () => {
  let registered = false;
  let sent: SentReading | undefined;

  const sentReading = (): SentReading => {
    if (!sent) {
      throw new Error('no reading was sent by an earlier proof');
    }
    return sent;
  };

  return [
    {
      name: 'POST /devices registers the simulated device to the caller',
      async run(api: AcceptanceApi) {
        const deviceId = api.simulatedDeviceId;
        const body: RegisterDeviceRequest = { deviceId, name: DEVICE_NAME, model: 'simdevice' };
        const response = await api.request({ method: 'POST', path: '/devices', body });
        if (response.status === 409) {
          // Registered by an earlier run. Only a 200 here says it is the caller's.
          expectErrorCode(api, response, 'DEVICE_CONFLICT');
          const owned = await api.request<Device>({
            method: 'GET',
            path: `/devices/${encodeURIComponent(deviceId)}`,
            route: '/devices/{id}',
          });
          api.check(
            owned,
            owned.status === 200,
            `${deviceId} is registered, but not to the caller (expected 200, got ${owned.status})`
          );
          api.check(owned, owned.body?.id === deviceId, `device.id is not ${deviceId}`);
        } else {
          api.expectStatus(response, 201);
        }
        registered = true;
      },
    },
    {
      name: 'simdevice --count 1 sends one reading through IoT Hub',
      async run(api: AcceptanceApi) {
        if (!registered) {
          throw new Error('the simulated device was not registered by an earlier proof');
        }
        const run = await api.runSimDevice(['--count', '1']);
        if (run.exitCode !== 0) {
          throw new ProofFailure(
            `simdevice exited ${run.exitCode ?? '(killed)'}, expected 0` +
              (run.stderrFirstLine ? `: ${run.stderrFirstLine}` : '')
          );
        }
        if (run.messages.length !== 1 || run.unparsedLines > 0) {
          throw new ProofFailure(
            `simdevice printed ${run.messages.length} JSON line(s) and ` +
              `${run.unparsedLines} other line(s) on stdout, expected exactly one JSON line`
          );
        }
        const message = run.messages[0] as Record<string, unknown> | null;
        const timestamp = message?.['timestamp'];
        const sentAt = message?.['sentAt'];
        if (!isDate(timestamp) || !isDate(sentAt)) {
          throw new ProofFailure(
            `simdevice line has timestamp ${JSON.stringify(timestamp)} and sentAt ` +
              `${JSON.stringify(sentAt)}; both must be dates`
          );
        }
        if (message?.['deviceId'] !== api.simulatedDeviceId) {
          throw new ProofFailure(
            `simdevice sent as ${JSON.stringify(message?.['deviceId'])}, not ${api.simulatedDeviceId}`
          );
        }
        sent = { timestamp, sentAt };
      },
    },
    {
      name: 'GET /temperatures/current/{deviceId} returns the sent reading',
      async run(api: AcceptanceApi) {
        const { timestamp, sentAt } = sentReading();
        const deviceId = api.simulatedDeviceId;
        const deadline = Date.now() + ROUNDTRIP_POLL.capMs;
        let last: AcceptanceResponse<Partial<TemperatureReading>> | undefined;

        for (;;) {
          const response = await api.request<Partial<TemperatureReading>>({
            method: 'GET',
            path: `/temperatures/current/${encodeURIComponent(deviceId)}`,
            route: '/temperatures/current/{deviceId}',
          });
          const arrivedAt = Date.now();
          last = response;
          if (response.status === 200 && sameInstant(response.body?.timestamp, timestamp)) {
            expectSentReading(api, response, response.body, deviceId);
            api.metric('roundtrip-ms', arrivedAt - Date.parse(sentAt));
            return;
          }
          // Not routed yet (404 NO_READINGS) or an older reading: keep polling.
          // Anything else is a failure now.
          if (response.status === 404) {
            expectErrorCode(api, response, 'NO_READINGS');
          } else {
            api.expectStatus(response, 200);
          }
          if (arrivedAt + ROUNDTRIP_POLL.intervalMs > deadline) {
            break;
          }
          await sleep(ROUNDTRIP_POLL.intervalMs);
        }

        const seen = last.status === 200 ? last.body?.timestamp : undefined;
        throw new ProofFailure(
          `the reading sent at ${sentAt} (timestamp ${timestamp}) was not readable within the ` +
            `${ROUNDTRIP_POLL.capMs / 1000} s cap; last status ${last.status}, ` +
            `last timestamp seen ${seen === undefined ? 'none' : JSON.stringify(seen)}`,
          last
        );
      },
    },
    {
      name: 'GET /temperatures/history holds the sent reading',
      async run(api: AcceptanceApi) {
        const { timestamp, sentAt } = sentReading();
        const deviceId = api.simulatedDeviceId;
        const startTime = new Date(Date.parse(sentAt) - HISTORY_LOOKBACK_MS).toISOString();
        let offset = 0;

        for (;;) {
          const response = await api.request<TemperatureHistoryResponse>({
            method: 'GET',
            path:
              `/temperatures/history?deviceId=${encodeURIComponent(deviceId)}` +
              `&startTime=${encodeURIComponent(startTime)}` +
              (offset > 0 ? `&offset=${offset}` : ''),
            route: '/temperatures/history',
          });
          api.expectStatus(response, 200);
          const readings = response.body?.readings;
          api.check(response, Array.isArray(readings), 'body.readings is not an array');
          const match = readings.find(reading => sameInstant(reading?.timestamp, timestamp));
          if (match) {
            expectSentReading(api, response, match, deviceId);
            return;
          }
          if (response.body.hasMore !== true) {
            throw new ProofFailure(
              `no reading with timestamp ${timestamp} in the ${offset + readings.length} ` +
                `reading(s) since ${startTime}`,
              response
            );
          }
          api.check(response, readings.length > 0, 'hasMore is true on an empty page');
          offset += readings.length;
        }
      },
    },
  ];
});
