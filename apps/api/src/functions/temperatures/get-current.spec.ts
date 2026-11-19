/**
 * HAR-28 (MG-79 part 1) — GET /temperatures/current/{deviceId}, with NO Azure
 * and NO credentials.
 *
 * The handler runs over the REAL DevicesRepository and TemperaturesRepository on
 * in-memory containers that stamp Cosmos system properties, and reads real
 * base64 X-MS-CLIENT-PRINCIPAL headers through the real principal.ts.
 */
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Device } from '@meatgeekv2/api-interfaces';

import { principalFromRequest } from '../../shared/auth/principal';
import { CosmosConfigError } from '../../shared/cosmos/cosmos-adapter';
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
import { getCurrentTemperaturesHandler, type TemperaturesHandlerDeps } from './get-current';

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

function request(deviceId: string, principal: string | null = encodedPrincipal(OID)): HttpRequest {
  const headers = new Map<string, string>();
  if (principal !== null) {
    headers.set('x-ms-client-principal', principal);
  }
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: { get: () => null },
    params: { deviceId },
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
  const deps: TemperaturesHandlerDeps = {
    resolvePrincipal: principalFromRequest,
    getDevicesRepository,
    getTemperaturesRepository,
  };
  return { devices, temperatures, deps, getDevicesRepository, getTemperaturesRepository };
}

function header(response: HttpResponseInit, name: string): string | undefined {
  return (response.headers as Record<string, string> | undefined)?.[name];
}

const BOTH_CHARGES = String(READ_CHARGE + TEMPERATURES_QUERY_CHARGE);

describe('GET /temperatures/current/{deviceId}', () => {
  it('200: the newest reading of an owned device, as a bare TemperatureReading', async () => {
    const { devices, temperatures, deps } = setup();
    devices.seed(device());
    temperatures.seed(
      routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:00.000Z' })
    );
    temperatures.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime: '2026-08-14T16:00:30.000Z',
        body: {
          deviceId: 'spoofed-device',
          timestamp: '2026-08-14T16:00:29.500Z',
          cookId: 'cook-7',
          grillTemp: 251.5,
          probe1Temp: 160,
        },
      })
    );
    const { ctx } = context();

    const response = await getCurrentTemperaturesHandler(request(DEVICE), ctx, deps);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({
      deviceId: DEVICE,
      timestamp: '2026-08-14T16:00:29.500Z',
      cookId: 'cook-7',
      grillTemp: 251.5,
      probe1Temp: 160,
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(BOTH_CHARGES);
    expect(header(response, 'X-Request-ID')).toBe('inv-9');
    expect(temperatures.queries).toHaveLength(1);
    expect(temperatures.queries[0].options['partitionKey']).toBe(DEVICE);
  });

  it('400 VALIDATION_ERROR for an id that cannot be a device id, before any Cosmos call', async () => {
    for (const bad of ['', 'has space', 'a/b', 'x'.repeat(129), 'q?x']) {
      const { deps, devices, temperatures } = setup();
      const { ctx } = context();

      const response = await getCurrentTemperaturesHandler(request(bad), ctx, deps);

      expect(response.status).toBe(400);
      expect(response.jsonBody).toMatchObject({ error: 'VALIDATION_ERROR', requestId: 'inv-9' });
      expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
      expect(devices.calls).toEqual([]);
      expect(temperatures.queries).toEqual([]);
    }
  });

  it('401 without a principal, and never reaches a repository', async () => {
    const { deps, getDevicesRepository, getTemperaturesRepository } = setup();
    const { ctx } = context();

    const response = await getCurrentTemperaturesHandler(request(DEVICE, null), ctx, deps);

    expect(response.status).toBe(401);
    expect(response.jsonBody).toMatchObject({
      error: 'UNAUTHENTICATED',
      reason: 'principal_header_missing',
    });
    expect(getDevicesRepository).not.toHaveBeenCalled();
    expect(getTemperaturesRepository).not.toHaveBeenCalled();
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
  });

  it('401 for an unparseable principal', async () => {
    const { deps, getDevicesRepository } = setup();
    const { ctx } = context();

    const response = await getCurrentTemperaturesHandler(request(DEVICE, '%%%'), ctx, deps);

    expect(response.status).toBe(401);
    expect(getDevicesRepository).not.toHaveBeenCalled();
  });

  it('404 DEVICE_NOT_FOUND for a device owned by someone else, without reading temperatures', async () => {
    const { devices, temperatures, deps } = setup();
    devices.seed(device({ userId: OTHER_USER_ID }));
    temperatures.seed(
      routedDocument({ deviceId: DEVICE, enqueuedTime: '2026-08-14T16:00:00.000Z' })
    );
    const { ctx } = context();

    const response = await getCurrentTemperaturesHandler(request(DEVICE), ctx, deps);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toEqual({
      error: 'DEVICE_NOT_FOUND',
      message: 'Device not found',
      requestId: 'inv-9',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(temperatures.queries).toEqual([]);
  });

  it('404 DEVICE_NOT_FOUND for an unknown device, with the same body as a foreign one', async () => {
    const foreign = setup();
    foreign.devices.seed(device({ userId: OTHER_USER_ID }));
    const unknown = setup();

    const foreignResponse = await getCurrentTemperaturesHandler(
      request(DEVICE),
      context().ctx,
      foreign.deps
    );
    const unknownResponse = await getCurrentTemperaturesHandler(
      request(DEVICE),
      context().ctx,
      unknown.deps
    );

    expect(unknownResponse.status).toBe(404);
    expect(unknownResponse.jsonBody).toEqual(foreignResponse.jsonBody);
    expect(header(unknownResponse, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(unknown.temperatures.queries).toEqual([]);
  });

  it('404 NO_READINGS for an owned device with no document that maps', async () => {
    const { devices, temperatures, deps } = setup();
    devices.seed(device());
    temperatures.seed(
      routedDocument({
        deviceId: DEVICE,
        enqueuedTime: '2026-08-14T16:00:00.000Z',
        systemDeviceId: 'intruder',
      })
    );
    const { ctx } = context();

    const response = await getCurrentTemperaturesHandler(request(DEVICE), ctx, deps);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toEqual({
      error: 'NO_READINGS',
      message: 'The device has no temperature readings',
      requestId: 'inv-9',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(BOTH_CHARGES);
  });

  it('500 sanitized when the temperatures container setting is missing (CosmosConfigError)', async () => {
    const { deps, devices } = setup();
    deps.getTemperaturesRepository = () => {
      throw new CosmosConfigError('COSMOSDB_TEMPERATURES_CONTAINER_NAME');
    };
    const { ctx, errors } = context();

    const response = await getCurrentTemperaturesHandler(request(DEVICE), ctx, deps);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to retrieve current temperatures',
      requestId: 'inv-9',
    });
    expect(JSON.stringify(response.jsonBody)).not.toContain('COSMOSDB');
    expect(errors.join('\n')).toContain('cosmos_temperatures_container_not_configured');
    // Configuration is resolved before any I/O.
    expect(devices.calls).toEqual([]);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
  });

  it('500 sanitized on a Cosmos failure, leaking no endpoint, database name, or claim', async () => {
    const { devices, temperatures, deps } = setup();
    devices.seed(device());
    temperatures.failNext(503);
    const { ctx, errors, logs } = context();

    const response = await getCurrentTemperaturesHandler(request(DEVICE), ctx, deps);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to retrieve current temperatures',
      requestId: 'inv-9',
    });
    // The ownership read plus the RU the failed query reported.
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(BOTH_CHARGES);
    const everything = [JSON.stringify(response), ...errors, ...logs].join('\n');
    for (const secret of [FAKE_ACCOUNT_ENDPOINT, 'documents.azure.com', OID, TID, 'meatgeek-v2']) {
      expect(everything).not.toContain(secret);
    }
    expect(errors.join('\n')).toContain('cosmos_status_503');
  });

  it('500 sanitized when the ownership read fails', async () => {
    const { devices, temperatures, deps } = setup();
    devices.seed(device());
    devices.failNext('read', 503);
    const { ctx, errors } = context();

    const response = await getCurrentTemperaturesHandler(request(DEVICE), ctx, deps);

    expect(response.status).toBe(500);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(errors.join('\n')).toContain('cosmos_status_503');
    expect(temperatures.queries).toEqual([]);
  });
});
