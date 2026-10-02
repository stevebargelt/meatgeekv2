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
 *   - a Cosmos failure is a sanitized 5xx with no emit;
 *   - COOK_STOPPED is emitted ONLY after a successful update, scoped to
 *     userId = the persisted deviceId.
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
  stopCook: (
    userId: string,
    id: string,
    endTime: string
  ) => Promise<{ cook: Cook | undefined; requestCharge: number; transitioned: boolean }>;
}

/**
 * A fake repository. `behavior` decides the outcome (a persisted stopped cook, a
 * miss, or a throw) while `calls` records the exact addressing the handler used.
 */
function fakeRepository(
  behavior: (
    userId: string,
    id: string,
    endTime: string
  ) => { cook: Cook | undefined; requestCharge: number; transitioned: boolean }
): RepoSpy {
  const calls: RepoSpy['calls'] = [];
  return {
    calls,
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

    // COOK_STOPPED emitted AFTER the write, scoped to the persisted deviceId.
    const msgs = messages();
    expect(msgs).toHaveLength(1);
    const [msg] = msgs!;
    expect(msg.target).toBe('cook_stopped');
    expect(msg.userId).toBe('meatgeek3');
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
    const repo = fakeRepository(() => ({
      cook: undefined,
      requestCharge: 1.2,
      transitioned: false,
    }));

    const res = await stopCookHandler(mockRequest('cook-missing'), ctx, {
      resolvePrincipal: authenticatedAs(AUTH_USER_ID),
      getRepository: () => repo,
    });

    expect(res.status).toBe(404);
    // The read WAS attempted, addressed to the caller's partition...
    expect(repo.calls).toHaveLength(1);
    expect(repo.calls[0].userId).toBe(AUTH_USER_ID);
    // ...but no SignalR message was emitted.
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
      { resolvePrincipal: principalFromRequest, getRepository: () => repo }
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
});
