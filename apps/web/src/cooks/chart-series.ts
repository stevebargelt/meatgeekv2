import type { components } from '@meatgeekv2/api-specs/types';
import { toDisplayUnit, type TemperatureUnit } from '../live/format';
import type { TemperatureMessage } from '../live/hub';

export type CookChart = components['schemas']['CookChart'];

/** The chart's channels, in legend and colour order. */
export const CHART_CHANNELS = [
  { channel: 'grill', reading: 'grillTemp', label: 'Grill' },
  { channel: 'probe1', reading: 'probe1Temp', label: 'Probe 1' },
  { channel: 'probe2', reading: 'probe2Temp', label: 'Probe 2' },
  { channel: 'probe3', reading: 'probe3Temp', label: 'Probe 3' },
  { channel: 'probe4', reading: 'probe4Temp', label: 'Probe 4' },
] as const;

export type ChartChannel = (typeof CHART_CHANNELS)[number]['channel'];

/** One channel at one time, in the display unit. */
export interface ChannelValue {
  avg: number;
  lo: number;
  hi: number;
}

/** One x position: a server bucket (at its start) or a pushed reading (at its timestamp). */
export type ChartRow = { t: number } & { [C in ChartChannel]?: ChannelValue };

export interface ChartSeries {
  rows: ChartRow[];
  /** Channels with a value in at least one row, in CHART_CHANNELS order. */
  channels: ChartChannel[];
}

/** At most this many pushed readings are drawn after the server series; the newest are kept. */
export const MAX_PUSHED_ROWS = 2000;

/**
 * The rows the chart draws: the server's buckets, then the readings pushed
 * since it loaded that fall after the last bucket, all in `unit`.
 *
 * A bucket covers `[t, t + bucketSeconds)`, so a pushed reading earlier than
 * the last bucket's end is already counted in the server series and is
 * dropped. The kept ones become one row each (`avg = lo = hi`), oldest first,
 * capped at MAX_PUSHED_ROWS. Values arrive in °F and are converted with
 * formatTemperature's rules.
 */
export function buildChartSeries(
  chart: CookChart,
  pushed: readonly TemperatureMessage[],
  unit: TemperatureUnit
): ChartSeries {
  const rows: ChartRow[] = chart.points.map(point => {
    const row: ChartRow = { t: Date.parse(point.t) };
    for (const { channel } of CHART_CHANNELS) {
      const value = point[channel];
      if (value) {
        row[channel] = {
          avg: toDisplayUnit(value.avg, unit),
          lo: toDisplayUnit(value.min, unit),
          hi: toDisplayUnit(value.max, unit),
        };
      }
    }
    return row;
  });

  const last = chart.points[chart.points.length - 1];
  const seriesEnd = last ? Date.parse(last.t) + chart.bucketSeconds * 1000 : -Infinity;
  const live = pushed
    .map(message => ({ message, t: Date.parse(message.timestamp) }))
    .filter(({ t }) => t >= seriesEnd)
    .sort((a, b) => a.t - b.t)
    .slice(-MAX_PUSHED_ROWS);
  for (const { message, t } of live) {
    const row: ChartRow = { t };
    for (const { channel, reading } of CHART_CHANNELS) {
      const value = message[reading];
      if (value !== undefined) {
        const shown = toDisplayUnit(value, unit);
        row[channel] = { avg: shown, lo: shown, hi: shown };
      }
    }
    rows.push(row);
  }

  const channels = CHART_CHANNELS.map(({ channel }) => channel).filter(channel =>
    rows.some(row => row[channel] !== undefined)
  );
  return { rows, channels };
}
