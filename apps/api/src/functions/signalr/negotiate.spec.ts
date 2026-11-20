/**
 * HAR-57 (MG-30) — POST /negotiate scopes a SignalR connection to the caller.
 * No Azure: the principal is a real Easy Auth header read by the real
 * principal.ts, the devices list is the real DevicesRepository on the in-memory
 * container, and SignalR is a recording stub.
 */
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Device } from '@meatgeekv2/api-interfaces';

import { principalFromRequest } from '../../shared/auth/principal';
import { DevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  FakeDevicesContainer,
  QUERY_CHARGE,
} from '../../shared/cosmos/fake-devices-container.testing';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import {
  SignalRUnavailableError,
  type SignalRManagementPort,
} from '../../shared/signalr/signalr-management';
import { GROUP_ADD_CONCURRENCY, negotiateHandler, type NegotiateDeps } from './negotiate';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const USER_ID = `${TID}:${OID}`;
const OTHER_USER_ID = `${TID}:oid-zzzz-9999`;

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

type Call =
  | { op: 'removeAll'; userId: string }
  | { op: 'add'; group: string; userId: string }
  | { op: 'token'; userId: string };

/** Records every SignalR call in order. `failOn` makes that operation throw. */
function signalRStub(
  failOn?: Call['op'],
  failure: unknown = new SignalRUnavailableError('add_user_to_group', 500)
) {
  const calls: Call[] = [];
  const port: SignalRManagementPort = {
    async removeUserFromAllGroups(userId) {
      calls.push({ op: 'removeAll', userId });
      if (failOn === 'removeAll') throw failure;
    },
    async addUserToGroup(group, userId) {
      calls.push({ op: 'add', group, userId });
      if (failOn === 'add') throw failure;
    },
    async generateClientToken(userId) {
      calls.push({ op: 'token', userId });
      if (failOn === 'token') throw failure;
      return { url: CLIENT_URL, accessToken: `token-for:${userId}` };
    },
  };
  return { port, calls };
}

function device(id: string, userId = USER_ID): Device {
  return {
    id,
    userId,
    name: `Smoker ${id}`,
    model: 'MeatGeek V1',
    isActive: true,
    connectionStatus: 'unknown',
  };
}

function setup(signalR = signalRStub()) {
  const fake = new FakeDevicesContainer();
  const getSignalR = jest.fn(() => signalR.port);
  const getRepository = jest.fn(() => new DevicesRepository(fake.asContainer()));
  const deps: NegotiateDeps = { resolvePrincipal: principalFromRequest, getRepository, getSignalR };
  return { fake, deps, signalR, getSignalR, getRepository };
}

function header(response: HttpResponseInit, name: string): string | undefined {
  return (response.headers as Record<string, string> | undefined)?.[name];
}

describe('negotiateHandler', () => {
  it('answers 401 with no principal and makes no SignalR or Cosmos call', async () => {
    const { deps, signalR, getSignalR, getRepository } = setup();

    const response = await negotiateHandler(request({ principal: null }), context().ctx, deps);

    expect(response.status).toBe(401);
    expect(response.jsonBody).toMatchObject({ error: 'UNAUTHENTICATED' });
    expect(signalR.calls).toEqual([]);
    expect(getSignalR).not.toHaveBeenCalled();
    expect(getRepository).not.toHaveBeenCalled();
  });

  it('returns 200 { url, accessToken } minted for exactly principal.userId', async () => {
    const { fake, deps, signalR } = setup();
    fake.seed(device('grill-1'));

    const response = await negotiateHandler(request(), context().ctx, deps);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual({ url: CLIENT_URL, accessToken: `token-for:${USER_ID}` });
    const tokens = signalR.calls.filter(c => c.op === 'token');
    expect(tokens).toEqual([{ op: 'token', userId: USER_ID }]);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(QUERY_CHARGE));
    expect(header(response, 'X-Request-ID')).toBe('inv-neg');
  });

  it('resets membership: remove-all first, then one add per owned device and nothing else', async () => {
    const { fake, deps, signalR } = setup();
    fake.seed(device('grill-1'));
    fake.seed(device('grill-2'));
    fake.seed(device('theirs', OTHER_USER_ID));

    const response = await negotiateHandler(request(), context().ctx, deps);

    expect(response.status).toBe(200);
    expect(signalR.calls[0]).toEqual({ op: 'removeAll', userId: USER_ID });
    const adds = signalR.calls.filter(c => c.op === 'add');
    expect(adds).toHaveLength(2);
    expect(adds).toEqual(
      expect.arrayContaining([
        { op: 'add', group: 'device-grill-1', userId: USER_ID },
        { op: 'add', group: 'device-grill-2', userId: USER_ID },
      ])
    );
    expect(signalR.calls.filter(c => c.op === 'removeAll')).toHaveLength(1);
    // Every add comes after the remove-all.
    expect(signalR.calls.slice(1).every(c => c.op !== 'removeAll')).toBe(true);
  });

  it('with 10 owned devices, has at most 4 adds in flight at once and makes all 10 (HAR-80)', async () => {
    const stub = signalRStub();
    let inFlight = 0;
    let peak = 0;
    const record = stub.port.addUserToGroup.bind(stub.port);
    stub.port.addUserToGroup = async (group, userId) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      try {
        await record(group, userId);
        // Yield a few turns so overlapping calls really overlap.
        for (let i = 0; i < 3; i++) await new Promise(resolve => setImmediate(resolve));
      } finally {
        inFlight--;
      }
    };
    const { fake, deps } = setup(stub);
    const ids = Array.from({ length: 10 }, (_, i) => `grill-${i}`);
    for (const id of ids) fake.seed(device(id));

    const response = await negotiateHandler(request(), context().ctx, deps);

    expect(response.status).toBe(200);
    expect(GROUP_ADD_CONCURRENCY).toBe(4);
    expect(peak).toBe(4);
    const adds = stub.calls.filter(c => c.op === 'add');
    expect(adds).toHaveLength(10);
    expect(adds.map(a => (a as { group: string }).group).sort()).toEqual(
      ids.map(id => `device-${id}`).sort()
    );
    expect(stub.calls[0]).toEqual({ op: 'removeAll', userId: USER_ID });
    expect(stub.calls[stub.calls.length - 1]).toEqual({ op: 'token', userId: USER_ID });
  });

  it('stops starting adds after the first failure and answers 503', async () => {
    const stub = signalRStub('add', new SignalRUnavailableError('add_user_to_group', 429));
    const { fake, deps } = setup(stub);
    for (let i = 0; i < 10; i++) fake.seed(device(`grill-${i}`));

    const response = await negotiateHandler(request(), context().ctx, deps);

    expect(response.status).toBe(503);
    expect((response.jsonBody as { reason: string }).reason).toBe(
      'signalr_add_user_to_group_status_429'
    );
    // The first batch of 4 started together; none after the failure, no token.
    expect(stub.calls.filter(c => c.op === 'add')).toHaveLength(GROUP_ADD_CONCURRENCY);
    expect(stub.calls.some(c => c.op === 'token')).toBe(false);
  });

  it('with no owned devices, still clears the groups and adds none', async () => {
    const { deps, signalR } = setup();

    const response = await negotiateHandler(request(), context().ctx, deps);

    expect(response.status).toBe(200);
    expect(signalR.calls).toEqual([
      { op: 'removeAll', userId: USER_ID },
      { op: 'token', userId: USER_ID },
    ]);
  });

  it('ignores ?deviceId=<foreign device>: same token, same groups, no 400', async () => {
    const plain = setup();
    plain.fake.seed(device('grill-1'));
    plain.fake.seed(device('theirs', OTHER_USER_ID));
    const withQuery = setup();
    withQuery.fake.seed(device('grill-1'));
    withQuery.fake.seed(device('theirs', OTHER_USER_ID));

    const a = await negotiateHandler(request(), context().ctx, plain.deps);
    const b = await negotiateHandler(
      request({ query: { deviceId: 'theirs' } }),
      context().ctx,
      withQuery.deps
    );

    expect(b.status).toBe(200);
    expect(b.jsonBody).toEqual(a.jsonBody);
    expect(withQuery.signalR.calls).toEqual(plain.signalR.calls);
    expect(JSON.stringify(withQuery.signalR.calls)).not.toContain('theirs');
  });

  it.each<[Call['op'], unknown, string]>([
    [
      'removeAll',
      new SignalRUnavailableError('remove_user_from_all_groups', 403),
      'signalr_remove_user_from_all_groups_status_403',
    ],
    ['add', new SignalRUnavailableError('add_user_to_group'), 'signalr_add_user_to_group_failed'],
    [
      'token',
      new SignalRUnavailableError('generate_token', 500),
      'signalr_generate_token_status_500',
    ],
    [
      'token',
      new Error(`connect ECONNREFUSED https://${SERVICE_HOST}/api/hubs`),
      'signalr_failure',
    ],
  ])(
    'answers 503 SIGNALR_UNAVAILABLE when %s fails, with its code as reason and no endpoint in the body or logs',
    async (op, failure, reason) => {
      const { fake, deps } = setup(signalRStub(op, failure));
      fake.seed(device('grill-1'));
      const { ctx, lines } = context();

      const response = await negotiateHandler(request(), ctx, deps);

      expect(response.status).toBe(503);
      expect(response.jsonBody).toEqual({
        error: 'SIGNALR_UNAVAILABLE',
        message: 'Real-time updates are unavailable. Try again later.',
        reason,
        requestId: 'inv-neg',
      });
      if (failure instanceof SignalRUnavailableError) {
        expect((response.jsonBody as { reason: string }).reason).toBe(failure.code);
      }
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
    const failure = Object.assign(new SignalRUnavailableError('add_user_to_group', 404), {
      message: `PUT https://${SERVICE_HOST}/api/hubs/temperatureHub/users/${USER_ID} 404`,
      cause: new Error(`token mi-secret for ${USER_ID}`),
      endpoint: `https://${SERVICE_HOST}`,
    });
    const { fake, deps } = setup(signalRStub('add', failure));
    fake.seed(device('grill-1'));
    const { ctx, lines } = context();

    const response = await negotiateHandler(request(), ctx, deps);

    expect(response.status).toBe(503);
    expect(response.jsonBody).toEqual({
      error: 'SIGNALR_UNAVAILABLE',
      message: 'Real-time updates are unavailable. Try again later.',
      reason: 'signalr_add_user_to_group_status_404',
      requestId: 'inv-neg',
    });
    const everything = JSON.stringify(response) + lines.join('\n');
    for (const leaked of [SERVICE_HOST, USER_ID, OID, 'mi-secret', 'device-grill-1', 'https://']) {
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

  it('answers a sanitized 500 when the devices read fails, with no SignalR call', async () => {
    const { deps, signalR } = setup();
    deps.getRepository = () => ({
      listDevicesByOwner: async () => {
        throw Object.assign(new Error(`https://acct.documents.azure.com failed`), { code: 503 });
      },
    });
    const { ctx, lines } = context();

    const response = await negotiateHandler(request(), ctx, deps);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toMatchObject({ error: 'INTERNAL_SERVER_ERROR' });
    expect(signalR.calls).toEqual([]);
    expect(JSON.stringify(response) + lines.join('\n')).not.toContain('documents.azure.com');
    expect(lines).toContain('negotiate failed: cosmos_status_503');
  });
});
