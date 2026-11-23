import { claimStandingDevice } from './enrolment';
import type { AcceptanceApi, SimDeviceRun } from './proof';
import { ProofFailure } from './proof';

/**
 * Steps more than one telemetry proof takes with the standing simulated device
 * (`api.simulatedDeviceId`): claiming it for the caller and sending one
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
 * HAR-140: make the simulated device the caller's with its own claim code
 * (`claimStandingDevice` in ./enrolment): claimed once per run, then claimed
 * again with the same code by each later group; never released. In
 * connection-string mode, where it shows no code, it must already be the
 * caller's.
 */
export async function registerSimulatedDevice(api: AcceptanceApi): Promise<void> {
  await claimStandingDevice(api, 'simulated', { name: DEVICE_NAME, model: 'simdevice' });
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

/** Fail unless a simdevice run exited 0, naming its exit (or the time limit
 *  it was killed at) and its first stderr line. */
export function expectSimDeviceExit0(run: SimDeviceRun): void {
  if (run.exitCode !== 0) {
    throw new ProofFailure(
      (run.killedAfterMs !== undefined
        ? `simdevice did not exit within its ${run.killedAfterMs} ms limit and was killed, expected exit 0`
        : `simdevice exited ${run.exitCode ?? '(killed)'}, expected 0`) +
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
