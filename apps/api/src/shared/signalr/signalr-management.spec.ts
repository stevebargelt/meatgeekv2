/**
 * HAR-57 (MG-30) — the SignalR data-plane client, with a stubbed credential and
 * a stubbed fetch. No Azure, no network.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AccessToken, TokenCredential } from '@azure/core-auth';

import {
  CLIENT_TOKEN_MINUTES,
  deviceGroup,
  resolveSignalRServiceUri,
  SIGNALR_API_VERSION,
  SIGNALR_SERVICE_URI_SETTING,
  SIGNALR_TOKEN_SCOPE,
  SignalRManagementClient,
  SignalRUnavailableError,
} from './signalr-management';

const SERVICE_URI = 'https://meatgeek-dev-signalr.service.signalr.net';
const HUB = 'temperatureHub';
const USER_ID = 'tid-1234:oid-5678';

interface Recorded {
  url: URL;
  method: string | undefined;
  authorization: string | undefined;
}

function stubCredential(token: string | Error = 'mi-token') {
  const scopes: Array<string | string[]> = [];
  const credential: TokenCredential = {
    async getToken(scope): Promise<AccessToken | null> {
      scopes.push(scope);
      if (token instanceof Error) {
        throw token;
      }
      return { token, expiresOnTimestamp: Date.now() + 3_600_000 };
    },
  };
  return { credential, scopes };
}

function stubFetch(
  answer: (url: URL) => Response | Error = () => new Response(null, { status: 200 })
) {
  const calls: Recorded[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      method: init?.method,
      authorization: headers.get('Authorization') ?? undefined,
    });
    const result = answer(url);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

function client(
  fetchStub = stubFetch(),
  credential = stubCredential()
): {
  client: SignalRManagementClient;
  fetchStub: ReturnType<typeof stubFetch>;
  credential: ReturnType<typeof stubCredential>;
} {
  return {
    client: new SignalRManagementClient(SERVICE_URI, HUB, {
      credential: credential.credential,
      fetch: fetchStub.fetch,
    }),
    fetchStub,
    credential,
  };
}

async function failure(promise: Promise<unknown>): Promise<SignalRUnavailableError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SignalRUnavailableError);
    return error as SignalRUnavailableError;
  }
  throw new Error('expected a SignalRUnavailableError');
}

describe('deviceGroup', () => {
  it('is device-<deviceId>', () => {
    expect(deviceGroup('meatgeek3')).toBe('device-meatgeek3');
  });
});

describe('SignalRManagementClient.generateClientToken', () => {
  it('POSTs :generateToken for the userId with a 60-minute lifetime and the api-version', async () => {
    const {
      client: c,
      fetchStub,
      credential,
    } = client(stubFetch(() => Response.json({ token: 'client-token' })));

    const connection = await c.generateClientToken(USER_ID);

    expect(connection).toEqual({
      url: `${SERVICE_URI}/client/?hub=${HUB}`,
      accessToken: 'client-token',
    });
    expect(fetchStub.calls).toHaveLength(1);
    const [call] = fetchStub.calls;
    expect(call.method).toBe('POST');
    expect(call.url.origin).toBe(SERVICE_URI);
    expect(call.url.pathname).toBe(`/api/hubs/${HUB}/:generateToken`);
    expect(call.url.searchParams.get('userId')).toBe(USER_ID);
    expect(call.url.searchParams.get('minutesToExpire')).toBe(String(CLIENT_TOKEN_MINUTES));
    expect(CLIENT_TOKEN_MINUTES).toBe(60);
    expect(call.url.searchParams.get('api-version')).toBe(SIGNALR_API_VERSION);
    expect(SIGNALR_API_VERSION).toBe('2024-12-01');
    expect(call.authorization).toBe('Bearer mi-token');
    expect(credential.scopes).toEqual([SIGNALR_TOKEN_SCOPE]);
    expect(SIGNALR_TOKEN_SCOPE).toBe('https://signalr.azure.com/.default');
  });

  it('fails when the answer has no token', async () => {
    const { client: c } = client(stubFetch(() => Response.json({})));
    const error = await failure(c.generateClientToken(USER_ID));
    expect(error.code).toBe('signalr_generate_token_status_200');
  });

  it('fails when the answer is not JSON', async () => {
    const { client: c } = client(stubFetch(() => new Response('<html>', { status: 200 })));
    await failure(c.generateClientToken(USER_ID));
  });
});

describe('SignalRManagementClient group operations', () => {
  it('removeUserFromAllGroups DELETEs /users/{user}/groups with the user URL-encoded', async () => {
    const { client: c, fetchStub } = client();

    await c.removeUserFromAllGroups(USER_ID);

    const [call] = fetchStub.calls;
    expect(call.method).toBe('DELETE');
    expect(call.url.pathname).toBe(`/api/hubs/${HUB}/users/tid-1234%3Aoid-5678/groups`);
    expect(call.url.searchParams.get('api-version')).toBe(SIGNALR_API_VERSION);
    expect(call.authorization).toBe('Bearer mi-token');
  });

  it('addUserToGroup PUTs /users/{user}/groups/{group} with both segments URL-encoded', async () => {
    // HAR-59: the versioned API's AddUserToGroup is /users/{user}/groups/{group};
    // /groups/{group}/users/{user} is not a route in 2022-06-01 or later.
    const { client: c, fetchStub } = client();

    await c.addUserToGroup('device-a:b/c', USER_ID);

    const [call] = fetchStub.calls;
    expect(call.method).toBe('PUT');
    expect(call.url.pathname).toBe(
      `/api/hubs/${HUB}/users/tid-1234%3Aoid-5678/groups/device-a%3Ab%2Fc`
    );
    expect(call.url.searchParams.get('api-version')).toBe(SIGNALR_API_VERSION);
    expect([...call.url.searchParams.keys()].sort()).toEqual(['api-version']);
  });
});

describe('SignalRManagementClient on the wire (real fetch, loopback server)', () => {
  // HAR-59: what Node's fetch actually sends, so a missing Content-Length (an
  // Azure front end answers 411) or a wrong path cannot hide behind the stub.
  interface Seen {
    method: string | undefined;
    path: string | undefined;
    contentLength: string | undefined;
    transferEncoding: string | undefined;
    authorization: string | undefined;
  }
  let server: Server;
  let base: string;
  const seen: Seen[] = [];

  beforeAll(async () => {
    server = createServer((req, res) => {
      seen.push({
        method: req.method,
        path: req.url,
        contentLength: req.headers['content-length'],
        transferEncoding: req.headers['transfer-encoding'],
        authorization: req.headers.authorization,
      });
      if (req.method === 'POST') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ token: 'wire-token' }));
      } else {
        res.writeHead(req.method === 'DELETE' ? 204 : 200);
        res.end();
      }
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('sends the three calls with the documented paths, api-version and Content-Length: 0', async () => {
    const c = new SignalRManagementClient(base, HUB, {
      credential: stubCredential().credential,
      fetch: (input, init) => fetch(input, init),
    });

    await c.removeUserFromAllGroups(USER_ID);
    await c.addUserToGroup('device-meatgeek3', USER_ID);
    const connection = await c.generateClientToken(USER_ID);

    expect(connection.accessToken).toBe('wire-token');
    const version = `api-version=${SIGNALR_API_VERSION}`;
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `DELETE /api/hubs/${HUB}/users/tid-1234%3Aoid-5678/groups?${version}`,
      `PUT /api/hubs/${HUB}/users/tid-1234%3Aoid-5678/groups/device-meatgeek3?${version}`,
      `POST /api/hubs/${HUB}/:generateToken?userId=tid-1234%3Aoid-5678&minutesToExpire=60&${version}`,
    ]);
    const [, put, post] = seen;
    expect(put.contentLength).toBe('0');
    expect(post.contentLength).toBe('0');
    for (const call of seen) {
      expect(call.transferEncoding).toBeUndefined();
      expect(call.authorization).toBe('Bearer mi-token');
    }
  });
});

describe('SignalRManagementClient failures are sanitized', () => {
  const host = 'meatgeek-dev-signalr.service.signalr.net';

  function expectSanitized(error: SignalRUnavailableError) {
    const text = `${error.message} ${error.code} ${String(error.stack)}`;
    expect(text).not.toContain(host);
    expect(text).not.toContain(USER_ID);
    expect(text).not.toContain('mi-token');
  }

  it('a non-2xx answer carries the operation and status only', async () => {
    const { client: c } = client(
      stubFetch(() => new Response(`forbidden for ${USER_ID} on ${host}`, { status: 403 }))
    );
    const error = await failure(c.addUserToGroup('device-x', USER_ID));
    expect(error.code).toBe('signalr_add_user_to_group_status_403');
    expect(error.status).toBe(403);
    expectSanitized(error);
  });

  it('a network failure carries the operation only', async () => {
    const { client: c } = client(
      stubFetch(() => new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${host}`))
    );
    const error = await failure(c.removeUserFromAllGroups(USER_ID));
    expect(error.code).toBe('signalr_remove_user_from_all_groups_failed');
    expect(error.status).toBeUndefined();
    expectSanitized(error);
  });

  it('a credential failure is a credential error, and no request is sent', async () => {
    const fetchStub = stubFetch();
    const { client: c } = client(
      fetchStub,
      stubCredential(new Error('ManagedIdentityCredential: http://169.254.169.254 unreachable'))
    );
    const error = await failure(c.generateClientToken(USER_ID));
    expect(error.code).toBe('signalr_credential_failed');
    expect(error.message).not.toContain('169.254');
    expect(fetchStub.calls).toEqual([]);
  });
});

describe('resolveSignalRServiceUri', () => {
  it('reads the setting and drops a trailing slash', () => {
    expect(resolveSignalRServiceUri({ [SIGNALR_SERVICE_URI_SETTING]: `${SERVICE_URI}/` })).toBe(
      SERVICE_URI
    );
    expect(SIGNALR_SERVICE_URI_SETTING).toBe('AzureSignalRConnectionString__serviceUri');
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['not a URL', 'not a url'],
    ['not https', 'http://meatgeek.service.signalr.net'],
  ])('throws a configuration error, without the value, when %s', (_c, value) => {
    const env = value === undefined ? {} : { [SIGNALR_SERVICE_URI_SETTING]: value };
    let caught: unknown;
    try {
      resolveSignalRServiceUri(env);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(SignalRUnavailableError);
    expect((caught as SignalRUnavailableError).code).toBe('signalr_configuration_failed');
    if (value?.trim()) {
      expect((caught as Error).message).not.toContain(value.trim());
    }
  });
});
