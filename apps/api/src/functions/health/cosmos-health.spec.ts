/**
 * MG-51 — the check that would have caught the outage.
 *
 * The Function App received no COSMOSDB_DATABASE_NAME, so the API fell back to
 * `meatgeek-dev`, a database that has never existed, while an IoT-ingest health
 * check stayed GREEN. These tests hold the two properties that make this probe
 * worth having: it reads the database name from the API's OWN configuration
 * (not a literal of its own), and it reports UNHEALTHY when Cosmos says that
 * database is not there.
 *
 * The Cosmos client is injected — the same seam the cosmos-export tool uses — so
 * the failure paths, which are the product here, run with no Azure and no
 * credentials.
 */
import type { CosmosProbeFactory } from './cosmos-health';

const ENDPOINT_SETTING = 'COSMOSDB__accountEndpoint';
const DATABASE_SETTING = 'COSMOSDB_DATABASE_NAME';
const TF_DATABASE_NAME = 'meatgeek-v2-dev-db';

/**
 * `environment` reads process.env once, at module load, so each case builds its
 * own module registry rather than mutating a resolved config object.
 */
function loadHealthModule(env: Record<string, string | undefined>) {
  jest.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return require('./cosmos-health') as typeof import('./cosmos-health');
}

function probeThat(readDatabase: (name: string) => Promise<void>): CosmosProbeFactory {
  return () => ({ readDatabase });
}

describe("MG-51: the API path to Cosmos is health-checked through the API's own configuration", () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
  });

  it('probes the database name the app is CONFIGURED with, not one of its own', async () => {
    const probed: string[] = [];
    const { checkCosmosHealth } = loadHealthModule({
      [ENDPOINT_SETTING]: 'https://mgv2dev.documents.azure.com/',
      [DATABASE_SETTING]: TF_DATABASE_NAME,
    });

    const result = await checkCosmosHealth(
      probeThat(async name => {
        probed.push(name);
      })
    );

    // A probe that spelled a database name itself would stay green through the
    // exact misconfiguration this ticket exists to catch. What the probe was
    // ASKED for is the proof — the result deliberately does not restate it.
    expect(probed).toEqual([TF_DATABASE_NAME]);
    expect(result.status).toBe('healthy');
  });

  it('reports UNHEALTHY when the configured database does not exist (the MG-51 failure)', async () => {
    const { checkCosmosHealth } = loadHealthModule({
      [ENDPOINT_SETTING]: 'https://mgv2dev.documents.azure.com/',
      [DATABASE_SETTING]: 'meatgeek-dev',
    });

    const result = await checkCosmosHealth(
      probeThat(async () => {
        throw Object.assign(
          new Error('Entity with the specified id does not exist in the system., 404'),
          { code: 404 }
        );
      })
    );

    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('cosmos_probe_failed');
    // 404 is the diagnostic that separates "database absent" from "identity
    // refused" — a number, so it carries nothing an account can be named by.
    expect(result.probeStatusCode).toBe(404);
  });

  it('reports UNHEALTHY when the account endpoint setting is missing', async () => {
    const { checkCosmosHealth } = loadHealthModule({
      [ENDPOINT_SETTING]: undefined,
      [DATABASE_SETTING]: TF_DATABASE_NAME,
    });

    let dialled = false;
    const result = await checkCosmosHealth(
      probeThat(async () => {
        dialled = true;
      })
    );

    expect(dialled).toBe(false);
    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('cosmos_account_endpoint_not_configured');
  });

  it('answers 200 when healthy and 503 when not, so a caller can gate on the status code', async () => {
    const { cosmosHealthHandler, checkCosmosHealth } = loadHealthModule({
      [ENDPOINT_SETTING]: 'https://mgv2dev.documents.azure.com/',
      [DATABASE_SETTING]: TF_DATABASE_NAME,
    });
    const context = { log: jest.fn(), error: jest.fn(), invocationId: 'inv-1' };

    const failing = await cosmosHealthHandler(
      {} as never,
      context as never,
      probeThat(async () => {
        throw new Error('Owner resource does not exist, 404');
      })
    );
    expect(failing.status).toBe(503);
    expect(context.error).toHaveBeenCalled();

    const ok = await cosmosHealthHandler(
      {} as never,
      context as never,
      probeThat(async () => undefined)
    );
    expect(ok.status).toBe(200);

    const healthy = await checkCosmosHealth(probeThat(async () => undefined));
    expect(healthy.status).toBe('healthy');
  });

  /**
   * The endpoint sits behind Easy Auth, which is mitigation, not compliance: an
   * authenticated caller must still not be able to read the Cosmos account or
   * database identifier out of the body, and neither must the log stream.
   */
  describe('discloses no connection detail, account identifier, or dependency error text', () => {
    const ENDPOINT = 'https://mgv2dev.documents.azure.com/';

    /** A dependency error shaped like the ones this invariant exists for. */
    const leakyFailure = Object.assign(
      new Error(
        `Failed to read database ${TF_DATABASE_NAME} at ${ENDPOINT}: ` +
          'X-IDENTITY-HEADER=1a2b3c4d, Authorization=Bearer eyJ0eXAiOiJKV1Qi.leaked, ' +
          'endpoint http://169.254.130.2/msi/token'
      ),
      { statusCode: 403 }
    );

    const forbidden = [
      TF_DATABASE_NAME,
      ENDPOINT,
      'mgv2dev',
      '1a2b3c4d',
      'eyJ0eXAiOiJKV1Qi',
      '169.254.130.2',
      'X-IDENTITY-HEADER',
      'Authorization',
    ];

    function expectNothingLeaked(text: string) {
      for (const secret of forbidden) {
        expect(text).not.toContain(secret);
      }
    }

    it('serves a healthy body with no account endpoint and no database name', async () => {
      const { cosmosHealthHandler } = loadHealthModule({
        [ENDPOINT_SETTING]: ENDPOINT,
        [DATABASE_SETTING]: TF_DATABASE_NAME,
      });
      const context = { log: jest.fn(), error: jest.fn(), invocationId: 'inv-healthy' };

      const response = await cosmosHealthHandler(
        {} as never,
        context as never,
        probeThat(async () => undefined)
      );

      expect(response.status).toBe(200);
      expectNothingLeaked(JSON.stringify(response.jsonBody));
      expect(response.jsonBody).toEqual({
        status: 'healthy',
        responseTime: expect.any(Number),
        error: undefined,
        probeStatusCode: undefined,
        requestId: 'inv-healthy',
      });
    });

    it('replaces a leaky dependency error with a fixed code in BOTH the body and the log', async () => {
      const { cosmosHealthHandler } = loadHealthModule({
        [ENDPOINT_SETTING]: ENDPOINT,
        [DATABASE_SETTING]: TF_DATABASE_NAME,
      });
      const context = { log: jest.fn(), error: jest.fn(), invocationId: 'inv-leak' };

      const response = await cosmosHealthHandler(
        {} as never,
        context as never,
        probeThat(async () => {
          throw leakyFailure;
        })
      );

      expect(response.status).toBe(503);
      expect(response.jsonBody).toMatchObject({
        status: 'unhealthy',
        error: 'cosmos_probe_failed',
        probeStatusCode: 403,
      });
      expectNothingLeaked(JSON.stringify(response.jsonBody));

      const logged = [...context.log.mock.calls, ...context.error.mock.calls]
        .flat()
        .map(String)
        .join('\n');
      expect(context.error).toHaveBeenCalled();
      expectNothingLeaked(logged);
      expect(logged).toContain('cosmos_probe_failed');
    });

    it('answers with a code, not the configuration error text, when the database name will not resolve', async () => {
      jest.resetModules();
      process.env[ENDPOINT_SETTING] = ENDPOINT;
      // The dev build's environment module refuses to invent a database name.
      // Whatever it says on the way out, this check reports only its own code.
      jest.doMock('../../environments/environment', () => ({
        environment: {
          get cosmosDb(): { databaseName: string } {
            throw new Error(
              `COSMOSDB_DATABASE_NAME is not set for ${ENDPOINT} — Terraform owns it. See MG-51.`
            );
          },
        },
      }));

      const { checkCosmosHealth } = require('./cosmos-health') as typeof import('./cosmos-health');
      let dialled = false;
      const result = await checkCosmosHealth(
        probeThat(async () => {
          dialled = true;
        })
      );

      jest.dontMock('../../environments/environment');

      expect(dialled).toBe(false);
      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('cosmos_database_name_not_configured');
      expectNothingLeaked(JSON.stringify(result));
    });
  });
});
