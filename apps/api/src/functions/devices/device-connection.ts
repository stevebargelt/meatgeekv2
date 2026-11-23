import type { Device, DeviceConnection } from '@meatgeekv2/api-interfaces';

import {
  DeviceTwinError,
  type DeviceTwin,
  type DeviceTwinPort,
} from '../../shared/iothub/device-twin';

/**
 * HAR-143 (goal HAR-130) — whether each device is connected and when IoT Hub
 * last heard from it, read live from the device's twin. `GET /devices` and
 * `GET /devices/{id}` attach it as `connection`; it is never stored.
 *
 * One twin GET per device (never an IoT Hub query, which needs a role the API
 * is not granted), at most {@link CONNECTION_READ_CONCURRENCY} at a time. A
 * device whose twin cannot be read (no twin, a failure, the client's timeout)
 * is `unknown`; a twin read never fails the request. What this logs is counts,
 * never device ids.
 */

/** How many twin GETs one request runs at once. */
export const CONNECTION_READ_CONCURRENCY = 8;

/** What a device whose twin could not be read reports. */
export const UNKNOWN_CONNECTION: DeviceConnection = Object.freeze({
  state: 'unknown',
  lastActivityAt: null,
}) as DeviceConnection;

/** The twin's connection fields as a {@link DeviceConnection}. */
export function connectionFromTwin(
  twin: Pick<DeviceTwin, 'connectionState' | 'lastActivityTime'>
): DeviceConnection {
  return {
    state:
      twin.connectionState === 'Connected'
        ? 'connected'
        : twin.connectionState === 'Disconnected'
          ? 'disconnected'
          : 'unknown',
    lastActivityAt: lastActivityAt(twin.lastActivityTime),
  };
}

/**
 * `lastActivityTime` as millisecond ISO-8601 UTC. IoT Hub sends
 * `0001-01-01T00:00:00Z` for a device it has never heard from; that, a missing
 * value and anything unparseable are `null`.
 */
function lastActivityAt(raw: string | undefined): string | null {
  if (raw === undefined) return null;
  const ms = Date.parse(raw);
  if (Number.isNaN(ms)) return null;
  const date = new Date(ms);
  return date.getUTCFullYear() <= 1 ? null : date.toISOString();
}

/** How one device's twin read went; logged as counts only. */
export type ConnectionReadOutcome = 'connected' | 'disconnected' | 'unknown' | 'no_twin' | 'failed';

export type ConnectionReadCounts = Record<ConnectionReadOutcome, number>;

async function readOne(
  twins: DeviceTwinPort,
  deviceId: string
): Promise<{ connection: DeviceConnection; outcome: ConnectionReadOutcome }> {
  try {
    const connection = connectionFromTwin(await twins.getTwin(deviceId));
    return { connection, outcome: connection.state };
  } catch (error) {
    const outcome = error instanceof DeviceTwinError && error.isNotFound ? 'no_twin' : 'failed';
    return { connection: UNKNOWN_CONNECTION, outcome };
  }
}

/**
 * Runs `task` over `items` with at most `limit` running at once, keeping the
 * input order in the result. `task` must not reject.
 */
async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < items.length) {
      const index = next++;
      results[index] = await task(items[index]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * Each device with its `connection`, read from its twin. `getTwins` is called
 * once; if it throws (the hub hostname is not configured) every device is
 * `unknown`. Never rejects.
 */
export async function withConnections(
  devices: readonly Device[],
  getTwins: () => DeviceTwinPort,
  limit = CONNECTION_READ_CONCURRENCY
): Promise<{ devices: Device[]; counts: ConnectionReadCounts }> {
  const counts: ConnectionReadCounts = {
    connected: 0,
    disconnected: 0,
    unknown: 0,
    no_twin: 0,
    failed: 0,
  };
  let twins: DeviceTwinPort | undefined;
  try {
    twins = getTwins();
  } catch {
    twins = undefined;
  }
  const hub = twins;
  const reads = await mapWithConcurrency(devices, limit, device =>
    hub
      ? readOne(hub, device.id)
      : Promise.resolve({ connection: UNKNOWN_CONNECTION, outcome: 'failed' as const })
  );
  reads.forEach(read => (counts[read.outcome] += 1));
  return {
    devices: devices.map((device, i) => ({ ...device, connection: { ...reads[i].connection } })),
    counts,
  };
}

/** The counts as one log fragment, e.g. `connected=1 disconnected=0 …`. */
export function formatConnectionCounts(counts: ConnectionReadCounts): string {
  return (Object.keys(counts) as ConnectionReadOutcome[])
    .map(outcome => `${outcome}=${counts[outcome]}`)
    .join(' ');
}
