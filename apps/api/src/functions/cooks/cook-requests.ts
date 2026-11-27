import type { TargetTemperatures } from '@meatgeekv2/api-interfaces';

/**
 * HAR-75 — validation of the POST /cooks body. Returns the cleaned request or
 * one message naming the field, for a 400 VALIDATION_ERROR.
 *
 * Before HAR-75 the handler checked only that `name`, `deviceId`, `meatType`
 * and `id` were present, stored `weight`, `targetTemps` and `notes` as sent,
 * and answered 500 to a body that was not valid JSON or was `null`. Now every
 * field has a rule and unknown keys are rejected rather than ignored (as
 * device-requests.ts does), so a body can never carry `userId`, `status` or
 * any other server-owned field towards a document.
 */

export const COOK_NAME_MAX_LENGTH = 100;
export const COOK_MEAT_TYPE_MAX_LENGTH = 100;
export const COOK_NOTES_MAX_LENGTH = 2000;
/** Pounds. Above this is a typo, not a cook. */
export const COOK_WEIGHT_MAX = 1000;
/** Degrees F, inclusive, for every target temperature. */
export const TARGET_TEMP_MIN = 0;
export const TARGET_TEMP_MAX = 1000;

/**
 * MG-84: the cook id is supplied by the client — generated once per start intent
 * and reused on every retry — and must be a UUID. The UUID shape also keeps
 * client ids out of the server's own document ids (`active-device:<deviceId>`).
 */
export const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const START_COOK_KEYS = [
  'id',
  'name',
  'deviceId',
  'meatType',
  'weight',
  'targetTemps',
  'notes',
] as const;

/** Every TargetTemperatures key. A Record so the compiler fails if the
 *  contract gains or loses a probe and this list is not updated with it. */
const TARGET_TEMP_KEYS: Record<keyof TargetTemperatures, true> = {
  grill: true,
  probe1: true,
  probe2: true,
  probe3: true,
  probe4: true,
};

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

/** A start request after validation: `name` and `meatType` trimmed, optional
 *  fields present only when sent. */
export interface ValidStartCook {
  readonly id: string;
  readonly name: string;
  readonly deviceId: string;
  readonly meatType: string;
  readonly weight?: number;
  readonly targetTemps?: TargetTemperatures;
  readonly notes?: string;
}

function fail<T>(message: string): Validated<T> {
  return { ok: false, message };
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** A required text field, trimmed; blank or too long is invalid. */
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

function targetTemps(value: unknown): Validated<TargetTemperatures> {
  if (!isPlainObject(value)) {
    return fail('targetTemps must be an object');
  }
  const temps: Record<string, number> = {};
  for (const [key, temp] of Object.entries(value)) {
    if (!Object.prototype.hasOwnProperty.call(TARGET_TEMP_KEYS, key)) {
      return fail(
        `targetTemps.${key} is not a target: use ${Object.keys(TARGET_TEMP_KEYS).join(', ')}`
      );
    }
    if (!isFiniteNumber(temp) || temp < TARGET_TEMP_MIN || temp > TARGET_TEMP_MAX) {
      return fail(
        `targetTemps.${key} must be a number from ${TARGET_TEMP_MIN} to ${TARGET_TEMP_MAX}`
      );
    }
    temps[key] = temp;
  }
  return { ok: true, value: temps as TargetTemperatures };
}

/**
 * #240: the PUT /cooks/{cookId}/targets body, `{ targetTemps }`. The targets
 * are the cook's whole set after the save: a channel left out is cleared, and
 * `{}` clears them all. Each target has the limits of POST /cooks.
 */
export function validateCookTargets(body: unknown): Validated<TargetTemperatures> {
  if (!isPlainObject(body)) {
    return fail('Request body must be a JSON object');
  }
  const extra = Object.keys(body).find(key => key !== 'targetTemps');
  if (extra !== undefined) {
    return fail(`${extra} is not a targets field`);
  }
  if (body['targetTemps'] === undefined) {
    return fail('targetTemps is required: send {} to clear every target');
  }
  return targetTemps(body['targetTemps']);
}

/** POST /cooks body → a start request, or a 400 message naming the field. */
export function validateStartCook(body: unknown): Validated<ValidStartCook> {
  if (!isPlainObject(body)) {
    return fail('Request body must be a JSON object');
  }
  const extra = Object.keys(body).find(
    key => !(START_COOK_KEYS as readonly string[]).includes(key)
  );
  if (extra !== undefined) {
    return fail(`${extra} is not a start-cook field`);
  }

  const name = text(body['name'], 'name', COOK_NAME_MAX_LENGTH);
  if (!name.ok) return name;

  const deviceId = body['deviceId'];
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    return fail('deviceId must be a non-empty string');
  }

  const meatType = text(body['meatType'], 'meatType', COOK_MEAT_TYPE_MAX_LENGTH);
  if (!meatType.ok) return meatType;

  // MG-84: the client-supplied id is the idempotency key. No server-minted
  // fallback: a request without one could not be retried safely.
  const id = body['id'];
  if (typeof id !== 'string' || !UUID_PATTERN.test(id)) {
    return fail('id is required and must be a UUID generated by the client');
  }

  const value: {
    -readonly [K in keyof ValidStartCook]: ValidStartCook[K];
  } = { id, name: name.value, deviceId, meatType: meatType.value };

  if (body['weight'] !== undefined) {
    const weight = body['weight'];
    if (!isFiniteNumber(weight) || weight <= 0 || weight > COOK_WEIGHT_MAX) {
      return fail(`weight must be a number greater than 0 and at most ${COOK_WEIGHT_MAX}`);
    }
    value.weight = weight;
  }

  if (body['targetTemps'] !== undefined) {
    const checked = targetTemps(body['targetTemps']);
    if (!checked.ok) return checked;
    value.targetTemps = checked.value;
  }

  if (body['notes'] !== undefined) {
    const notes = body['notes'];
    if (typeof notes !== 'string' || notes.length > COOK_NOTES_MAX_LENGTH) {
      return fail(`notes must be a string of at most ${COOK_NOTES_MAX_LENGTH} characters`);
    }
    value.notes = notes;
  }

  return { ok: true, value };
}
