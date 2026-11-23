/**
 * HAR-130 — POST /devices/claim, with NO Azure and NO credentials.
 *
 * The handler runs over the REAL DevicesRepository on the in-memory devices
 * container, a fake IoT Hub (FakeTwinHub) standing in for the device twin, a
 * fixed clock, and a tracer that records every span attribute. Principals are
 * real base64 X-MS-CLIENT-PRINCIPAL headers read by the real principal.ts.
 */
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Device } from '@meatgeekv2/api-interfaces';
import type { Tracer } from '@opentelemetry/api';

import { principalFromRequest } from '../../shared/auth/principal';
import { DevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  FakeDevicesContainer,
  QUERY_CHARGE,
  READ_CHARGE,
  WRITE_CHARGE,
} from '../../shared/cosmos/fake-devices-container.testing';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import { claimantHash, claimCodeHash } from '../../shared/devices/claim-code';
import { DeviceTwinError } from '../../shared/iothub/device-twin';
import { FakeTwinHub } from '../../shared/iothub/fake-device-twin.testing';
import { CLAIM_REFUSED_MESSAGE, claimDeviceHandler, type ClaimDeviceDeps } from './claim-device';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const OTHER_OID = 'oid-zzzz-9999';
const USER_ID = `${TID}:${OID}`;
const OTHER_USER_ID = `${TID}:${OTHER_OID}`;

const DEVICE_ID = 'meatgeek3';
/** As the device shows it, and as the caller types it (lower case, spaces). */
const SHOWN_CODE = '7K3M-9QXR-2HTV';
const TYPED_CODE = '7k3m 9qxr-2htv';
const CODE = '7K3M9QXR2HTV';
const CODE_HASH = claimCodeHash(DEVICE_ID, CODE);
const MY_HASH = claimantHash(USER_ID);
const OTHER_HASH = claimantHash(OTHER_USER_ID);

const NOW = new Date('2026-11-22T12:00:00.000Z');
const LATER = '2026-11-22T12:10:00.000Z';

/** The fixed 403 body; requestId is the invocation id. */
const REFUSED_BODY = {
  error: 'CLAIM_REFUSED',
  message: CLAIM_REFUSED_MESSAGE,
  requestId: 'inv-7',
};

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
  body?: unknown;
  rawBody?: string;
}

function request(options: RequestOptions = {}): HttpRequest {
  const headers = new Map<string, string>();
  const principal = options.principal === undefined ? encodedPrincipal(OID) : options.principal;
  if (principal !== null) {
    headers.set('x-ms-client-principal', principal);
  }
  return {
    json: async () =>
      options.rawBody !== undefined ? JSON.parse(options.rawBody) : (options.body ?? claimBody()),
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: { get: () => null },
    params: {},
  } as unknown as HttpRequest;
}

function claimBody(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { deviceId: DEVICE_ID, claimCode: TYPED_CODE, name: 'Backyard Smoker', ...overrides };
}

/** Everything the handler writes to the invocation log, every level. */
function context() {
  const lines: string[] = [];
  const record =
    (level: string) =>
    (...args: unknown[]) =>
      lines.push(`${level}: ${args.map(String).join(' ')}`);
  const ctx = {
    invocationId: 'inv-7',
    log: record('log'),
    info: record('info'),
    warn: record('warn'),
    error: record('error'),
    debug: record('debug'),
    trace: record('trace'),
  } as unknown as InvocationContext;
  return { ctx, lines };
}

/** A tracer whose spans record every attribute, event, status and exception. */
function recordingTracer() {
  const spans: Array<{ name: string; ended: boolean; recorded: unknown[] }> = [];
  const tracer = {
    startSpan: (name: string, options?: unknown) => {
      const span = { name, ended: false, recorded: [options] as unknown[] };
      spans.push(span);
      const handle = {
        setAttribute: (key: string, value: unknown) => (
          span.recorded.push({ [key]: value }),
          handle
        ),
        setAttributes: (attributes: unknown) => (span.recorded.push(attributes), handle),
        addEvent: (...args: unknown[]) => (span.recorded.push(args), handle),
        addLink: (...args: unknown[]) => (span.recorded.push(args), handle),
        addLinks: (...args: unknown[]) => (span.recorded.push(args), handle),
        setStatus: (status: unknown) => (span.recorded.push(status), handle),
        updateName: (next: string) => (span.recorded.push(next), handle),
        recordException: (exception: unknown) => {
          span.recorded.push(String(exception), JSON.stringify(exception));
        },
        end: () => {
          span.ended = true;
        },
        isRecording: () => true,
        spanContext: () => ({ traceId: '0'.repeat(32), spanId: '0'.repeat(16), traceFlags: 1 }),
      };
      return handle;
    },
    startActiveSpan: () => {
      throw new Error('the handler is expected to use startSpan');
    },
  } as unknown as Tracer;
  const attributes = () =>
    Object.assign(
      {},
      ...spans.flatMap(span =>
        span.recorded.filter(
          (entry): entry is Record<string, unknown> =>
            entry !== null && typeof entry === 'object' && !Array.isArray(entry)
        )
      )
    ) as Record<string, unknown>;
  return { tracer, spans, attributes };
}

/** A twin with a valid, unconsumed code for DEVICE_ID. */
function validReported(overrides: Record<string, string> = {}): Record<string, string> {
  return {
    claimCodeHash: CODE_HASH,
    claimExpiresAt: LATER,
    claimGeneration: '0',
    ...overrides,
  };
}

function setup(
  options: { desired?: Record<string, unknown>; reported?: Record<string, unknown> | null } = {}
) {
  const fake = new FakeDevicesContainer();
  const hub = new FakeTwinHub();
  if (options.reported !== null) {
    hub.addDevice(DEVICE_ID, options.desired ?? {}, options.reported ?? validReported());
  }
  const clock = { now: NOW };
  const telemetry = recordingTracer();
  const getRepository = jest.fn(() => new DevicesRepository(fake.asContainer()));
  const deps: ClaimDeviceDeps = {
    resolvePrincipal: principalFromRequest,
    getRepository,
    getDeviceTwin: () => hub,
    now: () => clock.now,
    tracer: telemetry.tracer,
  };
  return { fake, hub, clock, deps, getRepository, telemetry };
}

/** A device document as it would already be stored. */
function storedDevice(overrides: Partial<Device>): Device {
  return {
    id: DEVICE_ID,
    userId: USER_ID,
    name: 'Stored',
    model: 'MeatGeek',
    isActive: true,
    ...overrides,
  };
}

function header(response: HttpResponseInit, name: string): string | undefined {
  return (response.headers as Record<string, string> | undefined)?.[name];
}

describe('POST /devices/claim — success', () => {
  it('201: patches the twin with the consumed and claimant hashes under the read etag, BEFORE creating the document', async () => {
    const { fake, hub, deps, telemetry } = setup();
    const { ctx } = context();
    const createsAtPatch: number[] = [];
    hub.beforePatch = () => {
      createsAtPatch.push(fake.calls.filter(call => call.operation === 'create').length);
    };

    const response = await claimDeviceHandler(request(), ctx, deps);

    expect(response.status).toBe(201);
    expect(response.jsonBody).toEqual({
      id: DEVICE_ID,
      userId: USER_ID,
      name: 'Backyard Smoker',
      model: 'MeatGeek',
      isActive: true,
      claimedAt: NOW.toISOString(),
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(QUERY_CHARGE + WRITE_CHARGE));
    expect(header(response, 'X-Request-ID')).toBe('inv-7');

    expect(hub.patches).toEqual([
      {
        deviceId: DEVICE_ID,
        desired: { claimConsumedCodeHash: CODE_HASH, claimClaimantHash: MY_HASH },
        etag: 'etag-1',
      },
    ]);
    expect(createsAtPatch).toEqual([0]);
    expect(fake.calls.map(call => call.operation)).toEqual(['query', 'create']);
    expect(hub.desired(DEVICE_ID)).toMatchObject({
      claimConsumedCodeHash: CODE_HASH,
      claimClaimantHash: MY_HASH,
    });
    expect(fake.stored(DEVICE_ID)).toMatchObject({ userId: USER_ID, claimedAt: NOW.toISOString() });
    // HAR-143: connection state is read live from IoT Hub, never stored.
    expect(fake.stored(DEVICE_ID)).not.toHaveProperty('connectionStatus');
    expect(fake.stored(DEVICE_ID)).not.toHaveProperty('connection');

    expect(telemetry.spans).toHaveLength(1);
    expect(telemetry.spans[0].ended).toBe(true);
    expect(telemetry.attributes()).toMatchObject({
      'device.id': DEVICE_ID,
      'meatgeek.claim.outcome': 'created',
    });
  });

  it('accepts the code as shown, and keeps model, location and configuration (completed from the defaults)', async () => {
    const { deps } = setup();
    const { ctx } = context();

    const response = await claimDeviceHandler(
      request({
        body: claimBody({
          claimCode: SHOWN_CODE,
          model: ' MeatGeek V2 ',
          location: 'Deck',
          configuration: { temperatureUnit: 'celsius' },
        }),
      }),
      ctx,
      deps
    );

    expect(response.status).toBe(201);
    expect(response.jsonBody).toMatchObject({
      model: 'MeatGeek V2',
      location: 'Deck',
      configuration: {
        temperatureUnit: 'celsius',
        pollingInterval: 30,
        alertSettings: {
          highTempThreshold: 0,
          lowTempThreshold: 0,
          enableSounds: false,
          enablePushNotifications: false,
        },
      },
    });
  });

  it('accepts a matching generation other than 0', async () => {
    const { deps } = setup({
      desired: { claimGeneration: '3' },
      reported: validReported({ claimGeneration: '3' }),
    });
    const { ctx } = context();

    expect((await claimDeviceHandler(request(), ctx, deps)).status).toBe(201);
  });

  it('201 on a retry by the same caller after the twin patch succeeded but the create failed; no second patch', async () => {
    const { fake, hub, deps, clock } = setup();
    fake.failNext('create', 503);

    const first = await claimDeviceHandler(request(), context().ctx, deps);
    expect(first.status).toBe(500);
    expect(hub.patches).toHaveLength(1);
    expect(fake.stored(DEVICE_ID)).toBeUndefined();

    clock.now = new Date('2026-11-22T12:01:00.000Z');
    const retry = await claimDeviceHandler(request(), context().ctx, deps);

    expect(retry.status).toBe(201);
    expect(retry.jsonBody).toMatchObject({
      userId: USER_ID,
      claimedAt: '2026-11-22T12:01:00.000Z',
    });
    expect(hub.patches).toHaveLength(1);
  });

  it('200 with the stored device on a retry after both the patch and the create succeeded', async () => {
    const { fake, hub, deps, clock } = setup();
    const first = await claimDeviceHandler(request(), context().ctx, deps);
    expect(first.status).toBe(201);

    clock.now = new Date('2026-11-22T12:05:00.000Z');
    const retry = await claimDeviceHandler(
      request({ body: claimBody({ name: 'Renamed on retry' }) }),
      context().ctx,
      deps
    );

    expect(retry.status).toBe(200);
    expect(retry.jsonBody).toEqual(first.jsonBody);
    expect(header(retry, REQUEST_CHARGE_HEADER)).toBe(String(QUERY_CHARGE));
    expect(hub.patches).toHaveLength(1);
    expect(fake.calls.filter(call => call.operation === 'create')).toHaveLength(1);
  });

  it('a 412 whose re-read shows an unrelated write patches again and succeeds', async () => {
    const { hub, deps } = setup();
    hub.beforePatch = () => hub.forceWrite(DEVICE_ID, { activeCookId: 'cook-1' });

    const response = await claimDeviceHandler(request(), context().ctx, deps);

    expect(response.status).toBe(201);
    expect(hub.gets).toEqual([DEVICE_ID, DEVICE_ID]);
    expect(hub.patches.map(patch => patch.etag)).toEqual(['etag-1', 'etag-2']);
    expect(hub.desired(DEVICE_ID)).toMatchObject({
      activeCookId: 'cook-1',
      claimClaimantHash: MY_HASH,
    });
  });
});

describe('POST /devices/claim — 403 CLAIM_REFUSED', () => {
  type Case = {
    name: string;
    arrange: (fixture: ReturnType<typeof setup>) => void;
    options?: Parameters<typeof setup>[0];
    body?: Record<string, unknown>;
    reachesCosmos?: boolean;
  };
  const cases: Case[] = [
    {
      name: 'wrong code',
      arrange: () => undefined,
      body: claimBody({ claimCode: 'ZZZZ-ZZZZ-ZZZZ' }),
    },
    {
      name: 'twin 404 (no such device in IoT Hub)',
      arrange: () => undefined,
      options: { reported: null },
    },
    { name: 'no reported hash', arrange: () => undefined, options: { reported: {} } },
    {
      name: 'expired',
      arrange: () => undefined,
      options: { reported: validReported({ claimExpiresAt: '2026-11-22T11:59:59.999Z' }) },
    },
    {
      name: 'expiring exactly now',
      arrange: () => undefined,
      options: { reported: validReported({ claimExpiresAt: NOW.toISOString() }) },
    },
    {
      name: 'unreadable expiry',
      arrange: () => undefined,
      options: { reported: validReported({ claimExpiresAt: 'soon' }) },
    },
    {
      name: 'generation mismatch (desired bumped by a release)',
      arrange: () => undefined,
      options: { desired: { claimGeneration: '1' }, reported: validReported() },
    },
    {
      name: 'generation mismatch (no reported generation)',
      arrange: () => undefined,
      options: { reported: { claimCodeHash: CODE_HASH, claimExpiresAt: LATER } },
    },
    {
      name: 'consumed with another claimant',
      arrange: () => undefined,
      options: { desired: { claimConsumedCodeHash: CODE_HASH, claimClaimantHash: OTHER_HASH } },
    },
    {
      name: 'consumed with no claimant recorded',
      arrange: () => undefined,
      options: { desired: { claimConsumedCodeHash: CODE_HASH } },
    },
    {
      name: 'device document owned by another user',
      arrange: ({ fake }) => fake.seed(storedDevice({ userId: OTHER_USER_ID, name: 'Theirs' })),
      reachesCosmos: true,
    },
  ];

  it.each(cases)('$name → the one fixed 403 body, no request-charge header', async testCase => {
    const fixture = setup(testCase.options);
    testCase.arrange(fixture);
    const { ctx } = context();

    const response = await claimDeviceHandler(request({ body: testCase.body }), ctx, fixture.deps);

    expect(response.status).toBe(403);
    expect(response.jsonBody).toEqual(REFUSED_BODY);
    expect(response.headers).toEqual({
      'Content-Type': 'application/json',
      'X-Request-ID': 'inv-7',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
    expect(fixture.getRepository).toHaveBeenCalledTimes(testCase.reachesCosmos ? 1 : 0);
    expect(fixture.fake.stored(DEVICE_ID)?.['userId']).toBe(
      testCase.reachesCosmos ? OTHER_USER_ID : undefined
    );
  });

  it('a wrong code does not touch the twin’s desired properties', async () => {
    const { hub, deps } = setup();

    await claimDeviceHandler(
      request({ body: claimBody({ claimCode: 'ZZZZ-ZZZZ-ZZZZ' }) }),
      context().ctx,
      deps
    );

    expect(hub.patches).toEqual([]);
  });

  it('the same code for another device id does not match', async () => {
    const { hub, deps } = setup();
    hub.addDevice('meatgeek4', {}, validReported());

    const response = await claimDeviceHandler(
      request({ body: claimBody({ deviceId: 'meatgeek4' }) }),
      context().ctx,
      deps
    );

    expect(response.status).toBe(403);
  });

  it('a 412 on the patch whose re-read shows another claimant → 403, nothing stored', async () => {
    const { fake, hub, deps } = setup();
    hub.beforePatch = () =>
      hub.forceWrite(DEVICE_ID, {
        claimConsumedCodeHash: CODE_HASH,
        claimClaimantHash: OTHER_HASH,
      });

    const response = await claimDeviceHandler(request(), context().ctx, deps);

    expect(response.status).toBe(403);
    expect(response.jsonBody).toEqual(REFUSED_BODY);
    expect(hub.gets).toEqual([DEVICE_ID, DEVICE_ID]);
    expect(hub.patches).toHaveLength(1);
    expect(hub.desired(DEVICE_ID)).toMatchObject({ claimClaimantHash: OTHER_HASH });
    expect(fake.calls).toEqual([]);
  });

  it('a second claimant with the right code is refused once the first has claimed', async () => {
    const { deps } = setup();
    expect((await claimDeviceHandler(request(), context().ctx, deps)).status).toBe(201);

    const second = await claimDeviceHandler(
      request({ principal: encodedPrincipal(OTHER_OID) }),
      context().ctx,
      deps
    );

    expect(second.status).toBe(403);
    expect(second.jsonBody).toEqual(REFUSED_BODY);
  });
});

describe('POST /devices/claim — 409, 503, 500', () => {
  it('409 DEVICE_CONFLICT when the caller already has another device with that name', async () => {
    const { fake, deps } = setup();
    fake.seed(storedDevice({ id: 'grill-1', name: 'Backyard Smoker' }));

    const response = await claimDeviceHandler(request(), context().ctx, deps);

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ error: 'DEVICE_CONFLICT' });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(QUERY_CHARGE));
    expect(fake.stored(DEVICE_ID)).toBeUndefined();
  });

  it.each([
    [
      'the twin read answers 503',
      (hub: FakeTwinHub) => hub.failNext('get_twin', 503),
      'iothub_get_twin_status_503',
    ],
    [
      'the twin read fails on the network',
      (hub: FakeTwinHub) => hub.failNext('get_twin'),
      'iothub_get_twin_failed',
    ],
    [
      'the twin patch answers 500',
      (hub: FakeTwinHub) => hub.failNext('patch_twin', 500),
      'iothub_patch_twin_status_500',
    ],
    [
      'the patch loses the etag race twice',
      (hub: FakeTwinHub) => {
        hub.beforePatch = () => {
          hub.forceWrite(DEVICE_ID, { activeCookId: 'cook-1' });
          hub.beforePatch = () => hub.forceWrite(DEVICE_ID, { activeCookId: 'cook-2' });
        };
      },
      'iothub_patch_twin_status_412',
    ],
  ])('503 DEVICE_TWIN_UPDATE_FAILED when %s; no Cosmos call', async (_name, arrange, reason) => {
    const { hub, deps, getRepository } = setup();
    arrange(hub);
    const { ctx, lines } = context();

    const response = await claimDeviceHandler(request(), ctx, deps);

    expect(response.status).toBe(503);
    expect(response.jsonBody).toEqual({
      error: 'DEVICE_TWIN_UPDATE_FAILED',
      message: 'The device twin could not be read or updated. Retry the same request.',
      reason,
      requestId: 'inv-7',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
    expect(getRepository).not.toHaveBeenCalled();
    expect(lines).toContain(`error: claimDevice device twin failed: ${reason}`);
  });

  it('503 when the IoT Hub hostname is not configured', async () => {
    const { deps } = setup();
    deps.getDeviceTwin = () => {
      throw new DeviceTwinError('configuration');
    };

    const response = await claimDeviceHandler(request(), context().ctx, deps);

    expect(response.status).toBe(503);
    expect(response.jsonBody).toMatchObject({ reason: 'iothub_configuration_failed' });
  });

  it('a sanitized 500 with the RU spent when the create fails', async () => {
    const { fake, deps } = setup();
    fake.failNext('create', 503);
    const { ctx, lines } = context();

    const response = await claimDeviceHandler(request(), ctx, deps);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(QUERY_CHARGE + WRITE_CHARGE));
    expect(lines).toContain('error: claimDevice failed: cosmos_status_503');
    expect(JSON.stringify(response)).not.toContain('documents.azure.com');
  });

  it('a sanitized 500 when the point read after a 409 fails', async () => {
    const { fake, deps } = setup();
    fake.seed(storedDevice({ userId: OTHER_USER_ID }));
    fake.failNext('read', 503);

    const response = await claimDeviceHandler(request(), context().ctx, deps);

    expect(response.status).toBe(500);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(
      String(QUERY_CHARGE + WRITE_CHARGE + READ_CHARGE)
    );
  });
});

describe('POST /devices/claim — 400 and 401', () => {
  it.each([
    ['a code one symbol short', claimBody({ claimCode: '7K3M-9QXR-2HT' })],
    ['a code one symbol long', claimBody({ claimCode: '7K3M-9QXR-2HTVW' })],
    ['a code with a symbol outside the alphabet (U)', claimBody({ claimCode: '7K3M-9QXR-2HTU' })],
    ['a code with other punctuation', claimBody({ claimCode: '7K3M_9QXR_2HTV' })],
    ['a code that is not a string', claimBody({ claimCode: 123456789012 })],
    ['no code', claimBody({ claimCode: undefined })],
    ['an unknown key', claimBody({ userId: OTHER_USER_ID })],
    ['no name', claimBody({ name: undefined })],
    ['a blank name', claimBody({ name: '   ' })],
    ['a bad device id', claimBody({ deviceId: 'a/b' })],
    ['a blank model', claimBody({ model: ' ' })],
    ['a bad configuration', claimBody({ configuration: { pollingInterval: 0 } })],
    ['a body that is not an object', ['not', 'an', 'object']],
  ])('400 VALIDATION_ERROR for %s, before any twin or Cosmos call', async (_name, body) => {
    const { hub, deps, getRepository } = setup();

    const response = await claimDeviceHandler(request({ body }), context().ctx, deps);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(hub.gets).toEqual([]);
    expect(getRepository).not.toHaveBeenCalled();
  });

  it('400 for malformed JSON', async () => {
    const { deps } = setup();
    const response = await claimDeviceHandler(request({ rawBody: '{nope' }), context().ctx, deps);
    expect(response.status).toBe(400);
  });

  it('the existing 401 without a principal, before any twin or Cosmos call', async () => {
    const { hub, deps, getRepository } = setup();

    const response = await claimDeviceHandler(request({ principal: null }), context().ctx, deps);

    expect(response.status).toBe(401);
    expect(response.jsonBody).toMatchObject({
      error: 'UNAUTHENTICATED',
      reason: 'principal_header_missing',
    });
    expect(hub.gets).toEqual([]);
    expect(getRepository).not.toHaveBeenCalled();
  });

  it('401 for an unparseable principal', async () => {
    const { deps } = setup();
    const response = await claimDeviceHandler(request({ principal: '%%%' }), context().ctx, deps);
    expect(response.status).toBe(401);
  });
});

describe('POST /devices/claim — the code and the hashes never leak', () => {
  /** Every form of a secret this route handles. */
  const SECRETS = [
    CODE,
    SHOWN_CODE,
    TYPED_CODE,
    CODE.toLowerCase(),
    CODE_HASH,
    MY_HASH,
    OTHER_HASH,
    claimCodeHash(DEVICE_ID, 'ZZZZZZZZZZZZ'),
    'ZZZZ-ZZZZ-ZZZZ',
    'ZZZZZZZZZZZZ',
    '7K3M-9QXR-2HTU',
  ];

  const scenarios: Array<[string, () => Promise<{ text: string }>]> = [];
  const run =
    (
      arrange: (fixture: ReturnType<typeof setup>) => void,
      body?: Record<string, unknown>,
      options?: Parameters<typeof setup>[0],
      times = 1
    ) =>
    async () => {
      const fixture = setup(options);
      arrange(fixture);
      const captured: string[] = [];
      for (let i = 0; i < times; i++) {
        const { ctx, lines } = context();
        const response = await claimDeviceHandler(request({ body }), ctx, fixture.deps);
        captured.push(...lines, JSON.stringify(response));
      }
      captured.push(JSON.stringify(fixture.telemetry.spans));
      return { text: captured.join('\n') };
    };

  scenarios.push(
    ['201 then 200', run(() => undefined, undefined, undefined, 2)],
    ['wrong code', run(() => undefined, claimBody({ claimCode: 'ZZZZ-ZZZZ-ZZZZ' }))],
    ['400 on a bad code', run(() => undefined, claimBody({ claimCode: '7K3M-9QXR-2HTU' }))],
    [
      'expired',
      run(() => undefined, undefined, {
        reported: validReported({ claimExpiresAt: NOW.toISOString() }),
      }),
    ],
    [
      'consumed by another',
      run(() => undefined, undefined, {
        desired: { claimConsumedCodeHash: CODE_HASH, claimClaimantHash: OTHER_HASH },
      }),
    ],
    [
      '412 then refused',
      run(({ hub }) => {
        hub.beforePatch = () =>
          hub.forceWrite(DEVICE_ID, {
            claimConsumedCodeHash: CODE_HASH,
            claimClaimantHash: OTHER_HASH,
          });
      }),
    ],
    ['503 twin patch', run(({ hub }) => hub.failNext('patch_twin', 503))],
    ['500 create', run(({ fake }) => fake.failNext('create', 503))],
    ['409 name', run(({ fake }) => fake.seed(storedDevice({ id: 'g', name: 'Backyard Smoker' })))]
  );

  it.each(scenarios)(
    '%s: no log line, response or span carries the code or a hash',
    async (_name, scenario) => {
      const { text } = await scenario();
      expect(text.length).toBeGreaterThan(0);
      for (const secret of SECRETS) {
        expect(text).not.toContain(secret);
      }
    }
  );

  it('the capture is not vacuous: it sees the log lines, the response and the span', async () => {
    const { text } = await run(() => undefined)();
    expect(text).toContain('log: Processing claimDevice request');
    expect(text).toContain('"status":201');
    expect(text).toContain('meatgeek.claim.outcome');
    expect(text).toContain(DEVICE_ID);
  });
});
