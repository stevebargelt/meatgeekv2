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
    // exact misconfiguration this ticket exists to catch.
    expect(probed).toEqual([TF_DATABASE_NAME]);
    expect(result.status).toBe('healthy');
    expect(result.details.databaseName).toBe(TF_DATABASE_NAME);
  });

  it('reports UNHEALTHY when the configured database does not exist (the MG-51 failure)', async () => {
    const { checkCosmosHealth } = loadHealthModule({
      [ENDPOINT_SETTING]: 'https://mgv2dev.documents.azure.com/',
      [DATABASE_SETTING]: 'meatgeek-dev',
    });

    const result = await checkCosmosHealth(
      probeThat(async () => {
        throw new Error('Entity with the specified id does not exist in the system., 404');
      })
    );

    expect(result.status).toBe('unhealthy');
    expect(result.error).toContain('404');
    expect(result.details.databaseName).toBe('meatgeek-dev');
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
    expect(result.error).toContain(ENDPOINT_SETTING);
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
});
