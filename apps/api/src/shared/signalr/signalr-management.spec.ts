/**
 * HAR-57 (MG-30) — the SignalR data-plane client, with a stubbed credential and
 * a stubbed fetch. No Azure, no network.
 */
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type { AccessToken, TokenCredential } from '@azure/core-auth';

import {
  CLIENT_TOKEN_MINUTES,
  MAX_ATTEMPTS,
  RETRY_AFTER_CAP_MS,
  RETRY_BACKOFF_MS,
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
  signal: AbortSignal | null | undefined;
}

function stubCredential(token: string | Error = 'mi-token') {
  const scopes: Array<string | string[]> = [];
  const credential: TokenCredential = {
    async getToken(scope): Promise<AccessToken | null> {
      scopes.push(scope);
      if (token instanceof Error) {
        throw token;
      }
      // A fixed expiry: the client reads only `token`, never the expiry, and
      // keeps no token cache, so no clock is compared against it.
      return { token, expiresOnTimestamp: Date.parse('2099-01-01T00:00:00.000Z') };
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
      signal: init?.signal,
    });
    const result = answer(url);
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

/** Records every wait instead of waiting, so retry tests take no real time. */
function stubSleep() {
  const waits: number[] = [];
  const sleep = async (ms: number): Promise<void> => {
    waits.push(ms);
  };
  return { sleep, waits };
}

function client(
  fetchStub = stubFetch(),
  credential = stubCredential(),
  sleepStub = stubSleep()
): {
  client: SignalRManagementClient;
  fetchStub: ReturnType<typeof stubFetch>;
  credential: ReturnType<typeof stubCredential>;
  sleepStub: ReturnType<typeof stubSleep>;
} {
  return {
    client: new SignalRManagementClient(SERVICE_URI, HUB, {
      credential: credential.credential,
      fetch: fetchStub.fetch,
      sleep: sleepStub.sleep,
    }),
    fetchStub,
    credential,
    sleepStub,
  };
}

/** Answers with each of `answers` in turn, then repeats the last. */
function sequence(...answers: Array<() => Response>): (url: URL) => Response {
  let i = 0;
  return () => answers[Math.min(i++, answers.length - 1)]();
}

const status =
  (code: number, headers: Record<string, string> = {}) =>
  () =>
    new Response(null, { status: code, headers });

/** A 200 answer :generateToken accepts. */
const tokenOk = () =>
  new Response(JSON.stringify({ token: 'minted' }), {
    status: 200,
    headers: { 'Content-Type': 'application/json' },
  });

async function failure(promise: Promise<unknown>): Promise<SignalRUnavailableError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(SignalRUnavailableError);
    return error as SignalRUnavailableError;
  }
  throw new Error('expected a SignalRUnavailableError');
}

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

describe('SignalRManagementClient retries throttling (HAR-80)', () => {
  it('429 then 200 succeeds after one retry', async () => {
    const { client: c, fetchStub, sleepStub } = client(stubFetch(sequence(status(429), tokenOk)));

    await c.generateClientToken(USER_ID);

    expect(fetchStub.calls).toHaveLength(2);
    expect(sleepStub.waits).toEqual([RETRY_BACKOFF_MS[0]]);
    // The retry is the same request.
    const [first, second] = fetchStub.calls;
    expect(second.method).toBe(first.method);
    expect(second.url.toString()).toBe(first.url.toString());
    expect(second.authorization).toBe(first.authorization);
  });

  it('503 four times throws signalr_<op>_status_503 after exactly 4 fetches', async () => {
    const { client: c, fetchStub, sleepStub } = client(stubFetch(status(503)));

    const error = await failure(c.generateClientToken(USER_ID));

    expect(MAX_ATTEMPTS).toBe(4);
    expect(fetchStub.calls).toHaveLength(4);
    expect(sleepStub.waits).toHaveLength(3);
    expect(error.code).toBe('signalr_generate_token_status_503');
    expect(error.status).toBe(503);
  });

  it('Retry-After: 1 waits 1000 ms', async () => {
    const { client: c, sleepStub } = client(
      stubFetch(sequence(status(429, { 'Retry-After': '1' }), tokenOk))
    );

    await c.generateClientToken(USER_ID);

    expect(sleepStub.waits).toEqual([1000]);
  });

  it('Retry-After: 30 is capped at 2000 ms', async () => {
    const { client: c, sleepStub } = client(
      stubFetch(sequence(status(429, { 'Retry-After': '30' }), tokenOk))
    );

    await c.generateClientToken(USER_ID);

    expect(RETRY_AFTER_CAP_MS).toBe(2000);
    expect(sleepStub.waits).toEqual([2000]);
  });

  it('with no Retry-After the waits are 200, 400, 800 ms', async () => {
    const { client: c, fetchStub, sleepStub } = client(stubFetch(status(429)));

    const error = await failure(c.generateClientToken(USER_ID));

    expect(sleepStub.waits).toEqual([200, 400, 800]);
    expect(fetchStub.calls).toHaveLength(4);
    expect(error.code).toBe('signalr_generate_token_status_429');
  });

  it('a 403 throws after exactly 1 fetch and no wait', async () => {
    const { client: c, fetchStub, sleepStub } = client(stubFetch(status(403)));

    const error = await failure(c.generateClientToken(USER_ID));

    expect(fetchStub.calls).toHaveLength(1);
    expect(sleepStub.waits).toEqual([]);
    expect(error.code).toBe('signalr_generate_token_status_403');
  });

  it('gives each retry a fresh timeout signal', async () => {
    const { client: c, fetchStub } = client(stubFetch(sequence(status(503), status(429), tokenOk)));

    await c.generateClientToken(USER_ID);

    const signals = fetchStub.calls.map(call => call.signal);
    expect(signals).toHaveLength(3);
    for (const signal of signals) {
      expect(signal).toBeInstanceOf(AbortSignal);
    }
    expect(new Set(signals).size).toBe(3);
  });

  it('a network failure on a retry fails at once', async () => {
    const answers = [status(429), () => new TypeError('fetch failed')];
    let i = 0;
    const { client: c, fetchStub } = client(stubFetch(() => answers[i++]()));

    const error = await failure(c.generateClientToken(USER_ID));

    expect(fetchStub.calls).toHaveLength(2);
    expect(error.code).toBe('signalr_generate_token_failed');
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
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ token: 'wire-token' }));
    });
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    await new Promise<void>(resolve => server.close(() => resolve()));
  });

  it('sends the token call with the documented path, api-version and Content-Length: 0', async () => {
    const signals: Array<AbortSignal | null | undefined> = [];
    const c = new SignalRManagementClient(base, HUB, {
      credential: stubCredential().credential,
      // Real loopback I/O: record the client's AbortSignal.timeout, then drop it,
      // so a starved machine cannot turn a slow answer into a failure.
      fetch: (input, init) => {
        signals.push(init?.signal);
        return fetch(input, { ...init, signal: undefined });
      },
    });

    const connection = await c.generateClientToken(USER_ID);

    expect(signals).toHaveLength(1);
    expect(signals[0]).toBeInstanceOf(AbortSignal);

    expect(connection.accessToken).toBe('wire-token');
    const version = `api-version=${SIGNALR_API_VERSION}`;
    expect(seen.map(({ method, path }) => `${method} ${path}`)).toEqual([
      `POST /api/hubs/${HUB}/:generateToken?userId=tid-1234%3Aoid-5678&minutesToExpire=60&${version}`,
    ]);
    const [post] = seen;
    expect(post.contentLength).toBe('0');
    expect(post.transferEncoding).toBeUndefined();
    expect(post.authorization).toBe('Bearer mi-token');
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
    const error = await failure(c.generateClientToken(USER_ID));
    expect(error.code).toBe('signalr_generate_token_status_403');
    expect(error.status).toBe(403);
    expectSanitized(error);
  });

  it('a network failure carries the operation only', async () => {
    const { client: c } = client(
      stubFetch(() => new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${host}`))
    );
    const error = await failure(c.generateClientToken(USER_ID));
    expect(error.code).toBe('signalr_generate_token_failed');
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
