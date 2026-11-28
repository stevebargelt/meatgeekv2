import type { DeviceConnection } from '@meatgeekv2/api-interfaces';
import type { InvocationContext, Timer } from '@azure/functions';

import { getCooksRepository } from '../../shared/cosmos/cooks-repository';
import { getDeviceTwinClient, type DeviceTwinPort } from '../../shared/iothub/device-twin';
import { readConnections } from './device-connection';

/**
 * #231 — "a device went silent during a cook", as a log line an alert can read.
 *
 * SILENT means: the device holds a cook whose status is `active`, its IoT Hub
 * twin says `Disconnected`, and IoT Hub last heard from it (`lastActivityAt`,
 * see {@link connectionFromTwin}) at least {@link SILENT_AFTER_MS} ago, or
 * never. A device that is off between cooks holds no active cook, so it is
 * never read and never counted. A connected device is never silent: the pusher
 * stays connected while it runs, and `lastActivityTime` lags by minutes, so a
 * stale time on a connected twin is not evidence. A short drop (under
 * {@link SILENT_AFTER_MS}) is a network blip the device reconnects from; its
 * queue sends the readings it buffered.
 *
 * Every {@link DEVICE_SILENCE_SCHEDULE} this lists the active cooks' devices
 * (one cross-partition query), reads each device's twin once, and logs one line
 * of counts ({@link formatDeviceSilence}). The `device-silent-during-cook` log
 * search alert in apps/infrastructure/modules/monitoring/main.tf fires when a
 * line in FunctionAppLogs carries `silent=` above 0. The line carries counts
 * only, never a device, cook or user id, the same as the API's other logs.
 *
 * It never throws: a failed listing is logged as an error and the next run
 * tries again.
 */

/** How long a disconnected device with an active cook may be quiet. */
export const SILENT_AFTER_MS = 10 * 60 * 1000;

/** Every 5 minutes, on the minute (NCRONTAB: second first, six fields). */
export const DEVICE_SILENCE_SCHEDULE = '0 */5 * * * *';

/** The first word of the line; the alert query matches it. Source-fixed. */
export const DEVICE_SILENCE_MARKER = 'deviceSilence';

export interface DeviceSilenceCounts {
  /** Active cooks found (a device with two counts twice). */
  readonly activeCooks: number;
  /** Distinct devices that are silent. */
  readonly silent: number;
  /** Distinct devices that are connected or dropped only briefly. */
  readonly reporting: number;
  /** Distinct devices whose twin could not be read. */
  readonly unknown: number;
}

/** Injection seam: production reads Cosmos, IoT Hub and the wall clock. */
export interface DeviceSilenceDeps {
  listActiveCookDevices(): Promise<readonly string[]>;
  getTwins(): DeviceTwinPort;
  now(): Date;
}

export const defaultDeviceSilenceDeps: DeviceSilenceDeps = {
  listActiveCookDevices: async () => (await getCooksRepository().listActiveCookDevices()).deviceIds,
  getTwins: () => getDeviceTwinClient(),
  now: () => new Date(),
};

/** Whether one device with an active cook counts as silent at `now`. */
export function isSilent(connection: DeviceConnection, now: Date): boolean {
  if (connection.state !== 'disconnected') {
    return false;
  }
  if (connection.lastActivityAt === null) {
    return true;
  }
  return now.getTime() - Date.parse(connection.lastActivityAt) >= SILENT_AFTER_MS;
}

/** Counts the active cooks' devices by silence. Rejects only if listing does. */
export async function checkDeviceSilence(deps: DeviceSilenceDeps): Promise<DeviceSilenceCounts> {
  const cookDevices = await deps.listActiveCookDevices();
  const devices = [...new Set(cookDevices)];
  const reads = await readConnections(devices, () => deps.getTwins());
  const now = deps.now();
  let silent = 0;
  let reporting = 0;
  let unknown = 0;
  for (const { connection } of reads) {
    if (connection.state === 'unknown') {
      unknown += 1;
    } else if (isSilent(connection, now)) {
      silent += 1;
    } else {
      reporting += 1;
    }
  }
  return { activeCooks: cookDevices.length, silent, reporting, unknown };
}

/** The one line the check logs, e.g. `deviceSilence activeCooks=1 silent=0 …`. */
export function formatDeviceSilence(counts: DeviceSilenceCounts): string {
  return (
    `${DEVICE_SILENCE_MARKER} activeCooks=${counts.activeCooks} silent=${counts.silent}` +
    ` reporting=${counts.reporting} unknown=${counts.unknown}`
  );
}

export async function deviceSilenceHandler(
  _timer: Timer,
  context: InvocationContext,
  deps: DeviceSilenceDeps = defaultDeviceSilenceDeps
): Promise<void> {
  let counts: DeviceSilenceCounts;
  try {
    counts = await checkDeviceSilence(deps);
  } catch {
    context.error(`${DEVICE_SILENCE_MARKER} failed: active cooks not listed`);
    return;
  }
  context.log(formatDeviceSilence(counts));
}
