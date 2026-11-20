import type { StartCookRequest } from '../api/client';
import { validateLabel } from '../devices/validation';

/**
 * Client-side checks that mirror the API's StartCookRequest
 * (libs/api-specs/spec/components/schemas/cook.yaml). The server stays
 * authoritative; these only save a round trip.
 */
export const TARGET_KEYS = ['grill', 'probe1', 'probe2', 'probe3', 'probe4'] as const;
export type TargetKey = (typeof TARGET_KEYS)[number];

export const TARGET_LABELS: Record<TargetKey, string> = {
  grill: 'Grill target',
  probe1: 'Probe 1 target',
  probe2: 'Probe 2 target',
  probe3: 'Probe 3 target',
  probe4: 'Probe 4 target',
};

/** What the start form holds: every field as typed. */
export interface StartCookInput {
  name: string;
  meatType: string;
  weight: string;
  grill: string;
  probe1: string;
  probe2: string;
  probe3: string;
  probe4: string;
}

export const EMPTY_START_COOK: StartCookInput = {
  name: '',
  meatType: '',
  weight: '',
  grill: '',
  probe1: '',
  probe2: '',
  probe3: '',
  probe4: '',
};

export type StartCookErrors = Partial<Record<keyof StartCookInput, string>>;

/** A blank field is absent; anything else must be a finite number. */
function parseNumber(value: string): number | undefined | 'invalid' {
  const trimmed = value.trim();
  if (trimmed === '') return undefined;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : 'invalid';
}

export function validateStartCook(input: StartCookInput): StartCookErrors {
  const errors: StartCookErrors = {
    name: validateLabel('Name', input.name),
    meatType: validateLabel('Meat type', input.meatType),
  };

  const weight = parseNumber(input.weight);
  if (weight === 'invalid' || (weight !== undefined && (weight <= 0 || weight > 1000))) {
    errors.weight = 'Weight must be a number greater than 0 and at most 1000.';
  }

  for (const key of TARGET_KEYS) {
    const target = parseNumber(input[key]);
    if (target === 'invalid' || (target !== undefined && (target < 0 || target > 1000))) {
      errors[key] = `${TARGET_LABELS[key]} must be a number from 0 to 1000.`;
    }
  }

  return Object.fromEntries(
    Object.entries(errors).filter(([, message]) => message !== undefined)
  ) as StartCookErrors;
}

/**
 * The POST /cooks body for a valid input. `id` is the start intent's
 * idempotency key; blank optional fields are left out.
 */
export function toStartCookRequest(
  id: string,
  deviceId: string,
  input: StartCookInput
): StartCookRequest {
  const body: StartCookRequest = {
    id,
    deviceId,
    name: input.name.trim(),
    meatType: input.meatType.trim(),
  };
  const weight = parseNumber(input.weight);
  if (typeof weight === 'number') body.weight = weight;

  const targetTemps: NonNullable<StartCookRequest['targetTemps']> = {};
  for (const key of TARGET_KEYS) {
    const target = parseNumber(input[key]);
    if (typeof target === 'number') targetTemps[key] = target;
  }
  if (Object.keys(targetTemps).length > 0) body.targetTemps = targetTemps;
  return body;
}
