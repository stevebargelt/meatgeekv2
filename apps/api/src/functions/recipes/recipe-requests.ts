import type {
  RecipeCookMethod,
  RecipeMeatType,
  TargetTemperatures,
} from '@meatgeekv2/api-interfaces';

import {
  RECIPE_ID_PATTERN,
  type RecipeContent,
  type RecipeUpdate,
} from '../../shared/cosmos/recipes-repository';
import { isPlainObject } from '../../shared/cosmos/users-repository';

/**
 * HAR-36 (MG-82) — validation of the recipes route inputs: the POST and PATCH
 * bodies, the `{id}` path parameter and the `meatType` list filter. Each
 * validator returns the cleaned value or one fixed message for a 400
 * VALIDATION_ERROR, and runs before any Cosmos call.
 *
 * Unknown body keys are rejected rather than ignored. `id`, `userId`,
 * `createdAt` and `updatedAt` are server-owned and rejected with their own
 * message: the owner comes from the principal, the id and timestamps from the
 * server.
 */

export const RECIPE_NAME_MAX_LENGTH = 200;
export const RECIPE_DESCRIPTION_MAX_LENGTH = 2000;
export const RECIPE_MAX_INSTRUCTIONS = 100;
export const RECIPE_INSTRUCTION_MAX_LENGTH = 2000;
export const RECIPE_MAX_TAGS = 20;
export const RECIPE_TAG_MAX_LENGTH = 50;
/** The TargetTemperatures bounds from cook.yaml, degrees F. */
export const TARGET_TEMP_MIN = -50;
export const TARGET_TEMP_MAX = 1000;

export const RECIPE_MEAT_TYPES: readonly RecipeMeatType[] = [
  'beef',
  'pork',
  'chicken',
  'fish',
  'vegetarian',
  'other',
];
export const RECIPE_COOK_METHODS: readonly RecipeCookMethod[] = [
  'smoke',
  'grill',
  'roast',
  'braise',
];

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const RECIPE_KEYS = [
  'name',
  'description',
  'meatType',
  'cookMethod',
  'targetTemps',
  'estimatedDuration',
  'instructions',
  'tags',
] as const satisfies readonly (keyof RecipeContent)[];
const SERVER_OWNED_KEYS = ['id', 'userId', 'createdAt', 'updatedAt'];
const TARGET_TEMP_KEYS = [
  'grill',
  'probe1',
  'probe2',
  'probe3',
  'probe4',
] as const satisfies readonly (keyof TargetTemperatures)[];

function fail<T>(message: string): Validated<T> {
  return { ok: false, message };
}

function ok<T>(value: T): Validated<T> {
  return { ok: true, value };
}

/** A trimmed string of `min`–`max` characters. */
function text(value: unknown, field: string, min: number, max: number): Validated<string> {
  if (typeof value !== 'string') {
    return fail(`${field} must be a string`);
  }
  const trimmed = value.trim();
  if (trimmed.length < min || trimmed.length > max) {
    return fail(
      min > 0
        ? `${field} must be ${min}-${max} non-blank characters`
        : `${field} must be at most ${max} characters`
    );
  }
  return ok(trimmed);
}

function oneOf<T extends string>(
  value: unknown,
  field: string,
  allowed: readonly T[]
): Validated<T> {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    return fail(`${field} must be one of ${allowed.join(', ')}`);
  }
  return ok(value as T);
}

function targetTemps(value: unknown): Validated<TargetTemperatures> {
  if (!isPlainObject(value)) {
    return fail('targetTemps must be an object');
  }
  const extra = Object.keys(value).find(
    key => !(TARGET_TEMP_KEYS as readonly string[]).includes(key)
  );
  if (extra !== undefined) {
    return fail(`targetTemps.${extra} is not a probe (use grill, probe1-probe4)`);
  }
  const temps: TargetTemperatures = {};
  for (const key of TARGET_TEMP_KEYS) {
    const temp = value[key];
    if (temp === undefined) continue;
    if (
      typeof temp !== 'number' ||
      !Number.isFinite(temp) ||
      temp < TARGET_TEMP_MIN ||
      temp > TARGET_TEMP_MAX
    ) {
      return fail(
        `targetTemps.${key} must be a number from ${TARGET_TEMP_MIN} to ${TARGET_TEMP_MAX}`
      );
    }
    temps[key] = temp;
  }
  return ok(temps);
}

function stringList(
  value: unknown,
  field: string,
  maxItems: number,
  maxLength: number
): Validated<string[]> {
  if (!Array.isArray(value) || value.length > maxItems) {
    return fail(`${field} must be an array of at most ${maxItems} strings`);
  }
  const items: string[] = [];
  for (const item of value) {
    const checked = text(item, `each of ${field}`, 1, maxLength);
    if (!checked.ok) return checked;
    items.push(checked.value);
  }
  return ok(items);
}

/** One validator per recipe field, keyed by field: each is run only on a value
 *  that is present. */
const FIELD_VALIDATORS: {
  readonly [K in keyof RecipeContent]-?: (value: unknown) => Validated<RecipeContent[K]>;
} = {
  name: value => text(value, 'name', 1, RECIPE_NAME_MAX_LENGTH),
  description: value => text(value, 'description', 0, RECIPE_DESCRIPTION_MAX_LENGTH),
  meatType: value => oneOf(value, 'meatType', RECIPE_MEAT_TYPES),
  cookMethod: value => oneOf(value, 'cookMethod', RECIPE_COOK_METHODS),
  targetTemps,
  estimatedDuration: value =>
    typeof value === 'number' && Number.isFinite(value) && value > 0
      ? ok(value)
      : fail('estimatedDuration must be a number of hours greater than 0'),
  instructions: value =>
    stringList(value, 'instructions', RECIPE_MAX_INSTRUCTIONS, RECIPE_INSTRUCTION_MAX_LENGTH),
  tags: value => stringList(value, 'tags', RECIPE_MAX_TAGS, RECIPE_TAG_MAX_LENGTH),
};

/** Validates every recipe field present in `body`. Required-ness is the caller's. */
function recipeFields(body: Record<string, unknown>): Validated<RecipeUpdate> {
  const fields: Record<string, unknown> = {};
  for (const key of RECIPE_KEYS) {
    if (body[key] === undefined) continue;
    const result = (FIELD_VALIDATORS[key] as (value: unknown) => Validated<unknown>)(body[key]);
    if (!result.ok) return result;
    fields[key] = result.value;
  }
  return ok(fields as RecipeUpdate);
}

/** Rejects a non-object body, a server-owned key, or an unknown key. */
function checkKeys(body: unknown): Validated<Record<string, unknown>> {
  if (!isPlainObject(body)) {
    return fail('Request body must be a JSON object');
  }
  const owned = SERVER_OWNED_KEYS.find(key => key in body);
  if (owned !== undefined) {
    return fail(`${owned} must not be sent: it is set by the server`);
  }
  const extra = Object.keys(body).find(key => !(RECIPE_KEYS as readonly string[]).includes(key));
  if (extra !== undefined) {
    return fail(`${extra} is not a recipe field`);
  }
  return ok(body);
}

/** POST /recipes body → recipe content, or a 400 message. */
export function validateCreateRecipe(body: unknown): Validated<RecipeContent> {
  const keys = checkKeys(body);
  if (!keys.ok) return keys;
  if (keys.value['name'] === undefined) {
    return fail('name is required');
  }
  if (keys.value['meatType'] === undefined) {
    return fail('meatType is required');
  }
  const fields = recipeFields(keys.value);
  if (!fields.ok) return fields;
  return ok(fields.value as RecipeContent);
}

/** PATCH /recipes/{id} body → an update, or a 400 message. At least one field. */
export function validateUpdateRecipe(body: unknown): Validated<RecipeUpdate> {
  const keys = checkKeys(body);
  if (!keys.ok) return keys;
  if (!RECIPE_KEYS.some(key => keys.value[key] !== undefined)) {
    return fail(`Send at least one of ${RECIPE_KEYS.join(', ')}`);
  }
  return recipeFields(keys.value);
}

/** The `{id}` path parameter: a UUID, or a 400 message. */
export function validateRecipeId(id: string | undefined): Validated<string> {
  return id !== undefined && RECIPE_ID_PATTERN.test(id) ? ok(id) : fail('id must be a UUID');
}

/** The optional `meatType` list filter. `null` (absent) means no filter. */
export function validateMeatTypeFilter(
  value: string | null
): Validated<RecipeMeatType | undefined> {
  if (value === null) {
    return ok(undefined);
  }
  return oneOf(value, 'meatType', RECIPE_MEAT_TYPES);
}
