import { VALIDATION } from '@meatgeekv2/utils';
import { generateReading, generateSeries, SimulatorOptions } from './simulator';
import { TemperatureSeries } from './series';
import { MOCK_DEVICES, findDeviceById } from './fixtures';

const SEED = 'deterministic-seed-001';
const DEVICE_ID = 'meatgeek3';

function baseOptions(overrides: Partial<SimulatorOptions> = {}): SimulatorOptions {
  return {
    seed: SEED,
    deviceId: DEVICE_ID,
    startTimeMs: Date.UTC(2026, 0, 1, 12, 0, 0),
    ...overrides,
  };
}

describe('simulator: temperature bounds', () => {
  it('every generated reading falls within VALIDATION.TEMPERATURE bounds', () => {
    const series = generateSeries(baseOptions(), 0, 720, 1);
    expect(series.length).toBeGreaterThan(0);

    for (const r of series) {
      for (const probe of ['grillTemp', 'probe1Temp', 'probe2Temp'] as const) {
        const v = r[probe];
        if (v === undefined) continue;
        expect(v).toBeGreaterThanOrEqual(VALIDATION.TEMPERATURE.MIN);
        expect(v).toBeLessThanOrEqual(VALIDATION.TEMPERATURE.MAX);
      }
    }
  });
});

describe('simulator: determinism', () => {
  it('same seed yields the same series across invocations', () => {
    const a = generateSeries(baseOptions(), 0, 60, 1);
    const b = generateSeries(baseOptions(), 0, 60, 1);
    expect(b).toEqual(a);
  });

  it('different seeds diverge', () => {
    const a = generateReading(15, baseOptions({ seed: 'seed-A' }));
    const b = generateReading(15, baseOptions({ seed: 'seed-B' }));
    expect(a.grillTemp).not.toEqual(b.grillTemp);
  });
});

describe('simulator: grill within setpoint ±10°F over 60 minutes', () => {
  it('after warmup, grill stays within configured setpoint ±10°F', () => {
    const setpoint = 225;
    // Sample every minute from minute 15 (post-warmup) through minute 60.
    const readings = generateSeries(
      baseOptions({ setpoint }),
      15,
      60,
      1,
    );
    for (const r of readings) {
      expect(r.grillTemp).toBeDefined();
      const drift = Math.abs((r.grillTemp ?? 0) - setpoint);
      expect(drift).toBeLessThanOrEqual(10);
    }
  });

  it('honors a non-default setpoint', () => {
    const setpoint = 325;
    const readings = generateSeries(
      baseOptions({ setpoint }),
      15,
      60,
      1,
    );
    for (const r of readings) {
      const drift = Math.abs((r.grillTemp ?? 0) - setpoint);
      expect(drift).toBeLessThanOrEqual(10);
    }
  });
});

describe('simulator: probe stall plateau', () => {
  it('probe is non-decreasing across the stall band within tolerance', () => {
    const options = baseOptions({
      cookDurationMinutes: 600,
      stallTemp: 165,
      probeFinishTemp: 203,
    });
    const stallStart = 600 * 0.45;
    const stallEnd = 600 * 0.75;
    const samples: number[] = [];
    for (let m = Math.floor(stallStart); m <= Math.ceil(stallEnd); m += 5) {
      const r = generateReading(m, options);
      samples.push(r.probe1Temp ?? 0);
    }
    expect(samples.length).toBeGreaterThan(2);

    const tolerance = 1.0;
    for (let i = 1; i < samples.length; i++) {
      expect(samples[i]).toBeGreaterThanOrEqual(samples[i - 1] - tolerance);
    }

    const min = Math.min(...samples);
    const max = Math.max(...samples);
    expect(min).toBeGreaterThanOrEqual(160);
    expect(max).toBeLessThanOrEqual(172);
  });

  it('reaches finish temperature near end of cook', () => {
    const options = baseOptions({
      cookDurationMinutes: 600,
      probeFinishTemp: 203,
    });
    const finalReading = generateReading(600, options);
    expect(finalReading.probe1Temp).toBeGreaterThanOrEqual(200);
    expect(finalReading.probe1Temp).toBeLessThanOrEqual(206);
  });
});

describe('TemperatureSeries cache', () => {
  it('current() generates a reading and stores it; history() returns it', () => {
    let nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const series = new TemperatureSeries({
      seed: SEED,
      deviceId: DEVICE_ID,
      startTimeMs: nowMs,
      now: () => nowMs,
      cacheSize: 5,
    });

    nowMs += 30_000;
    series.current();
    nowMs += 30_000;
    series.current();

    const hist = series.history();
    expect(hist).toHaveLength(2);
    expect(hist[0].deviceId).toBe(DEVICE_ID);
  });

  it('respects cacheSize (evicts oldest)', () => {
    let nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const series = new TemperatureSeries({
      seed: SEED,
      deviceId: DEVICE_ID,
      startTimeMs: nowMs,
      now: () => nowMs,
      cacheSize: 3,
    });
    for (let i = 0; i < 6; i++) {
      nowMs += 60_000;
      series.current();
    }
    expect(series.history()).toHaveLength(3);
  });

  it('backfill populates history', () => {
    const nowMs = Date.UTC(2026, 0, 1, 12, 0, 0);
    const series = new TemperatureSeries({
      seed: SEED,
      deviceId: DEVICE_ID,
      startTimeMs: nowMs - 30 * 60_000,
      now: () => nowMs,
      cacheSize: 100,
    });
    series.backfill(10, 30);
    const hist = series.history();
    expect(hist.length).toBeGreaterThan(15);
    expect(hist.length).toBeLessThanOrEqual(100);
  });
});

describe('fixtures', () => {
  it("includes a device with id 'meatgeek3' matching the existing handler", () => {
    const dev = findDeviceById('meatgeek3');
    expect(dev).toBeDefined();
    expect(dev?.model).toBe('MeatGeek V1');
    expect(MOCK_DEVICES.map((d) => d.id)).toContain('meatgeek3');
  });
});
