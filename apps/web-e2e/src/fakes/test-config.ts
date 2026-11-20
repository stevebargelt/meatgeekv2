/**
 * What the fakes route `/config.json` to. The tenant and client are not real
 * Entra ids, and api.test is a reserved TLD (RFC 2606) that never resolves: if
 * a request escaped the fakes it could not reach anything.
 */
export const TEST_CONFIG = {
  apiBaseUrl: 'https://api.test/api',
  tenantId: '00000000-0000-4000-8000-0000000000e2',
  clientId: '11111111-1111-4111-8111-1111111111e2',
  apiScope: 'api://e2e-api/access_as_user',
} as const;

export type TestConfig = typeof TEST_CONFIG;

/** The signed-in user the fake Entra issues tokens for. */
export const TEST_USER = {
  name: 'Pat Pitmaster',
  username: 'pat@e2e.test',
  oid: '22222222-2222-4222-8222-2222222222e2',
} as const;

export type TestUser = typeof TEST_USER;
