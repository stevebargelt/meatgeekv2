/**
 * HAR-27 (MG-81) — GET and PUT /users/me, with NO Azure and NO credentials.
 *
 * Both handlers run over the REAL UsersRepository and the REAL DevicesRepository
 * on in-memory containers that stamp Cosmos system properties on every
 * document, so the no-underscore-keys assertions test the actual mapping and
 * `devices` really comes from the devices owner query. Principals are real
 * base64 X-MS-CLIENT-PRINCIPAL headers read by the real principal.ts.
 */
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Device, User } from '@meatgeekv2/api-interfaces';

import { principalFromRequest } from '../../shared/auth/principal';
import { CosmosConfigError } from '../../shared/cosmos/cosmos-adapter';
import { DevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  FAKE_ACCOUNT_ENDPOINT,
  FakeDevicesContainer,
  QUERY_CHARGE,
  READ_CHARGE,
  WRITE_CHARGE,
} from '../../shared/cosmos/fake-devices-container.testing';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import { DEFAULT_USER_PREFERENCES, UsersRepository } from '../../shared/cosmos/users-repository';
import { getUserProfileHandler } from './get-user-profile';
import { putUserProfileHandler } from './put-user-profile';
import type { UsersHandlerDeps } from './users-http';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const OTHER_OID = 'oid-zzzz-9999';
const USER_ID = `${TID}:${OID}`;
const OTHER_USER_ID = `${TID}:${OTHER_OID}`;
const EMAIL = 'pitmaster@example.com';
const CREATED_AT = '2026-01-02T03:04:05.000Z';
/** The repository's injected clock: what a newly created profile's createdAt is. */
const NOW = '2026-03-04T05:06:07.890Z';

function encodedPrincipal(oid: string, tid = TID): string {
  const payload = {
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
      { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: tid },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

interface RequestOptions {
  principal?: string | null;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

function request(options: RequestOptions = {}): HttpRequest {
  const headers = new Map<string, string>(
    Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const principal = options.principal === undefined ? encodedPrincipal(OID) : options.principal;
  if (principal !== null) {
    headers.set('x-ms-client-principal', principal);
  }
  const query = new Map(Object.entries(options.query ?? {}));
  return {
    json: async () => {
      if (options.rawBody !== undefined) {
        return JSON.parse(options.rawBody);
      }
      return options.body;
    },
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: { get: (k: string) => query.get(k) ?? null },
    params: {},
  } as unknown as HttpRequest;
}

function context() {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx = {
    invocationId: 'inv-27',
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
  } as unknown as InvocationContext;
  return { ctx, logs, errors };
}

function setup() {
  const users = new FakeDevicesContainer();
  const devices = new FakeDevicesContainer();
  const devicesRepository = new DevicesRepository(devices.asContainer());
  const listDevicesByOwner = jest.spyOn(devicesRepository, 'listDevicesByOwner');
  const getRepository = jest.fn(
    () => new UsersRepository(users.asContainer(), devicesRepository, () => new Date(NOW))
  );
  const deps: UsersHandlerDeps = { resolvePrincipal: principalFromRequest, getRepository };
  return { users, devices, deps, getRepository, listDevicesByOwner };
}

function storedUser(overrides: Record<string, unknown> = {}) {
  return {
    id: USER_ID,
    name: 'Pit Master',
    email: EMAIL,
    preferences: JSON.parse(JSON.stringify(DEFAULT_USER_PREFERENCES)),
    createdAt: CREATED_AT,
    ...overrides,
  };
}

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'grill-1',
    userId: USER_ID,
    name: 'Backyard Smoker',
    model: 'MeatGeek V1',
    isActive: true,
    connectionStatus: 'unknown',
    ...overrides,
  };
}

const VALID_PUT = { name: 'Pit Master', email: EMAIL };

/** Every key, at any depth, that starts with `_`. */
function underscoreKeys(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => underscoreKeys(item, `${at}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, member]) => [
      ...(key.startsWith('_') ? [`${at}.${key}`] : []),
      ...underscoreKeys(member, `${at}.${key}`),
    ]);
  }
  return [];
}

function header(response: HttpResponseInit, name: string): string | undefined {
  return (response.headers as Record<string, string> | undefined)?.[name];
}

type Handler = (
  request: HttpRequest,
  context: InvocationContext,
  deps: UsersHandlerDeps
) => Promise<HttpResponseInit>;

const ROUTES: Array<{ name: string; handler: Handler; request: () => RequestOptions }> = [
  { name: 'GET /users/me', handler: getUserProfileHandler, request: () => ({}) },
  {
    name: 'PUT /users/me',
    handler: putUserProfileHandler,
    request: () => ({ body: { ...VALID_PUT } }),
  },
];

describe('HAR-27 /users/me — shared contract', () => {
  describe.each(ROUTES)('$name', ({ handler, request: valid }) => {
    it('answers 401 without a principal and never reaches the repository', async () => {
      const { deps, getRepository } = setup();
      const { ctx } = context();

      const response = await handler(request({ ...valid(), principal: null }), ctx, deps);

      expect(response.status).toBe(401);
      expect(response.jsonBody).toMatchObject({
        error: 'UNAUTHENTICATED',
        reason: 'principal_header_missing',
      });
      expect(getRepository).not.toHaveBeenCalled();
      expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
    });

    it('answers 401 for a principal with no tenant id', async () => {
      const { deps, getRepository } = setup();
      const { ctx } = context();
      const noTid = Buffer.from(
        JSON.stringify({
          claims: [
            { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: OID },
          ],
        })
      ).toString('base64');

      const response = await handler(request({ ...valid(), principal: noTid }), ctx, deps);

      expect(response.status).toBe(401);
      expect(response.jsonBody).toMatchObject({ reason: 'principal_tenant_id_missing' });
      expect(getRepository).not.toHaveBeenCalled();
    });

    it('answers a sanitized 500 when the users container setting is missing (CosmosConfigError)', async () => {
      const { deps } = setup();
      deps.getRepository = () => {
        throw new CosmosConfigError('COSMOSDB_USERS_CONTAINER_NAME');
      };
      const { ctx, errors } = context();

      const response = await handler(request(valid()), ctx, deps);

      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        error: 'INTERNAL_SERVER_ERROR',
        message: expect.stringMatching(/^Failed to /),
        requestId: 'inv-27',
      });
      expect(JSON.stringify(response)).not.toContain('COSMOSDB');
      expect(errors.join('\n')).toContain('cosmos_users_container_not_configured');
    });

    it.each(['users read', 'devices query'] as const)(
      'answers a sanitized 500 on a Cosmos failure (%s), leaking no endpoint, email or claim',
      async failing => {
        const { users, devices, deps } = setup();
        users.seed(storedUser());
        if (failing === 'users read') {
          users.failNext('read', 503);
        } else {
          devices.failNext('query', 503);
        }
        const { ctx, errors, logs } = context();

        const response = await handler(request(valid()), ctx, deps);

        expect(response.status).toBe(500);
        expect(response.jsonBody).toEqual({
          error: 'INTERNAL_SERVER_ERROR',
          message: expect.stringMatching(/^Failed to /),
          requestId: 'inv-27',
        });
        expect(header(response, REQUEST_CHARGE_HEADER)).toMatch(/^\d+(\.\d+)?$/);
        const everything = [JSON.stringify(response), ...errors, ...logs].join('\n');
        for (const secret of [FAKE_ACCOUNT_ENDPOINT, 'documents.azure.com', OID, TID, EMAIL]) {
          expect(everything).not.toContain(secret);
        }
        expect(errors.join('\n')).toContain('cosmos_status_503');
      }
    );

    it('returns no key starting with `_`, fills devices from the owner query, and carries the request charge', async () => {
      const { users, devices, deps, listDevicesByOwner } = setup();
      users.seed(storedUser({ unmodelled: 'kept out of responses' }));
      devices.seed(device());
      devices.seed(device({ id: 'grill-2', name: 'Patio' }));
      devices.seed(device({ id: 'theirs', userId: OTHER_USER_ID, name: 'Theirs' }));
      const { ctx } = context();

      const response = await handler(request(valid()), ctx, deps);

      expect(response.status).toBe(200);
      expect(underscoreKeys(response.jsonBody)).toEqual([]);
      const user = response.jsonBody as User & Record<string, unknown>;
      expect(Object.keys(user).sort()).toEqual(
        ['createdAt', 'devices', 'email', 'id', 'name', 'preferences'].sort()
      );
      expect(user.devices).toEqual(['grill-1', 'grill-2']);
      expect(listDevicesByOwner).toHaveBeenCalledWith(USER_ID);
      expect(devices.calls.filter(c => c.operation === 'query')[0].parameters).toEqual([
        { name: '@userId', value: USER_ID },
      ]);
      expect(Number(header(response, REQUEST_CHARGE_HEADER))).toBeGreaterThan(0);
    });
  });
});

describe('GET /users/me', () => {
  it('returns 200 with the User, its RU including the devices query', async () => {
    const { users, devices, deps } = setup();
    users.seed(storedUser());
    devices.seed(device());
    const { ctx } = context();

    const response = await getUserProfileHandler(request(), ctx, deps);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      id: USER_ID,
      name: 'Pit Master',
      email: EMAIL,
      preferences: DEFAULT_USER_PREFERENCES,
      createdAt: CREATED_AT,
      devices: ['grill-1'],
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE + QUERY_CHARGE));
    expect(users.calls).toEqual([{ operation: 'read', id: USER_ID, partitionKey: USER_ID }]);
  });

  it('returns 404 USER_NOT_FOUND, with the read charge, when the caller has no profile', async () => {
    const { users, deps, listDevicesByOwner } = setup();
    users.seed(storedUser({ id: OTHER_USER_ID }));
    const { ctx } = context();

    const response = await getUserProfileHandler(request(), ctx, deps);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ error: 'USER_NOT_FOUND', requestId: 'inv-27' });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(listDevicesByOwner).not.toHaveBeenCalled();
  });

  it('takes identity only from the principal: ?userId= and x-user-id for another user are ignored', async () => {
    const { users, deps } = setup();
    users.seed(storedUser());
    users.seed(storedUser({ id: OTHER_USER_ID, name: 'Someone Else' }));
    const { ctx, logs } = context();

    const response = await getUserProfileHandler(
      request({ query: { userId: OTHER_USER_ID }, headers: { 'x-user-id': OTHER_USER_ID } }),
      ctx,
      deps
    );

    expect(response.status).toBe(200);
    expect((response.jsonBody as User).id).toBe(USER_ID);
    expect((response.jsonBody as User).name).toBe('Pit Master');
    expect(users.calls).toEqual([{ operation: 'read', id: USER_ID, partitionKey: USER_ID }]);
    expect(logs.join('\n')).not.toContain(OID);
  });

  it('a different principal reads a different partition (wrong partition is a miss, not a leak)', async () => {
    const { users, deps } = setup();
    users.seed(storedUser());
    const { ctx } = context();

    const response = await getUserProfileHandler(
      request({ principal: encodedPrincipal(OTHER_OID) }),
      ctx,
      deps
    );

    expect(response.status).toBe(404);
    expect(users.calls).toEqual([
      { operation: 'read', id: OTHER_USER_ID, partitionKey: OTHER_USER_ID },
    ]);
  });
});

describe('PUT /users/me', () => {
  it('creates the profile with create (201): id from the principal, createdAt now, preferences over the defaults', async () => {
    const { users, devices, deps } = setup();
    devices.seed(device());
    const { ctx } = context();

    const response = await putUserProfileHandler(
      request({
        body: {
          name: '  Pit Master ',
          email: ` ${EMAIL} `,
          preferences: { temperatureUnit: 'celsius', display: { theme: 'dark' } },
        },
      }),
      ctx,
      deps
    );

    expect(response.status).toBe(201);
    const user = response.jsonBody as User;
    expect(user).toEqual({
      id: USER_ID,
      name: 'Pit Master',
      email: EMAIL,
      preferences: {
        ...DEFAULT_USER_PREFERENCES,
        temperatureUnit: 'celsius',
        display: { ...DEFAULT_USER_PREFERENCES.display, theme: 'dark' },
      },
      createdAt: NOW,
      devices: ['grill-1'],
    });
    expect(users.stored(USER_ID)!['createdAt']).toBe(NOW);
    expect(users.calls.map(c => c.operation)).toEqual(['read', 'create']);
    expect(users.calls[1]).toMatchObject({ id: USER_ID, partitionKey: USER_ID });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(READ_CHARGE + QUERY_CHARGE + WRITE_CHARGE)
    );
    // Not stored: devices, subscription, lastLogin.
    const stored = users.stored(USER_ID)!;
    expect(stored).not.toHaveProperty('devices');
    expect(stored).not.toHaveProperty('subscription');
    expect(stored).not.toHaveProperty('lastLogin');
  });

  it('replaces an existing profile (200) under If-Match, keeping createdAt', async () => {
    const { users, deps } = setup();
    users.seed(storedUser());
    const etag = users.stored(USER_ID)!['_etag'];
    const { ctx } = context();

    const response = await putUserProfileHandler(
      request({ body: { name: 'Renamed', email: 'new@example.com' } }),
      ctx,
      deps
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({
      id: USER_ID,
      name: 'Renamed',
      email: 'new@example.com',
      createdAt: CREATED_AT,
      devices: [],
    });
    expect(users.calls.map(c => c.operation)).toEqual(['read', 'replace']);
    expect(users.calls[1]).toMatchObject({ id: USER_ID, partitionKey: USER_ID, ifMatch: etag });
    expect(users.stored(USER_ID)!['createdAt']).toBe(CREATED_AT);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(READ_CHARGE + QUERY_CHARGE + WRITE_CHARGE)
    );
  });

  it('deep-merges preferences over the stored ones: objects merge key by key, scalars and arrays replace', async () => {
    const { users, deps } = setup();
    const stored = storedUser();
    stored.preferences.notifications.pushNotifications.quietHours = {
      enabled: true,
      startTime: '21:00',
      endTime: '06:00',
    };
    stored.preferences.defaultTargetTemps = { brisket: { grill: 225, meat: 203 } };
    stored.preferences.tags = ['low', 'slow'];
    users.seed(stored);
    const { ctx } = context();

    const response = await putUserProfileHandler(
      request({
        body: {
          ...VALID_PUT,
          preferences: {
            notifications: { pushNotifications: { quietHours: { endTime: '08:00' } } },
            defaultTargetTemps: { pork: { grill: 250, meat: 195 } },
            tags: ['hot'],
            timeZone: 'America/Chicago',
          },
        },
      }),
      ctx,
      deps
    );

    expect(response.status).toBe(200);
    const preferences = (response.jsonBody as User).preferences as unknown as Record<
      string,
      unknown
    > &
      User['preferences'];
    expect(preferences.notifications.pushNotifications.quietHours).toEqual({
      enabled: true,
      startTime: '21:00',
      endTime: '08:00',
    });
    expect(preferences.notifications.tempAlerts).toBe(true);
    expect(preferences.defaultTargetTemps).toEqual({
      brisket: { grill: 225, meat: 203 },
      pork: { grill: 250, meat: 195 },
    });
    expect(preferences['tags']).toEqual(['hot']);
    expect(preferences.timeZone).toBe('America/Chicago');
    expect(preferences.display).toEqual(DEFAULT_USER_PREFERENCES.display);
  });

  it('turns a 412 on the replace into 409 CONCURRENT_UPDATE', async () => {
    const { users, deps } = setup();
    users.seed(storedUser());
    users.beforeReplace = id => users.touch(id);
    const { ctx } = context();

    const response = await putUserProfileHandler(request({ body: VALID_PUT }), ctx, deps);

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ error: 'CONCURRENT_UPDATE', requestId: 'inv-27' });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(READ_CHARGE + QUERY_CHARGE + WRITE_CHARGE)
    );
    expect(users.stored(USER_ID)!['name']).toBe('Pit Master');
  });

  it('retries a create that hits 409 (a concurrent PUT) once as the update path', async () => {
    const { users, deps } = setup();
    const { ctx } = context();
    // The concurrent PUT lands between this request's read and its create.
    const create = users.items.create;
    users.items.create = async body => {
      users.seed(storedUser({ name: 'Racer' }));
      return create(body);
    };

    const response = await putUserProfileHandler(
      request({ body: { name: 'Winner', email: EMAIL } }),
      ctx,
      deps
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({ name: 'Winner', createdAt: CREATED_AT });
    expect(users.calls.map(c => c.operation)).toEqual(['read', 'create', 'read', 'replace']);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(READ_CHARGE + QUERY_CHARGE + WRITE_CHARGE + READ_CHARGE + WRITE_CHARGE)
    );
  });

  it('answers a sanitized 500 when the write fails, with the charge so far', async () => {
    const { users, deps } = setup();
    users.failNext('create', 503);
    const { ctx, errors } = context();

    const response = await putUserProfileHandler(request({ body: VALID_PUT }), ctx, deps);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ message: 'Failed to save user profile' });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(READ_CHARGE + QUERY_CHARGE + WRITE_CHARGE)
    );
    expect(errors.join('\n')).toBe('putUserProfile failed: cosmos_status_503');
  });

  it('takes identity only from the principal: body ids, ?userId= and x-user-id never redirect the write', async () => {
    const { users, deps } = setup();
    users.seed(storedUser({ id: OTHER_USER_ID, name: 'Someone Else' }));
    const { ctx } = context();

    const response = await putUserProfileHandler(
      request({
        body: VALID_PUT,
        query: { userId: OTHER_USER_ID },
        headers: { 'x-user-id': OTHER_USER_ID },
      }),
      ctx,
      deps
    );

    expect(response.status).toBe(201);
    expect((response.jsonBody as User).id).toBe(USER_ID);
    expect(users.calls.every(c => c.id === USER_ID && c.partitionKey === USER_ID)).toBe(true);
    expect(users.stored(OTHER_USER_ID)!['name']).toBe('Someone Else');
  });

  describe('validation (400 VALIDATION_ERROR, no Cosmos call)', () => {
    const cases: Array<[string, RequestOptions]> = [
      ['malformed JSON', { rawBody: '{"name":' }],
      ['a non-object body', { body: ['Pit Master'] }],
      ['body id (another user)', { body: { ...VALID_PUT, id: OTHER_USER_ID } }],
      ['body userId (another user)', { body: { ...VALID_PUT, userId: OTHER_USER_ID } }],
      ['body id equal to the caller', { body: { ...VALID_PUT, id: USER_ID } }],
      ['an unknown field', { body: { ...VALID_PUT, devices: ['grill-1'] } }],
      ['createdAt', { body: { ...VALID_PUT, createdAt: CREATED_AT } }],
      ['a missing name', { body: { email: EMAIL } }],
      ['a non-string name', { body: { ...VALID_PUT, name: 42 } }],
      ['a blank name', { body: { ...VALID_PUT, name: '   ' } }],
      ['a 101-character name', { body: { ...VALID_PUT, name: 'x'.repeat(101) } }],
      ['a missing email', { body: { name: 'Pit Master' } }],
      ['an email without @', { body: { ...VALID_PUT, email: 'pitmaster.example.com' } }],
      ['an email without a dot', { body: { ...VALID_PUT, email: 'pit@master' } }],
      ['an email with a space', { body: { ...VALID_PUT, email: 'pit master@example.com' } }],
      [
        'a 255-character email',
        { body: { ...VALID_PUT, email: `${'a'.repeat(243)}@example.com` } },
      ],
      ['preferences as a string', { body: { ...VALID_PUT, preferences: 'dark' } }],
      ['preferences as an array', { body: { ...VALID_PUT, preferences: [] } }],
      ['preferences as null', { body: { ...VALID_PUT, preferences: null } }],
    ];

    it.each(cases)('rejects %s', async (_label, options) => {
      const { users, deps, getRepository } = setup();
      const { ctx } = context();

      const response = await putUserProfileHandler(request(options), ctx, deps);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ error: 'VALIDATION_ERROR', requestId: 'inv-27' });
      expect(getRepository).not.toHaveBeenCalled();
      expect(users.calls).toEqual([]);
      expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
    });

    it('names the identity field it refused', async () => {
      const { deps } = setup();
      const { ctx } = context();
      const response = await putUserProfileHandler(
        request({ body: { ...VALID_PUT, userId: OTHER_USER_ID } }),
        ctx,
        deps
      );
      expect((response.jsonBody as { message: string }).message).toMatch(
        /^userId must not be sent/
      );
      expect(JSON.stringify(response.jsonBody)).not.toContain(OTHER_OID);
    });

    it('accepts a 100-character name and a 254-character email', async () => {
      const { deps } = setup();
      const { ctx } = context();
      const email = `${'a'.repeat(242)}@example.com`;
      expect(email).toHaveLength(254);

      const response = await putUserProfileHandler(
        request({ body: { name: 'x'.repeat(100), email } }),
        ctx,
        deps
      );

      expect(response.status).toBe(201);
    });
  });
});
