// Exit-code contract tests for the V1 Cosmos export (MG-48).
//
// These drive main() end to end against a fake client, because the exit code IS
// the interface: an operator deletes a $85/month account on the strength of a 0
// from this tool. The failure cases below — mismatch, 429, transport drop, auth
// — are the half that is actually load-bearing, so they get the coverage.

import { strict as assert } from 'node:assert';
import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFile } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import { createRealClient, main } from './cosmos-export.mjs';
import { EXIT, MANIFEST_FILENAME } from './export-core.mjs';
import {
  accountScopeForbiddenError,
  authError,
  credentialUnavailableError,
  docs,
  fakeClient,
  fakeCosmosModule,
  fakeIdentityModule,
  FakeCosmosError,
  forbiddenError,
  throttleError,
  transportError,
} from './fake-cosmos.mjs';

const TEST_KEY = 'test-key-must-never-be-logged-or-persisted';
const CLI_PATH = fileURLToPath(new URL('./cosmos-export.mjs', import.meta.url));

async function outDir() {
  return mkdtemp(path.join(tmpdir(), 'cosmos-export-'));
}

async function run(
  argv,
  { spec = {}, env = {}, listError, containerListError, client, createClient } = {}
) {
  const lines = [];
  const log = { info: line => lines.push(line), error: line => lines.push(line) };
  const clientArgs = [];
  const code = await main({
    argv,
    env: { COSMOS_EXPORT_KEY: TEST_KEY, ...env },
    createClient: async args => {
      clientArgs.push(args);
      if (createClient) return createClient(args);
      return client ?? fakeClient(spec, { listError, containerListError });
    },
    log,
  });
  return { code, lines, out: lines.join('\n'), clientsCreated: clientArgs.length, clientArgs };
}

async function exportRun(dir, spec, extraArgs = []) {
  return run(['--account', 'meatgeek', '--out', dir, ...extraArgs], { spec });
}

async function readManifest(dir) {
  return JSON.parse(await readFile(path.join(dir, MANIFEST_FILENAME), 'utf8'));
}

async function exists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// Wrap the realistic fake so a resource that exists in its backing data can
// still receive a service error from the metadata read. This is deliberately
// different from removing the resource: the exporter's safety contract must
// distinguish a definite absence from a failed lookup.
function clientWithMetadataError(spec, shouldFail, error) {
  const client = fakeClient(spec);
  return {
    ...client,
    database(databaseId) {
      const database = client.database(databaseId);
      return {
        ...database,
        container(containerId) {
          const container = database.container(containerId);
          return {
            ...container,
            read: async () => {
              if (shouldFail(databaseId, containerId)) throw error();
              return container.read();
            },
          };
        },
      };
    },
  };
}

function execFileAsync(file, args, options) {
  return new Promise(resolve => {
    execFile(file, args, options, (err, stdout, stderr) => {
      resolve({ code: err?.code ?? 0, stdout, stderr });
    });
  });
}

async function sha256Of(p) {
  return createHash('sha256')
    .update(await readFile(p))
    .digest('hex');
}

describe('export — happy paths', () => {
  it('a container with 0 items exports cleanly and reconciles at 0', async () => {
    const dir = await outDir();
    const { code, out } = await exportRun(dir, { db1: { empty: { count: 0, pages: [] } } });

    assert.equal(code, EXIT.OK);
    const file = path.join(dir, 'db1__empty.jsonl');
    assert.equal((await stat(file)).size, 0);
    const manifest = await readManifest(dir);
    assert.equal(manifest.containers.length, 1);
    assert.deepEqual(
      {
        expectedCount: manifest.containers[0].expectedCount,
        writtenCount: manifest.containers[0].writtenCount,
      },
      { expectedCount: 0, writtenCount: 0 }
    );
    assert.equal(manifest.totals.documents, 0);
    assert.match(out, /EXPORT VERIFIED/);
  });

  it('a multi-page container writes every page and reconciles', async () => {
    const dir = await outDir();
    const pages = [docs('cook', 3, 0), docs('cook', 3, 3), docs('cook', 1, 6)];
    const { code } = await exportRun(dir, { 'meatgeek-prod': { cooks: { count: 7, pages } } });

    assert.equal(code, EXIT.OK);
    const file = path.join(dir, 'meatgeek-prod__cooks.jsonl');
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    assert.equal(lines.length, 7);
    assert.deepEqual(
      lines.map(l => JSON.parse(l).id),
      ['cook-0', 'cook-1', 'cook-2', 'cook-3', 'cook-4', 'cook-5', 'cook-6']
    );

    const entry = (await readManifest(dir)).containers[0];
    assert.equal(entry.expectedCount, 7);
    assert.equal(entry.writtenCount, 7);
    assert.equal(entry.bytes, (await stat(file)).size);
    assert.equal(entry.sha256, await sha256Of(file));
  });

  it('every database and container is enumerated by default, one file each', async () => {
    const dir = await outDir();
    const { code } = await exportRun(dir, {
      'meatgeek-prod': {
        cooks: { count: 1, pages: [docs('c', 1)] },
        devices: { count: 2, pages: [docs('d', 2)] },
      },
      'meatgeek-dev': { sessions: { count: 0, pages: [] } },
    });

    assert.equal(code, EXIT.OK);
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest.containers.map(c => `${c.database}/${c.container}`).sort(), [
      'meatgeek-dev/sessions',
      'meatgeek-prod/cooks',
      'meatgeek-prod/devices',
    ]);
    assert.equal(manifest.totals.containers, 3);
    assert.equal(manifest.totals.documents, 3);
  });

  it('--database / --container narrow the export', async () => {
    const dir = await outDir();
    const spec = {
      'meatgeek-prod': {
        cooks: { count: 1, pages: [docs('c', 1)] },
        devices: { count: 1, pages: [docs('d', 1)] },
      },
      'meatgeek-dev': { cooks: { count: 1, pages: [docs('x', 1)] } },
    };
    const { code } = await exportRun(dir, spec, [
      '--database',
      'meatgeek-prod',
      '--container',
      'cooks',
    ]);

    assert.equal(code, EXIT.OK);
    const manifest = await readManifest(dir);
    assert.deepEqual(
      manifest.containers.map(c => `${c.database}/${c.container}`),
      ['meatgeek-prod/cooks']
    );
    assert.deepEqual(manifest.filters, { databases: ['meatgeek-prod'], containers: ['cooks'] });
    assert.equal(await exists(path.join(dir, 'meatgeek-prod__devices.jsonl')), false);
  });

  it('a filter that matches nothing is a usage error, not a silent empty export', async () => {
    const dir = await outDir();
    const { code, out } = await exportRun(
      dir,
      { 'meatgeek-prod': { cooks: { count: 0, pages: [] } } },
      ['--database', 'typo-db']
    );

    assert.equal(code, EXIT.USAGE);
    assert.match(out, /matched nothing/);
    assert.equal(await exists(path.join(dir, MANIFEST_FILENAME)), false);
  });
});

describe('export — reconciliation is a hard failure', () => {
  it('query reports 100 but the iterator yields 90: exit 2, both numbers named', async () => {
    const dir = await outDir();
    const { code, out } = await exportRun(dir, {
      'meatgeek-prod': { cooks: { count: 100, pages: [docs('cook', 90)] } },
    });

    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /reconciliation FAILED/);
    assert.match(out, /100 document/);
    assert.match(out, /wrote 90/);
    assert.equal(
      await exists(path.join(dir, MANIFEST_FILENAME)),
      false,
      'no manifest may vouch for a failed export'
    );
    assert.equal(
      await exists(path.join(dir, 'meatgeek-prod__cooks.jsonl')),
      false,
      'no final file for a container that did not reconcile'
    );
    assert.equal(
      await exists(path.join(dir, 'meatgeek-prod__cooks.jsonl.partial')),
      true,
      'the partial stays, named as a partial'
    );
  });

  it('the iterator yielding MORE than the count also fails', async () => {
    const dir = await outDir();
    const { code, out } = await exportRun(dir, { db: { c: { count: 2, pages: [docs('a', 5)] } } });

    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /reports 2 document\(s\), the export wrote 5/);
  });

  it('a count query that returns no scalar refuses the container', async () => {
    const dir = await outDir();
    const client = fakeClient({ db: { c: { count: undefined, pages: [] } } });
    const { code, out } = await run(['--account', 'meatgeek', '--out', dir], { client });

    assert.equal(code, EXIT.TRANSPORT);
    assert.match(out, /count query returned no usable scalar/);
    assert.equal(await exists(path.join(dir, MANIFEST_FILENAME)), false);
  });

  it('an account with no containers at all does not produce a manifest', async () => {
    const dir = await outDir();
    const { code, out } = await exportRun(dir, {});

    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /no containers found/);
    assert.equal(await exists(path.join(dir, MANIFEST_FILENAME)), false);
  });
});

describe('export — fail closed on throttling and transport errors', () => {
  it('429 with retries exhausted mid-pagination aborts the run with exit 3', async () => {
    const dir = await outDir();
    const { code, out } = await exportRun(dir, {
      'meatgeek-prod': {
        cooks: {
          count: 10,
          pages: [docs('cook', 5), docs('cook', 5, 5)],
          throwAfterPages: 1,
          error: throttleError(),
        },
      },
    });

    assert.equal(code, EXIT.THROTTLED);
    assert.match(out, /ABORTED after 5 of 10 document/);
    assert.match(out, /retries exhausted/);
    assert.match(out, /exit 3 \(throttling abort\)/);
    assert.equal(await exists(path.join(dir, MANIFEST_FILENAME)), false);
    assert.equal(await exists(path.join(dir, 'meatgeek-prod__cooks.jsonl')), false);
    assert.equal(await exists(path.join(dir, 'meatgeek-prod__cooks.jsonl.partial')), true);
  });

  it('a transport error mid-pagination aborts with exit 5 and the same semantics', async () => {
    const dir = await outDir();
    const { code, out } = await exportRun(dir, {
      db: {
        telemetry: {
          count: 10,
          pages: [docs('t', 5), docs('t', 5, 5)],
          throwAfterPages: 1,
          error: transportError(),
        },
      },
    });

    assert.equal(code, EXIT.TRANSPORT);
    assert.match(out, /ABORTED after 5 of 10 document/);
    assert.match(out, /exit 5 \(transport abort\)/);
    assert.equal(await exists(path.join(dir, MANIFEST_FILENAME)), false);
    assert.equal(await exists(path.join(dir, 'db__telemetry.jsonl')), false);
    assert.equal(await exists(path.join(dir, 'db__telemetry.jsonl.partial')), true);
  });

  it('a 429 on the LAST page still aborts — no page is silently dropped', async () => {
    const dir = await outDir();
    const { code } = await exportRun(dir, {
      db: { c: { count: 10, pages: [docs('a', 5)], throwAfterPages: 1, error: throttleError() } },
    });

    assert.equal(code, EXIT.THROTTLED);
    assert.equal(await exists(path.join(dir, MANIFEST_FILENAME)), false);
  });

  it('a container failing part-way through a run fails the WHOLE run, manifest and all', async () => {
    const dir = await outDir();
    const { code } = await exportRun(dir, {
      db: {
        good: { count: 2, pages: [docs('g', 2)] },
        bad: { count: 4, pages: [docs('b', 2)], throwAfterPages: 1, error: throttleError() },
      },
    });

    assert.equal(code, EXIT.THROTTLED);
    assert.equal(
      await exists(path.join(dir, 'db__good.jsonl')),
      true,
      'the container that reconciled keeps its file'
    );
    assert.equal(
      await exists(path.join(dir, MANIFEST_FILENAME)),
      false,
      'but nothing claims the run succeeded'
    );
  });
});

describe('auth failures are distinguishable', () => {
  it('a 401 while enumerating exits 4 and leaves nothing claiming success', async () => {
    const dir = await outDir();
    const { code, out } = await run(['--account', 'meatgeek', '--out', dir], {
      spec: {},
      listError: authError(),
    });

    assert.equal(code, EXIT.AUTH);
    assert.match(out, /exit 4 \(auth failure\)/);
    assert.deepEqual(await readdir(dir), []);
  });

  it('--auth key with no COSMOS_EXPORT_KEY exits 4 before any client is built', async () => {
    const dir = await outDir();
    const { code, out, clientsCreated } = await run(
      ['--account', 'meatgeek', '--out', dir, '--auth', 'key'],
      {
        env: { COSMOS_EXPORT_KEY: undefined },
      }
    );

    assert.equal(code, EXIT.AUTH);
    assert.equal(clientsCreated, 0);
    assert.match(out, /COSMOS_EXPORT_KEY/);
  });

  it('a key passed as a CLI argument is refused', async () => {
    const { code, out } = await run([
      '--account',
      'meatgeek',
      '--out',
      '/tmp/nope',
      '--key',
      'abc123',
    ]);

    assert.equal(code, EXIT.USAGE);
    assert.match(out, /shell history/);
    assert.doesNotMatch(out, /abc123/);
  });

  it('the process itself exits with the auth code, not just main()', async () => {
    const { code, stderr } = await execFileAsync(
      process.execPath,
      [CLI_PATH, '--account', 'meatgeek', '--out', '/tmp/should-not-be-created', '--auth', 'key'],
      {
        env: { PATH: process.env.PATH },
      }
    );

    assert.equal(code, EXIT.AUTH);
    assert.match(stderr, /exit 4 \(auth failure\)/);
    assert.equal(await exists('/tmp/should-not-be-created'), false);
  });
});

// The V2 dev account has disableLocalAuth: true, so aad is the only mode that
// can ever reach it. These drive the real createRealClient with stand-in SDK
// modules: the wiring it hands to CosmosClient is the whole product of the aad
// path, and it is not exercised by anything that injects a client wholesale.
describe('--auth aad (MG-49)', () => {
  const ENDPOINT = 'https://meatgeek.documents.azure.com:443/';

  async function buildClient(authMode, identityOptions) {
    const constructed = [];
    await createRealClient({
      endpoint: ENDPOINT,
      authMode,
      key: TEST_KEY,
      loadCosmos: async () => fakeCosmosModule(constructed),
      loadIdentity: async () => fakeIdentityModule(identityOptions),
    });
    return constructed;
  }

  it('builds the client with a DefaultAzureCredential and no key', async () => {
    const [options] = await buildClient('aad');

    assert.equal(options.aadCredentials?.credentialKind, 'DefaultAzureCredential');
    assert.equal(options.key, undefined);
    assert.equal(options.endpoint, ENDPOINT);
    assert.doesNotMatch(JSON.stringify(options), new RegExp(TEST_KEY));
  });

  it('--auth key still builds the client from the key, with no credential', async () => {
    const [options] = await buildClient('key');

    assert.equal(options.key, TEST_KEY);
    assert.equal(options.aadCredentials, undefined);
  });

  it('both modes keep the same retry policy', async () => {
    const [aad] = await buildClient('aad');
    const [key] = await buildClient('key');

    assert.deepEqual(aad.connectionPolicy, key.connectionPolicy);
    assert.equal(aad.connectionPolicy.retryOptions.maxRetryAttemptCount, 9);
  });

  it('the auth mode is still inferred from COSMOS_EXPORT_KEY when --auth is absent', async () => {
    const spec = { db: { c: { count: 1, pages: [docs('a', 1)] } } };

    const withKey = await run(['--account', 'meatgeek', '--out', await outDir()], { spec });
    assert.equal(withKey.code, EXIT.OK);
    assert.equal(withKey.clientArgs[0].authMode, 'key');

    const dir = await outDir();
    const withoutKey = await run(['--account', 'meatgeek', '--out', dir], {
      spec,
      env: { COSMOS_EXPORT_KEY: undefined },
    });
    assert.equal(withoutKey.code, EXIT.OK);
    assert.equal(withoutKey.clientArgs[0].authMode, 'aad');
    assert.equal(withoutKey.clientArgs[0].key, '');
    assert.match(await readFile(path.join(dir, MANIFEST_FILENAME), 'utf8'), /"authMode": "aad"/);
  });

  it('a 403 from a missing data-plane role assignment exits 4, not 5, and writes nothing', async () => {
    const dir = await outDir();
    const { code, out } = await run(['--account', 'meatgeek', '--out', dir, '--auth', 'aad'], {
      env: { COSMOS_EXPORT_KEY: undefined },
      listError: forbiddenError(),
    });

    assert.equal(code, EXIT.AUTH);
    assert.match(out, /exit 4 \(auth failure\)/);
    assert.deepEqual(await readdir(dir), []);
  });

  it('a credential that cannot be acquired at all exits 4, not an unhandled rejection', async () => {
    const dir = await outDir();
    const { code, out } = await run(['--account', 'meatgeek', '--out', dir, '--auth', 'aad'], {
      env: { COSMOS_EXPORT_KEY: undefined },
      createClient: args =>
        createRealClient({
          ...args,
          loadCosmos: async () => fakeCosmosModule([]),
          loadIdentity: async () =>
            fakeIdentityModule({ throwOnConstruct: credentialUnavailableError() }),
        }),
    });

    assert.equal(code, EXIT.AUTH);
    assert.match(out, /exit 4 \(auth failure\)/);
    assert.match(out, /AggregateAuthenticationError/);
    assert.deepEqual(await readdir(dir), []);
  });

  it('an unsupported --auth value is a usage error before any client is built', async () => {
    const { code, out, clientsCreated } = await run([
      '--account',
      'meatgeek',
      '--out',
      '/tmp/should-not-be-created',
      '--auth',
      'sas',
    ]);

    assert.equal(code, EXIT.USAGE);
    assert.equal(clientsCreated, 0);
    assert.match(out, /--auth must be 'key' or 'aad', got 'sas'/);
    assert.equal(await exists('/tmp/should-not-be-created'), false);
  });

  it('--help names the data-plane role assignment and no longer says to install anything', async () => {
    const { out } = await run(['--help']);

    assert.match(out, /az cosmosdb sql role assignment create/);
    assert.match(out, /--role-definition-id/);
    assert.match(out, /00000000-0000-0000-0000-000000000001/);
    assert.match(out, /Subscription Owner is not sufficient/);
    assert.doesNotMatch(out, /@azure\/identity/);
  });
});

describe('secrets and document contents never reach the logs or disk', () => {
  it('a successful run logs counts, never document bodies, and never the key', async () => {
    const dir = await outDir();
    const { code, out } = await exportRun(dir, {
      db: { cooks: { count: 3, pages: [docs('cook', 3)] } },
    });

    assert.equal(code, EXIT.OK);
    assert.doesNotMatch(out, /SECRET-PAYLOAD/);
    assert.doesNotMatch(out, new RegExp(TEST_KEY));
    const manifestText = await readFile(path.join(dir, MANIFEST_FILENAME), 'utf8');
    assert.doesNotMatch(manifestText, new RegExp(TEST_KEY));
    assert.match(manifestText, /"authMode": "key"/);
  });

  it('an error whose message embeds a document does not leak it', async () => {
    const dir = await outDir();
    const leaky = transportError();
    leaky.message = 'failed on {"id":"cook-1","notes":"SECRET-PAYLOAD-cook-1"}';
    const { code, out } = await exportRun(dir, {
      db: { c: { count: 2, pages: [docs('a', 1)], throwAfterPages: 1, error: leaky } },
    });

    assert.equal(code, EXIT.TRANSPORT);
    assert.doesNotMatch(out, /SECRET-PAYLOAD/);
    assert.match(out, /\[redacted\]/);
  });

  // The guarantee is about what actually gets logged, so this asserts on the
  // whole of what the CLI emitted — and on the exit code, because the same
  // error is the one a name-substring match used to mis-report as exit 4.
  it('an SDK error carrying a connection string and a token leaks neither, and still exits 5', async () => {
    const dir = await outDir();
    const accountKey = 'Ab3xQ9zK7pLmN2vR5tYw8sD4fG6hJ1kZ0cV';
    const token =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJtZWF0Z2VlayJ9.dBjftJeZ4CVPmB92K27uhbUJU1p1rwW1gFWFOEjXk';
    const leaky = Object.assign(
      new Error(
        `socket hang up; AccountEndpoint=https://meatgeek.documents.azure.com:443/;AccountKey=${accountKey}; sent Authorization: Bearer ${token}`
      ),
      { name: 'CredentialTransportError', code: 'ECONNRESET' }
    );
    const { code, out } = await run(['--account', 'meatgeek', '--out', dir], { listError: leaky });

    assert.equal(code, EXIT.TRANSPORT);
    assert.match(out, /exit 5 \(transport abort\)/);
    assert.doesNotMatch(out, new RegExp(accountKey));
    assert.doesNotMatch(out, /eyJ/);
    assert.match(out, /AccountKey=\[redacted\]/);
    assert.deepEqual(await readdir(dir), []);
  });
});

describe('--verify', () => {
  const liveSpec = () => ({
    'meatgeek-prod': {
      cooks: { count: 3, pages: [docs('cook', 3)] },
      devices: { count: 0, pages: [] },
    },
  });

  async function seededExport() {
    const dir = await outDir();
    const { code } = await exportRun(dir, liveSpec());
    assert.equal(code, EXIT.OK);
    return dir;
  }

  async function verify(dir, spec = liveSpec()) {
    return run(['--account', 'meatgeek', '--out', dir, '--verify'], { spec });
  }

  it('passes against an untouched export', async () => {
    const dir = await seededExport();
    const { code, out } = await verify(dir);

    assert.equal(code, EXIT.OK);
    assert.match(out, /VERIFIED: 2 container\(s\) \/ 3 document\(s\)/);
  });

  it('detects a tampered export file', async () => {
    const dir = await seededExport();
    const file = path.join(dir, 'meatgeek-prod__cooks.jsonl');
    const original = await readFile(file, 'utf8');
    await writeFile(file, original.replace('cook-1', 'cook-X'));

    const { code, out } = await verify(dir);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /content hash mismatch/);
    assert.match(out, /DO NOT DELETE THE ACCOUNT/);
  });

  it('detects a truncated export file', async () => {
    const dir = await seededExport();
    const file = path.join(dir, 'meatgeek-prod__cooks.jsonl');
    const lines = (await readFile(file, 'utf8')).split('\n').filter(Boolean);
    await writeFile(file, `${lines.slice(0, 2).join('\n')}\n`);

    const { code, out } = await verify(dir);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /2 document line\(s\), manifest recorded 3/);
    assert.match(out, /content hash mismatch/);
  });

  it('detects a manifest whose recorded hash no longer matches the file', async () => {
    const dir = await seededExport();
    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.containers[0].sha256 = 'f'.repeat(64);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));

    const { code, out } = await verify(dir);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /content hash mismatch/);
    assert.match(out, /manifest f{64}/);
  });

  it('detects a missing export file', async () => {
    const dir = await seededExport();
    await rm(path.join(dir, 'meatgeek-prod__cooks.jsonl'));

    const { code, out } = await verify(dir);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /that file is missing/);
  });

  it('detects that the live account has drifted since the export', async () => {
    const dir = await seededExport();
    const drifted = liveSpec();
    drifted['meatgeek-prod'].cooks.count = 5;

    const { code, out } = await verify(dir, drifted);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /now reports 5 document\(s\), the export holds 3/);
  });

  it('detects a container that exists live but was never exported', async () => {
    const dir = await seededExport();
    const grown = liveSpec();
    grown['meatgeek-prod'].recipes = { count: 1, pages: [docs('r', 1)] };

    const { code, out } = await verify(dir, grown);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(
      out,
      /meatgeek-prod\/recipes: exists in the account but is NOT in the export manifest/
    );
  });

  it('detects a container that vanished from the account', async () => {
    const dir = await seededExport();
    const shrunk = liveSpec();
    delete shrunk['meatgeek-prod'].devices;

    const { code, out } = await verify(dir, shrunk);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /no longer present in the account/);
  });

  it('fails when an aborted run left a partial file in the export directory', async () => {
    const dir = await seededExport();
    await writeFile(path.join(dir, 'meatgeek-prod__other.jsonl.partial'), 'half a document');

    const { code, out } = await verify(dir);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /aborted-run artifact/);
  });

  it('honours the filters the export was taken with', async () => {
    const dir = await outDir();
    const spec = {
      'meatgeek-prod': { cooks: { count: 1, pages: [docs('c', 1)] } },
      'meatgeek-dev': { cooks: { count: 1, pages: [docs('x', 1)] } },
    };
    assert.equal((await exportRun(dir, spec, ['--database', 'meatgeek-prod'])).code, EXIT.OK);

    const { code } = await verify(dir, spec);
    assert.equal(
      code,
      EXIT.OK,
      'the un-exported database is out of scope, not a verification failure'
    );
  });

  it('fails when there is no export in the directory', async () => {
    const dir = await outDir();
    const { code, out } = await verify(dir);

    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /no manifest\.json/);
  });

  it('fails when the manifest itself is damaged', async () => {
    const dir = await seededExport();
    await writeFile(path.join(dir, MANIFEST_FILENAME), '{ not json');

    const { code, out } = await verify(dir);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /not valid JSON/);
  });

  async function reseedManifest(dir, edit) {
    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    edit(manifest);
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
  }

  // A bare string has a .length, so it used to select the database-scoped client
  // — the one thing in the manifest that changes what the verify run is allowed
  // to touch, decided by a truthy accident rather than by a list of ids.
  it('rejects a filters list that is not a list of ids, before a client is built', async () => {
    const dir = await seededExport();
    await reseedManifest(dir, manifest => {
      manifest.filters = { databases: 'meatgeek-prod', containers: null };
    });

    const { code, out, clientsCreated } = await verify(dir);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /filters\.databases is not a list of ids/);
    assert.equal(clientsCreated, 0);
  });

  it('rejects a filters field that is not an object at all', async () => {
    const dir = await seededExport();
    await reseedManifest(dir, manifest => {
      manifest.filters = 'everything';
    });

    const { code, out } = await verify(dir);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /filters is not an object/);
  });

  it('rejects an absentTargets field that is not a list of ids', async () => {
    const dir = await seededExport();
    await reseedManifest(dir, manifest => {
      manifest.absentTargets = { 'meatgeek-prod/cooks': true };
    });

    const { code, out } = await verify(dir);
    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /absentTargets is not a list of ids/);
  });

  it('verifies an older manifest that predates the filters field, unfiltered', async () => {
    const dir = await seededExport();
    await reseedManifest(dir, manifest => {
      delete manifest.filters;
      delete manifest.absentTargets;
    });

    const { code, out } = await verify(dir);
    assert.equal(code, EXIT.OK, out);
    assert.match(out, /VERIFIED: 2 container\(s\) \/ 3 document\(s\)/);
  });
});

// The direct-addressing path is the one that can lose data quietly. Under
// --database + --container the exporter addresses each target by id, so the only
// thing standing between a failed metadata read and a container dropped from the
// export is what this file asserts. assertFiltersMatched cannot be that thing:
// it works from FLAT sets of database and container names, so with two databases
// holding the same two container names, alpha/critical can vanish while every
// requested name is still represented somewhere. These tests all attack exactly
// that target, and the rule they encode is one line: only an unambiguous,
// terminal absence may be treated as "not present"; everything else aborts,
// non-zero, with no manifest written.
describe('directly addressed filtered targets (MG-49 safety probe)', () => {
  const scopedSpec = () => ({
    alpha: {
      critical: { count: 1, pages: [docs('alpha-critical', 1)] },
      retained: { count: 1, pages: [docs('alpha-retained', 1)] },
    },
    beta: {
      critical: { count: 1, pages: [docs('beta-critical', 1)] },
      retained: { count: 1, pages: [docs('beta-retained', 1)] },
    },
  });
  const filters = [
    '--database',
    'alpha',
    '--database',
    'beta',
    '--container',
    'critical',
    '--container',
    'retained',
  ];
  const key = entry => `${entry.database}/${entry.container}`;
  const failsAlphaCritical = (database, container) =>
    database === 'alpha' && container === 'critical';

  // The container EXISTS in the spec throughout — the metadata read is what
  // fails, which is the distinction the whole repair turns on.
  async function exportWith(error) {
    const dir = await outDir();
    const client = clientWithMetadataError(scopedSpec(), failsAlphaCritical, error);
    const exported = await run(['--account', 'meatgeek', '--out', dir, ...filters], { client });
    return { dir, client, exported };
  }

  async function assertAbortedWithNothingWritten(dir, exported, expectedExit) {
    assert.equal(exported.code, expectedExit, exported.out);
    assert.doesNotMatch(exported.out, /EXPORT VERIFIED/);
    assert.match(exported.out, /alpha\/critical/, 'the failure has to name the container');
    assert.equal(
      await exists(path.join(dir, MANIFEST_FILENAME)),
      false,
      'no manifest may vouch for an export that could not account for a requested container'
    );
  }

  it('a persistent 404 the database contradicts aborts rather than omitting the container', async () => {
    const { dir, exported } = await exportWith(
      () =>
        new FakeCosmosError('replica returned 404 while the container still exists', {
          statusCode: 404,
          code: 'NotFound',
        })
    );

    await assertAbortedWithNothingWritten(dir, exported, EXIT.TRANSPORT);
    assert.match(exported.out, /alpha still lists critical/);
    assert.match(exported.out, /refusing to omit a container that exists/);
  });

  it('a 404 carrying no resource code is not an unambiguous absence', async () => {
    const { dir, exported } = await exportWith(
      () => new FakeCosmosError('gateway returned a bare 404', { statusCode: 404 })
    );

    await assertAbortedWithNothingWritten(dir, exported, EXIT.TRANSPORT);
    assert.match(exported.out, /reading container metadata failed/);
  });

  // Each of these carries the not-found CODE, which used to be enough on its
  // own to read as an absence. None of them is one.
  const NEVER_AN_ABSENCE = [
    ['a 403 mislabelled by an intermediary', { statusCode: 403, code: 'NotFound' }, EXIT.AUTH],
    ['a 401 mislabelled by an intermediary', { statusCode: 401, code: 'NotFound' }, EXIT.AUTH],
    ['a 429 mislabelled by an intermediary', { statusCode: 429, code: 'NotFound' }, EXIT.THROTTLED],
    [
      'a socket reset with no HTTP status at all',
      { code: 'NotFound', name: 'RestError' },
      EXIT.TRANSPORT,
    ],
  ];

  for (const [label, shape, expectedExit] of NEVER_AN_ABSENCE) {
    it(`${label} exits ${expectedExit}, never a skip`, async () => {
      const { dir, exported } = await exportWith(
        () => new FakeCosmosError('metadata read failed', shape)
      );

      await assertAbortedWithNothingWritten(dir, exported, expectedExit);
    });
  }

  // The 403 case is the reviewer's mixed multi-target scenario in full: three
  // healthy targets across two databases, one erroring, and the run must not
  // reach EXPORT VERIFIED with the fourth quietly missing.
  it('an erroring target in a mixed multi-target run leaves no verified, incomplete export behind', async () => {
    const { dir, exported } = await exportWith(
      () =>
        new FakeCosmosError('forbidden metadata read mislabelled by an intermediary', {
          statusCode: 403,
          code: 'NotFound',
        })
    );

    assert.equal(exported.code, EXIT.AUTH);
    assert.deepEqual(await readdir(dir), [], 'nothing is written on the way to the abort');

    const verified = await run(['--account', 'meatgeek', '--out', dir, '--verify'], {
      spec: scopedSpec(),
    });
    assert.equal(verified.code, EXIT.RECONCILE, 'there is no export here to verify');
    assert.match(verified.out, /no manifest\.json/);
  });

  it('a container genuinely absent from one database is recorded, and the rest still export', async () => {
    const spec = scopedSpec();
    delete spec.alpha.critical;
    const dir = await outDir();

    const { code, out } = await run(['--account', 'meatgeek', '--out', dir, ...filters], { spec });

    assert.equal(code, EXIT.OK, out);
    assert.match(out, /EXPORT VERIFIED/);
    const manifest = await readManifest(dir);
    assert.deepEqual(manifest.containers.map(key), [
      'alpha/retained',
      'beta/critical',
      'beta/retained',
    ]);
    assert.deepEqual(
      manifest.absentTargets,
      ['alpha/critical'],
      'a proven absence is recorded, so the manifest can be held to the whole request later'
    );

    const verified = await run(['--account', 'meatgeek', '--out', dir, '--verify'], { spec });
    assert.equal(verified.code, EXIT.OK, verified.out);
  });

  it('a container absent from every requested database is still the exit-1 filter contract', async () => {
    const spec = scopedSpec();
    delete spec.alpha.critical;
    delete spec.beta.critical;
    const dir = await outDir();

    const { code, out } = await run(
      [
        '--account',
        'meatgeek',
        '--out',
        dir,
        '--database',
        'alpha',
        '--database',
        'beta',
        '--container',
        'critical',
      ],
      { spec }
    );

    assert.equal(code, EXIT.USAGE);
    assert.match(out, /matched nothing/);
    assert.equal(await exists(path.join(dir, MANIFEST_FILENAME)), false);
  });

  it('--verify refuses a manifest that is missing a requested container', async () => {
    const dir = await outDir();
    assert.equal(
      (await run(['--account', 'meatgeek', '--out', dir, ...filters], { spec: scopedSpec() })).code,
      EXIT.OK
    );

    // The omission a fail-open metadata read would have produced, made by hand:
    // the manifest simply does not mention alpha/critical. The account no longer
    // holds it either, so the live-vs-manifest cross-check cannot see it — the
    // recorded request is the only thing that can, which is the point.
    const manifestPath = path.join(dir, MANIFEST_FILENAME);
    const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
    manifest.containers = manifest.containers.filter(entry => key(entry) !== 'alpha/critical');
    await writeFile(manifestPath, JSON.stringify(manifest, null, 2));
    await rm(path.join(dir, 'alpha__critical.jsonl'));

    const drifted = scopedSpec();
    delete drifted.alpha.critical;
    const { code, out } = await run(['--account', 'meatgeek', '--out', dir, '--verify'], {
      spec: drifted,
    });

    assert.equal(code, EXIT.RECONCILE);
    assert.match(out, /alpha\/critical: the export was asked for it/);
    assert.match(out, /DO NOT DELETE THE ACCOUNT/);
  });
});

// MG-49, from a live smoke against V2 dev. A Cosmos DB Built-in Data Reader
// assignment scoped to /dbs/meatgeek-v2-dev-db — the correct least-privilege
// grant — could not run a --database-filtered export, because the tool asked the
// ACCOUNT what databases it held before it applied the filter. The fake here
// holds exactly that grant: account-level enumeration is forbidden, direct
// access succeeds. A filtered export has to complete against it, and an
// unfiltered one has to keep failing, since that one really does need the
// account.
describe('database-scoped RBAC (MG-49)', () => {
  const ACCOUNT = 'mgv2-dev-f640e19ae7ab';
  const DATABASE = 'meatgeek-v2-dev-db';
  const spec = {
    [DATABASE]: {
      temperatures: { count: 2, pages: [docs('t', 2)] },
      sessions: { count: 1, pages: [docs('s', 1)] },
    },
  };

  function scopedRun(argv, overrides = {}) {
    return run(['--account', ACCOUNT, '--auth', 'aad', ...argv], {
      spec,
      env: { COSMOS_EXPORT_KEY: undefined },
      listError: accountScopeForbiddenError(),
      ...overrides,
    });
  }

  it('a --database export completes where account enumeration is forbidden', async () => {
    const dir = await outDir();
    const { code } = await scopedRun(['--out', dir, '--database', DATABASE]);

    assert.equal(code, EXIT.OK);
    const manifest = await readManifest(dir);
    assert.deepEqual(
      manifest.containers.map(c => `${c.database}/${c.container}`),
      [`${DATABASE}/temperatures`, `${DATABASE}/sessions`]
    );
    assert.equal(manifest.totals.documents, 3);
  });

  it('...and --verify of that export completes too', async () => {
    const dir = await outDir();
    assert.equal((await scopedRun(['--out', dir, '--database', DATABASE])).code, EXIT.OK);

    const { code, out } = await scopedRun(['--out', dir, '--verify']);
    assert.equal(code, EXIT.OK, out);
    assert.match(out, /VERIFIED: 2 container\(s\) \/ 3 document\(s\)/);
  });

  it('--database --container completes where database enumeration is forbidden as well', async () => {
    const dir = await outDir();
    const { code } = await scopedRun(
      ['--out', dir, '--database', DATABASE, '--container', 'sessions'],
      {
        containerListError: accountScopeForbiddenError(),
      }
    );

    assert.equal(code, EXIT.OK);
    const manifest = await readManifest(dir);
    assert.deepEqual(
      manifest.containers.map(c => `${c.database}/${c.container}`),
      [`${DATABASE}/sessions`]
    );
    assert.equal(await exists(path.join(dir, `${DATABASE}__temperatures.jsonl`)), false);
  });

  it('an unfiltered export against the same grant still fails, loudly and with exit 4', async () => {
    const dir = await outDir();
    const { code, out } = await scopedRun(['--out', dir]);

    assert.equal(code, EXIT.AUTH);
    assert.match(out, /enumerating databases/);
    assert.match(out, /Request blocked by Auth/);
    assert.match(out, /exit 4 \(auth failure\)/);
    assert.deepEqual(await readdir(dir), [], 'nothing is written on the way to the 403');
  });

  it('a --database typo is still a usage error, not a 404 dressed up as a transport abort', async () => {
    const dir = await outDir();
    const { code, out } = await scopedRun(['--out', dir, '--database', 'typo-db']);

    assert.equal(code, EXIT.USAGE);
    assert.match(out, /matched nothing/);
    assert.equal(await exists(path.join(dir, MANIFEST_FILENAME)), false);
  });

  // Not enumerating databases is necessary but not sufficient: with endpoint
  // discovery left on, the SDK reads the DATABASE ACCOUNT for its region list
  // before the first data request, which is the account-scoped call the live
  // smoke actually died on. Nothing injecting a client wholesale can see this.
  it('a scoped run builds a client that will not probe the account for regions', async () => {
    const constructed = [];
    const loaders = {
      loadCosmos: async () => fakeCosmosModule(constructed),
      loadIdentity: async () => fakeIdentityModule(),
    };

    await createRealClient({
      endpoint: `https://${ACCOUNT}.documents.azure.com:443/`,
      authMode: 'aad',
      databaseScoped: true,
      ...loaders,
    });
    await createRealClient({
      endpoint: `https://${ACCOUNT}.documents.azure.com:443/`,
      authMode: 'aad',
      ...loaders,
    });

    assert.equal(constructed[0].connectionPolicy.enableEndpointDiscovery, false);
    assert.equal(constructed[1].connectionPolicy.enableEndpointDiscovery, true);
    assert.equal(constructed[0].connectionPolicy.retryOptions.maxRetryAttemptCount, 9);
  });

  it('main tells the client factory which runs are database-scoped', async () => {
    const dir = await outDir();
    const scoped = await scopedRun(['--out', dir, '--database', DATABASE]);
    assert.equal(scoped.clientArgs[0].databaseScoped, true);

    const unscoped = await scopedRun(['--out', await outDir()]);
    assert.equal(unscoped.clientArgs[0].databaseScoped, false);

    const verified = await scopedRun(['--out', dir, '--verify']);
    assert.equal(
      verified.clientArgs[0].databaseScoped,
      true,
      "--verify takes its scope from the manifest's filters, not from argv"
    );
  });
});

describe('CLI surface', () => {
  it('refuses to overwrite a completed export unless --force is given', async () => {
    const dir = await outDir();
    const spec = { db: { c: { count: 1, pages: [docs('a', 1)] } } };
    assert.equal((await exportRun(dir, spec)).code, EXIT.OK);

    const second = await exportRun(dir, spec);
    assert.equal(second.code, EXIT.USAGE);
    assert.match(second.out, /already exists/);

    const forced = await exportRun(dir, spec, ['--force']);
    assert.equal(forced.code, EXIT.OK);
  });

  it('--force removes the old manifest up front, so an aborted re-run leaves none behind', async () => {
    const dir = await outDir();
    assert.equal(
      (await exportRun(dir, { db: { c: { count: 1, pages: [docs('a', 1)] } } })).code,
      EXIT.OK
    );

    const { code } = await exportRun(
      dir,
      {
        db: { c: { count: 4, pages: [docs('a', 1)], throwAfterPages: 1, error: throttleError() } },
      },
      ['--force']
    );
    assert.equal(code, EXIT.THROTTLED);
    assert.equal(
      await exists(path.join(dir, MANIFEST_FILENAME)),
      false,
      'a stale manifest must not survive a failed re-run'
    );
  });

  it('--help exits 0 without touching the account', async () => {
    const { code, out, clientsCreated } = await run(['--help']);

    assert.equal(code, EXIT.OK);
    assert.equal(clientsCreated, 0);
    assert.match(out, /EXIT CODES/);
    assert.match(out, /COSMOS_EXPORT_KEY/);
  });

  it('rejects unknown arguments and missing values', async () => {
    assert.equal((await run(['--nope'])).code, EXIT.USAGE);
    assert.equal((await run(['--out'])).code, EXIT.USAGE);
    assert.equal((await run(['--account', 'meatgeek'])).code, EXIT.USAGE);
    assert.equal(
      (await run(['--out', '/tmp/x', '--account', 'a', '--page-size', '0'])).code,
      EXIT.USAGE
    );
    assert.equal(
      (await run(['--out', '/tmp/x', '--account', 'a', '--auth', 'sas'])).code,
      EXIT.USAGE
    );
  });

  it('accepts --flag=value as well as --flag value', async () => {
    const dir = await outDir();
    const { code } = await run([`--account=meatgeek`, `--out=${dir}`, '--database=db'], {
      spec: { db: { c: { count: 1, pages: [docs('a', 1)] } } },
    });

    assert.equal(code, EXIT.OK);
  });
});
