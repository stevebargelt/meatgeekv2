import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Cook, CookChart, CookChartChannel, CookChartPoint } from '@meatgeekv2/api-interfaces';

import {
  principalFromRequest,
  unauthenticatedResponse,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import { getCooksRepository, type CooksRepository } from '../../shared/cosmos/cooks-repository';
import {
  getDevicesRepository,
  type DevicesRepository,
} from '../../shared/cosmos/devices-repository';
import {
  getTemperatureRollupsRepository,
  hourStartOf,
  ROLLUP_CHANNELS,
  type ChannelStats,
  type HourSlots,
  type TemperatureRollupsRepository,
} from '../../shared/cosmos/temperature-rollups-repository';
import { claimedAtBound } from '../../shared/devices/readings-bound';
import {
  correlationIdOf,
  errorBody,
  jsonResponse,
  serverError,
  validationError,
} from '../devices/devices-http';
import { COOK_ID_MAX_LENGTH } from './get-cook';

/**
 * HAR-86 — GET /cooks/{cookId}/chart: the whole cook as at most
 * {@link MAX_CHART_POINTS} points, from the rollup read model.
 *
 * 1. The cook: one point read of `(userId, cookId)` in the caller's partition,
 *    exactly as GET /cooks/{cookId} does it. Absent, another user's and a
 *    device-lock id are the same 404 NOT_FOUND; a bad id is 400 with no Cosmos
 *    call. The cook read IS the ownership check: the device queried is the one
 *    stored on the caller's own cook.
 * 2. The window. A cook with an `endTime` (stopped) covers `[startTime,
 *    endTime)`. An active cook covers every reading from `startTime` on, with
 *    NO upper bound: that is what "active" means, and the standing-cook RU
 *    proof (HAR-87) relies on it. It is a time window on the device, not a
 *    `cookId` tag match.
 *    HAR-136: when the caller owns the device and it has `claimedAt`, the
 *    window starts no earlier than the first whole minute at or after
 *    `claimedAt` ({@link clampWindowToClaim}), so readings from before the
 *    claim never reach the chart. That costs one point read of the device. A
 *    device without `claimedAt`, or one the caller no longer owns, is not
 *    bounded this way (the cook's own window still applies).
 * 3. The rollups: ONE single-partition query on `temperature-rollups` for the
 *    device's hour documents with `hourStart` ≥ the hour containing
 *    `startTime` (and < `endTime` when there is one). Minute slots outside the
 *    window are then dropped: a slot is kept when it starts at or after the
 *    minute containing `startTime` and, for a stopped cook, before `endTime`.
 * 4. Buckets. `bucketSeconds` is the smallest of {@link BUCKET_SECONDS} that
 *    keeps the window at {@link MAX_CHART_POINTS} buckets or fewer. The span is
 *    measured from the start of `startTime`'s minute (the first slot that can
 *    be in the window) to `endTime`, or, for an active cook, to the later of
 *    now and the end of the last minute with data. Buckets start at that first
 *    minute, so a point's `t` is `startMinute + k × bucketSeconds`. (Past 180
 *    days even 6 h buckets overflow; then only the newest 720 are returned.)
 * 5. Each bucket merges its minute slots per channel: `min` of mins, `max` of
 *    maxes, `avg` = Σsum / Σn. Channels with no reading and buckets with no
 *    channel are left out.
 *
 * Every response carries `X-Request-ID`; every response that reached Cosmos
 * carries `x-meatgeek-request-charge`, the SUM of the point reads and every
 * query page.
 */

/** The bucket widths the chart may use, narrowest first. */
export const BUCKET_SECONDS = [60, 120, 300, 600, 900, 1800, 3600, 7200, 14400, 21600] as const;

/** The most points a chart holds. */
export const MAX_CHART_POINTS = 720;

const MINUTE_MS = 60_000;

/** Injection seam. Production wires Easy Auth, the two adapter-backed
 *  repositories and the real clock; tests pass fakes. */
export interface GetCookChartDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getCooksRepository(): Pick<CooksRepository, 'getCook'>;
  getDevicesRepository(): Pick<DevicesRepository, 'getDeviceOwnership'>;
  getRollupsRepository(): Pick<TemperatureRollupsRepository, 'queryHours'>;
  now(): number;
}

const defaultDeps: GetCookChartDeps = {
  resolvePrincipal: principalFromRequest,
  getCooksRepository,
  getDevicesRepository,
  getRollupsRepository: getTemperatureRollupsRepository,
  now: () => Date.now(),
};

/** The time window a cook's chart covers, in epoch ms. */
export interface ChartWindow {
  /** Start of the minute containing `startTime`: the first slot kept. */
  readonly startMinuteMs: number;
  /** Exclusive end (`endTime`); absent for an active cook. */
  readonly endMs?: number;
}

/** The window of a cook, or `undefined` when its times do not parse. */
export function chartWindowOf(cook: Pick<Cook, 'startTime' | 'endTime'>): ChartWindow | undefined {
  const startMs = Date.parse(cook.startTime);
  if (!Number.isFinite(startMs)) {
    return undefined;
  }
  const startMinuteMs = Math.floor(startMs / MINUTE_MS) * MINUTE_MS;
  if (cook.endTime === undefined) {
    return { startMinuteMs };
  }
  const endMs = Date.parse(cook.endTime);
  return Number.isFinite(endMs) ? { startMinuteMs, endMs } : undefined;
}

/**
 * HAR-136 — the window narrowed to readings from the caller's claim onward:
 * its first slot is the first whole minute at or after `claimedAtMs`, so a
 * minute slot that may hold a reading from before the claim is never shown.
 * `undefined` (no claim bound) leaves the window as it is.
 */
export function clampWindowToClaim(
  window: ChartWindow,
  claimedAtMs: number | undefined
): ChartWindow {
  if (claimedAtMs === undefined) {
    return window;
  }
  const firstWholeMinuteMs = Math.ceil(claimedAtMs / MINUTE_MS) * MINUTE_MS;
  if (firstWholeMinuteMs <= window.startMinuteMs) {
    return window;
  }
  return { ...window, startMinuteMs: firstWholeMinuteMs };
}

/** The smallest bucket width that keeps `spanMs` at {@link MAX_CHART_POINTS}
 *  buckets or fewer (the widest when even that does not). */
export function bucketSecondsFor(spanMs: number): number {
  for (const seconds of BUCKET_SECONDS) {
    if (Math.ceil(Math.max(spanMs, 0) / (seconds * 1000)) <= MAX_CHART_POINTS) {
      return seconds;
    }
  }
  return BUCKET_SECONDS[BUCKET_SECONDS.length - 1];
}

interface Slot {
  readonly startMs: number;
  readonly channels: HourSlots[string];
}

function isStats(value: unknown): value is ChannelStats {
  const stats = value as Partial<ChannelStats> | null | undefined;
  return (
    stats !== null &&
    typeof stats === 'object' &&
    [stats.n, stats.min, stats.max, stats.sum].every(
      field => typeof field === 'number' && Number.isFinite(field)
    ) &&
    (stats.n as number) > 0
  );
}

/** The minute slots of the hours that fall inside the window. */
function slotsInWindow(
  hours: ReadonlyArray<{ hourStart: string; slots: HourSlots }>,
  window: ChartWindow
): Slot[] {
  const slots: Slot[] = [];
  for (const hour of hours) {
    const hourMs = Date.parse(hour.hourStart);
    if (!Number.isFinite(hourMs)) {
      continue;
    }
    for (const [minute, channels] of Object.entries(hour.slots)) {
      const index = Number(minute);
      if (!Number.isInteger(index) || index < 0 || index > 59) {
        continue;
      }
      const startMs = hourMs + index * MINUTE_MS;
      if (startMs < window.startMinuteMs) continue;
      if (window.endMs !== undefined && startMs >= window.endMs) continue;
      slots.push({ startMs, channels });
    }
  }
  return slots;
}

/**
 * Builds the chart of `cook` from its device's rollup hours. Pure: `nowMs` is
 * passed in.
 */
export function buildCookChart(
  cook: Cook,
  window: ChartWindow,
  hours: ReadonlyArray<{ hourStart: string; slots: HourSlots }>,
  nowMs: number
): CookChart {
  const slots = slotsInWindow(hours, window);

  let spanEndMs: number;
  if (window.endMs !== undefined) {
    spanEndMs = window.endMs;
  } else {
    const lastSlotEnd = slots.reduce(
      (latest, slot) => Math.max(latest, slot.startMs + MINUTE_MS),
      0
    );
    spanEndMs = Math.max(nowMs, lastSlotEnd);
  }
  const bucketSeconds = bucketSecondsFor(spanEndMs - window.startMinuteMs);
  const bucketMs = bucketSeconds * 1000;

  const buckets = new Map<number, Map<string, ChannelStats>>();
  for (const slot of slots) {
    const bucketStart =
      window.startMinuteMs +
      Math.floor((slot.startMs - window.startMinuteMs) / bucketMs) * bucketMs;
    let channels = buckets.get(bucketStart);
    for (const channel of ROLLUP_CHANNELS) {
      const stats = slot.channels?.[channel];
      if (!isStats(stats)) continue;
      if (!channels) {
        channels = new Map();
        buckets.set(bucketStart, channels);
      }
      const merged = channels.get(channel);
      channels.set(
        channel,
        merged
          ? {
              n: merged.n + stats.n,
              min: Math.min(merged.min, stats.min),
              max: Math.max(merged.max, stats.max),
              sum: merged.sum + stats.sum,
            }
          : { n: stats.n, min: stats.min, max: stats.max, sum: stats.sum }
      );
    }
  }

  // Past 720 × 6 h (180 days) even the widest bucket overflows; the newest
  // MAX_CHART_POINTS buckets are kept so the contract's bound always holds.
  const points: CookChartPoint[] = [...buckets.entries()]
    .sort(([a], [b]) => a - b)
    .slice(-MAX_CHART_POINTS)
    .map(([bucketStart, channels]) => {
      const point: CookChartPoint = { t: new Date(bucketStart).toISOString() };
      for (const channel of ROLLUP_CHANNELS) {
        const stats = channels.get(channel);
        if (stats) {
          const value: CookChartChannel = {
            min: stats.min,
            max: stats.max,
            avg: stats.sum / stats.n,
          };
          point[channel] = value;
        }
      }
      return point;
    });

  const chart: CookChart = {
    cookId: cook.id,
    deviceId: cook.deviceId,
    startTime: cook.startTime,
    bucketSeconds,
    points,
  };
  if (cook.endTime !== undefined) {
    chart.endTime = cook.endTime;
  }
  return chart;
}

export async function getCookChartHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: GetCookChartDeps = defaultDeps
): Promise<HttpResponseInit> {
  context.log('Processing getCookChart request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const cookId = request.params['cookId'] ?? '';
  if (cookId.length === 0 || cookId.length > COOK_ID_MAX_LENGTH) {
    return validationError(
      `cookId must be 1-${COOK_ID_MAX_LENGTH} characters`,
      correlationId,
      context
    );
  }

  let spent = 0;
  try {
    const { cook, requestCharge: readCharge } = await deps
      .getCooksRepository()
      .getCook(principal.principal.userId, cookId);
    spent += readCharge;
    if (!cook) {
      return jsonResponse(
        404,
        errorBody('NOT_FOUND', 'Cook not found', context),
        correlationId,
        spent
      );
    }

    const cookWindow = chartWindowOf(cook);
    if (!cookWindow) {
      // A stored cook whose times do not parse: data the API never writes.
      throw new Error('cook_time_unparseable');
    }

    // HAR-136: when the caller owns the device and claimed it, only readings
    // from the claim onward. One point read on the devices container.
    const ownership = await deps
      .getDevicesRepository()
      .getDeviceOwnership(principal.principal.userId, cook.deviceId);
    spent += ownership.requestCharge;
    const window =
      ownership.status === 'owned'
        ? clampWindowToClaim(cookWindow, claimedAtBound(ownership.device))
        : cookWindow;
    const fromHourStart = new Date(hourStartOf(window.startMinuteMs)).toISOString();
    const toHourStart =
      window.endMs === undefined ? undefined : new Date(window.endMs).toISOString();

    const { hours, requestCharge: queryCharge } = await deps.getRollupsRepository().queryHours({
      deviceId: cook.deviceId,
      fromHourStart,
      toHourStart,
    });
    spent += queryCharge;

    const chart = buildCookChart(cook, window, hours, deps.now());
    context.log(
      `getCookChart hours=${hours.length} points=${chart.points.length} ` +
        `bucketSeconds=${chart.bucketSeconds} requestCharge=${spent}`
    );
    return jsonResponse(200, chart, correlationId, spent);
  } catch (error) {
    return serverError(
      'getCookChart',
      'Failed to retrieve cook chart',
      error,
      correlationId,
      context,
      spent
    );
  }
}
