import type { PutUserProfileRequest, User } from '@meatgeekv2/api-interfaces';

import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { expectNoSystemProperties } from '../lib/checks';
import { defineProofs } from '../lib/proof';

/**
 * HAR-27 (MG-81) — the caller's profile is a real Cosmos document keyed by the
 * authenticated identity: a PUT writes it and a GET reads the same name back.
 * Every response is checked for Cosmos system properties, and every route must
 * report its request charge (the runner's default).
 *
 * The acceptance identity is the CI service principal, whose profile persists
 * between runs, so the first PUT may create (201) or replace (200); a 404 first
 * is not expected. The name is run-unique so the read-back proves this run's
 * write. The email is a fixed `.invalid` address. Profiles are not deleted:
 * there is no delete route.
 */

const ACCEPTANCE_EMAIL = 'acceptance@example.invalid';

/** Fail unless the body is shaped like an api-interfaces User. */
function expectUser(api: AcceptanceApi, response: AcceptanceResponse): User {
  const value = response.body;
  api.check(response, value !== null && typeof value === 'object', 'body is not a JSON object');
  const user = value as Record<string, unknown>;
  for (const field of ['id', 'name', 'email', 'createdAt']) {
    api.check(response, typeof user[field] === 'string', `user.${field} is not a string`);
  }
  api.check(
    response,
    user['preferences'] !== null && typeof user['preferences'] === 'object',
    'user.preferences is not an object'
  );
  api.check(response, Array.isArray(user['devices']), 'user.devices is not an array');
  api.check(
    response,
    /^[^:]+:[^:]+$/.test(user['id'] as string),
    'user.id is not a "<tid>:<oid>" identity'
  );
  return user as unknown as User;
}

export default defineProofs('users', () => {
  let written: { name: string; id: string; createdAt: string } | undefined;

  return [
    {
      name: 'PUT /users/me writes the caller profile',
      async run(api: AcceptanceApi) {
        const body: PutUserProfileRequest = {
          name: `Acceptance ${api.runId}`,
          email: ACCEPTANCE_EMAIL,
        };
        const response = await api.request<User>({ method: 'PUT', path: '/users/me', body });
        api.check(
          response,
          response.status === 200 || response.status === 201,
          `expected 200 or 201, got ${response.status}`
        );
        expectNoSystemProperties(api, response);
        const user = expectUser(api, response);
        api.check(response, user.name === body.name, 'user.name is not the name sent');
        api.check(response, user.email === ACCEPTANCE_EMAIL, 'user.email is not the email sent');
        written = { name: body.name, id: user.id, createdAt: user.createdAt };
      },
    },
    {
      name: 'GET /users/me reads the name back',
      async run(api: AcceptanceApi) {
        if (!written) {
          throw new Error('no profile was written by an earlier proof');
        }
        const response = await api.request<User>({ method: 'GET', path: '/users/me' });
        api.expectStatus(response, 200);
        expectNoSystemProperties(api, response);
        const user = expectUser(api, response);
        api.check(response, user.name === written.name, "user.name is not this run's name");
        api.check(response, user.id === written.id, 'user.id differs from the PUT response');
        api.check(
          response,
          user.createdAt === written.createdAt,
          'user.createdAt differs from the PUT response'
        );
      },
    },
  ];
});
