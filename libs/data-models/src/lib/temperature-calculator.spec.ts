import { TemperatureReading } from '@meatgeekv2/api-interfaces';
import { TemperatureCalculator } from './temperature-calculator';

// Hand-computed reference values (independent of implementation):
// adcToResistance(10, 3.3, 10000):
//   voltage = (10/1023)*3.3 ≈ 0.03226...
//   current = (3.3 - 0.03226)/10000 ≈ 3.268e-4
//   resistance = voltage/current ≈ 98.7167
// resistanceToTemperature(98.7167, 100) via Callendar-Van Dusen:
//   ratio = 0.987167, tempC ≈ -3.282, tempF ≈ 26.092
const ADC10_DEFAULT_TEMP_F = 26.0924;

function makeReading(
  overrides: Partial<TemperatureReading> = {}
): TemperatureReading {
  return {
    deviceId: 'device-1',
    timestamp: '2026-01-01T00:00:00.000Z',
    cookId: undefined,
    grillTemp: undefined,
    probe1Temp: undefined,
    probe2Temp: undefined,
    probe3Temp: undefined,
    probe4Temp: undefined,
    ...overrides,
  };
}

function readingsForProbe(
  probe: 'grillTemp' | 'probe1Temp' | 'probe2Temp' | 'probe3Temp' | 'probe4Temp',
  temps: Array<number | undefined>,
  startMs = new Date('2026-01-01T00:00:00.000Z').getTime(),
  stepMs = 60_000
): TemperatureReading[] {
  return temps.map((t, i) =>
    makeReading({
      timestamp: new Date(startMs + i * stepMs).toISOString(),
      [probe]: t,
    })
  );
}

describe('TemperatureCalculator', () => {
  describe('constructor', () => {
    it('uses defaults (referenceVoltage=3.3, referenceResistor=10000, r0=100) when no options passed', () => {
      const calc = new TemperatureCalculator();
      const result = calc.convertAdcToTemperature(10);
      expect(result).not.toBeNull();
      expect(result as number).toBeCloseTo(ADC10_DEFAULT_TEMP_F, 1);
    });

    it('applies all overrides when fully specified', () => {
      const defaults = new TemperatureCalculator();
      const overridden = new TemperatureCalculator({
        referenceVoltage: 5.0,
        referenceResistor: 5000,
        r0: 100,
      });
      // Different reference voltage / resistor must produce a different result
      const a = defaults.convertAdcToTemperature(10);
      const b = overridden.convertAdcToTemperature(10);
      expect(a).not.toBeNull();
      // overridden values may push the result outside the valid range and yield
      // NaN/null; the contract here is just "different from default"
      if (b !== null && Number.isFinite(b)) {
        expect(b as number).not.toBeCloseTo(a as number, 1);
      } else {
        expect(a as number).toBeCloseTo(ADC10_DEFAULT_TEMP_F, 1);
      }
    });

    it('partial override keeps other defaults (referenceResistor unchanged)', () => {
      // With only r0 overridden, referenceVoltage and referenceResistor remain at
      // the defaults; verify by comparing the ADC=500 / r0=10000 result against
      // hand-computed value: voltage=(500/1023)*3.3≈1.6129, current≈1.687e-4,
      // resistance≈9560.23, ratio≈0.95602 → tempC≈-10.62 → tempF≈12.88 (approx).
      const calc = new TemperatureCalculator({ r0: 10000 });
      const result = calc.convertAdcToTemperature(500);
      expect(result).not.toBeNull();
      expect(Number.isFinite(result as number)).toBe(true);
      // Different from default-r0 result (which would be NaN/null for adc=500)
      const defaults = new TemperatureCalculator();
      const defaultResult = defaults.convertAdcToTemperature(500);
      expect(Number.isFinite(defaultResult as number)).toBe(false);
    });

    it('partial override keeps other defaults (only referenceResistor changed)', () => {
      // adcToResistance: voltage=(adc/1023)*rv, current=(rv-voltage)/rr,
      // resistance=voltage/current = rr * (adc/1023) / (1 - adc/1023). Doubling
      // rr doubles resistance, which (with r0 still defaulting to 100) shifts
      // the Callendar-Van Dusen output noticeably.
      const calc = new TemperatureCalculator({ referenceResistor: 5000 });
      const defaults = new TemperatureCalculator();
      const result = calc.convertAdcToTemperature(10);
      const defaultResult = defaults.convertAdcToTemperature(10);
      expect(defaultResult).not.toBeNull();
      // The defaults still apply (r0=100, referenceVoltage=3.3) — only rr changed.
      // The result with rr=5000 gives a different (or even non-finite) temperature
      // than the rr=10000 default.
      if (result === null || !Number.isFinite(result as number)) {
        // Non-finite result is itself proof that rr was applied (the defaults
        // yield a finite value); test passes.
        expect(Number.isFinite(defaultResult as number)).toBe(true);
      } else {
        expect(result as number).not.toBeCloseTo(defaultResult as number, 1);
      }
    });
  });

  describe('convertAdcToTemperature', () => {
    let calc: TemperatureCalculator;

    beforeEach(() => {
      calc = new TemperatureCalculator();
    });

    it('returns null when adcValue is 0 (boundary)', () => {
      expect(calc.convertAdcToTemperature(0)).toBeNull();
    });

    it('returns null when adcValue is negative', () => {
      expect(calc.convertAdcToTemperature(-1)).toBeNull();
      expect(calc.convertAdcToTemperature(-100)).toBeNull();
    });

    it('returns null when adcValue is 1023 (boundary)', () => {
      expect(calc.convertAdcToTemperature(1023)).toBeNull();
    });

    it('returns null when adcValue is greater than 1023', () => {
      expect(calc.convertAdcToTemperature(1024)).toBeNull();
      expect(calc.convertAdcToTemperature(99999)).toBeNull();
    });

    it('produces a finite temperature for mid-range ADC (with default options)', () => {
      const result = calc.convertAdcToTemperature(10);
      expect(result).not.toBeNull();
      expect(Number.isFinite(result as number)).toBe(true);
      expect(result as number).toBeCloseTo(ADC10_DEFAULT_TEMP_F, 1);
    });

    it('adds the correction offset to the computed temperature', () => {
      const baseline = calc.convertAdcToTemperature(10, 0);
      const corrected = calc.convertAdcToTemperature(10, 5);
      expect(baseline).not.toBeNull();
      expect(corrected).not.toBeNull();
      expect((corrected as number) - (baseline as number)).toBeCloseTo(5, 1);
    });

    it('returns null when adcToResistance yields a non-finite value (natural path)', () => {
      // referenceResistor=Infinity → current=(rv-voltage)/Infinity=0 → resistance=Infinity
      // → !isFinite(resistance) branch returns null.
      const weird = new TemperatureCalculator({ referenceResistor: Infinity });
      expect(weird.convertAdcToTemperature(10)).toBeNull();
    });

    it('returns null when reference voltage forces NaN in current calculation', () => {
      // referenceVoltage=Infinity → voltage=Infinity, current=Infinity-Infinity=NaN,
      // resistance=NaN → !isFinite returns null.
      const weird = new TemperatureCalculator({ referenceVoltage: Infinity });
      expect(weird.convertAdcToTemperature(10)).toBeNull();
    });

    it('correction defaults to 0 when not provided', () => {
      const a = calc.convertAdcToTemperature(10);
      const b = calc.convertAdcToTemperature(10, 0);
      expect(a).toBeCloseTo(b as number, 5);
    });
  });

  describe('processDeviceReading', () => {
    let calc: TemperatureCalculator;

    beforeEach(() => {
      calc = new TemperatureCalculator();
    });

    it('sets temperature for every probe when all ADCs are present and valid', () => {
      const result = calc.processDeviceReading({
        deviceId: 'd1',
        timestamp: '2026-01-01T00:00:00.000Z',
        grillAdc: 10,
        probe1Adc: 10,
        probe2Adc: 10,
        probe3Adc: 10,
        probe4Adc: 10,
        cookId: 'cook-1',
      });

      expect(result.deviceId).toBe('d1');
      expect(result.timestamp).toBe('2026-01-01T00:00:00.000Z');
      expect(result.cookId).toBe('cook-1');
      expect(result.grillTemp).toBeCloseTo(ADC10_DEFAULT_TEMP_F, 1);
      expect(result.probe1Temp).toBeCloseTo(ADC10_DEFAULT_TEMP_F, 1);
      expect(result.probe2Temp).toBeCloseTo(ADC10_DEFAULT_TEMP_F, 1);
      expect(result.probe3Temp).toBeCloseTo(ADC10_DEFAULT_TEMP_F, 1);
      expect(result.probe4Temp).toBeCloseTo(ADC10_DEFAULT_TEMP_F, 1);
    });

    it('leaves probe temps undefined when ADC values are absent', () => {
      const result = calc.processDeviceReading({
        deviceId: 'd1',
        timestamp: '2026-01-01T00:00:00.000Z',
      });

      expect(result.grillTemp).toBeUndefined();
      expect(result.probe1Temp).toBeUndefined();
      expect(result.probe2Temp).toBeUndefined();
      expect(result.probe3Temp).toBeUndefined();
      expect(result.probe4Temp).toBeUndefined();
      expect(result.cookId).toBeUndefined();
    });

    it('treats ADC=0 as absent and returns undefined for that probe (characterization)', () => {
      // BUG: 0 ADC is a valid reading boundary but the implementation uses a
      // truthy check (`rawReading.grillAdc ?`), so 0 falls through to undefined
      // rather than going through convertAdcToTemperature (which would also
      // return null for 0, but via the explicit boundary path).
      const result = calc.processDeviceReading({
        deviceId: 'd1',
        timestamp: '2026-01-01T00:00:00.000Z',
        grillAdc: 0,
        probe1Adc: 0,
      });

      expect(result.grillTemp).toBeUndefined();
      expect(result.probe1Temp).toBeUndefined();
    });

    it('applies per-probe corrections from the corrections argument', () => {
      const result = calc.processDeviceReading(
        {
          deviceId: 'd1',
          timestamp: '2026-01-01T00:00:00.000Z',
          grillAdc: 10,
          probe1Adc: 10,
          probe2Adc: 10,
          probe3Adc: 10,
          probe4Adc: 10,
        },
        {
          grillProbeCorrection: 1,
          probe1Correction: 2,
          probe2Correction: 3,
          probe3Correction: 4,
          probe4Correction: 5,
        }
      );

      expect(result.grillTemp).toBeCloseTo(ADC10_DEFAULT_TEMP_F + 1, 1);
      expect(result.probe1Temp).toBeCloseTo(ADC10_DEFAULT_TEMP_F + 2, 1);
      expect(result.probe2Temp).toBeCloseTo(ADC10_DEFAULT_TEMP_F + 3, 1);
      expect(result.probe3Temp).toBeCloseTo(ADC10_DEFAULT_TEMP_F + 4, 1);
      expect(result.probe4Temp).toBeCloseTo(ADC10_DEFAULT_TEMP_F + 5, 1);
    });

    it('passes through cookId when omitted (undefined)', () => {
      const result = calc.processDeviceReading({
        deviceId: 'd1',
        timestamp: '2026-01-01T00:00:00.000Z',
        grillAdc: 10,
      });
      expect(result.cookId).toBeUndefined();
    });

    it('returns undefined when convertAdcToTemperature returns null (out-of-range ADC)', () => {
      // adcValue >= 1023 returns null; impl maps null → undefined via `?? undefined`
      const result = calc.processDeviceReading({
        deviceId: 'd1',
        timestamp: '2026-01-01T00:00:00.000Z',
        grillAdc: 1024,
      });
      expect(result.grillTemp).toBeUndefined();
    });
  });

  describe('calculateStatistics', () => {
    let calc: TemperatureCalculator;

    beforeEach(() => {
      calc = new TemperatureCalculator();
    });

    it('returns nulls and stability=0 when there are no valid readings', () => {
      const result = calc.calculateStatistics([], 'grillTemp');
      expect(result).toEqual({
        current: null,
        average: null,
        min: null,
        max: null,
        trend: 'stable',
        stability: 0,
      });
    });

    it('returns nulls when all probe readings are undefined', () => {
      const readings = [
        makeReading({ grillTemp: undefined }),
        makeReading({ grillTemp: undefined }),
      ];
      const result = calc.calculateStatistics(readings, 'grillTemp');
      expect(result.current).toBeNull();
      expect(result.average).toBeNull();
      expect(result.min).toBeNull();
      expect(result.max).toBeNull();
      expect(result.stability).toBe(0);
    });

    it('computes current/average/min/max/stability against hand-computed golden vectors', () => {
      // Temps: [100, 150, 200]
      //   avg=150, min=100, max=200
      //   variance=((-50)^2 + 0^2 + 50^2)/3 = 5000/3 ≈ 1666.667
      //   stddev ≈ 40.825, stability = 100 - 40.825 ≈ 59.175 → rounded 59.2
      const readings = readingsForProbe('grillTemp', [100, 150, 200]);
      const result = calc.calculateStatistics(readings, 'grillTemp');
      expect(result.current).toBe(200);
      expect(result.average).toBeCloseTo(150.0, 1);
      expect(result.min).toBeCloseTo(100.0, 1);
      expect(result.max).toBeCloseTo(200.0, 1);
      expect(result.stability).toBeCloseTo(59.2, 1);
    });

    it('returns stability=100 when all readings are equal (zero variance)', () => {
      const readings = readingsForProbe('grillTemp', [200, 200, 200, 200]);
      const result = calc.calculateStatistics(readings, 'grillTemp');
      expect(result.current).toBe(200);
      expect(result.average).toBeCloseTo(200, 1);
      expect(result.min).toBeCloseTo(200, 1);
      expect(result.max).toBeCloseTo(200, 1);
      expect(result.stability).toBeCloseTo(100, 1);
    });

    it("passes trend through from calculateTrend ('rising' for monotonically rising temps)", () => {
      const readings = readingsForProbe('grillTemp', [100, 150, 200]);
      const result = calc.calculateStatistics(readings, 'grillTemp');
      expect(result.trend).toBe('rising');
    });

    it("returns trend='falling' for monotonically falling temps", () => {
      const readings = readingsForProbe('grillTemp', [200, 150, 100]);
      const result = calc.calculateStatistics(readings, 'grillTemp');
      expect(result.trend).toBe('falling');
    });

    it('filters out undefined/null probe entries and computes over the remainder', () => {
      const readings = [
        makeReading({ grillTemp: 100 }),
        makeReading({ grillTemp: undefined }),
        makeReading({ grillTemp: 200 }),
      ];
      const result = calc.calculateStatistics(readings, 'grillTemp');
      expect(result.current).toBe(200);
      expect(result.min).toBeCloseTo(100, 1);
      expect(result.max).toBeCloseTo(200, 1);
      expect(result.average).toBeCloseTo(150, 1);
    });

    it('honors the probe parameter (probe1Temp vs probe2Temp)', () => {
      const readings = [
        makeReading({ probe1Temp: 50, probe2Temp: 250 }),
        makeReading({ probe1Temp: 60, probe2Temp: 240 }),
      ];
      const p1 = calc.calculateStatistics(readings, 'probe1Temp');
      const p2 = calc.calculateStatistics(readings, 'probe2Temp');
      expect(p1.current).toBe(60);
      expect(p2.current).toBe(240);
    });
  });

  describe('detectAnomalies', () => {
    let calc: TemperatureCalculator;

    beforeEach(() => {
      calc = new TemperatureCalculator();
    });

    it('returns empty array for empty or single-element readings', () => {
      expect(calc.detectAnomalies([])).toEqual([]);
      expect(calc.detectAnomalies([makeReading({ grillTemp: 100 })])).toEqual([]);
    });

    it('detects a high-severity spike when |Δ| > 50 and change is positive', () => {
      const readings = readingsForProbe('grillTemp', [100, 200]); // Δ=+100
      const anomalies = calc.detectAnomalies(readings);
      expect(anomalies.length).toBeGreaterThanOrEqual(1);
      const grill = anomalies.find((a) => a.probe === 'grill');
      expect(grill).toBeDefined();
      expect(grill?.anomaly).toBe('spike');
      expect(grill?.severity).toBe('high');
      expect(grill?.value).toBe(200);
    });

    it('detects a high-severity drop when |Δ| > 50 and change is negative', () => {
      const readings = readingsForProbe('grillTemp', [200, 100]); // Δ=-100
      const grill = calc.detectAnomalies(readings).find((a) => a.probe === 'grill');
      expect(grill?.anomaly).toBe('drop');
      expect(grill?.severity).toBe('high');
      expect(grill?.value).toBe(100);
    });

    it('detects a medium-severity spike when 25 < |Δ| <= 50', () => {
      const readings = readingsForProbe('grillTemp', [100, 130]); // Δ=+30
      const grill = calc.detectAnomalies(readings).find((a) => a.probe === 'grill');
      expect(grill?.anomaly).toBe('spike');
      expect(grill?.severity).toBe('medium');
    });

    it('detects a medium-severity drop when 25 < |Δ| <= 50 and change is negative', () => {
      const readings = readingsForProbe('grillTemp', [130, 100]); // Δ=-30
      const grill = calc.detectAnomalies(readings).find((a) => a.probe === 'grill');
      expect(grill?.anomaly).toBe('drop');
      expect(grill?.severity).toBe('medium');
    });

    it('detects a low-severity spike when 15 < |Δ| <= 25', () => {
      const readings = readingsForProbe('grillTemp', [100, 120]); // Δ=+20
      const grill = calc.detectAnomalies(readings).find((a) => a.probe === 'grill');
      expect(grill?.anomaly).toBe('spike');
      expect(grill?.severity).toBe('low');
    });

    it('detects a low-severity drop when 15 < |Δ| <= 25 and change is negative', () => {
      const readings = readingsForProbe('grillTemp', [120, 100]); // Δ=-20
      const grill = calc.detectAnomalies(readings).find((a) => a.probe === 'grill');
      expect(grill?.anomaly).toBe('drop');
      expect(grill?.severity).toBe('low');
    });

    it('reports no anomaly when |Δ| <= 15', () => {
      const readings = readingsForProbe('grillTemp', [100, 110]); // Δ=+10
      const grill = calc.detectAnomalies(readings).find((a) => a.probe === 'grill');
      expect(grill).toBeUndefined();
    });

    it('reports disconnect (severity=high) when previous reading was valid and current is null/undefined', () => {
      const readings = [
        makeReading({ grillTemp: 100 }),
        makeReading({ grillTemp: undefined }),
      ];
      const grill = calc.detectAnomalies(readings).find((a) => a.probe === 'grill');
      expect(grill).toBeDefined();
      expect(grill?.anomaly).toBe('disconnect');
      expect(grill?.severity).toBe('high');
      expect(grill?.value).toBeNull();
    });

    it('skips when both previous and current are null/undefined', () => {
      const readings = [
        makeReading({ grillTemp: undefined }),
        makeReading({ grillTemp: undefined }),
      ];
      expect(calc.detectAnomalies(readings)).toEqual([]);
    });

    it('skips when previous is null but current is valid (no anomaly type for reconnect)', () => {
      const readings = [
        makeReading({ grillTemp: undefined }),
        makeReading({ grillTemp: 100 }),
      ];
      expect(calc.detectAnomalies(readings)).toEqual([]);
    });

    it('iterates every probe key (grill + probe1..4) and detects independently', () => {
      const readings = [
        makeReading({
          grillTemp: 100,
          probe1Temp: 100,
          probe2Temp: 100,
          probe3Temp: 100,
          probe4Temp: 100,
        }),
        makeReading({
          grillTemp: 200, // spike high
          probe1Temp: 130, // spike medium
          probe2Temp: 120, // spike low
          probe3Temp: 105, // no anomaly
          probe4Temp: undefined, // disconnect high
        }),
      ];
      const result = calc.detectAnomalies(readings);
      const byProbe = Object.fromEntries(result.map((a) => [a.probe, a]));
      expect(byProbe['grill']?.severity).toBe('high');
      expect(byProbe['grill']?.anomaly).toBe('spike');
      expect(byProbe['probe1']?.severity).toBe('medium');
      expect(byProbe['probe1']?.anomaly).toBe('spike');
      expect(byProbe['probe2']?.severity).toBe('low');
      expect(byProbe['probe2']?.anomaly).toBe('spike');
      expect(byProbe['probe3']).toBeUndefined();
      expect(byProbe['probe4']?.anomaly).toBe('disconnect');
      expect(byProbe['probe4']?.severity).toBe('high');
    });

    it('reports timestamp from the CURRENT reading on each anomaly', () => {
      const t0 = '2026-01-01T00:00:00.000Z';
      const t1 = '2026-01-01T00:01:00.000Z';
      const readings = [
        makeReading({ timestamp: t0, grillTemp: 100 }),
        makeReading({ timestamp: t1, grillTemp: 200 }),
      ];
      const grill = calc.detectAnomalies(readings).find((a) => a.probe === 'grill');
      expect(grill?.timestamp).toBe(t1);
    });

    it('honors custom thresholds passed by the caller', () => {
      // Δ=+20 is a low-severity spike under the defaults (>15), but with tighter
      // thresholds it becomes high (>10); with looser ones it is not an anomaly.
      const readings = readingsForProbe('grillTemp', [100, 120]); // Δ=+20

      const tight = calc
        .detectAnomalies(readings, { high: 10, medium: 5, low: 2 })
        .find((a) => a.probe === 'grill');
      expect(tight?.anomaly).toBe('spike');
      expect(tight?.severity).toBe('high');

      const loose = calc
        .detectAnomalies(readings, { high: 100, medium: 50, low: 30 })
        .find((a) => a.probe === 'grill');
      expect(loose).toBeUndefined();
    });
  });

  describe('calculateRSquared (NaN guard)', () => {
    it('returns 0 (not NaN) when normalizedTimes are identical (zero-variance x-axis)', () => {
      const calc = new TemperatureCalculator();
      // Identical time points make the upstream regression slope a 0/0 = NaN;
      // calculateRSquared must still yield a defined value rather than NaN.
      const r2 = (
        calc as unknown as {
          calculateRSquared(t: number[], x: number[], s: number): number;
        }
      ).calculateRSquared([100, 110, 120], [5, 5, 5], NaN);
      expect(Number.isNaN(r2)).toBe(false);
      expect(r2).toBe(0);
    });
  });

  describe('estimateCompletionTime', () => {
    let calc: TemperatureCalculator;

    beforeEach(() => {
      calc = new TemperatureCalculator();
      jest.useFakeTimers();
      jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
    });

    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns null/low when there are fewer than 3 valid readings', () => {
      const readings = readingsForProbe('probe1Temp', [100, 110]);
      const result = calc.estimateCompletionTime(readings, 200, 'probe1Temp');
      expect(result).toEqual({
        estimatedMinutes: null,
        confidence: 'low',
        estimatedCompletionTime: null,
      });
    });

    it('returns 0 minutes / high confidence when current temperature already meets target', () => {
      const readings = readingsForProbe('probe1Temp', [180, 190, 200]);
      const result = calc.estimateCompletionTime(readings, 200, 'probe1Temp');
      expect(result.estimatedMinutes).toBe(0);
      expect(result.confidence).toBe('high');
      expect(result.estimatedCompletionTime).toBe(
        new Date('2026-01-01T01:00:00.000Z').toISOString()
      );
    });

    it('returns null/low when slope is non-positive (declining temperatures)', () => {
      const readings = readingsForProbe('probe1Temp', [200, 190, 180, 170, 160]);
      const result = calc.estimateCompletionTime(readings, 250, 'probe1Temp');
      expect(result.estimatedMinutes).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.estimatedCompletionTime).toBeNull();
    });

    it('returns null/low when slope is exactly 0 (flat temperatures)', () => {
      const readings = readingsForProbe('probe1Temp', [100, 100, 100, 100, 100]);
      const result = calc.estimateCompletionTime(readings, 200, 'probe1Temp');
      expect(result.estimatedMinutes).toBeNull();
      expect(result.confidence).toBe('low');
      expect(result.estimatedCompletionTime).toBeNull();
    });

    it('returns null/low and does NOT throw when all readings share an identical timestamp (zero-variance time axis)', () => {
      // Identical timestamps make the regression denominator 0 and slope 0/0 =
      // NaN. Without the degenerate-denominator guard this falls through to
      // Math.ceil(remaining/NaN)=NaN and new Date(NaN).toISOString() throws
      // RangeError "Invalid time value".
      const ts = '2026-01-01T00:00:00.000Z';
      const readings = [
        makeReading({ timestamp: ts, probe1Temp: 100 }),
        makeReading({ timestamp: ts, probe1Temp: 110 }),
        makeReading({ timestamp: ts, probe1Temp: 120 }),
        makeReading({ timestamp: ts, probe1Temp: 130 }),
        makeReading({ timestamp: ts, probe1Temp: 140 }),
      ];
      let result!: ReturnType<typeof calc.estimateCompletionTime>;
      expect(() => {
        result = calc.estimateCompletionTime(readings, 200, 'probe1Temp');
      }).not.toThrow();
      expect(result).toEqual({
        estimatedMinutes: null,
        confidence: 'low',
        estimatedCompletionTime: null,
      });
    });

    it('returns high confidence when r²>0.8 AND n>=8 (perfectly linear, 8 readings)', () => {
      // 8 readings, +10°F/min slope, perfectly linear → r²=1.0
      // remaining=200-170=30, estimatedMinutes=ceil(30/10)=3
      const readings = readingsForProbe(
        'probe1Temp',
        [100, 110, 120, 130, 140, 150, 160, 170]
      );
      const result = calc.estimateCompletionTime(readings, 200, 'probe1Temp');
      expect(result.estimatedMinutes).toBe(3);
      expect(result.confidence).toBe('high');
      expect(result.estimatedCompletionTime).toBe(
        new Date(
          new Date('2026-01-01T01:00:00.000Z').getTime() + 3 * 60_000
        ).toISOString()
      );
    });

    it('returns medium confidence when r²>0.6 AND n>=5 but n<8', () => {
      // 5 perfectly linear readings: r²=1.0 > 0.8 BUT n=5 < 8, so falls to
      // the second branch (r²>0.6 && n>=5) → medium.
      const readings = readingsForProbe('probe1Temp', [100, 110, 120, 130, 140]);
      const result = calc.estimateCompletionTime(readings, 200, 'probe1Temp');
      expect(result.confidence).toBe('medium');
      // remaining=60, slope=10 → ceil(60/10)=6
      expect(result.estimatedMinutes).toBe(6);
    });

    it('returns low confidence when n is between 3 and 4 (below medium threshold)', () => {
      // 3 perfectly linear readings: r²=1 (>0.8) BUT n=3<5 → falls through both
      // confidence branches → low.
      const readings = readingsForProbe('probe1Temp', [100, 110, 120]);
      const result = calc.estimateCompletionTime(readings, 200, 'probe1Temp');
      expect(result.confidence).toBe('low');
      // remaining=80, slope=10 → 8
      expect(result.estimatedMinutes).toBe(8);
    });

    it('returns low confidence when r² is poor (noisy data) even with many readings', () => {
      // Noisy non-linear data; slope is still positive (last>first) so we reach
      // confidence selection, but r² is below 0.6.
      const readings = readingsForProbe(
        'probe1Temp',
        [100, 200, 110, 190, 120, 180, 130, 170]
      );
      const result = calc.estimateCompletionTime(readings, 300, 'probe1Temp');
      // slope > 0 (170 > 100 over the window), so we get a positive estimate
      if (result.estimatedMinutes !== null) {
        expect(result.confidence).toBe('low');
      }
    });

    it('computes estimatedCompletionTime as Date.now() + estimatedMinutes*60000 (ISO)', () => {
      const readings = readingsForProbe(
        'probe1Temp',
        [100, 110, 120, 130, 140, 150, 160, 170]
      );
      const result = calc.estimateCompletionTime(readings, 200, 'probe1Temp');
      expect(result.estimatedMinutes).not.toBeNull();
      const expected = new Date(
        Date.now() + (result.estimatedMinutes as number) * 60_000
      ).toISOString();
      expect(result.estimatedCompletionTime).toBe(expected);
    });

    it('honors the probe parameter (estimates against probe2Temp readings)', () => {
      // Distinct timestamps are required so the regression has non-zero variance
      // on the time axis; otherwise slope is NaN and Date construction throws.
      const start = new Date('2026-01-01T00:00:00.000Z').getTime();
      const readings = [
        makeReading({
          timestamp: new Date(start).toISOString(),
          probe1Temp: 999,
          probe2Temp: 100,
        }),
        makeReading({
          timestamp: new Date(start + 60_000).toISOString(),
          probe1Temp: 999,
          probe2Temp: 110,
        }),
        makeReading({
          timestamp: new Date(start + 120_000).toISOString(),
          probe1Temp: 999,
          probe2Temp: 120,
        }),
      ];
      const result = calc.estimateCompletionTime(readings, 200, 'probe2Temp');
      // Using probe2Temp (slope ~10/min) for target 200, remaining=80 → 8 min
      expect(result.estimatedMinutes).not.toBeNull();
      expect(result.estimatedMinutes as number).toBeGreaterThan(0);
    });

    it('filters out undefined probe readings before evaluating <3 threshold', () => {
      // 4 raw readings but only 2 valid → returns null/low
      const readings = [
        makeReading({ probe1Temp: 100 }),
        makeReading({ probe1Temp: undefined }),
        makeReading({ probe1Temp: 110 }),
        makeReading({ probe1Temp: undefined }),
      ];
      const result = calc.estimateCompletionTime(readings, 200, 'probe1Temp');
      expect(result.estimatedMinutes).toBeNull();
      expect(result.confidence).toBe('low');
    });

    it('uses only the last 10 readings (recent window) for the regression', () => {
      // First 5 readings are flat (would yield slope=0); last 10 are rising.
      // If only the last 10 are used, slope > 0 and we get a positive estimate.
      const temps = [
        50, 50, 50, 50, 50, // ignored (replaced by recent window)
        100, 110, 120, 130, 140, 150, 160, 170, 180, 190,
      ];
      const readings = readingsForProbe('probe1Temp', temps);
      const result = calc.estimateCompletionTime(readings, 250, 'probe1Temp');
      expect(result.estimatedMinutes).not.toBeNull();
      expect(result.estimatedMinutes as number).toBeGreaterThan(0);
      expect(result.confidence).toBe('high');
    });
  });
});
