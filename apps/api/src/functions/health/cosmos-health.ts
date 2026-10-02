import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import type { HealthStatus } from '@meatgeekv2/api-interfaces';
import {
  CosmosConfigError,
  type CosmosConfigFailure,
  getCosmosAdapter,
} from '../../shared/cosmos/cosmos-adapter';

/**
 * MG-51 / MG-59 — health check for the API's OWN path to Cosmos.
 *
 * The IoT Hub ingest path writes to Cosmos through an Azure routing endpoint
 * configured entirely in Terraform. This path — API code, reading app settings,
 * opening its own client — shares NO code with it. That is why an ingest-path
 * check was GREEN throughout the MG-51 outage: the API was pointed at
 * `meatgeek-dev`, a database that has never existed, and nothing exercised it.
 *
 * MG-59 removes the last way this probe could drift from the handlers: it no
 * longer builds its own CosmosClient and no longer hand-rolls a managed-identity
 * token fetch against the instance-metadata endpoint. It reaches Cosmos through
 * the ONE shared adapter every cooks handler uses (`getCosmosAdapter`), so the
 * client, the managed-identity credential, the database, and the cooks
 * container it exercises are — by
 * construction — the exact ones a request handler exercises. A green health
 * check can no longer share zero code with the real path.
 *
 * `database(...).read()` and `container(...).read()` are metadata reads: the
 * cheapest calls that can only succeed if the account is reachable, the identity
 * holds a data-plane role, AND the configured database and cooks container exist.
 * They create nothing and write nothing.
 *
 * What it deliberately does NOT report: the account endpoint, the database name,
 * the container name, or any text a dependency produced. The 200/503 plus a
 * fixed failure code is the entire signal; a caller entitled to know which
 * database or container is configured reads it from the Function App's settings.
 */

/**
 * The two read-only metadata reads this check performs, behind a seam. Both are
 * no-argument: WHICH database and container are read is fixed by the shared
 * adapter's configuration, not chosen by the caller — so a probe cannot be
 * pointed at a name of its own and stay green through the misconfiguration this
 * check exists to catch.
 */
export interface CosmosHealthProbe {
  /** Metadata read of the configured database. Creates nothing. */
  readDatabase(): Promise<void>;
  /** Metadata read of the configured cooks container. Creates nothing. */
  readCooksContainer(): Promise<void>;
}

/**
 * Builds the probe. The default factory binds the SHARED adapter, so the probe
 * dials Cosmos through the exact client, credential, database, and cooks
 * container a cooks handler uses. It MAY throw `CosmosConfigError` — the shared
 * adapter's fail-loud config guard, the same one the handlers hit — which
 * `checkCosmosHealth` maps to an unhealthy result rather than letting it crash
 * the request.
 */
export type CosmosHealthProbeFactory = () => CosmosHealthProbe;

/**
 * Production seam. Reaches Cosmos ONLY through the shared adapter: no separately
 * constructed CosmosClient, no hand-rolled managed-identity token fetch. The
 * adapter's credential is a ManagedIdentityCredential in the deployed Function
 * (never DefaultAzureCredential), built once and reused across warm invocations.
 */
const sharedAdapterProbe: CosmosHealthProbeFactory = () => {
  const adapter = getCosmosAdapter();
  return {
    async readDatabase() {
      await adapter.getDatabase().read();
    },
    async readCooksContainer() {
      await adapter.getCooksContainer().read();
    },
  };
};

/**
 * The only failure vocabulary this check speaks. The three configuration codes
 * are reused verbatim from the shared adapter's guard, so the health check and
 * the handlers name a missing setting the same way. Each code names the STEP
 * that failed, chosen by control flow — never derived from a dependency's error
 * text. A Cosmos or managed-identity error can carry token fragments, an
 * identity header, internal URLs or the account host, and this endpoint must
 * put none of that in a response body or a log line.
 */
export type CosmosHealthFailure = CosmosConfigFailure | 'cosmos_probe_failed';

export interface CosmosHealthResult extends HealthStatus {
  error?: CosmosHealthFailure;
  /**
   * The numeric HTTP status the dependency reported, when it reported one. This
   * is the whole diagnostic budget for a failure: 404 says the configured
   * database or container is absent, 403 says the identity lacks its data-plane
   * role, 401 says the token was refused. A number cannot carry an identifier.
   */
  probeStatusCode?: number;
}

/**
 * Runs the read-only probe and maps every outcome to a sanitized result. Missing
 * configuration surfaces as unhealthy through the SAME `CosmosConfigError` guard
 * the handlers hit — its `.code` (a fixed vocabulary that names only the setting,
 * never its value) becomes the health failure code. A dependency failure becomes
 * `cosmos_probe_failed` plus a numeric status and nothing else.
 */
export async function checkCosmosHealth(
  probeFactory: CosmosHealthProbeFactory = sharedAdapterProbe
): Promise<CosmosHealthResult> {
  const startedAt = Date.now();
  const unhealthy = (error: CosmosHealthFailure, probeStatusCode?: number): CosmosHealthResult => ({
    status: 'unhealthy',
    responseTime: Date.now() - startedAt,
    error,
    ...(probeStatusCode === undefined ? {} : { probeStatusCode }),
  });

  let probe: CosmosHealthProbe;
  try {
    // Acquiring the adapter runs its fail-loud config guard. On a Function App
    // that never received a setting this throws CosmosConfigError, whose code
    // names the missing setting (not its value) — reporting it as unhealthy is
    // what makes an MG-51-class misconfiguration visible from a health check
    // rather than from a user-facing 404 much later.
    probe = probeFactory();
  } catch (error) {
    if (error instanceof CosmosConfigError) {
      return unhealthy(error.code);
    }
    return unhealthy('cosmos_probe_failed', dependencyStatusCode(error));
  }

  try {
    // Read-only metadata reads of the database AND the cooks container the
    // handlers use. Both must answer for the API's Cosmos path to be healthy;
    // neither creates anything.
    await probe.readDatabase();
    await probe.readCooksContainer();
  } catch (error) {
    return unhealthy('cosmos_probe_failed', dependencyStatusCode(error));
  }

  return {
    status: 'healthy',
    responseTime: Date.now() - startedAt,
  };
}

/** Numbers only — anything the dependency phrased as text is discarded here. */
function dependencyStatusCode(error: unknown): number | undefined {
  const reported = error as { statusCode?: unknown; code?: unknown } | null | undefined;
  for (const value of [reported?.statusCode, reported?.code]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

export async function cosmosHealthHandler(
  _request: HttpRequest,
  context: InvocationContext,
  probeFactory?: CosmosHealthProbeFactory
): Promise<HttpResponseInit> {
  context.log('Processing cosmos health check');

  const result = await checkCosmosHealth(probeFactory);

  if (result.status !== 'healthy') {
    // `result.error` is a fixed code and `probeStatusCode` a number, so this log
    // line cannot carry a token, an identity header, or an account identifier.
    context.error(
      `Cosmos health check failed: ${result.error}` +
        (result.probeStatusCode === undefined ? '' : ` (status ${result.probeStatusCode})`)
    );
  }

  // Projected field by field rather than spread: the response body is an
  // allowlist, so a field added to CosmosHealthResult later cannot reach a
  // caller by accident. The 200/503 carries the health signal; the configured
  // account, database, and container are read from the Function App's settings
  // by whoever is entitled to them, not served from here.
  return {
    status: result.status === 'healthy' ? 200 : 503,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': context.invocationId,
    },
    jsonBody: {
      status: result.status,
      responseTime: result.responseTime,
      error: result.error,
      probeStatusCode: result.probeStatusCode,
      requestId: context.invocationId,
    },
  };
}
