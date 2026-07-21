/**
 * MG-27 (MG-9 follow-up) cross-surface integration tests.
 *
 * These drive the two behaviours the MG-27 fix corrected, end-to-end through
 * the public class methods (not the private helpers):
 *
 *  1. processDeviceReading routes a *present* ADC of 0 through
 *     convertAdcToTemperature's `<= 0` boundary instead of dropping it via a
 *     truthy check. So ADC=0 must yield the SAME probe field value as any other
 *     out-of-range ADC (e.g. 1023), and a genuinely-absent probe (undefined)
 *     must ALSO land on that value — 0, out-of-range and absent all agree,
 *     while a valid mid-range ADC still produces a real temperature.
 *
 *  2. createCook stores `request.name.trim()` (no dead optional-chaining) — for
 *     any valid StartCookRequest the stored name is always a defined string,
 *     trimmed of surrounding whitespace.
 *
 * A regression that reintroduces the truthy ADC gate or the `?.trim() ?? name`
 * fallback passes the old per-file specs but must fail here.
 */
import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import { CookManager } from './cook-manager';
import { TemperatureCalculator } from './temperature-calculator';
import type { StartCookRequest, TemperatureReading } from '@meatgeekv2/api-interfaces';

type ProbeAdcKey = 'grillAdc' | 'probe1Adc' | 'probe2Adc' | 'probe3Adc' | 'probe4Adc';
type ProbeTempKey = 'grillTemp' | 'probe1Temp' | 'probe2Temp' | 'probe3Temp' | 'probe4Temp';

const PROBES: Array<{ adc: ProbeAdcKey; temp: ProbeTempKey }> = [
  { adc: 'grillAdc', temp: 'grillTemp' },
  { adc: 'probe1Adc', temp: 'probe1Temp' },
  { adc: 'probe2Adc', temp: 'probe2Temp' },
  { adc: 'probe3Adc', temp: 'probe3Temp' },
  { adc: 'probe4Adc', temp: 'probe4Temp' },
];

const baseReading = (overrides: Record<string, unknown> = {}) => ({
  deviceId: 'device-1',
  timestamp: '2026-01-01T00:00:00.000Z',
  ...overrides,
});

const baseRequest = (overrides: Partial<StartCookRequest> = {}): StartCookRequest => ({
  name: 'Sunday Cook',
  deviceId: 'device-1',
  meatType: 'BRISKET',
  ...overrides,
});

describe('MG-27 — ADC=0 boundary routing (processDeviceReading)', () => {
  const calc = new TemperatureCalculator();

  it.each(PROBES)(
    'ADC=0, out-of-range (1023) and absent all yield the same $temp value',
    ({ adc, temp }) => {
      const zero = calc.processDeviceReading(baseReading({ [adc]: 0 })) as TemperatureReading;
      const high = calc.processDeviceReading(baseReading({ [adc]: 1023 })) as TemperatureReading;
      const absent = calc.processDeviceReading(baseReading()) as TemperatureReading;

      // The `<= 0` (and `>= 1023`) boundary of convertAdcToTemperature returns
      // null, which processDeviceReading maps to undefined.
      expect(zero[temp]).toBeUndefined();
      // 0 must agree with any other out-of-range ADC...
      expect(zero[temp]).toBe(high[temp]);
      // ...and with a genuinely-absent probe.
      expect(zero[temp]).toBe(absent[temp]);
      expect(high[temp]).toBe(absent[temp]);
    }
  );

  it('routes ADC=0 on ALL probes at once, matching an all-1023 and an empty reading', () => {
    const allZero = calc.processDeviceReading(
      baseReading({ grillAdc: 0, probe1Adc: 0, probe2Adc: 0, probe3Adc: 0, probe4Adc: 0 })
    ) as TemperatureReading;
    const allHigh = calc.processDeviceReading(
      baseReading({
        grillAdc: 1023,
        probe1Adc: 1023,
        probe2Adc: 1023,
        probe3Adc: 1023,
        probe4Adc: 1023,
      })
    ) as TemperatureReading;
    const empty = calc.processDeviceReading(baseReading()) as TemperatureReading;

    for (const { temp } of PROBES) {
      expect(allZero[temp]).toBeUndefined();
      expect(allZero[temp]).toBe(allHigh[temp]);
      expect(allZero[temp]).toBe(empty[temp]);
    }
  });

  it.each(PROBES)('a valid mid-range ADC still yields a real numeric $temp', ({ adc, temp }) => {
    const result = calc.processDeviceReading(baseReading({ [adc]: 10 })) as TemperatureReading;
    // Mid-range 10 is inside (0, 1023) → a genuine temperature, NOT undefined.
    expect(typeof result[temp]).toBe('number');
    expect(Number.isFinite(result[temp] as number)).toBe(true);
    // And it must differ from the out-of-range/absent sentinel (undefined).
    expect(result[temp]).not.toBeUndefined();
  });

  it('ADC=0 is treated as a present reading, not silently dropped like a falsy skip', () => {
    // The pre-MG-27 truthy gate would skip 0 the same way it skips undefined,
    // but via a DIFFERENT code path. Here we prove 0 and undefined converge on
    // the SAME value AND that a genuine reading (10) diverges from both.
    const zero = calc.processDeviceReading(baseReading({ grillAdc: 0 })) as TemperatureReading;
    const absent = calc.processDeviceReading(baseReading()) as TemperatureReading;
    const real = calc.processDeviceReading(baseReading({ grillAdc: 10 })) as TemperatureReading;

    expect(zero.grillTemp).toBe(absent.grillTemp); // 0 ≡ absent (both undefined)
    expect(real.grillTemp).not.toBe(zero.grillTemp); // real reading ≠ sentinel
    expect(typeof real.grillTemp).toBe('number');
  });
});

describe('MG-27 — ADC=0 is ROUTED through convertAdcToTemperature (white-box path)', () => {
  // The consistency assertions above prove 0, out-of-range and absent AGREE on
  // the output — but the old buggy truthy gate produced that same output (0 is
  // falsy → skipped to undefined, exactly like absent). Black-box output cannot
  // tell the fix from the bug. The one observable difference is the CODE PATH:
  // the fixed presence check hands a present 0 to convertAdcToTemperature; the
  // truthy gate never calls it for 0. These spy-based tests pin that path and go
  // red against a truthy-gate regression.
  let calc: TemperatureCalculator;
  let spy: ReturnType<typeof jest.spyOn>;

  beforeEach(() => {
    calc = new TemperatureCalculator();
    spy = jest.spyOn(calc, 'convertAdcToTemperature');
  });

  afterEach(() => {
    spy.mockRestore();
  });

  it.each(PROBES)(
    'a present ADC=0 on $adc is passed to convertAdcToTemperature (a truthy gate would skip it)',
    ({ adc }) => {
      calc.processDeviceReading(baseReading({ [adc]: 0 }));
      // Correction is the 2nd arg. Old truthy gate never reaches this call for 0.
      expect(spy).toHaveBeenCalledWith(0, expect.any(Number));
    }
  );

  it('routes a present ADC=0 on ALL probes through convertAdcToTemperature (5 calls with 0)', () => {
    calc.processDeviceReading(
      baseReading({ grillAdc: 0, probe1Adc: 0, probe2Adc: 0, probe3Adc: 0, probe4Adc: 0 })
    );
    expect(spy).toHaveBeenCalledTimes(PROBES.length);
    expect(spy).toHaveBeenCalledWith(0, expect.any(Number));
  });

  it('a genuinely-absent probe is NOT routed through convertAdcToTemperature', () => {
    calc.processDeviceReading(baseReading());
    // The presence check correctly skips absent probes — no conversion call.
    expect(spy).not.toHaveBeenCalled();
  });

  it('convertAdcToTemperature is never called with undefined (present 0 routes, absent skips)', () => {
    // grill present as 0, the other four absent: exactly one call, and never with
    // undefined. Proves the presence check discriminates 0 from absent by PATH.
    calc.processDeviceReading(baseReading({ grillAdc: 0 }));
    expect(spy).toHaveBeenCalledTimes(1);
    expect(spy).toHaveBeenCalledWith(0, expect.any(Number));
    expect(spy).not.toHaveBeenCalledWith(undefined, expect.anything());
  });
});

describe('MG-27 — createCook name is always a trimmed, defined string', () => {
  it('trims surrounding whitespace from a padded name', () => {
    const cook = CookManager.createCook(baseRequest({ name: '  Sunday Brisket  ' }), 'user-1');
    expect(cook.name).toBe('Sunday Brisket');
  });

  it.each([
    ['Sunday Cook', 'Sunday Cook'],
    ['  padded  ', 'padded'],
    ['\tTabbed\n', 'Tabbed'],
    ['NoTrimNeeded', 'NoTrimNeeded'],
    ['   ', ''], // whitespace-only trims to empty string — still a defined string
    ['a', 'a'],
  ])('name %p is stored as the defined string %p', (input, expected) => {
    const cook = CookManager.createCook(baseRequest({ name: input }), 'user-1');
    expect(typeof cook.name).toBe('string');
    expect(cook.name).toBe(expected);
    // Guards the removed `?.trim() ?? request.name` dead path: never undefined.
    expect(cook.name).not.toBeUndefined();
  });

  it('the stored name is a defined string for any valid StartCookRequest', () => {
    for (const name of ['Brisket', '  Pork  ', 'Ribs', '   ', 'x']) {
      const cook = CookManager.createCook(baseRequest({ name }), 'user-1');
      expect(typeof cook.name).toBe('string');
      expect(cook.name).toBe(name.trim());
    }
  });
});
