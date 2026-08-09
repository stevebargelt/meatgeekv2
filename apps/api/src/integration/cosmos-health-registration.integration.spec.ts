/**
 * MG-51 integration coverage: drive the Cosmos health probe through the handler
 * that main.ts registers with the Azure Functions host.  The probe seam keeps
 * these tests offline while preserving the route-to-handler wiring a caller uses.
 */
import type { HttpRequest, InvocationContext } from '@azure/functions';

interface HttpRegistration {
  methods: string[];
  authLevel?: string;
  route?: string;
  handler: (request: HttpRequest, context: InvocationContext) => Promise<unknown>;
}

interface CosmosProbeFactory {
  (accountEndpoint: string): { readDatabase(databaseName: string): Promise<void> };
}

const registrations: Record<string, HttpRegistration> = {};
const ENDPOINT = 'https://mgv2dev.documents.azure.com/';
const DATABASE = 'terraform-published-database-name';

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
  for (const key of ['COSMOSDB__accountEndpoint', 'COSMOSDB_DATABASE_NAME']) {
    const value = env[key];
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }

  // Jest does not apply Nx's webpack file replacement. Make the app registration
  // use the same development environment module that the dev Function App build
  // receives; otherwise this test would accidentally exercise environment.ts's
  // unrelated generic fallback instead of the MG-51 configuration contract.
  jest.doMock('../environments/environment', () =>
    require('../environments/environment.development')
  );

  // Importing main is the Functions v4 registration path.
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
  probeFactory: CosmosProbeFactory,
  invocationContext = context()
) {
  // Azure supplies two arguments; the optional third parameter is the shipped
  // offline seam. Calling the registered function (rather than importing its
  // handler) proves main.ts did not point the route at different code.
  const handler = registration.handler as unknown as (
    request: HttpRequest,
    context: InvocationContext,
    factory: CosmosProbeFactory
  ) => Promise<{ status: number; jsonBody: Record<string, unknown> }>;
  return handler({} as HttpRequest, invocationContext, probeFactory);
}

describe('MG-51: GET /health/cosmos registered Function App contract', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.dontMock('../environments/environment');
    for (const key of Object.keys(registrations)) {
      delete registrations[key];
    }
  });

  it("registers the anonymous GET health/cosmos trigger and returns 200 after probing Terraform's configured database", async () => {
    const registration = loadRegisteredHealth({
      COSMOSDB__accountEndpoint: ENDPOINT,
      COSMOSDB_DATABASE_NAME: DATABASE,
    });
    const probed: Array<[string, string]> = [];
    const invocationContext = context('healthy-request');

    expect(registration).toMatchObject({
      methods: ['GET'],
      authLevel: 'anonymous',
      route: 'health/cosmos',
    });

    const response = await invoke(
      registration,
      endpoint => ({
        readDatabase: async databaseName => {
          probed.push([endpoint, databaseName]);
        },
      }),
      invocationContext
    );

    expect(probed).toEqual([[ENDPOINT, DATABASE]]);
    expect(response.status).toBe(200);
    expect(response.jsonBody).toMatchObject({
      status: 'healthy',
      requestId: 'healthy-request',
    });
    // The route the Functions host actually serves must not hand a caller the
    // account it dialled or the database it read.
    expect(JSON.stringify(response.jsonBody)).not.toContain(ENDPOINT);
    expect(JSON.stringify(response.jsonBody)).not.toContain(DATABASE);
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
    });
    const invocationContext = context();

    const response = await invoke(
      registration,
      () => ({
        readDatabase: async () => {
          throw Object.assign(new Error(failure), statusCode === undefined ? {} : { statusCode });
        },
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

  it('refuses to register with a missing database setting rather than registering a route with a default', () => {
    expect(() =>
      loadRegisteredHealth({
        COSMOSDB__accountEndpoint: ENDPOINT,
        COSMOSDB_DATABASE_NAME: undefined,
      })
    ).toThrow(/COSMOSDB_DATABASE_NAME.*Terraform/);
    expect(registrations['cosmosHealth']).toBeUndefined();
  });
});
