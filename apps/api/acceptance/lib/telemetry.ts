import type { Device, RegisterDeviceRequest } from '@meatgeekv2/api-interfaces';

import { expectErrorCode } from './checks';
import type { AcceptanceApi, SimDeviceRun } from './proof';
import { ProofFailure } from './proof';

/**
 * Steps more than one telemetry proof takes with the standing simulated device
 * (`api.simulatedDeviceId`): registering it to the caller and sending one
 * reading through IoT Hub with `simdevice`.
 */

const DEVICE_NAME = 'Simulated smoker (acceptance)';

/** The reading one `simdevice --count 1` run sent, as its stdout line reports it. */
export interface SentReading {
  /** The payload's `timestamp`, three fractional digits. */
  readonly timestamp: string;
  /** When IoT Hub acknowledged the publish. */
  readonly sentAt: string;
}

export const isDate = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(Date.parse(value));

/**
 * True when `value` is the same instant as `sent`. Compared as instants, not
 * strings: simdevice prints `timestamp` with three fractional digits
 * (`…05.120Z`), but the payload is Go's RFC3339Nano, which drops trailing
 * zeros (`…05.12Z`), and the API returns the payload's string verbatim.
 */
export const sameInstant = (value: unknown, sent: string): boolean =>
  isDate(value) && Date.parse(value) === Date.parse(sent);

/**
 * Register the simulated device to the caller: `201`, or `409 DEVICE_CONFLICT`
 * (an earlier run registered it) and then `GET /devices/{id}` `200`, which that
 * route answers only for the caller's own device (`404` for someone else's).
 */
export async function registerSimulatedDevice(api: AcceptanceApi): Promise<void> {
  const deviceId = api.simulatedDeviceId;
  const body: RegisterDeviceRequest = { deviceId, name: DEVICE_NAME, model: 'simdevice' };
  const response = await api.request({ method: 'POST', path: '/devices', body });
  if (response.status !== 409) {
    api.expectStatus(response, 201);
    return;
  }
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
}

/**
 * Fail unless `message`, one stdout line of simdevice, is a reading sent as the
 * simulated device with a date `timestamp` and `sentAt`; return those two.
 */
export function parseSentReading(api: AcceptanceApi, message: unknown): SentReading {
  const line = message as Record<string, unknown> | null;
  const timestamp = line?.['timestamp'];
  const sentAt = line?.['sentAt'];
  if (!isDate(timestamp) || !isDate(sentAt)) {
    throw new ProofFailure(
      `simdevice line has timestamp ${JSON.stringify(timestamp)} and sentAt ` +
        `${JSON.stringify(sentAt)}; both must be dates`
    );
  }
  if (line?.['deviceId'] !== api.simulatedDeviceId) {
    throw new ProofFailure(
      `simdevice sent as ${JSON.stringify(line?.['deviceId'])}, not ${api.simulatedDeviceId}`
    );
  }
  return { timestamp, sentAt };
}

/** Fail unless a simdevice run exited 0, naming its exit and first stderr line. */
export function expectSimDeviceExit0(run: SimDeviceRun): void {
  if (run.exitCode !== 0) {
    throw new ProofFailure(
      `simdevice exited ${run.exitCode ?? '(killed)'}, expected 0` +
        (run.stderrFirstLine ? `: ${run.stderrFirstLine}` : '')
    );
  }
}

/**
 * Send one reading as the simulated device (`simdevice --count 1`) and return
 * what its one stdout line reports. Fails unless simdevice exits 0 and prints
 * exactly one JSON line, for the simulated device, with a date `timestamp` and
 * `sentAt`.
 */
export async function sendOneReading(api: AcceptanceApi): Promise<SentReading> {
  const run = await api.runSimDevice(['--count', '1']);
  expectSimDeviceExit0(run);
  if (run.messages.length !== 1 || run.unparsedLines > 0) {
    throw new ProofFailure(
      `simdevice printed ${run.messages.length} JSON line(s) and ` +
        `${run.unparsedLines} other line(s) on stdout, expected exactly one JSON line`
    );
  }
  return parseSentReading(api, run.messages[0]);
}
