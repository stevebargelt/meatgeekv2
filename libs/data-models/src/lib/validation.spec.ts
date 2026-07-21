/**
 * Unit tests for DataValidator
 *
 * Conventions in this file:
 *   - Error messages with numeric bounds are built from VALIDATION constants via
 *     template literals so the tests self-update if VALIDATION changes.
 *   - Assertions use `toContain` (not `toEqual`) for error arrays so the tests
 *     are order-independent and resilient to new errors being added.
 *   - `result.errors` and `result.warnings` are asserted separately and never
 *     conflated.
 *   - `@meatgeekv2/utils` is imported real, not mocked.
 */

import { VALIDATION, MEAT_TYPES } from '@meatgeekv2/utils';
import {
  StartCookRequest,
  UpdateCookRequest,
  RegisterDeviceRequest,
  RegisterUserRequest,
} from '@meatgeekv2/api-interfaces';
import { DataValidator } from './validation';

describe('DataValidator', () => {
  describe('validateTemperature', () => {
    it('returns isValid: true with no errors for null', () => {
      const result = DataValidator.validateTemperature(null);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns isValid: true with no errors for undefined', () => {
      const result = DataValidator.validateTemperature(undefined);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns an error for NaN', () => {
      const result = DataValidator.validateTemperature(NaN);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('Temperature must be a valid number');
    });

    it('returns an error when below VALIDATION.TEMPERATURE.MIN', () => {
      const result = DataValidator.validateTemperature(VALIDATION.TEMPERATURE.MIN - 1);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        `Temperature must be at least ${VALIDATION.TEMPERATURE.MIN}°F`
      );
    });

    it('returns an error when above VALIDATION.TEMPERATURE.MAX', () => {
      const result = DataValidator.validateTemperature(VALIDATION.TEMPERATURE.MAX + 1);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain(
        `Temperature cannot exceed ${VALIDATION.TEMPERATURE.MAX}°F`
      );
    });

    it('accepts the boundary value at MIN', () => {
      const result = DataValidator.validateTemperature(VALIDATION.TEMPERATURE.MIN);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('accepts the boundary value at MAX', () => {
      const result = DataValidator.validateTemperature(VALIDATION.TEMPERATURE.MAX);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });
  });

  describe('validateStartCookRequest', () => {
    const baseRequest = (): StartCookRequest => ({
      name: 'Sunday Brisket',
      deviceId: 'device-123',
      meatType: 'Brisket',
    });

    it('returns isValid: true for a fully valid request', () => {
      const result = DataValidator.validateStartCookRequest(baseRequest());
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('flags missing name as an error', () => {
      const req = baseRequest();
      req.name = '';
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).toContain('Cook name is required');
    });

    it('flags whitespace-only name as an error', () => {
      const req = baseRequest();
      req.name = '   ';
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).toContain('Cook name is required');
    });

    it('flags name shorter than MIN_LENGTH', () => {
      const req = baseRequest();
      req.name = 'a'.repeat(VALIDATION.COOK_NAME.MIN_LENGTH - 1);
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).toContain(
        `Cook name must be at least ${VALIDATION.COOK_NAME.MIN_LENGTH} characters`
      );
    });

    it('flags name longer than MAX_LENGTH', () => {
      const req = baseRequest();
      req.name = 'a'.repeat(VALIDATION.COOK_NAME.MAX_LENGTH + 1);
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).toContain(
        `Cook name cannot exceed ${VALIDATION.COOK_NAME.MAX_LENGTH} characters`
      );
    });

    it('flags missing deviceId', () => {
      const req = baseRequest();
      req.deviceId = '';
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).toContain('Device ID is required');
    });

    it('flags missing meatType', () => {
      const req = baseRequest();
      req.meatType = '';
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).toContain('Meat type is required');
    });

    it('warns (does not error) for an unrecognized meat type', () => {
      const req = baseRequest();
      req.meatType = 'Unicorn Steaks';
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toContain("'Unicorn Steaks' is not a recognized meat type");
    });

    it('recognizes the display name "Pork Shoulder" (resolveMeatType matches MEAT_TYPES[*].name)', () => {
      const req = baseRequest();
      req.meatType = MEAT_TYPES.PORK_SHOULDER.name; // 'Pork Shoulder'
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.warnings ?? []).not.toContain(
        `'${MEAT_TYPES.PORK_SHOULDER.name}' is not a recognized meat type`
      );
    });

    // resolveMeatType unifies cook-manager and DataValidator: BOTH the display name
    // and the canonical KEY resolve, so neither surface warns on a valid meat type.
    it('recognizes the key "PORK_SHOULDER" (resolveMeatType accepts keys too)', () => {
      const req = baseRequest();
      req.meatType = 'PORK_SHOULDER';
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.warnings ?? []).not.toContain(
        "'PORK_SHOULDER' is not a recognized meat type"
      );
    });

    it('flags weight <= 0 as an error', () => {
      const req = baseRequest();
      req.weight = 0;
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).toContain('Weight must be greater than 0');
    });

    it('flags negative weight as an error', () => {
      const req = baseRequest();
      req.weight = -5;
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).toContain('Weight must be greater than 0');
    });

    it('warns when weight > 50 but <= 100 (within reasonable bounds)', () => {
      const req = baseRequest();
      req.weight = 51;
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.warnings).toContain('Weight over 50 pounds - verify this is correct');
      expect(result.errors).not.toContain('Weight must be greater than 0');
    });

    it('flags weight over 100 as an error (unified weight contract)', () => {
      const req = baseRequest();
      req.weight = 101;
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).toContain('Weight cannot exceed 100 pounds');
      expect(result.warnings).not.toContain('Weight over 50 pounds - verify this is correct');
    });

    it('does not warn or error for weight in (0, 50]', () => {
      const req = baseRequest();
      req.weight = 12;
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).not.toContain('Weight must be greater than 0');
      expect(result.warnings).not.toContain('Weight over 50 pounds - verify this is correct');
    });

    it('bubbles up errors and warnings from invalid targetTemps', () => {
      const req = baseRequest();
      req.targetTemps = { grill: 50, probe1: 130 }; // grill below 150 (error), probe1 below 140 (warning)
      const result = DataValidator.validateStartCookRequest(req);
      expect(result.errors).toContain('Grill temperature must be between 150°F and 500°F');
      expect(result.warnings).toContain(
        `probe1 temperature of ${130}°F may not be safe for all meats`
      );
    });
  });

  describe('validateUpdateCookRequest', () => {
    it('returns isValid: true for an empty request', () => {
      const result = DataValidator.validateUpdateCookRequest({});
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('flags name shorter than MIN_LENGTH', () => {
      const req: UpdateCookRequest = {
        name: 'a'.repeat(VALIDATION.COOK_NAME.MIN_LENGTH - 1),
      };
      const result = DataValidator.validateUpdateCookRequest(req);
      expect(result.errors).toContain(
        `Cook name must be at least ${VALIDATION.COOK_NAME.MIN_LENGTH} characters`
      );
    });

    it('flags name longer than MAX_LENGTH', () => {
      const req: UpdateCookRequest = {
        name: 'a'.repeat(VALIDATION.COOK_NAME.MAX_LENGTH + 1),
      };
      const result = DataValidator.validateUpdateCookRequest(req);
      expect(result.errors).toContain(
        `Cook name cannot exceed ${VALIDATION.COOK_NAME.MAX_LENGTH} characters`
      );
    });

    it('flags rating < 1', () => {
      const result = DataValidator.validateUpdateCookRequest({ rating: 0 });
      expect(result.errors).toContain('Rating must be between 1 and 5 stars');
    });

    it('flags rating > 5', () => {
      const result = DataValidator.validateUpdateCookRequest({ rating: 6 });
      expect(result.errors).toContain('Rating must be between 1 and 5 stars');
    });

    it('accepts ratings 1 through 5', () => {
      for (const rating of [1, 2, 3, 4, 5]) {
        const result = DataValidator.validateUpdateCookRequest({ rating });
        expect(result.isValid).toBe(true);
        expect(result.errors).toEqual([]);
      }
    });

    it('bubbles up errors and warnings from invalid targetTemps', () => {
      const req: UpdateCookRequest = {
        targetTemps: { grill: 1000, probe1: 130 },
      };
      const result = DataValidator.validateUpdateCookRequest(req);
      expect(result.errors).toContain('Grill temperature must be between 150°F and 500°F');
      expect(result.warnings).toContain(
        `probe1 temperature of ${130}°F may not be safe for all meats`
      );
    });
  });

  describe('validateTargetTemperatures', () => {
    it('returns no errors or warnings for an empty object', () => {
      const result = DataValidator.validateTargetTemperatures({});
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('flags grill below 150 as an error', () => {
      const result = DataValidator.validateTargetTemperatures({ grill: 149 });
      expect(result.errors).toContain('Grill temperature must be between 150°F and 500°F');
    });

    it('flags grill above 500 as an error', () => {
      const result = DataValidator.validateTargetTemperatures({ grill: 501 });
      expect(result.errors).toContain('Grill temperature must be between 150°F and 500°F');
    });

    it('accepts boundary grill values 150 and 500', () => {
      const lo = DataValidator.validateTargetTemperatures({ grill: 150 });
      const hi = DataValidator.validateTargetTemperatures({ grill: 500 });
      expect(lo.errors).not.toContain('Grill temperature must be between 150°F and 500°F');
      expect(hi.errors).not.toContain('Grill temperature must be between 150°F and 500°F');
    });

    it('flags each probe below 100 as an error', () => {
      const probes = ['probe1', 'probe2', 'probe3', 'probe4'] as const;
      for (const probe of probes) {
        const result = DataValidator.validateTargetTemperatures({ [probe]: 99 });
        expect(result.errors).toContain(`${probe} temperature must be between 100°F and 250°F`);
      }
    });

    it('flags each probe above 250 as an error', () => {
      const probes = ['probe1', 'probe2', 'probe3', 'probe4'] as const;
      for (const probe of probes) {
        const result = DataValidator.validateTargetTemperatures({ [probe]: 251 });
        expect(result.errors).toContain(`${probe} temperature must be between 100°F and 250°F`);
      }
    });

    it('warns when probe1 < 140 even though it is within 100–250', () => {
      const result = DataValidator.validateTargetTemperatures({ probe1: 120 });
      expect(result.errors).not.toContain('probe1 temperature must be between 100°F and 250°F');
      expect(result.warnings).toContain(
        `probe1 temperature of ${120}°F may not be safe for all meats`
      );
    });

    it('warns when meat (probe1) is more than 50°F above grill', () => {
      const result = DataValidator.validateTargetTemperatures({ grill: 225, probe1: 280 });
      // probe1=280 exceeds 250 boundary so we expect both warning and error; test
      // only the cross-relationship warning here.
      expect(result.warnings).toContain(
        'Meat target temperature is significantly higher than grill temperature'
      );
    });

    it('does not flag a valid grill+probe combo', () => {
      const result = DataValidator.validateTargetTemperatures({ grill: 225, probe1: 203 });
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
      expect(result.warnings).toEqual([]);
    });
  });

  describe('validateDeviceRegistration', () => {
    const baseRequest = (): RegisterDeviceRequest => ({
      deviceId: 'dev_001',
      name: 'Kitchen Smoker',
      model: 'MeatGeek-Pro',
    });

    it('returns isValid: true for a fully valid request', () => {
      const result = DataValidator.validateDeviceRegistration(baseRequest());
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('flags missing deviceId', () => {
      const req = baseRequest();
      req.deviceId = '';
      const result = DataValidator.validateDeviceRegistration(req);
      expect(result.errors).toContain('Device ID is required');
    });

    it('flags whitespace-only deviceId', () => {
      const req = baseRequest();
      req.deviceId = '   ';
      const result = DataValidator.validateDeviceRegistration(req);
      expect(result.errors).toContain('Device ID is required');
    });

    it('flags deviceId shorter than 3 chars', () => {
      const req = baseRequest();
      req.deviceId = 'ab';
      const result = DataValidator.validateDeviceRegistration(req);
      expect(result.errors).toContain('Device ID must be at least 3 characters');
    });

    it('flags deviceId with disallowed characters', () => {
      const req = baseRequest();
      req.deviceId = 'bad id!';
      const result = DataValidator.validateDeviceRegistration(req);
      expect(result.errors).toContain(
        'Device ID can only contain letters, numbers, underscores, and hyphens'
      );
    });

    it('accepts deviceId with letters, numbers, underscores, and hyphens', () => {
      const req = baseRequest();
      req.deviceId = 'abc_123-XYZ';
      const result = DataValidator.validateDeviceRegistration(req);
      expect(result.errors).not.toContain(
        'Device ID can only contain letters, numbers, underscores, and hyphens'
      );
    });

    it('flags missing name', () => {
      const req = baseRequest();
      req.name = '';
      const result = DataValidator.validateDeviceRegistration(req);
      expect(result.errors).toContain('Device name is required');
    });

    it('flags name shorter than DEVICE_NAME.MIN_LENGTH', () => {
      const req = baseRequest();
      req.name = 'a'.repeat(VALIDATION.DEVICE_NAME.MIN_LENGTH - 1);
      const result = DataValidator.validateDeviceRegistration(req);
      expect(result.errors).toContain(
        `Device name must be at least ${VALIDATION.DEVICE_NAME.MIN_LENGTH} characters`
      );
    });

    it('flags name longer than DEVICE_NAME.MAX_LENGTH', () => {
      const req = baseRequest();
      req.name = 'a'.repeat(VALIDATION.DEVICE_NAME.MAX_LENGTH + 1);
      const result = DataValidator.validateDeviceRegistration(req);
      expect(result.errors).toContain(
        `Device name cannot exceed ${VALIDATION.DEVICE_NAME.MAX_LENGTH} characters`
      );
    });

    it('flags missing model', () => {
      const req = baseRequest();
      req.model = '';
      const result = DataValidator.validateDeviceRegistration(req);
      expect(result.errors).toContain('Device model is required');
    });

    it('flags whitespace-only model', () => {
      const req = baseRequest();
      req.model = '   ';
      const result = DataValidator.validateDeviceRegistration(req);
      expect(result.errors).toContain('Device model is required');
    });
  });

  describe('validateUserRegistration', () => {
    const baseRequest = (): RegisterUserRequest => ({
      email: 'test@example.com',
      password: 'Abcdef12',
      name: 'Alice',
    });

    it('returns isValid: true for a fully valid request', () => {
      const result = DataValidator.validateUserRegistration(baseRequest());
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('flags an invalid email per VALIDATION.EMAIL.PATTERN', () => {
      const req = baseRequest();
      req.email = 'not-an-email';
      const result = DataValidator.validateUserRegistration(req);
      expect(result.errors).toContain('Valid email address is required');
    });

    it('flags a missing email', () => {
      const req = baseRequest();
      req.email = '';
      const result = DataValidator.validateUserRegistration(req);
      expect(result.errors).toContain('Valid email address is required');
    });

    it('flags password shorter than 8 characters', () => {
      const req = baseRequest();
      req.password = 'Ab1';
      const result = DataValidator.validateUserRegistration(req);
      expect(result.errors).toContain('Password must be at least 8 characters');
    });

    it('flags password missing a lowercase letter', () => {
      const req = baseRequest();
      req.password = 'ABCDEF12';
      const result = DataValidator.validateUserRegistration(req);
      expect(result.errors).toContain('Password must contain at least one lowercase letter');
    });

    it('flags password missing an uppercase letter', () => {
      const req = baseRequest();
      req.password = 'abcdef12';
      const result = DataValidator.validateUserRegistration(req);
      expect(result.errors).toContain('Password must contain at least one uppercase letter');
    });

    it('flags password missing a digit', () => {
      const req = baseRequest();
      req.password = 'Abcdefgh';
      const result = DataValidator.validateUserRegistration(req);
      expect(result.errors).toContain('Password must contain at least one number');
    });

    it('flags name shorter than 2 chars after trim', () => {
      const req = baseRequest();
      req.name = ' a ';
      const result = DataValidator.validateUserRegistration(req);
      expect(result.errors).toContain('Name must be at least 2 characters');
    });

    it('flags missing name', () => {
      const req = baseRequest();
      req.name = '';
      const result = DataValidator.validateUserRegistration(req);
      expect(result.errors).toContain('Name must be at least 2 characters');
    });
  });

  describe('validateEmail', () => {
    it('returns true for valid email forms', () => {
      expect(DataValidator.validateEmail('alice@example.com')).toBe(true);
      expect(DataValidator.validateEmail('a.b+tag@sub.domain.co')).toBe(true);
    });

    it('returns false for invalid email forms', () => {
      expect(DataValidator.validateEmail('plainaddress')).toBe(false);
      expect(DataValidator.validateEmail('missing@domain')).toBe(false);
      expect(DataValidator.validateEmail('@nouser.com')).toBe(false);
      expect(DataValidator.validateEmail('spaces in@addr.com')).toBe(false);
    });
  });

  describe('validatePhoneNumber', () => {
    it('strips non-digit characters via /\\D/g and accepts a 10-digit value', () => {
      expect(DataValidator.validatePhoneNumber('(555) 123-4567')).toBe(true);
      expect(DataValidator.validatePhoneNumber('555.123.4567')).toBe(true);
      expect(DataValidator.validatePhoneNumber('5551234567')).toBe(true);
    });

    it('rejects fewer than 10 digits', () => {
      expect(DataValidator.validatePhoneNumber('555-1234')).toBe(false); // 7 digits
      expect(DataValidator.validatePhoneNumber('123456789')).toBe(false); // 9 digits
    });

    it('rejects more than 10 digits', () => {
      expect(DataValidator.validatePhoneNumber('15551234567')).toBe(false); // 11 digits
      expect(DataValidator.validatePhoneNumber('+1 (555) 123-45678')).toBe(false); // 11 digits
    });
  });

  describe('sanitizeString', () => {
    it('removes <script>…</script> blocks', () => {
      const out = DataValidator.sanitizeString('<script>alert(1)</script>safe');
      expect(out).toBe('safe');
    });

    it('strips < > \' " characters from the output', () => {
      const out = DataValidator.sanitizeString(`<b>hi</b> "quoted" 'q'`);
      expect(out).toBe('bhi/b quoted q');
    });

    it('trims leading and trailing whitespace', () => {
      const out = DataValidator.sanitizeString('   hello   ');
      expect(out).toBe('hello');
    });

    it('composes script removal, html-char stripping, and trimming', () => {
      const input = `   <script>alert("xss")</script>Hello <b>World</b> 'test'   `;
      const out = DataValidator.sanitizeString(input);
      // After script removal:  '   Hello <b>World</b> \'test\'   '
      // After [<>\'"] strip:   '   Hello bWorld/b test   '
      // After trim:            'Hello bWorld/b test'
      expect(out).toBe('Hello bWorld/b test');
    });
  });

  describe('validateCookNameUniqueness', () => {
    it('returns isValid: true when there are no existing cooks', () => {
      const result = DataValidator.validateCookNameUniqueness('My Cook', []);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns isValid: true when no duplicate exists', () => {
      const result = DataValidator.validateCookNameUniqueness('My Cook', [
        { name: 'Other Cook' },
        { name: 'Another Cook' },
      ]);
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    it('returns an error for a case-insensitive duplicate', () => {
      const result = DataValidator.validateCookNameUniqueness('my cook', [
        { name: 'MY COOK' },
      ]);
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('A cook with this name already exists');
    });

    // excludeCookId now excludes by cook.id (an opaque id), which is what callers
    // pass — the self-cook is skipped so renaming/saving in place is not a "duplicate".
    it('excludes a cook from the duplicate check when excludeCookId matches that cook.id', () => {
      const result = DataValidator.validateCookNameUniqueness(
        'My Cook',
        [{ id: 'cook-1', name: 'My Cook' }],
        'cook-1'
      );
      expect(result.isValid).toBe(true);
      expect(result.errors).toEqual([]);
    });

    // Exclusion is by id, not name: passing a cook's NAME as excludeCookId no
    // longer wrongly excludes it, so a real duplicate still surfaces.
    it('does not exclude by name — a cook whose name equals excludeCookId is still a duplicate', () => {
      const result = DataValidator.validateCookNameUniqueness(
        'My Cook',
        [{ id: 'cook-1', name: 'My Cook' }],
        'My Cook'
      );
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('A cook with this name already exists');
    });

    it('flags a duplicate when excludeCookId is an opaque id that no cook.id matches', () => {
      const result = DataValidator.validateCookNameUniqueness(
        'My Cook',
        [{ id: 'cook-1', name: 'My Cook' }],
        'cook-id-abc123'
      );
      expect(result.isValid).toBe(false);
      expect(result.errors).toContain('A cook with this name already exists');
    });
  });
});
