/**
 * MG-51 / MG-59 — the check that would have caught the outage, now refactored
 * onto the ONE shared Cosmos adapter.
 *
 * The Function App received no COSMOSDB_DATABASE_NAME, so the API fell back to
 * `meatgeek-dev`, a database that has never existed, while an IoT-ingest health
 * check stayed GREEN. MG-59 closes the last gap: the probe no longer builds its
 * own CosmosClient or hand-rolls an IDENTITY_ENDPOINT token fetch — it reaches
 * Cosmos ONLY through `getCosmosAdapter`, the same shared client, credential,
 * database, and cooks container the cooks handlers use. These tests hold that
 * property and the sanitization invariants, running with NO Azure and NO
 * credentials by injecting the probe/adapter seams.
 *
 * The adapter fails LOUD at module load on missing config, so importing this
 * module requires the three settings to be present — that IS the contract. Each
 * case therefore sets a fully-valid env before `require`, exactly as the adapter
 * spec does, and exercises the missing-config path through the adapter's own
 * `CosmosConfigError` rather than by un-setting env at import.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { CosmosHealthProbe, CosmosHealthProbeFactory } from './cosmos-health';

const ENDPOINT_SETTING = 'COSMOSDB__accountEndpoint';
const DATABASE_SETTING = 'COSMOSDB_DATABASE_NAME';
const COOKS_CONTAINER_SETTING = 'COSMOSDB_COOKS_CONTAINER_NAME';

// Realistic-shaped values used ONLY to prove they never surface in a body or a
// log line. The account host and database name are the sensitive identifiers.
const ACCOUNT_ENDPOINT = 'https://mgv2dev.documents.azure.com/';
const DATABASE_NAME = 'meatgeek-v2-dev-db';
const COOKS_CONTAINER = 'cooks';

const VALID_ENV: Record<string, string | undefined> = {
  [ENDPOINT_SETTING]: ACCOUNT_ENDPOINT,
  [DATABASE_SETTING]: DATABASE_NAME,
  [COOKS_CONTAINER_SETTING]: COOKS_CONTAINER,
};

/**
 * Re-imports the health module (and the adapter it pulls in) under a given env.
 * Both come from the SAME fresh registry, so a `CosmosConfigError` the test
 * constructs from the returned adapter passes `instanceof` inside the handler.
 */
function loadHealthModule(env: Record<string, string | undefined> = VALID_ENV) {
  jest.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  const health = require('./cosmos-health') as typeof import('./cosmos-health');
  const adapter =
    require('../../shared/cosmos/cosmos-adapter') as typeof import('../../shared/cosmos/cosmos-adapter');
  return { health, adapter };
}

/** Builds a probe factory from optional read behaviours (default: both succeed). */
function probeThat(reads: Partial<CosmosHealthProbe>): CosmosHealthProbeFactory {
  return () => ({
    readDatabase: reads.readDatabase ?? (async () => undefined),
    readCooksContainer: reads.readCooksContainer ?? (async () => undefined),
  });
}

/**
 * A fake shared adapter that records read/create calls on the database and cooks
 * container handles — used to prove the DEFAULT probe path goes through the
 * shared adapter and is read-only.
 */
function fakeAdapterDouble() {
  const dbRead = jest.fn(async () => undefined);
  const dbCreate = jest.fn();
  const cooksRead = jest.fn(async () => undefined);
  const cooksCreate = jest.fn();
  const database = { read: dbRead, create: dbCreate };
  const cooksContainer = { read: cooksRead, create: cooksCreate };
  const adapter = {
    getDatabase: jest.fn(() => database),
    getCooksContainer: jest.fn(() => cooksContainer),
    getContainer: jest.fn(() => cooksContainer),
  };
  return { adapter, dbRead, dbCreate, cooksRead, cooksCreate };
}

describe('MG-59: the Cosmos health probe runs through the ONE shared adapter', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.resetModules();
  });

  it('probes the shared adapter database AND cooks container, read-only, creating nothing', async () => {
    const { health, adapter } = loadHealthModule();
    const double = fakeAdapterDouble();
    // Install the fake as the shared singleton, then run the DEFAULT factory —
    // proving the probe reaches Cosmos through getCosmosAdapter, not its own client.
    adapter.__setSharedAdapterForTesting(double.adapter as never);

    const result = await health.checkCosmosHealth();

    expect(double.adapter.getDatabase).toHaveBeenCalledTimes(1);
    expect(double.adapter.getCooksContainer).toHaveBeenCalledTimes(1);
    expect(double.dbRead).toHaveBeenCalledTimes(1);
    expect(double.cooksRead).toHaveBeenCalledTimes(1);
    // Read-only: neither handle is asked to create anything.
    expect(double.dbCreate).not.toHaveBeenCalled();
    expect(double.cooksCreate).not.toHaveBeenCalled();
    expect(result.status).toBe('healthy');

    adapter.__setSharedAdapterForTesting(undefined);
  });

  it.each([
    [ENDPOINT_SETTING, 'cosmos_account_endpoint_not_configured'],
    [DATABASE_SETTING, 'cosmos_database_name_not_configured'],
    [COOKS_CONTAINER_SETTING, 'cosmos_cooks_container_not_configured'],
  ])(
    'surfaces a missing %s as unhealthy through the adapter fail-loud guard, without dialling',
    async (missingSetting, expectedCode) => {
      const { health, adapter } = loadHealthModule();

      // The adapter's guard is the SAME one the handlers hit. When it rejects a
      // missing/blank setting the check maps its code — it never dials Cosmos.
      const factory: CosmosHealthProbeFactory = () => {
        throw new adapter.CosmosConfigError(missingSetting);
      };

      const result = await health.checkCosmosHealth(factory);

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe(expectedCode);
      expect(result.probeStatusCode).toBeUndefined();
    }
  );

  it('reports UNHEALTHY with a numeric status when the database metadata read fails (MG-51 failure)', async () => {
    const { health } = loadHealthModule();

    const result = await health.checkCosmosHealth(
      probeThat({
        readDatabase: async () => {
          throw Object.assign(
            new Error('Entity with the specified id does not exist in the system., 404'),
            { code: 404 }
          );
        },
      })
    );

    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('cosmos_probe_failed');
    // 404 separates "database absent" from "identity refused" — a number, so it
    // carries nothing an account can be named by.
    expect(result.probeStatusCode).toBe(404);
  });

  it('reports UNHEALTHY when the cooks container is absent even though the database reads', async () => {
    const { health } = loadHealthModule();
    const dbRead = jest.fn(async () => undefined);

    const result = await health.checkCosmosHealth(
      probeThat({
        readDatabase: dbRead,
        readCooksContainer: async () => {
          throw Object.assign(new Error('Owner resource does not exist, 404'), { statusCode: 404 });
        },
      })
    );

    // The database read must have been attempted; the container is the second gate.
    expect(dbRead).toHaveBeenCalledTimes(1);
    expect(result.status).toBe('unhealthy');
    expect(result.error).toBe('cosmos_probe_failed');
    expect(result.probeStatusCode).toBe(404);
  });

  it('answers 200 when healthy and 503 when not, so a caller can gate on the status code', async () => {
    const { health } = loadHealthModule();
    const context = { log: jest.fn(), error: jest.fn(), invocationId: 'inv-1' };

    const failing = await health.cosmosHealthHandler(
      {} as never,
      context as never,
      probeThat({
        readDatabase: async () => {
          throw new Error('Owner resource does not exist, 404');
        },
      })
    );
    expect(failing.status).toBe(503);
    expect(context.error).toHaveBeenCalled();

    const ok = await health.cosmosHealthHandler({} as never, context as never, probeThat({}));
    expect(ok.status).toBe(200);
  });

  it('reaches Cosmos only through the shared adapter — no own client, no hand-rolled token fetch (source guard)', () => {
    const source = fs.readFileSync(path.join(__dirname, 'cosmos-health.ts'), 'utf8');
    // The hand-rolled managed-identity fetch and its own client are gone.
    expect(source).not.toContain('IDENTITY_ENDPOINT');
    expect(source).not.toContain('IDENTITY_HEADER');
    expect(source).not.toContain('X-IDENTITY-HEADER');
    expect(source).not.toContain('managedIdentityCredential');
    expect(source).not.toContain('aadCredentials');
    expect(source).not.toMatch(/new\s+CosmosClient/);
    expect(source).not.toMatch(/from\s*'@azure\/cosmos'/);
    // Config no longer flows through environment.cosmosDb; it flows through the adapter.
    expect(source).not.toContain('environments/environment');
    // It DOES reach Cosmos through the shared adapter.
    expect(source).toContain('getCosmosAdapter');
  });

  /**
   * The endpoint sits behind Easy Auth, which is mitigation, not compliance: an
   * authenticated caller must still not read the Cosmos account, database, or
   * container identifier out of the body, and neither must the log stream.
   */
  describe('discloses no connection detail, account identifier, or dependency error text', () => {
    /** A dependency error shaped like the ones this invariant exists for. */
    const leakyFailure = Object.assign(
      new Error(
        `Failed to read database ${DATABASE_NAME} at ${ACCOUNT_ENDPOINT}: ` +
          'X-IDENTITY-HEADER=1a2b3c4d, Authorization=Bearer eyJ0eXAiOiJKV1Qi.leaked, ' +
          'endpoint http://169.254.130.2/msi/token'
      ),
      { statusCode: 403 }
    );

    const forbidden = [
      DATABASE_NAME,
      ACCOUNT_ENDPOINT,
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

    it('serves a healthy body with no account endpoint, database name, or container name', async () => {
      const { health } = loadHealthModule();
      const context = { log: jest.fn(), error: jest.fn(), invocationId: 'inv-healthy' };

      const response = await health.cosmosHealthHandler(
        {} as never,
        context as never,
        probeThat({})
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
      const { health } = loadHealthModule();
      const context = { log: jest.fn(), error: jest.fn(), invocationId: 'inv-leak' };

      const response = await health.cosmosHealthHandler(
        {} as never,
        context as never,
        probeThat({
          readCooksContainer: async () => {
            throw leakyFailure;
          },
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

    it('answers with a code, not the configuration error text, when a setting will not resolve', async () => {
      const { health, adapter } = loadHealthModule();

      // The adapter's fail-loud guard names only the setting, never a value. The
      // health check reports only its own code — no message text reaches out.
      const result = await health.checkCosmosHealth(() => {
        throw new adapter.CosmosConfigError(DATABASE_SETTING);
      });

      expect(result.status).toBe('unhealthy');
      expect(result.error).toBe('cosmos_database_name_not_configured');
      expectNothingLeaked(JSON.stringify(result));
    });
  });
});
