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

import { main } from './cosmos-export.mjs';
import { EXIT, MANIFEST_FILENAME } from './export-core.mjs';
import { authError, docs, fakeClient, throttleError, transportError } from './fake-cosmos.mjs';

const TEST_KEY = 'test-key-must-never-be-logged-or-persisted';
const CLI_PATH = fileURLToPath(new URL('./cosmos-export.mjs', import.meta.url));

async function outDir() {
  return mkdtemp(path.join(tmpdir(), 'cosmos-export-'));
}

async function run(argv, { spec = {}, env = {}, listError, client } = {}) {
  const lines = [];
  const log = { info: line => lines.push(line), error: line => lines.push(line) };
  let clientsCreated = 0;
  const code = await main({
    argv,
    env: { COSMOS_EXPORT_KEY: TEST_KEY, ...env },
    createClient: async () => {
      clientsCreated += 1;
      return client ?? fakeClient(spec, { listError });
    },
    log,
  });
  return { code, lines, out: lines.join('\n'), clientsCreated };
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
