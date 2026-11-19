/**
 * HAR-35 (MG-79 part 2) — GET /temperatures/history, with NO Azure and NO
 * credentials.
 *
 * The handler runs over the REAL DevicesRepository and TemperaturesRepository on
 * in-memory containers that stamp Cosmos system properties, and reads real
 * base64 X-MS-CLIENT-PRINCIPAL headers through the real principal.ts.
 */
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Device, TemperatureHistoryResponse } from '@meatgeekv2/api-interfaces';

import { principalFromRequest } from '../../shared/auth/principal';
import { DevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  FAKE_ACCOUNT_ENDPOINT,
  FakeDevicesContainer,
  READ_CHARGE,
} from '../../shared/cosmos/fake-devices-container.testing';
import {
  FakeTemperaturesContainer,
  TEMPERATURES_QUERY_CHARGE,
  routedDocument,
} from '../../shared/cosmos/fake-temperatures-container.testing';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import { TemperaturesRepository } from '../../shared/cosmos/temperatures-repository';
import { getTemperatureHistoryHandler, type TemperatureHistoryHandlerDeps } from './get-history';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const USER_ID = `${TID}:${OID}`;
const OTHER_USER_ID = `${TID}:oid-zzzz-9999`;
const DEVICE = 'grill-1';

function encodedPrincipal(oid: string, tid = TID): string {
  const payload = {
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
      { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: tid },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function request(
  query: Record<string, string>,
  principal: string | null = encodedPrincipal(OID)
): HttpRequest {
  const headers = new Map<string, string>();
  if (principal !== null) {
    headers.set('x-ms-client-principal', principal);
  }
  const params = new URLSearchParams(query);
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: params,
    params: {},
  } as unknown as HttpRequest;
}

function context() {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx = {
    invocationId: 'inv-9',
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
  } as unknown as InvocationContext;
  return { ctx, logs, errors };
}

function device(overrides: Partial<Device> = {}): Device {
  return {
    id: DEVICE,
    userId: USER_ID,
    name: 'Backyard Smoker',
    model: 'MeatGeek V1',
    isActive: true,
    connectionStatus: 'unknown',
    ...overrides,
  };
}

function setup() {
  const devices = new FakeDevicesContainer();
  const temperatures = new FakeTemperaturesContainer();
  const getDevicesRepository = jest.fn(() => new DevicesRepository(devices.asContainer()));
  const getTemperaturesRepository = jest.fn(
    () => new TemperaturesRepository(temperatures.asContainer())
  );
  const deps: TemperatureHistoryHandlerDeps = {
    resolvePrincipal: principalFromRequest,
    getDevicesRepository,
    getTemperaturesRepository,
  };
  return { devices, temperatures, deps, getDevicesRepository, getTemperaturesRepository };
}

/** An owned device with `count` readings, one second apart from 16:00:00. */
function ownedWithReadings(count: number) {
  const fixture = setup();
  fixture.devices.seed(device());
  for (let i = 0; i < count; i += 1) {
    const enqueuedTime = new Date(Date.UTC(2026, 7, 14, 16, 0, i)).toISOString();
    fixture.temperatures.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime,
        body: { deviceId: DEVICE, timestamp: enqueuedTime, grillTemp: 200 + i },
      })
    );
  }
  return fixture;
}

function header(response: HttpResponseInit, name: string): string | undefined {
  return (response.headers as Record<string, string> | undefined)?.[name];
}

function page(response: HttpResponseInit): TemperatureHistoryResponse {
  return response.jsonBody as TemperatureHistoryResponse;
}

/** Every key at any depth of `value`. */
function keysDeep(value: unknown): string[] {
  if (Array.isArray(value)) return value.flatMap(keysDeep);
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, inner]) => [key, ...keysDeep(inner)]);
  }
  return [];
}

const ALL_CHARGES = String(READ_CHARGE + 2 * TEMPERATURES_QUERY_CHARGE);

describe('GET /temperatures/history', () => {
  it('200: a page of an owned device, oldest first, with total, offset, limit and hasMore', async () => {
    const { deps, temperatures } = ownedWithReadings(3);
    const { ctx } = context();

    const response = await getTemperatureHistoryHandler(request({ deviceId: DEVICE }), ctx, deps);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      readings: [
        { deviceId: DEVICE, timestamp: '2026-08-14T16:00:00.000Z', grillTemp: 200 },
        { deviceId: DEVICE, timestamp: '2026-08-14T16:00:01.000Z', grillTemp: 201 },
        { deviceId: DEVICE, timestamp: '2026-08-14T16:00:02.000Z', grillTemp: 202 },
      ],
      total: 3,
      offset: 0,
      limit: 100,
      hasMore: false,
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(ALL_CHARGES);
    expect(header(response, 'X-Request-ID')).toBe('inv-9');
    expect(temperatures.queries).toHaveLength(2);
  });

  it('runs the count then the page, single-partition, with the normalised filter as parameters', async () => {
    const { deps, temperatures } = ownedWithReadings(1);

    await getTemperatureHistoryHandler(
      request({
        deviceId: DEVICE,
        cookId: 'cook-7',
        // Offsets and second precision normalise to UTC with milliseconds.
        startTime: '2026-08-14T18:00:00+02:00',
        endTime: '2026-08-14T17:00:00Z',
        limit: '25',
        offset: '50',
      }),
      context().ctx,
      deps
    );

    const where =
      'c.deviceId = @deviceId AND c.SystemProperties["iothub-connection-device-id"] = @deviceId ' +
      'AND IS_OBJECT(c.Body) AND c.Body.cookId = @cookId ' +
      'AND c.SystemProperties["iothub-enqueuedtime"] >= @startTime ' +
      'AND c.SystemProperties["iothub-enqueuedtime"] < @endTime';
    const filterParameters = [
      { name: '@deviceId', value: DEVICE },
      { name: '@cookId', value: 'cook-7' },
      { name: '@startTime', value: '2026-08-14T16:00:00.000Z' },
      { name: '@endTime', value: '2026-08-14T17:00:00.000Z' },
    ];
    expect(temperatures.queries).toHaveLength(2);
    const [count, pageQuery] = temperatures.queries;
    expect(count.query).toBe(`SELECT VALUE COUNT(1) FROM c WHERE ${where}`);
    expect(count.parameters).toEqual(filterParameters);
    expect(pageQuery.query).toBe(
      `SELECT * FROM c WHERE ${where} ` +
        'ORDER BY c.SystemProperties["iothub-enqueuedtime"] ASC OFFSET @offset LIMIT @limit'
    );
    expect(pageQuery.parameters).toEqual([
      ...filterParameters,
      { name: '@offset', value: 50 },
      { name: '@limit', value: 25 },
    ]);
    for (const query of temperatures.queries) {
      expect(query.options['partitionKey']).toBe(DEVICE);
      expect(query.options).not.toHaveProperty('enableCrossPartitionQuery');
    }
  });

  it('200 with an empty page for an owned device with no readings, not 404', async () => {
    const { devices, deps } = setup();
    devices.seed(device());

    const response = await getTemperatureHistoryHandler(
      request({ deviceId: DEVICE }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      readings: [],
      total: 0,
      offset: 0,
      limit: 100,
      hasMore: false,
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(ALL_CHARGES);
  });

  it('hasMore at the boundary: true while offset + limit < total, false once it equals total', async () => {
    const { deps } = ownedWithReadings(5);
    const run = (offset: string, limit: string) =>
      getTemperatureHistoryHandler(
        request({ deviceId: DEVICE, offset, limit }),
        context().ctx,
        deps
      );

    const before = page(await run('0', '4'));
    expect(before).toMatchObject({ total: 5, offset: 0, limit: 4, hasMore: true });
    expect(before.readings.map(r => r.grillTemp)).toEqual([200, 201, 202, 203]);

    const exact = page(await run('1', '4'));
    expect(exact).toMatchObject({ total: 5, offset: 1, limit: 4, hasMore: false });
    expect(exact.readings.map(r => r.grillTemp)).toEqual([201, 202, 203, 204]);

    const past = page(await run('5', '4'));
    expect(past).toMatchObject({ readings: [], total: 5, hasMore: false });
  });

  it('never returns a document whose SystemProperties device id differs from the partition, and ignores Body.deviceId', async () => {
    const { devices, temperatures, deps } = setup();
    devices.seed(device());
    temperatures.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime: '2026-08-14T16:00:00.000Z',
        systemDeviceId: 'intruder',
        body: { deviceId: DEVICE, timestamp: '2026-08-14T16:00:00.000Z', grillTemp: 999 },
      })
    );
    temperatures.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime: '2026-08-14T16:00:01.000Z',
        body: { deviceId: 'spoofed-device', timestamp: '2026-08-14T16:00:01.000Z', grillTemp: 250 },
      })
    );

    const response = await getTemperatureHistoryHandler(
      request({ deviceId: DEVICE }),
      context().ctx,
      deps
    );

    expect(page(response)).toEqual({
      readings: [{ deviceId: DEVICE, timestamp: '2026-08-14T16:00:01.000Z', grillTemp: 250 }],
      total: 1,
      offset: 0,
      limit: 100,
      hasMore: false,
    });
    const text = JSON.stringify(response.jsonBody);
    expect(text).not.toContain('intruder');
    expect(text).not.toContain('spoofed-device');
    expect(text).not.toContain('999');
  });

  it('no _-prefixed key in any reading', async () => {
    const { deps } = ownedWithReadings(3);

    const response = await getTemperatureHistoryHandler(
      request({ deviceId: DEVICE }),
      context().ctx,
      deps
    );

    expect(page(response).readings).toHaveLength(3);
    expect(keysDeep(response.jsonBody).filter(key => key.startsWith('_'))).toEqual([]);
    for (const key of ['SystemProperties', 'Properties', 'iothub_name', 'Body', 'id']) {
      expect(keysDeep(response.jsonBody)).not.toContain(key);
    }
  });

  it('401 without a principal, before any read', async () => {
    const { deps, getDevicesRepository, getTemperaturesRepository, devices, temperatures } =
      setup();

    const response = await getTemperatureHistoryHandler(
      request({ deviceId: DEVICE }, null),
      context().ctx,
      deps
    );

    expect(response.status).toBe(401);
    expect(response.jsonBody).toMatchObject({
      error: 'UNAUTHENTICATED',
      reason: 'principal_header_missing',
    });
    expect(getDevicesRepository).not.toHaveBeenCalled();
    expect(getTemperaturesRepository).not.toHaveBeenCalled();
    expect(devices.calls).toEqual([]);
    expect(temperatures.queries).toEqual([]);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
  });

  it('401 for an unparseable principal, even with an invalid query', async () => {
    const { deps, getDevicesRepository } = setup();

    const response = await getTemperatureHistoryHandler(
      request({ limit: 'x' }, '%%%'),
      context().ctx,
      deps
    );

    expect(response.status).toBe(401);
    expect(getDevicesRepository).not.toHaveBeenCalled();
  });

  const CASES: Array<[string, Record<string, string>]> = [
    ['deviceId missing', {}],
    ['deviceId empty', { deviceId: '' }],
    ['deviceId with a space', { deviceId: 'has space' }],
    ['deviceId with a slash', { deviceId: 'a/b' }],
    ['deviceId of 129 characters', { deviceId: 'x'.repeat(129) }],
    ['cookId empty', { deviceId: DEVICE, cookId: '' }],
    ['cookId of 129 characters', { deviceId: DEVICE, cookId: 'c'.repeat(129) }],
    ['startTime not a date', { deviceId: DEVICE, startTime: 'yesterday' }],
    ['startTime empty', { deviceId: DEVICE, startTime: '' }],
    ['endTime not a date', { deviceId: DEVICE, endTime: '2026-13-45T99:00:00Z' }],
    [
      'startTime equal to endTime',
      { deviceId: DEVICE, startTime: '2026-08-14T16:00:00Z', endTime: '2026-08-14T16:00:00.000Z' },
    ],
    [
      'startTime after endTime',
      { deviceId: DEVICE, startTime: '2026-08-14T17:00:00Z', endTime: '2026-08-14T16:00:00Z' },
    ],
    ['limit not an integer', { deviceId: DEVICE, limit: '10.5' }],
    ['limit not a number', { deviceId: DEVICE, limit: 'ten' }],
    ['limit empty', { deviceId: DEVICE, limit: '' }],
    ['limit of 0', { deviceId: DEVICE, limit: '0' }],
    ['limit of 5001', { deviceId: DEVICE, limit: '5001' }],
    ['offset not an integer', { deviceId: DEVICE, offset: '1e3' }],
    ['offset negative', { deviceId: DEVICE, offset: '-1' }],
  ];

  it.each(CASES)('400 VALIDATION_ERROR for %s, with no Cosmos call', async (_name, query) => {
    const { deps, devices, temperatures, getDevicesRepository } = setup();

    const response = await getTemperatureHistoryHandler(request(query), context().ctx, deps);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ error: 'VALIDATION_ERROR', requestId: 'inv-9' });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
    expect(getDevicesRepository).not.toHaveBeenCalled();
    expect(devices.calls).toEqual([]);
    expect(temperatures.queries).toEqual([]);
  });

  it('accepts the bounds of limit (1 and 5000) and offset (0)', async () => {
    for (const [limit, offset] of [
      ['1', '0'],
      ['5000', '0'],
    ]) {
      const { deps } = ownedWithReadings(2);
      const response = await getTemperatureHistoryHandler(
        request({ deviceId: DEVICE, limit, offset }),
        context().ctx,
        deps
      );
      expect(response.status).toBe(200);
      expect(page(response).limit).toBe(Number(limit));
    }
  });

  it('404 DEVICE_NOT_FOUND for foreign and unknown devices, byte-identical, without reading temperatures', async () => {
    const foreign = setup();
    foreign.devices.seed(device({ userId: OTHER_USER_ID }));
    foreign.temperatures.seed(
      routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:00.000Z' })
    );
    const unknown = setup();

    const foreignResponse = await getTemperatureHistoryHandler(
      request({ deviceId: DEVICE }),
      context().ctx,
      foreign.deps
    );
    const unknownResponse = await getTemperatureHistoryHandler(
      request({ deviceId: DEVICE }),
      context().ctx,
      unknown.deps
    );

    for (const [response, fixture] of [
      [foreignResponse, foreign],
      [unknownResponse, unknown],
    ] as const) {
      expect(response.status).toBe(404);
      expect(response.jsonBody).toEqual({
        error: 'DEVICE_NOT_FOUND',
        message: 'Device not found',
        requestId: 'inv-9',
      });
      expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
      expect(fixture.temperatures.queries).toEqual([]);
    }
    expect(JSON.stringify(unknownResponse.jsonBody)).toBe(JSON.stringify(foreignResponse.jsonBody));
  });

  it('500 when the ownership read fails, charging the ownership read', async () => {
    const { devices, temperatures, deps } = setup();
    devices.seed(device());
    devices.failNext('read', 503);
    const { ctx, errors } = context();

    const response = await getTemperatureHistoryHandler(request({ deviceId: DEVICE }), ctx, deps);

    expect(response.status).toBe(500);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(errors.join('\n')).toContain('cosmos_status_503');
    expect(temperatures.queries).toEqual([]);
  });

  it('500 when the count query fails, charging the ownership read plus the failed count', async () => {
    const { deps, temperatures } = ownedWithReadings(1);
    temperatures.failNext(503);
    const { ctx, errors } = context();

    const response = await getTemperatureHistoryHandler(request({ deviceId: DEVICE }), ctx, deps);

    expect(response.status).toBe(500);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(READ_CHARGE + TEMPERATURES_QUERY_CHARGE)
    );
    expect(temperatures.queries).toHaveLength(1);
    expect(errors.join('\n')).toContain('cosmos_status_503');
  });

  it('500 when the page query fails, charging all three calls, leaking no endpoint, database name, or claim', async () => {
    const { deps, temperatures } = ownedWithReadings(1);
    temperatures.failNext(503, 1);
    const { ctx, errors, logs } = context();

    const response = await getTemperatureHistoryHandler(request({ deviceId: DEVICE }), ctx, deps);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to retrieve temperature history',
      requestId: 'inv-9',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(ALL_CHARGES);
    expect(temperatures.queries).toHaveLength(2);
    const everything = [JSON.stringify(response), ...errors, ...logs].join('\n');
    for (const secret of [FAKE_ACCOUNT_ENDPOINT, 'documents.azure.com', OID, TID, 'meatgeek-v2']) {
      expect(everything).not.toContain(secret);
    }
    expect(errors.join('\n')).toContain('cosmos_status_503');
  });
});
