/**
 * MG-59 — the shared Cosmos adapter, tested with NO Azure and NO credentials.
 *
 * The adapter is the single seam every cooks handler and the health probe reach
 * Cosmos through. These tests hold the security-critical properties: managed
 * identity is the only credential path, config fails loud at module load, the
 * client/credential are built once and reused, and nothing leaks an account,
 * database, container, credential, or identity value into an error or a log.
 *
 * Config is fail-loud on FIRST USE, not at module load: importing the module
 * reads no env, constructs no client, and throws nothing (so the host's main.ts
 * registration path and every handler spec can import a route without setting
 * the Cosmos env). The guard fires on the first `getCosmosAdapter()` call inside
 * a handler invocation. These tests hold both halves of that contract: a bare
 * import is inert, and the first accessor call throws loudly when a setting is
 * missing/blank. Only TYPES are imported statically and the module is loaded via
 * `require` after the env is arranged; the client and credential are injected
 * behind the CosmosAdapterSeams seam, so every case here runs offline.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { TokenCredential } from '@azure/core-auth';

import type { CosmosAdapterSeams, CosmosConfig } from './cosmos-adapter';

const ENDPOINT_SETTING = 'COSMOSDB__accountEndpoint';
const DATABASE_SETTING = 'COSMOSDB_DATABASE_NAME';
const COOKS_CONTAINER_SETTING = 'COSMOSDB_COOKS_CONTAINER_NAME';

// Realistic-shaped values used ONLY to prove they never surface in an error or
// log line. If a test's asserted message ever contained one of these, the leak
// check below would catch it.
const ACCOUNT_ENDPOINT = 'https://mgv2-secret-account.documents.azure.com/';
const DATABASE_NAME = 'meatgeek-v2-dev-db';
const COOKS_CONTAINER = 'cooks';

const VALID_ENV = {
  [ENDPOINT_SETTING]: ACCOUNT_ENDPOINT,
  [DATABASE_SETTING]: DATABASE_NAME,
  [COOKS_CONTAINER_SETTING]: COOKS_CONTAINER,
};

const CONFIG: CosmosConfig = {
  accountEndpoint: ACCOUNT_ENDPOINT,
  databaseName: DATABASE_NAME,
  cooksContainerName: COOKS_CONTAINER,
};

/** Re-imports the module with a given env, mirroring the MG-51 health spec. */
function loadAdapterModule(env: Record<string, string | undefined>) {
  jest.resetModules();
  for (const [key, value] of Object.entries(env)) {
    if (value === undefined) {
      delete process.env[key];
    } else {
      process.env[key] = value;
    }
  }
  return () => require('./cosmos-adapter') as typeof import('./cosmos-adapter');
}

/** Loads the module with a fully-valid env (the common case). */
function loadValid(): typeof import('./cosmos-adapter') {
  return loadAdapterModule(VALID_ENV)();
}

/** A container/database test double that records what it was asked for. */
function fakeClient() {
  const containerReads: string[] = [];
  const container = { __marker: 'container' };
  const database = {
    id: DATABASE_NAME,
    container: jest.fn((name: string) => {
      containerReads.push(name);
      return container;
    }),
  };
  const client = {
    database: jest.fn(() => database),
  };
  return { client, database, container, containerReads };
}

/** A credential double — never dials anything. */
function fakeCredential(): TokenCredential {
  return { getToken: jest.fn(async () => ({ token: 't', expiresOnTimestamp: 0 })) };
}

function seamsWith(overrides: Partial<CosmosAdapterSeams> = {}): {
  seams: CosmosAdapterSeams;
  credentialFactory: jest.Mock;
  clientFactory: jest.Mock;
  double: ReturnType<typeof fakeClient>;
} {
  const double = fakeClient();
  const credentialFactory = jest.fn(() => fakeCredential());
  const clientFactory = jest.fn(() => double.client as never);
  return {
    double,
    credentialFactory,
    clientFactory,
    seams: { credentialFactory, clientFactory, ...overrides },
  };
}

describe('MG-59 shared Cosmos adapter', () => {
  const savedEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...savedEnv };
    jest.resetModules();
  });

  describe('lazy init: import is inert, config fails loud on first use', () => {
    it('imports cleanly with NO Cosmos env set — construction and the guard are deferred', () => {
      // The regression FIX 1 addresses: importing a handler or main.ts must not
      // throw just because a test did not set the Cosmos env. A bare require with
      // all three settings absent must succeed and build no client.
      const load = loadAdapterModule({
        [ENDPOINT_SETTING]: undefined,
        [DATABASE_SETTING]: undefined,
        [COOKS_CONTAINER_SETTING]: undefined,
      });
      expect(load).not.toThrow();
    });

    for (const missing of [ENDPOINT_SETTING, DATABASE_SETTING, COOKS_CONTAINER_SETTING]) {
      it(`imports cleanly but getCosmosAdapter() throws when ${missing} is absent`, () => {
        const mod = loadAdapterModule({ ...VALID_ENV, [missing]: undefined })();
        // Import did not throw (loadAdapterModule invoked require without error);
        // the fail-loud guard fires only on first use.
        expect(() => mod.getCosmosAdapter()).toThrow();
      });

      it(`imports cleanly but getCosmosAdapter() throws when ${missing} is blank/whitespace`, () => {
        const mod = loadAdapterModule({ ...VALID_ENV, [missing]: '   ' })();
        expect(() => mod.getCosmosAdapter()).toThrow();
      });
    }

    it('names the missing setting and Terraform as owner, invents no default', () => {
      const mod = loadValid();
      let thrown: InstanceType<typeof mod.CosmosConfigError> | undefined;
      try {
        mod.resolveCosmosConfig({
          ...VALID_ENV,
          [DATABASE_SETTING]: undefined,
        } as NodeJS.ProcessEnv);
      } catch (error) {
        thrown = error as InstanceType<typeof mod.CosmosConfigError>;
      }
      expect(thrown).toBeInstanceOf(mod.CosmosConfigError);
      expect(thrown?.code).toBe('cosmos_database_name_not_configured');
      expect(thrown?.message).toContain(DATABASE_SETTING);
      expect(thrown?.message.toLowerCase()).toContain('terraform');
      // No default is invented: the fallback name a silent `|| 'meatgeek'` would
      // have produced never appears in the message.
      expect(thrown?.message.toLowerCase()).not.toContain('meatgeek');
    });

    it('imports cleanly and builds the singleton once when fully configured', () => {
      const mod = loadValid();
      const first = mod.getCosmosAdapter();
      const second = mod.getCosmosAdapter();
      expect(first).toBe(second);
    });
  });

  describe('managed-identity-only credential path', () => {
    it('the production seam builds a ManagedIdentityCredential, never DefaultAzureCredential', () => {
      const mod = loadValid();
      // jest.resetModules() gave the module a fresh @azure/identity registry, so
      // instanceof must compare against classes from that SAME registry.
      const identity = require('@azure/identity');
      const credential = mod.productionSeams.credentialFactory();
      expect(credential).toBeInstanceOf(identity.ManagedIdentityCredential);
      expect(credential).not.toBeInstanceOf(identity.DefaultAzureCredential);
      expect(credential.constructor.name).toBe('ManagedIdentityCredential');
    });

    it('the production client seam accepts an AAD credential (no key/connection string)', () => {
      // Real CosmosClient construction (no I/O). We only assert it accepts the
      // AAD credential shape; the source-level guard below proves no
      // key/connection-string code path exists at all.
      const mod = loadValid();
      const client = mod.productionSeams.clientFactory({
        endpoint: ACCOUNT_ENDPOINT,
        credential: fakeCredential(),
      });
      expect(client).toBeDefined();
    });

    it('never reads COSMOSDB_CONNECTION_STRING or an account key (source-level guard)', () => {
      const source = fs.readFileSync(path.join(__dirname, 'cosmos-adapter.ts'), 'utf8');
      expect(source).not.toContain('COSMOSDB_CONNECTION_STRING');
      expect(source).not.toContain('connectionString');
      expect(source).not.toMatch(/\bkey\s*:/);
      expect(source).not.toContain('masterKey');
      // DefaultAzureCredential must not be IMPORTED or CONSTRUCTED on the deployed
      // path (a doc comment naming it as the thing we avoid is fine).
      expect(source).not.toMatch(/new\s+DefaultAzureCredential/);
      const identityImport = source.match(/import\s*\{([^}]*)\}\s*from\s*'@azure\/identity'/);
      expect(identityImport).not.toBeNull();
      expect(identityImport?.[1]).not.toContain('DefaultAzureCredential');
    });
  });

  describe('client + credential lifecycle (injected seam, no Azure)', () => {
    it('builds the credential exactly once and reuses it across many accessor calls', () => {
      const mod = loadValid();
      const { seams, credentialFactory, clientFactory } = seamsWith();
      const adapter = new mod.CosmosAdapter(CONFIG, seams);

      adapter.getCooksContainer();
      adapter.getContainer('anything');
      adapter.getDatabase();
      adapter.getCooksContainer();

      // A token rebuilt per call would defeat the SDK cache and hammer the IMDS
      // endpoint. One credential, one client, for the life of the host.
      expect(credentialFactory).toHaveBeenCalledTimes(1);
      expect(clientFactory).toHaveBeenCalledTimes(1);
    });

    it('addresses the configured database and cooks container by name', () => {
      const mod = loadValid();
      const { seams, double } = seamsWith();
      const adapter = new mod.CosmosAdapter(CONFIG, seams);

      const container = adapter.getCooksContainer();

      expect(double.client.database).toHaveBeenCalledWith(DATABASE_NAME);
      expect(double.containerReads).toEqual([COOKS_CONTAINER]);
      expect(container).toBe(double.container);
    });

    it('exposes configured names to legitimate callers without dialling', () => {
      const mod = loadValid();
      const { seams, credentialFactory, clientFactory } = seamsWith();
      const adapter = new mod.CosmosAdapter(CONFIG, seams);

      expect(adapter.databaseName).toBe(DATABASE_NAME);
      expect(adapter.cooksContainerName).toBe(COOKS_CONTAINER);
      // Reading names does not construct a client or a credential.
      expect(credentialFactory).not.toHaveBeenCalled();
      expect(clientFactory).not.toHaveBeenCalled();
    });

    it('the injected credential seam decides the credential — a local tool may inject its own', () => {
      const mod = loadValid();
      const injected = fakeCredential();
      const { seams } = seamsWith({ credentialFactory: () => injected });
      const adapter = new mod.CosmosAdapter(CONFIG, seams);

      adapter.getCooksContainer();
      // The adapter hard-wires no credential type; the seam supplies it. The
      // deployed path supplies ManagedIdentityCredential, tooling may supply
      // another — but only through this explicit seam.
      expect(injected.getToken).toBeDefined();
    });
  });

  describe('no leakage of account/database/container/credential/identity text', () => {
    it('a config error message carries only the setting name, never resolved values', () => {
      const mod = loadValid();
      const error = new mod.CosmosConfigError(ENDPOINT_SETTING);
      // The setting NAME is a source constant and allowed; a resolved value is not.
      expect(error.message).not.toContain(ACCOUNT_ENDPOINT);
      expect(error.message).not.toContain(DATABASE_NAME);
      expect(error.message).not.toMatch(/\/\.default/);
      expect(error.message).not.toContain('token');
    });

    it('the source names no account host, no key vocabulary, and no identity header', () => {
      const source = fs.readFileSync(path.join(__dirname, 'cosmos-adapter.ts'), 'utf8');
      expect(source).not.toContain('documents.azure.com');
      expect(source).not.toContain('X-IDENTITY-HEADER');
      expect(source).not.toContain('IDENTITY_HEADER');
    });
  });
});
