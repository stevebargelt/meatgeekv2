import { makeTemperature } from '../test/fakes';
import { MAX_PUSHED_ROWS, buildChartSeries, type CookChart } from './chart-series';

const HOUR_MS = 3600 * 1000;
const T0 = Date.parse('2026-11-20T14:00:00.000Z');
const iso = (ms: number) => new Date(ms).toISOString();

function makeChart(points: CookChart['points'], bucketSeconds: CookChart['bucketSeconds'] = 3600) {
  return {
    cookId: 'cook-1',
    deviceId: 'meatgeek3',
    startTime: iso(T0),
    bucketSeconds,
    points,
  } satisfies CookChart;
}

const TWO_HOURS = makeChart([
  {
    t: iso(T0),
    grill: { min: 220, max: 240, avg: 230 },
    probe1: { min: 40, max: 120, avg: 80 },
  },
  {
    t: iso(T0 + HOUR_MS),
    grill: { min: 225, max: 235, avg: 229.5 },
    probe1: { min: 120, max: 150, avg: 135 },
  },
]);

describe('buildChartSeries', () => {
  it('maps min, max and avg to lo, hi and avg for each channel, at the bucket start', () => {
    const { rows, channels } = buildChartSeries(TWO_HOURS, [], 'fahrenheit');
    expect(rows).toEqual([
      { t: T0, grill: { avg: 230, lo: 220, hi: 240 }, probe1: { avg: 80, lo: 40, hi: 120 } },
      {
        t: T0 + HOUR_MS,
        grill: { avg: 229.5, lo: 225, hi: 235 },
        probe1: { avg: 135, lo: 120, hi: 150 },
      },
    ]);
    expect(channels).toEqual(['grill', 'probe1']);
  });

  it('omits a channel absent from every point, and keeps one present in only some', () => {
    const chart = makeChart([
      { t: iso(T0), grill: { min: 1, max: 3, avg: 2 } },
      {
        t: iso(T0 + HOUR_MS),
        grill: { min: 1, max: 3, avg: 2 },
        probe3: { min: 5, max: 5, avg: 5 },
      },
    ]);
    const { rows, channels } = buildChartSeries(chart, [], 'fahrenheit');
    expect(channels).toEqual(['grill', 'probe3']);
    expect(rows[0]).not.toHaveProperty('probe3');
    for (const row of rows) {
      expect(row).not.toHaveProperty('probe1');
      expect(row).not.toHaveProperty('probe2');
      expect(row).not.toHaveProperty('probe4');
    }
  });

  it('drops a pushed reading inside the last bucket and appends one after it', () => {
    const lastBucketEnd = T0 + 2 * HOUR_MS;
    const inside = makeTemperature({ timestamp: iso(lastBucketEnd - 1000), grillTemp: 999 });
    const atEnd = makeTemperature({ timestamp: iso(lastBucketEnd), grillTemp: 231 });
    const after = makeTemperature({
      timestamp: iso(lastBucketEnd + 30_000),
      grillTemp: 232,
      probe1Temp: undefined,
      probe2Temp: 70,
    });

    const { rows, channels } = buildChartSeries(TWO_HOURS, [after, inside, atEnd], 'fahrenheit');

    expect(rows).toHaveLength(4);
    expect(rows[2]).toEqual({
      t: lastBucketEnd,
      grill: { avg: 231, lo: 231, hi: 231 },
      probe1: { avg: 150, lo: 150, hi: 150 },
    });
    expect(rows[3]).toEqual({
      t: lastBucketEnd + 30_000,
      grill: { avg: 232, lo: 232, hi: 232 },
      probe2: { avg: 70, lo: 70, hi: 70 },
    });
    expect(rows.some(row => row.grill?.avg === 999)).toBe(false);
    expect(channels).toEqual(['grill', 'probe1', 'probe2']);
  });

  it('appends every pushed reading when the chart has no points', () => {
    const pushed = [makeTemperature({ timestamp: iso(T0), grillTemp: 200, probe1Temp: undefined })];
    const { rows, channels } = buildChartSeries(makeChart([]), pushed, 'fahrenheit');
    expect(rows).toEqual([{ t: T0, grill: { avg: 200, lo: 200, hi: 200 } }]);
    expect(channels).toEqual(['grill']);
  });

  it(`caps pushed rows at ${MAX_PUSHED_ROWS}, keeping the newest`, () => {
    const start = T0 + 2 * HOUR_MS;
    const pushed = Array.from({ length: MAX_PUSHED_ROWS + 50 }, (_, i) =>
      makeTemperature({ timestamp: iso(start + i * 1000), grillTemp: i })
    );
    const { rows } = buildChartSeries(TWO_HOURS, pushed.reverse(), 'fahrenheit');
    expect(rows).toHaveLength(2 + MAX_PUSHED_ROWS);
    const live = rows.slice(2);
    expect(live[0].grill?.avg).toBe(50);
    expect(live[live.length - 1].grill?.avg).toBe(MAX_PUSHED_ROWS + 49);
    // Oldest first.
    expect(live.every((row, i) => i === 0 || row.t > live[i - 1].t)).toBe(true);
  });

  it('converts server and pushed values to celsius with formatTemperature rounding', () => {
    const pushed = [
      makeTemperature({ timestamp: iso(T0 + 2 * HOUR_MS), grillTemp: 225, probe1Temp: 32 }),
    ];
    const { rows } = buildChartSeries(TWO_HOURS, pushed, 'celsius');
    // 230 °F = 110 °C, 220 °F = 104.4 °C, 240 °F = 115.6 °C.
    expect(rows[0].grill).toEqual({ avg: 110, lo: 104.4, hi: 115.6 });
    expect(rows[1].grill).toEqual({ avg: 109.7, lo: 107.2, hi: 112.8 });
    expect(rows[2]).toEqual({
      t: T0 + 2 * HOUR_MS,
      grill: { avg: 107.2, lo: 107.2, hi: 107.2 },
      probe1: { avg: 0, lo: 0, hi: 0 },
    });
  });
});
