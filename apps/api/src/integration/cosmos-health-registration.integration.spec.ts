/**
 * MG-51 / MG-59 integration coverage: drive the Cosmos health probe through the
 * handler that main.ts registers with the Azure Functions host. MG-59 refactored
 * the probe onto the ONE shared adapter, so the seam is now a no-argument probe
 * factory (`() => { readDatabase(); readCooksContainer(); }`) rather than one
 * that took an account endpoint — WHICH database and container are read is fixed
 * by the shared adapter's config, not chosen by the caller. The seam keeps these
 * tests offline while preserving the route-to-handler wiring a caller uses.
 */
import type { HttpRequest, InvocationContext } from '@azure/functions';

interface HttpRegistration {
  methods: string[];
  authLevel?: string;
  route?: string;
  handler: (request: HttpRequest, context: InvocationContext) => Promise<unknown>;
}

interface CosmosHealthProbeFactory {
  (): { readDatabase(): Promise<void>; readCooksContainer(): Promise<void> };
}

const registrations: Record<string, HttpRegistration> = {};
const ENDPOINT = 'https://mgv2dev.documents.azure.com/';
const DATABASE = 'terraform-published-database-name';
const COOKS_CONTAINER = 'cooks';

jest.mock('@azure/functions', () => {
  const actual = jest.requireActual('@azure/functions');
  return {
    ...actual,
    app: {
      http: (name: string, registration: HttpRegistration) => {
        registrations[name] = registration;
      },
      // main.ts also registers the MG-58 host-storage heartbeat timer. This
      // suite asserts the Cosmos health ROUTE, so the registration is swallowed
      // rather than captured — but the stub must exist, or importing main.ts
      // throws before health/cosmos is registered. The timer's own wiring is
      // asserted in functions/health/storage-heartbeat.spec.ts.
      timer: () => undefined,
    },
  };
});

function loadRegisteredHealth(env: Record<string, string | undefined>): HttpRegistration {
  jest.resetModules();
  for (const key of [
    'COSMOSDB__accountEndpoint',
    'COSMOSDB_DATABASE_NAME',
    'COSMOSDB_COOKS_CONTAINER_NAME',
  ]) {
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // Importing main is the Functions v4 registration path. The shared Cosmos
  // adapter initialises LAZILY (MG-59 FIX 1): importing it — and therefore
  // main.ts — reads no config, builds no client, and throws NOTHING even when a
  // setting is absent, so a handler/registration spec can import the app without
  // the Cosmos env. The MG-51 fail-loud guard still fires, but on FIRST USE inside
  // a request, where it surfaces as an unhealthy 503 (see the missing-config
  // tests below) rather than a wrong-name route silently registering.
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  require('../main');
  return registrations['cosmosHealth'];
}

function context(invocationId = 'cosmos-health-integration'): InvocationContext {
  return {
    invocationId,
    log: jest.fn(),
    error: jest.fn(),
  } as unknown as InvocationContext;
}

function invoke(
  registration: HttpRegistration,
  probeFactory: CosmosHealthProbeFactory,
  invocationContext = context()
) {
  // Azure supplies two arguments; the optional third parameter is the shipped
  // offline seam. Calling the registered function (rather than importing its
  // handler) proves main.ts did not point the route at different code.
  const handler = registration.handler as unknown as (
    request: HttpRequest,
    context: InvocationContext,
    factory: CosmosHealthProbeFactory
  ) => Promise<{ status: number; jsonBody: Record<string, unknown> }>;
  return handler({} as HttpRequest, invocationContext, probeFactory);
}

describe('MG-51 / MG-59: GET /health/cosmos registered Function App contract', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    for (const key of Object.keys(registrations)) {
      delete registrations[key];
    }
  });

  it('registers the anonymous GET health/cosmos trigger and returns 200 after read-only database + cooks probes', async () => {
    const registration = loadRegisteredHealth({
      COSMOSDB__accountEndpoint: ENDPOINT,
      COSMOSDB_DATABASE_NAME: DATABASE,
      COSMOSDB_COOKS_CONTAINER_NAME: COOKS_CONTAINER,
    });
    const probed: string[] = [];
    const invocationContext = context('healthy-request');

    expect(registration).toMatchObject({
      methods: ['GET'],
      authLevel: 'anonymous',
      route: 'health/cosmos',
    });

    const response = await invoke(
      registration,
      () => ({
        readDatabase: async () => {
          probed.push('database');
        },
        readCooksContainer: async () => {
          probed.push('cooks-container');
        },
      }),
      invocationContext
    );

    // Both metadata reads are exercised — the probe shares the handlers' path to
    // the database AND the cooks container.
    expect(probed).toEqual(['database', 'cooks-container']);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({
      status: 'healthy',
      requestId: 'healthy-request',
    });
    // The route the Functions host actually serves must not hand a caller the
    // account it dialled, the database, or the container it read.
    const body = JSON.stringify(response.jsonBody);
    expect(body).not.toContain(ENDPOINT);
    expect(body).not.toContain(DATABASE);
  });

  it.each([
    ['Cosmos is unreachable', `connect ECONNREFUSED ${ENDPOINT}`, undefined],
    ['the configured database is absent', `Owner resource ${DATABASE} does not exist`, 404],
    [
      'managed identity token acquisition fails',
      'managed identity token request failed: 401 Unauthorized, X-IDENTITY-HEADER=1a2b3c4d',
      401,
    ],
  ])('returns 503 without disclosing anything when %s', async (_scenario, failure, statusCode) => {
    const registration = loadRegisteredHealth({
      COSMOSDB__accountEndpoint: ENDPOINT,
      COSMOSDB_DATABASE_NAME: DATABASE,
      COSMOSDB_COOKS_CONTAINER_NAME: COOKS_CONTAINER,
    });
    const invocationContext = context();

    const response = await invoke(
      registration,
      () => ({
        readDatabase: async () => {
          throw Object.assign(new Error(failure), statusCode === undefined ? {} : { statusCode });
        },
        readCooksContainer: async () => undefined,
      }),
      invocationContext
    );

    expect(response.status).toBe(503);
    expect(response.jsonBody).toMatchObject({
      status: 'unhealthy',
      error: 'cosmos_probe_failed',
      ...(statusCode === undefined ? {} : { probeStatusCode: statusCode }),
    });

    const logged = (invocationContext.error as jest.Mock).mock.calls.flat().map(String).join('\n');
    for (const disclosure of [failure, ENDPOINT, DATABASE, '1a2b3c4d']) {
      expect(JSON.stringify(response.jsonBody)).not.toContain(disclosure);
      expect(logged).not.toContain(disclosure);
    }
    expect(logged).toContain('cosmos_probe_failed');
  });

  // MG-59 FIX 1: importing main.ts (the registration path) must NOT throw when a
  // Cosmos setting is missing — the adapter is lazy. The fail-loud guard instead
  // fires on the first request that reaches Cosmos, surfacing as an unhealthy 503
  // whose fixed config code names the missing setting (never its value). These two
  // tests drive the REAL adapter-backed probe (no injected seam) so the adapter's
  // own guard runs, and assert both halves: the import is inert, and the
  // per-request failure is loud but sanitized.
  function invokeWithRealProbe(registration: HttpRegistration) {
    const handler = registration.handler as unknown as (
      request: HttpRequest,
      context: InvocationContext
    ) => Promise<{ status: number; jsonBody: Record<string, unknown> }>;
    return handler({} as HttpRequest, context());
  }

  it('registers health/cosmos even with a missing database setting; a request returns a sanitized unhealthy 503', async () => {
    let registration: HttpRegistration | undefined;
    expect(() => {
      registration = loadRegisteredHealth({
        COSMOSDB__accountEndpoint: ENDPOINT,
        COSMOSDB_DATABASE_NAME: undefined,
        COSMOSDB_COOKS_CONTAINER_NAME: COOKS_CONTAINER,
      });
    }).not.toThrow();
    // The route IS registered — the app boots — but the guard has not yet fired.
    expect(registration).toBeDefined();

    const response = await invokeWithRealProbe(registration!);

    expect(response.status).toBe(503);
    expect(response.jsonBody).toMatchObject({
      status: 'unhealthy',
      error: 'cosmos_database_name_not_configured',
    });
    // The fixed code names the setting, never a resolved value.
    const body = JSON.stringify(response.jsonBody);
    expect(body).not.toContain(ENDPOINT);
    expect(body).not.toContain(COOKS_CONTAINER);
  });

  it('registers health/cosmos even with a missing cooks container setting; a request returns a sanitized unhealthy 503', async () => {
    let registration: HttpRegistration | undefined;
    expect(() => {
      registration = loadRegisteredHealth({
        COSMOSDB__accountEndpoint: ENDPOINT,
        COSMOSDB_DATABASE_NAME: DATABASE,
        COSMOSDB_COOKS_CONTAINER_NAME: undefined,
      });
    }).not.toThrow();
    expect(registration).toBeDefined();

    const response = await invokeWithRealProbe(registration!);

    expect(response.status).toBe(503);
    expect(response.jsonBody).toMatchObject({
      status: 'unhealthy',
      error: 'cosmos_cooks_container_not_configured',
    });
    const body = JSON.stringify(response.jsonBody);
    expect(body).not.toContain(ENDPOINT);
    expect(body).not.toContain(DATABASE);
  });
});
