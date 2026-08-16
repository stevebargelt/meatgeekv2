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
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename as realRename,
  rm,
  stat as realStat,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseContainerDefinition } from './container-definition.mjs';
import { PARTIAL_SUFFIX, evidenceFileName, partialPathFor } from './evidence.mjs';
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
  CONNECTION_DEVICE_ID_PROPERTY,
  ENVELOPE_BODY_FIELD,
  ENVELOPE_SYSTEM_PROPERTIES_FIELD,
  EXIT,
  FIXTURE_DEVICE_ID,
  FixtureError,
  MESSAGES_PER_RUN,
  RUN_ID_FIELD,
  RUN_ID_PARAMETER,
  SYNTHETIC_MARKER,
  SYNTHETIC_MARKER_FIELD,
  buildFixtureMessages,
  createRunLedger,
  newRunId,
  scrubSecrets,
} from './fixture-core.mjs';
import {
  AZ_COMMAND,
  DEFAULT_SEND_TIMEOUT_MS,
  KILL_GRACE_MS,
  assertArgvIsCredentialFree,
  buildSendArgv,
  cosmosReader,
  createRealReader,
  endpointFor,
  main,
  parseArgs,
  preflight,
  realSpawn,
  requireComplete,
  sendMessages,
  settleRun,
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

// Per-run ownership: --evidence-out is a DIRECTORY, and the file the tool writes
// inside it is DERIVED from the run id. Tests pass a directory and read the
// derived file back.
const evidenceFileIn = (dir, runId = RUN_ID) => path.join(dir, evidenceFileName(runId));

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

/**
 * A log that breaks PERMANENTLY once a line matching `armOn` is written, and
 * records every line either way.
 *
 * Modelled on the real failure rather than an invented one: an operator piping
 * this tool into `head` closes stdout mid-run, and from that write onwards every
 * write raises EPIPE — it does not recover. `armOn` picks the moment, so a test
 * can break the reporting from the settlement onwards while letting the run
 * itself complete.
 *
 * Recording BEFORE throwing is what makes the last-resort path assertable: that
 * handler reports through a log it already knows may be broken, so its lines
 * would otherwise vanish along with the failure they describe.
 */
function throwingLog({ armOn = () => true } = {}) {
  const base = recordingLog();
  let armed = false;
  const emit = level => line => {
    base[level](line);
    if (!armed && armOn(String(line))) armed = true;
    if (armed) throw Object.assign(new Error('EPIPE: broken pipe'), { code: 'EPIPE' });
  };
  return { ...base, info: emit('info'), error: emit('error') };
}

/**
 * The documents a healthy route delivers for `runId`, as IoT Hub routes them
 * (MG-73): the sender body nested under `Body`, a platform-assigned root id, and
 * the endpoint-stamped root partition value (with the matching authenticated
 * connection id) at the root. `overrides` merges at the ROOT — e.g.
 * `{ deviceId: 'some-other-partition' }` models a landing under a different
 * partition value.
 */
function deliveredDocuments(runId = RUN_ID, overrides = {}) {
  return buildFixtureMessages({
    runId,
    partitionKeyField: 'deviceId',
    deviceId: FIXTURE_DEVICE_ID,
    now: () => RUN_MILLIS,
  }).map((message, i) => {
    const partitionValue = overrides.deviceId ?? FIXTURE_DEVICE_ID;
    return {
      id: `cosmos-assigned-${i + 1}`,
      deviceId: partitionValue,
      [ENVELOPE_SYSTEM_PROPERTIES_FIELD]: { [CONNECTION_DEVICE_ID_PROPERTY]: partitionValue },
      [ENVELOPE_BODY_FIELD]: { ...message.body },
      _ts: 1_754_000_000,
      ...overrides,
    };
  });
}
/** The Cosmos root ids a confirmed read-back observes for `runId`. */
function observedRootIds() {
  return Array.from({ length: MESSAGES_PER_RUN }, (_, i) => `cosmos-assigned-${i + 1}`);
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
  spawn: spawnOverride,
  createReader,
  timeoutMs = 1000,
  pollIntervalMs = 250,
  evidenceOut,
  fs,
  // Injected rather than fixed, so two runs can be driven against ONE
  // --evidence-out with the distinct run ids two real operators would have. A
  // shared id would make the interleave tests below pass for the wrong reason.
  uuid = () => UUID,
  log = recordingLog(),
} = {}) {
  const clock = fakeClock({ start: RUN_MILLIS });
  const reader = fakeReader(readerSpec);
  // The override is for the one case a scripted az cannot express: the spawn
  // itself failing, before any child exists to have an exit code.
  const spawn = spawnOverride ?? fakeAzSpawn(spawnSpec);
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
    uuid,
    ...(fs ? { fs } : {}),
  });

  return { exitCode, log, spawn, reader, readerCalls, clock };
}

// ===========================================================================

describe('argument parsing', () => {
  it('defaults the device to the durable fixture and the wait to a bounded value', () => {
    const cfg = parseArgs([...BASE_ARGV, '--evidence-out', 'out-dir']);
    assert.equal(cfg.device, FIXTURE_DEVICE_ID);
    assert.equal(cfg.hub, HUB);
    assert.ok(Number.isInteger(cfg.timeoutMs) && cfg.timeoutMs > 0);
    assert.ok(Number.isInteger(cfg.pollIntervalMs) && cfg.pollIntervalMs > 0);
    // There is no overwrite mode: evidence artifacts are immutable and per-run.
    assert.equal('overwrite' in cfg, false);
  });

  it('accepts --flag=value as well as --flag value, and - for stdin', () => {
    const cfg = parseArgs([
      `--hub=${HUB}`,
      `--account=${ACCOUNT}`,
      `--database=${DATABASE}`,
      `--container=${CONTAINER}`,
      '--container-definition',
      '-',
      '--evidence-out=out-dir',
    ]);
    assert.equal(cfg.containerDefinition, '-');
    assert.equal(cfg.evidenceOut, 'out-dir');
  });

  it('rejects --overwrite: there is no mode that replaces an evidence artifact', () => {
    assert.throws(
      () => parseArgs([...BASE_ARGV, '--evidence-out', 'out-dir', '--overwrite']),
      err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
    );
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

  // ------------------------------------------------------------------------
  // Per-resource-type name validation, SCOPED TO WHAT THIS FIXTURE ADDRESSES
  // (operator-authorized correction, MG-67).
  //
  // Each of the five names is validated against an allowlist as narrow as THIS
  // TOOL genuinely needs — NOT as wide as Azure legally permits. The fixture
  // addresses one known dev hub, one durable dev device, one dev Cosmos account
  // and its plain-identifier database and containers; so every rule rejects a
  // dot, hence a JWT (three dot-separated segments), hence every separator-bearing
  // credential, BY CONSTRUCTION.
  //
  // HISTORY, so the scoping is not silently re-widened later. An early cycle
  // applied ONE credential-SHAPE heuristic (scrubSecrets(value) !== value)
  // uniformly, which both accepted a 32-char opaque key and over-refused. The next
  // cycle over-corrected: it carved the dotted Cosmos id
  // `analytics01.eventstore1.replicaWest` back in as ACCEPTED for --database and
  // --container, to placate an over-refusal finding — but that protected a case
  // this fixture will NEVER address (it names meatgeek-v2-dev-db and temperatures,
  // not arbitrary Cosmos resources), and it was the exact hole a security review
  // then reported: credential-shaped input accepted in the database and container
  // slots, reaching operator output and the evidence target. This cycle removes
  // the carve-out. A dotted id is now REFUSED for --database and --container too,
  // same as --device and --hub. Both directions are covered below, per type.
  // ------------------------------------------------------------------------

  const completeCfg = overrides => ({
    ...parseArgs([...BASE_ARGV, '--evidence-out', 'e.json']),
    ...overrides,
  });

  // SHORT_JWT is credential-SHAPED — the scrubber rewrites it — AND, being dotted,
  // fails every one of the five narrow name rules. Both facts matter now: it is
  // refused at validation in EVERY slot, and (the independent second defense) if
  // some future edit let it past, the scrubber would still rewrite it before it
  // reached a log line, the az argv or the evidence record.
  const SHORT_JWT = 'aaaaaaaaaaa.bbbbbbbbbbb.ccccccccccc';
  // An OPAQUE 32-character alphanumeric value: exactly the shape a device key
  // takes, and — the whole point of the pin — INDISTINGUISHABLE by any charset
  // rule from a 32-character alphanumeric device id. It clears DEVICE_ID_CHARSET
  // (letters and digits only, no dot, no separator) and yet is NOT the declared
  // fixture, so only the pin refuses it. It is obviously synthetic (a self-
  // describing prefix, not random base64) so it is not itself a committed
  // credential shape, but it stands in for one the charset can never catch. This
  // is the residual case the operator flagged: the pin is the only defense that
  // reaches it, because narrowing the pattern cannot.
  const OPAQUE_32_ALNUM = 'mg67opaqueDeviceToken' + 'x'.repeat(11);
  it('OPAQUE_32_ALNUM is a 32-char alphanumeric value the charset accepts but the fixture pin must refuse', () => {
    assert.equal(OPAQUE_32_ALNUM.length, 32);
    assert.match(OPAQUE_32_ALNUM, /^[A-Za-z0-9]+$/);
    assert.notEqual(OPAQUE_32_ALNUM, FIXTURE_DEVICE_ID);
  });
  it('SHORT_JWT is credential-SHAPED (the scrubber rewrites it) AND dotted (every name rule refuses it)', () => {
    assert.notEqual(scrubSecrets(SHORT_JWT), SHORT_JWT);
  });

  // Both connection-string shapes carry '/' ';' '=' and dots, every one of which
  // is outside the narrow [A-Za-z0-9-] alphabet the account/database/container
  // rules now allow — so BOTH are refused in every Cosmos slot, not just the hub
  // one. Both embed a planted key, so the no-echo assertions below are
  // load-bearing.
  const CONNECTION_STRING = `HostName=${HUB}.azure-devices.net;SharedAccessKeyName=iothubowner;SharedAccessKey=${PLANTED.deviceKey}`;
  const COSMOS_CONNECTION_STRING = `AccountEndpoint=https://${ACCOUNT}.documents.azure.com:443/;AccountKey=${PLANTED.deviceKey}==;`;
  // The dotted Cosmos id the previous cycle wrongly accepted. It is credential-
  // SHAPED to the scrubber (a JWT-like run of dotted segments) and it is exactly
  // what this fixture will never legitimately be asked to name.
  const DOTTED_COSMOS_ID = 'analytics01.eventstore1.replicaWest';

  const NAME_CASES = [
    {
      option: '--hub',
      field: 'hub',
      // A JWT's dots and a connection string's separators both fail the hub rule.
      legal: ['meatgeek-v2-dev-iothub-259d4bf5b628', 'abc'],
      illegal: [SHORT_JWT, CONNECTION_STRING, DOTTED_COSMOS_ID, 'has space', 'under_score'],
    },
    {
      option: '--device',
      field: 'device',
      // --device is PINNED to the one declared durable fixture, not merely charset-
      // constrained (operator-required correction, MG-67 — this closes the last
      // item in the credential-handling family). A charset rule cannot separate a
      // 32-char opaque secret from a 32-char legal device id: there is no
      // difference to detect. So the ONLY accepted --device value is the declared
      // constant; EVERY other value is refused before it can be logged, passed to
      // az, or (deviceId being the container partition key) embedded in a document
      // body. That makes "opaque credential accepted as a device name" structurally
      // unreachable rather than mitigated. Note the illegal set: OPAQUE_32_ALNUM is
      // charset-legal yet refused (only the pin catches it), and
      // 'dev-fixture-v2-probe1' — a perfectly well-formed device id — is refused
      // too, because it is not THIS fixture. Accepted tradeoff, on the record:
      // addressing a different device now requires a code change; intended, the
      // fixture is durable and singular and MG-62 reuses this exact name.
      legal: [FIXTURE_DEVICE_ID],
      illegal: [
        OPAQUE_32_ALNUM,
        'dev-fixture-v2-probe1',
        SHORT_JWT,
        CONNECTION_STRING,
        'dev-fixture.v2',
        'a/b',
        'a;b',
        'a:b',
        'a#b',
        'has space',
        'under_score',
        'x'.repeat(129),
      ],
    },
    {
      option: '--account',
      field: 'account',
      legal: ['mgv2-dev-f640e19ae7ab', 'abc'],
      illegal: [
        SHORT_JWT,
        CONNECTION_STRING,
        COSMOS_CONNECTION_STRING,
        DOTTED_COSMOS_ID,
        'HasUpperCase',
        'ab',
      ],
    },
    {
      option: '--database',
      field: 'database',
      // The five dev databases/containers are plain identifiers. The rule matches
      // that need and NOT the Azure-legal Cosmos id set: a dot (hence the dotted id
      // and a JWT) is refused, closing the carve-out the last cycle wrongly added.
      legal: ['meatgeek-v2-dev-db', 'devices', 'temperatures'],
      illegal: [SHORT_JWT, DOTTED_COSMOS_ID, COSMOS_CONNECTION_STRING, 'a/b', 'a#b', 'a?b', 'a.b'],
    },
    {
      option: '--container',
      field: 'container',
      legal: ['temperatures', 'devices', 'cooks'],
      illegal: [SHORT_JWT, DOTTED_COSMOS_ID, COSMOS_CONNECTION_STRING, 'a/b', 'a\\b', 'a#b', 'a.b'],
    },
  ];

  for (const { option, field, legal, illegal } of NAME_CASES) {
    for (const value of legal) {
      it(`accepts the known dev / plain-identifier ${option} name (${value})`, () => {
        assert.doesNotThrow(() => requireComplete(completeCfg({ [field]: value })));
      });
    }
    for (const value of illegal) {
      // The rejected value is NEVER reflected back onto the terminal — the
      // per-type checkers name the RULE, not the input, so a pasted credential
      // does not appear in the refusal.
      it(`refuses an illegal/credential-shaped ${option} without echoing it`, () => {
        const error = refusal(() => requireComplete(completeCfg({ [field]: value })));
        assert.equal(error.exitCode, EXIT.USAGE);
        assert.match(error.message, /not a valid Azure resource name/);
        assert.equal(
          error.message.includes(value),
          false,
          `the rejected ${option} value was echoed in the refusal`
        );
        assertNoPlantedSecret(error.message, `requireComplete(${option})`);
      });
    }
  }

  // The explicit JWT-as-device case: a JWT is a LEGAL IoT Hub device id, so under
  // an Azure-legal rule it would be ACCEPTED as --device, then logged, passed to
  // the az argv, and — deviceId being the container partition key — embedded in the
  // Cosmos document body. The device rule is pinned below the Azure-legal set, so a
  // JWT in the --device slot is REFUSED by construction (its dots). This case must
  // keep passing across the ceiling correction.
  it('REFUSES a JWT-shaped value in the --device slot, before it is logged/sent/embedded', () => {
    const error = refusal(() => requireComplete(completeCfg({ device: SHORT_JWT })));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.match(error.message, /not a valid Azure resource name/);
    assert.equal(
      error.message.includes(SHORT_JWT),
      false,
      'the rejected device value was echoed in the refusal'
    );
    assertNoPlantedSecret(error.message, 'requireComplete(--device JWT)');
  });

  // The carve-out being CLOSED, stated as its own case. The previous cycle
  // ACCEPTED a JWT-/dotted-shaped value as a Cosmos container id "because dots are
  // legal there". They are not legal HERE any more: this fixture names plain
  // identifiers, so a dotted value is refused in the --database and --container
  // slots exactly as in the --device and --hub slots — before it can be logged,
  // passed to az, embedded in a document body, or written to the evidence record.
  for (const field of ['database', 'container']) {
    it(`REFUSES a JWT-/dotted-shaped value as a Cosmos ${field} id — the carve-out is closed`, () => {
      const error = refusal(() => requireComplete(completeCfg({ [field]: SHORT_JWT })));
      assert.equal(error.exitCode, EXIT.USAGE);
      assert.match(error.message, /not a valid Azure resource name/);
      assert.equal(error.message.includes(SHORT_JWT), false);
      assertNoPlantedSecret(error.message, `requireComplete(--${field} JWT)`);
    });
  }

  // Driven through main() so the assertion covers every line a real run prints,
  // not just the thrown message: no operator-facing line — info OR error — may
  // carry a rejected name, on the rejection path (validate-then-use). Now includes
  // --account and --database, the two slots the carve-out left exposed.
  for (const [option, value] of [
    ['--hub', SHORT_JWT],
    ['--device', CONNECTION_STRING],
    ['--account', COSMOS_CONNECTION_STRING],
    ['--database', DOTTED_COSMOS_ID],
    ['--container', COSMOS_CONNECTION_STRING],
  ]) {
    it(`main() emits no log line carrying a rejected ${option}, on the rejection path`, async () => {
      const log = recordingLog();
      const { exitCode } = await runMain({ argv: [option, value], evidenceOut: 'unused-dir', log });
      assert.equal(exitCode, EXIT.USAGE);
      assert.equal(
        log.all().includes(value),
        false,
        `a rejected ${option} reached an operator log line`
      );
      assertNoPlantedSecret(log.all(), `main(${option})`);
    });
  }

  // SECOND HALF OF THE FINDING — refused BEFORE az and BEFORE any evidence write.
  // A credential-shaped --account/--database/--container is refused during
  // argument validation, which runs before the container is measured, before the
  // reservation, before the send and before the record is built. This asserts the
  // negative directly: az is NEVER spawned and NO file is left in the real
  // --evidence-out directory, so the value cannot have been passed to az, embedded
  // in a document body, or written to the evidence target.
  for (const [option, value] of [
    // The --device opaque case is the load-bearing one the operator flagged: a
    // 32-char alphanumeric value the charset would accept, refused only by the
    // pin, and proven here to reach NO az argv, NO evidence file and NO log line —
    // including on this refusal path itself.
    ['--device', OPAQUE_32_ALNUM],
    ['--account', COSMOS_CONNECTION_STRING],
    ['--database', DOTTED_COSMOS_ID],
    ['--container', COSMOS_CONNECTION_STRING],
  ]) {
    it(`a credential-shaped ${option} never reaches az or the evidence record`, async () => {
      await withTempDir(async dir => {
        const log = recordingLog();
        const spawn = fakeAzSpawn({});
        const { exitCode } = await runMain({
          argv: [option, value],
          evidenceOut: dir,
          spawn,
          log,
        });
        assert.equal(exitCode, EXIT.USAGE);
        assert.equal(spawn.calls.length, 0, `az was spawned with a credential-shaped ${option}`);
        const left = await readdir(dir);
        assert.deepEqual(
          left,
          [],
          `a run refusing ${option} still wrote into the evidence directory`
        );
        assert.equal(log.all().includes(value), false, `a rejected ${option} reached a log line`);
        assertNoPlantedSecret(log.all(), `main(${option} pre-az)`);
      });
    });
  }

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

  // Defence in depth: the spawn gate judges the two name slots by the SAME
  // per-type rules requireComplete applied, so a dotted (JWT-shaped) device id is
  // refused HERE too — a dotted device can never reach the az argv even if a
  // future caller bypasses requireComplete. (Only the hub and the device names
  // enter this send argv; the Cosmos account/database/container names are
  // validated by the same narrow rules in requireComplete above, where a dotted
  // value is now refused for all of them alike.) The rejected value is not echoed.
  it('refuses a dotted (JWT-shaped) device id at the --device-id slot', () => {
    const dottedDevice = 'edge.fixture.mg67-probe';
    const dottedArgv = buildSendArgv({ hub: HUB, device: dottedDevice, message });
    const error = refusal(() => assertArgvIsCredentialFree(dottedArgv));
    assert.equal(error.exitCode, EXIT.USAGE);
    assert.equal(
      error.message.includes(dottedDevice),
      false,
      'the rejected device value was echoed at the spawn gate'
    );
  });

  // The other direction still holds: a non-name element that IS credential-shaped
  // is refused, because everything outside the two name slots is tool-authored
  // and never a legal Azure name.
  it('still refuses a credential shape planted in a non-name (tool-authored) slot', () => {
    const error = refusal(() =>
      assertArgvIsCredentialFree([...argv, `--data=Bearer ${PLANTED.jwt}`])
    );
    assert.equal(error.exitCode, EXIT.USAGE);
    assertNoPlantedSecret(error.message, 'assertArgvIsCredentialFree(non-name slot)');
  });
});

describe('sendMessages', () => {
  const messages = buildFixtureMessages({
    runId: RUN_ID,
    partitionKeyField: 'deviceId',
    now: () => RUN_MILLIS,
  });

  const send = (spawn, ledger = createRunLedger({ runId: RUN_ID })) => ({
    ledger,
    promise: sendMessages({
      messages,
      hub: HUB,
      device: FIXTURE_DEVICE_ID,
      spawn,
      ledger,
      log: recordingLog(),
    }),
  });

  it('spawns az once per message, always as an argv array', async () => {
    const spawn = fakeAzSpawn({});
    const { ledger, promise } = send(spawn);
    const ids = await promise;
    assert.equal(spawn.calls.length, MESSAGES_PER_RUN);
    assert.equal(ids.length, MESSAGES_PER_RUN);
    for (const call of spawn.calls) {
      assert.equal(call.command, AZ_COMMAND);
      assert.ok(Array.isArray(call.argv));
    }
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.requestedIds.length, MESSAGES_PER_RUN);
    assert.equal(snapshot.acceptedIds.length, MESSAGES_PER_RUN);
    assert.deepEqual([...snapshot.ambiguousIds], []);
  });

  // The ledger is the whole contract, so sending without one is refused rather
  // than allowed to produce a document the run cannot afterwards account for.
  it('refuses to send at all without a ledger to account for the attempts', async () => {
    const spawn = fakeAzSpawn({});
    await assert.rejects(
      () =>
        sendMessages({
          messages,
          hub: HUB,
          device: FIXTURE_DEVICE_ID,
          spawn,
          log: recordingLog(),
        }),
      err => {
        assert.equal(err.exitCode, EXIT.USAGE);
        return true;
      }
    );
    assert.equal(spawn.calls.length, 0, 'nothing may be sent before it can be recorded');
  });

  it('aborts the whole run on the first nonzero az exit rather than sending on', async () => {
    const spawn = fakeAzSpawn({ script: [{ code: 0 }, { code: 1, stderr: 'ERROR: nope' }] });
    const { ledger, promise } = send(spawn);
    await assert.rejects(() => promise, FixtureError);
    assert.equal(spawn.calls.length, 2, 'the third message must not be sent after a failure');
    // Two attempted, and the third was never attempted so it is not recorded as
    // anything: an id for a message that does not exist would be a fabrication.
    const snapshot = ledger.snapshot();
    assert.equal(snapshot.requestedIds.length, 2);
    assert.equal(snapshot.acceptedIds.length, 1);
    assert.equal(snapshot.ambiguousIds.length, 1);
    assert.equal(snapshot.uncertain, true);
  });

  // The crux: az exiting nonzero does NOT establish that the hub rejected the
  // message. The CLI can fail after IoT Hub took it, so the id is UNKNOWN, and
  // nothing on this path may say it was not written.
  it('records a failed message as of UNKNOWN acceptance, never as not-sent', async () => {
    const spawn = fakeAzSpawn({ script: [{ code: 3, stderr: LEAKY_AZ_STDERR }] });
    const { ledger, promise } = send(spawn);
    await assert.rejects(promise, err => {
      assert.equal(err.exitCode, EXIT.SEND_FAILURE);
      assert.ok(err.message.includes(FIXTURE_DEVICE_ID));
      assert.ok(err.message.includes(HUB));
      assert.match(err.message, /UNKNOWN/);
      assert.equal(
        /nothing was written|no message had been accepted|was not written/i.test(err.message),
        false,
        'an az failure must never be reported as a known absence'
      );
      assertNoPlantedSecret(err.message, 'sendMessages az-failure message');
      return true;
    });
    const snapshot = ledger.snapshot();
    assert.deepEqual([...snapshot.ambiguousIds], [messages[0].body.id]);
    assert.deepEqual([...snapshot.acceptedIds], []);
  });

  it('reports a spawn failure as a send failure of UNKNOWN acceptance, not as an absence', async () => {
    const spawn = async () => {
      throw Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' });
    };
    const { ledger, promise } = send(spawn);
    await assert.rejects(promise, err => {
      assert.equal(err.exitCode, EXIT.SEND_FAILURE);
      assert.match(err.message, /azure-iot/);
      assert.match(err.message, /UNKNOWN/);
      return true;
    });
    // Even a process that may never have run leaves the id UNKNOWN: this tool
    // cannot tell "never spawned" from "spawned and unreapable", and guessing
    // the convenient one is how a document goes unaccounted for.
    assert.equal(ledger.snapshot().ambiguousIds.length, 1);
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
      const evidenceOut = dir;
      const { exitCode, log, spawn } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });

      assert.equal(exitCode, EXIT.OK);
      assert.equal(spawn.calls.length, MESSAGES_PER_RUN);

      const record = JSON.parse(await readFile(evidenceFileIn(evidenceOut), 'utf8'));
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
      assert.deepEqual(await readdir(dir), [evidenceFileName(RUN_ID)]);
    });
  });

  it('records the authenticated point-read identity, not the payload device claim, in the proof artifact', async () => {
    await withTempDir(async dir => {
      const { exitCode, reader } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });

      assert.equal(exitCode, EXIT.OK);
      // Discovery yields the platform-assigned root ids; each one must then be
      // point-read under the registered fixture partition before exit 0 is
      // possible. The payload's Body.deviceId is only an advisory claim.
      assert.deepEqual(
        reader.readCalls,
        observedRootIds().map(id => ({ id, partitionKey: FIXTURE_DEVICE_ID }))
      );

      const record = JSON.parse(await readFile(evidenceFileIn(dir), 'utf8'));
      assert.deepEqual(record.observedIds, observedRootIds());
      assert.equal(record.observedDocuments.length, MESSAGES_PER_RUN);
      for (const document of record.observedDocuments) {
        assert.ok(observedRootIds().includes(document.rootId));
        assert.notEqual(
          document.rootId,
          document.bodyId,
          'the Cosmos root id is not sender-controlled'
        );
        assert.equal(document.rootPartitionValue, FIXTURE_DEVICE_ID);
        assert.equal(document.connectionDeviceId, FIXTURE_DEVICE_ID);
        assert.equal(document.bodyDeviceIdAdvisory, FIXTURE_DEVICE_ID);
      }
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
        // The point read the confirmation gates on (MG-73) delegates to the
        // fake's store; it is not a 'read' poll, so it does not enter `order`.
        readDocument: request => reader.readDocument(request),
      };
      const spawn = fakeAzSpawn({});
      const spy = async (...args) => {
        order.push('send');
        return spawn(...args);
      };
      const clock = fakeClock({ start: RUN_MILLIS });

      const exitCode = await main({
        argv: [...BASE_ARGV, '--evidence-out', dir, '--timeout', '1000'],
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
          dir,
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
      const evidenceOut = dir;
      const { exitCode, log } = await runMain({
        evidenceOut,
        definition: 'container-show-ttl-drift.json',
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });
      assert.equal(exitCode, EXIT.OK);
      assert.match(log.all(), /FINDING/);
      const record = JSON.parse(await readFile(evidenceFileIn(evidenceOut), 'utf8'));
      assert.ok(record.ttlDriftFinding);
      assert.equal(record.measuredDefaultTtl, record.ttlDriftFinding.measured);
      assert.notEqual(record.measuredDefaultTtl, record.declaredDefaultTtl);
    });
  });
});

// ---------------------------------------------------------------------------
// HR1, the raw-path-interpolation defect class.
//
// --evidence-out is operator-supplied text, and the tool names the reserved
// destination on operator-facing lines on EVERY path: the reservation success
// line, the CONFIRMED-evidence line, and the failure lines that tell an operator
// where the record was or was not written. A path component shaped like a
// credential — a hostile working directory, or an accident — must be scrubbed on
// ALL of them, success lines included, not just the error paths. The regression
// this class caused was exactly a success line interpolating the path raw.
//
// Two operator-supplied positions are exercised separately, because they are
// different accidents: a credential-shaped DIRECTORY component nested inside the
// path, and a credential-shaped FINAL (filename-position) component of the path.
// The scrubber redacts an `AccountKey=` run to the end of the line, so in both
// the value never survives into a log line.
// ---------------------------------------------------------------------------
describe('HR1: a credential-shaped evidence path never reaches operator output', () => {
  // Built at runtime (never a source literal, the same posture as PLANTED) so
  // this file trips no credential-in-source check of its own. base64url gives a
  // filesystem-safe single path segment — no '/', no whitespace — that is one
  // directory name and one scrub run. The scrubber keys off the `AccountKey=`
  // NAME, not the value, and consumes to the end of the line: the value is gone
  // whole regardless of its length.
  const PLANTED_PATH_KEY = Buffer.from('mg67-path-secret-only-never-a-real-account-key').toString(
    'base64url'
  );
  const credSegment = `AccountKey=${PLANTED_PATH_KEY}`;

  // A publication that fails AFTER the send (the reservation's write+rename probe
  // and exclusive create still use the real fs and succeed; only the record's
  // partial→target rename fails), so the failure line that names the path is
  // emitted with live documents already in the container.
  const publicationFailsFs = () => ({
    rename: async (from, to) => {
      if (from.endsWith('.probe-src') || to.endsWith('.probe-dst')) return realRename(from, to);
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    },
  });

  const assertPathSecretAbsent = log => {
    const output = log.all();
    assert.equal(
      output.includes(PLANTED_PATH_KEY),
      false,
      'the credential-shaped path component reached operator output'
    );
    // Guard against a false pass: the destination WAS named (so the assertion
    // above is meaningful) and the scrubber DID fire on it.
    assert.match(output, /evidence destination reserved for run/);
    assert.match(output, /AccountKey=\[redacted\]/);
  };

  it('scrubs a credential-shaped DIRECTORY component on the success path', async () => {
    await withTempDir(async base => {
      const evidenceOut = path.join(base, credSegment, 'evidence');
      await mkdir(evidenceOut, { recursive: true });
      const { exitCode, log } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });
      assert.equal(exitCode, EXIT.OK);
      // The CONFIRMED-evidence line is a success line that names the path.
      assert.match(log.all(), /CONFIRMED/);
      assertPathSecretAbsent(log);
    });
  });

  it('scrubs a credential-shaped FINAL (filename-position) path component on the success path', async () => {
    await withTempDir(async base => {
      const evidenceOut = path.join(base, credSegment);
      await mkdir(evidenceOut, { recursive: true });
      const { exitCode, log } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });
      assert.equal(exitCode, EXIT.OK);
      assert.match(log.all(), /CONFIRMED/);
      assertPathSecretAbsent(log);
    });
  });

  it('scrubs the credential-shaped path on the FAILURE line too (write fails after the send)', async () => {
    await withTempDir(async base => {
      const evidenceOut = path.join(base, credSegment);
      await mkdir(evidenceOut, { recursive: true });
      const { exitCode, log } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
        fs: publicationFailsFs(),
      });
      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      const output = log.all();
      assert.equal(
        output.includes(PLANTED_PATH_KEY),
        false,
        'the credential-shaped path reached the failure line'
      );
      // The failure line DID name where the record could not be written — scrubbed.
      assert.match(output, /could not be written to .*AccountKey=\[redacted\]/);
    });
  });
});

describe('main: every failure class exits with its own code and claims nothing', () => {
  it('a nonzero az exit maps to SEND_FAILURE and leaks nothing the child printed', async () => {
    await withTempDir(async dir => {
      const evidenceOut = dir;
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

      // The FIRST message failed — and that is NOT "nothing was written". az can
      // exit nonzero after IoT Hub took the message, so message 1 is one
      // document of unknown fate and the run owes an evidence record for it.
      const record = JSON.parse(await readFile(evidenceFileIn(evidenceOut), 'utf8'));
      assert.equal(record.attempted, true);
      assert.equal(record.uncertain, true);
      assert.equal(record.requestedCount, 1);
      assert.deepEqual(record.acceptedIds, []);
      assert.equal(record.ambiguousCount, 1);
      assert.deepEqual(record.observedIds, []);
      assert.equal(record.confirmed, false);
      assert.equal(record.exitCode, EXIT.SEND_FAILURE);
      assert.ok(record.findings.some(f => f.kind === 'ambiguous-acceptance'));
      assert.equal(
        /nothing was written|no message had been accepted/i.test(output),
        false,
        'the run must never assert that nothing was written'
      );
    });
  });

  // The partial send. az accepted message 1 and failed on message 2, so ONE
  // document is on its way to the live container and a SECOND may be — and
  // unwinding past the evidence write would leave both with nothing accounting
  // for them. MG-53 halts on exactly that, and cannot tell it apart from the
  // unknown writer its halt exists to catch.
  it('a partial send records the accepted id AND the unknown one before exiting SEND_FAILURE', async () => {
    await withTempDir(async dir => {
      const evidenceOut = dir;
      const { exitCode, log, spawn } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }] },
        spawnSpec: { script: [{ code: 0 }, { code: 1, stderr: LEAKY_AZ_STDERR }] },
      });

      assert.equal(exitCode, EXIT.SEND_FAILURE);
      assert.equal(spawn.calls.length, 2, 'the run aborted on the second message');

      const record = JSON.parse(await readFile(evidenceFileIn(evidenceOut), 'utf8'));
      assert.equal(record.confirmed, false);
      assert.equal(record.exitCode, EXIT.SEND_FAILURE);
      // Two attempted: one az reported success for, one whose acceptance nobody
      // knows. The third was never attempted, so no id is recorded for it.
      assert.equal(record.requestedCount, 2);
      assert.deepEqual(record.acceptedIds, [`${RUN_ID}-1`]);
      assert.deepEqual(record.ambiguousIds, [`${RUN_ID}-2`]);
      // Both must be accounted for downstream, whatever their acceptance.
      assert.deepEqual(record.accountableIds, [`${RUN_ID}-1`, `${RUN_ID}-2`]);
      // Nothing was read back, and the record says so rather than implying an
      // absence: no read-back was ever attempted.
      assert.deepEqual(record.ids, []);
      assert.equal(record.count, 0);
      assert.equal(record.scope, 'not-attempted');
      assert.equal(record.uncertain, true);
      assert.ok(record.findings.some(f => f.kind === 'unconfirmed-run'));
      assert.ok(record.findings.some(f => f.kind === 'ambiguous-acceptance'));
      assert.equal(record.expectedCount, MESSAGES_PER_RUN);
      // Never inferred from the shortfall: no observed id diverged because no
      // document was observed at all.
      assert.equal(record.idDivergence, false);

      const output = log.all();
      // The id is in the terminal too, so a run killed before the write still
      // leaves a record the operator can act on.
      assert.ok(output.includes(`${RUN_ID}-1`), 'the sent id must be logged');
      assert.match(output, /recording every id this run attempted/);
      assertNoPlantedSecret(output, 'main partial-send output');
    });
  });

  it('a successful send followed by a timeout exits TIMEOUT and records an UNCONFIRMED run', async () => {
    await withTempDir(async dir => {
      const evidenceOut = dir;
      const { exitCode, spawn } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }], fallback: { docs: [] } },
      });

      assert.equal(exitCode, EXIT.TIMEOUT);
      assert.equal(spawn.calls.length, MESSAGES_PER_RUN, 'the send did happen');

      const record = JSON.parse(await readFile(evidenceFileIn(evidenceOut), 'utf8'));
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
        const copy = { ...doc, [ENVELOPE_BODY_FIELD]: { ...doc[ENVELOPE_BODY_FIELD] } };
        delete copy[ENVELOPE_BODY_FIELD][SYNTHETIC_MARKER_FIELD];
        return copy;
      });
      const { exitCode } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }, { docs: unmarked }] },
      });
      assert.equal(exitCode, EXIT.MARKER_VIOLATION);
    });
  });

  it('an incomplete read-back at the bound exits AMBIGUOUS, never success and never absence', async () => {
    await withTempDir(async dir => {
      const partial = deliveredDocuments().slice(0, 2);
      const { exitCode } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }], fallback: { docs: partial } },
      });
      assert.equal(exitCode, EXIT.AMBIGUOUS);
    });
  });

  it('documents found only outside the expected partition exit UNEXPECTED_PARTITION, not TIMEOUT', async () => {
    await withTempDir(async dir => {
      const elsewhere = deliveredDocuments(RUN_ID, { deviceId: 'some-other-partition' });
      const { exitCode } = await runMain({
        evidenceOut: dir,
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
        evidenceOut: dir,
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
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }, { error: authError() }] },
      });
      assert.equal(exitCode, EXIT.AUTH);
      assert.equal(reader.calls.length, 2, 'an auth failure is never retried');
    });
  });

  it('a transport failure with retries exhausted exits TRANSPORT, never an absence', async () => {
    await withTempDir(async dir => {
      const { exitCode } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }], fallback: { error: transportError() } },
      });
      assert.equal(exitCode, EXIT.TRANSPORT);
    });
  });

  it('a container definition missing its partition key exits CONTAINER_DEFINITION and sends nothing', async () => {
    await withTempDir(async dir => {
      const { exitCode, spawn } = await runMain({
        evidenceOut: dir,
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
        evidenceOut: dir,
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
        argv: [...BASE_ARGV, '--evidence-out', dir],
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
        evidenceOut: dir,
        argv: ['--container', 'sessions'],
        readerSpec: { script: [{ docs: [] }] },
      });
      assert.equal(exitCode, EXIT.CONTAINER_DEFINITION);
    });
  });

  // ---- The evidence destination, RESERVED before the first send. ----------
  //
  // --evidence-out is a DIRECTORY, and the file the tool writes is DERIVED from
  // the run id. An unusable directory or a reused destination is a purely LOCAL
  // fact, refused BEFORE anything live. Each case asserts the two things that
  // matter together: the exit is usage-class, and the spawn was NEVER called.

  const REFUSED_DESTINATIONS = [
    [
      'a directory that does not exist',
      dir => path.join(dir, 'nope'),
      /evidence directory does not exist/,
    ],
    [
      'a destination that is a file, not a directory',
      dir => path.join(dir, 'a-file'),
      /not a directory/,
    ],
  ];

  for (const [label, pathFor, expectedMessage] of REFUSED_DESTINATIONS) {
    it(`refuses ${label} before a single message is sent`, async () => {
      await withTempDir(async dir => {
        if (label.includes('file')) await writeFile(pathFor(dir), 'x', 'utf8');
        const { exitCode, log, spawn, readerCalls } = await runMain({
          evidenceOut: pathFor(dir),
          readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
        });

        assert.equal(exitCode, EXIT.USAGE, 'nothing live happened, which is what 1 means');
        assert.equal(spawn.calls.length, 0, 'no message may be sent for an unrecordable run');
        assert.equal(readerCalls.length, 0, 'the refusal precedes even the reader construction');
        assert.match(log.all(), expectedMessage);
        assert.match(log.all(), /usage error/);
      });
    });
  }

  it('refuses an UNWRITABLE directory before a single message is sent', async () => {
    await withTempDir(async dir => {
      // The primitive probe (write + rename) is the only way to establish the
      // real write will be permitted: a stat cannot tell a read-only mount apart.
      const { exitCode, log, spawn } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
        fs: {
          writeFile: async () => {
            throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
          },
          rename: async () => {},
          rm: async () => {},
        },
      });

      assert.equal(exitCode, EXIT.USAGE);
      assert.equal(spawn.calls.length, 0);
      assert.match(log.all(), /cannot support the publication primitive/);
      assert.match(log.all(), /no synthetic document is in the container from this run/);
    });
  });

  it('refuses a REUSED destination — the derived file already exists — before the send', async () => {
    await withTempDir(async dir => {
      // The run's file name is derived from its id, so a file already at that name
      // is a genuinely reused destination. Its bytes are load-bearing evidence of
      // an earlier run whose documents are still in the container, and this run
      // does not add three more before refusing. Evidence is immutable and
      // per-run: there is no flag that replaces it.
      const derived = evidenceFileIn(dir);
      await writeFile(derived, '{"an":"earlier run"}\n', 'utf8');

      const { exitCode, log, spawn } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });

      assert.equal(exitCode, EXIT.USAGE);
      assert.equal(spawn.calls.length, 0, 'no documents were added to the ones that file records');
      assert.match(log.all(), /already exists/);
      assert.match(log.all(), /Nothing has been sent for this run/);
      assert.equal(await readFile(derived, 'utf8'), '{"an":"earlier run"}\n');
    });
  });

  it('reports the reserved per-run destination', async () => {
    await withTempDir(async dir => {
      const { log } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });
      assert.match(log.all(), /evidence destination reserved for run/);
      assert.match(log.all(), /per-run, immutable/);
    });
  });

  // ---- The evidence write itself failing, AFTER the send. -----------------
  //
  // The reservation above runs before the send; this is the backstop after it.
  // A disk that fills, a volume that unmounts or a permission that changes
  // between the reservation and the publication all land here, after the
  // documents exist. The live container has changed and nothing recorded it:
  // that is EVIDENCE_UNRECORDED, and specifically NOT usage.
  //
  // The reservation (directory stat, primitive probe, exclusive create) uses the
  // real filesystem and succeeds; only the record PUBLICATION — the rename of the
  // per-run partial onto the reserved path — fails.
  const failingWriteFs = () => ({
    rename: async (from, to) => {
      if (from.endsWith('.probe-src') || to.endsWith('.probe-dst')) return realRename(from, to);
      throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
    },
  });

  const noPartialLeft = async dir =>
    assert.equal(
      (await readdir(dir)).filter(name => name.endsWith(PARTIAL_SUFFIX)).length,
      0,
      'no partial artifact is left behind'
    );

  it('a CONFIRMED run whose evidence write fails exits EVIDENCE_UNRECORDED, never USAGE', async () => {
    await withTempDir(async dir => {
      const { exitCode, log } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
        fs: failingWriteFs(),
      });

      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      assert.notEqual(exitCode, EXIT.USAGE, 'this must never read as "nothing live happened"');
      assert.notEqual(exitCode, EXIT.OK);

      const output = log.all();
      assert.match(output, /EVIDENCE NOT RECORDED/);
      assert.match(output, /ARE in/, 'a confirmed run knows the documents exist');
      assert.match(output, /RECORD THESE IDS BY HAND/);
      assert.ok(output.includes(RUN_ID));
      for (const doc of deliveredDocuments()) {
        assert.ok(output.includes(doc.id), `the output must name ${doc.id}`);
      }
      assert.match(output, /evidence unrecorded/, 'the exit label is reported');
      await noPartialLeft(dir);
    });
  });

  it('an evidence write that fails on an UNCONFIRMED run is never swallowed', async () => {
    await withTempDir(async dir => {
      const { exitCode, log, spawn } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }], fallback: { docs: [] } },
        fs: failingWriteFs(),
      });

      assert.equal(spawn.calls.length, MESSAGES_PER_RUN, 'the send did happen');
      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);

      const output = log.all();
      assert.match(output, /EVIDENCE NOT RECORDED/);
      assert.match(output, /MAY BE in/, 'an unconfirmed run cannot claim the documents exist');
      assert.match(output, /confirmation timeout/);
      // On a timeout nothing was observed, so the output names the SENT ids — the
      // sender's Body.id, from the ledger — not the Cosmos root ids.
      for (const doc of deliveredDocuments()) {
        const sentId = doc[ENVELOPE_BODY_FIELD].id;
        assert.ok(output.includes(sentId), `the output must name the sent id ${sentId}`);
      }
    });
  });

  it('a record that cannot even be BUILT after a send exits EVIDENCE_UNRECORDED, not USAGE', async () => {
    await withTempDir(async dir => {
      const renamed = deliveredDocuments().map((doc, index) => ({
        ...doc,
        id: `${'A'.repeat(44)}${index}`,
      }));
      const { exitCode, log } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }, { docs: renamed }] },
      });

      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      assert.notEqual(exitCode, EXIT.USAGE);
      const output = log.all();
      assert.match(output, /EVIDENCE NOT RECORDED/);
      assert.match(output, /credential-shape risk/, 'the reason for the refusal is reported');
      await noPartialLeft(dir);
    });
  });

  it('a partial send whose evidence write ALSO fails exits EVIDENCE_UNRECORDED', async () => {
    await withTempDir(async dir => {
      const { exitCode, log } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }] },
        spawnSpec: { script: [{ code: 0 }, { code: 1 }] },
        fs: failingWriteFs(),
      });

      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      const output = log.all();
      assert.match(output, /EVIDENCE NOT RECORDED/);
      assert.match(output, /MAY BE in/);
      assert.ok(output.includes(`${RUN_ID}-1`), 'the id that landed must be named');
    });
  });

  // The invariant the four fixes above share, asserted across EVERY outcome
  // rather than once per fix.
  //
  // Each case below has already handed MESSAGES_PER_RUN documents to IoT Hub by
  // the time it fails, so each has changed the live system. The individual tests
  // above pin the exit CODE each one reports; what they do not pin — on four of
  // the five — is that the documents it caused to exist were RECORDED. That gap
  // is how the swallowed-write defect (fix 3) got in: the behaviour was right on
  // the confirmed path and absent on the unconfirmed one, and no test held the
  // difference. MG-53 halts on a source document its recorded set does not
  // account for and cannot tell one from the unknown writer that halt exists to
  // catch, so "the run failed" is never a licence to discard the ids.
  //
  // The paired negative assertion matters as much: a record written on a failure
  // path must never be readable as proof. confirmed stays false and exitCode
  // stays nonzero, so a downstream reader cannot mistake an accounting artifact
  // for a traversal.
  const POST_SEND_FAILURES = [
    [
      'a 401 during the confirmation',
      { script: [{ docs: [] }, { error: authError() }] },
      EXIT.AUTH,
    ],
    [
      'a 403 during the confirmation',
      { script: [{ docs: [] }, { error: forbiddenError() }] },
      EXIT.AUTH,
    ],
    [
      'a transport failure with retries exhausted',
      { script: [{ docs: [] }], fallback: { error: transportError() } },
      EXIT.TRANSPORT,
    ],
    ['the bound elapsing with nothing found', { script: [{ docs: [] }] }, EXIT.TIMEOUT],
  ];

  for (const [label, readerSpec, expected] of POST_SEND_FAILURES) {
    it(`${label} still RECORDS the documents it put in the container`, async () => {
      await withTempDir(async dir => {
        const evidenceOut = dir;
        const { exitCode, spawn } = await runMain({ evidenceOut, readerSpec });

        assert.equal(exitCode, expected);
        assert.equal(spawn.calls.length, MESSAGES_PER_RUN, 'the documents really were sent');

        const record = JSON.parse(await readFile(evidenceFileIn(evidenceOut), 'utf8'));
        assert.equal(
          record.requestedIds.length,
          MESSAGES_PER_RUN,
          'every id this run caused to exist is accounted for'
        );
        assert.equal(record.confirmed, false, 'a failure record is never readable as proof');
        assert.equal(record.exitCode, expected);
        assert.ok(record.findings.some(f => f.kind === 'unconfirmed-run'));
      });
    });
  }

  it('a marker violation records the run rather than discarding it', async () => {
    await withTempDir(async dir => {
      // A document reached the container carrying no marker. That is a defect in
      // the sender, and it is also three documents in the live container: the
      // exit code reports the defect, the artifact accounts for the documents.
      const unmarked = deliveredDocuments().map(doc => {
        const copy = { ...doc, [ENVELOPE_BODY_FIELD]: { ...doc[ENVELOPE_BODY_FIELD] } };
        delete copy[ENVELOPE_BODY_FIELD][SYNTHETIC_MARKER_FIELD];
        return copy;
      });
      const evidenceOut = dir;
      const { exitCode } = await runMain({
        evidenceOut,
        readerSpec: { script: [{ docs: [] }, { docs: unmarked }] },
      });

      assert.equal(exitCode, EXIT.MARKER_VIOLATION);
      const record = JSON.parse(await readFile(evidenceFileIn(evidenceOut), 'utf8'));
      assert.equal(record.requestedIds.length, MESSAGES_PER_RUN);
      assert.equal(record.confirmed, false);
      assert.equal(record.exitCode, EXIT.MARKER_VIOLATION);
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

  // The temporary Cosmos data-plane grant is a DESTRUCTIVE step on shared live
  // infrastructure when it is undone: the operator's principal may already hold
  // a Data Reader assignment somebody else's work depends on, and a
  // list-and-match removal can delete THAT one instead of the one this run
  // created. So the instructions must capture the assignment id at creation and
  // remove exactly it — and must say what to do when the id is not available,
  // which is stop, not guess.
  it('--help removes the temporary role assignment BY ID and refuses to guess', async () => {
    const log = recordingLog();
    assert.equal(await main({ argv: ['--help'], log }), EXIT.OK);
    const help = log.all();
    assert.match(help, /role assignment create/);
    assert.match(help, /--query id -o tsv/, 'the assignment id must be captured at creation');
    assert.match(help, /role assignment delete/, 'removal is a documented step, not cleanup');
    assert.match(help, /--role-assignment-id/, 'the removal targets the id, not a name match');
    assert.match(help, /NEVER BY A NAME OR PRINCIPAL MATCH/);
    assert.match(help, /STOP and report rather than guessing/);
  });
});

// ===========================================================================
// THE EVIDENCE-WRITE INTEGRITY CONTRACT, under per-run ownership.
//
// The evidence record is the artifact MG-53 and MG-54 read as a PROGRAM INPUT to
// decide whether to halt a migration. Every run exclusively owns one destination:
// --evidence-out is a DIRECTORY and the file name is DERIVED from the run id, so
// two runs can never name the same file and there is nothing to coordinate. These
// tests, driven through main(), pin that the CLI reserves before the send, that a
// stat error is never read as an absence, and that no run touches another's file.
// ===========================================================================

describe('the evidence-write integrity contract', () => {
  const CONFIRMED_READS = runId => ({
    script: [{ docs: [] }, { docs: deliveredDocuments(runId) }],
  });

  const UUID_A = '00000000-0000-4000-8000-0000000000aa';
  const UUID_B = '00000000-0000-4000-8000-0000000000bb';
  const RUN_A = newRunId(() => UUID_A);
  const RUN_B = newRunId(() => UUID_B);

  // A STAT ERROR IS NOT AN ABSENCE. Only ENOENT means "not there"; every other
  // stat failure is a refusal, before the send, with nothing live. Reading an
  // unreadable answer as an absence is the MG-66 conflation.
  it('refuses a directory whose state cannot be READ before sending anything', async () => {
    await withTempDir(async dir => {
      const { exitCode, log, spawn, readerCalls } = await runMain({
        evidenceOut: dir,
        readerSpec: CONFIRMED_READS(),
        fs: {
          stat: async target =>
            target === dir
              ? Promise.reject(Object.assign(new Error('EIO'), { code: 'EIO' }))
              : realStat(target),
        },
      });

      assert.equal(exitCode, EXIT.USAGE, 'nothing live happened, which is what 1 means');
      assert.equal(spawn.calls.length, 0, 'no message may be sent onto an unreadable destination');
      assert.equal(readerCalls.length, 0);
      assert.match(log.all(), /cannot determine whether/);
      assert.match(log.all(), /not assumed to be free/);
    });
  });

  // A TEMP PATH IS PER RUN. Two runs sharing --evidence-out derive different file
  // names, so they cannot collide on a partial — the wrong-record-under-the-right
  // -name failure the shared-file model risked cannot arise.
  it('names its temp file for the RUN, so two runs cannot collide on one partial', () => {
    const a = partialPathFor(path.join('/tmp/mg67', evidenceFileName(RUN_A)), RUN_A);
    const b = partialPathFor(path.join('/tmp/mg67', evidenceFileName(RUN_B)), RUN_B);
    assert.notEqual(a, b, 'two runs must not share one partial file');
    assert.ok(a.includes(RUN_A) && b.includes(RUN_B), 'each partial names the run that owns it');
  });

  it('two runs sharing one --evidence-out directory own two independent files', async () => {
    await withTempDir(async dir => {
      const a = await runMain({
        evidenceOut: dir,
        uuid: () => UUID_A,
        readerSpec: CONFIRMED_READS(RUN_A),
      });
      const b = await runMain({
        evidenceOut: dir,
        uuid: () => UUID_B,
        readerSpec: CONFIRMED_READS(RUN_B),
      });

      assert.equal(a.exitCode, EXIT.OK);
      assert.equal(b.exitCode, EXIT.OK);

      const recA = JSON.parse(await readFile(evidenceFileIn(dir, RUN_A), 'utf8'));
      const recB = JSON.parse(await readFile(evidenceFileIn(dir, RUN_B), 'utf8'));
      assert.equal(recA.runId, RUN_A);
      assert.equal(recB.runId, RUN_B);
      // Neither file holds a fragment of the other run: no swap, no blend.
      assert.equal(JSON.stringify(recA).includes(RUN_B), false);
      assert.equal(JSON.stringify(recB).includes(RUN_A), false);
      assert.deepEqual(
        (await readdir(dir)).sort(),
        [evidenceFileName(RUN_A), evidenceFileName(RUN_B)].sort(),
        'two runs, two files, and no partial or probe debris'
      );
    });
  });
});

// ===========================================================================
// THE EVIDENCE-EMISSION CONTRACT.
//
// The tests above pin the exit CODE of each outcome one at a time. This suite
// pins the property they share, across EVERY terminal outcome the tool can
// produce at once — because the defect it answers was never one path. It was
// the same sentence on five paths ("a later error discards ids the tool already
// knew"), each individually repairable where it appeared, which is the signature
// of a missing contract rather than of five bugs. A per-path test leaves the
// sixth path to whoever adds it; this table does not.
//
// For each outcome: a record EXISTS whenever anything was attempted, and its
// four id sets are individually correct.
//
//   requested  attempted — never an id for a message the run never got to.
//   accepted   az reported success.
//   ambiguous  az reported failure, acceptance UNKNOWN. Never "not written".
//   observed   read back out of Cosmos, and never discarded by a later abort.
// ===========================================================================

describe('the evidence-emission contract holds on every terminal outcome', () => {
  const unmarkedDocuments = () =>
    deliveredDocuments().map(doc => {
      const copy = { ...doc, [ENVELOPE_BODY_FIELD]: { ...doc[ENVELOPE_BODY_FIELD] } };
      delete copy[ENVELOPE_BODY_FIELD][SYNTHETIC_MARKER_FIELD];
      return copy;
    });

  // Every outcome this tool can reach that ATTEMPTED a send. The four counts are
  // spelled out per case rather than derived, so a change in behaviour has to be
  // argued for in this table instead of quietly absorbed by a helper.
  const OUTCOMES = [
    {
      label: 'confirmed',
      readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      exit: EXIT.OK,
      sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 3 },
      uncertain: false,
    },
    {
      label: 'az fails on message 1 of 3',
      readerSpec: { script: [{ docs: [] }] },
      spawnSpec: { script: [{ code: 1, stderr: LEAKY_AZ_STDERR }] },
      exit: EXIT.SEND_FAILURE,
      // ONE attempted, of unknown acceptance. Not "nothing was written".
      sets: { requested: 1, accepted: 0, ambiguous: 1, observed: 0 },
    },
    {
      label: 'az fails on message 2 of 3',
      readerSpec: { script: [{ docs: [] }] },
      spawnSpec: { script: [{ code: 0 }, { code: 1 }] },
      exit: EXIT.SEND_FAILURE,
      sets: { requested: 2, accepted: 1, ambiguous: 1, observed: 0 },
    },
    {
      label: 'the spawn itself fails',
      readerSpec: { script: [{ docs: [] }] },
      spawn: async () => {
        throw Object.assign(new Error('spawn az ENOENT'), { code: 'ENOENT' });
      },
      exit: EXIT.SEND_FAILURE,
      sets: { requested: 1, accepted: 0, ambiguous: 1, observed: 0 },
    },
    {
      label: 'the confirmation times out',
      readerSpec: { script: [{ docs: [] }], fallback: { docs: [] } },
      exit: EXIT.TIMEOUT,
      sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 0 },
    },
    {
      label: 'a 401 aborts the confirmation',
      readerSpec: { script: [{ docs: [] }, { error: authError() }] },
      exit: EXIT.AUTH,
      sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 0 },
    },
    {
      // THE CASE THE CONTRACT EXISTS FOR. Two documents are read back, and THEN
      // the run aborts on a 403. Once an id has been observed it is never
      // discarded by a subsequent failure — the auth abort changes the outcome,
      // not the history.
      label: 'two documents are observed and THEN a 403 aborts the run',
      readerSpec: {
        script: [
          { docs: [] },
          { docs: deliveredDocuments().slice(0, 2) },
          { error: forbiddenError() },
        ],
      },
      exit: EXIT.AUTH,
      sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 2 },
    },
    {
      label: 'a transport failure exhausts its retries',
      readerSpec: { script: [{ docs: [] }], fallback: { error: transportError() } },
      exit: EXIT.TRANSPORT,
      sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 0 },
    },
    {
      label: 'a document comes back without the marker',
      readerSpec: { script: [{ docs: [] }, { docs: unmarkedDocuments() }] },
      exit: EXIT.MARKER_VIOLATION,
      // Observed stays EMPTY: an unmarked document is not one of this run's, and
      // counting it would tell MG-53 that a document it must halt on is
      // accounted for.
      sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 0 },
    },
    {
      label: 'an incomplete read-back at the bound',
      readerSpec: { script: [{ docs: [] }], fallback: { docs: deliveredDocuments().slice(0, 2) } },
      exit: EXIT.AMBIGUOUS,
      sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 2 },
    },
    {
      label: 'the documents land outside the expected partition',
      readerSpec: {
        script: [
          { docs: [] },
          { docs: [] },
          { docs: [] },
          { docs: deliveredDocuments(RUN_ID, { deviceId: 'some-other-partition' }) },
        ],
      },
      timeoutMs: 1,
      pollIntervalMs: 1,
      exit: EXIT.UNEXPECTED_PARTITION,
      sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 3 },
    },
  ];

  for (const outcome of OUTCOMES) {
    it(`${outcome.label}: a record exists and its four id sets are correct`, async () => {
      await withTempDir(async dir => {
        const evidenceOut = dir;
        const { exitCode } = await runMain({
          evidenceOut,
          readerSpec: outcome.readerSpec,
          spawnSpec: outcome.spawnSpec ?? {},
          ...(outcome.spawn ? { spawn: outcome.spawn } : {}),
          ...(outcome.timeoutMs ? { timeoutMs: outcome.timeoutMs } : {}),
          ...(outcome.pollIntervalMs ? { pollIntervalMs: outcome.pollIntervalMs } : {}),
        });
        assert.equal(exitCode, outcome.exit, 'the outcome is the one this case set up');

        // 1. THE RECORD EXISTS. Every one of these attempted a send.
        const record = JSON.parse(await readFile(evidenceFileIn(evidenceOut), 'utf8'));
        assert.equal(record.attempted, true);
        assert.equal(record.exitCode, outcome.exit);

        // 2. THE FOUR SETS, INDIVIDUALLY.
        assert.equal(record.requestedCount, outcome.sets.requested, 'requestedIds');
        assert.equal(record.acceptedCount, outcome.sets.accepted, 'acceptedIds');
        assert.equal(record.ambiguousCount, outcome.sets.ambiguous, 'ambiguousIds');
        assert.equal(record.observedCount, outcome.sets.observed, 'observedIds');
        for (const key of ['requestedIds', 'acceptedIds', 'ambiguousIds', 'observedIds']) {
          assert.ok(Array.isArray(record[key]), `${key} must be a list`);
          assert.equal(record[key].length, new Set(record[key]).size, `${key} must not repeat`);
        }
        // Everything that is or may be in the container, unioned for MG-53.
        assert.equal(
          record.accountableCount,
          new Set([...record.observedIds, ...record.acceptedIds, ...record.ambiguousIds]).size
        );

        // 3. CERTAINTY IS NEVER OVERCLAIMED.
        assert.equal(record.uncertain, outcome.uncertain ?? true);
        assert.equal(record.confirmed, outcome.exit === EXIT.OK);

        // 4. DIVERGENCE IS WITNESSED, NEVER INFERRED (MG-73). The platform
        // assigns the Cosmos root id, so ANY run that OBSERVED a document
        // witnesses divergence — while a run that observed nothing never infers
        // one from a shortfall.
        assert.equal(record.idDivergence, outcome.sets.observed > 0);
      });
    });
  }

  // The negative half of rule 1, stated as its own test because it is the
  // sentence the contract was written to delete: an error is never reported as a
  // known absence. This is the MG-66 conflation on the WRITE side.
  it('never asserts that nothing was written, on any outcome that attempted a send', async () => {
    for (const outcome of OUTCOMES) {
      await withTempDir(async dir => {
        const { log } = await runMain({
          evidenceOut: dir,
          readerSpec: outcome.readerSpec,
          spawnSpec: outcome.spawnSpec ?? {},
          ...(outcome.spawn ? { spawn: outcome.spawn } : {}),
          ...(outcome.timeoutMs ? { timeoutMs: outcome.timeoutMs } : {}),
          ...(outcome.pollIntervalMs ? { pollIntervalMs: outcome.pollIntervalMs } : {}),
        });
        const output = log.all();
        for (const claim of [
          /nothing was written/i,
          /no message had been accepted/i,
          /no document (was|were) written/i,
        ]) {
          assert.equal(claim.test(output), false, `${outcome.label} claimed ${claim}`);
        }
        assertNoPlantedSecret(output, `${outcome.label} output`);
      });
    }
  });

  // The one case that may exit without a record: a run that refused BEFORE its
  // first attempt. Here "nothing was written" is a fact about the run rather
  // than a guess about the hub, and an artifact would be a claim about a
  // container this run never touched.
  const PRE_ATTEMPT_REFUSALS = [
    [
      'a refused pre-send read',
      { readerSpec: { script: [{ error: forbiddenError() }] } },
      EXIT.AUTH,
    ],
    [
      'an unmeasurable container',
      { definition: 'container-show-malformed.json', readerSpec: { script: [{ docs: [] }] } },
      EXIT.CONTAINER_DEFINITION,
    ],
  ];

  for (const [label, options, expected] of PRE_ATTEMPT_REFUSALS) {
    it(`${label} exits without a record, having attempted nothing`, async () => {
      await withTempDir(async dir => {
        const { exitCode, spawn } = await runMain({
          evidenceOut: dir,
          ...options,
        });
        assert.equal(exitCode, expected);
        assert.equal(spawn.calls.length, 0, 'nothing was attempted');
        assert.deepEqual(await readdir(dir), [], 'so there is nothing to account for');
      });
    });
  }

  // Observation survives the write failure too: the ids the read-back saw are on
  // stderr as "ARE in", and the ones only sent are "MAY BE in". Both are named,
  // and neither is dropped because the other exists.
  it('an abort after a partial observation still names the observed ids on the unrecorded path', async () => {
    await withTempDir(async dir => {
      const { exitCode, log } = await runMain({
        evidenceOut: dir,
        readerSpec: {
          script: [
            { docs: [] },
            { docs: deliveredDocuments().slice(0, 2) },
            { error: forbiddenError() },
          ],
        },
        // The reservation succeeds (real filesystem) and then the record
        // PUBLICATION fails, so this exercises the after-the-send backstop rather
        // than the reservation that precedes it.
        fs: {
          rename: async (from, to) => {
            if (from.endsWith('.probe-src') || to.endsWith('.probe-dst')) {
              return realRename(from, to);
            }
            throw Object.assign(new Error('ENOSPC'), { code: 'ENOSPC' });
          },
        },
      });

      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      const output = log.all();
      // The two OBSERVED documents are named by their Cosmos root ids (they ARE
      // in the container); the third, sent but never observed, is named by its
      // SENT id (it MAY BE in the container). (MG-73.)
      const [seen1, seen2] = observedRootIds();
      const unseen = deliveredDocuments()[2][ENVELOPE_BODY_FIELD].id;
      assert.match(output, /ARE in/);
      assert.match(output, /MAY BE in/);
      for (const id of [seen1, seen2, unseen]) {
        assert.ok(output.includes(id), `the output must name ${id}`);
      }
    });
  });
});

// ===========================================================================
// A throw in the SETTLEMENT — after the live effect — never reports exit 1.
//
// Exit 1 is USAGE: "bad arguments, nothing live happened". settleRun() runs
// after the send, and a throw there used to escape main() as an unhandled
// rejection, which exits 1. That is the worst answer this tool can give: it
// tells an operator nothing happened while synthetic documents sit in the
// source container, and MG-53 halts on exactly those unrecorded documents.
//
// Every case here asserts BY EXIT CODE, and drives the throw through the log —
// the channel the settlement reports on, and the one that really does break in
// the field (`send-fixture.mjs ... | head -1` closes stdout).
// ===========================================================================

describe('a settlement that throws after live effect never exits 1', () => {
  const confirmedRun = { script: [{ docs: [] }, { docs: deliveredDocuments() }] };

  it('a confirmed run whose final line throws exits EVIDENCE_UNRECORDED, not 0 and not 1', async () => {
    await withTempDir(async dir => {
      const evidenceOut = dir;
      const log = throwingLog({ armOn: line => line.includes('CONFIRMED —') });
      const { exitCode } = await runMain({ evidenceOut, readerSpec: confirmedRun, log });

      // The record reached disk — the throw is strictly after it — and the tool
      // STILL refuses to report success, because the settlement that would have
      // established success did not finish. Fail-closed costs the operator a
      // look at a file; the other direction loses the ids.
      assert.deepEqual(await readdir(dir), [evidenceFileName(RUN_ID)]);
      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      assert.notEqual(exitCode, EXIT.USAGE, 'never "nothing live happened"');
      assert.notEqual(exitCode, EXIT.OK, 'an unfinished settlement confirms nothing');

      const output = log.all();
      assert.match(output, /RECORD THESE IDS BY HAND/);
      assert.match(output, /UNESTABLISHED/);
      assert.match(output, new RegExp(`device ${FIXTURE_DEVICE_ID} on hub ${HUB}`));
      assert.match(output, /exit 10 \(evidence unrecorded/);
    });
  });

  it('a send failure whose reporting breaks at the first settlement line exits EVIDENCE_UNRECORDED and names the ids', async () => {
    await withTempDir(async dir => {
      // The log dies on the settlement's very first line and stays dead. Nothing
      // downstream of it can report anything, so the exit code is the only
      // channel left — and it still has to be honest about a live send.
      const log = throwingLog({ armOn: line => line.includes("send-d2c-message' exited") });
      const { exitCode } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }] },
        spawnSpec: { script: [{ code: 1, stderr: LEAKY_AZ_STDERR }] },
        log,
      });

      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      assert.notEqual(exitCode, EXIT.USAGE);
      // Nothing was recorded — the throw preceded the write — which is exactly
      // what the code says. One document is of unknown fate, and it is named.
      assert.deepEqual(await readdir(dir), []);
      const output = log.all();
      // A send failure observed nothing, so the id named is the SENT id — the
      // sender's Body.id of the one attempted message, not a Cosmos root id.
      const firstId = deliveredDocuments()[0][ENVELOPE_BODY_FIELD].id;
      assert.ok(output.includes(firstId), 'the unrecorded id must be named');
      assert.equal(/nothing was written/i.test(output), false);
      assertNoPlantedSecret(output, 'the last-resort path');
    });
  });

  it('the handler discriminates: a run that attempted NOTHING keeps its own code', async () => {
    await withTempDir(async dir => {
      // A refused pre-send read. The ledger exists (a run id was minted) but no
      // message was attempted, so nothing is live: AUTH stands, and inflating it
      // to "documents may be live" would be its own false claim.
      const { exitCode } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ error: forbiddenError() }] },
        log: throwingLog({ armOn: line => line.includes('pre-send read') }),
      });
      assert.equal(exitCode, EXIT.AUTH);
      assert.notEqual(exitCode, EXIT.EVIDENCE_UNRECORDED, 'no document may be live');
      assert.deepEqual(await readdir(dir), []);
    });
  });

  it('a usage refusal whose reporting throws still exits 1 — nothing live happened, which is what 1 means', async () => {
    const { exitCode } = await runMain({
      argv: ['--evidence-out', ''],
      readerSpec: { script: [{ docs: [] }] },
      log: throwingLog(),
    });
    assert.equal(exitCode, EXIT.USAGE);
  });

  it('main() resolves rather than rejecting, whatever the settlement does', async () => {
    await assert.doesNotReject(() =>
      runMain({ readerSpec: confirmedRun, log: throwingLog(), evidenceOut: '/proc/nope/e.json' })
    );
  });
});

// ===========================================================================
// THE EXIT FUNNEL CANNOT DEFAULT TO 0.
//
// settleRun() used to open with
//   `confirmation ? confirmation.exitCode : (failure?.exitCode ?? EXIT.OK)`
// so a run holding NEITHER a confirmation nor a failure exited 0. Every path
// main() writes today produces one of the two, which is exactly why that
// default was invisible: it was reachable only from a state the code did not
// anticipate, and a state nobody anticipated is the one the tool knows least
// about. Exit 0 is this tool's single claim — a specific, newly identified,
// marker-carrying document was READ BACK OUT of the destination container — and
// it may not be made by fall-through.
//
// So these tests go at the funnel DIRECTLY rather than through main(): the
// point is precisely that main() cannot be made to produce these states today,
// and the guard has to hold for the edit that makes it able to. Each case
// asserts BY EXIT CODE.
// ===========================================================================

describe('exit 0 requires positive confirmation, never a fall-through', () => {
  const CFG = Object.freeze({
    device: FIXTURE_DEVICE_ID,
    hub: HUB,
    account: ACCOUNT,
    database: DATABASE,
    container: CONTAINER,
    evidenceOut: 'unused-dir',
    timeoutMs: 1000,
    pollIntervalMs: 250,
  });

  // No ledger: nothing was attempted, so nothing is owed a record and the code
  // is the only thing under test.
  const settle = ({ confirmation = null, failure = null, log }) =>
    settleRun({
      cfg: CFG,
      definition: null,
      ledger: null,
      confirmation,
      failure,
      device: CFG.device,
      hub: CFG.hub,
      log,
      now: () => RUN_MILLIS,
      fs: undefined,
    });

  // Every shape that is NOT "a confirmation carrying exit 0 and confirmed:true".
  // The list is deliberately broader than anything main() builds — half of these
  // are states only a future edit or a hand-rolled caller can produce, and those
  // are the ones the old default let through.
  const NOT_A_CONFIRMED_RUN = [
    ['neither a confirmation nor a failure', {}],
    [
      'a confirmation carrying exit 0 but confirmed:false',
      { confirmation: { exitCode: EXIT.OK, confirmed: false } },
    ],
    [
      'a confirmation carrying exit 0 with confirmed absent',
      { confirmation: { exitCode: EXIT.OK } },
    ],
    [
      'a confirmation carrying exit 0 with confirmed:"true" (a string)',
      { confirmation: { exitCode: EXIT.OK, confirmed: 'true' } },
    ],
    [
      'a confirmation carrying an exit code outside the vocabulary',
      { confirmation: { exitCode: 99, confirmed: false } },
    ],
    ['a confirmation carrying no exit code at all', { confirmation: { confirmed: true } }],
    [
      'a confirmation claiming confirmed:true alongside a nonzero code',
      { confirmation: { exitCode: EXIT.TIMEOUT, confirmed: true } },
    ],
    ['a confirmation that is not an object', { confirmation: 'confirmed!' }],
    ['a confirmation that is an array', { confirmation: [] }],
    [
      'a failure carrying exit code 0',
      { failure: new FixtureError(EXIT.OK, 'a failure that claims success') },
    ],
    [
      'a failure carrying an exit code outside the vocabulary',
      { failure: new FixtureError(42, 'off-vocabulary') },
    ],
  ];

  for (const [label, state] of NOT_A_CONFIRMED_RUN) {
    it(`${label} cannot reach exit 0`, async () => {
      const log = recordingLog();
      const exitCode = await settle({ ...state, log });

      assert.notEqual(
        exitCode,
        EXIT.OK,
        'exit 0 states a document was read back; this established none'
      );
      assert.ok(exitCode > 0, `expected a nonzero code, got ${exitCode}`);
      // Not merely nonzero: it is a code from this tool's own vocabulary, so an
      // operator scripting against it reads something meaningful.
      assert.ok(
        Object.values(EXIT).includes(exitCode),
        `${exitCode} is not in the tool's exit vocabulary`
      );
      // The failure output still names the device, the hub and the exit label on
      // this path as on every other (HR1's reporting contract).
      const output = log.all();
      assert.match(output, new RegExp(`device ${FIXTURE_DEVICE_ID} on hub ${HUB}`));
      assert.match(output, /exit \d+ \(/);
      assert.equal(/CONFIRMED —/.test(output), false, 'nothing here may read as a traversal');
      assertNoPlantedSecret(output, `${label} output`);
    });
  }

  // The unanticipated states are additionally REPORTED, not merely refused. An
  // unanticipated state is a defect in this tool, and an operator who sees only
  // a bare exit code cannot report one.
  it('says what it found when the state is one the code did not anticipate', async () => {
    const log = recordingLog();
    const exitCode = await settle({ confirmation: { exitCode: EXIT.OK, confirmed: false }, log });
    assert.equal(exitCode, EXIT.AMBIGUOUS, 'the unanticipated-state code');
    assert.match(log.all(), /without confirmed:true/);
    assert.match(log.all(), /rather than 0/);
  });

  // The positive control. Without it the suite above would pass just as well
  // against a funnel that never returns 0 at all, which would be a different
  // defect and not an improvement.
  it('a genuine confirmation still exits 0 and says what was proven', async () => {
    const log = recordingLog();
    const exitCode = await settle({
      confirmation: {
        exitCode: EXIT.OK,
        confirmed: true,
        observedCount: MESSAGES_PER_RUN,
        reason: 'read back',
      },
      log,
    });
    assert.equal(exitCode, EXIT.OK);
    assert.match(log.all(), /CONFIRMED —/);
    assert.match(log.all(), new RegExp(`${DATABASE}/${CONTAINER}`));
  });

  // ...and end to end, so the two halves are known to agree: the one path that
  // really does read documents back out of the container is still the one path
  // that exits 0.
  it('and end to end, only a real read-back exits 0', async () => {
    await withTempDir(async dir => {
      const { exitCode } = await runMain({
        evidenceOut: dir,
        readerSpec: { script: [{ docs: [] }, { docs: deliveredDocuments() }] },
      });
      assert.equal(exitCode, EXIT.OK);
    });
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

  // The behavioural cases above prove the last-resort handler is REACHED today.
  // This proves it cannot be un-reached by a plausible edit: a bare
  // `return settleRun(...)` settles its promise outside the try, taking the
  // rejection with it, and the tests above would still pass while an unhandled
  // rejection exited 1 in production.
  it('settles inside the guard: no un-awaited settleRun, and the entry point catches', async () => {
    const code = stripComments(await readSource('./send-fixture.mjs'));
    assert.match(code, /return await settleRun\(/, 'settleRun must be awaited inside the try');
    assert.equal(
      /return settleRun\(/.test(code),
      false,
      'an un-awaited settleRun rejects outside the guard'
    );
    assert.match(code, /catch \(err\) \{\s*return lastResortExit\(/);
    assert.match(code, /process\.exitCode = EXIT\.AMBIGUOUS/, 'the entry point never falls to 1');
  });

  // The behavioural suite above proves the funnel refuses today's unanticipated
  // states. This proves the DEFAULT that produced them cannot come back by a
  // plausible edit: `?? EXIT.OK` and a ternary falling to EXIT.OK are the two
  // spellings that were actually there, and neither is legitimate anywhere in
  // this file — the only code path permitted to yield 0 goes through
  // resolveOutcomeCode.
  it('has no fall-through to EXIT.OK anywhere, in any spelling', async () => {
    const code = stripComments(await readSource('./send-fixture.mjs'));
    for (const pattern of [/\?\?\s*EXIT\.OK/, /:\s*EXIT\.OK\s*[;,)]/, /\|\|\s*EXIT\.OK/]) {
      assert.equal(
        pattern.test(code),
        false,
        `send-fixture.mjs defaults to success via ${pattern}`
      );
    }
    assert.match(code, /resolveOutcomeCode\(\{ confirmation, failure \}\)/);
    // ...and the redundant last-line re-check, which is what makes exit 0
    // impossible to manufacture in the gap between the resolution and the return.
    assert.match(code, /exitCode === EXIT\.OK && confirmation\?\.confirmed !== true/);
  });

  // The destination RESERVATION must sit BEFORE the send in the source, not
  // merely behave that way in the cases this suite happens to cover. A future
  // edit that moves it below sendMessages() reintroduces exactly the defect:
  // documents in the container, and only then a refusal to record them.
  it('reserves the evidence destination before it spawns anything', async () => {
    const code = stripComments(await readSource('./send-fixture.mjs'));
    const body = /export async function main\([\s\S]*$/.exec(code)?.[0] ?? '';
    assert.ok(body, 'main() not found');
    const reserveAt = body.indexOf('reserveEvidenceDestination(');
    const sendAt = body.indexOf('await sendMessages(');
    assert.ok(reserveAt !== -1, 'main() does not reserve the evidence destination');
    assert.ok(sendAt !== -1, 'main() does not send');
    assert.ok(
      reserveAt < sendAt,
      'the evidence destination must be reserved before any message is sent'
    );
    // The write publishes into the reserved destination after the send.
    assert.match(code, /writeEvidenceRecord\(/);
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
      /\.containers\.create/,
      /\.databases\.create/,
      /\.replace\(/,
      /\.delete\(/,
    ]) {
      assert.equal(pattern.test(code), false, `send-fixture.mjs matches ${pattern}`);
    }
    // `.item(id, pk).read()` is the point read (MG-73) — a READ, the only item
    // call allowed, and it must be paired with .read() and nothing mutating.
    assert.match(code, /\.item\([^)]*\)\s*\.read\(\)/);
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

// RF-2: the az send timeout must be a HARD bound. Node's own spawn `timeout`
// sends ONE SIGTERM and then waits on close forever, so an az child that ignores
// SIGTERM outlives the bound — and a tool whose whole contract is fail-closed
// must not be able to hang. realSpawn escalates to SIGKILL after a stated grace
// and reports the bound it actually enforced. These drive the REAL primitive with
// a real child; realSpawn is injected as a fake everywhere else in the suite.
describe('realSpawn enforces a HARD timeout (RF-2)', () => {
  // A child that traps SIGTERM and keeps running. Only SIGKILL — which it cannot
  // trap — ends it, so it hangs forever unless realSpawn escalates.
  const IGNORES_SIGTERM = "process.on('SIGTERM', () => {}); setInterval(() => {}, 1000);";

  it('escalates to SIGKILL when the child ignores SIGTERM, at the stated bound', async () => {
    const startedNs = process.hrtime.bigint();
    const result = await realSpawn(process.execPath, ['-e', IGNORES_SIGTERM], {
      timeoutMs: 60,
      killGraceMs: 120,
    });
    const elapsedMs = Number(process.hrtime.bigint() - startedNs) / 1e6;

    // The bound HELD: a SIGTERM-ignoring child did not outlive it.
    assert.equal(result.timedOut, true, 'the bound must be reported as reached');
    assert.equal(result.hardKilled, true, 'a SIGTERM-ignoring child must be SIGKILLed');
    assert.equal(result.signal, 'SIGKILL');
    // A killed child has a null exit code, reported as a distinct nonzero so it
    // never reads as success.
    assert.equal(result.code, 124);
    assert.equal(result.enforcedBoundMs, 180, 'reports the bound it actually enforces');
    // It returned near the hard bound, NOT never; generous ceiling for a slow CI.
    assert.ok(elapsedMs < 5000, `realSpawn returned in ${elapsedMs}ms; the bound did not hold`);
  });

  it('lets a well-behaved child exit on its own without timing out', async () => {
    const result = await realSpawn(process.execPath, ['-e', 'process.exit(0)'], {
      timeoutMs: 5000,
      killGraceMs: 5000,
    });
    assert.equal(result.code, 0);
    assert.equal(result.timedOut, false, 'a child that exits in time is not timed out');
    assert.equal(result.hardKilled, false);
    assert.equal(result.signal, null);
  });

  it('wires the default kill grace to KILL_GRACE_MS', async () => {
    assert.ok(Number.isInteger(KILL_GRACE_MS) && KILL_GRACE_MS > 0, 'a positive default grace');
    const result = await realSpawn(process.execPath, ['-e', 'process.exit(3)']);
    assert.equal(result.code, 3);
    assert.equal(result.timedOut, false);
    assert.equal(result.enforcedBoundMs, DEFAULT_SEND_TIMEOUT_MS + KILL_GRACE_MS);
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
        evidenceOut: dir,
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
