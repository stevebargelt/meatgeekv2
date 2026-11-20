/**
 * MG-59 — stop-cook, tested with NO Azure and NO credentials.
 *
 * The handler read-then-updates the REAL persisted cook. These tests inject a
 * fake repository (recording exactly how it was addressed) and a principal
 * resolver, so the tenancy- and throughput-critical properties hold without ever
 * touching Cosmos or Easy Auth:
 *   - the partition userId is the AUTHENTICATED principal, never 'user-1';
 *   - a stop reads and updates the correctly-addressed document and returns its
 *     REAL persisted final state (no synthetic name/startTime/meatType);
 *   - an unauthenticated request writes nothing and emits nothing;
 *   - a miss in the caller's partition is a 404 with no emit;
 *   - HAR-26: a cook whose device the caller does not own (foreign or unknown)
 *     is a 403 DEVICE_NOT_OWNED with no write and no emit;
 *   - a Cosmos failure is a sanitized 5xx with no emit;
 *   - COOK_STOPPED is emitted ONLY after a successful update, scoped to
 *     userId = the authenticated principal (the owner), never the deviceId.
 * One case drives the REAL principal helper end-to-end from an X-MS-CLIENT-PRINCIPAL
 * header to prove the auth-derived-identity path.
 *
 * The shared adapter is LAZILY initialized: importing stop-cook (transitively the
 * cooks repository and the adapter) resolves no config, constructs no client, and
 * throws nothing — the fail-loud guard fires on first USE inside a handler, and
 * every test here injects a fake repository so that path is never reached. Valid
 * env is still arranged before the handler graph is required as belt-and-suspenders
 * (nothing in these tests depends on it), and the require ordering below is what
 * actually matters: it guarantees the test and the handler resolve the SAME
 * `signalROutput` instance so the emit-identity assertions can match.
 */
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { Cook } from '@meatgeekv2/api-interfaces';
import { readFileSync } from 'fs';
import { join } from 'path';

import type { SignalROutputMessage } from '../signalr/envelope';
import type { HeaderReader, PrincipalResult } from '../../shared/auth/principal';
import type { DeviceOwnership } from '../../shared/cosmos/devices-repository';

type CookMessage = SignalROutputMessage<Cook>;

const INVOCATION_ID = 'inv-99';

const VALID_ENV = {
  COSMOSDB__accountEndpoint: 'https://mgv2-secret-account.documents.azure.com/',
  COSMOSDB_DATABASE_NAME: 'meatgeek-v2-dev-db',
  COSMOSDB_COOKS_CONTAINER_NAME: 'cooks',
};

// The lazy adapter no longer throws at import, so this env is defensive only.
// The load-bearing reason everything is pulled from ONE module graph via require
// (rather than a top-level `import`) is the `signalROutput` instance identity: a
// hoisted import combined with jest.resetModules could hand the test a different
// `signalROutput` instance than the handler emits through, and the emit-identity
// check would never match. Env is set first purely so the ordering reads the same
// as the repository and adapter specs.
for (const [key, value] of Object.entries(VALID_ENV)) {
  process.env[key] = value;
}
const { stopCookHandler } = require('./stop-cook') as typeof import('./stop-cook');
const { signalROutput } = require('../signalr/envelope') as typeof import('../signalr/envelope');
const { principalFromRequest } =
  require('../../shared/auth/principal') as typeof import('../../shared/auth/principal');
const { DeviceTwinSyncError } =
  require('../../shared/iothub/device-twin-sync') as typeof import('../../shared/iothub/device-twin-sync');

// The authenticated principal a valid request resolves to: a tenant-namespaced
// Entra object id, exactly what shared/auth/principal produces. Deliberately not
// 'user-1'.
const AUTH_USER_ID = 'tenant-abc:oid-aaaa';

/** A stored cook as it existed BEFORE the stop — real fields, still active. */
function storedCook(overrides: Partial<Cook> = {}): Cook {
  return {
    id: 'cook-abc',
    userId: AUTH_USER_ID,
    deviceId: 'meatgeek3',
    name: 'Weekend Brisket',
    status: 'active',
    startTime: '2026-08-24T10:00:00.000Z',
    meatType: 'brisket',
    ...overrides,
  };
}

interface RepoSpy {
  readonly calls: Array<{ userId: string; id: string; endTime: string }>;
  readonly getCalls: Array<{ userId: string; id: string }>;
  getCook: (
    userId: string,
    id: string
  ) => Promise<{ cook: Cook | undefined; requestCharge: number }>;
  stopCook: (
    userId: string,
    id: string,
    endTime: string
  ) => Promise<{ cook: Cook | undefined; requestCharge: number; transitioned: boolean }>;
}

/** RU the fake point read of the cook reports. */
const GET_COOK_CHARGE = 1;
/** RU the fake ownership read reports. */
const OWNERSHIP_CHARGE = 1;

/**
 * A fake repository. `getCook` returns `existing` (the stored cook the handler
 * reads to learn its device; `null` is a miss). `behavior` decides the
 * stop's outcome (a persisted stopped cook, or a throw). `calls` and `getCalls`
 * record the exact addressing the handler used.
 */
function fakeRepository(
  behavior: (
    userId: string,
    id: string,
    endTime: string
  ) => { cook: Cook | undefined; requestCharge: number; transitioned: boolean },
  existing: Cook | null = storedCook(),
  getCookCharge = GET_COOK_CHARGE
): RepoSpy {
  const calls: RepoSpy['calls'] = [];
  const getCalls: RepoSpy['getCalls'] = [];
  return {
    calls,
    getCalls,
    getCook: async (userId, id) => {
      getCalls.push({ userId, id });
      return { cook: existing ?? undefined, requestCharge: getCookCharge };
    },
    stopCook: async (userId, id, endTime) => {
      calls.push({ userId, id, endTime });
      return behavior(userId, id, endTime);
    },
  };
}

function authenticatedAs(userId: string): (request: HeaderReader) => PrincipalResult {
  return () => ({
    authenticated: true,
    principal: { userId, objectId: 'oid-aaaa', tenantId: 'tenant-abc' },
  });
}

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

const owned = fakeOwnership().getDeviceOwnership;

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
        throw new DeviceTwinSyncError(failWith, TWIN_FAILURE_CHARGE);
      }
      return { outcome: 'patched' as const, requestCharge: 0 };
    },
  };
}

/** RU a failing fake sync reports, so tests can see it summed into the header. */
const TWIN_FAILURE_CHARGE = 2;

/** The default for tests that are not about the twin. */
const noTwinSync = fakeTwinSync().sync;

const unauthenticated: (request: HeaderReader) => PrincipalResult = () => ({
  authenticated: false,
  reason: 'principal_header_missing',
});

/** A request whose headers come from a case-insensitive map (matches Azure). */
function mockRequest(cookId: string, headers: Record<string, string> = {}): HttpRequest {
  const lower = new Map(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  return {
    json: async () => {
      throw new Error('body should not be read by stop-cook');
    },
    headers: { get: (name: string) => lower.get(name.toLowerCase()) ?? null },
    query: { get: () => null },
    params: { cookId },
  } as unknown as HttpRequest;
}

interface Captured {
  ctx: InvocationContext;
  messages: () => CookMessage[] | undefined;
}

function mockContext(): Captured {
  let captured: CookMessage[] | undefined;
  const ctx = {
    invocationId: INVOCATION_ID,
    log: () => undefined,
    error: () => undefined,
    extraOutputs: {
      set: (output: unknown, value: unknown) => {
        if (output === signalROutput) {
          captured = value as CookMessage[];
        }
      },
    },
  } as unknown as InvocationContext;
  return { ctx, messages: () => captured };
}

describe('stopCookHandler', () => {
  it('reads and updates the correctly-addressed cook and returns its persisted final state', async () => {
    const { ctx, messages } = mockContext();

    // The repository echoes the stop transition it would persist: the stored
    // cook, now completed with the endTime the handler supplied.
    const repo = fakeRepository((userId, id, endTime) => ({
      cook: { ...storedCook(), userId, id, status: 'completed', endTime },
      requestCharge: 4.2,
      transitioned: true,
    }));

    const res = await stopCookHandler(mockRequest('cook-abc'), ctx, {
      resolvePrincipal: authenticatedAs(AUTH_USER_ID),
      getRepository: () => repo,
      syncDeviceTwin: noTwinSync,
      getDeviceOwnership: owned,
    });

    // Addressed by (authenticated userId, cookId) — the partition contract.
    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0].userId).toBe(AUTH_USER_ID);
    expect(repo.calls[0].id).toBe('cook-abc');
    expect(Number.isNaN(Date.parse(repo.calls[0].endTime))).toBe(false);

    expect(res.status).toBe(200);
    const body = res.jsonBody as Cook;
    // The REAL persisted final state — not synthetic placeholders.
    expect(body.status).toBe('completed');
    expect(body.endTime).toBe(repo.calls[0].endTime);
    expect(body.name).toBe('Weekend Brisket');
    expect(body.startTime).toBe('2026-08-24T10:00:00.000Z');
    expect(body.meatType).toBe('brisket');
    expect(body.userId).toBe(AUTH_USER_ID);

    // COOK_STOPPED emitted AFTER the write, delivered to the OWNER: the
    // authenticated principal's userId (HAR-57, MG-30), never the deviceId.
    const msgs = messages();
    expect(msgs).toHaveLength(1);
    const [msg] = msgs!;
    expect(msg.target).toBe('cook_stopped');
    expect(msg.userId).toBe(AUTH_USER_ID);
    expect(msg.userId).not.toBe('meatgeek3');
    expect(msg.arguments[0].deviceId).toBe('meatgeek3');
    const envelope = msg.arguments[0];
    expect(envelope).not.toHaveProperty('cookId');
    expect(envelope.payload.id).toBe('cook-abc');
    expect(envelope.payload.status).toBe('completed');
  });

  it('never uses or persists a fabricated user-1 tenant', async () => {
    const { ctx } = mockContext();
    const repo = fakeRepository((userId, id, endTime) => ({
      cook: { ...storedCook(), userId, id, status: 'completed', endTime },
      requestCharge: 1,
      transitioned: true,
    }));

    const res = await stopCookHandler(mockRequest('cook-abc'), ctx, {
      resolvePrincipal: authenticatedAs(AUTH_USER_ID),
      getRepository: () => repo,
      syncDeviceTwin: noTwinSync,
      getDeviceOwnership: owned,
    });

    expect(repo.calls[0].userId).not.toBe('user-1');
    expect((res.jsonBody as Cook).userId).not.toBe('user-1');
    expect(JSON.stringify(res.jsonBody)).not.toContain('user-1');
  });

  it('returns 200 idempotently but emits NO COOK_STOPPED when the cook was already completed (retried stop)', async () => {
    const { ctx, messages } = mockContext();
    // A retry after a successful stop whose response was lost: the repository
    // finds the cook already completed and performs no write.
    const firstEndTime = '2026-08-24T20:00:00.000Z';
    const repo = fakeRepository(() => ({
      cook: storedCook({ status: 'completed', endTime: firstEndTime }),
      requestCharge: 1,
      transitioned: false,
    }));

    const res = await stopCookHandler(mockRequest('cook-abc'), ctx, {
      resolvePrincipal: authenticatedAs(AUTH_USER_ID),
      getRepository: () => repo,
      syncDeviceTwin: noTwinSync,
      getDeviceOwnership: owned,
    });

    expect(res.status).toBe(200);
    const body = res.jsonBody as Cook;
    expect(body.status).toBe('completed');
    expect(body.endTime).toBe(firstEndTime);
    // No new durable transition → no duplicate downstream notification.
    expect(messages()).toBeUndefined();
  });

  it('returns 401 with no update and no emit when unauthenticated', async () => {
    const { ctx, messages } = mockContext();
    const repo = fakeRepository(() => {
      throw new Error('repository must not be called for an unauthenticated request');
    });

    const res = await stopCookHandler(mockRequest('cook-abc'), ctx, {
      resolvePrincipal: unauthenticated,
      getRepository: () => repo,
      syncDeviceTwin: noTwinSync,
      getDeviceOwnership: owned,
    });

    expect(res.status).toBe(401);
    expect(repo.calls).toHaveLength(0);
    expect(messages()).toBeUndefined();
    // Fixed reason code only — no identity material.
    expect((res.jsonBody as { reason: string }).reason).toBe('principal_header_missing');
  });

  it('returns 404 with no emit when the cook is absent in the caller partition', async () => {
    const { ctx, messages } = mockContext();
    // A miss: the read found nothing in this partition, so nothing is written.
    const repo = fakeRepository(
      () => {
        throw new Error('stopCook must not be called for a missing cook');
      },
      null,
      1.2
    );
    const ownership = fakeOwnership();

    const res = await stopCookHandler(mockRequest('cook-missing'), ctx, {
      resolvePrincipal: authenticatedAs(AUTH_USER_ID),
      getRepository: () => repo,
      syncDeviceTwin: noTwinSync,
      getDeviceOwnership: ownership.getDeviceOwnership,
    });

    expect(res.status).toBe(404);
    // The read WAS attempted, addressed to the caller's partition...
    expect(repo.getCalls).toEqual([{ userId: AUTH_USER_ID, id: 'cook-missing' }]);
    // ...but nothing was written, no device was looked up, and no SignalR
    // message was emitted.
    expect(repo.calls).toHaveLength(0);
    expect(ownership.calls).toHaveLength(0);
    expect(messages()).toBeUndefined();
  });

  it('returns a sanitized 5xx with no emit when the repository fails', async () => {
    const { ctx, messages } = mockContext();
    const repo = fakeRepository(() => {
      // A realistic Cosmos error carrying leaky detail — none of it may surface.
      throw Object.assign(new Error('https://mgv2-secret-account.documents.azure.com forbidden'), {
        statusCode: 403,
      });
    });

    const res = await stopCookHandler(mockRequest('cook-abc'), ctx, {
      resolvePrincipal: authenticatedAs(AUTH_USER_ID),
      getRepository: () => repo,
      syncDeviceTwin: noTwinSync,
      getDeviceOwnership: owned,
    });

    expect(res.status).toBe(500);
    expect(messages()).toBeUndefined();
    const serialized = JSON.stringify(res.jsonBody);
    expect(serialized).not.toContain('documents.azure.com');
    expect(serialized).not.toContain('mgv2-secret-account');
    expect(serialized).not.toContain('403');
  });

  it('derives the partition userId from a real X-MS-CLIENT-PRINCIPAL header (auth path end-to-end)', async () => {
    const { ctx } = mockContext();

    // A real Easy Auth principal: base64 JSON with oid + tid claims. The helper
    // namespaces them as "<tid>:<oid>".
    const principal = {
      claims: [
        {
          typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier',
          val: 'oid-real-123',
        },
        { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: 'tid-real-999' },
      ],
    };
    const header = Buffer.from(JSON.stringify(principal), 'utf8').toString('base64');
    const expectedUserId = 'tid-real-999:oid-real-123';

    const repo = fakeRepository((userId, id, endTime) => ({
      cook: { ...storedCook({ userId }), userId, id, status: 'completed', endTime },
      requestCharge: 2,
      transitioned: true,
    }));

    const res = await stopCookHandler(
      mockRequest('cook-abc', { 'x-ms-client-principal': header }),
      ctx,
      {
        resolvePrincipal: principalFromRequest,
        getRepository: () => repo,
        syncDeviceTwin: noTwinSync,
        getDeviceOwnership: owned,
      }
    );

    expect(res.status).toBe(200);
    // The persisted userId is the tenant-namespaced principal from the header —
    // proving the auth-derived-identity path drives the partition value.
    expect(repo.calls[0].userId).toBe(expectedUserId);
    expect((res.jsonBody as Cook).userId).toBe(expectedUserId);
  });

  it('does not re-declare Cook locally and does not import it from start-cook', () => {
    // Structural guard for contract item 4 (cooks only): the shared Cook contract
    // comes from @meatgeekv2/api-interfaces, not a local copy or the sibling
    // start-cook module.
    const source = readFileSync(join(__dirname, 'stop-cook.ts'), 'utf8');
    expect(source).not.toMatch(/from ['"]\.\/start-cook['"]/);
    expect(source).toMatch(/from ['"]@meatgeekv2\/api-interfaces['"]/);
    // No local `interface Cook` / `type Cook =` re-declaration.
    expect(source).not.toMatch(/\b(interface|type)\s+Cook\b/);
  });

  describe('HAR-26 — only the device owner can stop a cook (MG-83, MG-88)', () => {
    it('owned device: reads the cook, then its device ownership, then stops and emits cook_stopped', async () => {
      const { ctx, messages } = mockContext();
      const repo = fakeRepository((userId, id, endTime) => ({
        cook: { ...storedCook(), userId, id, status: 'completed', endTime },
        requestCharge: 4,
        transitioned: true,
      }));
      const ownership = fakeOwnership();

      const res = await stopCookHandler(mockRequest('cook-abc'), ctx, {
        resolvePrincipal: authenticatedAs(AUTH_USER_ID),
        getRepository: () => repo,
        syncDeviceTwin: noTwinSync,
        getDeviceOwnership: ownership.getDeviceOwnership,
      });

      expect(res.status).toBe(200);
      expect(repo.getCalls).toEqual([{ userId: AUTH_USER_ID, id: 'cook-abc' }]);
      // The device comes from the STORED cook, checked for the caller.
      expect(ownership.calls).toEqual([{ userId: AUTH_USER_ID, deviceId: 'meatgeek3' }]);
      expect(repo.calls).toHaveLength(1);
      expect(messages()).toHaveLength(1);
      expect(messages()![0].target).toBe('cook_stopped');
    });

    it.each(['foreign', 'unknown'] as const)(
      '%s device: 403 DEVICE_NOT_OWNED, no write, no SignalR output',
      async status => {
        const { ctx, messages } = mockContext();
        const repo = fakeRepository(() => {
          throw new Error('stopCook must not be called for a device the caller does not own');
        });

        const res = await stopCookHandler(mockRequest('cook-abc'), ctx, {
          resolvePrincipal: authenticatedAs(AUTH_USER_ID),
          getRepository: () => repo,
          syncDeviceTwin: noTwinSync,
          getDeviceOwnership: fakeOwnership({ meatgeek3: status }).getDeviceOwnership,
        });

        expect(res.status).toBe(403);
        expect(res.jsonBody).toEqual({
          error: 'DEVICE_NOT_OWNED',
          message: 'The device is not registered to the caller.',
          requestId: INVOCATION_ID,
        });
        expect(repo.calls).toHaveLength(0);
        expect(messages()).toBeUndefined();
      }
    );

    it('missing principal: 401 before any read', async () => {
      const repo = fakeRepository(() => {
        throw new Error('stopCook must not be called');
      });
      const ownership = fakeOwnership();
      const res = await stopCookHandler(mockRequest('cook-abc'), mockContext().ctx, {
        resolvePrincipal: unauthenticated,
        getRepository: () => repo,
        syncDeviceTwin: noTwinSync,
        getDeviceOwnership: ownership.getDeviceOwnership,
      });
      expect(res.status).toBe(401);
      expect(repo.getCalls).toHaveLength(0);
      expect(ownership.calls).toHaveLength(0);
      expect(repo.calls).toHaveLength(0);
    });

    it('ownership read failure: sanitized 500, no write, no SignalR output', async () => {
      const { ctx, messages } = mockContext();
      const repo = fakeRepository(() => {
        throw new Error('stopCook must not be called');
      });
      const res = await stopCookHandler(mockRequest('cook-abc'), ctx, {
        resolvePrincipal: authenticatedAs(AUTH_USER_ID),
        getRepository: () => repo,
        syncDeviceTwin: noTwinSync,
        getDeviceOwnership: async () => {
          throw new Error('request to https://mgv2-secret-account.documents.azure.com failed');
        },
      });
      expect(res.status).toBe(500);
      expect(JSON.stringify(res)).not.toContain('documents.azure.com');
      expect(repo.calls).toHaveLength(0);
      expect(messages()).toBeUndefined();
    });
  });

  describe('MG-31 — cook_stopped carries the persisted cook', () => {
    it('emits the stored name and startTime, which appear nowhere in the request', async () => {
      const { ctx, messages } = mockContext();
      // Values only the repository knows. The request carries just the cook id
      // in the path, no body (mockRequest's json() throws), and no other header.
      const persistedName = 'Persisted Pork Shoulder 7f3a';
      const persistedStart = '2026-03-14T05:26:53.000Z';
      const stored = storedCook({
        id: 'cook-mg31',
        name: persistedName,
        startTime: persistedStart,
      });
      const repo = fakeRepository(
        (_userId, _id, endTime) => ({
          cook: { ...stored, status: 'completed', endTime },
          requestCharge: 1,
          transitioned: true,
        }),
        stored
      );
      const request = mockRequest('cook-mg31');

      const res = await stopCookHandler(request, ctx, {
        resolvePrincipal: authenticatedAs(AUTH_USER_ID),
        getRepository: () => repo,
        syncDeviceTwin: noTwinSync,
        getDeviceOwnership: owned,
      });

      expect(res.status).toBe(200);
      expect(JSON.stringify(request)).not.toContain(persistedName);
      expect(JSON.stringify(request)).not.toContain(persistedStart);
      const payload = messages()![0].arguments[0].payload;
      expect(payload.name).toBe(persistedName);
      expect(payload.startTime).toBe(persistedStart);
    });
  });

  describe('HAR-11 — x-meatgeek-request-charge header', () => {
    function chargeHeader(res: { headers?: unknown }): string | undefined {
      return (res.headers as Record<string, string> | undefined)?.['x-meatgeek-request-charge'];
    }

    function stopWith(
      repo: RepoSpy,
      resolvePrincipal = authenticatedAs(AUTH_USER_ID),
      getDeviceOwnership = owned
    ) {
      return stopCookHandler(mockRequest('cook-abc'), mockContext().ctx, {
        resolvePrincipal,
        getRepository: () => repo,
        syncDeviceTwin: noTwinSync,
        getDeviceOwnership,
      });
    }

    it('reports the RU charge on a 200 stop, transitioned or already completed', async () => {
      const stopped = storedCook({ status: 'completed', endTime: '2026-08-24T20:00:00.000Z' });
      const fresh = await stopWith(
        fakeRepository(() => ({ cook: stopped, requestCharge: 11.38, transitioned: true }))
      );
      const repeat = await stopWith(
        fakeRepository(() => ({ cook: stopped, requestCharge: 1, transitioned: false }))
      );

      expect([fresh.status, repeat.status]).toEqual([200, 200]);
      // The cook read (1) and the ownership read (1) plus the stop.
      expect(chargeHeader(fresh)).toBe('13.38');
      expect(chargeHeader(repeat)).toBe('3');
    });

    it('reports the RU charge of the read on a 404 miss', async () => {
      const res = await stopWith(
        fakeRepository(
          () => ({ cook: undefined, requestCharge: 0, transitioned: false }),
          null,
          1.2
        )
      );
      expect(res.status).toBe(404);
      expect(chargeHeader(res)).toBe('1.2');
    });

    it('reports the completed reads plus the charge a failing Cosmos call carried on the 500', async () => {
      const charged = await stopWith(
        fakeRepository(() => {
          throw Object.assign(new Error('precondition failed'), {
            code: 412,
            requestCharge: 2.25,
          });
        })
      );
      const uncharged = await stopWith(
        fakeRepository(() => {
          throw new Error('credential unavailable');
        })
      );

      expect([charged.status, uncharged.status]).toEqual([500, 500]);
      expect(chargeHeader(charged)).toBe('4.25');
      expect(chargeHeader(uncharged)).toBe('2');
    });

    it('omits the header on a 500 when the first read fails without a charge', async () => {
      const repo = fakeRepository(() => ({
        cook: undefined,
        requestCharge: 0,
        transitioned: false,
      }));
      const res = await stopWith({
        ...repo,
        getCook: async () => {
          throw new Error('credential unavailable');
        },
      });
      expect(res.status).toBe(500);
      expect(chargeHeader(res)).toBeUndefined();
    });

    it('reports both reads on a 403', async () => {
      const res = await stopWith(
        fakeRepository(() => {
          throw new Error('stopCook must not be called');
        }),
        authenticatedAs(AUTH_USER_ID),
        fakeOwnership({ meatgeek3: 'foreign' }).getDeviceOwnership
      );
      expect(res.status).toBe(403);
      expect(chargeHeader(res)).toBe('2');
    });

    it('omits the header on a 401, where no Cosmos call was made', async () => {
      const res = await stopWith(
        fakeRepository(() => {
          throw new Error('repository must not be called');
        }),
        unauthenticated
      );
      expect(res.status).toBe(401);
      expect(chargeHeader(res)).toBeUndefined();
    });
  });

  describe('HAR-66 — the device twin is synced after the stop write', () => {
    const completedCook = (endTime: string) =>
      ({ ...storedCook(), id: 'cook-abc', status: 'completed', endTime }) as Cook;
    const transitioning = () =>
      fakeRepository((_userId, _id, endTime) => ({
        cook: completedCook(endTime),
        requestCharge: 4,
        transitioned: true,
      }));
    const alreadyCompleted = () =>
      fakeRepository(() => ({
        cook: completedCook('2026-08-24T20:00:00.000Z'),
        requestCharge: 1,
        transitioned: false,
      }));

    function depsWith(repo: RepoSpy, twin: ReturnType<typeof fakeTwinSync>) {
      return {
        resolvePrincipal: authenticatedAs(AUTH_USER_ID),
        getRepository: () => repo,
        getDeviceOwnership: owned,
        syncDeviceTwin: twin.sync,
      };
    }

    it('syncs after a transitioned stop with the owner, the stored device and the correlation id', async () => {
      const twin = fakeTwinSync();
      const { ctx, messages } = mockContext();

      const res = await stopCookHandler(
        mockRequest('cook-abc', { 'X-Request-ID': 'req-stop-1' }),
        ctx,
        depsWith(transitioning(), twin)
      );

      expect(res.status).toBe(200);
      expect(twin.calls).toEqual([
        { userId: AUTH_USER_ID, deviceId: 'meatgeek3', correlationId: 'req-stop-1' },
      ]);
      expect(messages()).toHaveLength(1);
    });

    it('syncs after an already-completed stop too, so a retried stop heals the twin', async () => {
      const twin = fakeTwinSync();
      const { ctx, messages } = mockContext();

      const res = await stopCookHandler(
        mockRequest('cook-abc'),
        ctx,
        depsWith(alreadyCompleted(), twin)
      );

      expect(res.status).toBe(200);
      expect(twin.calls).toEqual([
        { userId: AUTH_USER_ID, deviceId: 'meatgeek3', correlationId: INVOCATION_ID },
      ]);
      // cook_stopped emission is unchanged: nothing on a non-transition.
      expect(messages()).toBeUndefined();
    });

    it('makes no twin call on 401', async () => {
      const twin = fakeTwinSync();
      const res = await stopCookHandler(mockRequest('cook-abc'), mockContext().ctx, {
        ...depsWith(transitioning(), twin),
        resolvePrincipal: unauthenticated,
      });
      expect(res.status).toBe(401);
      expect(twin.calls).toEqual([]);
    });

    it('makes no twin call on 404', async () => {
      const twin = fakeTwinSync();
      const repo = fakeRepository(
        () => ({ cook: undefined, requestCharge: 1, transitioned: false }),
        null
      );
      const res = await stopCookHandler(
        mockRequest('cook-abc'),
        mockContext().ctx,
        depsWith(repo, twin)
      );
      expect(res.status).toBe(404);
      expect(twin.calls).toEqual([]);
    });

    it.each(['foreign', 'unknown'] as const)(
      'makes no twin call on 403 (%s device)',
      async status => {
        const twin = fakeTwinSync();
        const res = await stopCookHandler(mockRequest('cook-abc'), mockContext().ctx, {
          ...depsWith(transitioning(), twin),
          getDeviceOwnership: fakeOwnership({ meatgeek3: status }).getDeviceOwnership,
        });
        expect(res.status).toBe(403);
        expect(twin.calls).toEqual([]);
      }
    );

    it('makes no twin call when the Cosmos stop write fails', async () => {
      const twin = fakeTwinSync();
      const repo = fakeRepository(() => {
        throw Object.assign(new Error('cosmos down'), { statusCode: 503 });
      });
      const res = await stopCookHandler(
        mockRequest('cook-abc'),
        mockContext().ctx,
        depsWith(repo, twin)
      );
      expect(res.status).toBe(500);
      expect(twin.calls).toEqual([]);
    });

    it('a sync failure answers 503 with the cook completed and cook_stopped still emitted', async () => {
      const repo = transitioning();
      const twin = fakeTwinSync('iothub_get_twin_status_401');
      const { ctx, messages } = mockContext();

      const res = await stopCookHandler(
        mockRequest('cook-abc', { 'X-Request-ID': 'req-stop-2' }),
        ctx,
        depsWith(repo, twin)
      );

      expect(res.status).toBe(503);
      expect(res.jsonBody).toEqual({
        error: 'DEVICE_TWIN_UPDATE_FAILED',
        message: expect.any(String),
        cookId: 'cook-abc',
        reason: 'iothub_get_twin_status_401',
        requestId: INVOCATION_ID,
      });
      // The stop was written before the sync ran.
      expect(repo.calls).toHaveLength(1);
      expect(messages()).toHaveLength(1);
      expect(messages()![0].target).toBe('cook_stopped');
      const headers = res.headers as Record<string, string>;
      expect(headers['X-Request-ID']).toBe('req-stop-2');
      // RU: the cook read + ownership read + the stop + what the sync spent.
      expect(headers['x-meatgeek-request-charge']).toBe(
        String(GET_COOK_CHARGE + OWNERSHIP_CHARGE + 4 + TWIN_FAILURE_CHARGE)
      );
    });

    it('an unexpected sync error still answers a sanitized 503', async () => {
      const res = await stopCookHandler(mockRequest('cook-abc'), mockContext().ctx, {
        ...depsWith(transitioning(), fakeTwinSync()),
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
