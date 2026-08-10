// Integration contract coverage for MG-49.  These tests exercise main() with
// the real exporter pipeline and a Cosmos-shaped client, keeping Azure itself
// out of scope while covering the CLI's observable exit/error guarantees.
//
// Dependency-free tier: every client here is injected. The cases that take
// createRealClient's real SDK imports live in cosmos-export.sdk.test.mjs.

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';

import { main } from './cosmos-export.mjs';
import { EXIT } from './export-core.mjs';
import {
  FakeCosmosError,
  authError,
  credentialUnavailableError,
  docs,
  fakeClient,
  forbiddenError,
  throttleError,
  transportError,
} from './fake-cosmos.mjs';

const ACCOUNT_KEY = 'integration-account-key-must-not-leak';
const ACCESS_TOKEN = 'integration-aad-token-must-not-leak';

async function outDir() {
  return mkdtemp(path.join(tmpdir(), 'cosmos-export-integration-'));
}

async function invoke(argv, { client, createClient, env = {} } = {}) {
  const lines = [];
  const code = await main({
    argv,
    env: { COSMOS_EXPORT_KEY: ACCOUNT_KEY, ...env },
    createClient: async args => createClient?.(args) ?? client,
    log: { info: line => lines.push(line), error: line => lines.push(line) },
  });
  return { code, output: lines.join('\n') };
}

async function outputText(dir, output) {
  const files = await readdir(dir);
  const contents = await Promise.all(files.map(name => readFile(path.join(dir, name), 'utf8')));
  return [output, ...contents].join('\n');
}

describe('MG-49 main() integration exit contracts', () => {
  for (const [label, error, expected] of [
    ['key 401', authError(), EXIT.AUTH],
    ['AAD missing data-plane role (403)', forbiddenError(), EXIT.AUTH],
    ['throttling abort (429)', throttleError(), EXIT.THROTTLED],
    ['transport failure', transportError(), EXIT.TRANSPORT],
  ]) {
    it(`${label} has its operator exit code and no files`, async () => {
      const dir = await outDir();
      const { code, output } = await invoke(['--account', 'meatgeek', '--out', dir], {
        client: fakeClient({}, { listError: error }),
        env: label.includes('AAD') ? { COSMOS_EXPORT_KEY: undefined } : {},
      });

      assert.equal(code, expected);
      assert.match(output, new RegExp(`exit ${expected}\\b`));
      assert.deepEqual(await readdir(dir), []);
    });
  }

  it('credential acquisition failure exits 4 before exporting anything', async () => {
    const dir = await outDir();
    const { code, output } = await invoke(
      ['--account', 'meatgeek', '--out', dir, '--auth', 'aad'],
      {
        env: { COSMOS_EXPORT_KEY: undefined },
        createClient: async () => {
          throw credentialUnavailableError();
        },
      }
    );

    assert.equal(code, EXIT.AUTH);
    assert.match(output, /AggregateAuthenticationError/);
    assert.deepEqual(await readdir(dir), []);
  });

  it('usage failure exits 1 before creating an output directory', async () => {
    const dir = path.join(await outDir(), 'not-created');
    const { code } = await invoke(['--account', 'meatgeek', '--out', dir, '--auth', 'nope'], {
      client: fakeClient({}),
    });

    assert.equal(code, EXIT.USAGE);
    await assert.rejects(readdir(dir));
  });
});

describe('MG-49 secret-boundary integration', () => {
  it('key and AAD export flows never persist or log either credential secret', async () => {
    const spec = { db: { cooks: { count: 1, pages: [docs('cook', 1)] } } };
    const keyDir = await outDir();
    const keyRun = await invoke(['--account', 'meatgeek', '--out', keyDir, '--auth', 'key'], {
      client: fakeClient(spec),
    });
    assert.equal(keyRun.code, EXIT.OK);

    const aadDir = await outDir();
    const aadRun = await invoke(['--account', 'meatgeek', '--out', aadDir, '--auth', 'aad'], {
      client: fakeClient(spec),
      env: { COSMOS_EXPORT_KEY: undefined, AZURE_ACCESS_TOKEN: ACCESS_TOKEN },
    });
    assert.equal(aadRun.code, EXIT.OK);

    for (const text of [
      await outputText(keyDir, keyRun.output),
      await outputText(aadDir, aadRun.output),
    ]) {
      assert.doesNotMatch(text, new RegExp(ACCOUNT_KEY));
      assert.doesNotMatch(text, new RegExp(ACCESS_TOKEN));
    }
  });

  it('status precedence keeps a throttling error out of the broad auth-name classification', async () => {
    const dir = await outDir();
    const error = new FakeCosmosError('retries exhausted', {
      statusCode: 429,
      name: 'CredentialTransportError',
    });
    const { code } = await invoke(['--account', 'meatgeek', '--out', dir], {
      client: fakeClient({}, { listError: error }),
    });

    assert.equal(code, EXIT.THROTTLED);
    assert.deepEqual(await readdir(dir), []);
  });
});
