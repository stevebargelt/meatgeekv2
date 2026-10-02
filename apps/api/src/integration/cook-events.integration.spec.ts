/**
 * MG-14 SignalR cook-event producer — integration tests.
 *
 * Unlike the per-handler unit specs (start-cook.spec.ts, stop-cook.spec.ts,
 * negotiate.spec.ts, envelope.spec.ts), these tests exercise the producer
 * contract END-TO-END through the REAL app wiring:
 *
 *   1. main.ts's app.http() registrations are captured (routes, methods, and
 *      the shared signalR input/output bindings) and the registered handlers
 *      are driven with mock requests/context — proving the handler a real
 *      request would hit emits the right SignalR message on the right binding.
 *   2. The emitted envelopes are JSON-serialized exactly as the Functions
 *      SignalR output binding would put them on the wire, then cross-checked
 *      against the Go data-pusher CONSUMER contract
 *      (apps/data-pusher/internal/signalr) — event-name strings and the
 *      cookId-omitted-on-stop rule are read straight out of the Go source so
 *      the two sides cannot silently drift.
 *
 * No live SignalR Service is involved; the bindings are mocked. AC5 (live
 * end-to-end smoke) is out of scope here and blocked on the MG-24 bootstrap.
 */
import { readFileSync, existsSync } from 'fs';
import { dirname, resolve } from 'path';
import { HttpRequest, InvocationContext } from '@azure/functions';
import {
  signalROutput,
  SignalROutputMessage,
  buildCookEnvelope,
  COOK_STARTED,
  COOK_STOPPED,
  HUB_NAME,
} from '../functions/signalr/envelope';
import { signalRConnInfoInput } from '../functions/signalr/negotiate';
import { Cook } from '../functions/cooks/start-cook';

// ---------------------------------------------------------------------------
// Capture main.ts's app.http() registrations by mocking the Functions `app`
// object while keeping the real `input`/`output` generic-binding builders (so
// signalROutput / signalRConnInfoInput keep their real object identity).
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
  connInfoReads: () => number;
}

function mockContext(connectionInfo?: unknown): CapturingContext {
  let captured: SignalROutputMessage<Cook>[] | undefined;
  let reads = 0;
  const ctx = {
    invocationId: INVOCATION_ID,
    log: () => undefined,
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
    // Input binding: negotiate reads its SignalRConnectionInfo from here.
    extraInputs: {
      get: (input: unknown) => {
        if (input === signalRConnInfoInput) {
          reads += 1;
          return connectionInfo;
        }
        return undefined;
      },
    },
  } as unknown as InvocationContext;
  return { ctx, messages: () => captured, connInfoReads: () => reads };
}

const VALID_START = {
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

/** A fixed authenticated principal (tenant-namespaced userId), never 'user-1'. */
const AUTHED_PRINCIPAL = {
  authenticated: true as const,
  principal: {
    userId: 'tenant-aaaa:oid-bbbb',
    objectId: 'oid-bbbb',
    tenantId: 'tenant-aaaa',
  },
};

/** Fake start-cook deps: authenticated, with a repository that echoes the write. */
function startDeps() {
  return {
    resolvePrincipal: () => AUTHED_PRINCIPAL,
    getRepository: () => ({
      // Persist = echo back the document the handler built (what Cosmos returns).
      createCook: async (cook: Cook) => ({ cook, requestCharge: 1 }),
    }),
  };
}

/**
 * Fake stop-cook deps. `persisted` models the durable cook the repository
 * point-reads and completes; `undefined` models a cook absent in the caller's
 * partition (a 404). The stopped cook keeps the persisted `deviceId` — the axis
 * the COOK_STOPPED envelope is delivered on — which under the new contract comes
 * from PERSISTENCE, not from the request body.
 */
function stopDeps(persisted: Cook | undefined) {
  return {
    resolvePrincipal: () => AUTHED_PRINCIPAL,
    getRepository: () => ({
      stopCook: async (_userId: string, id: string, endTime: string) => ({
        cook: persisted
          ? ({ ...persisted, id, status: 'completed', endTime } as Cook)
          : undefined,
        requestCharge: 1,
      }),
    }),
  };
}

/** The persisted active cook a stop reads back (deviceId is the delivery axis). */
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

  it('registers negotiate as POST /negotiate with the signalR connection-info input binding', () => {
    const reg = mockRegistrations['negotiate'];
    expect(reg).toBeDefined();
    expect(reg.methods).toEqual(['POST']);
    expect(reg.route).toBe('negotiate');
    expect(reg.extraInputs).toContain(signalRConnInfoInput);
  });

  it('binds both producers to the same temperatureHub SignalR hub', () => {
    // output.generic()/input.generic() preserve their options, so the hub
    // name is inspectable and must agree across producer + negotiate.
    expect((signalROutput as unknown as { hubName: string }).hubName).toBe(HUB_NAME);
    expect((signalRConnInfoInput as unknown as { hubName: string }).hubName).toBe(HUB_NAME);
    expect(HUB_NAME).toBe('temperatureHub');
    // negotiate scopes the connection to the device's user group.
    expect((signalRConnInfoInput as unknown as { userId: string }).userId).toBe('{query.deviceId}');
  });
});

// ---------------------------------------------------------------------------
// B. cook_started, driven through the registered handler.
// ---------------------------------------------------------------------------
describe('POST /cooks (startCook) — cook_started producer', () => {
  it('emits exactly one cook_started envelope on group userId=deviceId with correlation from X-Request-ID', async () => {
    const { ctx, messages } = mockContext();
    const res = await invokeStart(
      mockRequest({ body: VALID_START, headers: { 'X-Request-ID': 'req-xyz' } }),
      ctx
    );

    const msgs = messages();
    expect(msgs).toHaveLength(1);
    const [msg] = msgs!;
    expect(msg.target).toBe('cook_started');
    expect(msg.userId).toBe(VALID_START.deviceId); // group = userId = deviceId

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
  ])('returns 400 and emits NO message when %s is missing (authenticated)', async (_field, body) => {
    // Authenticated (via injected deps) but invalid: validation still returns 400
    // and emits nothing. The auth gate is upstream of validation, so a missing
    // field is a 400, not a 401.
    const { ctx, messages } = mockContext();
    const res = await invokeStart(mockRequest({ body }), ctx);
    expect((res as { status: number }).status).toBe(400);
    expect(messages()).toBeUndefined();
  });

  it('returns 401 and emits NO message when the request is unauthenticated', async () => {
    // The persisted userId comes ONLY from the authenticated principal; an
    // unauthenticated caller is rejected before any write or SignalR emit.
    const { ctx, messages } = mockContext();
    const unauthDeps = {
      resolvePrincipal: () => ({ authenticated: false as const, reason: 'principal_header_missing' as const }),
      getRepository: () => ({
        createCook: async () => {
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
  it('emits one cook_stopped envelope on group userId=deviceId with top-level cookId OMITTED', async () => {
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
    expect(msg.userId).toBe('meatgeek3'); // group = userId = deviceId

    const env = msg.arguments[0];
    // Top-level cookId must be ABSENT (not undefined-valued) on stop.
    expect(env).not.toHaveProperty('cookId');
    // The stopped cook stays identifiable via payload.id === path cookId.
    expect(env.payload.id).toBe('cook-abc');
    expect(env.payload.status).toBe('completed');
    expect(env.correlation.id).toBe('req-stop');

    // The stop payload is the PERSISTED cook read back and completed; it is a
    // schema-VALID Cook: name >= 3 chars, startTime a parseable ISO-8601
    // date-time. The Go consumer keys off payload.id and ignores name/startTime.
    expect(env.payload.name.length).toBeGreaterThanOrEqual(3);
    expect(Number.isNaN(Date.parse(env.payload.startTime))).toBe(false);

    expect((res as { status: number }).status).toBe(200);
  });

  it('serializes cook_stopped with no cookId key on the wire (matches Go omitempty pointer)', async () => {
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
      resolvePrincipal: () => ({ authenticated: false as const, reason: 'principal_header_missing' as const }),
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
// D. negotiate, driven through the registered handler.
// ---------------------------------------------------------------------------
describe('POST /negotiate — SignalR connection info', () => {
  const handler = () => mockRegistrations['negotiate'].handler;
  const STUB_CONN_INFO = {
    url: 'https://example.service.signalr.net/client/?hub=temperatureHub',
    accessToken: 'stub-access-token',
  };

  it('returns 200 with the SignalRConnectionInfo from the input binding for a deviceId', async () => {
    const { ctx } = mockContext(STUB_CONN_INFO);
    const res = await handler()(mockRequest({ query: { deviceId: 'meatgeek3' } }), ctx);
    expect((res as { status: number }).status).toBe(200);
    expect((res as { jsonBody: unknown }).jsonBody).toBe(STUB_CONN_INFO);
  });

  it('returns 400 VALIDATION_ERROR when deviceId is absent (no connection info issued)', async () => {
    const { ctx, connInfoReads } = mockContext(STUB_CONN_INFO);
    const res = await handler()(mockRequest({ query: {} }), ctx);
    expect((res as { status: number }).status).toBe(400);
    expect((res as { jsonBody: { error: string } }).jsonBody.error).toBe('VALIDATION_ERROR');
    // Rejected before handing back any connection info.
    expect(connInfoReads()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// E. Wire-contract match with the Go data-pusher CONSUMER.
//    These read the Go source directly so producer/consumer cannot drift.
// ---------------------------------------------------------------------------
describe('producer/consumer wire-contract parity (apps/data-pusher/internal/signalr)', () => {
  // Walk up from this test file to the repo root (dir that contains apps/), so
  // the cross-check is robust to where the runner copies the tree.
  function goSignalrDir(): string {
    let dir = __dirname;
    for (let i = 0; i < 12; i++) {
      const candidate = resolve(dir, 'apps/data-pusher/internal/signalr');
      if (existsSync(resolve(candidate, 'events.go'))) {
        return candidate;
      }
      const parent = dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
    throw new Error(
      'Could not locate apps/data-pusher/internal/signalr/events.go from ' + __dirname
    );
  }

  const dir = goSignalrDir();
  const eventsGo = readFileSync(resolve(dir, 'events.go'), 'utf8');
  const protocolGo = readFileSync(resolve(dir, 'protocol.go'), 'utf8');

  function goEventType(name: string): string {
    const m = eventsGo.match(new RegExp(`${name}\\s+EventType\\s*=\\s*"([^"]+)"`));
    if (!m) throw new Error(`Go const ${name} not found in events.go`);
    return m[1];
  }

  it('COOK_STARTED matches the Go EventTypeCookStarted constant', () => {
    expect(COOK_STARTED).toBe(goEventType('EventTypeCookStarted'));
    expect(COOK_STARTED).toBe('cook_started');
  });

  it('COOK_STOPPED matches the Go EventTypeCookStopped constant', () => {
    expect(COOK_STOPPED).toBe(goEventType('EventTypeCookStopped'));
    expect(COOK_STOPPED).toBe('cook_stopped');
  });

  it('the Go envelope decodes cookId as an omitempty pointer (nil when the producer omits it)', () => {
    // envelopeArgument in protocol.go: `CookID *string json:"cookId,omitempty"`.
    // A pointer + omitempty means an absent key decodes to nil — which is
    // exactly what the producer relies on when it drops cookId on stop.
    expect(protocolGo).toMatch(/CookID\s+\*string\s+`json:"cookId,omitempty"`/);
  });

  it('emits the wire shape the Go dispatcher expects: cookId present on start, absent on stop', () => {
    const cook: Cook = {
      id: 'cook-42',
      userId: 'user-1',
      deviceId: 'device-1',
      name: 'Test Cook',
      status: 'active',
      startTime: new Date().toISOString(),
      meatType: 'brisket',
    };

    // cook_started → Go decodes CookID = &"cook-42" (see TestCookStartedEventPropagates).
    const started = JSON.parse(JSON.stringify(buildCookEnvelope(COOK_STARTED, cook, 'corr-abc')));
    expect(started.type).toBe('cook_started');
    expect(started.cookId).toBe('cook-42');
    expect(started.payload.id).toBe('cook-42');
    expect(started.correlation.id).toBe('corr-abc');

    // cook_stopped → Go decodes CookID = nil (see TestCookStoppedClearsCookID);
    // the key must be absent, and the cook stays identifiable via payload.id.
    const stopped = JSON.parse(JSON.stringify(buildCookEnvelope(COOK_STOPPED, cook, 'corr-xyz')));
    expect(stopped.type).toBe('cook_stopped');
    expect(Object.keys(stopped)).not.toContain('cookId');
    expect(stopped.payload.id).toBe('cook-42');
    expect(stopped.correlation.id).toBe('corr-xyz');
  });
});
