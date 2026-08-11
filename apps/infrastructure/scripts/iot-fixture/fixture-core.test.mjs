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
  CONFIRMATION_QUERY,
  D2C_CONTENT_ENCODING,
  D2C_CONTENT_TYPE,
  D2C_SYSTEM_PROPERTIES,
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  DEFAULT_TRANSPORT_RETRIES,
  EXIT,
  FIXTURE_DEVICE_ID,
  FixtureError,
  ID_SET_NAMES,
  MESSAGES_PER_RUN,
  RUN_ID_FIELD,
  RUN_ID_PARAMETER,
  SEQUENCE_FIELD,
  SYNTHETIC_MARKER,
  SYNTHETIC_MARKER_FIELD,
  TICKET,
  abortedConfirmation,
  buildFixtureMessages,
  classifyError,
  confirmArrival,
  createRunLedger,
  describeConfirmation,
  describeError,
  describeIdSets,
  evaluateReadBack,
  exitLabel,
  formatD2cProperties,
  hasSyntheticMarker,
  isSyntheticDocument,
  mergeIds,
  mustEmitEvidence,
  newRunId,
  observedIdsDiverge,
  scrubChildOutput,
  scrubSecrets,
  toFixtureError,
} from './fixture-core.mjs';
import {
  FakeAzureError,
  authError,
  credentialUnavailableError,
  docs,
  fakeAzSpawn,
  fakeClock,
  fakeCosmosClient,
  fakeReader,
  forbiddenError,
  throttleError,
  transportError,
} from './fake-azure.mjs';

const readSource = relative => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

// assert.throws returns nothing, and every refusal in this tool is asserted BY
// EXIT CODE rather than by message text, so the error itself has to come back.
const refusal = (fn, context = '') => {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof FixtureError, `${context}: threw ${err?.name}, not a FixtureError`);
    return err;
  }
  return assert.fail(`${context}: expected a FixtureError, nothing was thrown`);
};

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
      'EVIDENCE_UNRECORDED',
    ]) {
      assert.ok(name in EXIT, `no exit code for ${name}`);
    }
  });

  // The worst answer this tool could give is "nothing happened" while documents
  // sit in the live container. USAGE means exactly that — bad arguments, no live
  // effect — so the outcome for "a send happened and no record survived it" must
  // not be able to collapse into it.
  it('keeps "documents are live and unrecorded" apart from "nothing happened"', () => {
    assert.notEqual(EXIT.EVIDENCE_UNRECORDED, EXIT.USAGE);
    assert.notEqual(exitLabel(EXIT.EVIDENCE_UNRECORDED), exitLabel(EXIT.USAGE));
    assert.match(exitLabel(EXIT.EVIDENCE_UNRECORDED), /unrecorded/);
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
      `device ${FIXTURE_DEVICE_ID}: nothing arrived within 120000ms`
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

// The synthetic document contract (HR3). These are not shape tests for their own
// sake: MG-53 refuses to proceed if the source holds a document this fixture did
// not produce, and MG-54 cites these documents by id and count in a destructive
// authorization. Both need the marker to be unmistakable and the correlation to
// be exact.
describe('the synthetic document contract', () => {
  const PARTITION_FIELD = 'deviceId';
  const FIXED_CLOCK = () => Date.parse('2026-08-10T12:00:00.000Z');
  const build = (overrides = {}) =>
    buildFixtureMessages({
      runId: 'mg-67-run-fixed',
      partitionKeyField: PARTITION_FIELD,
      now: FIXED_CLOCK,
      ...overrides,
    });

  it('names the device unmistakably as a test fixture, not as an appliance', () => {
    assert.match(FIXTURE_DEVICE_ID, /fixture/);
    assert.match(FIXTURE_DEVICE_ID, /synthetic/);
    // It is a durable dev fixture MG-62 reuses, so it is scoped to dev and is
    // a legal IoT Hub device id.
    assert.match(FIXTURE_DEVICE_ID, /^[A-Za-z0-9-]{1,128}$/);
    assert.match(FIXTURE_DEVICE_ID, /dev/);
  });

  it('names the ticket in the marker, so a stray document explains itself', () => {
    assert.equal(SYNTHETIC_MARKER, 'MG-67-SYNTHETIC-FIXTURE');
    assert.ok(SYNTHETIC_MARKER.includes(TICKET), 'the marker does not name the ticket');
    assert.equal(SYNTHETIC_MARKER_FIELD, 'syntheticFixture');
  });

  it('puts the marker, the run id, the fixture device and a timestamp in every body', () => {
    const messages = build();
    assert.equal(messages.length, MESSAGES_PER_RUN);
    for (const message of messages) {
      const { body } = message;
      assert.equal(body[SYNTHETIC_MARKER_FIELD], SYNTHETIC_MARKER);
      assert.equal(body[RUN_ID_FIELD], 'mg-67-run-fixed');
      // Spelled exactly as the container's partition key path demands — the
      // same spelling apps/data-pusher/internal/wire/types.go marshals.
      assert.equal(body[PARTITION_FIELD], FIXTURE_DEVICE_ID);
      assert.equal(body.timestamp, '2026-08-10T12:00:00.000Z');
      assert.equal(body.ticket, TICKET);
      assert.equal(body[SEQUENCE_FIELD], message.sequence);
    }
    assert.deepEqual(
      messages.map(m => m.sequence),
      [1, 2, 3]
    );
  });

  it('survives the JSON round-trip the hub will put it through', () => {
    for (const { body } of build()) {
      const routed = JSON.parse(JSON.stringify(body));
      assert.deepEqual(routed, body);
      assert.ok(JSON.stringify(body).includes(SYNTHETIC_MARKER));
    }
  });

  // A constant, not a flag: the evidence record states a count MG-53 checks the
  // source against, and an operator-supplied count would let the recorded number
  // drift from the code.
  it('sends a fixed count that no argument can override', () => {
    assert.equal(MESSAGES_PER_RUN, 3);
    assert.equal(build({ count: 99 }).length, MESSAGES_PER_RUN);
    assert.equal(build({ messages: 0 }).length, MESSAGES_PER_RUN);
  });

  it('declares JSON content type and utf-8 encoding on every message', () => {
    for (const { systemProperties, messageId } of build()) {
      assert.equal(systemProperties[D2C_SYSTEM_PROPERTIES.CONTENT_TYPE], 'application/json');
      assert.equal(systemProperties[D2C_SYSTEM_PROPERTIES.CONTENT_ENCODING], 'utf-8');
      assert.equal(systemProperties[D2C_SYSTEM_PROPERTIES.MESSAGE_ID], messageId);
    }
    assert.equal(D2C_CONTENT_TYPE, 'application/json');
    assert.equal(D2C_CONTENT_ENCODING, 'utf-8');
    // Without both of these IoT Hub routes an opaque payload rather than a JSON
    // document, the marker becomes unqueryable, and the proof is impossible.
    assert.equal(D2C_SYSTEM_PROPERTIES.CONTENT_TYPE, '$.ct');
    assert.equal(D2C_SYSTEM_PROPERTIES.CONTENT_ENCODING, '$.ce');
  });

  it('renders the system properties in the form az takes', () => {
    const [message] = build();
    const rendered = formatD2cProperties(message.systemProperties);
    assert.equal(rendered, `$.ct=application/json;$.ce=utf-8;$.mid=${message.messageId}`);
  });

  // A mangled $.ct means the hub writes an opaque payload and the run then fails
  // as an absence for a reason that has nothing to do with the route. Refuse
  // rather than escape.
  it('refuses a system property carrying a delimiter, and an empty set', () => {
    for (const bad of [{ '$.ct': 'application/json;$.ce=utf-8' }, { '$.mid': 'has space' }]) {
      assert.equal(refusal(() => formatD2cProperties(bad)).exitCode, EXIT.USAGE);
    }
    assert.equal(refusal(() => formatD2cProperties({})).exitCode, EXIT.USAGE);
    assert.equal(refusal(() => formatD2cProperties(undefined)).exitCode, EXIT.USAGE);
  });

  it('mints a distinct run id per invocation and never repeats one', () => {
    const ids = new Set(Array.from({ length: 500 }, () => newRunId()));
    assert.equal(ids.size, 500);
    for (const id of ids) {
      assert.match(id, /^mg-67-run-[0-9a-f-]{36}$/);
    }
  });

  // HR2 repeatability: two runs produce two independently identified document
  // sets, and neither depends on setup the other performed.
  it('gives two successive builds different run ids and disjoint identifiers', () => {
    const first = build({ runId: newRunId() });
    const second = build({ runId: newRunId() });

    const runIdOf = messages => new Set(messages.map(m => m.body[RUN_ID_FIELD]));
    const firstRun = runIdOf(first);
    const secondRun = runIdOf(second);
    assert.equal(firstRun.size, 1);
    assert.equal(secondRun.size, 1);
    assert.notDeepEqual([...firstRun], [...secondRun]);

    const identifiers = messages => messages.flatMap(m => [m.messageId, m.body.id]);
    const firstIds = new Set(identifiers(first));
    assert.equal(firstIds.size, MESSAGES_PER_RUN, 'ids collide within one run');
    for (const id of identifiers(second)) {
      assert.equal(firstIds.has(id), false, `run 2 reused ${id}`);
    }
  });

  it('carries a sender-chosen id that is not the correlation key', () => {
    const [message] = build();
    assert.equal(message.body.id, message.messageId);
    // The id is NOT what the read-back matches on: the platform assigns the
    // document id and whether it honours this one is not pinned down anywhere.
    // A document with a completely different id still correlates.
    const renamed = { ...message.body, id: 'whatever-the-platform-chose' };
    assert.equal(isSyntheticDocument(renamed, 'mg-67-run-fixed'), true);
  });

  it('refuses a partition key that is a path, or that collides with the contract', () => {
    for (const bad of ['/deviceId', 'a/b', '', '  ', 'device-id', 42, null, undefined]) {
      const err = refusal(() => build({ partitionKeyField: bad }), `accepted ${String(bad)}`);
      assert.equal(err.exitCode, EXIT.USAGE);
    }
    // Landing the partition key on a contract field would overwrite the marker
    // or the run id and silently destroy the correlation.
    for (const reserved of ['id', 'timestamp', 'ticket', SYNTHETIC_MARKER_FIELD, RUN_ID_FIELD]) {
      const err = refusal(() => build({ partitionKeyField: reserved }), reserved);
      assert.equal(err.exitCode, EXIT.USAGE);
      assert.match(err.message, /collides/);
    }
  });

  // The partition key field is the one input here that came from outside (the
  // measured container definition), and the refusal echoes it — so the echo goes
  // through the scrubber, on this failure path like every other (HR1).
  it('scrubs the rejected partition key rather than echoing it back', () => {
    const err = refusal(() => build({ partitionKeyField: '/AccountKey=not-a-real-key-0000' }));
    assert.equal(err.exitCode, EXIT.USAGE);
    assert.doesNotMatch(err.message, /not-a-real-key/);
    assert.match(err.message, /\[redacted\]/);
    assert.equal(describeError(err), err.message);
  });

  it('refuses to build without a run id or a device', () => {
    for (const bad of ['', '   ', null, 7]) {
      assert.equal(refusal(() => build({ runId: bad })).exitCode, EXIT.USAGE);
      assert.equal(refusal(() => build({ deviceId: bad })).exitCode, EXIT.USAGE);
    }
    assert.equal(refusal(() => buildFixtureMessages()).exitCode, EXIT.USAGE);
  });
});

describe('isSyntheticDocument', () => {
  const RUN = 'mg-67-run-abc';
  const marked = (extra = {}) => ({
    id: `${RUN}-1`,
    deviceId: FIXTURE_DEVICE_ID,
    timestamp: '2026-08-10T12:00:00.000Z',
    [SYNTHETIC_MARKER_FIELD]: SYNTHETIC_MARKER,
    [RUN_ID_FIELD]: RUN,
    [SEQUENCE_FIELD]: 1,
    ...extra,
  });

  it('accepts a document this run built, including the fields Cosmos adds', () => {
    assert.equal(isSyntheticDocument(marked(), RUN), true);
    assert.equal(
      isSyntheticDocument(marked({ _ts: 1786000000, _rid: 'x', _etag: '"0000"' }), RUN),
      true
    );
    const [message] = buildFixtureMessages({ runId: RUN, partitionKeyField: 'deviceId' });
    assert.equal(isSyntheticDocument(message.body, RUN), true);
  });

  it('rejects a document with no marker — the MARKER VIOLATION shape', () => {
    const { [SYNTHETIC_MARKER_FIELD]: _dropped, ...unmarked } = marked();
    assert.equal(isSyntheticDocument(unmarked, RUN), false);
    assert.equal(hasSyntheticMarker(unmarked), false);
    // A real-looking temperature reading is exactly what must NOT pass.
    assert.equal(
      isSyntheticDocument(
        { id: 'r-1', deviceId: 'some-real-grill', timestamp: '2026-08-10T12:00:00.000Z' },
        RUN
      ),
      false
    );
  });

  it('rejects a marker that is merely truthy, or nearly right', () => {
    for (const value of [
      true,
      1,
      {},
      [],
      `${SYNTHETIC_MARKER}-tampered`,
      'MG-67',
      'mg-67-synthetic-fixture',
    ]) {
      assert.equal(
        isSyntheticDocument(marked({ [SYNTHETIC_MARKER_FIELD]: value }), RUN),
        false,
        JSON.stringify(value)
      );
    }
  });

  it('rejects a marked document carrying a DIFFERENT run id', () => {
    // Marked, so it is not a marker violation — it is simply another run's
    // document, and counting it would make a partial arrival look complete.
    const other = marked({ [RUN_ID_FIELD]: 'mg-67-run-somebody-else' });
    assert.equal(hasSyntheticMarker(other), true);
    assert.equal(isSyntheticDocument(other, RUN), false);
    const { [RUN_ID_FIELD]: _dropped, ...noRun } = marked();
    assert.equal(isSyntheticDocument(noRun, RUN), false);
    assert.equal(isSyntheticDocument(marked({ [RUN_ID_FIELD]: `${RUN}-1` }), RUN), false);
  });

  it('rejects anything that is not a plain object', () => {
    for (const value of [
      null,
      undefined,
      0,
      '',
      'a string',
      JSON.stringify(marked()),
      [marked()],
      [],
    ]) {
      assert.equal(isSyntheticDocument(value, RUN), false, JSON.stringify(value) ?? 'undefined');
      assert.equal(hasSyntheticMarker(value), false);
    }
  });

  // Returning false for a missing run id would read as an absence and end as a
  // timeout — a caller bug misattributed to the route. Throw instead.
  it('throws rather than returning false when the caller supplies no run id', () => {
    for (const bad of [undefined, null, '', '   ', 5]) {
      const err = refusal(() => isSyntheticDocument(marked(), bad), String(bad));
      assert.equal(err.exitCode, EXIT.USAGE);
    }
  });
});

// ---------------------------------------------------------------------------
// THE DOCUMENT CONTRACT MEETS THE EVIDENCE-EMISSION CONTRACT.
//
// The ledger's own suite drives it with placeholder ids ('msg-1'). This one
// drives it with the ids buildFixtureMessages ACTUALLY MINTS, because the join is
// where the defect the contract answers lives: the artifact MG-53 and MG-54 parse
// records ids, and an id in it the document contract never minted — or one it
// minted that a later failure quietly dropped — is a claim about what the live
// container holds that nobody witnessed.
//
// So these assert the CONTRACT, not the symptoms it was extracted from: for every
// terminal outcome the exit vocabulary can produce after an attempt, a record is
// required and its four id sets are individually correct.
// ---------------------------------------------------------------------------
describe('the document contract under the evidence-emission contract', () => {
  const RUN = 'mg-67-run-joined';
  const FIXED_CLOCK = () => Date.parse('2026-08-10T12:00:00.000Z');
  const built = () =>
    buildFixtureMessages({ runId: RUN, partitionKeyField: 'deviceId', now: FIXED_CLOCK });
  const mintedIds = () => built().map(message => message.messageId);

  // A document as COSMOS hands it back: the body, plus the platform's own
  // bookkeeping, under whichever id the platform chose. Whether it honours the
  // sender's `id` is behaviour no file in this repo pins down, so both are
  // modelled and neither is assumed.
  const routed = (message, id = message.body.id) => ({ ...message.body, id, _ts: 1786000000 });

  // Enumerated FROM the vocabulary rather than listed by hand: an exit code added
  // later has to land in one bucket or the other, and this test is where it is
  // forced to. USAGE and CONTAINER_DEFINITION are the only two refusals that can
  // precede the first attempt — everything else means the live system was already
  // touched, and a record is owed.
  const PRE_ATTEMPT_ONLY = new Set([EXIT.USAGE, EXIT.CONTAINER_DEFINITION]);
  const POST_ATTEMPT_CODES = Object.values(EXIT).filter(
    code => code !== EXIT.OK && !PRE_ATTEMPT_ONLY.has(code)
  );

  it('mints the ids the ledger records as requested, and no others', () => {
    const messages = built();
    const run = createRunLedger({ runId: RUN });
    for (const message of messages) run.accept(run.request(message.messageId));
    const snapshot = run.snapshot({
      confirmation: { confirmed: true, observedIds: messages.map(m => m.body.id) },
    });

    // requestedIds ARE the document contract's minted ids, in send order.
    assert.deepEqual([...snapshot.requestedIds], [`${RUN}-1`, `${RUN}-2`, `${RUN}-3`]);
    assert.deepEqual([...snapshot.requestedIds], mintedIds());
    assert.equal(snapshot.requestedIds.length, MESSAGES_PER_RUN);
    // The one certain combination, reached only here.
    assert.equal(snapshot.uncertain, false);
    assert.equal(snapshot.idDivergence, false);
    assert.equal(mustEmitEvidence(snapshot), true);
  });

  // The crux, with real ids: az fails on message 1 of 3. The two messages the run
  // never reached are not failures and must appear NOWHERE — recording them would
  // put ids in the artifact for documents that cannot exist — while message 1 is
  // recorded as the unknown it is, never as proof nothing was written.
  it('records a failure on message 1 of 3 against that minted id alone', () => {
    const messages = built();
    const run = createRunLedger({ runId: RUN });
    run.markAmbiguous(run.request(messages[0].messageId));
    const snapshot = run.snapshot();

    assert.deepEqual([...snapshot.requestedIds], [`${RUN}-1`]);
    assert.deepEqual([...snapshot.acceptedIds], []);
    assert.deepEqual([...snapshot.ambiguousIds], [`${RUN}-1`]);
    assert.deepEqual([...snapshot.observedIds], []);
    assert.equal(snapshot.attempted, true);
    assert.equal(snapshot.uncertain, true);
    assert.equal(mustEmitEvidence(snapshot), true);

    const serialized = JSON.stringify(snapshot);
    for (const unattempted of [`${RUN}-2`, `${RUN}-3`]) {
      assert.equal(serialized.includes(unattempted), false, `${unattempted} was never attempted`);
    }
    // A shortfall is not a renaming: one of three attempted, none observed,
    // witnesses nothing about the platform's id behaviour.
    assert.equal(snapshot.idDivergence, false);
    assert.doesNotMatch(describeIdSets(snapshot), /nothing was (?:sent|written)|nothing arrived/i);
  });

  // The property every one of the patched paths violated in its own way, asserted
  // across the WHOLE vocabulary rather than on the one path a reviewer found: a
  // document read back on an earlier poll is IN the container, and a later auth
  // failure, transport abort, marker violation or timeout is new information about
  // the reader — not a retraction of what it already read.
  it('keeps an observed document through every terminal outcome, and still owes a record', () => {
    assert.ok(POST_ATTEMPT_CODES.length >= 8, 'the vocabulary lost a post-attempt outcome');

    for (const exitCode of POST_ATTEMPT_CODES) {
      const messages = built();
      const run = createRunLedger({ runId: RUN });
      for (const message of messages) run.accept(run.request(message.messageId));
      // Poll two read one document back. Then the run aborted with this outcome.
      run.observe([routed(messages[0], 'cosmos-assigned-1').id]);
      const snapshot = run.snapshot({
        confirmation: abortedConfirmation({
          runId: RUN,
          exitCode,
          reason: `aborted with ${exitLabel(exitCode)}`,
        }),
      });

      const where = exitLabel(exitCode);
      assert.deepEqual([...snapshot.observedIds], ['cosmos-assigned-1'], where);
      assert.deepEqual([...snapshot.requestedIds], mintedIds(), where);
      assert.deepEqual([...snapshot.acceptedIds], mintedIds(), where);
      assert.deepEqual([...snapshot.ambiguousIds], [], where);
      assert.equal(snapshot.uncertain, true, where);
      assert.equal(mustEmitEvidence(snapshot), true, where);
      // Witnessed: a document came back under an id this run did not mint.
      assert.equal(snapshot.idDivergence, true, where);
    }
  });

  // Correlation is marker + run id INSIDE the device's partition, and the
  // sender-chosen id is not the key. A neighbouring run's document is marked and
  // well-formed and still is not this run's — counting it would make a partial
  // arrival look complete, which is the one way this tool could exit 0 wrongly.
  it('correlates on marker and run id, so another run cannot be counted as this one', () => {
    const [mine] = built();
    const [theirs] = buildFixtureMessages({
      runId: newRunId(),
      partitionKeyField: 'deviceId',
      now: FIXED_CLOCK,
    });

    assert.equal(isSyntheticDocument(routed(mine), RUN), true);
    // Renamed by the platform: still ours.
    assert.equal(isSyntheticDocument(routed(mine, 'cosmos-assigned-9'), RUN), true);
    // Marked, same device, same partition — a different run.
    assert.equal(hasSyntheticMarker(routed(theirs)), true);
    assert.equal(isSyntheticDocument(routed(theirs), RUN), false);
    // And an id collision cannot smuggle it in: the id is not the correlator.
    assert.equal(isSyntheticDocument(routed(theirs, mine.body.id), RUN), false);
  });

  it('flags divergence only for a minted id the platform actually replaced', () => {
    const messages = built();
    const requestedIds = mintedIds();

    // Honoured: the ids that came back are the ones the bodies carried.
    const honoured = messages.map(message => routed(message).id);
    assert.equal(observedIdsDiverge({ observedIds: honoured, requestedIds }), false);
    // Witnessed replacement.
    assert.equal(observedIdsDiverge({ observedIds: ['cosmos-assigned-1'], requestedIds }), true);
    // A shortfall is an incomplete read-back and NOTHING else. Inferring a
    // renaming from it would put a fabricated claim in the one artifact MG-53 and
    // MG-54 parse mechanically.
    assert.equal(observedIdsDiverge({ observedIds: honoured.slice(0, 2), requestedIds }), false);
  });

  // The vocabulary is operator-facing contract text, and it defined SEND_FAILURE
  // as "Nothing was sent." — the exact claim the contract forbids, stated where an
  // operator and every later reader of this file would take it as settled.
  it('defines no exit code as an assertion that nothing was written', async () => {
    const source = await readSource('./fixture-core.mjs');
    const vocabulary = source.slice(
      source.indexOf('export const EXIT = {'),
      source.indexOf('const EXIT_LABELS')
    );
    assert.ok(vocabulary.includes('SEND_FAILURE'), 'the exit vocabulary was not located');
    assert.doesNotMatch(vocabulary, /failed\.\s*\n?\s*\/\/\s*Nothing was sent\./);
    assert.match(vocabulary, /ambiguous BY CONSTRUCTION/);
  });
});

// The fail-closed confirmation read-back (HR2). Every outcome below is asserted
// BY EXIT CODE rather than by prose, because the exit code is what the operator
// and the two downstream tickets act on — and because "fail-closed" asserted in a
// comment is exactly the kind of claim this repo has shipped behind before.
//
// Nothing here sleeps: the clock and the wait are injected, so a 20-second bound
// elapses in microseconds while the real deadline arithmetic still runs.
describe('the confirmation read-back', () => {
  const RUN = 'mg-67-run-confirm';
  const BOUND = 20_000;
  const INTERVAL = 5_000;
  // With this bound and interval the loop polls at 0, 5s, 10s, 15s and 20s, so a
  // wait that never finds anything issues five partition-scoped polls and then
  // exactly one cross-partition sweep.
  const POLLS_TO_BOUND = 5;
  const SWEEP_CALL_INDEX = POLLS_TO_BOUND;

  // Documents as COSMOS returns them, not as the sender built them: the id
  // prefix is deliberately not the sender's, since whether the platform honours
  // a supplied id is behaviour no file in this repo pins down. What the
  // read-back reports must be what it OBSERVED.
  const routed = (
    count,
    {
      runId = RUN,
      idPrefix = 'cosmos-assigned',
      partitionValue = FIXTURE_DEVICE_ID,
      unmarked = false,
      firstSequence = 1,
    } = {}
  ) =>
    Array.from({ length: count }, (_, i) => {
      const doc = {
        id: `${idPrefix}-${i + 1}`,
        deviceId: partitionValue,
        timestamp: '2026-08-10T12:00:00.000Z',
        [SYNTHETIC_MARKER_FIELD]: SYNTHETIC_MARKER,
        [RUN_ID_FIELD]: runId,
        [SEQUENCE_FIELD]: firstSequence + i,
        // The properties Cosmos adds. They must not disturb the correlation.
        _ts: 1_786_000_000,
        _rid: 'fixture-rid',
        _etag: '"0000-0000"',
      };
      if (unmarked) delete doc[SYNTHETIC_MARKER_FIELD];
      return doc;
    });

  const confirm = async (spec, overrides = {}) => {
    const clock = fakeClock();
    const reader = fakeReader(spec);
    const result = await confirmArrival({
      reader,
      runId: RUN,
      partitionKeyField: 'deviceId',
      timeoutMs: BOUND,
      pollIntervalMs: INTERVAL,
      now: clock.now,
      sleep: clock.sleep,
      ...overrides,
    });
    return { result, reader, clock };
  };

  const asyncRefusal = async (fn, context = '') => {
    try {
      await fn();
    } catch (err) {
      assert.ok(err instanceof FixtureError, `${context}: threw ${err?.name}, not a FixtureError`);
      return err;
    }
    return assert.fail(`${context}: expected a FixtureError, nothing was thrown`);
  };

  // Every non-success outcome must be nonzero AND distinct from every other
  // outcome's code, so this is asserted on each scenario rather than once.
  const assertFailed = (result, expected, context) => {
    assert.equal(result.exitCode, expected, `${context}: ${describeConfirmation(result)}`);
    assert.equal(result.confirmed, false, `${context}: reported confirmed on a failure`);
    assert.notEqual(result.exitCode, EXIT.OK, context);
    for (const other of [
      EXIT.TIMEOUT,
      EXIT.AUTH,
      EXIT.TRANSPORT,
      EXIT.MARKER_VIOLATION,
      EXIT.AMBIGUOUS,
      EXIT.UNEXPECTED_PARTITION,
    ]) {
      if (other !== expected) assert.notEqual(result.exitCode, other, `${context} collided`);
    }
  };

  it('confirms only when the expected count is read back, and reports the delay', async () => {
    const { result, reader, clock } = await confirm({
      script: [{ docs: [] }, { docs: [] }, { docs: routed(MESSAGES_PER_RUN) }],
    });

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(result.confirmed, true);
    assert.equal(result.observedCount, MESSAGES_PER_RUN);
    // Routing is asynchronous, so the delay is the calibration the first live
    // run hands to every later ticket. Two empty polls at a 5s cadence.
    assert.equal(result.observedArrivalMs, 2 * INTERVAL);
    assert.equal(result.polls, 3);
    assert.equal(reader.calls.length, 3);
    assert.deepEqual(clock.sleeps, [INTERVAL, INTERVAL]);
    assert.equal(result.crossPartitionSweepRun, false);
    assert.equal(result.scope, 'expected-partition');
  });

  it('reports the ids the read-back OBSERVED, not the ones the sender hoped for', async () => {
    const requested = buildFixtureMessages({ runId: RUN, partitionKeyField: 'deviceId' }).map(
      message => message.body.id
    );
    const { result } = await confirm({ script: [{ docs: routed(MESSAGES_PER_RUN) }] });

    assert.deepEqual(result.observedIds, [
      'cosmos-assigned-1',
      'cosmos-assigned-2',
      'cosmos-assigned-3',
    ]);
    for (const id of requested) {
      assert.equal(result.observedIds.includes(id), false, `reported the requested id ${id}`);
    }
    assert.deepEqual(result.observedPartitionValues, [FIXTURE_DEVICE_ID]);
  });

  it('exits TIMEOUT when the bound elapses with nothing found anywhere', async () => {
    const startedWall = Date.now();
    const { result, reader, clock } = await confirm({ fallback: { docs: [] } });

    assertFailed(result, EXIT.TIMEOUT, 'nothing within the bound');
    assert.equal(result.observedCount, 0);
    assert.equal(result.polls, POLLS_TO_BOUND);
    // The absence is only reported AFTER the cross-partition sweep came back
    // empty too — see the unexpected-partition case below.
    assert.equal(result.crossPartitionSweepRun, true);
    assert.equal(reader.calls.length, POLLS_TO_BOUND + 1);
    assert.equal(result.elapsedMs, BOUND);
    assert.equal(clock.elapsed(), BOUND);
    // The bound elapsed on the injected clock, not on the wall clock: no test
    // sleeps, which is what keeps a 180s production default testable at all.
    assert.ok(Date.now() - startedWall < 1_000, 'the test actually waited');
  });

  it('exits AUTH immediately on a 403, with no further poll and no timeout code', async () => {
    const { result, reader, clock } = await confirm({
      script: [{ error: forbiddenError() }],
      fallback: { docs: routed(MESSAGES_PER_RUN) },
    });

    assertFailed(result, EXIT.AUTH, 'a 403 on the first poll');
    // The single most likely failure of the live run is a data-plane role
    // assignment that has not propagated. Telling that operator "the route did
    // not deliver" would send them to rebuild working infrastructure.
    assert.equal(reader.calls.length, 1, 'polled again after an auth failure');
    assert.deepEqual(clock.sleeps, []);
    assert.equal(result.elapsedMs, 0);
    assert.equal(result.crossPartitionSweepRun, false);
    assert.match(result.reason, /NOTHING about whether the route delivered/);
  });

  it('exits AUTH on a 401 and on a credential that could not be acquired', async () => {
    for (const error of [authError(), credentialUnavailableError()]) {
      const { result, reader } = await confirm({ script: [{ error }] });
      assertFailed(result, EXIT.AUTH, error.name);
      assert.equal(reader.calls.length, 1);
    }
  });

  it('exits TRANSPORT once retries are exhausted, rather than waiting out the bound', async () => {
    const { result, reader } = await confirm(
      { fallback: { error: transportError() } },
      { maxTransportRetries: 1 }
    );

    assertFailed(result, EXIT.TRANSPORT, 'transport retries exhausted');
    assert.equal(reader.calls.length, 2, 'retry budget not honoured');
    // It ABORTS. A transport failure that quietly burned the rest of the bound
    // would be reported as an absence, which is the conflation this refuses.
    assert.ok(result.elapsedMs < BOUND, 'kept polling past the retry budget');
    assert.equal(result.crossPartitionSweepRun, false);
  });

  it('retries a transport failure inside the budget and can still confirm', async () => {
    const { result, reader } = await confirm({
      script: [{ error: transportError() }, { docs: routed(MESSAGES_PER_RUN) }],
    });

    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(result.confirmed, true);
    assert.equal(reader.calls.length, 2);
    assert.equal(result.observedArrivalMs, INTERVAL);
  });

  it('exits MARKER VIOLATION for a document read back without the marker', async () => {
    for (const [context, page] of [
      ['every document unmarked', routed(MESSAGES_PER_RUN, { unmarked: true })],
      [
        'one document unmarked',
        [...routed(2), ...routed(1, { unmarked: true, idPrefix: 'stray', firstSequence: 3 })],
      ],
    ]) {
      const { result, reader, clock } = await confirm({ script: [{ docs: page }] });
      assertFailed(result, EXIT.MARKER_VIOLATION, context);
      // A defect in the sender, established on the first page — there is nothing
      // to wait for.
      assert.equal(reader.calls.length, 1, context);
      assert.deepEqual(clock.sleeps, [], context);
      assert.match(result.reason, /defect in the sender/);
    }
  });

  it('exits AMBIGUOUS for a partial set at the bound, and never TIMEOUT', async () => {
    const { result, reader } = await confirm({ fallback: { docs: routed(2) } });

    assertFailed(result, EXIT.AMBIGUOUS, '2 of 3 at the bound');
    assert.equal(result.observedCount, 2);
    assert.equal(result.expectedCount, MESSAGES_PER_RUN);
    assert.deepEqual(result.observedIds, ['cosmos-assigned-1', 'cosmos-assigned-2']);
    assert.equal(result.polls, POLLS_TO_BOUND);
    // Documents DID arrive under the expected partition, so the sweep would
    // answer a question nobody asked.
    assert.equal(result.crossPartitionSweepRun, false);
    assert.equal(reader.calls.length, POLLS_TO_BOUND);
  });

  it('keeps waiting on a partial set while the bound still has room', async () => {
    const { result } = await confirm({
      script: [{ docs: routed(1) }, { docs: routed(2) }, { docs: routed(MESSAGES_PER_RUN) }],
    });
    assert.equal(result.exitCode, EXIT.OK);
    assert.equal(result.observedCount, MESSAGES_PER_RUN);
    assert.equal(result.observedArrivalMs, 2 * INTERVAL);
  });

  it('exits AMBIGUOUS for every unreadable or non-deterministic read-back', async () => {
    const one = routed(1)[0];
    const cases = [
      ['duplicate documents', [one, { ...one }]],
      ['a duplicate sequence under different ids', [one, { ...one, id: 'cosmos-assigned-9' }]],
      ['more documents than were sent', routed(MESSAGES_PER_RUN + 1)],
      ['a foreign run id in the page', [...routed(2), ...routed(1, { runId: 'mg-67-run-other' })]],
      ['a document with no usable id', [{ ...one, id: '' }]],
      ['a document that is not an object', [one, 'not-a-document']],
      ['a null where a document was expected', [null]],
      ['a reader that answered with something other than a list', 'not-a-list'],
    ];

    for (const [context, page] of cases) {
      const { result } = await confirm({ script: [{ docs: page }] });
      assertFailed(result, EXIT.AMBIGUOUS, context);
      // Each of these is a FAILURE, never an absence and never a success.
      assert.notEqual(result.exitCode, EXIT.TIMEOUT, context);
      assert.ok(result.reason.length > 0, context);
    }
  });

  it('distinguishes delivered-under-an-unexpected-partition from not delivered', async () => {
    const { result, reader } = await confirm({
      script: [
        ...Array.from({ length: POLLS_TO_BOUND }, () => ({ docs: [] })),
        { docs: routed(MESSAGES_PER_RUN, { partitionValue: 'some-other-partition' }) },
      ],
      fallback: { docs: [] },
    });

    // Nothing between the device and Cosmos injects a partition key, so the body
    // is the only source of one. Reporting this as an absence would call a
    // WORKING route broken.
    assertFailed(result, EXIT.UNEXPECTED_PARTITION, 'found only cross-partition');
    assert.notEqual(result.exitCode, EXIT.TIMEOUT);
    assert.equal(result.observedCount, MESSAGES_PER_RUN);
    assert.deepEqual(result.observedPartitionValues, ['some-other-partition']);
    // The operator needs to be told WHERE they landed, or the finding is not
    // actionable — this is the whole reason the sweep exists.
    assert.match(result.reason, /some-other-partition/);
    assert.match(result.reason, new RegExp(FIXTURE_DEVICE_ID));
    assert.equal(result.crossPartitionSweepRun, true);
    // Scoped first, swept once — and the sweep is what an omitted partitionKey
    // means on the wire.
    assert.equal(reader.calls[0].partitionKey, FIXTURE_DEVICE_ID);
    assert.equal(reader.calls[SWEEP_CALL_INDEX].partitionKey, undefined);
    assert.equal(reader.calls.length, POLLS_TO_BOUND + 1);
  });

  it('classifies a failure of the sweep itself rather than calling it an absence', async () => {
    const empties = Array.from({ length: POLLS_TO_BOUND }, () => ({ docs: [] }));
    for (const [error, expected] of [
      [forbiddenError(), EXIT.AUTH],
      [transportError(), EXIT.TRANSPORT],
    ]) {
      const { result } = await confirm({ script: [...empties, { error }] });
      assertFailed(result, expected, `sweep failed with ${error.name}`);
      assert.equal(result.scope, 'cross-partition');
      assert.equal(result.crossPartitionSweepRun, true);
    }
  });

  it('reports an unmarked document found by the sweep as a marker violation', async () => {
    const empties = Array.from({ length: POLLS_TO_BOUND }, () => ({ docs: [] }));
    const { result } = await confirm({
      script: [...empties, { docs: routed(MESSAGES_PER_RUN, { unmarked: true }) }],
    });
    assertFailed(result, EXIT.MARKER_VIOLATION, 'unmarked documents found cross-partition');
  });

  // The single assertion that has to hold on every path: an operator reading a
  // timeout must be able to see what it timed out against, and the evidence
  // artifact records the bound as the calibration for later tickets.
  it('reports the wait bound actually used on every path, success or failure', async () => {
    const empties = Array.from({ length: POLLS_TO_BOUND }, () => ({ docs: [] }));
    const paths = [
      ['success', { script: [{ docs: routed(MESSAGES_PER_RUN) }] }, EXIT.OK],
      ['timeout', { fallback: { docs: [] } }, EXIT.TIMEOUT],
      ['auth', { script: [{ error: forbiddenError() }] }, EXIT.AUTH],
      ['transport', { fallback: { error: transportError() } }, EXIT.TRANSPORT],
      [
        'marker violation',
        { script: [{ docs: routed(1, { unmarked: true }) }] },
        EXIT.MARKER_VIOLATION,
      ],
      ['ambiguous', { script: [{ docs: routed(MESSAGES_PER_RUN + 1) }] }, EXIT.AMBIGUOUS],
      [
        'unexpected partition',
        {
          script: [...empties, { docs: routed(MESSAGES_PER_RUN, { partitionValue: 'elsewhere' }) }],
        },
        EXIT.UNEXPECTED_PARTITION,
      ],
    ];

    for (const [context, spec, expected] of paths) {
      const { result } = await confirm(spec);
      assert.equal(result.exitCode, expected, context);
      assert.equal(result.waitBoundMs, BOUND, `${context}: the bound is missing from the result`);
      assert.equal(result.pollIntervalMs, INTERVAL, context);
      assert.ok(result.polls > 0, `${context}: reported no poll at all`);
      assert.equal(typeof result.elapsedMs, 'number', context);
      assert.equal(result.runId, RUN, context);
      assert.equal(exitLabel(result.exitCode), result.exitLabel, context);
      assert.match(describeConfirmation(result), new RegExp(`bound ${BOUND}ms`), context);
      // Fail-closed, asserted structurally: confirmed is true on exactly one
      // path, and only with the full expected count read back.
      assert.equal(result.confirmed, expected === EXIT.OK, context);
      // The evidence-emission contract, on every terminal outcome: anything
      // short of a completed confirmation leaves what the container holds an
      // open question, and the RECORD says so rather than leaving an operator to
      // infer it from a count of zero.
      assert.equal(result.uncertain, expected !== EXIT.OK, `${context}: wrong uncertainty`);
      if (result.confirmed) {
        assert.equal(result.observedCount, result.expectedCount, context);
        assert.equal(typeof result.observedArrivalMs, 'number', context);
      } else {
        assert.ok(result.exitCode > 0, context);
        assert.equal(result.observedArrivalMs, null, context);
      }
    }
  });

  it('matches on the run id as a bound parameter, and validates the marker itself', async () => {
    const { reader } = await confirm({ script: [{ docs: routed(MESSAGES_PER_RUN) }] });
    const [call] = reader.calls;

    assert.equal(call.query, CONFIRMATION_QUERY);
    assert.deepEqual(call.parameters, [{ name: RUN_ID_PARAMETER, value: RUN }]);
    // The run id travels as a parameter, never interpolated into the SQL.
    assert.equal(call.query.includes(RUN), false);
    assert.ok(call.query.includes(RUN_ID_FIELD));
    // And the predicate deliberately does NOT filter on the marker: if it did,
    // the service would filter out exactly the documents the marker check exists
    // to catch, and MARKER VIOLATION would be an outcome only a fake could
    // produce.
    assert.equal(call.query.includes(SYNTHETIC_MARKER_FIELD), false);
    assert.equal(call.query.includes(SYNTHETIC_MARKER), false);
  });

  it('scrubs a credential out of a read-back failure, on the failure path', async () => {
    const leaky = new FakeAzureError(
      'connect failed AccountEndpoint=https://x.documents.azure.com/;AccountKey=not-a-real-account-key-0000==',
      { statusCode: 500, name: 'RestError' }
    );
    const { result } = await confirm({ fallback: { error: leaky } }, { maxTransportRetries: 0 });

    assertFailed(result, EXIT.TRANSPORT, 'a leaky transport error');
    for (const text of [result.reason, describeConfirmation(result)]) {
      assert.doesNotMatch(text, /not-a-real-account-key/);
    }
    assert.match(result.reason, /\[redacted\]/);
    // The outcome is still named, so the operator learns something.
    assert.match(result.reason, /retries exhausted/);
  });

  it('refuses an unbounded, unusable or absent wait rather than starting one', async () => {
    const usage = async (overrides, context) => {
      const err = await asyncRefusal(
        () =>
          confirmArrival({
            reader: fakeReader(),
            runId: RUN,
            timeoutMs: BOUND,
            pollIntervalMs: INTERVAL,
            now: () => 0,
            sleep: async () => {},
            ...overrides,
          }),
        context
      );
      assert.equal(err.exitCode, EXIT.USAGE, context);
    };

    await usage({ reader: undefined }, 'no reader');
    await usage({ reader: {} }, 'a reader with no queryDocuments');
    for (const bad of ['', '   ', null, 7]) {
      await usage({ runId: bad }, `runId ${String(bad)}`);
      await usage({ partitionValue: bad }, `partitionValue ${String(bad)}`);
    }
    for (const bad of [0, -1, 1.5, Number.POSITIVE_INFINITY, Number.NaN, '5000', null]) {
      await usage({ timeoutMs: bad }, `timeoutMs ${String(bad)}`);
      await usage({ pollIntervalMs: bad }, `pollIntervalMs ${String(bad)}`);
      await usage({ expectedCount: bad }, `expectedCount ${String(bad)}`);
    }
    await usage({ maxTransportRetries: -1 }, 'a negative retry budget');
    // The partition key field is measured, not assumed: a raw path here would
    // build a query nothing can answer.
    await usage({ partitionKeyField: '/deviceId' }, 'a partition key path');
  });

  it('defaults to a bound that is explicit, finite and generous', () => {
    for (const value of [
      DEFAULT_CONFIRMATION_TIMEOUT_MS,
      DEFAULT_POLL_INTERVAL_MS,
      DEFAULT_TRANSPORT_RETRIES,
    ]) {
      assert.ok(Number.isInteger(value), `${value} is not an integer`);
      assert.ok(Number.isFinite(value));
    }
    assert.ok(DEFAULT_CONFIRMATION_TIMEOUT_MS > 0);
    assert.ok(DEFAULT_POLL_INTERVAL_MS > 0);
    assert.ok(DEFAULT_POLL_INTERVAL_MS < DEFAULT_CONFIRMATION_TIMEOUT_MS);
    assert.ok(DEFAULT_TRANSPORT_RETRIES >= 1);
  });

  // A bound smaller than the interval is a legal, if odd, operator choice. It
  // must still poll, still sweep before reporting an absence, and still not
  // overrun: the wait is clamped to the bound, not to the cadence.
  it('clamps the cadence to a bound smaller than the poll interval', async () => {
    const { result, reader, clock } = await confirm(
      { fallback: { docs: [] } },
      { timeoutMs: 1, pollIntervalMs: INTERVAL }
    );
    assertFailed(result, EXIT.TIMEOUT, 'a one-millisecond bound');
    assert.deepEqual(clock.sleeps, [1], 'slept for the interval rather than the bound');
    assert.equal(result.polls, 2);
    assert.equal(result.elapsedMs, 1);
    assert.equal(reader.calls.length, 3, 'the sweep still ran before reporting an absence');
    assert.equal(result.waitBoundMs, 1);
  });

  // ---- The evidence-emission contract, inside the read-back. --------------
  // An id that has been read back is a document that is IN THE CONTAINER. What
  // fails afterwards is news about the reader, not a retraction of the read, and
  // MG-53 halts on a source document no artifact accounts for.
  it('never discards an id it has already observed, whatever fails afterwards', async () => {
    const cases = [
      ['an auth failure on the next poll', { error: forbiddenError() }, EXIT.AUTH],
      ['a transport abort', { error: transportError() }, EXIT.TRANSPORT],
      [
        'a marker violation on the next page',
        {
          docs: [
            ...routed(2),
            ...routed(1, { unmarked: true, idPrefix: 'stray', firstSequence: 3 }),
          ],
        },
        EXIT.MARKER_VIOLATION,
      ],
      ['an unreadable page', { docs: 'not-a-list' }, EXIT.AMBIGUOUS],
      [
        'a duplicate that cannot be told from a second arrival',
        { docs: routed(2).concat(routed(2)) },
        EXIT.AMBIGUOUS,
      ],
    ];

    for (const [context, later, expected] of cases) {
      const { result } = await confirm(
        { script: [{ docs: routed(2) }, later] },
        { maxTransportRetries: 0 }
      );
      assertFailed(result, expected, context);
      assert.deepEqual(
        result.observedIds,
        ['cosmos-assigned-1', 'cosmos-assigned-2'],
        `${context}: dropped the ids an earlier poll had already read back`
      );
      assert.equal(result.observedCount, 2, context);
      assert.equal(result.uncertain, true, context);
    }
  });

  // The ids the sweep finds are observations too, and an operator whose route
  // put the documents somewhere unexpected still has to be told which documents.
  it('carries the ids the cross-partition sweep observed into the result', async () => {
    const empties = Array.from({ length: POLLS_TO_BOUND }, () => ({ docs: [] }));
    const { result } = await confirm({
      script: [...empties, { docs: routed(MESSAGES_PER_RUN, { partitionValue: 'elsewhere' }) }],
    });
    assertFailed(result, EXIT.UNEXPECTED_PARTITION, 'found only cross-partition');
    assert.deepEqual(result.observedIds, [
      'cosmos-assigned-1',
      'cosmos-assigned-2',
      'cosmos-assigned-3',
    ]);
    assert.equal(result.uncertain, true);
  });

  // A page that holds the expected count is not a confirmation if an earlier
  // page held ids this one does not: confirming would record an observed set
  // nobody ever read in one piece, and MG-53 checks the source against exactly
  // that set.
  it('refuses to confirm a set that changed under it, and reports every id it saw', async () => {
    const { result } = await confirm({
      script: [{ docs: routed(2) }, { docs: routed(MESSAGES_PER_RUN, { idPrefix: 'renamed' }) }],
    });

    assertFailed(result, EXIT.AMBIGUOUS, 'the complete page omits ids an earlier poll read back');
    assert.deepEqual(result.observedIds, [
      'cosmos-assigned-1',
      'cosmos-assigned-2',
      'renamed-1',
      'renamed-2',
      'renamed-3',
    ]);
    assert.equal(result.observedCount, 5);
    assert.match(result.reason, /never unseen/);
  });

  it('never sleeps past the bound', async () => {
    const { clock, result } = await confirm(
      { fallback: { docs: [] } },
      { timeoutMs: 12_000, pollIntervalMs: INTERVAL }
    );
    assert.equal(
      clock.sleeps.reduce((sum, ms) => sum + ms, 0),
      12_000
    );
    assert.deepEqual(clock.sleeps, [5_000, 5_000, 2_000]);
    assert.equal(result.elapsedMs, 12_000);
  });
});

// The pure ambiguity rules, readable without a clock. confirmArrival's outcomes
// above are the contract; these pin the judgements it is built from.
// A run that aborted mid-send never reaches the read-back, but it HAS changed
// the live container — and the evidence record is built from a confirmation
// result. This is the shape that makes such a run recordable without letting it
// look for one moment like a confirmation.
describe('the aborted-run result', () => {
  const aborted = (overrides = {}) =>
    abortedConfirmation({
      runId: 'mg-67-run-aborted',
      exitCode: EXIT.SEND_FAILURE,
      reason: 'the send aborted after 1 of 3 message(s)',
      ...overrides,
    });

  it('is never confirmed and observes nothing, whatever it is asked for', () => {
    const result = aborted();
    assert.equal(result.confirmed, false);
    assert.equal(result.exitCode, EXIT.SEND_FAILURE);
    assert.deepEqual(result.observedIds, []);
    assert.equal(result.observedCount, 0);
    assert.equal(result.observedArrivalMs, null);
    assert.equal(result.polls, 0);
    assert.equal(result.crossPartitionSweepRun, false);
  });

  // 'not-attempted' is the machine-readable difference between "read back and
  // found nothing" and "never read back at all". MG-53 reading this record has
  // to be able to tell those apart: the first is a fact about the route, the
  // second is a fact about the run.
  it('says explicitly that no read-back was attempted, rather than reporting an absence', () => {
    assert.equal(aborted().scope, 'not-attempted');
    assert.notEqual(aborted().exitCode, EXIT.TIMEOUT);
  });

  it('reports the wait bound it was configured with, like every other result', () => {
    const result = aborted({ timeoutMs: 4321, pollIntervalMs: 21 });
    assert.equal(result.waitBoundMs, 4321);
    assert.equal(result.pollIntervalMs, 21);
    assert.equal(result.exitLabel, exitLabel(EXIT.SEND_FAILURE));
  });

  it('refuses to describe a successful run: it exists only for failures', () => {
    for (const exitCode of [EXIT.OK, -1, 1.5, undefined]) {
      const err = refusal(() => aborted({ exitCode }), `accepted exit code ${exitCode}`);
      assert.equal(err.exitCode, EXIT.USAGE);
    }
    refusal(() => abortedConfirmation({ exitCode: EXIT.SEND_FAILURE, reason: 'x' }));
    refusal(() => aborted({ reason: '' }));
  });

  it('is frozen, so a caller cannot edit an unconfirmed result into a confirmed one', () => {
    const result = aborted();
    assert.throws(() => {
      result.confirmed = true;
    });
  });
});

// The contract itself, rather than the symptoms it was extracted from. Every
// defect it answers had the same sentence — a later error discarded ids the tool
// already knew — so what is asserted here is the RULE: four id sets that are
// never conflated, an observation that is never retracted, and an unknown that is
// never recorded as an absence.
describe('the run ledger (the evidence-emission contract)', () => {
  const RUN = 'mg-67-run-ledger';
  const ledger = () => createRunLedger({ runId: RUN });
  const ids = ['msg-1', 'msg-2', 'msg-3'];
  const confirmedResult = observedIds => ({ confirmed: true, observedIds });

  it('names the four id sets and keeps them separate', () => {
    assert.deepEqual(ID_SET_NAMES, ['requestedIds', 'acceptedIds', 'ambiguousIds', 'observedIds']);
    assert.equal(new Set(ID_SET_NAMES).size, ID_SET_NAMES.length);
  });

  it('records a full success as attempted, accepted, unambiguous and observed', () => {
    const run = ledger();
    for (const id of ids) run.accept(run.request(id));
    const snapshot = run.snapshot({
      confirmation: confirmedResult(['cosmos-1', 'cosmos-2', 'cosmos-3']),
    });

    assert.deepEqual([...snapshot.requestedIds], ids);
    assert.deepEqual([...snapshot.acceptedIds], ids);
    assert.deepEqual([...snapshot.ambiguousIds], []);
    assert.deepEqual([...snapshot.observedIds], ['cosmos-1', 'cosmos-2', 'cosmos-3']);
    assert.equal(snapshot.attempted, true);
    // The ONE combination that is certain: nothing unknown was sent, and a
    // confirmation completed.
    assert.equal(snapshot.uncertain, false);
    assert.equal(mustEmitEvidence(snapshot), true);
  });

  // The crux of the contract. `az` can fail AFTER IoT Hub accepted the message,
  // so a send failure is ambiguous BY CONSTRUCTION — including on message 1 of 3,
  // where the old shape told the operator nothing had been written and wrote no
  // artifact at all.
  it('records a failure on the FIRST message as unknown acceptance, never as nothing sent', () => {
    const run = ledger();
    run.markAmbiguous(run.request(ids[0]));
    const snapshot = run.snapshot();

    assert.deepEqual([...snapshot.requestedIds], [ids[0]]);
    assert.deepEqual([...snapshot.acceptedIds], []);
    assert.deepEqual([...snapshot.ambiguousIds], [ids[0]]);
    assert.deepEqual([...snapshot.observedIds], []);
    // Something was attempted, so a record MUST be emitted — an unrecorded
    // document halts MG-53 in the one way its operator cannot diagnose.
    assert.equal(snapshot.attempted, true);
    assert.equal(mustEmitEvidence(snapshot), true);
    assert.equal(snapshot.uncertain, true);
    // And the operator-facing line never claims an absence.
    const line = describeIdSets(snapshot);
    assert.match(line, /1 of UNKNOWN acceptance/);
    assert.doesNotMatch(line, /nothing was written|nothing arrived|no document was sent/i);
  });

  it('records a mid-run abort as accepted-so-far plus one unknown, and nothing else', () => {
    const run = ledger();
    run.accept(run.request(ids[0]));
    run.markAmbiguous(run.request(ids[1]));
    // ids[2] is never requested: an attempt that never began is not a message
    // that failed, and recording it would put an id in the artifact for a
    // document that cannot exist.
    const snapshot = run.snapshot();

    assert.deepEqual([...snapshot.requestedIds], [ids[0], ids[1]]);
    assert.deepEqual([...snapshot.acceptedIds], [ids[0]]);
    assert.deepEqual([...snapshot.ambiguousIds], [ids[1]]);
    assert.equal(snapshot.uncertain, true);
  });

  it('folds an unresolved request into the ambiguous set, fail-closed', () => {
    const run = ledger();
    run.accept(run.request(ids[0]));
    run.request(ids[1]); // The process died here; no outcome was ever recorded.
    const snapshot = run.snapshot();

    assert.deepEqual([...snapshot.ambiguousIds], [ids[1]]);
    assert.equal(snapshot.uncertain, true);
  });

  it('is uncertain whenever anything is ambiguous, even behind a confirmation', () => {
    const run = ledger();
    run.accept(run.request(ids[0]));
    run.markAmbiguous(run.request(ids[1]));
    // Both documents were read back — and one of them was sent by a message
    // whose acceptance az never established. The run is still uncertain.
    const snapshot = run.snapshot({ confirmation: confirmedResult(['cosmos-1', 'cosmos-2']) });
    assert.equal(snapshot.uncertain, true);
  });

  it('is uncertain when no confirmation completed, however clean the send was', () => {
    const run = ledger();
    for (const id of ids) run.accept(run.request(id));
    for (const confirmation of [
      null,
      { confirmed: false, observedIds: [] },
      abortedConfirmation({ runId: RUN, exitCode: EXIT.SEND_FAILURE, reason: 'aborted' }),
    ]) {
      assert.equal(run.snapshot({ confirmation }).uncertain, true);
    }
  });

  // The property every one of the patched paths violated in its own way.
  it('observes monotonically: an id seen once is in every later snapshot', () => {
    const run = ledger();
    run.observe(['cosmos-1', 'cosmos-2']);
    // A later poll that sees less, an abort that sees nothing, a duplicate.
    run.observe(['cosmos-1']);
    run.observe([]);
    const snapshot = run.snapshot({
      confirmation: { confirmed: false, observedIds: ['cosmos-3'] },
    });

    assert.deepEqual([...snapshot.observedIds], ['cosmos-1', 'cosmos-2', 'cosmos-3']);
    assert.equal(run.snapshot().observedIds.length, 2, 'a snapshot mutated the ledger');
  });

  it('unions in order and refuses an id it could not record', () => {
    assert.deepEqual(mergeIds(['a', 'b'], ['b', 'c']), ['a', 'b', 'c']);
    assert.deepEqual(mergeIds(), []);
    for (const bad of [[''], ['   '], [null], [7], [{}]]) {
      assert.equal(refusal(() => mergeIds([], bad)).exitCode, EXIT.USAGE);
    }
    assert.equal(refusal(() => mergeIds('a', [])).exitCode, EXIT.USAGE);
  });

  it('refuses to invent, duplicate or revise an outcome', () => {
    const run = ledger();
    run.request(ids[0]);

    // An outcome for a message nobody attempted.
    assert.equal(refusal(() => run.accept('never-requested')).exitCode, EXIT.USAGE);
    assert.equal(refusal(() => run.markAmbiguous('never-requested')).exitCode, EXIT.USAGE);
    // A duplicate id would make the run's own record ambiguous.
    assert.equal(refusal(() => run.request(ids[0])).exitCode, EXIT.USAGE);
    for (const bad of ['', '   ', null, 7]) {
      assert.equal(refusal(() => run.request(bad)).exitCode, EXIT.USAGE);
    }
    // Unknown acceptance never becomes known again.
    run.markAmbiguous(ids[0]);
    assert.equal(refusal(() => run.accept(ids[0])).exitCode, EXIT.USAGE);
    assert.equal(refusal(() => run.markAmbiguous(ids[0])).exitCode, EXIT.USAGE);
    assert.equal(refusal(() => createRunLedger()).exitCode, EXIT.USAGE);
  });

  it('emits no evidence only for a run that attempted nothing', () => {
    const run = ledger();
    assert.equal(mustEmitEvidence(run.snapshot()), false);
    run.request(ids[0]);
    assert.equal(mustEmitEvidence(run.snapshot()), true);
    assert.equal(mustEmitEvidence(undefined), false);
  });

  it('is frozen, so a caller cannot edit an unknown into a known', () => {
    const run = ledger();
    run.markAmbiguous(run.request(ids[0]));
    const snapshot = run.snapshot();
    assert.throws(() => {
      snapshot.uncertain = false;
    });
    assert.throws(() => {
      snapshot.ambiguousIds.push('msg-9');
    });
  });

  // HR1 applies to all FOUR id sets now, not just the one: the artifact these
  // feed is the thing MG-53 and MG-54 parse, and it may not carry a credential.
  it('has no field that could hold a credential', () => {
    const run = ledger();
    run.accept(run.request(ids[0]));
    run.markAmbiguous(run.request(ids[1]));
    run.observe(['cosmos-1']);
    const snapshot = run.snapshot();
    const serialized = JSON.stringify(snapshot);

    for (const key of Object.keys(snapshot)) {
      assert.doesNotMatch(key, /key|token|secret|password|credential|sig|connection/i, key);
    }
    for (const shape of [
      /AccountKey/i,
      /SharedAccessKey/i,
      /Bearer\s/i,
      /HostName=/i,
      /\bsig=/i,
      /eyJ[\w-]+\./,
    ]) {
      assert.doesNotMatch(serialized, shape, `${shape} appeared in the snapshot`);
    }
    // Nothing in it but the run id and ids the caller put there.
    assert.deepEqual(JSON.parse(serialized), {
      runId: RUN,
      requestedIds: [ids[0], ids[1]],
      acceptedIds: [ids[0]],
      ambiguousIds: [ids[1]],
      observedIds: ['cosmos-1'],
      attempted: true,
      idDivergence: true,
      uncertain: true,
    });
  });

  // The other half of the same discipline: a claim in the artifact must have
  // been witnessed. Divergence says the platform RENAMED a document — an
  // assertion about live behaviour nobody in this repo has ever observed — so it
  // is set only when an observed document carries an id this run did not choose.
  it('flags id divergence only when an OBSERVED id was not one the run requested', () => {
    // Witnessed: the document that came back is not one of ours by id.
    assert.equal(observedIdsDiverge({ observedIds: ['cosmos-1'], requestedIds: ['msg-1'] }), true);
    // The platform honoured the ids: no divergence.
    assert.equal(observedIdsDiverge({ observedIds: ['msg-1'], requestedIds: ['msg-1'] }), false);
    // A SHORTFALL is not divergence. Two of three read back is an incomplete
    // read-back; inferring a renaming from it would put a fabricated claim in
    // the one artifact MG-53 and MG-54 parse.
    assert.equal(observedIdsDiverge({ observedIds: ['msg-1', 'msg-2'], requestedIds: ids }), false);
    // Nothing observed witnesses nothing.
    assert.equal(observedIdsDiverge({ observedIds: [], requestedIds: ids }), false);
    assert.equal(observedIdsDiverge(), false);

    // And the same rule through the ledger: a partial read-back of ids the run
    // did choose is not divergence, however incomplete it is.
    const run = ledger();
    for (const id of ids) run.accept(run.request(id));
    run.observe([ids[0]]);
    assert.equal(run.snapshot().idDivergence, false);
    run.observe(['cosmos-9']);
    assert.equal(run.snapshot().idDivergence, true);
  });
});

describe('evaluateReadBack', () => {
  const RUN = 'mg-67-run-evaluate';
  const doc = (extra = {}) => ({
    id: 'cosmos-assigned-1',
    deviceId: FIXTURE_DEVICE_ID,
    [SYNTHETIC_MARKER_FIELD]: SYNTHETIC_MARKER,
    [RUN_ID_FIELD]: RUN,
    [SEQUENCE_FIELD]: 1,
    ...extra,
  });

  it('separates empty, partial and complete, and only complete can be a success', () => {
    assert.equal(evaluateReadBack([], { runId: RUN }).kind, 'empty');
    const partial = evaluateReadBack([doc()], { runId: RUN, expectedCount: 3 });
    assert.equal(partial.kind, 'partial');
    // Not yet a verdict: routing is asynchronous and documents trickle in.
    assert.equal(partial.exitCode, undefined);
    const complete = evaluateReadBack([doc()], { runId: RUN, expectedCount: 1 });
    assert.equal(complete.kind, 'complete');
    assert.deepEqual(complete.ids, ['cosmos-assigned-1']);
  });

  it('ignores the properties Cosmos adds', () => {
    const stored = doc({ _ts: 1, _rid: 'r', _etag: '"0"', _self: 'dbs/x' });
    assert.equal(evaluateReadBack([stored], { runId: RUN, expectedCount: 1 }).kind, 'complete');
  });

  it('refuses a caller with no run id rather than judging an uncorrelated page', () => {
    const err = refusal(() => evaluateReadBack([doc()], { runId: '' }));
    assert.equal(err.exitCode, EXIT.USAGE);
    assert.equal(refusal(() => evaluateReadBack([doc()])).exitCode, EXIT.USAGE);
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

  // HR2 repeatability, proved structurally rather than by running twice: a build
  // cannot depend on state a previous run wrote if the module can read no state
  // at all. The run id comes from crypto.randomUUID and nothing else.
  it('reads no file and no environment variable, so no run can depend on another', async () => {
    const source = await readSource('./fixture-core.mjs');
    for (const pattern of [
      /node:fs/,
      /\breadFileSync?\b/,
      /\bwriteFileSync?\b/,
      /process\.env/,
      /localStorage/,
    ]) {
      assert.equal(pattern.test(source), false, `fixture-core.mjs matches ${pattern}`);
    }
  });

  // Two decisions that are only defensible while their reasoning is attached to
  // them, and that a later edit would otherwise quietly drop.
  it('records the accepted schema deviation and the data-pusher finding', async () => {
    const source = await readSource('./fixture-core.mjs');
    // The marker deviates from TemperatureReading's additionalProperties: false
    // on purpose; the schema is not edited and MG-59 inherits the question.
    assert.match(source, /additionalProperties: false/);
    assert.match(source, /MG-59/);
    // The repo's real producer sets neither content type nor encoding: recorded
    // here as a finding, deliberately not fixed by a verification ticket.
    assert.match(source, /data-pusher/);
    assert.match(source, /buildPublishProperties/);
  });
});
