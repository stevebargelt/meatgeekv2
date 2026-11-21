/**
 * HAR-66 — the IoT Hub twin client, with a stubbed credential and a stubbed
 * fetch. No Azure, no network.
 */
import type { AccessToken, TokenCredential } from '@azure/core-auth';

import {
  DeviceTwinClient,
  DeviceTwinError,
  IOTHUB_API_VERSION,
  IOTHUB_SERVICE_HOSTNAME_SETTING,
  IOTHUB_TOKEN_SCOPE,
  quoteEtag,
  resolveIotHubHostname,
} from './device-twin';

const HOSTNAME = 'meatgeek-dev-iothub.azure-devices.net';
const DEVICE_ID = 'meatgeek 3/pi#1';
const TOKEN = 'mi-token-secret';

interface Recorded {
  url: URL;
  method: string | undefined;
  headers: Headers;
  body: string | undefined;
}

function stubCredential(token: string | Error = TOKEN) {
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

function stubFetch(answer: () => Response | Error) {
  const calls: Recorded[] = [];
  const fetchStub = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({
      url: new URL(String(input)),
      method: init?.method,
      headers: new Headers(init?.headers),
      body: typeof init?.body === 'string' ? init.body : undefined,
    });
    const result = answer();
    if (result instanceof Error) {
      throw result;
    }
    return result;
  }) as typeof fetch;
  return { fetch: fetchStub, calls };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

const TWIN_BODY = {
  deviceId: DEVICE_ID,
  etag: 'AAAAAAAAAAE=',
  version: 4,
  properties: {
    desired: { activeCookId: 'cook-a', correlationId: 'req-1', $version: 3 },
    reported: { activeCookId: 'cook-a', appliedDesiredVersion: 3, $version: 5 },
  },
};

function client(answer: () => Response | Error, credential = stubCredential()) {
  const fetchStub = stubFetch(answer);
  return {
    client: new DeviceTwinClient(HOSTNAME, {
      credential: credential.credential,
      fetch: fetchStub.fetch,
    }),
    calls: fetchStub.calls,
    scopes: credential.scopes,
  };
}

async function failure(promise: Promise<unknown>): Promise<DeviceTwinError> {
  try {
    await promise;
  } catch (error) {
    expect(error).toBeInstanceOf(DeviceTwinError);
    return error as DeviceTwinError;
  }
  throw new Error('expected a DeviceTwinError');
}

/** Nothing identifying may reach an error: not the host, the device, the token. */
function expectSanitized(error: DeviceTwinError): void {
  const text = `${error.message} ${error.code} ${String(error.stack)} ${JSON.stringify(error)}`;
  for (const secret of [HOSTNAME, 'meatgeek-dev-iothub', DEVICE_ID, 'meatgeek 3', TOKEN]) {
    expect(text).not.toContain(secret);
  }
}

describe('DeviceTwinClient.getTwin', () => {
  it('GETs /twins/{id} with the api-version and a managed identity bearer token', async () => {
    const { client: twins, calls, scopes } = client(() => json(TWIN_BODY));

    const twin = await twins.getTwin(DEVICE_ID);

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('GET');
    expect(call.url.origin).toBe(`https://${HOSTNAME}`);
    // The device id is URL-encoded: '/', ' ' and '#' cannot change the path.
    expect(call.url.pathname).toBe(`/twins/${encodeURIComponent(DEVICE_ID)}`);
    expect(call.url.searchParams.get('api-version')).toBe(IOTHUB_API_VERSION);
    expect(IOTHUB_API_VERSION).toBe('2021-04-12');
    expect(call.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call.body).toBeUndefined();
    expect(scopes).toEqual([IOTHUB_TOKEN_SCOPE]);
    expect(IOTHUB_TOKEN_SCOPE).toBe('https://iothubs.azure.net/.default');

    expect(twin).toEqual({ etag: TWIN_BODY.etag, desired: TWIN_BODY.properties.desired });
  });

  it('treats a twin with no desired properties as an empty desired set', async () => {
    const { client: twins } = client(() => json({ etag: 'e1', properties: {} }));
    expect(await twins.getTwin('pi')).toEqual({ etag: 'e1', desired: {} });
  });

  it('keeps a 404 (no device identity) distinct', async () => {
    const { client: twins } = client(() => json({ Message: `Device ${DEVICE_ID} not found` }, 404));
    const error = await failure(twins.getTwin(DEVICE_ID));
    expect(error.code).toBe('iothub_get_twin_status_404');
    expect(error.isNotFound).toBe(true);
    expect(error.isPreconditionFailed).toBe(false);
    expectSanitized(error);
  });

  it('fails with the numeric status when the twin has no etag', async () => {
    const { client: twins } = client(() => json({ properties: { desired: {} } }));
    const error = await failure(twins.getTwin(DEVICE_ID));
    expect(error.code).toBe('iothub_get_twin_status_200');
  });
});

describe('DeviceTwinClient.patchDesired', () => {
  it('PATCHes { properties: { desired } } with If-Match on the etag', async () => {
    const { client: twins, calls } = client(() => json(TWIN_BODY));

    await twins.patchDesired(
      DEVICE_ID,
      { activeCookId: 'cook-b', correlationId: null },
      'AAAAAAAAAAE='
    );

    expect(calls).toHaveLength(1);
    const [call] = calls;
    expect(call.method).toBe('PATCH');
    expect(call.url.origin).toBe(`https://${HOSTNAME}`);
    expect(call.url.pathname).toBe(`/twins/${encodeURIComponent(DEVICE_ID)}`);
    expect(call.url.searchParams.get('api-version')).toBe(IOTHUB_API_VERSION);
    expect(call.headers.get('Authorization')).toBe(`Bearer ${TOKEN}`);
    expect(call.headers.get('Content-Type')).toBe('application/json');
    expect(call.headers.get('If-Match')).toBe('"AAAAAAAAAAE="');
    // `null` is sent as null: IoT Hub deletes the property.
    expect(JSON.parse(call.body!)).toEqual({
      properties: { desired: { activeCookId: 'cook-b', correlationId: null } },
    });
  });

  it('keeps a 412 distinct from every other failure', async () => {
    const stale = await failure(
      client(() => json({ Message: 'precondition failed' }, 412)).client.patchDesired(
        DEVICE_ID,
        { activeCookId: null, correlationId: null },
        'old'
      )
    );
    expect(stale.code).toBe('iothub_patch_twin_status_412');
    expect(stale.isPreconditionFailed).toBe(true);
    expectSanitized(stale);

    for (const status of [400, 401, 403, 404, 429, 500, 503]) {
      const other = await failure(
        client(() => json({}, status)).client.patchDesired(
          DEVICE_ID,
          { activeCookId: null, correlationId: null },
          'e'
        )
      );
      expect(other.code).toBe(`iothub_patch_twin_status_${status}`);
      expect(other.isPreconditionFailed).toBe(false);
      expectSanitized(other);
    }
  });
});

describe('sanitized failures', () => {
  it('drops the credential error text', async () => {
    const credential = stubCredential(
      new Error(`ManagedIdentityCredential failed at http://169.254.169.254 for ${HOSTNAME}`)
    );
    const { client: twins, calls } = client(() => json(TWIN_BODY), credential);
    const error = await failure(twins.getTwin(DEVICE_ID));
    expect(error.code).toBe('iothub_credential_failed');
    expect(error.status).toBeUndefined();
    expect(calls).toHaveLength(0);
    expect(error.message).not.toContain('169.254');
    expectSanitized(error);
  });

  it('drops a network failure, whose text names the host', async () => {
    const { client: twins } = client(
      () => new TypeError(`fetch failed: getaddrinfo ENOTFOUND ${HOSTNAME} (${DEVICE_ID})`)
    );
    const error = await failure(
      twins.patchDesired(DEVICE_ID, { activeCookId: 'c', correlationId: 'r' }, 'e')
    );
    expect(error.code).toBe('iothub_patch_twin_failed');
    expectSanitized(error);
  });

  it('never puts the token, host or device id in an error for any operation', async () => {
    const { client: twins } = client(() =>
      json({ detail: `${HOSTNAME} ${DEVICE_ID} ${TOKEN}` }, 500)
    );
    expectSanitized(await failure(twins.getTwin(DEVICE_ID)));
    expectSanitized(
      await failure(twins.patchDesired(DEVICE_ID, { activeCookId: null, correlationId: null }, 'e'))
    );
  });
});

describe('resolveIotHubHostname', () => {
  it('reads the bare hostname from IOTHUB_SERVICE_HOSTNAME', () => {
    expect(IOTHUB_SERVICE_HOSTNAME_SETTING).toBe('IOTHUB_SERVICE_HOSTNAME');
    expect(resolveIotHubHostname({ IOTHUB_SERVICE_HOSTNAME: ` ${HOSTNAME} ` })).toBe(HOSTNAME);
  });

  it.each([
    ['missing', undefined],
    ['blank', '   '],
    ['a URL, not a hostname', `https://${HOSTNAME}`],
    ['a hostname with a path', `${HOSTNAME}/twins`],
    ['a single label', 'localhost'],
  ])('fails with a fixed configuration code when %s', (_label, value) => {
    let caught: unknown;
    try {
      resolveIotHubHostname(value === undefined ? {} : { IOTHUB_SERVICE_HOSTNAME: value });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(DeviceTwinError);
    expect((caught as DeviceTwinError).code).toBe('iothub_configuration_failed');
    expect((caught as DeviceTwinError).message).not.toContain('azure-devices');
  });
});

describe('quoteEtag', () => {
  it('quotes a bare etag and leaves a quoted one alone', () => {
    expect(quoteEtag('AAAAAAAAAAE=')).toBe('"AAAAAAAAAAE="');
    expect(quoteEtag('"AAAAAAAAAAE="')).toBe('"AAAAAAAAAAE="');
  });
});
