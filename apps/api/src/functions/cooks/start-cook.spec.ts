import { HttpRequest, InvocationContext } from '@azure/functions';
// Contract types come from the shared package — the handler no longer declares
// its own Cook/StartCookRequest, so the spec exercises the canonical shapes.
// All cross-module imports here are TYPE-ONLY (erased at runtime): the real
// modules are pulled in via require() AFTER valid env is arranged, because the
// cooks repository → shared adapter runs a fail-loud config guard at module
// load that throws without env (exactly as the adapter/repository specs do).
import type { Cook, StartCookRequest } from '@meatgeekv2/api-interfaces';
import type { StartCookDeps } from './start-cook';
import type { SignalROutputMessage } from '../signalr/envelope';
import type { CookResult } from '../../shared/cosmos/cooks-repository';
import type { PrincipalResult } from '../../shared/auth/principal';

const INVOCATION_ID = 'inv-42';

// A representative tenant-namespaced identity ("<tid>:<oid>") — the shape the
// Easy Auth principal helper produces. Deliberately NOT 'user-1'.
const PRINCIPAL_USER_ID = 'tenant-abc:oid-123';

// The adapter's fail-loud guard demands these three at module load. Values are
// inert placeholders — no test ever reaches Azure (the repository is injected).
const VALID_ENV = {
  COSMOSDB__accountEndpoint: 'https://mgv2-secret-account.documents.azure.com/',
  COSMOSDB_DATABASE_NAME: 'meatgeek-v2-dev-db',
  COSMOSDB_COOKS_CONTAINER_NAME: 'cooks',
};

// Populated once via require() after env is set. `signalROutput` MUST come from
// the same fresh module graph the handler imported, or the identity check the
// handler does (`output === signalROutput`) would never match a separately
// imported instance.
let startCookHandler: typeof import('./start-cook').startCookHandler;
let signalROutput: unknown;

beforeAll(() => {
  jest.resetModules();
  for (const [key, value] of Object.entries(VALID_ENV)) {
    process.env[key] = value;
  }
  startCookHandler = (require('./start-cook') as typeof import('./start-cook')).startCookHandler;
  signalROutput = (require('../signalr/envelope') as typeof import('../signalr/envelope'))
    .signalROutput;
});

function mockRequest(body: Partial<StartCookRequest>, requestIdHeader?: string): HttpRequest {
  const headers = new Map<string, string>();
  if (requestIdHeader !== undefined) {
    headers.set('X-Request-ID', requestIdHeader);
  }
  return {
    json: async () => body,
    headers: { get: (k: string) => headers.get(k) ?? null },
    query: { get: () => null },
    params: {},
  } as unknown as HttpRequest;
}

interface Captured {
  ctx: InvocationContext;
  messages: () => SignalROutputMessage[] | undefined;
}

function mockContext(): Captured {
  let captured: SignalROutputMessage[] | undefined;
  const ctx = {
    invocationId: INVOCATION_ID,
    log: () => undefined,
    error: () => undefined,
    extraOutputs: {
      set: (output: unknown, value: unknown) => {
        if (output === signalROutput) {
          captured = value as SignalROutputMessage[];
        }
      },
    },
  } as unknown as InvocationContext;
  return { ctx, messages: () => captured };
}

/**
 * Records every createCook call so a test can assert the write happened exactly
 * once and inspect the persisted document (its partition userId in particular).
 * `echoResource` toggles whether Cosmos echoes the stored resource (it does) vs.
 * returning nothing, exercising the `persisted ?? newCook` fallback.
 */
function fakeRepository(opts: { echoResource?: boolean } = {}) {
  const echoResource = opts.echoResource ?? true;
  const writes: Cook[] = [];
  return {
    writes,
    createCook: async (cook: Cook): Promise<CookResult> => {
      writes.push(cook);
      return {
        cook: echoResource ? { ...cook } : undefined,
        requestCharge: 7.42,
      };
    },
  };
}

/** Deps that authenticate as PRINCIPAL_USER_ID and capture repository writes. */
function authedDeps(repo = fakeRepository()): {
  deps: StartCookDeps;
  writes: Cook[];
} {
  const deps: StartCookDeps = {
    resolvePrincipal: (): PrincipalResult => ({
      authenticated: true,
      principal: {
        userId: PRINCIPAL_USER_ID,
        objectId: 'oid-123',
        tenantId: 'tenant-abc',
      },
    }),
    getRepository: () => repo,
  };
  return { deps, writes: repo.writes };
}

const validBody: StartCookRequest = {
  name: 'Weekend Brisket',
  deviceId: 'meatgeek3',
  meatType: 'brisket',
};

describe('startCookHandler', () => {
  it('writes exactly one cook partitioned on the authenticated principal, then emits', async () => {
    const { ctx, messages } = mockContext();
    const { deps, writes } = authedDeps();

    const res = await startCookHandler(mockRequest(validBody), ctx, deps);

    // Exactly one write, addressed to the authenticated identity's partition.
    expect(writes).toHaveLength(1);
    expect(writes[0].userId).toBe(PRINCIPAL_USER_ID);
    expect(writes[0].deviceId).toBe(validBody.deviceId);
    expect(writes[0].status).toBe('active');

    // The 201 body is the persisted cook, carrying the identity userId.
    expect(res.status).toBe(201);
    const persisted = res.jsonBody as Cook;
    expect(persisted.userId).toBe(PRINCIPAL_USER_ID);
    expect(persisted.id).toBe(writes[0].id);

    // Emitted only after the write, scoped to the DEVICE group (=deviceId), a
    // different axis from the persisted identity userId.
    const msgs = messages();
    expect(msgs).toHaveLength(1);
    const [msg] = msgs!;
    expect(msg.target).toBe('cook_started');
    expect(msg.userId).toBe(validBody.deviceId);
    expect(msg.userId).not.toBe(PRINCIPAL_USER_ID);

    const envelope = msg.arguments[0];
    expect(envelope.type).toBe('cook_started');
    expect(envelope.deviceId).toBe(validBody.deviceId);
    expect(envelope.cookId).toBe(envelope.payload.id);
    expect(envelope.payload.id).toBe(persisted.id);
  });

  it('never persists or returns the retired user-1 tenant', async () => {
    const { ctx, messages } = mockContext();
    const { deps, writes } = authedDeps();

    const res = await startCookHandler(mockRequest(validBody), ctx, deps);

    expect(writes[0].userId).not.toBe('user-1');
    expect((res.jsonBody as Cook).userId).not.toBe('user-1');
    expect(JSON.stringify(res.jsonBody)).not.toContain('user-1');
    expect(JSON.stringify(messages())).not.toContain('user-1');
  });

  it('returns 401 with no write and no SignalR emit when unauthenticated', async () => {
    const { ctx, messages } = mockContext();
    const repo = fakeRepository();
    const deps: StartCookDeps = {
      resolvePrincipal: (): PrincipalResult => ({
        authenticated: false,
        reason: 'principal_header_missing',
      }),
      getRepository: () => repo,
    };

    const res = await startCookHandler(mockRequest(validBody), ctx, deps);

    expect(res.status).toBe(401);
    expect((res.jsonBody as { error: string }).error).toBe('UNAUTHENTICATED');
    expect(repo.writes).toHaveLength(0);
    expect(messages()).toBeUndefined();
  });

  it('returns a sanitized 5xx with no SignalR emit when the repository fails', async () => {
    const { ctx, messages } = mockContext();
    const deps: StartCookDeps = {
      resolvePrincipal: (): PrincipalResult => ({
        authenticated: true,
        principal: {
          userId: PRINCIPAL_USER_ID,
          objectId: 'oid-123',
          tenantId: 'tenant-abc',
        },
      }),
      getRepository: () => ({
        createCook: async () => {
          // A Cosmos-style error whose message carries an account endpoint — it
          // must NOT surface in the response body.
          throw Object.assign(new Error('request to https://acct.documents.azure.com failed'), {
            code: 503,
          });
        },
      }),
    };

    const res = await startCookHandler(mockRequest(validBody), ctx, deps);

    expect(res.status).toBe(500);
    const body = res.jsonBody as { error: string; message: string };
    expect(body.error).toBe('INTERNAL_SERVER_ERROR');
    // Sanitized: no account/endpoint text leaks into the response.
    expect(JSON.stringify(res.jsonBody)).not.toContain('documents.azure.com');
    // Write failed before the emit — no envelope was set.
    expect(messages()).toBeUndefined();
  });

  it('emits COOK_STARTED only after the write, using the persisted document', async () => {
    const { ctx, messages } = mockContext();
    // Repository does NOT echo the resource, so the handler falls back to the
    // in-memory cook — the emitted payload must still be internally consistent.
    const { deps } = authedDeps(fakeRepository({ echoResource: false }));

    const res = await startCookHandler(mockRequest(validBody), ctx, deps);

    expect(res.status).toBe(201);
    const msgs = messages();
    expect(msgs).toHaveLength(1);
    expect(msgs![0].arguments[0].payload.id).toBe((res.jsonBody as Cook).id);
    expect(msgs![0].arguments[0].payload.userId).toBe(PRINCIPAL_USER_ID);
  });

  it('propagates the X-Request-ID header as the correlation id when present', async () => {
    const { ctx, messages } = mockContext();
    const { deps } = authedDeps();

    await startCookHandler(mockRequest(validBody, 'req-abc'), ctx, deps);

    expect(messages()![0].arguments[0].correlation.id).toBe('req-abc');
  });

  it('falls back to the invocation id for correlation when no X-Request-ID header is present', async () => {
    const { ctx, messages } = mockContext();
    const { deps } = authedDeps();

    await startCookHandler(mockRequest(validBody), ctx, deps);

    expect(messages()![0].arguments[0].correlation.id).toBe(INVOCATION_ID);
  });

  it.each([
    ['name', { deviceId: 'meatgeek3', meatType: 'brisket' }],
    ['deviceId', { name: 'x', meatType: 'brisket' }],
    ['meatType', { name: 'x', deviceId: 'meatgeek3' }],
  ])(
    'returns 400 with no write and no SignalR message when %s is missing',
    async (_field, body) => {
      const { ctx, messages } = mockContext();
      const { deps, writes } = authedDeps();

      const res = await startCookHandler(mockRequest(body), ctx, deps);

      expect(res.status).toBe(400);
      expect(writes).toHaveLength(0);
      expect(messages()).toBeUndefined();
    }
  );

  it('returns 400 with no write when name is whitespace-only', async () => {
    const { ctx, messages } = mockContext();
    const { deps, writes } = authedDeps();

    const res = await startCookHandler(
      mockRequest({ name: '   ', deviceId: 'meatgeek3', meatType: 'brisket' }),
      ctx,
      deps
    );

    expect(res.status).toBe(400);
    expect((res.jsonBody as { error: string }).error).toBe('VALIDATION_ERROR');
    expect(writes).toHaveLength(0);
    expect(messages()).toBeUndefined();
  });

  it('stores the trimmed name in the 201 body when name has surrounding whitespace', async () => {
    const { ctx } = mockContext();
    const { deps, writes } = authedDeps();

    const res = await startCookHandler(
      mockRequest({ name: '  Weekend Brisket  ', deviceId: 'meatgeek3', meatType: 'brisket' }),
      ctx,
      deps
    );

    expect(res.status).toBe(201);
    expect((res.jsonBody as Cook).name).toBe('Weekend Brisket');
    expect(writes[0].name).toBe('Weekend Brisket');
  });
});
