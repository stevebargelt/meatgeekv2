/**
 * #244 — GET, POST /users/me/push-tokens and DELETE
 * /users/me/push-tokens/{tokenId}, at the HTTP handler, over the real
 * PushTokensRepository on an in-memory /id-partitioned container. Principals
 * are real base64 X-MS-CLIENT-PRINCIPAL headers read by the real principal.ts.
 */
import { createHash } from 'node:crypto';

import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { principalFromRequest } from '../../shared/auth/principal';
import { FakeDevicesContainer } from '../../shared/cosmos/fake-devices-container.testing';
import {
  MAX_PUSH_TOKENS_PER_USER,
  pushTokenId,
  PushTokensRepository,
} from '../../shared/cosmos/push-tokens-repository';
import {
  deletePushTokenHandler,
  listPushTokensHandler,
  registerPushTokenHandler,
  type PushTokensHandlerDeps,
} from './push-tokens';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const OTHER_OID = 'oid-zzzz-9999';
const USER_ID = `${TID}:${OID}`;
const TOKEN = 'ab'.repeat(32);
const OTHER_TOKEN = 'cd'.repeat(32);

function encodedPrincipal(oid: string): string {
  const payload = {
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
      { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: TID },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function request(
  options: {
    oid?: string | null;
    body?: unknown;
    rawBody?: string;
    params?: Record<string, string>;
  } = {}
): HttpRequest {
  const headers = new Map<string, string>();
  if (options.oid !== null) {
    headers.set('x-ms-client-principal', encodedPrincipal(options.oid ?? OID));
  }
  return {
    json: async () => (options.rawBody !== undefined ? JSON.parse(options.rawBody) : options.body),
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: { get: () => null },
    params: options.params ?? {},
  } as unknown as HttpRequest;
}

function context(): InvocationContext & { logs: string[] } {
  const logs: string[] = [];
  const write = (...args: unknown[]) => logs.push(args.map(String).join(' '));
  return {
    invocationId: 'inv-1',
    log: write,
    warn: write,
    error: write,
    logs,
  } as unknown as InvocationContext & { logs: string[] };
}

class World {
  readonly container = new FakeDevicesContainer();
  now = new Date('2026-11-27T10:00:00.000Z');
  readonly repository = new PushTokensRepository(this.container.asContainer(), () => this.now);
  readonly deps: PushTokensHandlerDeps = {
    resolvePrincipal: principalFromRequest,
    getRepository: () => this.repository,
  };
  readonly logs: string[] = [];

  private async run(
    handler: typeof listPushTokensHandler,
    req: HttpRequest
  ): Promise<HttpResponseInit> {
    const ctx = context();
    const response = await handler(req, ctx, this.deps);
    this.logs.push(...ctx.logs);
    return response;
  }

  register(token: unknown, oid?: string) {
    return this.run(registerPushTokenHandler, request({ body: { token }, oid }));
  }
  list(oid?: string) {
    return this.run(listPushTokensHandler, request({ oid }));
  }
  remove(tokenId: string, oid?: string) {
    return this.run(deletePushTokenHandler, request({ params: { tokenId }, oid }));
  }
}

describe('POST /users/me/push-tokens', () => {
  it('registers a token for the signed-in user: 201 with its id, never the token', async () => {
    const w = new World();

    const response = await w.register(TOKEN);

    expect(response.status).toBe(201);
    expect(response.jsonBody).toEqual({
      id: pushTokenId(TOKEN),
      registeredAt: '2026-11-27T10:00:00.000Z',
    });
    expect(JSON.stringify(response)).not.toContain(TOKEN);
    expect((await w.list()).jsonBody).toEqual({
      items: [{ id: pushTokenId(TOKEN), registeredAt: '2026-11-27T10:00:00.000Z' }],
    });
  });

  it('the id is the SHA-256 of the token in hex, whatever its case', async () => {
    const w = new World();
    const response = await w.register(TOKEN.toUpperCase());
    expect((response.jsonBody as { id: string }).id).toBe(
      createHash('sha256').update(TOKEN).digest('hex')
    );
  });

  it('registering a token again is 200 and moves its time, with no duplicate', async () => {
    const w = new World();
    await w.register(TOKEN);
    w.now = new Date('2026-11-28T10:00:00.000Z');

    const response = await w.register(TOKEN);

    expect(response.status).toBe(200);
    expect((await w.list()).jsonBody).toEqual({
      items: [{ id: pushTokenId(TOKEN), registeredAt: '2026-11-28T10:00:00.000Z' }],
    });
  });

  it(`keeps at most ${MAX_PUSH_TOKENS_PER_USER} phones, dropping the least recently registered`, async () => {
    const w = new World();
    const tokens = Array.from({ length: MAX_PUSH_TOKENS_PER_USER + 1 }, (_, i) =>
      i.toString(16).padStart(2, '0').repeat(32)
    );
    for (const [i, token] of tokens.entries()) {
      w.now = new Date(Date.UTC(2026, 10, 27, 10, i));
      await w.register(token);
    }

    const ids = ((await w.list()).jsonBody as { items: Array<{ id: string }> }).items.map(
      t => t.id
    );
    expect(ids).toHaveLength(MAX_PUSH_TOKENS_PER_USER);
    expect(ids).not.toContain(pushTokenId(tokens[0]));
    expect(ids).toContain(pushTokenId(tokens[MAX_PUSH_TOKENS_PER_USER]));
  });

  it.each([
    ['not hex', 'zz'.repeat(32)],
    ['too short', 'ab'.repeat(10)],
    ['not a string', 42],
    ['missing', undefined],
  ])('refuses a token that is %s with 400 VALIDATION_ERROR', async (_why, token) => {
    const w = new World();
    const response = await w.register(token);
    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect(w.container.calls).toHaveLength(0);
  });

  it('refuses a body that is not JSON, not an object, or carries another field', async () => {
    const w = new World();
    const deps = w.deps;
    for (const req of [
      request({ rawBody: '{' }),
      request({ body: [TOKEN] }),
      request({ body: { token: TOKEN, userId: 'someone' } }),
    ]) {
      const response = await registerPushTokenHandler(req, context(), deps);
      expect(response.status).toBe(400);
    }
    expect(w.container.calls).toHaveLength(0);
  });

  it('answers 401 with no principal, before any store call', async () => {
    const w = new World();
    const response = await w.register(TOKEN, null as unknown as string);
    expect(response.status).toBe(401);
    expect(w.container.calls).toHaveLength(0);
  });

  it('answers a sanitized 500 when the store fails', async () => {
    const w = new World();
    w.container.failNext('read', 503);
    const response = await w.register(TOKEN);
    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
    expect(JSON.stringify(response)).not.toMatch(/documents\.azure\.com/);
  });

  it('retries a write another phone made in between', async () => {
    const w = new World();
    await w.register(TOKEN);
    let touched = false;
    w.container.beforeReplace = id => {
      if (!touched) {
        touched = true;
        w.container.touch(id);
      }
    };

    const response = await w.register(OTHER_TOKEN);

    expect(response.status).toBe(201);
    expect(((await w.list()).jsonBody as { items: unknown[] }).items).toHaveLength(2);
  });
});

describe('GET /users/me/push-tokens', () => {
  it('is an empty list for a user with no phones', async () => {
    const w = new World();
    const response = await w.list();
    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ items: [] });
  });

  it("lists only the caller's own phones", async () => {
    const w = new World();
    await w.register(TOKEN);
    await w.register(OTHER_TOKEN, OTHER_OID);

    expect((await w.list()).jsonBody).toEqual({
      items: [{ id: pushTokenId(TOKEN), registeredAt: expect.any(String) }],
    });
    expect(w.container.stored(`push-tokens:${USER_ID}`)).toBeDefined();
  });
});

describe('DELETE /users/me/push-tokens/{tokenId}', () => {
  it('removes the phone: 204, and it is gone', async () => {
    const w = new World();
    await w.register(TOKEN);
    await w.register(OTHER_TOKEN);

    const response = await w.remove(pushTokenId(TOKEN));

    expect(response.status).toBe(204);
    expect((await w.list()).jsonBody).toEqual({
      items: [{ id: pushTokenId(OTHER_TOKEN), registeredAt: expect.any(String) }],
    });
  });

  it('is 204 for a phone that is not registered, and removes nothing of another user', async () => {
    const w = new World();
    await w.register(TOKEN, OTHER_OID);

    const response = await w.remove(pushTokenId(TOKEN));

    expect(response.status).toBe(204);
    expect(((await w.list(OTHER_OID)).jsonBody as { items: unknown[] }).items).toHaveLength(1);
  });

  it('refuses an id that is not a SHA-256 in hex, such as the token itself', async () => {
    const w = new World();
    for (const id of [TOKEN + 'ab', 'nope', 'AB'.repeat(32)]) {
      const response = await w.remove(id);
      expect(response.status).toBe(400);
    }
    expect(w.container.calls).toHaveLength(0);
  });
});

it('never writes a push token to a log', async () => {
  const w = new World();
  await w.register(TOKEN);
  await w.register('zz' + TOKEN.slice(2));
  await w.list();
  await w.remove(pushTokenId(TOKEN));
  expect(w.logs.length).toBeGreaterThan(0);
  expect(w.logs.join('\n')).not.toMatch(/abab|zzab/);
});
