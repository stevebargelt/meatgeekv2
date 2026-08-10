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

  // Exit 4 tells the operator to go and fix a role assignment; exit 5 tells them
  // to retry. A name-substring match sends a connection reset to the first of
  // those, so the identity names are matched exactly and nothing else is auth.
  it('maps every @azure/identity credential-acquisition failure to exit 4', () => {
    for (const name of [
      'CredentialUnavailableError',
      'AuthenticationError',
      'AuthenticationRequiredError',
      'AggregateAuthenticationError',
    ]) {
      assert.equal(classifyError({ name }), EXIT.AUTH, name);
    }
  });

  it('leaves a transport failure with a credential-shaped name on exit 5', () => {
    assert.equal(
      classifyError({ name: 'CredentialTransportError', code: 'ECONNRESET' }),
      EXIT.TRANSPORT
    );
    assert.equal(
      classifyError({ name: 'AuthenticationTransportError', statusCode: 500 }),
      EXIT.TRANSPORT
    );
    assert.equal(classifyError({ name: 'AuthenticationErrorHandler' }), EXIT.TRANSPORT);
  });

  it('keeps the HTTP status ahead of the name check', () => {
    assert.equal(
      classifyError({ statusCode: 429, name: 'AggregateAuthenticationError' }),
      EXIT.THROTTLED
    );
    assert.equal(classifyError({ statusCode: 401, name: 'RestError' }), EXIT.AUTH);
    assert.equal(classifyError({ statusCode: 403, name: 'RestError' }), EXIT.AUTH);
    assert.equal(classifyError({ code: 'Unauthorized' }), EXIT.AUTH);
    assert.equal(classifyError({ code: 'Forbidden' }), EXIT.AUTH);
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

    // Ours by construction and secret-free, so the scrub is deliberately not
    // applied to it — the help it gives an operator is the whole point.
    const usage = new ExportError(EXIT.AUTH, 'set COSMOS_EXPORT_KEY=<value> and retry');
    assert.equal(describeError(usage), 'set COSMOS_EXPORT_KEY=<value> and retry');
  });
});

// An unbracketed credential in an SDK message used to pass through verbatim.
// These pin the shapes that must never reach a terminal or a captured log.
describe('describeError secret scrubbing', () => {
  const ACCOUNT_KEY = 'Ab3xQ9zK7pLmN2vR5tYw8sD4fG6hJ1kZ0cV+bN/mQ==';
  const JWT =
    'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.dBjftJeZ4CVPmB92K27uhbUJU1p1rwW1gFWFOEjXk';
  const SAS_SIG = 'r7Uu4pQ2mKdN9wXvA1sZ0bTfHgYcJlEo3iRzQ6nMxSc%3D';

  const describeSdk = message =>
    describeError(Object.assign(new Error(message), { name: 'RestError' }));

  it('redacts an AccountKey out of a connection string', () => {
    const out = describeSdk(
      `Failed to connect using AccountEndpoint=https://meatgeek.documents.azure.com:443/;AccountKey=${ACCOUNT_KEY};`
    );
    assert.doesNotMatch(out, /Ab3xQ9zK/);
    assert.match(out, /AccountKey=\[redacted\]/);
    assert.match(out, /AccountEndpoint=\[redacted\]/);
    assert.match(out, /RestError/);
  });

  it('redacts bearer tokens and raw JWTs', () => {
    const bearer = describeSdk(`401 from token endpoint, sent Authorization: Bearer ${JWT}`);
    assert.doesNotMatch(bearer, /eyJ/);
    assert.match(bearer, /Bearer \[redacted\]/);

    const bare = describeSdk(`token ${JWT} was rejected`);
    assert.doesNotMatch(bare, /eyJ/);
    assert.match(bare, /\[redacted\]/);
  });

  it('redacts SAS token fragments', () => {
    const out = describeSdk(
      `GET https://x.blob.core.windows.net/c?sv=2021-08-06&ss=b&sig=${SAS_SIG} failed`
    );
    assert.doesNotMatch(out, /r7Uu4pQ2/);
    assert.doesNotMatch(out, /sv=2021/);
    assert.match(out, /sig=\[redacted\]/);
  });

  it('redacts any credential-shaped key=value pair', () => {
    for (const pair of [
      'password=hunter2correcthorse',
      'x-ms-token=abc123def456',
      'clientSecret=s3cr3tvalue',
      'apiKey=k-9911',
      'refresh_credential=zzz999',
    ]) {
      const out = describeSdk(`request failed with ${pair} in the payload`);
      assert.match(out, /=\[redacted\]/, pair);
      assert.doesNotMatch(out, /hunter2|abc123|s3cr3t|k-9911|zzz999/, pair);
    }
  });

  it('redacts a credential written JSON-style, with a colon and quotes', () => {
    for (const fragment of [
      `"AccountKey": "${ACCOUNT_KEY}"`,
      `'AccountKey': '${ACCOUNT_KEY}'`,
      `AccountKey: ${ACCOUNT_KEY}`,
      `"AccountKey":"${ACCOUNT_KEY}"`,
      `AccountKey=${ACCOUNT_KEY}`,
    ]) {
      const out = describeSdk(`failed ${fragment}`);
      assert.doesNotMatch(out, /Ab3xQ9zK|bN\/mQ|==/, fragment);
      assert.match(out, /\[redacted\]/, fragment);
    }
  });

  it('does not leak a secret when a malformed JSON-style key has mismatched quotes', () => {
    const secret = 'mismatched-quote-secret';
    const out = describeSdk(`failed "AccountKey': "${secret}"`);
    assert.doesNotMatch(out, new RegExp(secret));
    assert.match(out, /\[redacted\]/);
  });

  it('does not leave a secret tail after an escaped quote in a quoted value', () => {
    const secret = 'escaped-quote-secret';
    const out = describeSdk(`failed "AccountKey": "before\\"${secret}after"`);
    assert.doesNotMatch(out, new RegExp(secret));
    assert.match(out, /\[redacted\]/);
  });

  // Value consumption runs to end of line and never inspects quoting, so these
  // are all the same case to it. They are pinned individually because each one
  // is a shape a previous where-does-the-value-end rule got wrong.
  it('leaks nothing from any malformed quoting around a credential value', () => {
    for (const [label, fragment] of [
      ['unterminated opening quote', '"AccountKey": "sup3rs3cret'],
      ['nested quotes', `"AccountKey": ""sup3rs3cret""`],
      ['both quote kinds', `AccountKey="'sup3rs3cret'"`],
      ['separator inside the value', 'AccountKey=sup3rs3cret=more:andmore'],
      ['trailing backslashes', 'AccountKey="sup3rs3cret\\\\"'],
      ['quote-only value', `AccountKey="""`],
    ]) {
      const out = describeSdk(`failed ${fragment} while connecting`);
      assert.doesNotMatch(out, /sup3rs3cret/, label);
      assert.match(out, /\[redacted\]/, label);
    }
  });

  it('redacts an empty credential value without swallowing the key', () => {
    assert.match(describeSdk('failed AccountKey='), /AccountKey=\[redacted\]/);
    assert.match(describeSdk('failed "AccountKey": ""'), /"AccountKey": \[redacted\]/);
  });

  // End-of-line is the boundary, so everything after a credential on that line
  // is lost — including an exempt key. That is the deliberate trade: a dropped
  // diagnostic is cheap, a surviving fragment is not.
  it('consumes to end of line, so no trailing text can carry a fragment out', () => {
    const out = describeSdk('AccountKey=sup3rs3cret partitionKey=deviceId');
    assert.doesNotMatch(out, /sup3rs3cret/);
    assert.match(out, /AccountKey=\[redacted\]/);

    const multiline = describeSdk('failed AccountKey=sup3rs3cret\nretry advice');
    assert.doesNotMatch(multiline, /sup3rs3cret/);
  });

  // The mirror of the case above. With no exemption there is nothing that can
  // step over a key, so a benign key name leading a line cannot shield what
  // follows it — the first match consumes to end of line regardless.
  it('a benign key name leading the line cannot shield a credential behind it', () => {
    const out = describeSdk('query failed partitionKey=deviceId AccountKey=sup3rs3cret');
    assert.doesNotMatch(out, /sup3rs3cret/);
    assert.match(out, /partitionKey=\[redacted\]/);
  });

  it('does not let a quote inside a credential-shaped key turn its suffix into an exempt key', () => {
    const secret = 'quote-inside-key-secret';
    const out = describeSdk(`query failed AccountKey"partitionKey=${secret}`);

    assert.doesNotMatch(out, new RegExp(secret));
    assert.match(out, /\[redacted\]/);
  });

  // The generalisation of the case above, driven by what an attacker can place
  // rather than by what the scrubber happens to parse. Every one of these is a
  // character that would have had to act as a key-token boundary under some
  // exemption rule; with no exemption, none of them can reach a decision not to
  // redact, because there is no such decision left to reach. The last entry is
  // the one that matters most: a plain space is not attacker-exotic at all, and
  // no boundary rule built on whitespace could ever have refused it.
  it('lets no character placed around a benign key name carry a credential out', () => {
    const secret = 'sup3rs3cret';
    for (const [label, injected] of [
      ['double quote', `AccountKey"partitionKey`],
      ['single quote', `AccountKey'partitionKey`],
      ['backtick', 'AccountKey`partitionKey'],
      ['comma', 'AccountKey,partitionKey'],
      ['colon', 'AccountKey:partitionKey'],
      ['unterminated bracket', 'AccountKey[partitionKey'],
      ['backslash', 'AccountKey\\partitionKey'],
      ['no separator at all', 'AccountKeypartitionKey'],
      ['reverse order', 'partitionKey"AccountKey'],
      ['a plain space', 'AccountKey partitionKey'],
    ]) {
      const out = describeSdk(`query failed ${injected}=${secret}`);
      assert.doesNotMatch(out, new RegExp(secret), label);
      assert.match(out, /\[redacted\]/, label);
    }
  });

  // The accepted cost of deleting the exemption (MG-49): benign Cosmos key
  // names redact too. Pinned rather than merely tolerated, because the value of
  // having no exemption is that this list can never grow an escape hatch.
  it('redacts even benign Cosmos key names, since nothing is exempt', () => {
    for (const name of [
      'partitionKey',
      'partitionkey',
      'partitionKeyPath',
      'partitionKeyRangeId',
      'rangeKey',
      'keyspace',
    ]) {
      assert.match(describeSdk(`query failed ${name}=deviceId`), /\[redacted\]/, name);
      assert.doesNotMatch(describeSdk(`query failed ${name}=deviceId`), /deviceId/, name);
      assert.doesNotMatch(describeSdk(`query failed "${name}": "deviceId"`), /deviceId/, name);
    }
  });

  it('still redacts every real credential name — the exemption is not a hole', () => {
    for (const name of [
      'AccountKey',
      'primaryKey',
      'secondaryKey',
      'primaryMasterKey',
      'secondaryMasterKey',
      'masterKey',
      'authKey',
      'sig',
      'signature',
      'clientSecret',
      'password',
      'token',
    ]) {
      for (const fragment of [`${name}=sup3rs3cret`, `"${name}": "sup3rs3cret"`]) {
        const out = describeSdk(`failed ${fragment}`);
        assert.doesNotMatch(out, /sup3rs3cret/, fragment);
        assert.match(out, /\[redacted\]/, fragment);
      }
    }
  });

  it('redacts a name that merely contains a benign one', () => {
    for (const name of ['notApartitionKeySecret', 'partitionKeyOverride', 'myKeyspaceToken']) {
      const out = describeSdk(`failed ${name}=sup3rs3cret`);
      assert.doesNotMatch(out, /sup3rs3cret/, name);
      assert.match(out, /\[redacted\]/, name);
    }
  });

  it('scrubs before truncating, so a long message cannot leave half a secret', () => {
    // The key starts at char 195, so a 200-char cut applied first would leave
    // its first five characters standing in the log.
    const out = describeSdk(`${'context '.repeat(23)}AccountKey=${ACCOUNT_KEY};`);
    assert.doesNotMatch(out, /Ab3x/);
    assert.ok(out.length < 260);
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
