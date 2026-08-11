// Unit tests for the operator CLI (MG-67, step 6).
//
// This is the only file in the tool that touches a credential boundary or a
// child process, so the properties under test are not "it sends" and "it
// reports". They are:
//
//   1. NOTHING CREDENTIAL-SHAPED EVER EXISTS. Not in the argv handed to az
//      (which az writes to ~/.azure and `ps` exposes, where no scrub can reach
//      it), not in any line this tool emits, on any path including every
//      failure path, and including text the az CHILD wrote.
//   2. AN EXIT 0 MEANS ONE THING. The expected count of marker-carrying,
//      run-correlated documents was read back out of the destination container
//      AND the evidence recording them was written. Every other outcome exits
//      with its own distinct nonzero code, asserted BY CODE and not by prose.
//   3. NOTHING IS SENT THAT CANNOT BE CONFIRMED. A refused or unreadable
//      pre-send read aborts before a single document is written.
//
// Dependency-free by contract: node: built-ins and local files only, so this
// file runs in the credentialless validate-infrastructure job with no npm
// install and no network. The spawn, the reader, the clock, the uuid source and
// the filesystem are all injected — no az binary, no Azure package, no network,
// and no test sleeps.
//
// The real `import('@azure/cosmos')` / `import('@azure/identity')` thunks are
// the one thing this tier cannot exercise; they live in send-fixture.sdk.test.mjs.

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseContainerDefinition } from './container-definition.mjs';
import {
  fakeAzSpawn,
  fakeClock,
  fakeCosmosClient,
  fakeCosmosModule,
  fakeIdentityModule,
  fakeReader,
  forbiddenError,
  authError,
  credentialUnavailableError,
  transportError,
} from './fake-azure.mjs';
import {
  CONFIRMATION_QUERY,
  EXIT,
  FIXTURE_DEVICE_ID,
  FixtureError,
  MESSAGES_PER_RUN,
  RUN_ID_FIELD,
  RUN_ID_PARAMETER,
  SYNTHETIC_MARKER,
  SYNTHETIC_MARKER_FIELD,
  buildFixtureMessages,
  newRunId,
} from './fixture-core.mjs';
import {
  AZ_COMMAND,
  assertArgvIsCredentialFree,
  buildSendArgv,
  cosmosReader,
  createRealReader,
  endpointFor,
  main,
  parseArgs,
  preflight,
  requireComplete,
  sendMessages,
} from './send-fixture.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const readSource = relative => readFile(path.join(HERE, relative), 'utf8');
const readFixture = name => readFile(path.join(HERE, 'fixtures', name), 'utf8');

const HUB = 'meatgeek-v2-dev-iothub-259d4bf5b628';
const ACCOUNT = 'mgv2-dev-f640e19ae7ab';
const DATABASE = 'meatgeek-v2-dev-db';
const CONTAINER = 'temperatures';
const UUID = '00000000-0000-4000-8000-000000000001';
const RUN_ID = newRunId(() => UUID);
const RUN_MILLIS = Date.parse('2026-08-11T09:00:00.000Z');

// ---------------------------------------------------------------------------
// Secrets that must never come back out.
//
// These are the shapes an operator's terminal could realistically receive one
// in: a device key, a bearer token, a SAS signature. They are planted in the az
// child's stderr and in arguments someone thought this tool would accept, and
// every assertion below is on the EXACT substring.
//
// They are BUILT AT RUNTIME from self-describing plaintext rather than written
// down, following cosmos-export.sdk.test.mjs. HR1 says no credential is
// committed to the repository ANYWHERE, tests included, and a diff-wide grep
// for credential shapes is part of this ticket's acceptance — a hard-coded
// base64 blob would trip it and a reviewer would have to take "it is only a
// test value" on trust. Constructed, the file commits no such shape at all
// while the test still exercises the real one (proved by the source-posture
// suite at the bottom, which greps THIS file too).
// ---------------------------------------------------------------------------
const b64url = text =>
  Buffer.from(text).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_');

const PLANTED = Object.freeze({
  // 44+ unbroken base64 characters, the shape of an IoT device key.
  deviceKey: Buffer.from('mg67-test-only-never-a-real-device-key').toString('base64'),
  // Three dotted base64url segments, the shape of a JWT.
  jwt: [
    b64url('{"alg":"HS256","typ":"JWT"}'),
    b64url('{"sub":"mg67-test-only-not-a-real-subject"}'),
    b64url('mg67-test-only-never-a-real-signature'),
  ].join('.'),
  sasSignature: b64url('mg67-test-only-never-a-real-sas-signature'),
});

const LEAKY_AZ_STDERR = [
  'ERROR: The command failed with an unexpected error.',
  `Connection string: HostName=${HUB}.azure-devices.net;DeviceId=${FIXTURE_DEVICE_ID};SharedAccessKey=${PLANTED.deviceKey}`,
  `Authorization header: Bearer ${PLANTED.jwt}`,
  `sas_token=SharedAccessSignature sr=${HUB}&sig=${PLANTED.sasSignature}%3D&se=1800000000`,
  'Traceback (most recent call last):',
  '  File "/opt/az/lib/knack/cli.py", line 233, in invoke',
].join('\n');

function assertNoPlantedSecret(text, context) {
  for (const [name, secret] of Object.entries(PLANTED)) {
    assert.equal(
      text.includes(secret),
      false,
      `${context}: the planted ${name} appeared in operator-facing output`
    );
  }
}

// ---------------------------------------------------------------------------
// Harness.
// ---------------------------------------------------------------------------

/**
 * Run `fn`, require that it threw a FixtureError, and hand the error back.
 * assert.throws() returns undefined, and the assertions that matter here are
 * about the error's exit CODE and about what its message does not contain.
 */
function refusal(fn) {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof FixtureError, `expected a FixtureError, got ${err?.name}`);
    return err;
  }
  return assert.fail('expected a refusal, but the call returned');
}

function recordingLog() {
  const info = [];
  const error = [];
  return {
    info: line => info.push(String(line)),
    error: line => error.push(String(line)),
    infoLines: info,
    errorLines: error,
    all: () => [...info, ...error].join('\n'),
  };
}

/** The documents a healthy route delivers for `runId`, built through the real contract. */
function deliveredDocuments(runId = RUN_ID, overrides = {}) {
  return buildFixtureMessages({
    runId,
    partitionKeyField: 'deviceId',
    deviceId: FIXTURE_DEVICE_ID,
    now: () => RUN_MILLIS,
  }).map(message => ({ ...message.body, _ts: 1_754_000_000, ...overrides }));
}

const BASE_ARGV = Object.freeze([
  '--hub',
  HUB,
  '--account',
  ACCOUNT,
  '--database',
  DATABASE,
  '--container',
  CONTAINER,
  '--container-definition',
  'definition.json',
]);

async function withTempDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mg67-send-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Run main() with every seam faked. Returns the exit code, the captured log, the
 * fake spawn (for argv assertions) and the reader's recorded calls.
 */
async function runMain({
  argv = [],
  definition = 'container-show-clean.json',
  readerSpec = {},
  spawnSpec = {},
  createReader,
  timeoutMs = 1000,
  pollIntervalMs = 250,
  evidenceOut,
  fs,
} = {}) {
  const log = recordingLog();
  const clock = fakeClock({ start: RUN_MILLIS });
  const reader = fakeReader(readerSpec);
  const spawn = fakeAzSpawn(spawnSpec);
  const definitionText =
    typeof definition === 'string' ? await readFixture(definition) : definition;
  const readerCalls = [];

  const exitCode = await main({
    argv: [
      ...BASE_ARGV,
      '--timeout',
      String(timeoutMs),
      '--poll-interval',
      String(pollIntervalMs),
      ...(evidenceOut ? ['--evidence-out', evidenceOut] : []),
      ...argv,
    ],
    createReader:
      createReader ??
      (async target => {
        readerCalls.push(target);
        return reader;
      }),
    spawn,
    log,
    readFileFn: async () => definitionText,
    now: clock.now,
    sleep: clock.sleep,
    uuid: () => UUID,
    ...(fs ? { fs } : {}),
  });

  return { exitCode, log, spawn, reader, readerCalls, clock };
}

// ===========================================================================

describe('argument parsing', () => {
  it('defaults the device to the durable fixture and the wait to a bounded value', () => {
    const cfg = parseArgs([...BASE_ARGV, '--evidence-out', 'e.json']);
    assert.equal(cfg.device, FIXTURE_DEVICE_ID);
    assert.equal(cfg.hub, HUB);
    assert.ok(Number.isInteger(cfg.timeoutMs) && cfg.timeoutMs > 0);
    assert.ok(Number.isInteger(cfg.pollIntervalMs) && cfg.pollIntervalMs > 0);
    assert.equal(cfg.overwrite, false);
  });

  it('accepts --flag=value as well as --flag value, and - for stdin', () => {
    const cfg = parseArgs([
      `--hub=${HUB}`,
      `--account=${ACCOUNT}`,
      `--database=${DATABASE}`,
      `--container=${CONTAINER}`,
      '--container-definition',
      '-',
      '--evidence-out=e.json',
      '--overwrite',
    ]);
    assert.equal(cfg.containerDefinition, '-');
    assert.equal(cfg.overwrite, true);
  });

  // HR1: there is no credential mode at all, so every spelling of one is refused
  // BY NAME rather than falling through to "unknown argument" — an operator
  // reaching for one holds a mental model this tool has to correct.
  for (const flag of [
    '--key',
    '--device-key',
    '--primary-key',
    '--account-key',
    '--master-key',
    '--symmetric-key',
    '--connection-string',
    '--login',
    '--sas',
    '--sas-token',
    '--token',
    '--password',
    '--secret',
    '--certificate',
    '--cert',
    '--auth',
  ]) {
    it(`refuses ${flag} without reading or echoing its value`, () => {
      const error = refusal(() => parseArgs([...BASE_ARGV, flag, PLANTED.deviceKey]));
      assert.equal(error.exitCode, EXIT.USAGE);
      assert.match(error.message, /no key, connection-string, SAS or certificate mode/);
      assertNoPlantedSecret(error.message, `parseArgs(${flag})`);
    });

    it(`refuses ${flag}=<value> too, so the inline spelling is not a bypass`, () => {
      const error = refusal(() => parseArgs([...BASE_ARGV, `${flag}=${PLANTED.deviceKey}`]));
      assert.equal(error.exitCode, EXIT.USAGE);
      assertNoPlantedSecret(error.message, `parseArgs(${flag}=)`);
    });
  }

  // Not a secret in themselves — they make az PRINT one, onto a terminal and
  // into ~/.azure where nothing this repo owns can redact it.
  for (const flag of ['--debug', '--verbose']) {
    it(`refuses ${flag}, because under verbosity az prints request signatures`, () => {
      const error = refusal(() => parseArgs([...BASE_ARGV, flag]));
      assert.equal(error.exitCode, EXIT.USAGE);
      assert.match(error.message, /verbosity/);
    });
  }

  it('rejects an unknown argument rather than ignoring it', () => {
    const error = refusal(() => parseArgs(['--nope']));
    assert.equal(error.exitCode, EXIT.USAGE);
  });

  it('rejects a non-positive or non-integer wait bound: an unreportable wait is not a wait', () => {
    for (const value of ['0', '-1', 'soon', '1.5']) {
      const error = refusal(() => parseArgs(['--timeout', value]));
      assert.equal(error.exitCode, EXIT.USAGE);
    }
  });

  it('requires the container definition and the evidence path', () => {
    const withoutDefinition = parseArgs([
      '--hub',
      HUB,
      '--account',
      ACCOUNT,
      '--database',
      DATABASE,
      '--container',
      CONTAINER,
      '--evidence-out',
      'e.json',
    ]);
    assert.throws(() => requireComplete(withoutDefinition), /container-definition/);

    const withoutEvidence = parseArgs([...BASE_ARGV]);
    assert.throws(() => requireComplete(withoutEvidence), /evidence-out/);
  });

  // A name is what goes onto an az command line. Anything that is not a plain
  // Azure resource name is either a typo or an attempt to smuggle a second
  // argument into the child's argv.
  it('refuses a target name that is not a plain Azure resource name', () => {
    for (const bad of ['a hub', '--hub-name', 'hub;rm -rf /', '$(id)', '']) {
      const cfg = { ...parseArgs([...BASE_ARGV, '--evidence-out', 'e.json']), hub: bad };
      const error = refusal(() => requireComplete(cfg));
      assert.equal(error.exitCode, EXIT.USAGE);
    }
  });

  it('derives the Cosmos endpoint from the account name alone', () => {
    assert.equal(endpointFor(ACCOUNT), `https://${ACCOUNT}.documents.azure.com:443/`);
  });
});

describe('the az invocation shape (HR1)', () => {
  const message = buildFixtureMessages({
    runId: RUN_ID,
    partitionKeyField: 'deviceId',
    now: () => RUN_MILLIS,
  })[0];
  const argv = buildSendArgv({ hub: HUB, device: FIXTURE_DEVICE_ID, message });

  it('addresses the hub and the device BY NAME, and nothing else', () => {
    assert.deepEqual(argv.slice(0, 3), ['iot', 'device', 'send-d2c-message']);
    assert.equal(argv[argv.indexOf('--hub-name') + 1], HUB);
    assert.equal(argv[argv.indexOf('--device-id') + 1], FIXTURE_DEVICE_ID);
  });

  it('carries no credential-shaped token and no credential flag of any spelling', () => {
    const joined = argv.join(' ');
    for (const forbidden of [
      '--key',
      '--device-key',
      '--login',
      '--connection-string',
      '--sas',
      '--sas-token',
      '--certificate',
      'SharedAccessKey',
      'AccountKey',
      'HostName=',
      'SharedAccessSignature',
      'Bearer ',
    ]) {
      assert.equal(joined.includes(forbidden), false, `argv carries ${forbidden}`);
    }
    assertNoPlantedSecret(joined, 'buildSendArgv');
  });

  it('never asks az for verbosity', () => {
    assert.equal(argv.includes('--debug'), false);
    assert.equal(argv.includes('--verbose'), false);
    // ...and keeps the child quiet, so there is less for the scrubber to catch.
    assert.equal(argv.includes('--only-show-errors'), true);
    assert.equal(argv[argv.indexOf('--output') + 1], 'none');
  });

  it('declares JSON content type and utf-8 encoding, without which the hub writes an opaque payload', () => {
    const properties = argv[argv.indexOf('--properties') + 1];
    assert.match(properties, /\$\.ct=application\/json/);
    assert.match(properties, /\$\.ce=utf-8/);
  });

  it('sends a body carrying the marker, the run id and the measured partition field', () => {
    const body = JSON.parse(argv[argv.indexOf('--data') + 1]);
    assert.equal(body[SYNTHETIC_MARKER_FIELD], SYNTHETIC_MARKER);
    assert.equal(body[RUN_ID_FIELD], RUN_ID);
    assert.equal(body.deviceId, FIXTURE_DEVICE_ID);
  });

  // The argv is the one thing this tool hands to a program that writes it to
  // disk and exposes it through `ps`. So it is re-checked immediately before the
  // spawn rather than trusted, and the check is the tool's OWN scrubber, so the
  // two cannot drift apart.
  it('refuses to spawn an argv carrying a credential shape, without echoing it', () => {
    for (const poisoned of [
      `--data=SharedAccessKey=${PLANTED.deviceKey}`,
      `Bearer ${PLANTED.jwt}`,
      `HostName=${HUB}.azure-devices.net;SharedAccessKey=${PLANTED.deviceKey}`,
      PLANTED.jwt,
    ]) {
      const error = refusal(() => assertArgvIsCredentialFree([...argv, poisoned]));
      assert.equal(error.exitCode, EXIT.USAGE);
      assertNoPlantedSecret(error.message, 'assertArgvIsCredentialFree');
    }
  });

  it('refuses to spawn an argv carrying a verbosity or credential flag', () => {
    for (const flag of ['--debug', '--verbose', '--login', '--key']) {
      const error = refusal(() => assertArgvIsCredentialFree([...argv, flag]));
      assert.equal(error.exitCode, EXIT.USAGE);
    }
  });

  it('passes a clean argv through unchanged', () => {
    assert.deepEqual(assertArgvIsCredentialFree(argv), argv);
  });
});

describe('sendMessages', () => {
  const messages = buildFixtureMessages({
    runId: RUN_ID,
    partitionKeyField: 'deviceId',
    now: () => RUN_MILLIS,
  });

  it('spawns az once per message, always as an argv array', async () => {
    const spawn = fakeAzSpawn({});
    const log = recordingLog();
    const ids = await sendMessages({
      messages,
      hub: HUB,
      device: FIXTURE_DEVICE_ID,
      spawn,
      log,
    });
    assert.equal(spawn.calls.length, MESSAGES_PER_RUN);
    assert.equal(ids.length, MESSAGES_PER_RUN);
    for (const call of spawn.calls) {
      assert.equal(call.command, AZ_COMMAND);
      assert.ok(Array.isArray(call.argv));
    }
  });

  it('aborts the whole run on the first nonzero az exit rather than sending on', async () => {
    const spawn = fakeAzSpawn({ script: [{ code: 0 }, { code: 1, stderr: 'ERROR: nope' }] });
    const log = recordingLog();
    const error = await assert.rejects(
      () => sendMessages({ messages, hub: HUB, device: FIXTURE_DEVICE_ID, spawn, log }),
      FixtureError
    );
    assert.equal(spawn.calls.length, 2, 'the third message must not be sent after a failure');
    return error;
  });

  it('names the device, the hub and the outcome when az fails', async () => {
    const spawn = fakeAzSpawn({ script: [{ code: 3, stderr: LEAKY_AZ_STDERR }] });
    const log = recordingLog();
    await assert.rejects(
      () => sendMessages({ messages, hub: HUB, device: FIXTURE_DEVICE_ID, spawn, log }),
      err => {
        assert.equal(err.exitCode, EXIT.SEND_FAILURE);
        assert.ok(err.message.includes(FIXTURE_DEVICE_ID));
        assert.ok(err.message.includes(HUB));
        assertNoPlantedSecret(err.message, 'sendMessages az-failure message');
        return true;
      }
    );
  });

  it('reports a spawn failure as a send failure, not as an absence', async () => {
    const spawn = async () => {
      throw Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' });
    };
    await assert.rejects(
      () =>
        sendMessages({ messages, hub: HUB, device: FIXTURE_DEVICE_ID, spawn, log: recordingLog() }),
      err => {
        assert.equal(err.exitCode, EXIT.SEND_FAILURE);
        assert.match(err.message, /azure-iot/);
        return true;
      }
    );
  });
});

describe('the Cosmos reader adapter', () => {
  const spec = { [DATABASE]: { [CONTAINER]: { script: [{ docs: deliveredDocuments() }] } } };

  it('binds the run id as a parameter and never interpolates it into the query', async () => {
    const client = fakeCosmosClient(spec);
    const reader = cosmosReader(client, { database: DATABASE, container: CONTAINER });
    await reader.queryDocuments({
      query: CONFIRMATION_QUERY,
      parameters: [{ name: RUN_ID_PARAMETER, value: RUN_ID }],
      partitionKey: FIXTURE_DEVICE_ID,
    });
    const [call] = client.calls;
    assert.equal(call.query, CONFIRMATION_QUERY);
    assert.equal(call.query.includes(RUN_ID), false);
    assert.deepEqual(call.parameters, [{ name: RUN_ID_PARAMETER, value: RUN_ID }]);
    assert.equal(call.partitionKey, FIXTURE_DEVICE_ID);
  });

  it('an absent partitionKey IS the cross-partition sweep, not a scoped query with a blank key', async () => {
    const client = fakeCosmosClient(spec);
    const reader = cosmosReader(client, { database: DATABASE, container: CONTAINER });
    await reader.queryDocuments({ query: CONFIRMATION_QUERY, parameters: [] });
    assert.equal('partitionKey' in client.calls[0], true);
    assert.equal(client.calls[0].partitionKey, undefined);
  });

  it('passes a missing resources list through verbatim rather than laundering it into an absence', async () => {
    const client = {
      database: () => ({
        container: () => ({ items: { query: () => ({ fetchAll: async () => ({}) }) } }),
      }),
    };
    const reader = cosmosReader(client, { database: DATABASE, container: CONTAINER });
    assert.equal(await reader.queryDocuments({ query: 'x', parameters: [] }), undefined);
  });

  it('constructs the real client with an AAD credential and with no key of any kind', async () => {
    const constructed = [];
    const reader = await createRealReader({
      endpoint: endpointFor(ACCOUNT),
      database: DATABASE,
      container: CONTAINER,
      loadCosmos: async () => fakeCosmosModule(constructed),
      loadIdentity: async () => fakeIdentityModule({}),
    });
    assert.equal(typeof reader.queryDocuments, 'function');
    assert.equal(constructed.length, 1);
    const [options] = constructed;
    assert.equal(options.endpoint, endpointFor(ACCOUNT));
    assert.equal(options.aadCredentials?.credentialKind, 'DefaultAzureCredential');
    for (const forbidden of [
      'key',
      'masterKey',
      'connectionString',
      'resourceTokens',
      'tokenProvider',
    ]) {
      assert.equal(forbidden in options, false, `the client was constructed with ${forbidden}`);
    }
  });

  it('reports a credential that cannot be acquired as AUTH, never as a crash or an absence', async () => {
    await assert.rejects(
      () =>
        createRealReader({
          endpoint: endpointFor(ACCOUNT),
          database: DATABASE,
          container: CONTAINER,
          loadCosmos: async () => fakeCosmosModule([]),
          loadIdentity: async () =>
            fakeIdentityModule({ throwOnConstruct: credentialUnavailableError() }),
        }),
      err => {
        assert.equal(err.exitCode, EXIT.AUTH);
        assert.match(err.message, /az login/);
        return true;
      }
    );
  });
});

describe('the pre-send read (HR5: newly identified)', () => {
  it('accepts an empty container for this run and reports nothing else', async () => {
    const reader = fakeReader({ script: [{ docs: [] }] });
    assert.equal(await preflight({ reader, runId: RUN_ID }), true);
    assert.equal(reader.calls.length, 1);
    assert.equal(reader.calls[0].partitionKey, undefined, 'the pre-send read must be unscoped');
  });

  it('refuses when a document already carries this run id — the correlation could not be trusted', async () => {
    const reader = fakeReader({ script: [{ docs: deliveredDocuments() }] });
    await assert.rejects(
      () => preflight({ reader, runId: RUN_ID }),
      err => {
        assert.equal(err.exitCode, EXIT.AMBIGUOUS);
        assert.match(err.message, /NOTHING WAS SENT/);
        return true;
      }
    );
  });

  it('treats an unreadable answer as a failure, not as an empty container', async () => {
    const reader = fakeReader({ script: [{ docs: undefined }] });
    reader.queryDocuments = async () => 'not a list';
    await assert.rejects(
      () => preflight({ reader, runId: RUN_ID }),
      err => {
        assert.equal(err.exitCode, EXIT.AMBIGUOUS);
        return true;
      }
    );
  });

  it('classifies a 403 as AUTH and says explicitly that nothing was sent', async () => {
    const reader = fakeReader({ script: [{ error: forbiddenError() }] });
    await assert.rejects(
      () => preflight({ reader, runId: RUN_ID }),
      err => {
        assert.equal(err.exitCode, EXIT.AUTH);
        assert.match(err.message, /NOTHING WAS SENT/);
        assert.match(err.message, /says nothing about whether the route works/);
        return true;
      }
    );
  });
});

// ===========================================================================
// End-to-end through main(), asserted BY EXIT CODE.
// ===========================================================================

describe('main: the confirmed path', () => {
  it('exits 0 and writes an evidence file whose observed id count matches', async () => {
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      const { exitCode, log, spawn } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });

      assert.equal(exitCode, EXIT.OK);
      assert.equal(spawn.calls.length, MESSAGES_PER_RUN);

      const record = JSON.parse(await readFile(evidenceOut, 'utf8'));
      assert.equal(record.confirmed, true);
      assert.equal(record.exitCode, EXIT.OK);
      assert.equal(record.count, MESSAGES_PER_RUN);
      assert.equal(record.ids.length, record.count);
      assert.equal(record.runId, RUN_ID);
      assert.equal(record.marker.value, SYNTHETIC_MARKER);
      assert.equal(record.deviceId, FIXTURE_DEVICE_ID);
      // HR4: measured, and carrying the declared comparand alongside it.
      assert.equal(record.measuredDefaultTtl, 604800);
      assert.equal(record.partitionKeyPath, '/deviceId');
      assert.equal(record.waitBoundMs, 1000);
      assert.ok(record.expiryInstant);
      assert.match(log.all(), /CONFIRMED/);

      // No debris beside the artifact.
      assert.deepEqual(await readdir(dir), ['evidence.json']);
    });
  });

  it('does the pre-send read BEFORE the first spawn, and polls only after sending', async () => {
    await withTempDir(async dir => {
      const order = [];
      const reader = fakeReader({ script: [{ docs: [] }, { docs: deliveredDocuments() }] });
      const wrapped = {
        queryDocuments: async request => {
          order.push('read');
          return reader.queryDocuments(request);
        },
      };
      const spawn = fakeAzSpawn({});
      const spy = async (...args) => {
        order.push('send');
        return spawn(...args);
      };
      const clock = fakeClock({ start: RUN_MILLIS });

      const exitCode = await main({
        argv: [...BASE_ARGV, '--evidence-out', path.join(dir, 'e.json'), '--timeout', '1000'],
        createReader: async () => wrapped,
        spawn: spy,
        log: recordingLog(),
        readFileFn: async () => readFixture('container-show-clean.json'),
        now: clock.now,
        sleep: clock.sleep,
        uuid: () => UUID,
      });

      assert.equal(exitCode, EXIT.OK);
      assert.deepEqual(order, ['read', 'send', 'send', 'send', 'read']);
    });
  });

  it('reads the container definition from stdin when given -', async () => {
    await withTempDir(async dir => {
      const text = await readFixture('container-show-clean.json');
      const clock = fakeClock({ start: RUN_MILLIS });
      const exitCode = await main({
        argv: [
          '--hub',
          HUB,
          '--account',
          ACCOUNT,
          '--database',
          DATABASE,
          '--container',
          CONTAINER,
          '--container-definition',
          '-',
          '--evidence-out',
          path.join(dir, 'e.json'),
          '--timeout',
          '1000',
        ],
        createReader: async () =>
          fakeReader({ script: [{ docs: [] }, { docs: deliveredDocuments() }] }),
        spawn: fakeAzSpawn({}),
        log: recordingLog(),
        stdin: (async function* () {
          yield Buffer.from(text, 'utf8');
        })(),
        now: clock.now,
        sleep: clock.sleep,
        uuid: () => UUID,
      });
      assert.equal(exitCode, EXIT.OK);
    });
  });

  it('surfaces measured TTL drift as a finding and records it, without failing the run', async () => {
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      const { exitCode, log } = await runMain({
        evidenceOut,
        definition: 'container-show-ttl-drift.json',
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });
      assert.equal(exitCode, EXIT.OK);
      assert.match(log.all(), /FINDING/);
      const record = JSON.parse(await readFile(evidenceOut, 'utf8'));
      assert.ok(record.ttlDriftFinding);
      assert.equal(record.measuredDefaultTtl, record.ttlDriftFinding.measured);
      assert.notEqual(record.measuredDefaultTtl, record.declaredDefaultTtl);
    });
  });
});

describe('main: every failure class exits with its own code and claims nothing', () => {
  it('a nonzero az exit maps to SEND_FAILURE and leaks nothing the child printed', async () => {
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      const { exitCode, log } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }] },
        spawnSpec: { script: [{ code: 1, stderr: LEAKY_AZ_STDERR }] },
      });

      assert.equal(exitCode, EXIT.SEND_FAILURE);
      const output = log.all();
      assert.ok(output.includes(FIXTURE_DEVICE_ID), 'output must name the device');
      assert.ok(output.includes(HUB), 'output must name the hub');
      assert.match(output, /send failure/);
      assertNoPlantedSecret(output, 'main send-failure output');
      // The FIRST message failed, so nothing was accepted and there is nothing
      // to account for. Absence of a record here is the honest answer.
      assert.deepEqual(await readdir(dir), []);
    });
  });

  // The partial send. az accepted message 1 and failed on message 2, so ONE
  // document is on its way to the live container — and unwinding past the
  // evidence write would leave it there with nothing accounting for it. MG-53
  // halts on exactly that, and cannot tell it apart from the unknown writer its
  // halt exists to catch.
  it('a partial send RECORDS the ids that already landed before exiting SEND_FAILURE', async () => {
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      const { exitCode, log, spawn } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }] },
        spawnSpec: { script: [{ code: 0 }, { code: 1, stderr: LEAKY_AZ_STDERR }] },
      });

      assert.equal(exitCode, EXIT.SEND_FAILURE);
      assert.equal(spawn.calls.length, 2, 'the run aborted on the second message');

      const record = JSON.parse(await readFile(evidenceOut, 'utf8'));
      assert.equal(record.confirmed, false);
      assert.equal(record.exitCode, EXIT.SEND_FAILURE);
      // The one message az accepted, recorded by id. This is the whole point.
      assert.equal(record.requestedIds.length, 1);
      assert.equal(record.requestedCount, 1);
      assert.ok(record.requestedIds[0].includes(RUN_ID));
      // Nothing was read back, and the record says so rather than implying an
      // absence: no read-back was ever attempted.
      assert.deepEqual(record.ids, []);
      assert.equal(record.count, 0);
      assert.equal(record.scope, 'not-attempted');
      assert.ok(record.findings.some(f => f.kind === 'unconfirmed-run'));
      assert.equal(record.expectedCount, MESSAGES_PER_RUN);

      const output = log.all();
      // The id is in the terminal too, so a run killed before the write still
      // leaves a record the operator can act on.
      assert.ok(output.includes(record.requestedIds[0]), 'the sent id must be logged');
      assert.match(output, /recording what WAS sent/);
      assertNoPlantedSecret(output, 'main partial-send output');
    });
  });

  it('a successful send followed by a timeout exits TIMEOUT and records an UNCONFIRMED run', async () => {
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      const { exitCode, spawn } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }], fallback: { docs: [] } },
      });

      assert.equal(exitCode, EXIT.TIMEOUT);
      assert.equal(spawn.calls.length, MESSAGES_PER_RUN, 'the send did happen');

      const record = JSON.parse(await readFile(evidenceOut, 'utf8'));
      assert.equal(record.confirmed, false);
      assert.equal(record.exitCode, EXIT.TIMEOUT);
      assert.equal(record.count, 0);
      assert.deepEqual(record.ids, []);
      // The artifact exists so the sent-but-unconfirmed documents are accounted
      // for, and says in its own findings that it is not proof of anything.
      assert.ok(record.findings.some(f => f.kind === 'unconfirmed-run'));
      assert.equal(record.waitBoundMs, 1000);
      assert.equal(record.crossPartitionSweepRun, true);
    });
  });

  it('a read-back document WITHOUT the marker exits MARKER_VIOLATION, not success', async () => {
    await withTempDir(async dir => {
      const unmarked = deliveredDocuments().map(doc => {
        const copy = { ...doc };
        delete copy[SYNTHETIC_MARKER_FIELD];
        return copy;
      });
      const { exitCode } = await runMain({
        evidenceOut: path.join(dir, 'evidence.json'),
        readerSpec: { script: [{ docs: [] }, { docs: unmarked }] },
      });
      assert.equal(exitCode, EXIT.MARKER_VIOLATION);
    });
  });

  it('an incomplete read-back at the bound exits AMBIGUOUS, never success and never absence', async () => {
    await withTempDir(async dir => {
      const partial = deliveredDocuments().slice(0, 2);
      const { exitCode } = await runMain({
        evidenceOut: path.join(dir, 'evidence.json'),
        readerSpec: { script: [{ docs: [] }], fallback: { docs: partial } },
      });
      assert.equal(exitCode, EXIT.AMBIGUOUS);
    });
  });

  it('documents found only outside the expected partition exit UNEXPECTED_PARTITION, not TIMEOUT', async () => {
    await withTempDir(async dir => {
      const elsewhere = deliveredDocuments(RUN_ID, { deviceId: 'some-other-partition' });
      const { exitCode } = await runMain({
        evidenceOut: path.join(dir, 'evidence.json'),
        timeoutMs: 1,
        pollIntervalMs: 1,
        // preflight, poll, poll, then the single cross-partition sweep.
        readerSpec: { script: [{ docs: [] }, { docs: [] }, { docs: [] }, { docs: elsewhere }] },
      });
      assert.equal(exitCode, EXIT.UNEXPECTED_PARTITION);
    });
  });

  it('a 403 on the pre-send read exits AUTH and sends NOTHING', async () => {
    await withTempDir(async dir => {
      const { exitCode, log, spawn } = await runMain({
        evidenceOut: path.join(dir, 'evidence.json'),
        readerSpec: { script: [{ error: forbiddenError() }] },
      });
      assert.equal(exitCode, EXIT.AUTH);
      assert.equal(spawn.calls.length, 0, 'no document may be written that cannot be confirmed');
      assert.deepEqual(await readdir(dir), [], 'and nothing is recorded');
      assert.match(log.all(), /auth failure/);
    });
  });

  it('a 401 during the confirmation exits AUTH immediately, not TIMEOUT', async () => {
    await withTempDir(async dir => {
      const { exitCode, reader } = await runMain({
        evidenceOut: path.join(dir, 'evidence.json'),
        readerSpec: { script: [{ docs: [] }, { error: authError() }] },
      });
      assert.equal(exitCode, EXIT.AUTH);
      assert.equal(reader.calls.length, 2, 'an auth failure is never retried');
    });
  });

  it('a transport failure with retries exhausted exits TRANSPORT, never an absence', async () => {
    await withTempDir(async dir => {
      const { exitCode } = await runMain({
        evidenceOut: path.join(dir, 'evidence.json'),
        readerSpec: { script: [{ docs: [] }], fallback: { error: transportError() } },
      });
      assert.equal(exitCode, EXIT.TRANSPORT);
    });
  });

  it('a container definition missing its partition key exits CONTAINER_DEFINITION and sends nothing', async () => {
    await withTempDir(async dir => {
      const { exitCode, spawn } = await runMain({
        evidenceOut: path.join(dir, 'evidence.json'),
        definition: 'container-show-missing-partition-key.json',
        readerSpec: { script: [{ docs: [] }] },
      });
      assert.equal(exitCode, EXIT.CONTAINER_DEFINITION);
      assert.equal(spawn.calls.length, 0);
    });
  });

  it('a malformed container definition exits CONTAINER_DEFINITION rather than assuming a shape', async () => {
    await withTempDir(async dir => {
      const { exitCode } = await runMain({
        evidenceOut: path.join(dir, 'evidence.json'),
        definition: 'container-show-malformed.json',
        readerSpec: { script: [{ docs: [] }] },
      });
      assert.equal(exitCode, EXIT.CONTAINER_DEFINITION);
    });
  });

  it('an unreadable container definition file exits CONTAINER_DEFINITION, never a default', async () => {
    await withTempDir(async dir => {
      const clock = fakeClock({ start: RUN_MILLIS });
      const spawn = fakeAzSpawn({});
      const exitCode = await main({
        argv: [...BASE_ARGV, '--evidence-out', path.join(dir, 'e.json')],
        createReader: async () => fakeReader({}),
        spawn,
        log: recordingLog(),
        readFileFn: async () => {
          throw Object.assign(new Error('no such file'), { code: 'ENOENT' });
        },
        now: clock.now,
        sleep: clock.sleep,
        uuid: () => UUID,
      });
      assert.equal(exitCode, EXIT.CONTAINER_DEFINITION);
      assert.equal(spawn.calls.length, 0);
    });
  });

  it('measuring the wrong container is refused rather than recorded', async () => {
    await withTempDir(async dir => {
      const { exitCode } = await runMain({
        evidenceOut: path.join(dir, 'evidence.json'),
        argv: ['--container', 'sessions'],
        readerSpec: { script: [{ docs: [] }] },
      });
      assert.equal(exitCode, EXIT.CONTAINER_DEFINITION);
    });
  });

  // ---- The evidence write itself failing. ---------------------------------
  //
  // The live container has changed and nothing recorded it. That is its own exit
  // code, and specifically NOT usage: telling an operator "bad arguments,
  // nothing happened" while documents sit in the container is the worst answer
  // this tool can give, and it is the one MG-53 cannot diagnose.
  const failingFs = () => ({
    stat: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    writeFile: async () => {
      throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
    },
    rename: async () => {},
    rm: async () => {},
  });

  it('a CONFIRMED run whose evidence write fails exits EVIDENCE_UNRECORDED, never USAGE', async () => {
    await withTempDir(async dir => {
      const { exitCode, log } = await runMain({
        evidenceOut: path.join(dir, 'nonexistent-directory', 'evidence.json'),
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
        fs: failingFs(),
      });

      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      assert.notEqual(exitCode, EXIT.USAGE, 'this must never read as "nothing live happened"');
      assert.notEqual(exitCode, EXIT.OK);

      const output = log.all();
      assert.match(output, /EVIDENCE NOT RECORDED/);
      assert.match(output, /ARE in/, 'a confirmed run knows the documents exist');
      assert.match(output, /RECORD THESE IDS BY HAND/);
      assert.ok(output.includes(RUN_ID));
      // Every observed id is named, because recording them by hand is the
      // action this exit code exists to demand.
      for (const doc of deliveredDocuments()) {
        assert.ok(output.includes(doc.id), `the output must name ${doc.id}`);
      }
      assert.match(output, /evidence unrecorded/, 'the exit label is reported');
      assert.deepEqual(await readdir(dir), [], 'no partial artifact is left behind');
    });
  });

  // The same collision, reached the way an operator actually reaches it: a
  // second run pointed at the first run's evidence file. The refusal to
  // overwrite is correct — that file records documents still in the container —
  // but the run that hit it has ALSO put documents there.
  it('a re-run refused for not overwriting still exits EVIDENCE_UNRECORDED, not USAGE', async () => {
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      await writeFile(evidenceOut, '{"an":"earlier run"}\n', 'utf8');

      const { exitCode, log } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });

      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      const output = log.all();
      assert.match(output, /refusing to overwrite/);
      assert.match(output, /EVIDENCE NOT RECORDED/);
      // The earlier run's record is intact — refusing to clobber it is the
      // behaviour that produced this exit code in the first place.
      assert.equal(await readFile(evidenceOut, 'utf8'), '{"an":"earlier run"}\n');
    });
  });

  // The unconfirmed path is where the record matters MOST: without it the
  // operator cannot tell "delivered but unfindable" from "never delivered", and
  // the documents are in the container either way. The write failure used to
  // vanish here entirely.
  it('an evidence write that fails on an UNCONFIRMED run is never swallowed', async () => {
    await withTempDir(async dir => {
      const { exitCode, log, spawn } = await runMain({
        evidenceOut: path.join(dir, 'nonexistent-directory', 'evidence.json'),
        readerSpec: { script: [{ docs: [] }], fallback: { docs: [] } },
        fs: failingFs(),
      });

      assert.equal(spawn.calls.length, MESSAGES_PER_RUN, 'the send did happen');
      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);

      const output = log.all();
      assert.match(output, /EVIDENCE NOT RECORDED/);
      assert.match(output, /MAY BE in/, 'an unconfirmed run cannot claim the documents exist');
      // The confirmation's own outcome is still reported, on the lines above:
      // the write failure takes the exit code, not the diagnosis.
      assert.match(output, /confirmation timeout/);
      for (const doc of deliveredDocuments()) {
        assert.ok(output.includes(doc.id), `the output must name the sent id ${doc.id}`);
      }
    });
  });

  // Not only the WRITE. A record that cannot be BUILT leaves the documents just
  // as unaccounted for, and buildEvidenceRecord refuses with USAGE — the one
  // code that must never describe a run that changed the live system. Reached
  // here the way it is reachable live: a platform-assigned document id that the
  // record's own credential-shape guard refuses.
  it('a record that cannot even be BUILT after a send exits EVIDENCE_UNRECORDED, not USAGE', async () => {
    await withTempDir(async dir => {
      const renamed = deliveredDocuments().map((doc, index) => ({
        ...doc,
        id: `${'A'.repeat(44)}${index}`,
      }));
      const { exitCode, log } = await runMain({
        evidenceOut: path.join(dir, 'evidence.json'),
        readerSpec: { script: [{ docs: [] }, { docs: renamed }] },
      });

      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      assert.notEqual(exitCode, EXIT.USAGE);
      const output = log.all();
      assert.match(output, /EVIDENCE NOT RECORDED/);
      assert.match(output, /credential-shape risk/, 'the reason for the refusal is reported');
      assert.deepEqual(await readdir(dir), [], 'and nothing half-written is left behind');
    });
  });

  it('a partial send whose evidence write ALSO fails exits EVIDENCE_UNRECORDED', async () => {
    await withTempDir(async dir => {
      const { exitCode, log } = await runMain({
        evidenceOut: path.join(dir, 'nonexistent-directory', 'evidence.json'),
        readerSpec: { script: [{ docs: [] }] },
        spawnSpec: { script: [{ code: 0 }, { code: 1 }] },
        fs: failingFs(),
      });

      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      const output = log.all();
      assert.match(output, /EVIDENCE NOT RECORDED/);
      assert.match(output, /MAY BE in/);
      assert.ok(output.includes(`${RUN_ID}-1`), 'the id that landed must be named');
    });
  });

  it('a usage error still names the device, the hub and the exit label', async () => {
    const log = recordingLog();
    const exitCode = await main({
      argv: [...BASE_ARGV, '--evidence-out', 'e.json', '--key', PLANTED.deviceKey],
      createReader: async () => fakeReader({}),
      spawn: fakeAzSpawn({}),
      log,
    });
    assert.equal(exitCode, EXIT.USAGE);
    assert.match(log.all(), /usage error/);
    assertNoPlantedSecret(log.all(), 'main usage-error output');
  });

  it('--help exits 0 and documents the whole operator flow', async () => {
    const log = recordingLog();
    assert.equal(await main({ argv: ['--help'], log }), EXIT.OK);
    const help = log.all();
    for (const topic of [
      'az iot device send-d2c-message',
      'az login',
      'azure-iot',
      'role assignment create',
      '--container-definition',
      '--evidence-out',
      'default_ttl',
      'confirmed-in-cosmos',
      // The operator has to be able to look up the one code that means "the
      // live container changed and nothing recorded it".
      'evidence unrecorded',
    ]) {
      assert.ok(help.includes(topic), `--help does not mention ${topic}`);
    }
    assert.equal(help.includes('--debug'), false, '--help must not suggest a verbosity flag');
  });
});

// ===========================================================================
// Source-text assertions: properties a behavioural test cannot see the absence
// of. Comments are stripped first — the header discusses key auth deliberately,
// and that documentation is worth keeping greppable.
// ===========================================================================

describe('source posture (HR1)', () => {
  const stripComments = source =>
    source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^[ \t]*\/\/.*$/gm, '');

  it('reads no environment variable at all, so no credential can arrive by that door', async () => {
    const code = stripComments(await readSource('./send-fixture.mjs'));
    assert.equal(/process\.env/.test(code), false, 'send-fixture.mjs reads process.env');
    for (const name of [
      'COSMOS_EXPORT_KEY',
      'AZURE_CLIENT_SECRET',
      'IOTHUB_CONNECTION_STRING',
      'IOT_DEVICE_KEY',
      'AZURE_STORAGE_KEY',
      'ARM_CLIENT_SECRET',
    ]) {
      assert.equal(code.includes(name), false, `send-fixture.mjs references ${name}`);
    }
  });

  it('offers no key, connection-string, SAS or certificate auth mode in its code', async () => {
    const code = stripComments(await readSource('./send-fixture.mjs'));
    for (const pattern of [
      /\bkey\s*:/,
      /\bmasterKey\b/,
      /\bconnectionString\b/i,
      /\bresourceTokens\b/,
      /\bSharedAccessKey\b/,
      /\bSharedAccessSignature\b/,
      /\bauthMode\b/,
    ]) {
      assert.equal(pattern.test(code), false, `send-fixture.mjs matches ${pattern}`);
    }
    // ...and the one auth wiring it does have is the AAD one.
    assert.match(code, /aadCredentials/);
    assert.match(code, /DefaultAzureCredential/);
  });

  it('never hands az a verbosity flag', async () => {
    const code = stripComments(await readSource('./send-fixture.mjs'));
    // The only occurrences allowed are the REFUSED set and the messages that
    // explain the refusal — never an element pushed into a send argv.
    const argvBuilder = /export function buildSendArgv[\s\S]*?\n}/.exec(code)?.[0] ?? '';
    assert.ok(argvBuilder, 'buildSendArgv not found');
    assert.equal(argvBuilder.includes('--debug'), false);
    assert.equal(argvBuilder.includes('--verbose'), false);
  });

  it('imports only node: built-ins and local siblings, and nothing from cosmos-export', async () => {
    const source = await readSource('./send-fixture.mjs');
    const specifiers = [
      ...[...source.matchAll(/^\s*(?:import|export)\b[^\n]*?\sfrom\s*['"]([^'"]+)['"]/gm)].map(
        m => m[1]
      ),
      ...[...source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]/g)].map(m => m[1]),
    ];
    for (const specifier of specifiers) {
      const azureSdk = specifier === '@azure/cosmos' || specifier === '@azure/identity';
      assert.ok(
        specifier.startsWith('node:') || specifier.startsWith('./') || azureSdk,
        `send-fixture.mjs imports ${specifier}`
      );
      assert.equal(specifier.includes('cosmos-export'), false);
    }
    // The two Azure packages appear ONLY behind the injectable dynamic thunks,
    // so this file still parses and tests in the credentialless CI tier.
    assert.equal(/^\s*import\s[^\n]*'@azure\//m.test(source), false);
  });

  it('issues no mutating Cosmos call and spawns nothing but az', async () => {
    const code = stripComments(await readSource('./send-fixture.mjs'));
    for (const pattern of [
      /\.items\.create\b/,
      /\.items\.upsert\b/,
      /\.items\.bulk\b/,
      /\.item\(/,
      /\.containers\.create/,
      /\.databases\.create/,
      /\.replace\(/,
      /\.delete\(/,
    ]) {
      assert.equal(pattern.test(code), false, `send-fixture.mjs matches ${pattern}`);
    }
    assert.match(code, /shell:\s*false/);
  });

  // HR1 says no device key, connection string, SAS token or certificate is
  // committed to the repository ANYWHERE — "including tests, fixtures, examples,
  // sample env files, and documentation". So this greps the TEST file as well as
  // the tool, comments and all. It is the reason the planted secrets above are
  // constructed at runtime instead of written down: the shapes must exist while
  // the tests run and must not exist in the diff.
  //
  // The patterns require a credential-shaped VALUE, not merely the word: a
  // template interpolation like `SharedAccessKey=${...}` is not a committed
  // secret, and flagging it would only teach the next author to disable this.
  for (const file of ['./send-fixture.mjs', './send-fixture.test.mjs']) {
    it(`${file} carries no credential-shaped literal, comments included`, async () => {
      const source = await readSource(file);
      for (const pattern of [
        /\bBearer\s+[\w-]{20,}/,
        /\b[\w-]{16,}\.[\w-]{16,}\.[\w-]{16,}\b/,
        /(AccountKey|SharedAccessKey|SharedAccessSignature|sig)\s*=\s*[A-Za-z0-9+/%_-]{20,}/i,
        /[A-Za-z0-9+/]{40,}={0,2}/,
      ]) {
        assert.equal(pattern.test(source), false, `${file} matches ${pattern}`);
      }
    });
  }

  // ...and the constructed shapes are genuinely the shapes, so the leak tests
  // above are not passing because they plant something harmless.
  it('the planted secrets really do have credential shapes at runtime', () => {
    assert.match(PLANTED.deviceKey, /^[A-Za-z0-9+/]{40,}={0,2}$/);
    assert.match(PLANTED.jwt, /^[\w-]{16,}\.[\w-]{16,}\.[\w-]{16,}$/);
    assert.match(PLANTED.sasSignature, /^[\w-]{20,}$/);
  });
});

describe('the measured shape is what is used (HR4)', () => {
  it('derives the body field from the container definition, not from a constant', async () => {
    // The clean fixture measures /deviceId; the body must carry deviceId
    // because that is what was MEASURED, and the same value must be the
    // partition the read-back scopes to.
    const definition = parseContainerDefinition(await readFixture('container-show-clean.json'), {
      expectedContainer: CONTAINER,
    });
    assert.equal(definition.partitionKeyField, 'deviceId');

    await withTempDir(async dir => {
      const { exitCode, spawn, reader } = await runMain({
        evidenceOut: path.join(dir, 'e.json'),
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });
      assert.equal(exitCode, EXIT.OK);
      const body = JSON.parse(spawn.calls[0].argv[spawn.calls[0].argv.indexOf('--data') + 1]);
      assert.equal(body[definition.partitionKeyField], FIXTURE_DEVICE_ID);
      // Poll 2 is the confirmation read; it is scoped to that same partition.
      assert.equal(reader.calls[1].partitionKey, FIXTURE_DEVICE_ID);
    });
  });
});
