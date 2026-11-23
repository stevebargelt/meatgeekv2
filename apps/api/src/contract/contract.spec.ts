/**
 * HAR-72 — the OpenAPI drift check. `nx test api` runs it on every pull request.
 *
 * libs/api-specs/spec/openapi.yaml is the contract the web and iOS clients
 * share. This suite fails when it stops being true of the API:
 *   (a) the (METHOD, route) pairs main.ts registers with `app.http` differ from
 *       the spec's (METHOD, path) pairs;
 *   (b) an operation does not require the bearer scheme or declares no 401, or
 *       the 401 body's `reason` enum differs from what principal.ts returns;
 *   (c) the spec does not validate as OpenAPI 3.0;
 *   (d) a SignalR message built by the real producers does not match its
 *       `x-signalr` schema.
 * It also keeps ErrorCode honest: the spec's enum equals api-interfaces'
 * ERROR_CODES, and every code a handler writes is in it.
 */
import * as fs from 'fs';
import * as path from 'path';

import SwaggerParser from '@apidevtools/swagger-parser';
import Ajv, { type ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { InvocationContext } from '@azure/functions';
import { ERROR_CODES, type Cook } from '@meatgeekv2/api-interfaces';
import type { OpenAPIV3 } from 'openapi-types';

import { DEVICE_NOT_OWNED } from '../functions/cooks/device-ownership';
import { broadcastTemperatureHandler } from '../functions/signalr/broadcast-temperature';
import {
  buildCookEnvelope,
  COOK_STARTED,
  COOK_STOPPED,
  HUB_NAME,
  signalROutput,
  TEMPERATURE,
  type SignalRTemperatureMessage,
} from '../functions/signalr/envelope';
import { principalFromHeaderValue, unauthenticatedResponse } from '../shared/auth/principal';
import {
  compareRoutes,
  formatRouteDrift,
  normalisePath,
  operationsMissingAuth,
  registeredOperations,
  specOperations,
  type HttpRegistrationLike,
  type Operation,
} from './contract-drift.testing';

const SPEC_PATH = path.resolve(__dirname, '../../../../libs/api-specs/spec/openapi.yaml');
const API_SOURCE = path.resolve(__dirname, '..');

const mockHttpRegistrations = new Map<string, HttpRegistrationLike>();

jest.mock('@azure/functions', () => {
  const actual = jest.requireActual('@azure/functions');
  return {
    ...actual,
    app: {
      http: (name: string, options: HttpRegistrationLike) => {
        mockHttpRegistrations.set(name, options);
      },
      // Not HTTP routes: the drift check is about app.http only.
      eventHub: () => undefined,
      // HAR-86: the rollupTemperatures change-feed trigger; asserted in
      // rollup-temperatures.integration.spec.ts.
      cosmosDB: () => undefined,
      timer: () => undefined,
    },
  };
});

interface SignalRExtension {
  hub: string;
  negotiate: string;
  messages: Record<string, OpenAPIV3.SchemaObject>;
}

let validated: OpenAPIV3.Document;
let dereferenced: OpenAPIV3.Document;

beforeAll(async () => {
  // Importing main.ts is the Functions v4 registration path. It reads no
  // configuration and builds no client at import (MG-59 FIX 1).
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../main');
  validated = (await SwaggerParser.validate(SPEC_PATH)) as OpenAPIV3.Document;
  dereferenced = (await SwaggerParser.dereference(SPEC_PATH)) as OpenAPIV3.Document;
});

function schemaAt(name: string): OpenAPIV3.SchemaObject {
  const schema = dereferenced.components?.schemas?.[name];
  if (!schema) throw new Error(`components.schemas.${name} is missing`);
  return schema as OpenAPIV3.SchemaObject;
}

function signalR(): SignalRExtension {
  return (dereferenced as unknown as { 'x-signalr': SignalRExtension })['x-signalr'];
}

/** Ajv for OpenAPI 3.0 schemas: `example` and other OpenAPI keywords are
 *  ignored, OpenAPI's numeric formats are accepted, and the string formats the
 *  spec uses are checked. */
function compile(schema: OpenAPIV3.SchemaObject): ValidateFunction {
  const ajv = new Ajv({ strict: false, allErrors: true, logger: false });
  addFormats(ajv);
  for (const format of ['double', 'float', 'int32', 'int64']) {
    ajv.addFormat(format, true);
  }
  return ajv.compile(schema);
}

function expectValid(validate: ValidateFunction, value: unknown): void {
  const valid = validate(value);
  expect({ valid, errors: validate.errors ?? null }).toEqual({ valid: true, errors: null });
}

describe('(a) routes: main.ts registrations equal the spec operations', () => {
  it('main.ts registers HTTP routes (the capture works)', () => {
    expect(mockHttpRegistrations.size).toBeGreaterThan(0);
  });

  it('every (METHOD, route) in main.ts is in the spec, and every spec operation is in main.ts', () => {
    const drift = compareRoutes(
      registeredOperations(mockHttpRegistrations),
      specOperations(validated)
    );
    const message = formatRouteDrift(drift);
    if (message) throw new Error(message);
    expect(drift).toEqual({ missingFromSpec: [], missingFromApi: [] });
  });

  it('treats a parameter by position, not by name', () => {
    expect(normalisePath('cooks/{cookId}/stop')).toBe('/cooks/{}/stop');
    expect(normalisePath('/cooks/{id}/stop')).toBe('/cooks/{}/stop');
    expect(normalisePath('items/{id:int}/{slug?}')).toBe('/items/{}/{}');
    const api: Operation[] = [{ method: 'POST', path: '/cooks/{cookId}/stop', source: 'stopCook' }];
    const spec: Operation[] = [{ method: 'POST', path: '/cooks/{id}/stop', source: 'stopCook' }];
    expect(compareRoutes(api, spec)).toEqual({ missingFromSpec: [], missingFromApi: [] });
  });

  it('fails, naming the route, when main.ts gains a route the spec lacks', () => {
    const registrations = new Map(mockHttpRegistrations);
    registrations.set('throwawayRoute', { methods: ['GET'], route: 'throwaway/{thing}' });

    const drift = compareRoutes(registeredOperations(registrations), specOperations(validated));

    expect(drift.missingFromApi).toEqual([]);
    expect(drift.missingFromSpec).toEqual([
      { method: 'GET', path: '/throwaway/{thing}', source: 'throwawayRoute' },
    ]);
    expect(formatRouteDrift(drift)).toContain(
      'Routes main.ts registers that the spec does not describe:\n  - GET /throwaway/{thing} (throwawayRoute)'
    );
  });

  it('fails when main.ts adds a method to an existing route', () => {
    const registrations = new Map(mockHttpRegistrations);
    registrations.set('deleteCooks', { methods: ['DELETE'], route: 'cooks' });

    const drift = compareRoutes(registeredOperations(registrations), specOperations(validated));

    expect(formatRouteDrift(drift)).toContain('  - DELETE /cooks (deleteCooks)');
  });

  it('fails when a registration has no methods (Azure Functions would accept every method)', () => {
    const registrations = new Map(mockHttpRegistrations);
    registrations.set('anyMethod', { route: 'cooks' });

    const drift = compareRoutes(registeredOperations(registrations), specOperations(validated));

    expect(drift.missingFromSpec).toEqual([{ method: 'ANY', path: '/cooks', source: 'anyMethod' }]);
  });

  it('fails, naming the operation, when the spec loses an operation main.ts serves', () => {
    const altered = structuredClone(validated);
    delete altered.paths['/cooks/{cookId}/stop'];
    delete altered.paths['/devices/{id}']?.patch;

    const drift = compareRoutes(
      registeredOperations(mockHttpRegistrations),
      specOperations(altered)
    );

    expect(drift.missingFromApi).toEqual([]);
    expect(drift.missingFromSpec).toEqual([
      { method: 'POST', path: '/cooks/{cookId}/stop', source: 'stopCook' },
      { method: 'PATCH', path: '/devices/{id}', source: 'updateDevice' },
    ]);
    const message = formatRouteDrift(drift);
    expect(message).toContain('  - POST /cooks/{cookId}/stop (stopCook)');
    expect(message).toContain('  - PATCH /devices/{id} (updateDevice)');
  });

  it('fails, naming the operation, when the spec describes a route main.ts does not serve', () => {
    const altered = structuredClone(validated);
    // PATCH /cooks/{id} is not served (HAR-75 added only GET /cooks/{cookId}).
    altered.paths['/cooks/{id}'] = {
      patch: { operationId: 'updateCook', responses: { '200': { description: 'ok' } } },
    };

    const drift = compareRoutes(
      registeredOperations(mockHttpRegistrations),
      specOperations(altered)
    );

    expect(drift.missingFromSpec).toEqual([]);
    expect(drift.missingFromApi).toEqual([
      { method: 'PATCH', path: '/cooks/{id}', source: 'updateCook' },
    ]);
    expect(formatRouteDrift(drift)).toContain(
      'Operations the spec describes that main.ts does not register:\n  - PATCH /cooks/{id} (updateCook)'
    );
  });
});

describe('(b) auth: every operation requires the bearer token and declares a 401', () => {
  it('has no operation without bearer security or a 401', () => {
    expect(operationsMissingAuth(validated)).toEqual([]);
  });

  it('fails for an operation that opts out of security or drops its 401', () => {
    const altered = structuredClone(validated);
    const listCooks = altered.paths['/cooks']?.get as OpenAPIV3.OperationObject;
    listCooks.security = [];
    const getDevices = altered.paths['/devices']?.get as OpenAPIV3.OperationObject;
    delete getDevices.responses['401'];
    const getRecipe = altered.paths['/recipes/{id}']?.get as OpenAPIV3.OperationObject;
    getRecipe.security = [{ bearerAuth: [] }, {}];

    expect(operationsMissingAuth(altered)).toEqual([
      'GET /cooks: does not require bearerAuth',
      'GET /devices: declares no 401 response',
      'GET /recipes/{id}: does not require bearerAuth',
    ]);
  });

  it('declares the bearer scheme as an http bearer token', () => {
    const scheme = validated.components?.securitySchemes?.[
      'bearerAuth'
    ] as OpenAPIV3.HttpSecurityScheme;
    expect({ type: scheme.type, scheme: scheme.scheme }).toEqual({
      type: 'http',
      scheme: 'bearer',
    });
  });

  it("lists exactly principal.ts's failure reasons, and the 401 body principal.ts builds matches", () => {
    const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64');
    const reasons = new Set<string>();
    for (const header of [
      undefined,
      'not base64 json',
      encode({ claims: [] }),
      encode({ claims: [{ typ: 'oid', val: 'object-id' }] }),
    ]) {
      const result = principalFromHeaderValue(header);
      if (result.authenticated) throw new Error('expected an unauthenticated result');
      reasons.add(result.reason);
    }

    const schema = schemaAt('UnauthenticatedError');
    const reasonEnum = (schema.properties?.['reason'] as OpenAPIV3.SchemaObject).enum;
    expect([...reasons].sort()).toEqual([...(reasonEnum ?? [])].sort());

    const validate = compile(schema);
    for (const reason of reasons) {
      const response = unauthenticatedResponse(
        reason as Parameters<typeof unauthenticatedResponse>[0],
        'invocation-1'
      );
      expect(response.status).toBe(401);
      expectValid(validate, response.jsonBody);
    }
  });
});

describe('(c) the spec validates', () => {
  it('is a valid OpenAPI 3.0 document (swagger-parser)', () => {
    expect(validated.openapi).toMatch(/^3\.0\./);
  });

  it('has a server whose base path is /api, where the Functions host serves every route', () => {
    for (const server of validated.servers ?? []) {
      expect(new URL(server.url).pathname).toBe('/api');
    }
    expect(validated.servers?.length).toBeGreaterThan(0);
  });
});

describe('HAR-143: a device carries its live connection, never connectionStatus', () => {
  const DEVICE = {
    id: 'grill-1',
    userId: 'tid:oid',
    name: 'Backyard',
    model: 'MeatGeek',
    isActive: true,
  };

  it('a Device with connection validates, with lastActivityAt set or null', () => {
    const validate = compile(schemaAt('Device'));
    expectValid(validate, {
      ...DEVICE,
      connection: { state: 'connected', lastActivityAt: '2026-11-20T12:00:00.000Z' },
    });
    expectValid(validate, { ...DEVICE, connection: { state: 'unknown', lastActivityAt: null } });
    expect(schemaAt('DeviceConnectionState').enum).toEqual([
      'connected',
      'disconnected',
      'unknown',
    ]);
  });

  it('refuses connectionStatus, a connection without lastActivityAt, and an unknown state', () => {
    const validate = compile(schemaAt('Device'));
    expect(validate({ ...DEVICE, connectionStatus: 'unknown' })).toBe(false);
    expect(validate({ ...DEVICE, connection: { state: 'connected' } })).toBe(false);
    expect(validate({ ...DEVICE, connection: { state: 'online', lastActivityAt: null } })).toBe(
      false
    );
  });
});

describe('ErrorCode lists every code the API emits', () => {
  it("equals api-interfaces' ERROR_CODES", () => {
    const codes = schemaAt('ErrorCode').enum ?? [];
    expect([...codes].sort()).toEqual([...ERROR_CODES].sort());
  });

  it('includes every error code a handler writes', () => {
    const emitted = new Set<string>([DEVICE_NOT_OWNED]);
    const patterns = [/\berror:\s*'([A-Z][A-Z_]+)'/g, /\berrorBody\(\s*'([A-Z][A-Z_]+)'/g];
    const visit = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const full = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          if (entry.name !== 'contract') visit(full);
        } else if (/\.ts$/.test(entry.name) && !/\.(spec|testing)\.ts$/.test(entry.name)) {
          const source = fs.readFileSync(full, 'utf8');
          for (const pattern of patterns) {
            for (const match of source.matchAll(pattern)) emitted.add(match[1]);
          }
        }
      }
    };
    visit(API_SOURCE);

    // Guard against a scan that silently finds nothing.
    expect(emitted.size).toBeGreaterThanOrEqual(10);
    const codes = new Set(schemaAt('ErrorCode').enum ?? []);
    expect([...emitted].filter(code => !codes.has(code))).toEqual([]);
  });
});

describe('(d) SignalR: the messages the API builds match their x-signalr schemas', () => {
  const ownerId = 'tenant-id:object-id';

  function cook(overrides: Partial<Cook> = {}): Cook {
    return {
      id: '6f1c2b8e-3d4a-4f6b-9c7d-0e1f2a3b4c5d',
      userId: ownerId,
      deviceId: 'meatgeek3',
      name: 'Brisket',
      status: 'active',
      startTime: '2026-11-20T12:00:00.000Z',
      meatType: 'brisket',
      weight: 12.5,
      targetTemps: { grill: 225, probe1: 203 },
      notes: 'post oak',
      ...overrides,
    };
  }

  /** HAR-81: the push is addressed to the device's owner; no Cosmos here. */
  const ownerDeps = { ownerOf: async () => 'tid-1:oid-owner' };

  function broadcastContext(): {
    context: InvocationContext;
    sent: () => SignalRTemperatureMessage[];
  } {
    const set = jest.fn();
    const context = {
      invocationId: 'invocation-1',
      triggerMetadata: {
        systemPropertiesArray: [
          {
            'iothub-connection-device-id': 'meatgeek3',
            'iothub-enqueuedtime': '2026-11-20T18:04:05.500Z',
          },
        ],
        enqueuedTimeUtcArray: ['2026-11-20T18:04:05.600Z'],
      },
      extraOutputs: { set },
      log: jest.fn(),
    } as unknown as InvocationContext;
    return {
      context,
      sent: () => {
        expect(set).toHaveBeenCalledWith(signalROutput, expect.any(Array));
        return set.mock.calls[0][1] as SignalRTemperatureMessage[];
      },
    };
  }

  it('names the hub, the negotiate route and exactly the targets the API sends', () => {
    const extension = signalR();
    expect(extension.hub).toBe(HUB_NAME);
    expect(Object.keys(extension.messages).sort()).toEqual(
      [TEMPERATURE, COOK_STARTED, COOK_STOPPED].sort()
    );
    expect(validated.paths[extension.negotiate]?.post).toBeDefined();
    expect(
      registeredOperations(mockHttpRegistrations).some(
        operation =>
          operation.method === 'POST' &&
          normalisePath(operation.path) === normalisePath(extension.negotiate)
      )
    ).toBe(true);
  });

  it('temperature: what broadcastTemperature sends matches the schema', async () => {
    const { context, sent } = broadcastContext();
    await broadcastTemperatureHandler(
      [
        {
          deviceId: 'spoofed-by-the-body',
          timestamp: '2026-11-20T18:04:05.123Z',
          cookId: '6f1c2b8e-3d4a-4f6b-9c7d-0e1f2a3b4c5d',
          grillTemp: 225.5,
          probe1Temp: 160.25,
          probe2Temp: 98,
          probe3Temp: 'not a number',
        },
      ],
      context,
      ownerDeps
    );

    const messages = sent();
    expect(messages).toHaveLength(1);
    expect(messages[0].target).toBe(TEMPERATURE);
    expect(messages[0].userId).toBe('tid-1:oid-owner');
    const [reading] = messages[0].arguments;
    expect(reading.deviceId).toBe('meatgeek3');
    expectValid(compile(signalR().messages[TEMPERATURE]), reading);
  });

  it('temperature: a minimal reading (no cook, no temperatures) matches the schema', async () => {
    const { context, sent } = broadcastContext();
    await broadcastTemperatureHandler([{}], context, ownerDeps);

    const [reading] = sent()[0].arguments;
    expectValid(compile(signalR().messages[TEMPERATURE]), reading);
  });

  it('temperature: the schema has exactly the TemperatureReading fields plus enqueuedTimeUtc', () => {
    const reading = Object.keys(schemaAt('TemperatureReading').properties ?? {});
    const message = Object.keys(signalR().messages[TEMPERATURE].properties ?? {});
    expect(message.sort()).toEqual([...reading, 'enqueuedTimeUtc'].sort());
  });

  it('cook_started: buildCookEnvelope matches the schema', () => {
    const envelope = buildCookEnvelope(COOK_STARTED, cook(), 'correlation-1');
    expect(envelope.cookId).toBe(envelope.payload.id);
    expectValid(compile(signalR().messages[COOK_STARTED]), envelope);
  });

  it('cook_stopped: buildCookEnvelope matches the schema', () => {
    const envelope = buildCookEnvelope(
      COOK_STOPPED,
      cook({ status: 'completed', endTime: '2026-11-20T20:00:00.000Z' }),
      'correlation-1'
    );
    expect('cookId' in envelope).toBe(false);
    expectValid(compile(signalR().messages[COOK_STOPPED]), envelope);
  });

  it('rejects a message that does not match (the validation is not vacuous)', () => {
    const started = buildCookEnvelope(COOK_STARTED, cook(), 'correlation-1');
    const stopped = buildCookEnvelope(COOK_STOPPED, cook({ status: 'completed' }), 'c');

    expect(compile(signalR().messages[COOK_STARTED])({ ...started, extra: true })).toBe(false);
    expect(compile(signalR().messages[COOK_STOPPED])({ ...stopped, cookId: 'x' })).toBe(false);
    expect(compile(signalR().messages[COOK_STARTED])(stopped)).toBe(false);
    expect(
      compile(signalR().messages[TEMPERATURE])({ deviceId: 'meatgeek3', timestamp: 'x' })
    ).toBe(false);
  });
});
