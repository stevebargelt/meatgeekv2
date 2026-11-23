/**
 * HAR-20 (MG-80) — the devices handlers, with NO Azure and NO credentials.
 * HAR-85 adds DELETE /devices/{id}; HAR-136 makes it a release (its own cases
 * are in delete-device.spec.ts). Here DELETE runs with no cook lock and a hub
 * with no twin for the device, so the HAR-85 cases keep their meaning.
 *
 * Each handler runs over the REAL DevicesRepository on an in-memory container
 * that stamps Cosmos system properties on every document, so the
 * no-underscore-keys assertions test the actual mapping. Principals are real
 * base64 X-MS-CLIENT-PRINCIPAL headers read by the real principal.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Device } from '@meatgeekv2/api-interfaces';

import { principalFromRequest } from '../../shared/auth/principal';
import { CosmosConfigError } from '../../shared/cosmos/cosmos-adapter';
import { CooksRepository } from '../../shared/cosmos/cooks-repository';
import { DevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  COOKS_READ_CHARGE,
  FakeCooksContainer,
} from '../../shared/cosmos/fake-cooks-container.testing';
import {
  DELETE_CHARGE,
  FAKE_ACCOUNT_ENDPOINT,
  FakeDevicesContainer,
  QUERY_CHARGE,
  READ_CHARGE,
  WRITE_CHARGE,
} from '../../shared/cosmos/fake-devices-container.testing';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import { DeviceTwinError } from '../../shared/iothub/device-twin';
import { FakeTwinHub } from '../../shared/iothub/fake-device-twin.testing';
import { deleteDeviceHandler, type DeleteDeviceDeps } from './delete-device';
import { defaultDevicesDeps } from './devices-http';
import { getDeviceHandler } from './get-device';
import { getDevicesHandler } from './get-devices';
import { registerDeviceHandler } from './register-device';
import { updateDeviceHandler } from './update-device';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const OTHER_OID = 'oid-zzzz-9999';
const USER_ID = `${TID}:${OID}`;
const OTHER_USER_ID = `${TID}:${OTHER_OID}`;

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
  params?: Record<string, string>;
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
    params: options.params ?? {},
  } as unknown as HttpRequest;
}

function context() {
  const logs: string[] = [];
  const errors: string[] = [];
  const warnings: string[] = [];
  const ctx = {
    invocationId: 'inv-7',
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => warnings.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
  } as unknown as InvocationContext;
  return { ctx, logs, errors, warnings };
}

function setup() {
  const fake = new FakeDevicesContainer();
  const getRepository = jest.fn(() => new DevicesRepository(fake.asContainer()));
  const cooks = new FakeCooksContainer();
  const twins = new FakeTwinHub();
  // DeleteDeviceDeps is the DevicesHandlerDeps every other route takes, plus
  // the cook lock and the twin hub DELETE uses.
  const deps: DeleteDeviceDeps = {
    resolvePrincipal: principalFromRequest,
    getRepository,
    getCooksRepository: () => new CooksRepository(cooks.asContainer()),
    getDeviceTwin: () => twins,
  };
  return { fake, deps, getRepository, cooks, twins };
}

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: 'grill-1',
    userId: USER_ID,
    name: 'Backyard Smoker',
    model: 'MeatGeek V1',
    isActive: true,
    ...overrides,
  };
}

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
  deps: DeleteDeviceDeps
) => Promise<HttpResponseInit>;

/** One valid, successful-path request per route, for the shared cases below. */
const ROUTES: Array<{ name: string; handler: Handler; request: () => RequestOptions }> = [
  { name: 'GET /devices', handler: getDevicesHandler, request: () => ({}) },
  {
    name: 'POST /devices',
    handler: registerDeviceHandler,
    request: () => ({ body: { deviceId: 'grill-9', name: 'New one', model: 'MeatGeek V2' } }),
  },
  {
    name: 'GET /devices/{id}',
    handler: getDeviceHandler,
    request: () => ({ params: { id: 'grill-1' } }),
  },
  {
    name: 'PATCH /devices/{id}',
    handler: updateDeviceHandler,
    request: () => ({ params: { id: 'grill-1' }, body: { location: 'Garage' } }),
  },
  {
    name: 'DELETE /devices/{id}',
    handler: deleteDeviceHandler,
    request: () => ({ params: { id: 'grill-1' } }),
  },
];

describe('HAR-20 devices routes — shared contract', () => {
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

    it('answers 401 for an unparseable principal', async () => {
      const { deps, getRepository } = setup();
      const { ctx } = context();

      const response = await handler(request({ ...valid(), principal: '%%%' }), ctx, deps);

      expect(response.status).toBe(401);
      expect(getRepository).not.toHaveBeenCalled();
    });

    it('answers a sanitized 500 when the devices container setting is missing (CosmosConfigError)', async () => {
      const { deps } = setup();
      deps.getRepository = () => {
        throw new CosmosConfigError('COSMOSDB_DEVICES_CONTAINER_NAME');
      };
      const { ctx, errors } = context();

      const response = await handler(request(valid()), ctx, deps);

      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        error: 'INTERNAL_SERVER_ERROR',
        message: expect.stringMatching(/^Failed to /),
        requestId: 'inv-7',
      });
      expect(JSON.stringify(response.jsonBody)).not.toContain('COSMOSDB');
      expect(errors.join('\n')).toContain('cosmos_devices_container_not_configured');
    });

    it('answers a sanitized 500 on a Cosmos failure, leaking no endpoint or claim', async () => {
      const { fake, deps } = setup();
      fake.seed(device());
      for (const operation of ['read', 'query', 'create', 'replace', 'delete'] as const) {
        fake.failNext(operation, 503);
      }
      const { ctx, errors, logs } = context();

      const response = await handler(request(valid()), ctx, deps);

      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        error: 'INTERNAL_SERVER_ERROR',
        message: expect.stringMatching(/^Failed to /),
        requestId: 'inv-7',
      });
      expect(header(response, REQUEST_CHARGE_HEADER)).toMatch(/^\d+(\.\d+)?$/);
      const everything = [JSON.stringify(response), ...errors, ...logs].join('\n');
      for (const secret of [FAKE_ACCOUNT_ENDPOINT, 'documents.azure.com', OID, TID]) {
        expect(everything).not.toContain(secret);
      }
      expect(errors.join('\n')).toContain('cosmos_status_503');
    });

    it('returns no key starting with `_` and carries the request-charge header', async () => {
      const { fake, deps } = setup();
      fake.seed(
        device({ configuration: { temperatureUnit: 'celsius' } as Device['configuration'] })
      );
      const { ctx } = context();

      const response = await handler(request(valid()), ctx, deps);

      expect(response.status).toBeLessThan(300);
      expect(underscoreKeys(response.jsonBody)).toEqual([]);
      expect(Number(header(response, REQUEST_CHARGE_HEADER))).toBeGreaterThan(0);
    });

    it('HAR-143: never answers with connectionStatus, even for a document stored with it', async () => {
      const { fake, deps } = setup();
      fake.seed({ ...device(), connectionStatus: 'online' } as Device);
      const { ctx } = context();

      const response = await handler(request(valid()), ctx, deps);

      expect(response.status).toBeLessThan(300);
      expect(JSON.stringify(response.jsonBody ?? null)).not.toContain('connectionStatus');
      // POST /devices writes a new document: it carries no connectionStatus.
      expect(fake.stored('grill-9') ?? {}).not.toHaveProperty('connectionStatus');
    });
  });
});

/** HAR-143: what a device whose twin could not be read reports. */
const UNKNOWN = { state: 'unknown', lastActivityAt: null } as const;

describe('GET /devices', () => {
  it('returns 200 { devices } for the caller only', async () => {
    const { fake, deps } = setup();
    fake.seed(device());
    fake.seed(device({ id: 'grill-2', name: 'Patio' }));
    fake.seed(device({ id: 'theirs', userId: OTHER_USER_ID }));
    const { ctx } = context();

    const response = await getDevicesHandler(request(), ctx, deps);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      devices: [
        { ...device(), connection: UNKNOWN },
        { ...device({ id: 'grill-2', name: 'Patio' }), connection: UNKNOWN },
      ],
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(QUERY_CHARGE));
  });

  it('HAR-143: maps each twin to connected / disconnected and its lastActivityTime', async () => {
    const { fake, deps, twins } = setup();
    fake.seed(device({ id: 'grill-1', name: 'A' }));
    fake.seed(device({ id: 'grill-2', name: 'B' }));
    twins.addDevice('grill-1').setConnection('grill-1', {
      connectionState: 'Connected',
      lastActivityTime: '2026-11-20T12:34:56.1234567Z',
    });
    twins.addDevice('grill-2').setConnection('grill-2', {
      connectionState: 'Disconnected',
      lastActivityTime: '2026-11-19T08:00:00Z',
    });
    const { ctx } = context();

    const response = await getDevicesHandler(request(), ctx, deps);

    expect(response.status).toBe(200);
    const { devices } = response.jsonBody as { devices: Device[] };
    expect(devices.map(d => [d.id, d.connection])).toEqual([
      ['grill-1', { state: 'connected', lastActivityAt: '2026-11-20T12:34:56.123Z' }],
      ['grill-2', { state: 'disconnected', lastActivityAt: '2026-11-19T08:00:00.000Z' }],
    ]);
  });

  it('HAR-143: a device IoT Hub has never heard from (0001-01-01) has lastActivityAt null', async () => {
    const { fake, deps, twins } = setup();
    fake.seed(device());
    twins.addDevice('grill-1').setConnection('grill-1', {
      connectionState: 'Disconnected',
      lastActivityTime: '0001-01-01T00:00:00Z',
    });

    const response = await getDevicesHandler(request(), context().ctx, deps);

    const { devices } = response.jsonBody as { devices: Device[] };
    expect(devices[0].connection).toEqual({ state: 'disconnected', lastActivityAt: null });
  });

  it('HAR-143: a device that only synced its twin is heard from at its last reported-properties write', async () => {
    const { fake, deps, twins } = setup();
    fake.seed(device());
    twins
      .addDevice(
        'grill-1',
        {},
        { claimGeneration: '0', $metadata: { $lastUpdated: '2026-11-23T09:28:49.5Z' } }
      )
      .setConnection('grill-1', {
        connectionState: 'Disconnected',
        lastActivityTime: '0001-01-01T00:00:00Z',
      });

    const response = await getDevicesHandler(request(), context().ctx, deps);

    const { devices } = response.jsonBody as { devices: Device[] };
    expect(devices[0].connection).toEqual({
      state: 'disconnected',
      lastActivityAt: '2026-11-23T09:28:49.500Z',
    });
  });

  it('HAR-143: a twin 404 or a twin failure makes that device unknown, and the list still answers 200', async () => {
    const { fake, deps, twins } = setup();
    fake.seed(device({ id: 'grill-1', name: 'A' })); // no twin: 404
    fake.seed(device({ id: 'grill-2', name: 'B' })); // the read fails
    fake.seed(device({ id: 'grill-3', name: 'C' })); // the read times out (no status)
    fake.seed(device({ id: 'grill-4', name: 'D' }));
    twins.addDevice('grill-2');
    twins.addDevice('grill-3');
    twins.addDevice('grill-4').setConnection('grill-4', {
      connectionState: 'Connected',
      lastActivityTime: '2026-11-20T12:00:00Z',
    });
    const getTwin = twins.getTwin.bind(twins);
    jest.spyOn(twins, 'getTwin').mockImplementation(async id => {
      if (id === 'grill-2') throw new DeviceTwinError('get_twin', 500);
      if (id === 'grill-3') throw new DeviceTwinError('get_twin');
      return getTwin(id);
    });
    const { ctx, logs, errors } = context();

    const response = await getDevicesHandler(request(), ctx, deps);

    expect(response.status).toBe(200);
    const { devices } = response.jsonBody as { devices: Device[] };
    expect(devices.map(d => [d.id, d.connection])).toEqual([
      ['grill-1', UNKNOWN],
      ['grill-2', UNKNOWN],
      ['grill-3', UNKNOWN],
      ['grill-4', { state: 'connected', lastActivityAt: '2026-11-20T12:00:00.000Z' }],
    ]);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(QUERY_CHARGE));
    // Counts only: no device id reaches the log.
    const logged = [...logs, ...errors].join('\n');
    expect(logged).toContain(
      'getDevices connections connected=1 disconnected=0 unknown=0 no_twin=1 failed=2'
    );
    for (const id of ['grill-1', 'grill-2', 'grill-3', 'grill-4']) {
      expect(logged).not.toContain(id);
    }
  });

  it('HAR-143: an unconfigured hub makes every device unknown, and the list still answers 200', async () => {
    const { fake, deps } = setup();
    fake.seed(device());
    deps.getDeviceTwin = () => {
      throw new DeviceTwinError('configuration');
    };

    const response = await getDevicesHandler(request(), context().ctx, deps);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ devices: [{ ...device(), connection: UNKNOWN }] });
  });

  it('HAR-143: never returns connectionStatus, even from a document stored with it', async () => {
    const { fake, deps } = setup();
    fake.seed({ ...device(), connectionStatus: 'unknown' } as Device);

    const response = await getDevicesHandler(request(), context().ctx, deps);

    const { devices } = response.jsonBody as { devices: Device[] };
    expect(devices).toHaveLength(1);
    expect(devices[0]).not.toHaveProperty('connectionStatus');
    expect(JSON.stringify(response.jsonBody)).not.toContain('connectionStatus');
  });

  it('takes identity only from the principal: ?userId= and x-user-id for another user are ignored', async () => {
    const { fake, deps } = setup();
    fake.seed(device());
    fake.seed(device({ id: 'theirs', userId: OTHER_USER_ID, name: 'Theirs' }));
    const { ctx, logs } = context();

    const response = await getDevicesHandler(
      request({ query: { userId: OTHER_USER_ID }, headers: { 'x-user-id': OTHER_USER_ID } }),
      ctx,
      deps
    );

    expect(response.status).toBe(200);
    const { devices } = response.jsonBody as { devices: Device[] };
    expect(devices.map(d => d.id)).toEqual(['grill-1']);
    expect(fake.calls[0].parameters).toEqual([{ name: '@userId', value: USER_ID }]);
    expect(logs.join('\n')).not.toContain(OID);
  });

  it('returns an empty list for a caller with no devices', async () => {
    const { deps } = setup();
    const { ctx } = context();
    const response = await getDevicesHandler(request(), ctx, deps);
    expect(response.jsonBody).toEqual({ devices: [] });
  });
});

describe('POST /devices', () => {
  it('creates the device for the principal and returns 201 with the Device', async () => {
    const { fake, deps } = setup();
    const { ctx } = context();

    const response = await registerDeviceHandler(
      request({
        body: { deviceId: 'grill-9', name: '  New one ', model: 'MeatGeek V2', location: 'Deck' },
      }),
      ctx,
      deps
    );

    expect(response.status).toBe(201);
    expect(response.jsonBody).toEqual({
      id: 'grill-9',
      userId: USER_ID,
      name: 'New one',
      model: 'MeatGeek V2',
      location: 'Deck',
      isActive: true,
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(QUERY_CHARGE + WRITE_CHARGE));
    expect(fake.calls.map(c => c.operation)).toEqual(['query', 'create']);
  });

  it('registers with no SignalR dependency and no warning (HAR-81)', async () => {
    // Readings are pushed to the owner's SignalR user, so a new device needs no
    // group membership: the handler's deps carry no SignalR client at all.
    const { fake, deps } = setup();
    const { ctx, warnings } = context();

    const response = await registerDeviceHandler(
      request({ body: { deviceId: 'grill-9', name: 'New one', model: 'MeatGeek V2' } }),
      ctx,
      deps
    );

    expect(response.status).toBe(201);
    expect(fake.stored('grill-9')).toBeDefined();
    // The production devices seam (HAR-143: the twin hub, which the GETs read
    // connections from; the test seam also carries DELETE's cook lock).
    // Neither is SignalR.
    expect(Object.keys(defaultDevicesDeps).sort()).toEqual([
      'getDeviceTwin',
      'getRepository',
      'resolvePrincipal',
    ]);
    expect(Object.keys(deps).filter(key => /signalr/i.test(key))).toEqual([]);
    expect(warnings).toEqual([]);
  });

  it('completes a partial configuration from DEFAULT_DEVICE_CONFIGURATION', async () => {
    const { deps } = setup();
    const { ctx } = context();

    const response = await registerDeviceHandler(
      request({
        body: {
          deviceId: 'grill-9',
          name: 'Configured',
          model: 'MeatGeek V2',
          configuration: { probe1Correction: -3, alertSettings: { highTempThreshold: 275 } },
        },
      }),
      ctx,
      deps
    );

    expect(response.status).toBe(201);
    expect((response.jsonBody as Device).configuration).toEqual({
      probe1Correction: -3,
      temperatureUnit: 'fahrenheit',
      pollingInterval: 30,
      alertSettings: {
        highTempThreshold: 275,
        lowTempThreshold: 0,
        enableSounds: false,
        enablePushNotifications: false,
      },
    });
  });

  it('ignores ?userId= and x-user-id: the device is owned by the principal', async () => {
    const { fake, deps } = setup();
    const { ctx } = context();

    await registerDeviceHandler(
      request({
        query: { userId: OTHER_USER_ID },
        headers: { 'x-user-id': OTHER_USER_ID },
        body: { deviceId: 'grill-9', name: 'Mine', model: 'M' },
      }),
      ctx,
      deps
    );

    expect(fake.stored('grill-9')?.['userId']).toBe(USER_ID);
  });

  it.each([
    ['a body userId', { deviceId: 'g', name: 'n', model: 'm', userId: OTHER_USER_ID }],
    ['a missing deviceId', { name: 'n', model: 'm' }],
    ['a deviceId with a slash', { deviceId: 'a/b', name: 'n', model: 'm' }],
    ['a deviceId over 128 characters', { deviceId: 'x'.repeat(129), name: 'n', model: 'm' }],
    ['a blank name', { deviceId: 'g', name: '   ', model: 'm' }],
    ['a name over 100 characters', { deviceId: 'g', name: 'n'.repeat(101), model: 'm' }],
    ['a non-string name', { deviceId: 'g', name: 7, model: 'm' }],
    ['a missing model', { deviceId: 'g', name: 'n' }],
    [
      'an unknown configuration field',
      { deviceId: 'g', name: 'n', model: 'm', configuration: { x: 1 } },
    ],
    [
      'a bad temperatureUnit',
      { deviceId: 'g', name: 'n', model: 'm', configuration: { temperatureUnit: 'kelvin' } },
    ],
    [
      'a fractional pollingInterval',
      { deviceId: 'g', name: 'n', model: 'm', configuration: { pollingInterval: 1.5 } },
    ],
    [
      'a non-boolean alert flag',
      {
        deviceId: 'g',
        name: 'n',
        model: 'm',
        configuration: { alertSettings: { enableSounds: 1 } },
      },
    ],
    ['an array body', []],
  ])('answers 400 VALIDATION_ERROR for %s, with no Cosmos call', async (_case, body) => {
    const { fake, deps } = setup();
    const { ctx } = context();

    const response = await registerDeviceHandler(request({ body }), ctx, deps);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(fake.calls).toEqual([]);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
  });

  it('accepts a 128-character deviceId and a 100-character name', async () => {
    const { deps } = setup();
    const { ctx } = context();
    const response = await registerDeviceHandler(
      request({ body: { deviceId: 'x'.repeat(128), name: 'n'.repeat(100), model: 'm' } }),
      ctx,
      deps
    );
    expect(response.status).toBe(201);
  });

  it('answers 400 for malformed JSON', async () => {
    const { deps } = setup();
    const { ctx } = context();
    const response = await registerDeviceHandler(request({ rawBody: '{nope' }), ctx, deps);
    expect(response.status).toBe(400);
  });

  it('answers the same fixed 409 DEVICE_CONFLICT for a taken id (any owner) and a taken name', async () => {
    const { fake, deps } = setup();
    fake.seed(device({ id: 'theirs', userId: OTHER_USER_ID, name: 'Theirs' }));
    fake.seed(device({ id: 'mine', name: 'Taken' }));

    const idTaken = await registerDeviceHandler(
      request({ body: { deviceId: 'theirs', name: 'Fresh', model: 'm' } }),
      context().ctx,
      deps
    );
    const nameTaken = await registerDeviceHandler(
      request({ body: { deviceId: 'fresh', name: 'Taken', model: 'm' } }),
      context().ctx,
      deps
    );

    for (const response of [idTaken, nameTaken]) {
      expect(response.status).toBe(409);
      expect(response.jsonBody).toEqual({
        error: 'DEVICE_CONFLICT',
        message: 'A device with this id or name already exists.',
        requestId: 'inv-7',
      });
      expect(header(response, REQUEST_CHARGE_HEADER)).toBeDefined();
    }
    expect(fake.stored('theirs')?.['userId']).toBe(OTHER_USER_ID);
    expect(fake.stored('fresh')).toBeUndefined();
  });
});

describe('GET /devices/{id}', () => {
  it('returns 200 with the Device the caller owns', async () => {
    const { fake, deps } = setup();
    fake.seed(device());
    const { ctx } = context();

    const response = await getDeviceHandler(request({ params: { id: 'grill-1' } }), ctx, deps);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ ...device(), connection: UNKNOWN });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
  });

  it('HAR-143: carries the connection read from the device twin', async () => {
    const { fake, deps, twins } = setup();
    fake.seed(device());
    twins.addDevice('grill-1').setConnection('grill-1', {
      connectionState: 'Connected',
      lastActivityTime: '2026-11-20T12:00:00Z',
    });

    const response = await getDeviceHandler(
      request({ params: { id: 'grill-1' } }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(200);
    expect((response.jsonBody as Device).connection).toEqual({
      state: 'connected',
      lastActivityAt: '2026-11-20T12:00:00.000Z',
    });
    expect(twins.gets).toEqual(['grill-1']);
  });

  it('HAR-143: a twin failure makes the device unknown and still answers 200', async () => {
    const { fake, deps, twins } = setup();
    fake.seed({ ...device(), connectionStatus: 'online' } as Device);
    twins.addDevice('grill-1');
    twins.failNext('get_twin', 503);
    const { ctx, logs } = context();

    const response = await getDeviceHandler(request({ params: { id: 'grill-1' } }), ctx, deps);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ ...device(), connection: UNKNOWN });
    expect(JSON.stringify(response.jsonBody)).not.toContain('connectionStatus');
    expect(logs.join('\n')).toContain('getDevice connection');
    expect(logs.join('\n')).not.toContain('grill-1');
  });

  it('HAR-143: reads no twin for a device the caller does not own', async () => {
    const { fake, deps, twins } = setup();
    fake.seed(device({ id: 'theirs', userId: OTHER_USER_ID }));
    twins.addDevice('theirs');

    const response = await getDeviceHandler(
      request({ params: { id: 'theirs' } }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(404);
    expect(twins.gets).toEqual([]);
  });

  it('answers 404 for a foreign device, identical to an unknown one', async () => {
    const { fake, deps } = setup();
    fake.seed(device({ id: 'theirs', userId: OTHER_USER_ID }));

    const foreign = await getDeviceHandler(
      request({ params: { id: 'theirs' } }),
      context().ctx,
      deps
    );
    const unknown = await getDeviceHandler(
      request({ params: { id: 'nobody' } }),
      context().ctx,
      deps
    );

    expect(foreign.status).toBe(404);
    expect(foreign.jsonBody).toEqual(unknown.jsonBody);
    expect(foreign.jsonBody).toEqual({
      error: 'NOT_FOUND',
      message: 'Device not found',
      requestId: 'inv-7',
    });
    expect(header(foreign, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
  });

  it('answers 404 for another user’s device even with ?userId= / x-user-id naming that user', async () => {
    const { fake, deps } = setup();
    fake.seed(device({ id: 'theirs', userId: OTHER_USER_ID }));

    const response = await getDeviceHandler(
      request({
        params: { id: 'theirs' },
        query: { userId: OTHER_USER_ID },
        headers: { 'x-user-id': OTHER_USER_ID },
      }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(404);
  });
});

describe('PATCH /devices/{id}', () => {
  it('merges configuration over the stored one and returns 200 with the Device', async () => {
    const { fake, deps } = setup();
    fake.seed(
      device({
        configuration: {
          temperatureUnit: 'celsius',
          pollingInterval: 30,
          probe1Correction: -2,
          alertSettings: {
            highTempThreshold: 300,
            lowTempThreshold: 0,
            enableSounds: true,
            enablePushNotifications: false,
          },
        },
      })
    );
    const { ctx } = context();

    const response = await updateDeviceHandler(
      request({
        params: { id: 'grill-1' },
        body: {
          name: 'Renamed',
          location: 'Garage',
          configuration: { pollingInterval: 10, alertSettings: { lowTempThreshold: 150 } },
        },
      }),
      ctx,
      deps
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(
      device({
        name: 'Renamed',
        location: 'Garage',
        configuration: {
          temperatureUnit: 'celsius',
          pollingInterval: 10,
          probe1Correction: -2,
          alertSettings: {
            highTempThreshold: 300,
            lowTempThreshold: 150,
            enableSounds: true,
            enablePushNotifications: false,
          },
        },
      })
    );
    expect(fake.calls.find(c => c.operation === 'replace')?.ifMatch).toMatch(/^"etag-/);
  });

  it('answers 404 for a foreign device and leaves it untouched', async () => {
    const { fake, deps } = setup();
    fake.seed(device({ id: 'theirs', userId: OTHER_USER_ID, location: 'Theirs' }));

    const response = await updateDeviceHandler(
      request({ params: { id: 'theirs' }, body: { location: 'Mine now' } }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ error: 'NOT_FOUND', message: 'Device not found' });
    expect(fake.stored('theirs')?.['location']).toBe('Theirs');
    expect(fake.calls.map(c => c.operation)).toEqual(['read']);
  });

  it('answers 404 for an unknown device', async () => {
    const { deps } = setup();
    const response = await updateDeviceHandler(
      request({ params: { id: 'nobody' }, body: { location: 'x' } }),
      context().ctx,
      deps
    );
    expect(response.status).toBe(404);
  });

  it('answers 409 CONCURRENT_UPDATE when the ETag no longer matches', async () => {
    const { fake, deps } = setup();
    fake.seed(device());
    fake.beforeReplace = id => fake.touch(id);

    const response = await updateDeviceHandler(
      request({ params: { id: 'grill-1' }, body: { location: 'Late' } }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ error: 'CONCURRENT_UPDATE' });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE + WRITE_CHARGE));
  });

  it('answers 409 DEVICE_CONFLICT when renaming onto another of the caller’s devices', async () => {
    const { fake, deps } = setup();
    fake.seed(device());
    fake.seed(device({ id: 'grill-2', name: 'Patio' }));

    const response = await updateDeviceHandler(
      request({ params: { id: 'grill-1' }, body: { name: 'Patio' } }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ error: 'DEVICE_CONFLICT' });
  });

  it.each([
    ['an empty body', {}],
    ['a userId', { userId: OTHER_USER_ID }],
    ['isActive', { isActive: false }],
    ['a blank name', { name: ' ' }],
    ['a configuration array', { configuration: [] }],
    ['a pollingInterval of 0', { configuration: { pollingInterval: 0 } }],
  ])('answers 400 VALIDATION_ERROR for %s, with no Cosmos call', async (_case, body) => {
    const { fake, deps } = setup();
    fake.seed(device());

    const response = await updateDeviceHandler(
      request({ params: { id: 'grill-1' }, body }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(fake.calls).toEqual([]);
  });
});

describe('DELETE /devices/{id} (HAR-85)', () => {
  it('answers 204 with no body, deletes the device, and carries every read and the delete RU', async () => {
    const { fake, deps } = setup();
    fake.seed(device());
    const { ctx, logs } = context();

    const response = await deleteDeviceHandler(request({ params: { id: 'grill-1' } }), ctx, deps);

    expect(response.status).toBe(204);
    expect(response.jsonBody).toBeUndefined();
    expect(response.body).toBeUndefined();
    expect(header(response, 'X-Request-ID')).toBe('inv-7');
    // HAR-136: the ownership read, the cook-lock read, then the delete's own
    // read and the delete.
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(READ_CHARGE + COOKS_READ_CHARGE + READ_CHARGE + DELETE_CHARGE)
    );
    expect(fake.stored('grill-1')).toBeUndefined();
    expect(logs.join('\n')).toContain('deleteDevice deleted');
  });

  it('answers 403 DEVICE_NOT_OWNED for another user’s device and leaves it', async () => {
    const { fake, deps } = setup();
    fake.seed(device({ id: 'theirs', userId: OTHER_USER_ID }));

    const response = await deleteDeviceHandler(
      request({ params: { id: 'theirs' } }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(403);
    expect(response.jsonBody).toEqual({
      error: 'DEVICE_NOT_OWNED',
      message: 'The device is not registered to the caller.',
      requestId: 'inv-7',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(fake.stored('theirs')).toBeDefined();
    expect(fake.calls.map(c => c.operation)).toEqual(['read']);
  });

  it('answers 403 even when ?userId= / x-user-id name the owner', async () => {
    const { fake, deps } = setup();
    fake.seed(device({ id: 'theirs', userId: OTHER_USER_ID }));

    const response = await deleteDeviceHandler(
      request({
        params: { id: 'theirs' },
        query: { userId: OTHER_USER_ID },
        headers: { 'x-user-id': OTHER_USER_ID },
      }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(403);
    expect(fake.stored('theirs')).toBeDefined();
  });

  it('answers 404 DEVICE_NOT_FOUND when no device has the id, with the read RU', async () => {
    const { deps } = setup();

    const response = await deleteDeviceHandler(
      request({ params: { id: 'nobody' } }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(404);
    expect(response.jsonBody).toEqual({
      error: 'DEVICE_NOT_FOUND',
      message: 'Device not found',
      requestId: 'inv-7',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
  });

  it('answers 404 DEVICE_NOT_FOUND for a second delete of the same device', async () => {
    const { fake, deps } = setup();
    fake.seed(device());

    const first = await deleteDeviceHandler(
      request({ params: { id: 'grill-1' } }),
      context().ctx,
      deps
    );
    const second = await deleteDeviceHandler(
      request({ params: { id: 'grill-1' } }),
      context().ctx,
      deps
    );

    expect([first.status, second.status]).toEqual([204, 404]);
    expect(second.jsonBody).toMatchObject({ error: 'DEVICE_NOT_FOUND' });
  });

  it('answers 401 without a principal: no Cosmos call, no RU header, nothing deleted', async () => {
    const { fake, deps, getRepository } = setup();
    fake.seed(device());

    const response = await deleteDeviceHandler(
      request({ params: { id: 'grill-1' }, principal: null }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(401);
    expect(response.jsonBody).toMatchObject({ error: 'UNAUTHENTICATED' });
    expect(getRepository).not.toHaveBeenCalled();
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
    expect(fake.stored('grill-1')).toBeDefined();
  });

  it('answers a sanitized 500 carrying every read’s RU plus the failed delete’s', async () => {
    const { fake, deps } = setup();
    fake.seed(device());
    fake.failNext('delete', 503);
    const { ctx, errors } = context();

    const response = await deleteDeviceHandler(request({ params: { id: 'grill-1' } }), ctx, deps);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to delete device',
      requestId: 'inv-7',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(READ_CHARGE + COOKS_READ_CHARGE + READ_CHARGE + DELETE_CHARGE)
    );
    expect(errors.join('\n')).toContain('deleteDevice failed: cosmos_status_503');
    expect(errors.join('\n')).not.toContain(FAKE_ACCOUNT_ENDPOINT);
  });
});

describe('source guards', () => {
  const DIR = __dirname;
  const sources = fs
    .readdirSync(DIR)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map(file => fs.readFileSync(path.join(DIR, file), 'utf8'));

  it('reads no identity from the query string or an x-user-id header', () => {
    for (const source of sources) {
      expect(source).not.toMatch(/query\.get\(\s*['"]userId['"]/);
      expect(source).not.toMatch(/headers\.get\(\s*['"]x-user-id/i);
    }
  });

  it('uses the Device contract from @meatgeekv2/api-interfaces with no local re-declaration', () => {
    for (const source of sources) {
      expect(source).not.toMatch(/\binterface\s+Device\b/);
    }
  });
});
