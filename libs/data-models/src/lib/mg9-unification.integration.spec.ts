/**
 * MG-9 cross-surface unification integration tests.
 *
 * Unlike the per-file unit specs (cook-manager.spec / validation.spec /
 * temperature-calculator.spec), these tests drive BOTH surfaces together and
 * assert they AGREE — the whole point of MG-9 was to collapse cook-manager and
 * DataValidator onto the single @meatgeekv2/utils source of truth (resolveMeatType,
 * VALIDATION.WEIGHT, trim-before-validate). A regression that re-forks either
 * surface passes its own unit spec but must fail here.
 */
import { describe, expect, it } from '@jest/globals';
import { CookManager } from './cook-manager';
import { DataValidator } from './validation';
import { TemperatureCalculator } from './temperature-calculator';
import { MEAT_TYPES, VALIDATION, resolveMeatType } from '@meatgeekv2/utils';
import type { StartCookRequest } from '@meatgeekv2/api-interfaces';
import type { TemperatureReading } from '@meatgeekv2/api-interfaces';

const UUIDV4_COOK_ID = /^cook-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

const baseRequest = (overrides: Partial<StartCookRequest> = {}): StartCookRequest => ({
  name: 'Sunday Cook',
  deviceId: 'device-1',
  meatType: 'BRISKET',
  ...overrides,
});

// The two surfaces expose weight problems through DIFFERENT message strings, so
// cross-surface agreement is asserted on CLASSIFICATION (error / warning / clean),
// not on exact copy. With an otherwise-valid input the only error/warning that
// can appear is the weight one.
const cookManagerWeightClass = (weight: number) => {
  const r = CookManager.validateCook({
    name: 'Sunday Cook',
    deviceId: 'device-1',
    meatType: 'BRISKET',
    weight,
  });
  return { error: r.errors.length > 0, warning: r.warnings.length > 0 };
};

const validatorWeightClass = (weight: number) => {
  const r = DataValidator.validateStartCookRequest(baseRequest({ weight }));
  return {
    error: r.errors.length > 0,
    warning: (r.warnings ?? []).length > 0,
  };
};

describe('MG-9 cross-surface unification', () => {
  describe('resolveMeatType is the single resolver behind both surfaces', () => {
    // 'Pork Shoulder' (display name) and 'PORK_SHOULDER' (canonical key) must
    // resolve identically everywhere they are consulted.
    it.each([['Pork Shoulder'], ['PORK_SHOULDER'], ['pork shoulder']])(
      'resolves %s to the canonical PORK_SHOULDER key on every surface',
      input => {
        // 1. utils resolver itself
        expect(resolveMeatType(input)).toBe('PORK_SHOULDER');

        // 2. cook-manager surface: createCook derives its default targetTemps
        //    from the resolved MEAT_TYPES entry (verbatim meatType is stored,
        //    the RESOLUTION shows up in the derived temps).
        const cook = CookManager.createCook(
          baseRequest({ meatType: input, targetTemps: undefined }),
          'user-1'
        );
        expect(cook.targetTemps).toEqual({
          grill: MEAT_TYPES.PORK_SHOULDER.defaultGrillTemp,
          probe1: MEAT_TYPES.PORK_SHOULDER.defaultMeatTemp,
        });

        // 3. DataValidator surface: a resolvable meat type raises no
        //    "not recognized" warning.
        const validation = DataValidator.validateStartCookRequest(baseRequest({ meatType: input }));
        expect(validation.warnings ?? []).not.toContain(`'${input}' is not a recognized meat type`);
      }
    );

    it('display-name and key inputs produce the SAME derived targetTemps on cook-manager', () => {
      const fromName = CookManager.createCook(
        baseRequest({ meatType: 'Pork Shoulder', targetTemps: undefined }),
        'user-1'
      );
      const fromKey = CookManager.createCook(
        baseRequest({ meatType: 'PORK_SHOULDER', targetTemps: undefined }),
        'user-1'
      );
      expect(fromName.targetTemps).toEqual(fromKey.targetTemps);
    });

    it('rejects an unknown meat type on BOTH surfaces', () => {
      const unknown = 'Dragon Ribs';

      // utils resolver
      expect(resolveMeatType(unknown)).toBeUndefined();

      // cook-manager: no MEAT_TYPES config → no derived default temps
      const cook = CookManager.createCook(
        baseRequest({ meatType: unknown, targetTemps: undefined }),
        'user-1'
      );
      expect(cook.targetTemps).toEqual({ grill: undefined, probe1: undefined });

      // DataValidator: emits the "not recognized" warning
      const validation = DataValidator.validateStartCookRequest(baseRequest({ meatType: unknown }));
      expect(validation.warnings ?? []).toContain(`'${unknown}' is not a recognized meat type`);
    });
  });

  describe('unified weight contract (VALIDATION.WEIGHT) — both surfaces agree', () => {
    // Sanity-pin the shared source of truth so the table below is meaningful.
    it('reads its bounds from the shared VALIDATION.WEIGHT constant', () => {
      expect(VALIDATION.WEIGHT).toEqual({
        MIN_EXCLUSIVE: 0,
        MAX: 100,
        WARN_ABOVE: 50,
      });
    });

    it.each([
      // weight, expected classification
      [0, { error: true, warning: false }], // <= MIN_EXCLUSIVE → error
      [-5, { error: true, warning: false }], // negative → error
      [101, { error: true, warning: false }], // > MAX → error
      [150, { error: true, warning: false }], // well over MAX → error
      [51, { error: false, warning: true }], // WARN band lower edge → warning
      [75, { error: false, warning: true }], // WARN band → warning
      [100, { error: false, warning: true }], // == MAX, still in WARN band → warning
      [12, { error: false, warning: false }], // normal → clean
      [50, { error: false, warning: false }], // == WARN_ABOVE, not yet warning → clean
      [0.5, { error: false, warning: false }], // just above MIN_EXCLUSIVE → clean
    ])('weight=%p classifies the same on cook-manager and DataValidator', (weight, expected) => {
      const cm = cookManagerWeightClass(weight as number);
      const dv = validatorWeightClass(weight as number);
      // both surfaces agree with each other...
      expect(cm).toEqual(dv);
      // ...and with the documented contract
      expect(cm).toEqual(expected);
    });
  });

  describe('cookId entropy (crypto.randomUUID)', () => {
    it('mints distinct UUIDv4-shaped ids across calls (no collision)', () => {
      const ids = new Set<string>();
      for (let i = 0; i < 200; i++) {
        const cook = CookManager.createCook(baseRequest(), 'user-1');
        expect(cook.id).toMatch(UUIDV4_COOK_ID);
        ids.add(cook.id);
      }
      expect(ids.size).toBe(200);
    });

    it('two back-to-back creates never share an id', () => {
      const a = CookManager.createCook(baseRequest(), 'user-1');
      const b = CookManager.createCook(baseRequest(), 'user-1');
      expect(a.id).not.toBe(b.id);
      expect(a.id).toMatch(UUIDV4_COOK_ID);
      expect(b.id).toMatch(UUIDV4_COOK_ID);
    });
  });

  describe('cook name trim is unified (store == validate)', () => {
    it('createCook stores a trimmed name and both validators accept the padded input', () => {
      const padded = '  Sunday Brisket  ';
      const trimmed = 'Sunday Brisket';

      const cook = CookManager.createCook(baseRequest({ name: padded }), 'user-1');
      // stored trimmed
      expect(cook.name).toBe(trimmed);

      // DataValidator trims before length-checking → the padded name is valid
      const dv = DataValidator.validateStartCookRequest(baseRequest({ name: padded }));
      expect(dv.errors).not.toContain('Cook name is required');
      expect(dv.errors.some(e => e.includes('at least'))).toBe(false);

      // CookManager.validateCook on the STORED (trimmed) cook is also clean
      const cm = CookManager.validateCook(cook);
      expect(cm.errors).toEqual([]);
    });

    it('a whitespace-only name is rejected consistently across all surfaces', () => {
      // MG-28: createCook now fails fast on a whitespace-only name (was: stored '')
      // so it can never emit a Cook violating the required non-empty-name invariant.
      expect(() => CookManager.createCook(baseRequest({ name: '   ' }), 'user-1')).toThrow(
        'createCook: cook name must not be empty or whitespace-only'
      );

      // The validator surfaces flag the same whitespace-only name.
      const cm = CookManager.validateCook({ name: '   ', deviceId: 'device-1', meatType: 'BRISKET' });
      expect(cm.errors).toContain('Cook name must be at least 3 characters');

      const dv = DataValidator.validateStartCookRequest(baseRequest({ name: '   ' }));
      expect(dv.isValid).toBe(false);
      expect(dv.errors).toContain('Cook name is required');
    });
  });

  describe('validateCookNameUniqueness excludes by id, not name', () => {
    const existing: Array<{ id?: string; name: string }> = [
      { id: 'cook-abc', name: 'Brisket Night' },
    ];

    it('does NOT exclude a cook whose NAME happens to equal excludeCookId', () => {
      // excludeCookId is an opaque id. Passing the cook's NAME must not
      // accidentally exclude it — the duplicate should still be caught.
      const result = DataValidator.validateCookNameUniqueness(
        'Brisket Night',
        existing,
        'Brisket Night' // this is a NAME, not an id
      );
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('A cook with this name already exists');
    });

    it('DOES exclude the cook whose ID equals excludeCookId (self-rename allowed)', () => {
      const result = DataValidator.validateCookNameUniqueness(
        'Brisket Night',
        existing,
        'cook-abc' // matches existing[0].id
      );
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });
});

describe('MG-9 temperature-calculator hardening', () => {
  // calculateRSquared is a private helper; access it the same controlled way the
  // unit spec does so we cover the real math the estimator depends on.
  const rSquared = (
    calc: TemperatureCalculator,
    temps: number[],
    times: number[],
    slope: number
  ): number =>
    (
      calc as unknown as {
        calculateRSquared(t: number[], x: number[], s: number): number;
      }
    ).calculateRSquared(temps, times, slope);

  describe('calculateRSquared NaN guard', () => {
    it('returns a defined 0 (not NaN) when all normalizedTimes are identical', () => {
      const calc = new TemperatureCalculator();
      // Identical x-axis ⇒ upstream slope is 0/0 = NaN; the guard must keep the
      // return finite so confidence math is never poisoned.
      const r2 = rSquared(calc, [100, 110, 120], [5, 5, 5], NaN);
      expect(Number.isNaN(r2)).toBe(false);
      expect(Number.isFinite(r2)).toBe(true);
      expect(r2).toBe(0);
    });

    it('returns a sensible r-squared (~1) for a clean linear series', () => {
      const calc = new TemperatureCalculator();
      // temps rise 10°/step, times 0,1,2 ⇒ slope 10 ⇒ perfect fit.
      const r2 = rSquared(calc, [100, 110, 120], [0, 1, 2], 10);
      expect(Number.isFinite(r2)).toBe(true);
      expect(r2).toBeGreaterThan(0.99);
      expect(r2).toBeLessThanOrEqual(1);
    });
  });

  describe('detectAnomalies thresholds', () => {
    const readingsForProbe = (temps: number[]): TemperatureReading[] =>
      temps.map((grillTemp, i) => ({
        deviceId: 'device-1',
        timestamp: new Date(
          new Date('2026-01-01T00:00:00.000Z').getTime() + i * 60_000
        ).toISOString(),
        grillTemp,
      }));

    it('falls back to the documented 15/25/50°F default bands', () => {
      const calc = new TemperatureCalculator();

      // Δ below 15 → not an anomaly.
      expect(
        calc.detectAnomalies(readingsForProbe([100, 110])).find(a => a.probe === 'grill')
      ).toBeUndefined();

      // Δ=20 (>15, ≤25) → low severity.
      expect(
        calc.detectAnomalies(readingsForProbe([100, 120])).find(a => a.probe === 'grill')?.severity
      ).toBe('low');

      // Δ=30 (>25, ≤50) → medium severity.
      expect(
        calc.detectAnomalies(readingsForProbe([100, 130])).find(a => a.probe === 'grill')?.severity
      ).toBe('medium');

      // Δ=60 (>50) → high severity.
      expect(
        calc.detectAnomalies(readingsForProbe([100, 160])).find(a => a.probe === 'grill')?.severity
      ).toBe('high');
    });

    it('honors caller-supplied custom thresholds', () => {
      const calc = new TemperatureCalculator();
      const readings = readingsForProbe([100, 130]); // Δ=30

      // Tight thresholds reclassify Δ=30 as high (>20).
      expect(
        calc
          .detectAnomalies(readings, { high: 20, medium: 10, low: 5 })
          .find(a => a.probe === 'grill')?.severity
      ).toBe('high');

      // Loose thresholds suppress it entirely (Δ=30 not > 40).
      expect(
        calc
          .detectAnomalies(readings, { high: 100, medium: 60, low: 40 })
          .find(a => a.probe === 'grill')
      ).toBeUndefined();
    });
  });
});
