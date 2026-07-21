import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { CookManager } from './cook-manager';
import { COOK_STATUS, MEAT_TYPES } from '@meatgeekv2/utils';
import type {
  Cook,
  StartCookRequest,
  TemperatureReading,
} from '@meatgeekv2/api-interfaces';

const FAKE_NOW_ISO = '2026-01-01T00:00:00.000Z';

const buildCook = (overrides: Partial<Cook> = {}): Cook => ({
  id: 'cook-existing-1',
  userId: 'user-1',
  deviceId: 'device-1',
  name: 'Test Cook',
  status: COOK_STATUS.PLANNING,
  startTime: FAKE_NOW_ISO,
  meatType: 'BRISKET',
  weight: 12,
  targetTemps: { grill: 225, probe1: 203 },
  isPublic: false,
  ...overrides,
});

const buildStartRequest = (
  overrides: Partial<StartCookRequest> = {}
): StartCookRequest => ({
  name: 'Sunday Brisket',
  deviceId: 'device-1',
  meatType: 'BRISKET',
  weight: 12,
  ...overrides,
});

const buildReading = (
  overrides: Partial<TemperatureReading> = {}
): TemperatureReading => ({
  deviceId: 'device-1',
  timestamp: FAKE_NOW_ISO,
  ...overrides,
});

describe('CookManager', () => {
  describe('createCook', () => {
    beforeEach(() => {
      jest
        .useFakeTimers()
        .setSystemTime(new Date(FAKE_NOW_ISO));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns a cookId of the form cook-<uuidv4> that is unique across calls', () => {
      const a = CookManager.createCook(buildStartRequest(), 'user-7');
      const b = CookManager.createCook(buildStartRequest(), 'user-7');
      expect(a.id).toMatch(
        /^cook-[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/
      );
      expect(a.id).not.toBe(b.id);
    });

    it('trims the cook name before storing (agrees with validateCook)', () => {
      const cook = CookManager.createCook(
        buildStartRequest({ name: '  Sunday Brisket  ' }),
        'user-1'
      );
      expect(cook.name).toBe('Sunday Brisket');
    });

    it('populates default targetTemps from MEAT_TYPES for BRISKET key', () => {
      const cook = CookManager.createCook(
        buildStartRequest({ meatType: 'BRISKET', targetTemps: undefined }),
        'user-1'
      );
      expect(cook.targetTemps).toEqual({
        grill: MEAT_TYPES.BRISKET.defaultGrillTemp,
        probe1: MEAT_TYPES.BRISKET.defaultMeatTemp,
      });
    });

    it('populates default targetTemps from MEAT_TYPES for PORK_SHOULDER key', () => {
      const cook = CookManager.createCook(
        buildStartRequest({ meatType: 'PORK_SHOULDER', targetTemps: undefined }),
        'user-1'
      );
      expect(cook.targetTemps).toEqual({
        grill: MEAT_TYPES.PORK_SHOULDER.defaultGrillTemp,
        probe1: MEAT_TYPES.PORK_SHOULDER.defaultMeatTemp,
      });
    });

    it('uppercases the meatType when looking up MEAT_TYPES (lowercase input still resolves)', () => {
      const cook = CookManager.createCook(
        buildStartRequest({ meatType: 'brisket', targetTemps: undefined }),
        'user-1'
      );
      expect(cook.targetTemps).toEqual({
        grill: MEAT_TYPES.BRISKET.defaultGrillTemp,
        probe1: MEAT_TYPES.BRISKET.defaultMeatTemp,
      });
    });

    it('resolves the display name "Pork Shoulder" to the PORK_SHOULDER key and populates its default targetTemps', () => {
      const cook = CookManager.createCook(
        buildStartRequest({ meatType: 'Pork Shoulder', targetTemps: undefined }),
        'user-1'
      );
      expect(cook.targetTemps).toEqual({
        grill: MEAT_TYPES.PORK_SHOULDER.defaultGrillTemp,
        probe1: MEAT_TYPES.PORK_SHOULDER.defaultMeatTemp,
      });
    });

    it('leaves targetTemps grill/probe1 as undefined when meatType cannot be resolved', () => {
      const cook = CookManager.createCook(
        buildStartRequest({ meatType: 'Unicorn Steaks', targetTemps: undefined }),
        'user-1'
      );
      expect(cook.targetTemps).toEqual({ grill: undefined, probe1: undefined });
    });

    it('uses request.targetTemps to override the MEAT_TYPES defaults', () => {
      const overrides = { grill: 250, probe1: 200, probe2: 180 };
      const cook = CookManager.createCook(
        buildStartRequest({ meatType: 'BRISKET', targetTemps: overrides }),
        'user-1'
      );
      expect(cook.targetTemps).toEqual(overrides);
    });

    it('sets status to COOK_STATUS.PLANNING and isPublic to false', () => {
      const cook = CookManager.createCook(buildStartRequest(), 'user-1');
      expect(cook.status).toBe(COOK_STATUS.PLANNING);
      expect(cook.isPublic).toBe(false);
    });

    it('passes notes through unchanged', () => {
      const cook = CookManager.createCook(
        buildStartRequest({ notes: 'wrap at 165' }),
        'user-1'
      );
      expect(cook.notes).toBe('wrap at 165');
    });

    it('sets startTime to the current ISO string', () => {
      const cook = CookManager.createCook(buildStartRequest(), 'user-1');
      expect(cook.startTime).toBe(FAKE_NOW_ISO);
    });

    it('propagates userId, deviceId, name, meatType, weight', () => {
      const cook = CookManager.createCook(
        buildStartRequest({
          name: 'Sunday Brisket',
          deviceId: 'device-9',
          meatType: 'BRISKET',
          weight: 14.5,
        }),
        'user-42'
      );
      expect(cook.userId).toBe('user-42');
      expect(cook.deviceId).toBe('device-9');
      expect(cook.name).toBe('Sunday Brisket');
      expect(cook.meatType).toBe('BRISKET');
      expect(cook.weight).toBe(14.5);
    });
  });

  describe('startCook', () => {
    beforeEach(() => {
      jest
        .useFakeTimers()
        .setSystemTime(new Date('2026-02-15T10:30:00.000Z'));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('transitions status to COOK_STATUS.ACTIVE', () => {
      const original = buildCook({ status: COOK_STATUS.PLANNING });
      const started = CookManager.startCook(original);
      expect(started.status).toBe(COOK_STATUS.ACTIVE);
    });

    it('updates startTime to a fresh ISO string from now()', () => {
      const original = buildCook({ startTime: '2020-01-01T00:00:00.000Z' });
      const started = CookManager.startCook(original);
      expect(started.startTime).toBe('2026-02-15T10:30:00.000Z');
    });

    it('preserves all other cook fields', () => {
      const original = buildCook({
        notes: 'low and slow',
        weight: 14,
        targetTemps: { grill: 225, probe1: 203 },
      });
      const started = CookManager.startCook(original);
      expect(started.id).toBe(original.id);
      expect(started.userId).toBe(original.userId);
      expect(started.deviceId).toBe(original.deviceId);
      expect(started.notes).toBe('low and slow');
      expect(started.weight).toBe(14);
      expect(started.targetTemps).toEqual({ grill: 225, probe1: 203 });
    });
  });

  describe('updateCook', () => {
    beforeEach(() => {
      jest
        .useFakeTimers()
        .setSystemTime(new Date(FAKE_NOW_ISO));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('updates the name when name is provided', () => {
      const cook = buildCook({ name: 'Old Name' });
      const result = CookManager.updateCook(cook, { name: 'New Name' });
      expect(result.name).toBe('New Name');
    });

    it('updates the status when status is provided', () => {
      const cook = buildCook({ status: COOK_STATUS.PLANNING });
      const result = CookManager.updateCook(cook, {
        status: COOK_STATUS.PAUSED,
      });
      expect(result.status).toBe(COOK_STATUS.PAUSED);
    });

    it('merges targetTemps shallowly over existing targetTemps', () => {
      const cook = buildCook({
        targetTemps: { grill: 225, probe1: 203, probe2: 180 },
      });
      const result = CookManager.updateCook(cook, {
        targetTemps: { probe1: 210 },
      });
      expect(result.targetTemps).toEqual({
        grill: 225,
        probe1: 210,
        probe2: 180,
      });
    });

    it('updates notes when provided', () => {
      const cook = buildCook({ notes: 'orig' });
      const result = CookManager.updateCook(cook, { notes: 'updated' });
      expect(result.notes).toBe('updated');
    });

    it('updates rating when provided', () => {
      const cook = buildCook();
      const result = CookManager.updateCook(cook, { rating: 5 });
      expect(result.rating).toBe(5);
    });

    it('when endTime is provided and startTime exists, sets endTime and computes actualDuration in hours', () => {
      const cook = buildCook({ startTime: '2026-01-01T00:00:00.000Z' });
      const result = CookManager.updateCook(cook, {
        endTime: '2026-01-01T02:00:00.000Z',
      });
      // 120 minutes via calculateDuration, then / 60 = 2 hours
      expect(result.endTime).toBe('2026-01-01T02:00:00.000Z');
      expect(result.actualDuration).toBeCloseTo(2, 1);
    });

    it('when endTime is provided but startTime is empty, does not set actualDuration', () => {
      const cook = buildCook({ startTime: '' });
      const result = CookManager.updateCook(cook, {
        endTime: '2026-01-01T02:00:00.000Z',
      });
      expect(result.endTime).toBe('2026-01-01T02:00:00.000Z');
      expect(result.actualDuration).toBeUndefined();
    });

    it('does not mutate the input cook (returns a new object)', () => {
      const cook = buildCook({ name: 'Original' });
      const result = CookManager.updateCook(cook, { name: 'Changed' });
      expect(cook.name).toBe('Original');
      expect(result).not.toBe(cook);
    });

    it('does not touch fields whose updates are undefined', () => {
      const cook = buildCook({
        name: 'Keep',
        status: COOK_STATUS.PLANNING,
        notes: 'keep notes',
        rating: 3,
        targetTemps: { grill: 225 },
      });
      const result = CookManager.updateCook(cook, {});
      expect(result.name).toBe('Keep');
      expect(result.status).toBe(COOK_STATUS.PLANNING);
      expect(result.notes).toBe('keep notes');
      expect(result.rating).toBe(3);
      expect(result.targetTemps).toEqual({ grill: 225 });
    });
  });

  describe('completeCook', () => {
    beforeEach(() => {
      jest
        .useFakeTimers()
        .setSystemTime(new Date('2026-01-01T05:00:00.000Z'));
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('sets status to COMPLETED and endTime to the current ISO string', () => {
      const cook = buildCook({ startTime: '2026-01-01T00:00:00.000Z' });
      const result = CookManager.completeCook(cook);
      expect(result.status).toBe(COOK_STATUS.COMPLETED);
      expect(result.endTime).toBe('2026-01-01T05:00:00.000Z');
    });

    it('computes actualDuration in hours from startTime to now', () => {
      const cook = buildCook({ startTime: '2026-01-01T00:00:00.000Z' });
      // 5 hours = 300 minutes; impl divides by 60 → 5 hours
      const result = CookManager.completeCook(cook);
      expect(result.actualDuration).toBeCloseTo(5, 1);
    });

    it('assigns finalTemps onto maxTemps when provided', () => {
      const cook = buildCook({ startTime: '2026-01-01T00:00:00.000Z' });
      const finalTemps = { grill: 240, probe1: 205, probe2: 190 };
      const result = CookManager.completeCook(cook, finalTemps);
      expect(result.maxTemps).toEqual(finalTemps);
    });

    it('leaves actualDuration undefined when startTime is empty', () => {
      const cook = buildCook({ startTime: '' });
      const result = CookManager.completeCook(cook);
      expect(result.actualDuration).toBeUndefined();
      expect(result.endTime).toBe('2026-01-01T05:00:00.000Z');
      expect(result.status).toBe(COOK_STATUS.COMPLETED);
    });

    it('preserves prior cook fields not modified by completion', () => {
      const cook = buildCook({
        startTime: '2026-01-01T00:00:00.000Z',
        notes: 'rested 1h',
      });
      const result = CookManager.completeCook(cook);
      expect(result.id).toBe(cook.id);
      expect(result.notes).toBe('rested 1h');
      expect(result.userId).toBe(cook.userId);
    });
  });

  describe('validateCook', () => {
    it('returns isValid:true with no errors for a fully valid cook', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        weight: 12,
        targetTemps: { grill: 225, probe1: 203 },
      });
      expect(result).toEqual({ isValid: true, errors: [], warnings: [] });
    });

    it('flags a name shorter than 3 chars (after trim)', () => {
      const result = CookManager.validateCook({
        name: 'ab',
        deviceId: 'device-1',
        meatType: 'BRISKET',
      });
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Cook name must be at least 3 characters');
    });

    it('flags a missing name', () => {
      const result = CookManager.validateCook({
        deviceId: 'device-1',
        meatType: 'BRISKET',
      });
      expect(result.errors).toContain('Cook name must be at least 3 characters');
    });

    it('treats whitespace-only names as too short (validateCook trims, while createCook does not)', () => {
      // BUG: cook-manager and DataValidator disagree on name trimming —
      // CookManager.createCook passes request.name through verbatim; CookManager.validateCook
      // (and DataValidator) trims before length check. Characterization test — follow-up needed.
      const result = CookManager.validateCook({
        name: '   ',
        deviceId: 'device-1',
        meatType: 'BRISKET',
      });
      expect(result.errors).toContain('Cook name must be at least 3 characters');
    });

    it('flags a missing deviceId', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        meatType: 'BRISKET',
      });
      expect(result.errors).toContain('Device ID is required');
    });

    it('flags an empty deviceId', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: '',
        meatType: 'BRISKET',
      });
      expect(result.errors).toContain('Device ID is required');
    });

    it('flags a missing meatType', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
      });
      expect(result.errors).toContain('Meat type is required');
    });

    it('flags an empty meatType', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: '',
      });
      expect(result.errors).toContain('Meat type is required');
    });

    it('flags weight = 0 (out of (0, 100])', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        weight: 0,
      });
      expect(result.errors).toContain('Weight must be between 0 and 100 pounds');
    });

    it('flags weight < 0', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        weight: -5,
      });
      expect(result.errors).toContain('Weight must be between 0 and 100 pounds');
    });

    it('flags weight > 100', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        weight: 101,
      });
      expect(result.errors).toContain('Weight must be between 0 and 100 pounds');
    });

    it('accepts weight in (0, 100] but warns above 50 (e.g. 75)', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        weight: 75,
      });
      expect(result.isValid).toBe(true);
      expect(result.errors).not.toContain(
        'Weight must be between 0 and 100 pounds'
      );
      expect(result.warnings).toContain(
        'Weight over 50 pounds - verify this is correct'
      );
    });

    it('does not warn for weight in (0, 50]', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        weight: 40,
      });
      expect(result.warnings).not.toContain(
        'Weight over 50 pounds - verify this is correct'
      );
    });

    it('accepts undefined weight without error', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
      });
      expect(result.errors).not.toContain(
        'Weight must be between 0 and 100 pounds'
      );
    });

    it('flags grill target below 150', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        targetTemps: { grill: 100 },
      });
      expect(result.errors).toContain(
        'Grill target temperature must be between 150°F and 500°F'
      );
    });

    it('flags grill target above 500', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        targetTemps: { grill: 600 },
      });
      expect(result.errors).toContain(
        'Grill target temperature must be between 150°F and 500°F'
      );
    });

    it('accepts grill target at boundary values 150 and 500', () => {
      const low = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        targetTemps: { grill: 150 },
      });
      const high = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        targetTemps: { grill: 500 },
      });
      expect(low.errors).not.toContain(
        'Grill target temperature must be between 150°F and 500°F'
      );
      expect(high.errors).not.toContain(
        'Grill target temperature must be between 150°F and 500°F'
      );
    });

    it.each(['probe1', 'probe2', 'probe3', 'probe4'] as const)(
      'flags %s below 100',
      (probe) => {
        const result = CookManager.validateCook({
          name: 'Sunday Brisket',
          deviceId: 'device-1',
          meatType: 'BRISKET',
          targetTemps: { [probe]: 50 },
        });
        expect(result.errors).toContain(
          `${probe} target temperature must be between 100°F and 250°F`
        );
      }
    );

    it.each(['probe1', 'probe2', 'probe3', 'probe4'] as const)(
      'flags %s above 250',
      (probe) => {
        const result = CookManager.validateCook({
          name: 'Sunday Brisket',
          deviceId: 'device-1',
          meatType: 'BRISKET',
          targetTemps: { [probe]: 300 },
        });
        expect(result.errors).toContain(
          `${probe} target temperature must be between 100°F and 250°F`
        );
      }
    );

    it('accepts probes at boundary values 100 and 250', () => {
      const result = CookManager.validateCook({
        name: 'Sunday Brisket',
        deviceId: 'device-1',
        meatType: 'BRISKET',
        targetTemps: { probe1: 100, probe2: 250 },
      });
      expect(result.errors).not.toContain(
        'probe1 target temperature must be between 100°F and 250°F'
      );
      expect(result.errors).not.toContain(
        'probe2 target temperature must be between 100°F and 250°F'
      );
    });

    it('accumulates multiple errors when several fields are invalid', () => {
      const result = CookManager.validateCook({
        name: 'a',
        deviceId: '',
        meatType: '',
        weight: 200,
        targetTemps: { grill: 50, probe1: 9000 },
      });
      expect(result.isValid).toBe(false);
      expect(result.errors.length).toBeGreaterThanOrEqual(5);
    });
  });

  describe('calculateCookProgress', () => {
    it('short-circuits with zeros when cook has no targetTemps', () => {
      const cook = buildCook({ targetTemps: undefined });
      const reading = buildReading({ probe1Temp: 150 });
      const result = CookManager.calculateCookProgress(cook, reading);
      expect(result).toEqual({
        overallProgress: 0,
        probeProgress: {},
        isNearCompletion: false,
        completedProbes: [],
      });
    });

    it('skips probes with no target and skips probes with null current temp', () => {
      const cook = buildCook({
        targetTemps: { probe1: 200, probe2: 180 },
      });
      const reading = {
        ...buildReading({ probe1Temp: 135 }),
        // probe2Temp deliberately null — cast since interface forbids null
        probe2Temp: null,
      } as unknown as TemperatureReading;
      const result = CookManager.calculateCookProgress(cook, reading);

      // Only probe1 should contribute. Hand-computed: (135-70)/(200-70)*100 = 65/130*100 = 50
      expect(Object.keys(result.probeProgress)).toEqual(['probe1']);
      expect(result.probeProgress['probe1']).toBe(50);
      expect(result.overallProgress).toBe(50);
      expect(result.isNearCompletion).toBe(false);
      expect(result.completedProbes).toEqual([]);
    });

    it('marks isNearCompletion=true when overallProgress >= 90', () => {
      const cook = buildCook({ targetTemps: { probe1: 200 } });
      // Need (current-70)/130 >= 0.9 → current >= 70 + 117 = 187
      const reading = buildReading({ probe1Temp: 190 });
      const result = CookManager.calculateCookProgress(cook, reading);
      // Hand-computed: (190-70)/(200-70)*100 = 120/130*100 = 92.307... → rounds to 92
      expect(result.overallProgress).toBe(92);
      expect(result.isNearCompletion).toBe(true);
    });

    it('lists a probe in completedProbes when currentTemp >= targetTemp', () => {
      const cook = buildCook({ targetTemps: { probe1: 200, probe2: 180 } });
      const reading = buildReading({ probe1Temp: 200, probe2Temp: 150 });
      const result = CookManager.calculateCookProgress(cook, reading);
      expect(result.completedProbes).toContain('probe1');
      expect(result.completedProbes).not.toContain('probe2');
    });

    it('marks isNearCompletion=true when every active probe is in completedProbes (even if overall < 90)', () => {
      // Two probes, both at target. Hand-computed progress=100 each → overall 100,
      // but also exercises the completedProbes.length === activeProbes branch.
      const cook = buildCook({ targetTemps: { probe1: 200, probe2: 180 } });
      const reading = buildReading({ probe1Temp: 200, probe2Temp: 180 });
      const result = CookManager.calculateCookProgress(cook, reading);
      expect(result.completedProbes.sort()).toEqual(['probe1', 'probe2']);
      expect(result.isNearCompletion).toBe(true);
    });

    it('clamps progress to 100 when currentTemp far exceeds targetTemp', () => {
      const cook = buildCook({ targetTemps: { probe1: 200 } });
      const reading = buildReading({ probe1Temp: 400 });
      const result = CookManager.calculateCookProgress(cook, reading);
      expect(result.probeProgress['probe1']).toBe(100);
      expect(result.overallProgress).toBe(100);
    });

    it('clamps progress to 0 when currentTemp is below the starting temperature assumption (70)', () => {
      const cook = buildCook({ targetTemps: { probe1: 200 } });
      const reading = buildReading({ probe1Temp: 50 });
      const result = CookManager.calculateCookProgress(cook, reading);
      expect(result.probeProgress['probe1']).toBe(0);
      expect(result.overallProgress).toBe(0);
    });

    it('averages probeProgress across active probes for overallProgress', () => {
      const cook = buildCook({ targetTemps: { probe1: 200, probe2: 200 } });
      // probe1: (135-70)/130 = 50%, probe2: (200-70)/130 ≈ 100%
      // overall = round((50 + 100)/2) = 75
      const reading = buildReading({ probe1Temp: 135, probe2Temp: 200 });
      const result = CookManager.calculateCookProgress(cook, reading);
      expect(result.probeProgress['probe1']).toBe(50);
      expect(result.probeProgress['probe2']).toBe(100);
      expect(result.overallProgress).toBe(75);
    });
  });

  describe('generateCookSummary', () => {
    it('returns zeroed summary when there are no matching readings', () => {
      const cook = buildCook({ id: 'cook-1' });
      const result = CookManager.generateCookSummary(cook, []);
      expect(result).toEqual({
        cookId: 'cook-1',
        totalDuration: 0,
        averageGrillTemp: 0,
        peakGrillTemp: 0,
        averageProbeTemps: {},
        temperatureStability: 0,
      });
    });

    it('filters readings by cook.id and ignores foreign-cook readings', () => {
      const cook = buildCook({ id: 'cook-target' });
      const readings: TemperatureReading[] = [
        {
          deviceId: 'd1',
          timestamp: '2026-01-01T00:00:00.000Z',
          cookId: 'cook-other',
          grillTemp: 999,
        },
        {
          deviceId: 'd1',
          timestamp: '2026-01-01T00:00:00.000Z',
          cookId: 'cook-target',
          grillTemp: 200,
          probe1Temp: 100,
        },
        {
          deviceId: 'd1',
          timestamp: '2026-01-01T00:10:00.000Z',
          cookId: 'cook-target',
          grillTemp: 210,
          probe1Temp: 110,
        },
        {
          deviceId: 'd1',
          timestamp: '2026-01-01T00:20:00.000Z',
          cookId: 'cook-target',
          grillTemp: 190,
          probe1Temp: 120,
          probe2Temp: 70,
        },
      ];
      const result = CookManager.generateCookSummary(cook, readings);

      // Hand-computed against the cook-target subset only (3 readings):
      //   grillTemps = [200, 210, 190]   → avg = 200.0, peak = 210.0
      //   probe1     = [100, 110, 120]   → avg = 110.0
      //   probe2     = [70]              → avg = 70.0
      //   variance   = ((0)^2 + (10)^2 + (-10)^2) / 3 = 200/3 ≈ 66.667
      //   stability  = max(0, 100 - sqrt(66.667)) ≈ 100 - 8.165 ≈ 91.8
      //   duration   = floor((20*60*1000) / 60000) = 20 minutes
      expect(result.cookId).toBe('cook-target');
      expect(result.averageGrillTemp).toBeCloseTo(200.0, 1);
      expect(result.peakGrillTemp).toBeCloseTo(210.0, 1);
      expect(result.averageProbeTemps['probe1']).toBeCloseTo(110.0, 1);
      expect(result.averageProbeTemps['probe2']).toBeCloseTo(70.0, 1);
      expect(result.temperatureStability).toBeCloseTo(91.8, 1);
      expect(result.totalDuration).toBe(20);
    });

    it('omits probe entries from averageProbeTemps when no readings include them', () => {
      const cook = buildCook({ id: 'cook-target' });
      const readings: TemperatureReading[] = [
        {
          deviceId: 'd1',
          timestamp: '2026-01-01T00:00:00.000Z',
          cookId: 'cook-target',
          grillTemp: 200,
        },
        {
          deviceId: 'd1',
          timestamp: '2026-01-01T00:05:00.000Z',
          cookId: 'cook-target',
          grillTemp: 200,
        },
      ];
      const result = CookManager.generateCookSummary(cook, readings);
      expect(result.averageProbeTemps).toEqual({});
      // Two equal grillTemps → variance 0 → stability 100
      expect(result.temperatureStability).toBeCloseTo(100, 1);
      expect(result.totalDuration).toBe(5);
    });

    it('computes a perfect stability of 100 when grill temperatures are constant', () => {
      const cook = buildCook({ id: 'cook-target' });
      const readings: TemperatureReading[] = [
        {
          deviceId: 'd1',
          timestamp: '2026-01-01T00:00:00.000Z',
          cookId: 'cook-target',
          grillTemp: 225,
        },
        {
          deviceId: 'd1',
          timestamp: '2026-01-01T01:00:00.000Z',
          cookId: 'cook-target',
          grillTemp: 225,
        },
      ];
      const result = CookManager.generateCookSummary(cook, readings);
      expect(result.temperatureStability).toBeCloseTo(100, 1);
      expect(result.peakGrillTemp).toBeCloseTo(225, 1);
      expect(result.averageGrillTemp).toBeCloseTo(225, 1);
      expect(result.totalDuration).toBe(60);
    });
  });

  describe('estimateRemainingTime', () => {
    beforeEach(() => {
      jest.useFakeTimers();
    });
    afterEach(() => {
      jest.useRealTimers();
    });

    it('returns null when cook.targetTemps.probe1 is missing', () => {
      jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
      const cook = buildCook({
        startTime: '2026-01-01T00:00:00.000Z',
        targetTemps: { grill: 225 },
      });
      const reading = buildReading({ probe1Temp: 130 });
      expect(CookManager.estimateRemainingTime(cook, reading)).toBeNull();
    });

    it('returns null when reading.probe1Temp is missing', () => {
      jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
      const cook = buildCook({
        startTime: '2026-01-01T00:00:00.000Z',
        targetTemps: { probe1: 200 },
      });
      const reading = buildReading();
      expect(CookManager.estimateRemainingTime(cook, reading)).toBeNull();
    });

    it("returns 'Done!' when current probe1Temp meets or exceeds the target", () => {
      jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
      const cook = buildCook({
        startTime: '2026-01-01T00:00:00.000Z',
        targetTemps: { probe1: 200 },
      });
      const reading = buildReading({ probe1Temp: 200 });
      expect(CookManager.estimateRemainingTime(cook, reading)).toBe('Done!');
    });

    it('returns null when cook.startTime is empty', () => {
      jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
      const cook = buildCook({
        startTime: '',
        targetTemps: { probe1: 200 },
      });
      const reading = buildReading({ probe1Temp: 130 });
      expect(CookManager.estimateRemainingTime(cook, reading)).toBeNull();
    });

    it("returns 'Calculating...' when fewer than 30 minutes have elapsed", () => {
      jest.setSystemTime(new Date('2026-01-01T00:20:00.000Z'));
      const cook = buildCook({
        startTime: '2026-01-01T00:00:00.000Z',
        targetTemps: { probe1: 200 },
      });
      const reading = buildReading({ probe1Temp: 130 });
      expect(CookManager.estimateRemainingTime(cook, reading)).toBe(
        'Calculating...'
      );
    });

    it("returns 'Unable to estimate' when the heating rate is non-positive (currentTemp <= 70)", () => {
      jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
      const cook = buildCook({
        startTime: '2026-01-01T00:00:00.000Z',
        targetTemps: { probe1: 200 },
      });
      // current=70 → tempRise=0 → ratePerMinute=0 → 'Unable to estimate'
      const reading = buildReading({ probe1Temp: 70 });
      expect(CookManager.estimateRemainingTime(cook, reading)).toBe(
        'Unable to estimate'
      );
    });

    it('returns a formatDuration string on the happy path', () => {
      jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
      const cook = buildCook({
        startTime: '2026-01-01T00:00:00.000Z',
        targetTemps: { probe1: 200 },
      });
      // Hand-computed: elapsed=60min, current=130, start=70
      //   tempRise=60, ratePerMin=1.0
      //   tempNeeded=70, estMin=ceil(70/1)=70 → formatDuration(70) = '1h 10m'
      const reading = buildReading({ probe1Temp: 130 });
      expect(CookManager.estimateRemainingTime(cook, reading)).toBe('1h 10m');
    });

    it('returns a sub-hour string when the projection rounds to under 60 minutes', () => {
      jest.setSystemTime(new Date('2026-01-01T01:00:00.000Z'));
      const cook = buildCook({
        startTime: '2026-01-01T00:00:00.000Z',
        targetTemps: { probe1: 200 },
      });
      // Hand-computed: elapsed=60min, current=190, start=70
      //   tempRise=120, ratePerMin=2.0
      //   tempNeeded=10, estMin=ceil(10/2)=5 → formatDuration(5) = '5m'
      const reading = buildReading({ probe1Temp: 190 });
      expect(CookManager.estimateRemainingTime(cook, reading)).toBe('5m');
    });
  });
});
