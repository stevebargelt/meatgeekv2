/**
 * HAR-57 (MG-30) — POST /negotiate scopes a SignalR connection to the caller.
 * No Azure: the principal is a real Easy Auth header read by the real
 * principal.ts, and SignalR is a recording stub. Since HAR-81 negotiate mints
 * the token and makes no other SignalR call and no Cosmos read.
 */
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { principalFromRequest } from '../../shared/auth/principal';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import {
  SignalRUnavailableError,
  type SignalRManagementPort,
} from '../../shared/signalr/signalr-management';
import { negotiateHandler, type NegotiateDeps } from './negotiate';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const USER_ID = `${TID}:${OID}`;

const SERVICE_HOST = 'meatgeek-dev-signalr.service.signalr.net';
const CLIENT_URL = `https://${SERVICE_HOST}/client/?hub=temperatureHub`;

function encodedPrincipal(oid = OID, tid = TID): string {
  const payload = {
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
      { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: tid },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function request(options: { principal?: string | null; query?: Record<string, string> } = {}) {
  const headers = new Map<string, string>();
  const principal = options.principal === undefined ? encodedPrincipal() : options.principal;
  if (principal !== null) {
    headers.set('x-ms-client-principal', principal);
  }
  const query = new Map(Object.entries(options.query ?? {}));
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: { get: (k: string) => query.get(k) ?? null },
  } as unknown as HttpRequest;
}

function context() {
  const lines: string[] = [];
  const ctx = {
    invocationId: 'inv-neg',
    log: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
    warn: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => lines.push(args.map(String).join(' ')),
  } as unknown as InvocationContext;
  return { ctx, lines };
}

/** Records every SignalR call. `failure` makes the token call throw. */
function signalRStub(failure?: unknown) {
  const calls: string[] = [];
  const port: SignalRManagementPort = {
    async generateClientToken(userId) {
      calls.push(userId);
      if (failure !== undefined) throw failure;
      return { url: CLIENT_URL, accessToken: `token-for:${userId}` };
    },
  };
  return { port, calls };
}

function setup(signalR = signalRStub()) {
  const getSignalR = jest.fn(() => signalR.port);
  const deps: NegotiateDeps = { resolvePrincipal: principalFromRequest, getSignalR };
  return { deps, signalR, getSignalR };
}

function header(response: HttpResponseInit, name: string): string | undefined {
  return (response.headers as Record<string, string> | undefined)?.[name];
}

describe('negotiateHandler', () => {
  it('answers 401 with no principal and makes no SignalR call', async () => {
    const { deps, signalR, getSignalR } = setup();

    const response = await negotiateHandler(request({ principal: null }), context().ctx, deps);

    expect(response.status).toBe(401);
    expect(response.jsonBody).toMatchObject({ error: 'UNAUTHENTICATED' });
    expect(signalR.calls).toEqual([]);
    expect(getSignalR).not.toHaveBeenCalled();
  });

  it('returns 200 { url, accessToken } minted for exactly principal.userId', async () => {
    const { deps, signalR } = setup();

    const response = await negotiateHandler(request(), context().ctx, deps);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ url: CLIENT_URL, accessToken: `token-for:${USER_ID}` });
    expect(header(response, 'X-Request-ID')).toBe('inv-neg');
  });

  it('makes exactly one SignalR call, the token, and reads no devices (HAR-81)', async () => {
    // NegotiateDeps has no repository: negotiate cannot read Cosmos. The only
    // SignalR operation it can reach is the token, and it calls it once, so a
    // caller's device count no longer drives REST calls to the service.
    const { deps, signalR } = setup();

    const response = await negotiateHandler(request(), context().ctx, deps);

    expect(response.status).toBe(200);
    expect(signalR.calls).toEqual([USER_ID]);
    expect(Object.keys(deps).sort()).toEqual(['getSignalR', 'resolvePrincipal']);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
  });

  it('ignores ?deviceId=<any device>: same token, no 400', async () => {
    const plain = setup();
    const withQuery = setup();

    const a = await negotiateHandler(request(), context().ctx, plain.deps);
    const b = await negotiateHandler(
      request({ query: { deviceId: 'theirs' } }),
      context().ctx,
      withQuery.deps
    );

    expect(b.status).toBe(200);
    expect(b.jsonBody).toEqual(a.jsonBody);
    expect(withQuery.signalR.calls).toEqual(plain.signalR.calls);
  });

  it.each<[unknown, string]>([
    [new SignalRUnavailableError('generate_token', 500), 'signalr_generate_token_status_500'],
    [new SignalRUnavailableError('generate_token', 429), 'signalr_generate_token_status_429'],
    [new SignalRUnavailableError('credential'), 'signalr_credential_failed'],
    [new Error(`connect ECONNREFUSED https://${SERVICE_HOST}/api/hubs`), 'signalr_failure'],
  ])(
    'answers 503 SIGNALR_UNAVAILABLE when the token call fails (%s), with its code as reason and no endpoint in the body or logs',
    async (failure, reason) => {
      const { deps } = setup(signalRStub(failure));
      const { ctx, lines } = context();

      const response = await negotiateHandler(request(), ctx, deps);

      expect(response.status).toBe(503);
      expect(response.jsonBody).toEqual({
        error: 'SIGNALR_UNAVAILABLE',
        message: 'Real-time updates are unavailable. Try again later.',
        reason,
        requestId: 'inv-neg',
      });
      const everything = JSON.stringify(response) + lines.join('\n');
      expect(everything).not.toContain(SERVICE_HOST);
      expect(everything).not.toContain('https://');
      expect(everything).not.toContain('ECONNREFUSED');
      expect(lines.some(l => /negotiate failed: signalr_/.test(l))).toBe(true);
    }
  );

  it('takes only the code from the error: nothing else it carries reaches the body', async () => {
    // HAR-59: reason is the error's fixed code. Whatever else a thrown
    // SignalRUnavailableError carries (a message, a cause, extra fields) stays out.
    const failure = Object.assign(new SignalRUnavailableError('generate_token', 404), {
      message: `POST https://${SERVICE_HOST}/api/hubs/temperatureHub/:generateToken?userId=${USER_ID} 404`,
      cause: new Error(`token mi-secret for ${USER_ID}`),
      endpoint: `https://${SERVICE_HOST}`,
    });
    const { deps } = setup(signalRStub(failure));
    const { ctx, lines } = context();

    const response = await negotiateHandler(request(), ctx, deps);

    expect(response.status).toBe(503);
    expect(response.jsonBody).toEqual({
      error: 'SIGNALR_UNAVAILABLE',
      message: 'Real-time updates are unavailable. Try again later.',
      reason: 'signalr_generate_token_status_404',
      requestId: 'inv-neg',
    });
    const everything = JSON.stringify(response) + lines.join('\n');
    for (const leaked of [SERVICE_HOST, USER_ID, OID, 'mi-secret', 'https://']) {
      expect(everything).not.toContain(leaked);
    }
  });

  it('answers 503 when SignalR is not configured (the client getter throws)', async () => {
    const { deps } = setup();
    deps.getSignalR = () => {
      throw new SignalRUnavailableError('configuration');
    };
    const { ctx, lines } = context();

    const response = await negotiateHandler(request(), ctx, deps);

    expect(response.status).toBe(503);
    expect((response.jsonBody as { reason?: string }).reason).toBe('signalr_configuration_failed');
    expect(lines).toContain('negotiate failed: signalr_configuration_failed');
  });
});
