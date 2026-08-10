// Unit tests for the fixture tool's foundation: the exit vocabulary that makes
// every failure class distinguishable from every other one (and from success),
// the error classification that must never turn an auth failure into an absence,
// and the scrubbing that keeps credentials out of every operator-facing line.
//
// Dependency-free by contract: node: built-ins and the local fake only, so this
// file runs in the credentialless validate-infrastructure job with no npm
// install and no network.

import { strict as assert } from 'node:assert';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { describe, it } from 'node:test';

import {
  CHILD_OUTPUT_MAX_LINES,
  EXIT,
  FixtureError,
  TICKET,
  classifyError,
  describeError,
  exitLabel,
  scrubChildOutput,
  scrubSecrets,
  toFixtureError,
} from './fixture-core.mjs';
import {
  authError,
  credentialUnavailableError,
  docs,
  fakeAzSpawn,
  fakeCosmosClient,
  fakeReader,
  forbiddenError,
  throttleError,
  transportError,
} from './fake-azure.mjs';

const readSource = relative => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

describe('exit vocabulary', () => {
  // MG-53 and MG-54 act on what this tool concluded. Two failure classes sharing
  // a code makes "the route never delivered" indistinguishable from "your RBAC
  // grant has not propagated", which is the whole defect this vocabulary exists
  // to prevent.
  it('gives every failure class its own distinct nonzero code', () => {
    const entries = Object.entries(EXIT);
    const codes = entries.map(([, code]) => code);
    assert.equal(new Set(codes).size, codes.length, 'two exit codes collide');

    for (const [name, code] of entries) {
      if (name === 'OK') {
        assert.equal(code, 0);
        continue;
      }
      assert.ok(Number.isInteger(code), `${name} is not an integer`);
      assert.ok(code > 0, `${name} is not nonzero`);
      // 126, 127 and 128+n belong to the shell. A tool whose exit code can be
      // read as "command not found" cannot be scripted against.
      assert.ok(code < 126, `${name} collides with the shell's own range`);
    }
  });

  it('covers every failure class the ticket names', () => {
    for (const name of [
      'USAGE',
      'SEND_FAILURE',
      'TIMEOUT',
      'AUTH',
      'TRANSPORT',
      'MARKER_VIOLATION',
      'AMBIGUOUS',
      'CONTAINER_DEFINITION',
      'UNEXPECTED_PARTITION',
    ]) {
      assert.ok(name in EXIT, `no exit code for ${name}`);
    }
  });

  it('labels every code, distinctly, and admits when it does not know one', () => {
    const labels = Object.values(EXIT).map(exitLabel);
    for (const label of labels) {
      assert.notEqual(label, 'unknown');
    }
    assert.equal(new Set(labels).size, labels.length, 'two exit labels collide');
    assert.equal(exitLabel(99), 'unknown');
  });

  // Exit 0 means one thing: documents were read back OUT of Cosmos. The label
  // says so rather than saying 'ok', because a reader of a CI log should not be
  // able to mistake it for "the send did not error".
  it('labels success as a confirmed read-back, not as an absence of error', () => {
    assert.equal(exitLabel(EXIT.OK), 'confirmed-in-cosmos');
    assert.equal(exitLabel(EXIT.TIMEOUT), 'confirmation timeout');
    assert.equal(exitLabel(EXIT.MARKER_VIOLATION), 'synthetic marker violation');
    assert.equal(exitLabel(EXIT.AMBIGUOUS), 'correlation ambiguity');
  });

  it('carries the exit code on the error itself', () => {
    const err = new FixtureError(EXIT.TIMEOUT, 'nothing arrived within 120000ms');
    assert.ok(err instanceof Error);
    assert.equal(err.name, 'FixtureError');
    assert.equal(err.exitCode, EXIT.TIMEOUT);
  });

  it('names the ticket, so a marked document ties back to it', () => {
    assert.equal(TICKET, 'MG-67');
  });
});

describe('error classification', () => {
  it('classifies a 401 and the verbatim disableLocalAuth 403 as AUTH', () => {
    for (const err of [authError(), forbiddenError()]) {
      const code = classifyError(err);
      assert.equal(code, EXIT.AUTH, err.message);
      // The point of the assertion: an operator whose data-plane role assignment
      // has not propagated must not be told the route failed to deliver.
      assert.notEqual(code, EXIT.TRANSPORT);
      assert.notEqual(code, EXIT.TIMEOUT);
      assert.notEqual(code, EXIT.AMBIGUOUS);
      assert.notEqual(code, EXIT.SEND_FAILURE);
      assert.notEqual(code, EXIT.OK);
    }
  });

  it('classifies a credential that could not be acquired at all as AUTH', () => {
    assert.equal(classifyError(credentialUnavailableError()), EXIT.AUTH);
    for (const name of [
      'CredentialUnavailableError',
      'AuthenticationError',
      'AuthenticationRequiredError',
      'AggregateAuthenticationError',
    ]) {
      assert.equal(classifyError({ name }), EXIT.AUTH, name);
    }
    assert.equal(classifyError({ code: 'Unauthorized' }), EXIT.AUTH);
    assert.equal(classifyError({ code: 'Forbidden' }), EXIT.AUTH);
    assert.equal(classifyError({ statusCode: 403, name: 'RestError' }), EXIT.AUTH);
  });

  it('leaves a transport failure with a credential-shaped name on TRANSPORT', () => {
    assert.equal(classifyError(transportError()), EXIT.TRANSPORT);
    assert.equal(
      classifyError({ name: 'CredentialTransportError', code: 'ECONNRESET' }),
      EXIT.TRANSPORT
    );
    assert.equal(classifyError({ name: 'AuthenticationErrorHandler' }), EXIT.TRANSPORT);
    assert.equal(classifyError(new Error('something else')), EXIT.TRANSPORT);
  });

  // This tool reads a handful of documents, so it has no throttling class. A 429
  // is a retryable transport condition and an exhausted retry aborts — what it
  // must never become is an absence or a success.
  it('treats a 429 as a transport condition and never as an absence', () => {
    const code = classifyError(throttleError());
    assert.equal(code, EXIT.TRANSPORT);
    assert.notEqual(code, EXIT.OK);
    assert.notEqual(code, EXIT.TIMEOUT);
  });

  // Absence, timeout, marker violation and ambiguity are conclusions the
  // confirmation loop draws from what it READ. classifyError looks at an
  // exception, so it must be structurally incapable of manufacturing one.
  it('can only ever return AUTH or TRANSPORT', () => {
    const inputs = [
      authError(),
      forbiddenError(),
      transportError(),
      throttleError(),
      credentialUnavailableError(),
      new Error('boom'),
      {},
      null,
      undefined,
      { statusCode: 404 },
      { statusCode: 500 },
      { code: 'ETIMEDOUT' },
      'a thrown string',
    ];
    for (const input of inputs) {
      const code = classifyError(input);
      assert.ok(
        code === EXIT.AUTH || code === EXIT.TRANSPORT,
        `classifyError produced ${exitLabel(code)} for ${JSON.stringify(input)}`
      );
    }
  });
});

describe('toFixtureError', () => {
  it('passes an existing FixtureError through untouched', () => {
    const original = new FixtureError(EXIT.AMBIGUOUS, 'read back 2 of 3 documents');
    assert.equal(toFixtureError(original, 'confirming'), original);
  });

  it('wraps an SDK error with its class, its context and no secret', () => {
    const err = Object.assign(new Error('connect failed AccountKey=not-a-real-cosmos-key-0000=='), {
      name: 'RestError',
      statusCode: 500,
    });
    const wrapped = toFixtureError(err, 'polling temperatures for run r-1');
    assert.ok(wrapped instanceof FixtureError);
    assert.equal(wrapped.exitCode, EXIT.TRANSPORT);
    assert.match(wrapped.message, /polling temperatures for run r-1/);
    assert.doesNotMatch(wrapped.message, /not-a-real-cosmos-key/);
    assert.match(wrapped.message, /\[redacted\]/);
    assert.match(wrapped.message, /retries exhausted/);
  });

  it('says out loud that an auth failure is not an absence', () => {
    const wrapped = toFixtureError(forbiddenError(), 'polling temperatures');
    assert.equal(wrapped.exitCode, EXIT.AUTH);
    assert.match(wrapped.message, /NOT an absence/);
  });
});

// Every string below is a synthetic non-credential, hand-built to match the
// SHAPES the scrubber keys on. None of them is or ever was a real secret, and no
// real credential belongs in this repository on any path (HR1).
describe('describeError secret scrubbing', () => {
  const FAKE_ACCOUNT_KEY = 'not-a-real-account-key-0000AAAAbbbbCCCC==';
  const FAKE_DEVICE_KEY = 'not-a-real-shared-access-key-0000';
  const FAKE_JWT =
    'eyJmYWtlIjoidGVzdCJ9.eyJub3RfYV9yZWFsX3Rva2VuIjp0cnVlfQ.c2lnbmF0dXJlLWlzLWZha2U';
  const FAKE_SAS_SIG = 'not-a-real-signature-0000%3D';

  const describeSdk = message =>
    describeError(Object.assign(new Error(message), { name: 'RestError' }));

  it('keeps the diagnostic bits and drops anything document-shaped', () => {
    const err = Object.assign(new Error('conflict: {"id":"cook-1","userId":"steve"}'), {
      name: 'ErrorResponse',
      statusCode: 409,
    });
    const described = describeError(err);
    assert.match(described, /ErrorResponse/);
    assert.match(described, /status=409/);
    assert.match(described, /\[redacted\]/);
    assert.doesNotMatch(described, /cook-1/);
    assert.doesNotMatch(described, /steve/);
  });

  it('redacts an AccountKey out of a Cosmos connection string', () => {
    const out = describeSdk(
      `Failed to connect using AccountEndpoint=https://mgv2-dev-f640e19ae7ab.documents.azure.com:443/;AccountKey=${FAKE_ACCOUNT_KEY};`
    );
    assert.doesNotMatch(out, /not-a-real-account-key/);
    assert.match(out, /AccountKey=\[redacted\]/);
    assert.match(out, /AccountEndpoint=\[redacted\]/);
    assert.match(out, /RestError/);
  });

  // The IoT flavour, which the sibling tool never sees: a device connection
  // string is HostName=...;DeviceId=...;SharedAccessKey=... . This tool is built
  // so it never holds one, and the scrubber does not rely on that holding.
  it('redacts a device connection string, including the SharedAccessKey', () => {
    const out = describeSdk(
      `send failed for HostName=meatgeek-v2-dev-iothub-259d4bf5b628.azure-devices.net;DeviceId=d;SharedAccessKey=${FAKE_DEVICE_KEY}`
    );
    assert.doesNotMatch(out, /not-a-real-shared-access-key/);
    assert.match(out, /HostName=\[redacted\]/);
    assert.match(out, /SharedAccessKey=\[redacted\]/);
  });

  it('redacts bearer tokens and raw JWTs', () => {
    const bearer = describeSdk(`401 from token endpoint, sent Authorization: Bearer ${FAKE_JWT}`);
    assert.doesNotMatch(bearer, /eyJmYWtl/);
    assert.match(bearer, /Bearer \[redacted\]/);

    const bare = describeSdk(`token ${FAKE_JWT} was rejected`);
    assert.doesNotMatch(bare, /eyJmYWtl/);
    assert.match(bare, /\[redacted\]/);
  });

  it('redacts SAS token fragments', () => {
    const out = describeSdk(
      `GET https://x.blob.core.windows.net/c?sv=2021-08-06&sig=${FAKE_SAS_SIG} failed`
    );
    assert.doesNotMatch(out, /not-a-real-signature/);
    assert.doesNotMatch(out, /sv=2021/);
    assert.match(out, /sig=\[redacted\]/);
  });

  it('redacts any credential-shaped key=value pair, however it is written', () => {
    for (const fragment of [
      'password=not-a-real-password-0000',
      'x-ms-token=not-a-real-token-0000',
      'clientSecret=not-a-real-secret-0000',
      'apiKey=not-a-real-key-0000',
      `"AccountKey": "${FAKE_ACCOUNT_KEY}"`,
      `'AccountKey': '${FAKE_ACCOUNT_KEY}'`,
      `AccountKey: ${FAKE_ACCOUNT_KEY}`,
      // A malformed pair with mismatched quotes: the shape that leaked twice in
      // the sibling tool. An ambiguous parse redacts MORE, never less.
      `"AccountKey': "${FAKE_ACCOUNT_KEY}"`,
      '"AccountKey": "unterminated-not-a-real-key-0000',
      'AccountKey=not-a-real-key-0000=more:andmore',
    ]) {
      const out = describeSdk(`request failed with ${fragment} in the payload`);
      assert.match(out, /\[redacted\]/, fragment);
      assert.doesNotMatch(out, /not-a-real-(password|token|secret|key|account-key)/, fragment);
    }
  });

  it('redacts an empty credential value without swallowing the key', () => {
    assert.match(describeSdk('failed AccountKey='), /AccountKey=\[redacted\]/);
    assert.match(describeSdk('failed "AccountKey": ""'), /"AccountKey": \[redacted\]/);
  });

  // The MG-63 accepted limitation, pinned as intended behaviour so nobody
  // "fixes" it back into a where-does-the-value-end rule. Consumption runs to
  // end of line, so a benign diagnostic sharing the line is lost too.
  it('consumes to end of line, so no trailing text can carry a fragment out', () => {
    const out = describeSdk('AccountKey=not-a-real-key-0000 partitionKey=deviceId');
    assert.doesNotMatch(out, /not-a-real-key/);
    assert.match(out, /AccountKey=\[redacted\]/);
  });

  it('scrubs before capping, and never runs long', () => {
    const long = describeSdk(`${'x'.repeat(5000)} AccountKey=not-a-real-key-0000`);
    assert.ok(long.length < 260);
    assert.doesNotMatch(long, /not-a-real-key/);
  });

  it('passes a FixtureError message through unchanged', () => {
    const err = new FixtureError(
      EXIT.TIMEOUT,
      'device meatgeek-v2-dev-fixture-device: nothing arrived within 120000ms'
    );
    assert.equal(describeError(err), err.message);
  });

  it('never returns an empty diagnostic', () => {
    assert.equal(describeError(null), 'unknown error');
    assert.equal(describeError({}), 'unknown error');
    assert.equal(describeError(new Error('')), 'Error');
  });

  it('tolerates non-string input rather than throwing on a failure path', () => {
    assert.equal(scrubSecrets(undefined), '');
    assert.equal(scrubSecrets(42), '');
    assert.doesNotThrow(() => describeError({ message: { nested: 'object' } }));
  });
});

describe('scrubChildOutput', () => {
  it('redacts a credential the az child printed, and keeps the diagnostic', () => {
    const stderr = [
      'ERROR: The command failed with an unexpected error.',
      'Authorization: Bearer not-a-real-bearer-token-0000',
      'connection: HostName=hub.azure-devices.net;SharedAccessKey=not-a-real-key-0000',
    ].join('\n');
    const out = scrubChildOutput(stderr);
    assert.doesNotMatch(out, /not-a-real-bearer-token/);
    assert.doesNotMatch(out, /not-a-real-key/);
    assert.match(out, /unexpected error/);
    assert.match(out, /\[redacted\]/);
  });

  // Bracket redaction runs over the whole text before the split on purpose: a
  // JSON object az printed across several lines has its braces on different
  // lines, and a per-line scrub would leave every inner value intact.
  it('redacts a JSON blob spanning several lines rather than its braces only', () => {
    const out = scrubChildOutput('failed to send:\n{\n  "deviceKey": "not-a-real-key-0000"\n}\n');
    assert.doesNotMatch(out, /not-a-real-key/);
    assert.doesNotMatch(out, /deviceKey/);
    assert.match(out, /\[redacted\]/);
  });

  it('bounds the output and says how much it suppressed', () => {
    const many = Array.from({ length: CHILD_OUTPUT_MAX_LINES + 4 }, (_, i) => `line ${i}`).join(
      '\n'
    );
    const out = scrubChildOutput(many);
    const lines = out.split('\n');
    assert.equal(lines.length, CHILD_OUTPUT_MAX_LINES + 1);
    assert.match(lines.at(-1), /4 further line\(s\) suppressed/);
  });

  it('caps a single very long line after scrubbing, not before', () => {
    const out = scrubChildOutput(`${'y'.repeat(4000)} AccountKey=not-a-real-key-0000`);
    assert.doesNotMatch(out, /not-a-real-key/);
    assert.ok(out.length <= 200);
  });

  it('returns an empty string for nothing, so a caller emits no stray line', () => {
    assert.equal(scrubChildOutput(''), '');
    assert.equal(scrubChildOutput('   \n\n'), '');
    assert.equal(scrubChildOutput(undefined), '');
    assert.equal(scrubChildOutput(null), '');
  });
});

describe('the fake Cosmos reader', () => {
  it('records the parameterised query and the partition it was scoped to', async () => {
    const reader = fakeReader({ script: [{ docs: docs('temp', 2) }] });
    const found = await reader.queryDocuments({
      query: 'SELECT * FROM c WHERE c.runId = @runId',
      parameters: [{ name: '@runId', value: 'r-1' }],
      partitionKey: 'fixture-device',
    });
    assert.equal(found.length, 2);
    assert.equal(reader.calls.length, 1);
    assert.equal(reader.calls[0].partitionKey, 'fixture-device');
    assert.deepEqual(reader.calls[0].parameters, [{ name: '@runId', value: 'r-1' }]);
  });

  it('scripts outcomes per call, so a poll sequence and its errors are expressible', async () => {
    const reader = fakeReader({
      script: [{ docs: [] }, { error: transportError() }, { docs: docs('temp', 1) }],
      fallback: { docs: [] },
    });
    assert.deepEqual(await reader.queryDocuments({}), []);
    await assert.rejects(() => reader.queryDocuments({}), /socket hang up/);
    assert.equal((await reader.queryDocuments({})).length, 1);
    // Past the end of the script the fallback repeats, so a bounded polling loop
    // does not need its poll count known in advance.
    assert.deepEqual(await reader.queryDocuments({}), []);
    assert.equal(reader.calls.length, 4);
  });

  it('throws on every mutating method it exposes', () => {
    const reader = fakeReader();
    for (const method of [
      'createDocument',
      'upsertDocument',
      'replaceDocument',
      'patchDocument',
      'deleteDocument',
      'bulk',
    ]) {
      assert.throws(() => reader[method]({}), /read-only violation/, method);
    }
  });
});

describe('the fake Cosmos client', () => {
  const spec = () => ({
    'meatgeek-v2-dev-db': { temperatures: { script: [{ docs: docs('t', 1) }] } },
  });

  it('delegates a query and records whether it was cross-partition', async () => {
    const client = fakeCosmosClient(spec());
    const container = client.database('meatgeek-v2-dev-db').container('temperatures');
    const page = await container.items
      .query({ query: 'SELECT * FROM c', parameters: [] }, { partitionKey: 'd' })
      .fetchAll();
    assert.equal(page.resources.length, 1);
    assert.equal(client.calls[0].partitionKey, 'd');

    // No partitionKey option is how a cross-partition sweep is expressed, and
    // that distinction carries its own exit code, so it must be observable.
    await container.items.query({ query: 'SELECT * FROM c' }).fetchAll();
    assert.equal(client.calls[1].partitionKey, undefined);
  });

  it('throws on every mutating method the real client exposes', () => {
    const client = fakeCosmosClient(spec());
    const db = client.database('meatgeek-v2-dev-db');
    const container = db.container('temperatures');
    const guarded = [
      ['databases.create', () => client.databases.create({})],
      ['databases.createIfNotExists', () => client.databases.createIfNotExists({})],
      ['containers.create', () => db.containers.create({})],
      ['containers.createIfNotExists', () => db.containers.createIfNotExists({})],
      ['database.delete', () => db.delete()],
      ['items.create', () => container.items.create({})],
      ['items.upsert', () => container.items.upsert({})],
      ['items.bulk', () => container.items.bulk([])],
      ['items.batch', () => container.items.batch([])],
      ['container.item', () => container.item('id')],
      ['container.delete', () => container.delete()],
      ['container.replace', () => container.replace({})],
    ];
    for (const [name, call] of guarded) {
      assert.throws(call, /read-only violation/, name);
    }
  });
});

describe('the fake az spawn', () => {
  it('records the full argv of every invocation', async () => {
    const spawn = fakeAzSpawn({ script: [{ code: 0, stdout: 'sent' }] });
    const result = await spawn('az', ['iot', 'device', 'send-d2c-message', '--hub-name', 'h']);
    assert.equal(result.code, 0);
    assert.equal(result.stdout, 'sent');
    assert.equal(spawn.calls.length, 1);
    assert.deepEqual(spawn.calls[0].argv, ['iot', 'device', 'send-d2c-message', '--hub-name', 'h']);
  });

  it('scripts a nonzero exit with stderr, and a spawn that fails outright', async () => {
    const spawn = fakeAzSpawn({
      script: [
        { code: 1, stderr: 'ERROR: device not found' },
        { error: Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' }) },
      ],
    });
    const failed = await spawn('az', []);
    assert.equal(failed.code, 1);
    assert.match(failed.stderr, /device not found/);
    await assert.rejects(() => spawn('az', []), /ENOENT/);
  });
});

describe('module boundaries', () => {
  const SOURCES = ['./fixture-core.mjs', './fake-azure.mjs'];

  // This tier runs in validate-infrastructure, which installs nothing. An import
  // of an Azure package here would make the credentialless job unrunnable, and
  // an import of the sibling tool would couple this one-off proof to MG-66's
  // live deletion gate.
  // Only real import specifiers, not prose: both headers discuss cosmos-export
  // deliberately, and that documentation is worth keeping greppable.
  const importSpecifiers = source => [
    ...[...source.matchAll(/^\s*(?:import|export)\b[^\n]*?\sfrom\s*['"]([^'"]+)['"]/gm)].map(
      m => m[1]
    ),
    ...[...source.matchAll(/^\s*import\s+['"]([^'"]+)['"]/gm)].map(m => m[1]),
    ...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
  ];

  it('imports no Azure package and nothing from cosmos-export', async () => {
    for (const relative of SOURCES) {
      const source = await readSource(relative);
      for (const specifier of importSpecifiers(source)) {
        assert.ok(
          specifier.startsWith('node:') || specifier.startsWith('./'),
          `${relative} imports ${specifier}`
        );
        assert.doesNotMatch(
          specifier,
          /cosmos-export/,
          `${relative} imports from cosmos-export (${specifier})`
        );
      }
    }
  });

  // A grep is a blunt instrument, but it is the check that still holds when
  // someone adds a feature here in six months without reading the header.
  it('issues no mutating Cosmos call from the core', async () => {
    const source = await readSource('./fixture-core.mjs');
    for (const pattern of [
      /\.items\.create\b/,
      /\.items\.upsert\b/,
      /\.items\.bulk\b/,
      /\.items\.batch\b/,
      /\.item\(/,
      /\.containers\.create/,
      /\.databases\.create/,
      /executeBulkOperations/,
      /\.patch\(/,
      /\.upsert\(/,
    ]) {
      assert.equal(pattern.test(source), false, `fixture-core.mjs matches ${pattern}`);
    }
  });
});
