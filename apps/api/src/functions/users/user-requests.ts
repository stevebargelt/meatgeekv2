import type { UserPreferences } from '@meatgeekv2/api-interfaces';

import { isPlainObject, type UserProfileInput } from '../../shared/cosmos/users-repository';

/**
 * HAR-27 (MG-81) — validation of the PUT /users/me body. Returns the cleaned
 * profile or one fixed message for a 400 VALIDATION_ERROR.
 *
 * Identity is never part of the body: `id` and `userId` are rejected with their
 * own message, and any other key outside `name`, `email`, `preferences` is
 * rejected too, so a body can never set `devices`, `createdAt`, `subscription`
 * or `lastLogin`.
 */

export const USER_NAME_MAX_LENGTH = 100;
export const USER_EMAIL_MAX_LENGTH = 254;
export const USER_EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export type Validated<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly message: string };

const PROFILE_KEYS = ['name', 'email', 'preferences'];
const IDENTITY_KEYS = ['id', 'userId'];

function fail<T>(message: string): Validated<T> {
  return { ok: false, message };
}

export function validatePutUserProfile(body: unknown): Validated<UserProfileInput> {
  if (!isPlainObject(body)) {
    return fail('Request body must be a JSON object');
  }
  const identity = IDENTITY_KEYS.find(key => key in body);
  if (identity !== undefined) {
    return fail(`${identity} must not be sent: the profile belongs to the authenticated caller`);
  }
  const extra = Object.keys(body).find(key => !PROFILE_KEYS.includes(key));
  if (extra !== undefined) {
    return fail(`${extra} is not a profile field`);
  }

  const { name, email, preferences } = body;
  if (typeof name !== 'string') {
    return fail('name must be a string');
  }
  const trimmedName = name.trim();
  if (trimmedName.length === 0 || trimmedName.length > USER_NAME_MAX_LENGTH) {
    return fail(`name must be 1-${USER_NAME_MAX_LENGTH} non-blank characters`);
  }

  if (typeof email !== 'string') {
    return fail('email must be a string');
  }
  const trimmedEmail = email.trim();
  if (trimmedEmail.length > USER_EMAIL_MAX_LENGTH || !USER_EMAIL_PATTERN.test(trimmedEmail)) {
    return fail(`email must be a valid address of at most ${USER_EMAIL_MAX_LENGTH} characters`);
  }

  if (preferences !== undefined && !isPlainObject(preferences)) {
    return fail('preferences must be an object');
  }

  return {
    ok: true,
    value: {
      name: trimmedName,
      email: trimmedEmail,
      ...(preferences !== undefined
        ? { preferences: preferences as Partial<UserPreferences> }
        : {}),
    },
  };
}
