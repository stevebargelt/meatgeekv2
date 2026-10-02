import { Container, CosmosClient, Database } from '@azure/cosmos';
import { ManagedIdentityCredential } from '@azure/identity';
import type { TokenCredential } from '@azure/core-auth';

/**
 * MG-59 — the ONE shared Cosmos adapter.
 *
 * The V2 API has never persisted anything: the old libs/azure-client shell
 * hand-rolled a class named CosmosClient that never dialled Cosmos and whose
 * healthCheck() returned a hardcoded green. This adapter replaces it. It is the
 * single seam every cooks handler AND the health probe reach Cosmos through, so
 * a green health check cannot diverge from the path a request handler takes —
 * the MG-51 lesson, enforced structurally.
 *
 * Managed identity is the ONLY credential path. There is no account key, no
 * connection string, and no hardcoded/dev database anywhere in this file. The
 * deployed Function constructs a ManagedIdentityCredential — NOT an unrestricted
 * DefaultAzureCredential, whose chain could bind an environment or developer
 * credential around the workload identity. The credential is a seam so local
 * tooling can inject DefaultAzureCredential deliberately; the deployed path
 * never can.
 *
 * Configuration is fail-loud at module load (MG-51 pattern): the three settings
 * Terraform publishes are read from process.env directly and THROW on
 * missing/blank, inventing no default. This deliberately does NOT route through
 * environments/environment.ts, whose `|| 'meatgeek'` database fallback (MG-55,
 * out of scope) is exactly the silent-wrong-name failure this guard refuses to
 * inherit.
 */

/** Setting names Terraform publishes to the Function App. Source-fixed text. */
const ACCOUNT_ENDPOINT_SETTING = 'COSMOSDB__accountEndpoint';
const DATABASE_NAME_SETTING = 'COSMOSDB_DATABASE_NAME';
const COOKS_CONTAINER_SETTING = 'COSMOSDB_COOKS_CONTAINER_NAME';

/**
 * The fixed failure vocabulary for configuration. Each names the setting that
 * was absent — a source constant, never a value read at runtime — so a thrown
 * message can carry no account host, database name, or container name. The
 * message points at Terraform as the owner and invents no default, so a missing
 * setting fails the app loudly at load instead of silently binding a wrong name.
 */
export type CosmosConfigFailure =
  | 'cosmos_account_endpoint_not_configured'
  | 'cosmos_database_name_not_configured'
  | 'cosmos_cooks_container_not_configured';

const CONFIG_FAILURE_FOR_SETTING: Record<string, CosmosConfigFailure> = {
  [ACCOUNT_ENDPOINT_SETTING]: 'cosmos_account_endpoint_not_configured',
  [DATABASE_NAME_SETTING]: 'cosmos_database_name_not_configured',
  [COOKS_CONTAINER_SETTING]: 'cosmos_cooks_container_not_configured',
};

/**
 * Thrown when a required Cosmos setting is missing or blank. It carries only the
 * fixed failure code and the setting name (both source constants) — never the
 * resolved value — so it is safe to log verbatim.
 */
export class CosmosConfigError extends Error {
  readonly code: CosmosConfigFailure;

  constructor(settingName: string) {
    super(
      `${settingName} is not configured — it must be published to the Function App ` +
        `by Terraform (see apps/infrastructure/modules/functions). There is no default.`
    );
    this.name = 'CosmosConfigError';
    this.code = CONFIG_FAILURE_FOR_SETTING[settingName];
  }
}

export interface CosmosConfig {
  readonly accountEndpoint: string;
  readonly databaseName: string;
  readonly cooksContainerName: string;
}

function requireSetting(env: NodeJS.ProcessEnv, settingName: string): string {
  const value = env[settingName];
  if (value === undefined || value.trim().length === 0) {
    throw new CosmosConfigError(settingName);
  }
  return value.trim();
}

/**
 * Reads the three Terraform-owned settings from process.env directly and throws
 * on the first missing/blank one. Exported so the fail-loud contract can be
 * exercised in a unit test without touching Azure.
 */
export function resolveCosmosConfig(env: NodeJS.ProcessEnv = process.env): CosmosConfig {
  return {
    accountEndpoint: requireSetting(env, ACCOUNT_ENDPOINT_SETTING),
    databaseName: requireSetting(env, DATABASE_NAME_SETTING),
    cooksContainerName: requireSetting(env, COOKS_CONTAINER_SETTING),
  };
}

/**
 * The two constructor seams. Both are pure factories that build objects without
 * doing I/O, so a unit test can inject fakes and no real credential or network
 * is reachable. The production values live in `productionSeams` below.
 */
export interface CosmosAdapterSeams {
  /**
   * Builds the credential the client authenticates with. Called AT MOST ONCE per
   * adapter — the returned credential instance is held and reused across every
   * warm invocation, so the SDK's own token cache (and its refresh-before-expiry
   * behaviour) survives rather than a fresh token being minted per request.
   */
  readonly credentialFactory: () => TokenCredential;
  readonly clientFactory: (options: {
    endpoint: string;
    credential: TokenCredential;
  }) => CosmosClient;
}

/**
 * The deployed path. ManagedIdentityCredential — never DefaultAzureCredential —
 * so no environment or developer credential in the chain can be selected around
 * the workload's managed identity. Constructing it does no I/O; the token is
 * fetched lazily on first use and cached thereafter.
 */
export const productionSeams: CosmosAdapterSeams = {
  credentialFactory: () => new ManagedIdentityCredential(),
  clientFactory: ({ endpoint, credential }) =>
    new CosmosClient({ endpoint, aadCredentials: credential }),
};

/**
 * The shared adapter. One instance per host holds one CosmosClient, one
 * credential, and the resolved config. The client and credential are built
 * lazily on first accessor call and reused for the life of the instance, so a
 * cold start pays the construction cost once and warm invocations reuse it.
 *
 * Nothing here restates configured values in a thrown error or a log line — the
 * adapter exposes accessors for callers that legitimately need names (the cooks
 * repository addressing its container), not diagnostics that leak them.
 */
export class CosmosAdapter {
  private client?: CosmosClient;
  private credential?: TokenCredential;
  private database?: Database;

  constructor(
    private readonly config: CosmosConfig,
    private readonly seams: CosmosAdapterSeams
  ) {}

  get databaseName(): string {
    return this.config.databaseName;
  }

  get cooksContainerName(): string {
    return this.config.cooksContainerName;
  }

  private getClient(): CosmosClient {
    if (!this.client) {
      // credentialFactory runs exactly once; the credential is retained so its
      // token cache lives across warm invocations rather than being rebuilt.
      this.credential = this.seams.credentialFactory();
      this.client = this.seams.clientFactory({
        endpoint: this.config.accountEndpoint,
        credential: this.credential,
      });
    }
    return this.client;
  }

  /** The configured database handle, reused across calls. Metadata reads only. */
  getDatabase(): Database {
    if (!this.database) {
      this.database = this.getClient().database(this.config.databaseName);
    }
    return this.database;
  }

  /** Generic container accessor — used by the health probe. */
  getContainer(containerName: string): Container {
    return this.getDatabase().container(containerName);
  }

  /** The cooks container, addressed by the Terraform-published name. */
  getCooksContainer(): Container {
    return this.getContainer(this.config.cooksContainerName);
  }
}

let sharedAdapter: CosmosAdapter | undefined;

/**
 * The one adapter both the cooks handlers and the health route consume.
 *
 * Initialization is LAZY: importing this module reads no configuration,
 * constructs no client, and throws nothing. The fail-loud config guard
 * (`resolveCosmosConfig`) and the client/credential construction fire on the
 * FIRST call — inside a handler invocation, never at module import. This is the
 * MG-51 fail-loud contract relocated one step later: a Function App with a
 * missing/blank setting still fails loudly and fast (on the first request that
 * reaches Cosmos, before any I/O), but merely importing a handler or the
 * host's main.ts registration path — as the jest suite does without setting the
 * Cosmos env — constructs nothing and cannot throw. An unconfigured app can
 * never limp along on an invented default; it just cannot serve a Cosmos route.
 *
 * The first call resolves config and constructs the adapter with the production
 * (managed-identity) seams; subsequent calls return the same instance, so a
 * single client/credential is shared for the host's lifetime and warm
 * invocations reuse the cached token.
 */
export function getCosmosAdapter(): CosmosAdapter {
  if (!sharedAdapter) {
    const config = resolveCosmosConfig();
    sharedAdapter = new CosmosAdapter(config, productionSeams);
  }
  return sharedAdapter;
}

/**
 * Test seam only. Lets a unit test install an adapter built with fake seams (no
 * Azure, no credentials) or clear the singleton between cases. Never called by
 * production code.
 */
export function __setSharedAdapterForTesting(adapter: CosmosAdapter | undefined): void {
  sharedAdapter = adapter;
}
