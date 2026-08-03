// Unit-level tests for the export core: the read-only guarantee, error
// classification (which is what makes the exit codes distinguishable), and the
// message scrubbing that keeps user documents out of the logs.

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  EXIT,
  ExportError,
  classifyError,
  describeError,
  exitLabel,
  fileNameFor,
  listTargets,
} from './export-core.mjs';
import { authError, docs, fakeClient, throttleError, transportError } from './fake-cosmos.mjs';

const SOURCES = ['./export-core.mjs', './cosmos-export.mjs'];

// The whole tool is one promise: it reads and never writes. A grep is a blunt
// instrument, but it is the one check that still holds when someone adds a
// feature here in six months without reading the header comment.
const MUTATING_CALLS = [
  /\.items\.create\b/,
  /\.items\.upsert\b/,
  /\.items\.bulk\b/,
  /\.items\.batch\b/,
  /\.item\(/,
  /\.containers\.create/,
  /\.databases\.create/,
  /\.container\([^)]*\)\.(delete|replace)\b/,
  /executeBulkOperations/,
  /\.patch\(/,
  /\.upsert\(/,
];

describe('read-only guarantee', () => {
  it('no mutating Cosmos client call appears in the source', async () => {
    for (const relative of SOURCES) {
      const source = await readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
      for (const pattern of MUTATING_CALLS) {
        assert.equal(
          pattern.test(source),
          false,
          `${relative} contains a mutating call matching ${pattern}`
        );
      }
    }
  });

  it('the only query the tool issues is the count query', async () => {
    const source = await readFile(
      fileURLToPath(new URL('./export-core.mjs', import.meta.url)),
      'utf8'
    );
    const queries = source.match(/query\('([^']*)'\)/g) ?? [];
    assert.deepEqual(queries, ["query('SELECT VALUE COUNT(1) FROM c')"]);
  });

  it('the fake client fails loudly if a mutating method is ever reached', () => {
    const client = fakeClient({ db: { c: { count: 0, pages: [] } } });
    assert.throws(
      () => client.database('db').container('c').items.create({}),
      /read-only violation/
    );
    assert.throws(() => client.database('db').delete(), /read-only violation/);
  });
});

describe('error classification', () => {
  it('maps each failure kind to its own exit code', () => {
    assert.equal(classifyError(throttleError()), EXIT.THROTTLED);
    assert.equal(classifyError(authError()), EXIT.AUTH);
    assert.equal(classifyError(transportError()), EXIT.TRANSPORT);
    assert.equal(classifyError({ statusCode: 403, message: 'AccountIsDisabled' }), EXIT.AUTH);
    assert.equal(classifyError({ name: 'CredentialUnavailableError' }), EXIT.AUTH);
    assert.equal(classifyError({ code: 429 }), EXIT.THROTTLED);
    assert.equal(classifyError(new Error('something else')), EXIT.TRANSPORT);
  });

  it('labels every exit code', () => {
    assert.equal(exitLabel(EXIT.OK), 'verified-complete');
    assert.equal(exitLabel(EXIT.RECONCILE), 'reconciliation failure');
    assert.equal(exitLabel(EXIT.THROTTLED), 'throttling abort');
    assert.equal(exitLabel(EXIT.AUTH), 'auth failure');
    assert.equal(exitLabel(EXIT.TRANSPORT), 'transport abort');
  });
});

describe('describeError', () => {
  it('keeps the diagnostic bits and drops anything document-shaped', () => {
    const err = Object.assign(
      new Error('Entity with the specified id exists: {"id":"cook-1","userId":"steve"}'),
      {
        name: 'ErrorResponse',
        statusCode: 409,
      }
    );
    const described = describeError(err);

    assert.match(described, /ErrorResponse/);
    assert.match(described, /status=409/);
    assert.match(described, /\[redacted\]/);
    assert.doesNotMatch(described, /cook-1/);
    assert.doesNotMatch(described, /steve/);
  });

  it('redacts array-shaped payloads too, and never runs long', () => {
    assert.match(describeError(new Error('batch failed [{"id":"a"},{"id":"b"}]')), /\[redacted\]/);
    assert.ok(describeError(new Error('x'.repeat(5000))).length < 260);
  });

  it('passes an ExportError message through unchanged', () => {
    const err = new ExportError(EXIT.RECONCILE, 'reports 100, wrote 90');
    assert.equal(describeError(err), 'reports 100, wrote 90');
  });
});

describe('file naming', () => {
  it('is stable and readable for ordinary ids', () => {
    assert.equal(fileNameFor('meatgeek-prod', 'cooks'), 'meatgeek-prod__cooks.jsonl');
  });

  it('never lets an exotic id escape the output directory', () => {
    const name = fileNameFor('..', 'a b/c');
    assert.doesNotMatch(name, /[/\\]/);
    assert.notEqual(name, '..__a b/c.jsonl');
  });

  it('keeps distinct ids on distinct files after sanitising', () => {
    assert.notEqual(fileNameFor('db', 'a b'), fileNameFor('db', 'a_b'));
  });
});

describe('listTargets', () => {
  const spec = {
    'meatgeek-prod': {
      cooks: { count: 1, pages: [docs('c', 1)] },
      devices: { count: 0, pages: [] },
    },
    'meatgeek-dev': { cooks: { count: 0, pages: [] } },
  };

  it('walks every database and container by default', async () => {
    const targets = await listTargets(fakeClient(spec));
    assert.deepEqual(
      targets.map(t => `${t.database}/${t.container}`),
      ['meatgeek-prod/cooks', 'meatgeek-prod/devices', 'meatgeek-dev/cooks']
    );
  });

  it('applies database and container filters', async () => {
    const targets = await listTargets(fakeClient(spec), {
      databases: ['meatgeek-dev'],
      containers: ['cooks'],
    });
    assert.deepEqual(targets, [{ database: 'meatgeek-dev', container: 'cooks' }]);
  });

  it('surfaces an enumeration auth failure as an auth-coded ExportError', async () => {
    await assert.rejects(
      () => listTargets(fakeClient(spec, { listError: authError() })),
      err => {
        assert.equal(err.exitCode, EXIT.AUTH);
        assert.match(err.message, /enumerating databases/);
        return true;
      }
    );
  });
});
