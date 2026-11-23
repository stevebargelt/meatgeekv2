import type { Device } from '../api/client';
import { formatDuration } from '../live/format';

/** HAR-143: a device's connection as GET /devices reports it. */
export type DeviceConnection = NonNullable<Device['connection']>;

/** The four ways a device row states its connection. */
export const CONNECTION_TEXT = {
  connected: 'Connected',
  offline: 'Offline',
  neverHeard: 'Offline · never heard from',
  unknown: 'Status unknown',
} as const;

/** "last heard 3 min 4 s ago", in the live panel's duration style. */
export function lastHeard(lastActivityAt: string, now: number): string {
  return `last heard ${formatDuration(now - Date.parse(lastActivityAt))} ago`;
}

/**
 * HAR-143: what a device row says about its connection, relative to `now`
 * (epoch ms, from the page's injected clock):
 *   - "Connected", plus " · last heard <age> ago" when the hub has heard from it;
 *   - "Offline · last heard <age> ago";
 *   - "Offline · never heard from";
 *   - "Status unknown" (the twin could not be read, or no connection was sent).
 */
export function connectionText(connection: DeviceConnection | undefined, now: number): string {
  const at = connection?.lastActivityAt ?? null;
  const heard = at !== null && !Number.isNaN(Date.parse(at));
  switch (connection?.state) {
    case 'connected':
      return heard
        ? `${CONNECTION_TEXT.connected} · ${lastHeard(at, now)}`
        : CONNECTION_TEXT.connected;
    case 'disconnected':
      return heard
        ? `${CONNECTION_TEXT.offline} · ${lastHeard(at, now)}`
        : CONNECTION_TEXT.neverHeard;
    default:
      return CONNECTION_TEXT.unknown;
  }
}
