import type { DeviceConfiguration } from '@meatgeekv2/api-interfaces';

import { normalizeClaimCode } from '../../shared/devices/claim-code';
import {
  DEVICE_ID_PATTERN,
  type DeviceConfigurationPatch,
  type DeviceUpdate,
} from '../../shared/cosmos/devices-repository';

/**
 * HAR-20 (MG-80) — validation of the POST /devices and PATCH /devices/{id}
 * bodies; HAR-130 adds POST /devices/claim. Each validator returns the cleaned request or one fixed message for a
 * 400 VALIDATION_ERROR. Unknown keys are rejected rather than ignored, so a body
 * can never carry `userId`, `isActive` or `connectionStatus` into a document:
 * the owner comes from the principal and the status fields from the server.
 */

export const DEVICE_NAME_MAX_LENGTH = 100;
export const DEVICE_MODEL_MAX_LENGTH = 100;
export const DEVICE_LOCATION_MAX_LENGTH = 200;
export const POLLING_INTERVAL_MIN_SECONDS = 1;
export const POLLING_INTERVAL_MAX_SECONDS = 3600;

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** A register request after validation: strings trimmed, configuration cleaned. */
export interface ValidRegisterDevice {
  readonly deviceId: string;
  readonly name: string;
  readonly model: string;
  readonly location?: string;
  readonly configuration?: DeviceConfigurationPatch;
}

/** A claim request after validation: the register fields plus the normalized
 *  claim code. `model` is filled with {@link DEFAULT_CLAIMED_DEVICE_MODEL}. */
export interface ValidClaimDevice extends ValidRegisterDevice {
  /** 12 Crockford base32 symbols. Never log it. */
  readonly claimCode: string;
}

/** The model a claimed device is stored with when the request names none. */
export const DEFAULT_CLAIMED_DEVICE_MODEL = 'MeatGeek';

const REGISTER_KEYS = ['deviceId', 'name', 'model', 'location', 'configuration'];
const CLAIM_KEYS = [...REGISTER_KEYS, 'claimCode'];
const UPDATE_KEYS = ['name', 'location', 'configuration'];
const CORRECTION_KEYS = [
  'grillProbeCorrection',
  'probe1Correction',
  'probe2Correction',
  'probe3Correction',
  'probe4Correction',
] as const;
const CONFIGURATION_KEYS = [
  ...CORRECTION_KEYS,
  'temperatureUnit',
  'pollingInterval',
  'alertSettings',
];
const ALERT_NUMBER_KEYS = ['highTempThreshold', 'lowTempThreshold'] as const;
const ALERT_BOOLEAN_KEYS = ['enableSounds', 'enablePushNotifications'] as const;
const ALERT_KEYS: readonly string[] = [...ALERT_NUMBER_KEYS, ...ALERT_BOOLEAN_KEYS];
const TEMPERATURE_UNITS: readonly DeviceConfiguration['temperatureUnit'][] = [
  'fahrenheit',
  'celsius',
];

function fail<T>(message: string): Validated<T> {
  return { ok: false, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function unknownKey(
  value: Record<string, unknown>,
  allowed: readonly string[]
): string | undefined {
  return Object.keys(value).find(key => !allowed.includes(key));
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A required-or-optional bounded text field, trimmed; blank is invalid. */
function text(value: unknown, field: string, maxLength: number): Validated<string> {
  if (typeof value !== 'string') {
    return fail(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > maxLength) {
    return fail(`${field} must be 1-${maxLength} non-blank characters`);
  }
  return { ok: true, value: trimmed };
}

/** A partial DeviceConfiguration, field by field. */
function configurationPatch(value: unknown): Validated<DeviceConfigurationPatch> {
  if (!isPlainObject(value)) {
    return fail('configuration must be an object');
  }
  const extra = unknownKey(value, CONFIGURATION_KEYS);
  if (extra !== undefined) {
    return fail(`configuration.${extra} is not a configuration field`);
  }

  const patch: Record<string, unknown> = {};
  for (const key of CORRECTION_KEYS) {
    if (value[key] !== undefined) {
      if (!isFiniteNumber(value[key])) {
        return fail(`configuration.${key} must be a number`);
      }
      patch[key] = value[key];
    }
  }
  if (value['temperatureUnit'] !== undefined) {
    if (!TEMPERATURE_UNITS.includes(value['temperatureUnit'] as never)) {
      return fail('configuration.temperatureUnit must be fahrenheit or celsius');
    }
    patch['temperatureUnit'] = value['temperatureUnit'];
  }
  if (value['pollingInterval'] !== undefined) {
    const interval = value['pollingInterval'];
    if (
      !Number.isInteger(interval) ||
      (interval as number) < POLLING_INTERVAL_MIN_SECONDS ||
      (interval as number) > POLLING_INTERVAL_MAX_SECONDS
    ) {
      return fail(
        `configuration.pollingInterval must be an integer from ${POLLING_INTERVAL_MIN_SECONDS} to ${POLLING_INTERVAL_MAX_SECONDS}`
      );
    }
    patch['pollingInterval'] = interval;
  }
  if (value['alertSettings'] !== undefined) {
    const alerts = value['alertSettings'];
    if (!isPlainObject(alerts)) {
      return fail('configuration.alertSettings must be an object');
    }
    const extraAlert = unknownKey(alerts, ALERT_KEYS);
    if (extraAlert !== undefined) {
      return fail(`configuration.alertSettings.${extraAlert} is not an alert setting`);
    }
    const alertPatch: Record<string, unknown> = {};
    for (const key of ALERT_NUMBER_KEYS) {
      if (alerts[key] !== undefined) {
        if (!isFiniteNumber(alerts[key])) {
          return fail(`configuration.alertSettings.${key} must be a number`);
        }
        alertPatch[key] = alerts[key];
      }
    }
    for (const key of ALERT_BOOLEAN_KEYS) {
      if (alerts[key] !== undefined) {
        if (typeof alerts[key] !== 'boolean') {
          return fail(`configuration.alertSettings.${key} must be a boolean`);
        }
        alertPatch[key] = alerts[key];
      }
    }
    patch['alertSettings'] = alertPatch;
  }
  return { ok: true, value: patch as DeviceConfigurationPatch };
}

/** POST /devices body → a register request, or a 400 message. */
export function validateRegisterDevice(body: unknown): Validated<ValidRegisterDevice> {
  if (!isPlainObject(body)) {
    return fail('Request body must be a JSON object');
  }
  const extra = unknownKey(body, REGISTER_KEYS);
  if (extra !== undefined) {
    return fail(`${extra} is not a register-device field`);
  }
  return deviceFields(body, body['model']);
}

/**
 * HAR-130: POST /devices/claim body → a claim request, or a 400 message. The
 * register rules apply to the shared fields, except that `model` may be left
 * out. The claim code is normalized (see shared/devices/claim-code); the 400
 * message never repeats it.
 */
export function validateClaimDevice(body: unknown): Validated<ValidClaimDevice> {
  if (!isPlainObject(body)) {
    return fail('Request body must be a JSON object');
  }
  const extra = unknownKey(body, CLAIM_KEYS);
  if (extra !== undefined) {
    return fail(`${extra} is not a claim-device field`);
  }
  const fields = deviceFields(
    body,
    body['model'] === undefined ? DEFAULT_CLAIMED_DEVICE_MODEL : body['model']
  );
  if (!fields.ok) return fields;

  const rawCode = body['claimCode'];
  const claimCode = typeof rawCode === 'string' ? normalizeClaimCode(rawCode) : null;
  if (claimCode === null) {
    return fail(
      'claimCode must be the 12-symbol code the device shows (XXXX-XXXX-XXXX: 0-9 and A-Z except I, L, O and U)'
    );
  }
  return { ok: true, value: { ...fields.value, claimCode } };
}

/** The fields register and claim share, after the key check. */
function deviceFields(
  body: Record<string, unknown>,
  rawModel: unknown
): Validated<ValidRegisterDevice> {
  const deviceId = body['deviceId'];
  if (typeof deviceId !== 'string' || !DEVICE_ID_PATTERN.test(deviceId)) {
    return fail('deviceId must be 1-128 characters of A-Z, a-z, 0-9, ".", "_", ":" or "-"');
  }
  const name = text(body['name'], 'name', DEVICE_NAME_MAX_LENGTH);
  if (!name.ok) return name;
  const model = text(rawModel, 'model', DEVICE_MODEL_MAX_LENGTH);
  if (!model.ok) return model;

  let location: string | undefined;
  if (body['location'] !== undefined) {
    const checked = text(body['location'], 'location', DEVICE_LOCATION_MAX_LENGTH);
    if (!checked.ok) return checked;
    location = checked.value;
  }

  let configuration: DeviceConfigurationPatch | undefined;
  if (body['configuration'] !== undefined) {
    const checked = configurationPatch(body['configuration']);
    if (!checked.ok) return checked;
    configuration = checked.value;
  }

  return {
    ok: true,
    value: {
      deviceId,
      name: name.value,
      model: model.value,
      ...(location !== undefined ? { location } : {}),
      ...(configuration !== undefined ? { configuration } : {}),
    },
  };
}

/** PATCH /devices/{id} body → an update, or a 400 message. At least one field. */
export function validateUpdateDevice(body: unknown): Validated<DeviceUpdate> {
  if (!isPlainObject(body)) {
    return fail('Request body must be a JSON object');
  }
  const extra = unknownKey(body, UPDATE_KEYS);
  if (extra !== undefined) {
    return fail(`${extra} is not an updatable device field`);
  }
  if (!UPDATE_KEYS.some(key => body[key] !== undefined)) {
    return fail('Send at least one of name, location, configuration');
  }

  const update: { name?: string; location?: string; configuration?: DeviceConfigurationPatch } = {};
  if (body['name'] !== undefined) {
    const checked = text(body['name'], 'name', DEVICE_NAME_MAX_LENGTH);
    if (!checked.ok) return checked;
    update.name = checked.value;
  }
  if (body['location'] !== undefined) {
    const checked = text(body['location'], 'location', DEVICE_LOCATION_MAX_LENGTH);
    if (!checked.ok) return checked;
    update.location = checked.value;
  }
  if (body['configuration'] !== undefined) {
    const checked = configurationPatch(body['configuration']);
    if (!checked.ok) return checked;
    update.configuration = checked.value;
  }
  return { ok: true, value: update };
}
