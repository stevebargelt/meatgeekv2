/**
 * MG-14 SignalR cook-event producer — integration tests.
 *
 * Unlike the per-handler unit specs (start-cook.spec.ts, stop-cook.spec.ts,
 * negotiate.spec.ts, envelope.spec.ts), these tests exercise the producer
 * contract END-TO-END through the REAL app wiring:
 *
 *   1. main.ts's app.http() registrations are captured (routes, methods, and
 *      the shared signalR output binding) and the registered handlers are
 *      driven with mock requests/context — proving the handler a real request
 *      would hit emits the right SignalR message on the right binding.
 *   2. HAR-57 (MG-30): cook events are delivered to the OWNER (message userId =
 *      the authenticated principal's userId), never to userId = deviceId, and
 *      negotiate scopes a connection to the caller's own device groups whatever
 *      `deviceId` query parameter the caller sends.
 *
 * The emitted envelopes are JSON-serialized exactly as the Functions SignalR
 * output binding would put them on the wire. No live SignalR Service is
 * involved: the output binding is mocked and negotiate's SignalR client is a
 * recording stub. The live negotiate proof is
 * apps/api/acceptance/proofs/signalr-negotiate.proof.ts.
 */
import { HttpRequest, InvocationContext } from '@azure/functions';
import {
  signalROutput,
  SignalROutputMessage,
  buildCookEnvelope,
  COOK_STARTED,
  COOK_STOPPED,
  HUB_NAME,
} from '../functions/signalr/envelope';
import type { NegotiateDeps } from '../functions/signalr/negotiate';
import type { SignalRManagementPort } from '../shared/signalr/signalr-management';
import { Cook } from '../functions/cooks/start-cook';

// ---------------------------------------------------------------------------
// Capture main.ts's app.http() registrations by mocking the Functions `app`
// object while keeping the real `output` generic-binding builder (so
// signalROutput keeps its real object identity).
// ---------------------------------------------------------------------------
interface HttpRegistration {
  methods: string[];
  authLevel?: string;
  route?: string;
  extraInputs?: unknown[];
  extraOutputs?: unknown[];
  handler: (req: HttpRequest, ctx: InvocationContext) => Promise<unknown>;
}

const mockRegistrations: Record<string, HttpRegistration> = {};

jest.mock('@azure/functions', () => {
  const actual = jest.requireActual('@azure/functions');
  return {
    ...actual,
    app: {
      http: (name: string, config: HttpRegistration) => {
        mockRegistrations[name] = config;
      },
      // main.ts also registers the MG-58 host-storage heartbeat timer. This
      // suite is about the SignalR producers, so the registration is swallowed
      // rather than captured — but the stub must exist, or importing main.ts
      // throws before any HTTP registration lands. The timer's own wiring is
      // asserted in functions/health/storage-heartbeat.spec.ts.
      timer: () => undefined,
      // HAR-60: main.ts registers the broadcastTemperature Event Hub trigger;
      // its wiring is asserted in broadcast-temperature.integration.spec.ts.
      eventHub: () => undefined,
      // HAR-86: the rollupTemperatures change-feed trigger; asserted in
      // rollup-temperatures.integration.spec.ts.
      cosmosDB: () => undefined,
    },
  };
});

// Importing main.ts triggers all app.http() registrations into mockRegistrations.
beforeAll(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../main');
});

// ---------------------------------------------------------------------------
// Mock request / context helpers.
// ---------------------------------------------------------------------------
const INVOCATION_ID = 'inv-integration-1';

function mockRequest(opts: {
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
  headers?: Record<string, string>;
}): HttpRequest {
  const query = new Map(Object.entries(opts.query ?? {}));
  const headers = new Map(Object.entries(opts.headers ?? {}));
  return {
    json: async () => opts.body,
    headers: { get: (k: string) => headers.get(k) ?? null },
    query: { get: (k: string) => query.get(k) ?? null },
    params: opts.params ?? {},
  } as unknown as HttpRequest;
}

interface CapturingContext {
  ctx: InvocationContext;
  messages: () => SignalROutputMessage<Cook>[] | undefined;
}

function mockContext(): CapturingContext {
  let captured: SignalROutputMessage<Cook>[] | undefined;
  const ctx = {
    invocationId: INVOCATION_ID,
    log: () => undefined,
    warn: () => undefined,
    error: () => undefined,
    // Output binding: the runtime matches set() to a binding by object
    // identity, so only capture when the shared signalROutput is used.
    extraOutputs: {
      set: (output: unknown, value: unknown) => {
        if (output === signalROutput) {
          captured = value as SignalROutputMessage<Cook>[];
        }
      },
    },
  } as unknown as InvocationContext;
  return { ctx, messages: () => captured };
}

const VALID_START = {
  // MG-84: the client supplies the cook id (a UUID) on every start.
  id: '6f1c2b8e-3d4a-4f6b-9c7d-0e1f2a3b4c5d',
  name: 'Weekend Brisket',
  deviceId: 'meatgeek3',
  meatType: 'brisket',
};

// ---------------------------------------------------------------------------
// MG-59 injection seams. The cooks handlers now (a) derive the persisted userId
// from the authenticated Easy Auth principal and (b) persist through the shared
// Cosmos adapter. This suite is about the SignalR PRODUCER contract, not
// persistence or auth, so it injects a fake authenticated principal and a fake
// repository — exactly the handlers' own DI seam (start-cook.ts StartCookDeps /
// stop-cook.ts StopCookDeps). No Easy Auth, no Cosmos, no credentials are
// touched; the producer envelopes are asserted through the real handler code.
// ---------------------------------------------------------------------------

/** A fixed authenticated principal (tenant-namespaced userId), never 'tid-test:oid-test'. */
const AUTHED_PRINCIPAL = {
  authenticated: true as const,
  principal: {
    userId: 'tenant-aaaa:oid-bbbb',
    objectId: 'oid-bbbb',
    tenantId: 'tenant-aaaa',
  },
};

/** HAR-26: every device is owned by the caller in this suite (ownership is
 *  covered in start-cook.spec / stop-cook.spec). */
async function ownedDevice(userId: string, deviceId: string) {
  return {
    status: 'owned' as const,
    device: { id: deviceId, userId, name: deviceId },
    requestCharge: 1,
  };
}

/** HAR-66: the twin sync always succeeds here (it is covered in its own spec). */
async function syncedTwin() {
  return { outcome: 'patched' as const, requestCharge: 0 };
}

/** Fake start-cook deps: authenticated, with a repository that echoes the write. */
function startDeps() {
  return {
    resolvePrincipal: () => AUTHED_PRINCIPAL,
    getDeviceOwnership: ownedDevice,
    syncDeviceTwin: syncedTwin,
    getRepository: () => ({
      // Persist = echo back the document the handler built (what Cosmos returns).
      startCook: async (cook: Cook) => ({ outcome: 'created' as const, cook, requestCharge: 1 }),
    }),
  };
}

/**
 * Fake stop-cook deps. `persisted` models the durable cook the repository
 * point-reads and completes; `undefined` models a cook absent in the caller's
 * partition (a 404). The stopped cook keeps the persisted `deviceId`, which the
 * COOK_STOPPED envelope carries; delivery goes to the owner, not the device.
 */
function stopDeps(persisted: Cook | undefined) {
  return {
    resolvePrincipal: () => AUTHED_PRINCIPAL,
    getDeviceOwnership: ownedDevice,
    syncDeviceTwin: syncedTwin,
    getRepository: () => ({
      getCook: async () => ({ cook: persisted, requestCharge: 1 }),
      stopCook: async (_userId: string, id: string, endTime: string) => ({
        cook: persisted ? ({ ...persisted, id, status: 'completed', endTime } as Cook) : undefined,
        requestCharge: 1,
        transitioned: persisted !== undefined,
      }),
    }),
  };
}

/** The persisted active cook a stop reads back. */
function persistedActiveCook(): Cook {
  return {
    id: 'persisted-id',
    userId: AUTHED_PRINCIPAL.principal.userId,
    deviceId: 'meatgeek3',
    name: 'Weekend Brisket',
    status: 'active',
    startTime: '2026-08-24T06:00:00Z',
    meatType: 'brisket',
  };
}

/** Drives the registered startCook handler with injected deps (3rd arg seam). */
function invokeStart(
  req: HttpRequest,
  ctx: InvocationContext,
  deps: ReturnType<typeof startDeps> = startDeps()
) {
  const handler = mockRegistrations['startCook'].handler as unknown as (
    r: HttpRequest,
    c: InvocationContext,
    d: unknown
  ) => Promise<unknown>;
  return handler(req, ctx, deps);
}

/** Drives the registered stopCook handler with injected deps (3rd arg seam). */
function invokeStop(
  req: HttpRequest,
  ctx: InvocationContext,
  deps: ReturnType<typeof stopDeps> = stopDeps(persistedActiveCook())
) {
  const handler = mockRegistrations['stopCook'].handler as unknown as (
    r: HttpRequest,
    c: InvocationContext,
    d: unknown
  ) => Promise<unknown>;
  return handler(req, ctx, deps);
}

// ---------------------------------------------------------------------------
// A. main.ts wiring — routes, methods, and the shared SignalR bindings.
// ---------------------------------------------------------------------------
describe('main.ts SignalR producer registrations', () => {
  it('registers startCook as POST /cooks with the shared signalR output binding', () => {
    const reg = mockRegistrations['startCook'];
    expect(reg).toBeDefined();
    expect(reg.methods).toEqual(['POST']);
    expect(reg.route).toBe('cooks');
    // Same object identity the handler emits through.
    expect(reg.extraOutputs).toContain(signalROutput);
  });

  it('registers stopCook as POST /cooks/{cookId}/stop with the shared signalR output binding', () => {
    const reg = mockRegistrations['stopCook'];
    expect(reg).toBeDefined();
    expect(reg.methods).toEqual(['POST']);
    expect(reg.route).toBe('cooks/{cookId}/stop');
    expect(reg.extraOutputs).toContain(signalROutput);
  });

  it('registers negotiate as POST /negotiate with no SignalR input binding (HAR-57)', () => {
    const reg = mockRegistrations['negotiate'];
    expect(reg).toBeDefined();
    expect(reg.methods).toEqual(['POST']);
    expect(reg.route).toBe('negotiate');
    // The SignalR connection-info input binding cannot express the principal's
    // "<tid>:<oid>" userId; negotiate mints its token through the REST client.
    expect(reg.extraInputs ?? []).toEqual([]);
  });

  it('binds the producers to the temperatureHub SignalR hub', () => {
    // output.generic() preserves its options, so the hub name is inspectable.
    expect((signalROutput as unknown as { hubName: string }).hubName).toBe(HUB_NAME);
    expect(HUB_NAME).toBe('temperatureHub');
  });
});

// ---------------------------------------------------------------------------
// B. cook_started, driven through the registered handler.
// ---------------------------------------------------------------------------
describe('POST /cooks (startCook) — cook_started producer', () => {
  it('emits exactly one cook_started envelope to the owner (userId = principal) with correlation from X-Request-ID', async () => {
    const { ctx, messages } = mockContext();
    const res = await invokeStart(
      mockRequest({ body: VALID_START, headers: { 'X-Request-ID': 'req-xyz' } }),
      ctx
    );

    const msgs = messages();
    expect(msgs).toHaveLength(1);
    const [msg] = msgs!;
    expect(msg.target).toBe('cook_started');
    // HAR-57: delivered to the owner, never to userId = deviceId.
    expect(msg.userId).toBe(AUTHED_PRINCIPAL.principal.userId);
    expect(msg.userId).not.toBe(VALID_START.deviceId);

    const env = msg.arguments[0];
    expect(env.type).toBe('cook_started');
    expect(env.deviceId).toBe(VALID_START.deviceId);
    expect(env.cookId).toBe(env.payload.id); // top-level cookId === payload.id
    expect(env.correlation.id).toBe('req-xyz'); // propagated request id

    // payload is a full active Cook echoing the request.
    expect(env.payload.status).toBe('active');
    expect(env.payload.name).toBe(VALID_START.name);
    expect(env.payload.meatType).toBe(VALID_START.meatType);
    expect(env.payload.deviceId).toBe(VALID_START.deviceId);

    // 201 contract preserved; response id matches the emitted cook.
    expect((res as { status: number }).status).toBe(201);
    expect((res as { jsonBody: Cook }).jsonBody.id).toBe(env.payload.id);
  });

  it('falls back to the invocation id for correlation when X-Request-ID is absent', async () => {
    const { ctx, messages } = mockContext();
    await invokeStart(mockRequest({ body: VALID_START }), ctx);
    expect(messages()![0].arguments[0].correlation.id).toBe(INVOCATION_ID);
  });

  it.each([
    ['name', { deviceId: 'meatgeek3', meatType: 'brisket' }],
    ['deviceId', { name: 'x', meatType: 'brisket' }],
    ['meatType', { name: 'x', deviceId: 'meatgeek3' }],
  ])(
    'returns 400 and emits NO message when %s is missing (authenticated)',
    async (_field, body) => {
      // Authenticated (via injected deps) but invalid: validation still returns 400
      // and emits nothing. The auth gate is upstream of validation, so a missing
      // field is a 400, not a 401.
      const { ctx, messages } = mockContext();
      const res = await invokeStart(mockRequest({ body }), ctx);
      expect((res as { status: number }).status).toBe(400);
      expect(messages()).toBeUndefined();
    }
  );

  it('returns 401 and emits NO message when the request is unauthenticated', async () => {
    // The persisted userId comes ONLY from the authenticated principal; an
    // unauthenticated caller is rejected before any write or SignalR emit.
    const { ctx, messages } = mockContext();
    const unauthDeps = {
      resolvePrincipal: () => ({
        authenticated: false as const,
        reason: 'principal_header_missing' as const,
      }),
      getRepository: () => ({
        startCook: async () => {
          throw new Error('must not be called when unauthenticated');
        },
      }),
    };
    const res = await invokeStart(
      mockRequest({ body: VALID_START }),
      ctx,
      unauthDeps as unknown as ReturnType<typeof startDeps>
    );
    expect((res as { status: number }).status).toBe(401);
    expect(messages()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// C. cook_stopped, driven through the registered handler.
// ---------------------------------------------------------------------------
describe('POST /cooks/{cookId}/stop (stopCook) — cook_stopped producer', () => {
  it('emits one cook_stopped envelope to the owner (userId = principal) with top-level cookId OMITTED', async () => {
    const { ctx, messages } = mockContext();
    const res = await invokeStop(
      mockRequest({
        params: { cookId: 'cook-abc' },
        headers: { 'X-Request-ID': 'req-stop' },
      }),
      ctx
    );

    const msgs = messages();
    expect(msgs).toHaveLength(1);
    const [msg] = msgs!;
    expect(msg.target).toBe('cook_stopped');
    // HAR-57: delivered to the owner, never to userId = deviceId.
    expect(msg.userId).toBe(AUTHED_PRINCIPAL.principal.userId);
    expect(msg.userId).not.toBe('meatgeek3');
    expect(msg.arguments[0].deviceId).toBe('meatgeek3');

    const env = msg.arguments[0];
    // Top-level cookId must be ABSENT (not undefined-valued) on stop.
    expect(env).not.toHaveProperty('cookId');
    // The stopped cook stays identifiable via payload.id === path cookId.
    expect(env.payload.id).toBe('cook-abc');
    expect(env.payload.status).toBe('completed');
    expect(env.correlation.id).toBe('req-stop');

    // The stop payload is the PERSISTED cook read back and completed; it is a
    // schema-VALID Cook: name >= 3 chars, startTime a parseable ISO-8601
    // date-time.
    expect(env.payload.name.length).toBeGreaterThanOrEqual(3);
    expect(Number.isNaN(Date.parse(env.payload.startTime))).toBe(false);

    expect((res as { status: number }).status).toBe(200);
  });

  it('serializes cook_stopped with no cookId key on the wire', async () => {
    const { ctx, messages } = mockContext();
    await invokeStop(mockRequest({ params: { cookId: 'cook-99' } }), ctx);
    // What the SignalR output binding actually puts on the wire.
    const wire = JSON.parse(JSON.stringify(messages()![0].arguments[0]));
    expect(Object.keys(wire)).not.toContain('cookId');
    expect(wire.payload.id).toBe('cook-99');
  });

  it('falls back to the invocation id for correlation when X-Request-ID is absent', async () => {
    const { ctx, messages } = mockContext();
    await invokeStop(mockRequest({ params: { cookId: 'cook-1' } }), ctx);
    expect(messages()![0].arguments[0].correlation.id).toBe(INVOCATION_ID);
  });

  it('returns 404 and emits NO message when the cook is absent in the caller partition', async () => {
    // MG-59 contract change: stop no longer synthesizes a cook from body.deviceId
    // (the old contract, which 400'd on a missing deviceId). It point-reads the
    // PERSISTED cook in the caller's partition; a miss is a 404 with NO emit — and
    // a cook owned by another principal lives in another partition, so this same
    // path also refuses any cross-tenant stop.
    const { ctx, messages } = mockContext();
    const res = await invokeStop(
      mockRequest({ params: { cookId: 'ghost' } }),
      ctx,
      stopDeps(undefined)
    );
    expect((res as { status: number }).status).toBe(404);
    expect(messages()).toBeUndefined();
  });

  it('returns 401 and emits NO message when the request is unauthenticated', async () => {
    const { ctx, messages } = mockContext();
    const unauthDeps = {
      resolvePrincipal: () => ({
        authenticated: false as const,
        reason: 'principal_header_missing' as const,
      }),
      getRepository: () => ({
        stopCook: async () => {
          throw new Error('must not be called when unauthenticated');
        },
      }),
    };
    const res = await invokeStop(
      mockRequest({ params: { cookId: 'cook-abc' } }),
      ctx,
      unauthDeps as unknown as ReturnType<typeof stopDeps>
    );
    expect((res as { status: number }).status).toBe(401);
    expect(messages()).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// D. negotiate, driven through the registered handler (HAR-57, MG-30).
// ---------------------------------------------------------------------------
describe('POST /negotiate — a connection scoped to the caller', () => {
  const CLIENT_URL = 'https://example.service.signalr.net/client/?hub=temperatureHub';

  function negotiateDeps(ownedDeviceIds: string[]) {
    const calls: string[] = [];
    const signalR: SignalRManagementPort = {
      async removeUserFromAllGroups(userId) {
        calls.push(`removeAll ${userId}`);
      },
      async addUserToGroup(group, userId) {
        calls.push(`add ${group} ${userId}`);
      },
      async generateClientToken(userId) {
        calls.push(`token ${userId}`);
        return { url: CLIENT_URL, accessToken: `token-for:${userId}` };
      },
    };
    const deps = {
      resolvePrincipal: () => AUTHED_PRINCIPAL,
      getRepository: () => ({
        listDevicesByOwner: async (userId: string) => ({
          devices: ownedDeviceIds.map(id => ({ id, userId, name: id })),
          requestCharge: 1,
        }),
      }),
      getSignalR: () => signalR,
    } as unknown as NegotiateDeps;
    return { deps, calls };
  }

  function invokeNegotiate(req: HttpRequest, deps: NegotiateDeps) {
    const handler = mockRegistrations['negotiate'].handler as unknown as (
      r: HttpRequest,
      c: InvocationContext,
      d: NegotiateDeps
    ) => Promise<{ status: number; jsonBody: unknown }>;
    return handler(req, mockContext().ctx, deps);
  }

  it("returns a token for the principal and joins only the caller's device groups", async () => {
    const { deps, calls } = negotiateDeps(['meatgeek3']);
    const res = await invokeNegotiate(mockRequest({}), deps);

    const userId = AUTHED_PRINCIPAL.principal.userId;
    expect(res.status).toBe(200);
    expect(res.jsonBody).toEqual({ url: CLIENT_URL, accessToken: `token-for:${userId}` });
    expect(calls).toEqual([
      `removeAll ${userId}`,
      `add device-meatgeek3 ${userId}`,
      `token ${userId}`,
    ]);
  });

  it('ignores a ?deviceId= for a device the caller does not own', async () => {
    const { deps, calls } = negotiateDeps(['meatgeek3']);
    const res = await invokeNegotiate(mockRequest({ query: { deviceId: 'someone-elses' } }), deps);

    expect(res.status).toBe(200);
    expect(calls.join('\n')).not.toContain('someone-elses');
  });
});

// ---------------------------------------------------------------------------
// E. Wire shape of the cook envelopes.
// ---------------------------------------------------------------------------
describe('cook envelope wire shape', () => {
  it('uses the cook_started and cook_stopped event names', () => {
    expect(COOK_STARTED).toBe('cook_started');
    expect(COOK_STOPPED).toBe('cook_stopped');
  });

  it('carries cookId on start and omits it on stop', () => {
    const cook: Cook = {
      id: 'cook-42',
      userId: 'tid-test:oid-test',
      deviceId: 'device-1',
      name: 'Test Cook',
      status: 'active',
      startTime: new Date().toISOString(),
      meatType: 'brisket',
    };

    const started = JSON.parse(JSON.stringify(buildCookEnvelope(COOK_STARTED, cook, 'corr-abc')));
    expect(started.type).toBe('cook_started');
    expect(started.cookId).toBe('cook-42');
    expect(started.payload.id).toBe('cook-42');
    expect(started.correlation.id).toBe('corr-abc');

    // The key must be absent, and the cook stays identifiable via payload.id.
    const stopped = JSON.parse(JSON.stringify(buildCookEnvelope(COOK_STOPPED, cook, 'corr-xyz')));
    expect(stopped.type).toBe('cook_stopped');
    expect(Object.keys(stopped)).not.toContain('cookId');
    expect(stopped.payload.id).toBe('cook-42');
    expect(stopped.correlation.id).toBe('corr-xyz');
  });
});
