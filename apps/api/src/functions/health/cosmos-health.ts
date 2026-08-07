import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import { CosmosClient } from '@azure/cosmos';

import { environment } from '../../environments/environment';
import type { HealthStatus } from '@meatgeekv2/api-interfaces';

/**
 * MG-51 — dev health check for the API's OWN path to Cosmos.
 *
 * The IoT Hub ingest path writes to Cosmos through an Azure routing endpoint
 * configured entirely in Terraform. This path — API code, reading app settings,
 * opening its own client — shares NO code with it. That is why an ingest-path
 * check was GREEN throughout the outage this ticket fixes: the API was pointed
 * at `meatgeek-dev`, a database that has never existed, and nothing exercised
 * it. So this check deliberately resolves configuration the way a request
 * handler does (`environment.cosmosDb`, the app settings Terraform publishes)
 * and then actually talks to Cosmos. A check that asserted the settings were
 * present without dialling would have missed a name that is set but wrong.
 *
 * `database(...).read()` is a metadata read of the database itself: it is the
 * cheapest call that can only succeed if the account is reachable, the identity
 * holds a data-plane role, AND the configured database exists. It creates
 * nothing and touches no container.
 *
 * What it deliberately does NOT report: the account endpoint, the database name,
 * or any text a dependency produced. The 200/503 plus a fixed failure code is
 * the entire signal; a caller that is entitled to know which database is
 * configured reads it from the Function App's settings.
 */

/** The one Cosmos operation this check performs, behind a seam. */
export interface CosmosDatabaseProbe {
  readDatabase(databaseName: string): Promise<void>;
}

export type CosmosProbeFactory = (accountEndpoint: string) => CosmosDatabaseProbe;

/**
 * The only failure vocabulary this check speaks. Each code names the STEP that
 * failed, chosen by control flow — never derived from a dependency's error text.
 * A Cosmos or managed-identity error can carry token fragments, the
 * X-IDENTITY-HEADER, internal URLs or the account host, and this endpoint must
 * put none of that in a response body or a log line.
 */
export type CosmosHealthFailure =
  | 'cosmos_database_name_not_configured'
  | 'cosmos_account_endpoint_not_configured'
  | 'cosmos_probe_failed';

export interface CosmosHealthResult extends HealthStatus {
  error?: CosmosHealthFailure;
  /**
   * The numeric HTTP status the dependency reported, when it reported one. This
   * is the whole diagnostic budget for a failure: 404 says the configured
   * database is absent, 403 says the identity lacks its data-plane role, 401
   * says the token was refused. A number cannot carry an identifier.
   */
  probeStatusCode?: number;
}

/**
 * App Service / Functions managed-identity token endpoint. The Function App has
 * no Cosmos key to fall back on — MG-24 removed every key output — so this is
 * the only credential the app has. `@azure/identity` would supply this, but it
 * is not a dependency of this workspace; the IDENTITY_ENDPOINT contract it would
 * use here is a documented, stable HTTP interface.
 */
function managedIdentityCredential() {
  const identityEndpoint = process.env['IDENTITY_ENDPOINT'];
  const identityHeader = process.env['IDENTITY_HEADER'];

  return {
    async getToken(scopes: string | string[]) {
      if (!identityEndpoint || !identityHeader) {
        throw new Error(
          'IDENTITY_ENDPOINT/IDENTITY_HEADER are unset — the Function App has no managed identity available, and there is no key fallback (MG-24 removed them)'
        );
      }

      // Cosmos asks for `<endpoint>/.default`; the App Service token endpoint
      // takes the bare audience.
      const scope = Array.isArray(scopes) ? scopes[0] : scopes;
      const resource = scope.replace(/\/\.default$/, '');

      const url = `${identityEndpoint}?api-version=2019-08-01&resource=${encodeURIComponent(resource)}`;
      const response = await fetch(url, { headers: { 'X-IDENTITY-HEADER': identityHeader } });
      if (!response.ok) {
        throw new Error(
          `managed identity token request failed: ${response.status} ${response.statusText}`
        );
      }

      const body = (await response.json()) as { access_token: string; expires_on: string };
      // expires_on is epoch seconds on Linux hosts and a date string on Windows.
      const expiresOn = Number(body.expires_on);
      return {
        token: body.access_token,
        expiresOnTimestamp: Number.isNaN(expiresOn)
          ? Date.parse(body.expires_on)
          : expiresOn * 1000,
      };
    },
  };
}

const realCosmosProbe: CosmosProbeFactory = accountEndpoint => {
  const client = new CosmosClient({
    endpoint: accountEndpoint,
    aadCredentials: managedIdentityCredential(),
  });

  return {
    async readDatabase(databaseName: string) {
      await client.database(databaseName).read();
    },
  };
};

/**
 * Terraform publishes the account endpoint as `COSMOSDB__accountEndpoint` (the
 * Functions host resolves that form for identity-based bindings) and the
 * database name as `COSMOSDB_DATABASE_NAME`, which the app reads itself via
 * `environment.cosmosDb`. Reading the name through `environment` rather than
 * `process.env` here is the point: it is the exact resolution a handler gets,
 * including its refusal to invent a default.
 */
export async function checkCosmosHealth(
  probeFactory: CosmosProbeFactory = realCosmosProbe
): Promise<CosmosHealthResult> {
  const startedAt = Date.now();
  const unhealthy = (error: CosmosHealthFailure, probeStatusCode?: number): CosmosHealthResult => ({
    status: 'unhealthy',
    responseTime: Date.now() - startedAt,
    error,
    ...(probeStatusCode === undefined ? {} : { probeStatusCode }),
  });

  // Resolving `environment` can itself throw when infrastructure never set
  // COSMOSDB_DATABASE_NAME — that is the MG-51 failure, and reporting it as
  // unhealthy here is what makes it visible from a health check rather than
  // from a user-facing 404 much later.
  let databaseName: string;
  try {
    databaseName = environment.cosmosDb.databaseName;
  } catch {
    return unhealthy('cosmos_database_name_not_configured');
  }

  const accountEndpoint = process.env['COSMOSDB__accountEndpoint'] ?? '';
  if (!accountEndpoint) {
    return unhealthy('cosmos_account_endpoint_not_configured');
  }

  try {
    await probeFactory(accountEndpoint).readDatabase(databaseName);
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
  probeFactory?: CosmosProbeFactory
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
  // account and database are read from the Function App's settings by whoever
  // is entitled to them, not served from here.
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
