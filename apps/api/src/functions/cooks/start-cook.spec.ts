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
import type { StartCookResult } from '../../shared/cosmos/cooks-repository';
import type { PrincipalResult } from '../../shared/auth/principal';
import type { DeviceOwnership } from '../../shared/cosmos/devices-repository';

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
let DeviceTwinSyncErrorClass: typeof import('../../shared/iothub/device-twin-sync').DeviceTwinSyncError;

beforeAll(() => {
  jest.resetModules();
  for (const [key, value] of Object.entries(VALID_ENV)) {
    process.env[key] = value;
  }
  startCookHandler = (require('./start-cook') as typeof import('./start-cook')).startCookHandler;
  signalROutput = (require('../signalr/envelope') as typeof import('../signalr/envelope'))
    .signalROutput;
  DeviceTwinSyncErrorClass = (
    require('../../shared/iothub/device-twin-sync') as typeof import('../../shared/iothub/device-twin-sync')
  ).DeviceTwinSyncError;
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
 * An in-memory model of CooksRepository.startCook: it records every write and
 * answers like the real batch does — a known id is a replay, a device held by a
 * non-terminal cook is busy, otherwise the cook is created and takes the device.
 * `echoResource` toggles whether the store echoes the stored resource or the
 * handler falls back to its own copy (the repository's `stored ?? cook`).
 */
function fakeRepository(opts: { echoResource?: boolean } = {}) {
  const echoResource = opts.echoResource ?? true;
  const writes: Cook[] = [];
  const stored = new Map<string, Cook>();
  const deviceHolder = new Map<string, string>();
  return {
    writes,
    stored,
    /** Model a stop: the cook completes and its device is released. */
    complete(id: string) {
      const cook = stored.get(id)!;
      stored.set(id, { ...cook, status: 'completed' });
      deviceHolder.delete(cook.deviceId);
    },
    startCook: async (cook: Cook): Promise<StartCookResult> => {
      const existing = stored.get(cook.id);
      if (existing) {
        return { outcome: 'replayed', cook: { ...existing }, requestCharge: 2 };
      }
      const holder = deviceHolder.get(cook.deviceId);
      if (holder) {
        return { outcome: 'deviceBusy', activeCookId: holder, requestCharge: 3 };
      }
      writes.push(cook);
      stored.set(cook.id, { ...cook });
      deviceHolder.set(cook.deviceId, cook.id);
      return { outcome: 'created', cook: echoResource ? { ...cook } : cook, requestCharge: 7.42 };
    },
  };
}

/** RU the fake ownership read reports, so tests can see it summed into the header. */
const OWNERSHIP_CHARGE = 1;

/**
 * HAR-26: a fake devices ownership read. Every device is `owned` by the caller
 * unless `statuses` says otherwise; `calls` records each read.
 */
function fakeOwnership(statuses: Record<string, 'foreign' | 'unknown'> = {}) {
  const calls: Array<{ userId: string; deviceId: string }> = [];
  return {
    calls,
    getDeviceOwnership: async (userId: string, deviceId: string): Promise<DeviceOwnership> => {
      calls.push({ userId, deviceId });
      const status = statuses[deviceId];
      if (status) {
        return { status, requestCharge: OWNERSHIP_CHARGE };
      }
      return {
        status: 'owned',
        device: { id: deviceId, userId, name: deviceId } as never,
        requestCharge: OWNERSHIP_CHARGE,
      };
    },
  };
}

/** HAR-66: a recorded call to the injected device twin sync. */
interface TwinSyncCall {
  readonly userId: string;
  readonly deviceId: string;
  readonly correlationId: string;
}

/**
 * HAR-66: a fake device twin sync. It records each call; with `failWith` it
 * throws a DeviceTwinSyncError with that reason (from the handler's own module
 * graph, so the handler's instanceof check matches).
 */
function fakeTwinSync(failWith?: string) {
  const calls: TwinSyncCall[] = [];
  return {
    calls,
    sync: async (userId: string, deviceId: string, correlationId: string) => {
      calls.push({ userId, deviceId, correlationId });
      if (failWith !== undefined) {
        throw new DeviceTwinSyncErrorClass(failWith, TWIN_FAILURE_CHARGE);
      }
      return { outcome: 'patched' as const, requestCharge: 0 };
    },
  };
}

/** RU a failing fake sync reports, so tests can see it summed into the header. */
const TWIN_FAILURE_CHARGE = 2;

/** The default for tests that are not about the twin. */
const noTwinSync = fakeTwinSync().sync;

/** Deps that authenticate as PRINCIPAL_USER_ID and capture repository writes. */
function authedDeps(
  repo = fakeRepository(),
  ownership = fakeOwnership()
): {
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
    syncDeviceTwin: noTwinSync,
    getDeviceOwnership: ownership.getDeviceOwnership,
  };
  return { deps, writes: repo.writes };
}

const COOK_ID = '6f1c2b8e-3d4a-4f6b-9c7d-0e1f2a3b4c5d';
const OTHER_COOK_ID = 'a0b1c2d3-e4f5-4a6b-8c7d-8e9f0a1b2c3d';

const validBody: StartCookRequest = {
  id: COOK_ID,
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
    // MG-84: the id is the one the client sent, not a server-minted one.
    expect(persisted.id).toBe(COOK_ID);

    // Emitted only after the write, delivered to the OWNER: the authenticated
    // principal's userId (HAR-57, MG-30), never the deviceId.
    const msgs = messages();
    expect(msgs).toHaveLength(1);
    const [msg] = msgs!;
    expect(msg.target).toBe('cook_started');
    expect(msg.userId).toBe(PRINCIPAL_USER_ID);
    expect(msg.userId).not.toBe(validBody.deviceId);

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
      syncDeviceTwin: noTwinSync,
      getDeviceOwnership: fakeOwnership().getDeviceOwnership,
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
        startCook: async () => {
          // A Cosmos-style error whose message carries an account endpoint — it
          // must NOT surface in the response body.
          throw Object.assign(new Error('request to https://acct.documents.azure.com failed'), {
            code: 503,
          });
        },
      }),
      syncDeviceTwin: noTwinSync,
      getDeviceOwnership: fakeOwnership().getDeviceOwnership,
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
    ['name', { id: COOK_ID, deviceId: 'meatgeek3', meatType: 'brisket' }],
    ['deviceId', { id: COOK_ID, name: 'x', meatType: 'brisket' }],
    ['meatType', { id: COOK_ID, name: 'x', deviceId: 'meatgeek3' }],
    ['id', { name: 'x', deviceId: 'meatgeek3', meatType: 'brisket' }],
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
      mockRequest({ id: COOK_ID, name: '   ', deviceId: 'meatgeek3', meatType: 'brisket' }),
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
      mockRequest({
        id: COOK_ID,
        name: '  Weekend Brisket  ',
        deviceId: 'meatgeek3',
        meatType: 'brisket',
      }),
      ctx,
      deps
    );

    expect(res.status).toBe(201);
    expect((res.jsonBody as Cook).name).toBe('Weekend Brisket');
    expect(writes[0].name).toBe('Weekend Brisket');
  });

  describe('MG-84 — retry-safe start', () => {
    it.each([
      ['not a UUID', 'cook-123'],
      ['empty', ''],
      ['a number', 42],
      ['a device lock id', 'active-device:meatgeek3'],
    ])('returns 400 with no write when id is %s', async (_label, id) => {
      const { ctx, messages } = mockContext();
      const { deps, writes } = authedDeps();

      const res = await startCookHandler(
        mockRequest({ ...validBody, id: id as unknown as string }),
        ctx,
        deps
      );

      expect(res.status).toBe(400);
      expect((res.jsonBody as { error: string }).error).toBe('VALIDATION_ERROR');
      expect(writes).toHaveLength(0);
      expect(messages()).toBeUndefined();
    });

    it('a retry after success returns 200 with the original cook and emits no second COOK_STARTED', async () => {
      const repo = fakeRepository();
      const { deps } = authedDeps(repo);
      const first = mockContext();
      const created = await startCookHandler(mockRequest(validBody), first.ctx, deps);

      const retry = mockContext();
      const replayed = await startCookHandler(mockRequest(validBody), retry.ctx, deps);

      expect(created.status).toBe(201);
      expect(first.messages()).toHaveLength(1);
      expect(replayed.status).toBe(200);
      expect(replayed.jsonBody).toEqual(created.jsonBody);
      expect(retry.messages()).toBeUndefined();
      expect(repo.writes).toHaveLength(1);
    });

    it('a retry with the same body in a different key order is still a replay', async () => {
      const repo = fakeRepository();
      const { deps } = authedDeps(repo);
      const body = { ...validBody, targetTemps: { grill: 225, probe1: 203 } };
      await startCookHandler(mockRequest(body), mockContext().ctx, deps);

      const retry = mockContext();
      const res = await startCookHandler(
        mockRequest({ ...body, targetTemps: { probe1: 203, grill: 225 } }),
        retry.ctx,
        deps
      );

      expect(res.status).toBe(200);
      expect(retry.messages()).toBeUndefined();
    });

    it('a replay of a cook that has since completed returns that cook, not a new one', async () => {
      const repo = fakeRepository();
      const { deps } = authedDeps(repo);
      await startCookHandler(mockRequest(validBody), mockContext().ctx, deps);
      repo.complete(COOK_ID);

      const retry = mockContext();
      const res = await startCookHandler(mockRequest(validBody), retry.ctx, deps);

      expect(res.status).toBe(200);
      expect((res.jsonBody as Cook).status).toBe('completed');
      expect(retry.messages()).toBeUndefined();
      expect(repo.writes).toHaveLength(1);
    });

    it.each([
      ['name', { name: 'Different Brisket' }],
      ['deviceId', { deviceId: 'meatgeek4' }],
      ['meatType', { meatType: 'pork' }],
      ['weight', { weight: 9 }],
      ['targetTemps', { targetTemps: { grill: 250 } }],
      ['notes', { notes: 'changed' }],
    ])(
      'the same id with a different %s returns 422 COOK_ID_REUSED with no write and no emit',
      async (_field, change) => {
        const repo = fakeRepository();
        const { deps } = authedDeps(repo);
        await startCookHandler(mockRequest(validBody), mockContext().ctx, deps);

        const reuse = mockContext();
        const res = await startCookHandler(
          mockRequest({ ...validBody, ...change }),
          reuse.ctx,
          deps
        );

        expect(res.status).toBe(422);
        expect(res.jsonBody).toEqual({
          error: 'COOK_ID_REUSED',
          message: expect.any(String),
          requestId: INVOCATION_ID,
        });
        expect(reuse.messages()).toBeUndefined();
        expect(repo.writes).toHaveLength(1);
      }
    );

    it('distinct ids on different devices create distinct cooks, each announced once', async () => {
      const repo = fakeRepository();
      const { deps } = authedDeps(repo);
      const first = mockContext();
      const second = mockContext();

      const a = await startCookHandler(mockRequest(validBody), first.ctx, deps);
      const b = await startCookHandler(
        mockRequest({ ...validBody, id: OTHER_COOK_ID, deviceId: 'meatgeek4' }),
        second.ctx,
        deps
      );

      expect([a.status, b.status]).toEqual([201, 201]);
      expect((a.jsonBody as Cook).id).toBe(COOK_ID);
      expect((b.jsonBody as Cook).id).toBe(OTHER_COOK_ID);
      expect(repo.writes.map(cook => cook.id)).toEqual([COOK_ID, OTHER_COOK_ID]);
      expect(first.messages()).toHaveLength(1);
      expect(second.messages()).toHaveLength(1);
    });

    it('a second cook on a busy device returns 409 COOK_ALREADY_ACTIVE with the active cook id, no write, no emit', async () => {
      const repo = fakeRepository();
      const { deps } = authedDeps(repo);
      await startCookHandler(mockRequest(validBody), mockContext().ctx, deps);

      const busy = mockContext();
      const res = await startCookHandler(
        mockRequest({ ...validBody, id: OTHER_COOK_ID }),
        busy.ctx,
        deps
      );

      expect(res.status).toBe(409);
      expect(res.jsonBody).toEqual({
        error: 'COOK_ALREADY_ACTIVE',
        message: expect.any(String),
        requestId: INVOCATION_ID,
        activeCookId: COOK_ID,
      });
      expect(busy.messages()).toBeUndefined();
      expect(repo.writes).toHaveLength(1);
    });

    it('once the active cook is stopped, a new cook on the same device is created', async () => {
      const repo = fakeRepository();
      const { deps } = authedDeps(repo);
      await startCookHandler(mockRequest(validBody), mockContext().ctx, deps);
      repo.complete(COOK_ID);

      const next = mockContext();
      const res = await startCookHandler(
        mockRequest({ ...validBody, id: OTHER_COOK_ID }),
        next.ctx,
        deps
      );

      expect(res.status).toBe(201);
      expect(next.messages()).toHaveLength(1);
    });
  });

  describe('HAR-26 — only the device owner can start a cook (MG-88, MG-83)', () => {
    it('owned device: reads ownership for the caller and device, writes the cook, returns 201', async () => {
      const repo = fakeRepository();
      const ownership = fakeOwnership();
      const { deps } = authedDeps(repo, ownership);
      const { ctx, messages } = mockContext();

      const res = await startCookHandler(mockRequest(validBody), ctx, deps);

      expect(res.status).toBe(201);
      expect(ownership.calls).toEqual([{ userId: PRINCIPAL_USER_ID, deviceId: 'meatgeek3' }]);
      expect(repo.writes).toHaveLength(1);
      expect(messages()).toHaveLength(1);
    });

    it.each(['foreign', 'unknown'] as const)(
      '%s device: 403 DEVICE_NOT_OWNED, no startCook call, no SignalR output',
      async status => {
        const startCook = jest.fn();
        const { deps } = authedDeps(fakeRepository(), fakeOwnership({ meatgeek3: status }));
        const { ctx, messages } = mockContext();

        const res = await startCookHandler(mockRequest(validBody), ctx, {
          ...deps,
          getRepository: () => ({ startCook }),
        });

        expect(res.status).toBe(403);
        expect(res.jsonBody).toEqual({
          error: 'DEVICE_NOT_OWNED',
          message: 'The device is not registered to the caller.',
          requestId: INVOCATION_ID,
        });
        expect(startCook).not.toHaveBeenCalled();
        expect(messages()).toBeUndefined();
      }
    );

    it('foreign and unknown devices get byte-identical responses', async () => {
      const foreign = await startCookHandler(
        mockRequest(validBody),
        mockContext().ctx,
        authedDeps(fakeRepository(), fakeOwnership({ meatgeek3: 'foreign' })).deps
      );
      const unknown = await startCookHandler(
        mockRequest(validBody),
        mockContext().ctx,
        authedDeps(fakeRepository(), fakeOwnership({ meatgeek3: 'unknown' })).deps
      );
      expect(JSON.stringify(foreign)).toBe(JSON.stringify(unknown));
    });

    it('missing principal: 401 before any ownership read', async () => {
      const ownership = fakeOwnership();
      const res = await startCookHandler(mockRequest(validBody), mockContext().ctx, {
        ...authedDeps(fakeRepository(), ownership).deps,
        resolvePrincipal: (): PrincipalResult => ({
          authenticated: false,
          reason: 'principal_header_missing',
        }),
      });
      expect(res.status).toBe(401);
      expect(ownership.calls).toHaveLength(0);
    });

    it('invalid body: 400 before any ownership read', async () => {
      const ownership = fakeOwnership();
      const res = await startCookHandler(
        mockRequest({ ...validBody, meatType: undefined }),
        mockContext().ctx,
        authedDeps(fakeRepository(), ownership).deps
      );
      expect(res.status).toBe(400);
      expect(ownership.calls).toHaveLength(0);
    });

    it('ownership read failure: sanitized 500, no write, no SignalR output', async () => {
      const repo = fakeRepository();
      const { ctx, messages } = mockContext();
      const res = await startCookHandler(mockRequest(validBody), ctx, {
        ...authedDeps(repo).deps,
        syncDeviceTwin: noTwinSync,
        getDeviceOwnership: async () => {
          throw Object.assign(new Error('request to https://acct.documents.azure.com failed'), {
            code: 503,
          });
        },
      });

      expect(res.status).toBe(500);
      expect(res.jsonBody).toEqual({
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to start cook',
        requestId: INVOCATION_ID,
      });
      expect(JSON.stringify(res)).not.toContain('documents.azure.com');
      expect(repo.writes).toHaveLength(0);
      expect(messages()).toBeUndefined();
    });

    it('a second cook on an owned busy device is still 409 (MG-84 unchanged)', async () => {
      const repo = fakeRepository();
      const { deps } = authedDeps(repo);
      await startCookHandler(mockRequest(validBody), mockContext().ctx, deps);
      const res = await startCookHandler(
        mockRequest({ ...validBody, id: OTHER_COOK_ID }),
        mockContext().ctx,
        deps
      );
      expect(res.status).toBe(409);
    });
  });

  describe('HAR-11 — x-meatgeek-request-charge header', () => {
    function chargeHeader(res: { headers?: unknown }): string | undefined {
      return (res.headers as Record<string, string> | undefined)?.['x-meatgeek-request-charge'];
    }

    function failingDeps(error: unknown): StartCookDeps {
      return {
        ...authedDeps().deps,
        getRepository: () => ({
          startCook: async () => {
            throw error;
          },
        }),
      };
    }

    it('reports the RU charge on a 201 create', async () => {
      const { deps } = authedDeps();
      const res = await startCookHandler(mockRequest(validBody), mockContext().ctx, deps);
      expect(res.status).toBe(201);
      // The ownership read (1) plus the create batch (7.42).
      expect(chargeHeader(res)).toBe('8.42');
    });

    it('reports the RU charge on a 200 replay, a 422 id reuse and a 409 busy device', async () => {
      const { deps } = authedDeps();
      await startCookHandler(mockRequest(validBody), mockContext().ctx, deps);

      const replay = await startCookHandler(mockRequest(validBody), mockContext().ctx, deps);
      const reuse = await startCookHandler(
        mockRequest({ ...validBody, name: 'Different' }),
        mockContext().ctx,
        deps
      );
      const busy = await startCookHandler(
        mockRequest({ ...validBody, id: OTHER_COOK_ID }),
        mockContext().ctx,
        deps
      );

      expect([replay.status, reuse.status, busy.status]).toEqual([200, 422, 409]);
      // Each adds the ownership read (1) to the repository's charge.
      expect(chargeHeader(replay)).toBe('3');
      expect(chargeHeader(reuse)).toBe('3');
      expect(chargeHeader(busy)).toBe('4');
    });

    it('reports the ownership read plus the charge a failing Cosmos call carried on the 500', async () => {
      const cosmosError = Object.assign(new Error('https://acct.documents.azure.com throttled'), {
        code: 429,
        requestCharge: 1.5,
      });
      const res = await startCookHandler(
        mockRequest(validBody),
        mockContext().ctx,
        failingDeps(cosmosError)
      );
      expect(res.status).toBe(500);
      expect(chargeHeader(res)).toBe('2.5');
    });

    it('reports only the ownership read on a 500 whose error reports no charge', async () => {
      const res = await startCookHandler(
        mockRequest(validBody),
        mockContext().ctx,
        failingDeps(new Error('config missing'))
      );
      expect(res.status).toBe(500);
      expect(chargeHeader(res)).toBe('1');
    });

    it('omits the header on a 500 when the ownership read fails without a charge', async () => {
      const res = await startCookHandler(mockRequest(validBody), mockContext().ctx, {
        ...authedDeps().deps,
        syncDeviceTwin: noTwinSync,
        getDeviceOwnership: async () => {
          throw new Error('config missing');
        },
      });
      expect(res.status).toBe(500);
      expect(chargeHeader(res)).toBeUndefined();
    });

    it('reports the ownership read on a 403', async () => {
      const { deps } = authedDeps(fakeRepository(), fakeOwnership({ meatgeek3: 'unknown' }));
      const res = await startCookHandler(mockRequest(validBody), mockContext().ctx, deps);
      expect(res.status).toBe(403);
      expect(chargeHeader(res)).toBe('1');
    });

    it('omits the header when no Cosmos call was made (401, 400)', async () => {
      const unauth = await startCookHandler(mockRequest(validBody), mockContext().ctx, {
        ...authedDeps().deps,
        resolvePrincipal: (): PrincipalResult => ({
          authenticated: false,
          reason: 'principal_header_missing',
        }),
      });
      const invalid = await startCookHandler(
        mockRequest({ ...validBody, id: 'not-a-uuid' }),
        mockContext().ctx,
        authedDeps().deps
      );

      expect([unauth.status, invalid.status]).toEqual([401, 400]);
      expect(chargeHeader(unauth)).toBeUndefined();
      expect(chargeHeader(invalid)).toBeUndefined();
    });
  });

  describe('HAR-66 — the device twin is synced after the write', () => {
    function withTwin(twin: ReturnType<typeof fakeTwinSync>, repo = fakeRepository()) {
      const { deps } = authedDeps(repo);
      return { deps: { ...deps, syncDeviceTwin: twin.sync }, repo };
    }

    it('syncs on 201 with the owner, the device and the request correlation id', async () => {
      const twin = fakeTwinSync();
      const { deps } = withTwin(twin);

      const res = await startCookHandler(
        mockRequest(validBody, 'req-start-1'),
        mockContext().ctx,
        deps
      );

      expect(res.status).toBe(201);
      expect(twin.calls).toEqual([
        { userId: PRINCIPAL_USER_ID, deviceId: 'meatgeek3', correlationId: 'req-start-1' },
      ]);
    });

    it('falls back to the invocation id as the correlation id', async () => {
      const twin = fakeTwinSync();
      await startCookHandler(mockRequest(validBody), mockContext().ctx, withTwin(twin).deps);
      expect(twin.calls[0].correlationId).toBe(INVOCATION_ID);
    });

    it('syncs on a matching replay (200), and emits nothing', async () => {
      const twin = fakeTwinSync();
      const { deps } = withTwin(twin);
      await startCookHandler(mockRequest(validBody), mockContext().ctx, deps);

      const { ctx, messages } = mockContext();
      const replay = await startCookHandler(mockRequest(validBody, 'req-retry'), ctx, deps);

      expect(replay.status).toBe(200);
      expect(messages()).toBeUndefined();
      expect(twin.calls).toHaveLength(2);
      expect(twin.calls[1]).toEqual({
        userId: PRINCIPAL_USER_ID,
        deviceId: 'meatgeek3',
        correlationId: 'req-retry',
      });
    });

    it('makes no twin call on 409 COOK_ALREADY_ACTIVE', async () => {
      const repo = fakeRepository();
      const first = fakeTwinSync();
      await startCookHandler(mockRequest(validBody), mockContext().ctx, withTwin(first, repo).deps);

      const twin = fakeTwinSync();
      const res = await startCookHandler(
        mockRequest({ ...validBody, id: OTHER_COOK_ID }),
        mockContext().ctx,
        withTwin(twin, repo).deps
      );

      expect(res.status).toBe(409);
      expect(twin.calls).toEqual([]);
    });

    it('makes no twin call on 422 COOK_ID_REUSED', async () => {
      const repo = fakeRepository();
      await startCookHandler(
        mockRequest(validBody),
        mockContext().ctx,
        withTwin(fakeTwinSync(), repo).deps
      );

      const twin = fakeTwinSync();
      const res = await startCookHandler(
        mockRequest({ ...validBody, name: 'A different cook' }),
        mockContext().ctx,
        withTwin(twin, repo).deps
      );

      expect(res.status).toBe(422);
      expect(twin.calls).toEqual([]);
    });

    it('makes no twin call on 401', async () => {
      const twin = fakeTwinSync();
      const res = await startCookHandler(mockRequest(validBody), mockContext().ctx, {
        ...withTwin(twin).deps,
        resolvePrincipal: (): PrincipalResult => ({
          authenticated: false,
          reason: 'principal_header_missing',
        }),
      });
      expect(res.status).toBe(401);
      expect(twin.calls).toEqual([]);
    });

    it.each(['foreign', 'unknown'] as const)(
      'makes no twin call on 403 (%s device)',
      async status => {
        const twin = fakeTwinSync();
        const { deps } = authedDeps(fakeRepository(), fakeOwnership({ meatgeek3: status }));
        const res = await startCookHandler(mockRequest(validBody), mockContext().ctx, {
          ...deps,
          syncDeviceTwin: twin.sync,
        });
        expect(res.status).toBe(403);
        expect(twin.calls).toEqual([]);
      }
    );

    it('makes no twin call when the Cosmos write fails', async () => {
      const twin = fakeTwinSync();
      const res = await startCookHandler(mockRequest(validBody), mockContext().ctx, {
        ...withTwin(twin).deps,
        getRepository: () => ({
          startCook: async () => {
            throw Object.assign(new Error('cosmos down'), { statusCode: 503 });
          },
        }),
      });
      expect(res.status).toBe(500);
      expect(twin.calls).toEqual([]);
    });

    it('a sync failure on 201 answers 503 with the cook persisted and cook_started still set', async () => {
      const repo = fakeRepository();
      const twin = fakeTwinSync('iothub_patch_twin_status_403');
      const { ctx, messages } = mockContext();

      const res = await startCookHandler(mockRequest(validBody), ctx, withTwin(twin, repo).deps);

      expect(res.status).toBe(503);
      expect(res.jsonBody).toEqual({
        error: 'DEVICE_TWIN_UPDATE_FAILED',
        message: expect.any(String),
        cookId: COOK_ID,
        reason: 'iothub_patch_twin_status_403',
        requestId: INVOCATION_ID,
      });
      expect(repo.stored.get(COOK_ID)?.status).toBe('active');
      expect(messages()).toHaveLength(1);
      expect(messages()![0].target).toBe('cook_started');
      // RU: ownership read + the write + what the sync spent before failing.
      const headers = res.headers as Record<string, string>;
      expect(headers['x-meatgeek-request-charge']).toBe(String(1 + 7.42 + TWIN_FAILURE_CHARGE));
      expect(headers['X-Request-ID']).toBe(INVOCATION_ID);
    });

    it('a retry of the same request after a failed sync replays and heals the twin', async () => {
      const repo = fakeRepository();
      const failed = await startCookHandler(
        mockRequest(validBody),
        mockContext().ctx,
        withTwin(fakeTwinSync('iothub_get_twin_failed'), repo).deps
      );
      expect(failed.status).toBe(503);

      const twin = fakeTwinSync();
      const { ctx, messages } = mockContext();
      const retry = await startCookHandler(mockRequest(validBody), ctx, withTwin(twin, repo).deps);

      expect(retry.status).toBe(200);
      expect(twin.calls).toHaveLength(1);
      // The replay does not announce the cook a second time.
      expect(messages()).toBeUndefined();
      expect(repo.writes).toHaveLength(1);
    });

    it('a sync failure on a replay answers 503 and emits nothing', async () => {
      const repo = fakeRepository();
      await startCookHandler(
        mockRequest(validBody),
        mockContext().ctx,
        withTwin(fakeTwinSync(), repo).deps
      );

      const { ctx, messages } = mockContext();
      const res = await startCookHandler(
        mockRequest(validBody),
        ctx,
        withTwin(fakeTwinSync('device_twin_sync_contended'), repo).deps
      );

      expect(res.status).toBe(503);
      expect((res.jsonBody as { reason: string }).reason).toBe('device_twin_sync_contended');
      expect(messages()).toBeUndefined();
    });

    it('an unexpected sync error still answers a sanitized 503', async () => {
      const res = await startCookHandler(mockRequest(validBody), mockContext().ctx, {
        ...authedDeps().deps,
        syncDeviceTwin: async () => {
          throw new Error('https://meatgeek-dev-iothub.azure-devices.net/twins/meatgeek3 failed');
        },
      });
      expect(res.status).toBe(503);
      expect((res.jsonBody as { reason: string }).reason).toBe('device_twin_sync_failed');
      expect(JSON.stringify(res)).not.toContain('azure-devices');
    });
  });
});
