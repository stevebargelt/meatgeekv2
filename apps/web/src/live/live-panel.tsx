import { useEffect, useRef, useState } from 'react';
import type { components } from '@meatgeekv2/api-specs/types';
import { useApi } from '../api/api-context';
import type { Cook, Device } from '../api/client';
import { formatDateTime, useNow } from '../cooks/time';
import { formatDuration, formatTemperature, type TemperatureUnit } from './format';
import type { CookStoppedMessage, TemperatureMessage } from './hub';
import { useHubFactory } from './hub-context';
import { openLiveConnection, type ConnectionStatus } from './live-connection';

type TemperatureReading = components['schemas']['TemperatureReading'];

/** A device with no `pollingInterval` is polled every 30 s (the API's default). */
export const DEFAULT_POLLING_INTERVAL_S = 30;
/** A reading older than this many polling intervals is stale. */
export const STALE_AFTER_INTERVALS = 3;

const CHANNELS = [
  { key: 'grillTemp', channel: 'grill', label: 'Grill' },
  { key: 'probe1Temp', channel: 'probe1', label: 'Probe 1' },
  { key: 'probe2Temp', channel: 'probe2', label: 'Probe 2' },
  { key: 'probe3Temp', channel: 'probe3', label: 'Probe 3' },
  { key: 'probe4Temp', channel: 'probe4', label: 'Probe 4' },
] as const;

/** `waiting`, `live` and `stale` are the panel's states; `connecting` is only the first connect. */
export type PanelState = 'connecting' | 'waiting' | 'live' | 'stale';

/**
 * The live readings of an active cook's device, pushed over SignalR.
 *
 * Opens one hub connection on mount and stops it on unmount. Shows
 * `temperature` messages for the cook's device, and after every start and
 * reconnect backfills with GET /temperatures/current. Each `temperature`
 * message it accepts (the cook's device only) is also passed to `onReading`,
 * so the page can use this one connection for other views (the chart). On
 * `cook_stopped` for this cook it stops the connection and calls
 * `onCookStopped`.
 */
export function LivePanel({
  cook,
  onCookStopped,
  onReading,
}: {
  cook: Cook;
  onCookStopped: (message: CookStoppedMessage) => void;
  onReading?: (message: TemperatureMessage) => void;
}) {
  const api = useApi();
  const createHub = useHubFactory();
  const device = useDevice(cook.deviceId);
  const [status, setStatus] = useState<ConnectionStatus>('connecting');
  const [reading, setReading] = useState<TemperatureReading | undefined>(undefined);
  const now = useNow(true);
  const onCookStoppedRef = useRef(onCookStopped);
  onCookStoppedRef.current = onCookStopped;
  const onReadingRef = useRef(onReading);
  onReadingRef.current = onReading;

  useEffect(() => {
    let mounted = true;
    const { id: cookId, deviceId } = cook;

    // Keep whichever reading is newer: a backfill can race a push.
    const show = (next: TemperatureReading) => {
      if (!mounted) return;
      setReading(previous =>
        previous && Date.parse(next.timestamp) < Date.parse(previous.timestamp) ? previous : next
      );
    };

    const backfill = async () => {
      try {
        const { data } = await api.GET('/temperatures/current/{deviceId}', {
          params: { path: { deviceId } },
        });
        // 404 is "no reading yet"; any other failure leaves the screen as it is.
        if (data) show(data);
      } catch {
        // A failed backfill is not fatal: pushes still arrive.
      }
    };

    const stop = openLiveConnection({
      negotiate: async () => {
        const { data, response } = await api.POST('/negotiate');
        return data ? { ok: true, info: data } : { ok: false, status: response.status };
      },
      createHub,
      onStatus: next => {
        if (mounted) setStatus(next);
      },
      onConnected: () => void backfill(),
      onTemperature: message => {
        if (message.deviceId !== deviceId) return;
        show(message);
        if (mounted) onReadingRef.current?.(message);
      },
      onCookStopped: message => {
        if (message.payload.id !== cookId) return;
        stop();
        if (mounted) onCookStoppedRef.current(message);
      },
    });

    return () => {
      mounted = false;
      stop();
    };
  }, [api, createHub, cook.id, cook.deviceId]);

  const unit: TemperatureUnit = device?.configuration?.temperatureUnit ?? 'fahrenheit';
  const pollingS = device?.configuration?.pollingInterval ?? DEFAULT_POLLING_INTERVAL_S;
  const staleAfterMs = STALE_AFTER_INTERVALS * pollingS * 1000;
  const ageMs = reading ? Math.max(0, now - Date.parse(reading.timestamp)) : undefined;
  const { state, badge } = panelState(status, ageMs, staleAfterMs);

  return (
    <section
      className="card live-panel"
      data-testid="cook-live-panel"
      data-state={state}
      aria-label="Live readings"
    >
      <h2>
        Live readings{' '}
        <span className={`badge badge-${state}`} data-testid="live-badge">
          {badge}
        </span>
      </h2>
      {status === 'signed-out' && (
        <p className="problem">Your sign-in has expired. Sign out and sign in again.</p>
      )}
      {state === 'waiting' && (
        <p className="muted">
          Waiting for the first reading… After a quiet period the first one can take up to about 20
          s.
        </p>
      )}
      <dl className="live-readings">
        {CHANNELS.map(({ key, channel, label }) => (
          <div key={key} data-channel={channel}>
            <dt>{label}</dt>
            <dd>{formatTemperature(reading?.[key], unit)}</dd>
          </div>
        ))}
      </dl>
      <p className="muted" data-testid="live-reading-time">
        {reading && ageMs !== undefined
          ? `Reading at ${formatDateTime(reading.timestamp)} (${formatDuration(ageMs)} ago)`
          : 'No reading yet'}
      </p>
    </section>
  );
}

function panelState(
  status: ConnectionStatus,
  ageMs: number | undefined,
  staleAfterMs: number
): { state: PanelState; badge: string } {
  switch (status) {
    case 'connecting':
      return { state: 'connecting', badge: 'Connecting…' };
    case 'reconnecting':
      return { state: 'stale', badge: 'Reconnecting…' };
    case 'signed-out':
      return { state: 'stale', badge: 'Sign in again' };
  }
  if (ageMs === undefined) return { state: 'waiting', badge: 'Waiting' };
  if (ageMs > staleAfterMs)
    return { state: 'stale', badge: `No reading for ${formatDuration(ageMs)}` };
  return { state: 'live', badge: 'Live' };
}

/** GET /devices/{id}, for the unit and polling interval. Undefined until it answers or if it fails. */
function useDevice(deviceId: string): Device | undefined {
  const api = useApi();
  const [device, setDevice] = useState<Device | undefined>(undefined);
  useEffect(() => {
    let current = true;
    api
      .GET('/devices/{id}', { params: { path: { id: deviceId } } })
      .then(({ data }) => {
        if (current && data) setDevice(data);
      })
      .catch(() => undefined);
    return () => {
      current = false;
    };
  }, [api, deviceId]);
  return device;
}
