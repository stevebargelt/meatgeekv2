// MG-67 — the REAL-SDK tier for the iot-fixture sender.
//
// The only tests that belong in this file are the ones that need a real
// node_modules: they take createRealReader's DEFAULT import thunks, or they
// construct error instances from the installed @azure/identity and
// @azure/cosmos rather than hand-written stand-ins. Everything else in this
// directory runs against fake-azure.mjs and stays in the dependency-free tier.
//
// The split is not cosmetic, and it mirrors the one cosmos-export already
// established. The dependency-free tier runs in CI's validate-infrastructure
// job, which installs nothing and holds no credentials on purpose; a test that
// resolves @azure/cosmos cannot run there. But the real import is also the one
// thing that tier can never check — so deleting these would leave
// `import('@azure/identity')`, and every assumption this tool makes about the
// SDKs' shapes, unverified everywhere. Hence: same directory, separate file,
// separate CI step after `npm ci` (lint-and-test). Run via
// `run-tests.mjs --sdk`, which floors the counts so a rename cannot make this
// tier vacuously green.
//
// WHAT ONLY THIS TIER CAN PROVE. Six things, each of them a way the tool
// could be wrong while the whole fake tier stayed green:
//
//   1. The option bag createRealReader hands to CosmosClient is one the REAL
//      constructor accepts, and it carries a REAL DefaultAzureCredential and no
//      key material of any kind (HR1). The fake CosmosClient records whatever
//      it is given, so it cannot tell a well-formed bag from a rejected one,
//      and it cannot tell a real credential from a `{credentialKind: '...'}`
//      object literal.
//   2. fixture-core's IDENTITY_AUTH_ERRORS names match the error classes the
//      installed @azure/identity actually exports. That set is a list of
//      strings; a package bump that renamed one would turn "run az login" into
//      a TRANSPORT abort, and no fake could notice. Pinned here by constructing
//      each real class.
//   3. The real SDK error shapes classify the way the tool assumes — including
//      AggregateAuthenticationError, whose message inlines every inner
//      credential's message and is therefore a genuine multi-line leak vector
//      that a one-line fake error does not model (HR1 again).
//   4. THE EVIDENCE-EMISSION CONTRACT SURVIVES A REAL SDK FAILURE. A real error
//      raised AFTER the send — the read-back, not the pre-send gate — still
//      leaves the run RECORDED, with its four id sets individually correct and
//      its already-observed documents intact. That path is where the documents
//      are already in the live container, so it is the one where an unrecorded
//      run halts MG-53 indistinguishably from the unknown writer that halt
//      exists to catch. Section 5 below.
//   5. THE CREDENTIAL GUARD AND THE CONTRACT DO NOT FIGHT EACH OTHER. The
//      evidence record's guard is FAIL-CLOSED: a credential-shaped value
//      REFUSES the whole write. A real SDK error's text travels into the
//      record's `outcomeReason`, so a scrub that let a base64-shaped run
//      through would not leak — it would turn a run with live documents into an
//      UNRECORDED one, which is the worse of the two failures and the exact
//      outcome the contract exists to prevent. Only a real error produces the
//      text that tests that interaction; a hand-written one-line fake does not.
//   6. THE EXIT FUNNEL'S VOCABULARY AND classifyError AGREE ABOUT REAL ERRORS.
//      resolveOutcomeCode is fail-closed by construction: a code it does not
//      recognise becomes UNANTICIPATED rather than being trusted. That is the
//      right default, and it also means a classifier that answered with a code
//      outside the vocabulary would be SILENTLY DOWNGRADED — a real 403 exiting
//      as a correlation ambiguity, sending an operator to diagnose the route
//      when the answer was an RBAC grant. Whether the two agree can only be
//      checked against the real error classes, which is this tier's job.
//      Section 7 below.
//
// WHAT DELIBERATELY IS NOT HERE. The per-outcome sweep of the
// evidence-emission contract — every terminal outcome the tool can reach, its
// four id sets spelled out — lives in the dependency-free tier
// (send-fixture.test.mjs, "the evidence-emission contract holds on every
// terminal outcome"), because most of those outcomes involve no SDK at all and
// this tier must not grow a second copy that can drift from it. What is here is
// the slice reachable only THROUGH a real SDK error: the AUTH and TRANSPORT
// aborts, and the recording that has to survive them.
//
// Likewise the exit funnel's own fall-through cases — a run holding neither a
// confirmation nor a failure, a confirmation carrying exit 0 without
// confirmed:true — are the fake tier's ("exit 0 requires positive confirmation,
// never a fall-through"). They involve no SDK, and section 7 does not restate
// them; it asks the one question that needs the real packages, which is whether
// a REAL error can arrive at that funnel wearing a code the funnel does not
// know.
//
// NOTHING HERE MAY CONTACT AZURE. Constructing a client and constructing a
// credential are both offline; calling any client method is not, and is out of
// scope for this tier as much as for the other. No test below calls a client
// method, and no test below calls getToken().

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { PARTIAL_SUFFIX, PROBE_SUFFIX } from './evidence.mjs';
import {
  EXIT,
  FIXTURE_DEVICE_ID,
  FixtureError,
  MESSAGES_PER_RUN,
  RUN_ID_PARAMETER,
  SYNTHETIC_MARKER,
  UNANTICIPATED_OUTCOME_CODE,
  buildFixtureMessages,
  classifyError,
  exitLabel,
  isKnownExitCode,
  resolveOutcomeCode,
  toFixtureError,
} from './fixture-core.mjs';
import { createRealReader, endpointFor, main, preflight, settleRun } from './send-fixture.mjs';

// The real dev target from the brief. Nothing here reaches it; the names are
// here so a failure message reads like the run an operator would perform.
const ACCOUNT = 'mgv2-dev-f640e19ae7ab';
const DATABASE = 'meatgeek-v2-dev-db';
const CONTAINER = 'temperatures';
const ENDPOINT = endpointFor(ACCOUNT);
const RUN_ID = 'mg67-sdk-tier-run-id';

// ---------------------------------------------------------------------------
// Secrets that must never come back out.
//
// BUILT AT RUNTIME from self-describing plaintext rather than written down,
// following cosmos-export.sdk.test.mjs and this tool's own fake tier. HR1 says
// no credential is committed to the repository ANYWHERE, tests included, and a
// diff-wide grep for credential shapes is part of this ticket's acceptance — a
// hard-coded base64 blob would trip it and a reviewer would have to take "it is
// only a test value" on trust. Constructed, the file commits no such shape at
// all while the assertions still exercise the real one.
// ---------------------------------------------------------------------------
const PLANTED = Object.freeze({
  // 44+ unbroken base64 characters: the shape of an IoT device key.
  deviceKey: Buffer.from('mg67-sdk-tier-test-only-never-a-real-device-key').toString('base64'),
  accountKey: Buffer.from('mg67-sdk-tier-test-only-never-a-real-account-key').toString('base64'),
});

function assertNoPlantedSecret(text, context) {
  for (const [name, secret] of Object.entries(PLANTED)) {
    assert.equal(
      text.includes(secret),
      false,
      `${context}: the planted ${name} appeared in operator-facing output`
    );
  }
}

// Loaded once, through the same specifiers send-fixture.mjs uses. If either of
// these fails to resolve, every test in this file fails loudly — which is the
// point of the tier.
const cosmos = await import('@azure/cosmos');
const identity = await import('@azure/identity');

/**
 * The real @azure/cosmos module with CosmosClient subclassed so the constructed
 * instance and its option bag are observable.
 *
 * The REAL constructor still runs (`super(options)`), so this is not a fake
 * standing in for it: a bag the real SDK rejects throws here exactly as it
 * would in production. The subclass exists only to get a handle on what would
 * otherwise be swallowed by createRealReader's closure.
 */
function recordingCosmosModule(constructed) {
  return {
    ...cosmos,
    CosmosClient: class RecordingCosmosClient extends cosmos.CosmosClient {
      constructor(options) {
        super(options);
        constructed.push({ options, client: this });
      }
    },
  };
}

/** The real identity module with a DefaultAzureCredential that fails to construct. */
function failingIdentityModule(error) {
  return {
    ...identity,
    DefaultAzureCredential: class FailingDefaultAzureCredential {
      constructor() {
        throw error;
      }
    },
  };
}

/** A reader whose single query throws — the seam preflight() is injected with. */
const throwingReader = error => ({
  queryDocuments: async () => {
    throw error;
  },
});

async function refusal(fn, context) {
  try {
    await fn();
  } catch (err) {
    assert.ok(err instanceof FixtureError, `${context}: expected a FixtureError, got ${err?.name}`);
    return err;
  }
  return assert.fail(`${context}: expected a refusal, but the call returned`);
}

// ===========================================================================
// 1. The real SDKs resolve and construct offline.
// ===========================================================================

describe('MG-67 real Azure SDK wiring', () => {
  it("takes createRealReader's default import thunks and builds a reader with no overrides at all", async () => {
    // No loadCosmos, no loadIdentity: the dynamic imports inside
    // send-fixture.mjs are the ones under test. Construction contacts nothing.
    const reader = await createRealReader({
      endpoint: ENDPOINT,
      database: DATABASE,
      container: CONTAINER,
    });

    assert.equal(typeof reader.queryDocuments, 'function');
    // queryDocuments is deliberately NOT called: that would reach Azure.
    assert.deepEqual(Object.keys(reader), ['queryDocuments'], 'the reader seam grew a method');
  });

  it('constructs the real DefaultAzureCredential offline without requesting a token', async () => {
    const credential = new identity.DefaultAzureCredential();

    assert.equal(credential.constructor.name, 'DefaultAzureCredential');
    // A credential is a getToken provider; calling it is what would contact
    // Azure, so the shape is asserted and the call is not made.
    assert.equal(typeof credential.getToken, 'function');
  });
});

// ===========================================================================
// 2. HR1 — the read-back client is AAD-only, against the REAL constructor.
// ===========================================================================

describe('MG-67 the real CosmosClient is constructed AAD-only', () => {
  // Every property name that could carry, derive or stand in for key material.
  // Checked with `in`, not for falsiness: `key: undefined` present on the bag
  // is still a key-mode option bag, and an SDK bump that started honouring it
  // would be exactly the regression this list exists to catch.
  const FORBIDDEN_AUTH_OPTIONS = [
    'key',
    'masterKey',
    'connectionString',
    'resourceTokens',
    'tokenProvider',
    'permissionFeed',
  ];

  it('accepts the exact option bag this tool builds, carrying a real DefaultAzureCredential and no key', async () => {
    const constructed = [];
    const reader = await createRealReader({
      endpoint: ENDPOINT,
      database: DATABASE,
      container: CONTAINER,
      loadCosmos: async () => recordingCosmosModule(constructed),
      // loadIdentity is deliberately left at its default: the credential in the
      // bag below is a genuine DefaultAzureCredential, not a stand-in.
    });

    assert.equal(typeof reader.queryDocuments, 'function');
    assert.equal(constructed.length, 1, 'expected exactly one client construction');
    const [{ options, client }] = constructed;

    // The real constructor ran and produced a real CosmosClient.
    assert.ok(client instanceof cosmos.CosmosClient);
    assert.equal(options.endpoint, ENDPOINT);
    assert.ok(
      options.aadCredentials instanceof identity.DefaultAzureCredential,
      'aadCredentials is not a real DefaultAzureCredential'
    );

    for (const forbidden of FORBIDDEN_AUTH_OPTIONS) {
      assert.equal(
        forbidden in options,
        false,
        `the real client was constructed with a '${forbidden}' option`
      );
    }
  });

  it('leaves no key material on the client the real SDK built from that bag', async () => {
    const constructed = [];
    await createRealReader({
      endpoint: ENDPOINT,
      database: DATABASE,
      container: CONTAINER,
      loadCosmos: async () => recordingCosmosModule(constructed),
    });
    const [{ client }] = constructed;

    // clientContext.cosmosClientOptions is the SDK's own copy of what it was
    // handed — the closest thing to observing what the client will actually
    // authenticate with. It IS an internal surface, pinned here on purpose:
    // if an @azure/cosmos bump moves it, this assertion fails loudly and the
    // path gets re-derived. Do NOT soften it to optional chaining — an
    // undefined bag would make every check below pass while proving nothing.
    const applied = client.clientContext?.cosmosClientOptions;
    assert.equal(
      typeof applied,
      'object',
      'clientContext.cosmosClientOptions moved in @azure/cosmos — re-derive the path, do not delete this test'
    );
    assert.notEqual(applied, null);

    for (const forbidden of FORBIDDEN_AUTH_OPTIONS) {
      assert.equal(
        applied[forbidden] ?? undefined,
        undefined,
        `the real client carries '${forbidden}' after construction`
      );
    }
    assert.ok(applied.aadCredentials instanceof identity.DefaultAzureCredential);
  });
});

// ===========================================================================
// 3. Real credential-acquisition failures surface as AUTH — never as a crash,
//    never as an absence.
// ===========================================================================

describe('MG-67 real @azure/identity failures classify as AUTH', () => {
  // Every credential-acquisition error class the installed SDK exports,
  // constructed for real. This is the drift pin for fixture-core's
  // IDENTITY_AUTH_ERRORS: that set is a list of hand-written strings, and a
  // package bump that renamed any of these would silently downgrade
  // "run az login" to a TRANSPORT abort. Only this tier can notice.
  const REAL_IDENTITY_ERRORS = [
    ['CredentialUnavailableError', () => new identity.CredentialUnavailableError('no credential')],
    ['AuthenticationError', () => new identity.AuthenticationError(401, 'interaction required')],
    [
      'AuthenticationRequiredError',
      () =>
        new identity.AuthenticationRequiredError({
          scopes: ['https://cosmos.azure.com/.default'],
          getTokenOptions: {},
          message: 'interactive authentication is needed',
        }),
    ],
    [
      'AggregateAuthenticationError',
      () =>
        new identity.AggregateAuthenticationError(
          [new identity.CredentialUnavailableError('AzureCliCredential: please run az login')],
          'DefaultAzureCredential failed to retrieve a token'
        ),
    ],
  ];

  for (const [name, make] of REAL_IDENTITY_ERRORS) {
    it(`a real ${name} exits AUTH with the az login instruction, not TRANSPORT and not an absence`, async () => {
      const error = make();
      // Asserted before it is used: the classification is by exact name, so a
      // renamed class must fail here rather than quietly reclassify.
      assert.equal(error.name, name, `@azure/identity renamed ${name} to ${error.name}`);

      const err = await refusal(
        () =>
          createRealReader({
            endpoint: ENDPOINT,
            database: DATABASE,
            container: CONTAINER,
            loadIdentity: async () => failingIdentityModule(error),
          }),
        name
      );

      assert.equal(err.exitCode, EXIT.AUTH, `${name} did not classify as AUTH`);
      assert.notEqual(err.exitCode, EXIT.TRANSPORT);
      assert.notEqual(err.exitCode, EXIT.TIMEOUT);
      assert.match(err.message, /az login/);
      assert.match(err.message, /NOTHING about whether the route delivered/);
    });
  }

  it('does not leak the credentials a real AggregateAuthenticationError inlines from its inner errors', async () => {
    // The real class concatenates every inner credential's message into its own
    // `message`, across multiple lines. That is the leak vector a one-line fake
    // error cannot model: DefaultAzureCredential's chain reports what each link
    // tried, and an environment-credential failure can quote what it was given.
    const error = new identity.AggregateAuthenticationError(
      [
        new identity.CredentialUnavailableError(
          `EnvironmentCredential: AccountKey=${PLANTED.accountKey}`
        ),
        new identity.CredentialUnavailableError(
          `ManagedIdentityCredential: {"SharedAccessKey":"${PLANTED.deviceKey}"}`
        ),
      ],
      'DefaultAzureCredential failed to retrieve a token'
    );
    assert.ok(
      error.message.includes(PLANTED.accountKey),
      'the real SDK stopped inlining inner messages — this test is no longer exercising the leak vector it was written for'
    );

    const err = await refusal(
      () =>
        createRealReader({
          endpoint: ENDPOINT,
          database: DATABASE,
          container: CONTAINER,
          loadIdentity: async () => failingIdentityModule(error),
        }),
      'AggregateAuthenticationError leak'
    );

    assert.equal(err.exitCode, EXIT.AUTH);
    assertNoPlantedSecret(err.message, 'createRealReader AUTH failure');
  });

  it('does not leak a credential a real CredentialUnavailableError carries on its FIRST line', async () => {
    // The companion to the case above, and the sharper of the two. describeError
    // keeps only the first line, so an inner-error leak is caught by the
    // truncation as much as by the scrub — whereas a single credential that
    // failed reports inline, on line one, where nothing but the scrubber stands
    // between it and the operator's terminal. DefaultAzureCredential raises this
    // class directly when one source is configured and rejects.
    const error = new identity.CredentialUnavailableError(
      `EnvironmentCredential: AZURE_CLIENT_SECRET=${PLANTED.accountKey} was rejected; SharedAccessKey=${PLANTED.deviceKey}`
    );
    assert.equal(error.message.split('\n').length, 1, 'the leak must be on the first line');

    const err = await refusal(
      () =>
        createRealReader({
          endpoint: ENDPOINT,
          database: DATABASE,
          container: CONTAINER,
          loadIdentity: async () => failingIdentityModule(error),
        }),
      'CredentialUnavailableError leak'
    );

    assert.equal(err.exitCode, EXIT.AUTH);
    assertNoPlantedSecret(err.message, 'createRealReader single-credential AUTH failure');
  });
});

// ===========================================================================
// 4. Real @azure/cosmos error shapes, through the pre-send read — the gate that
//    decides whether anything is written at all.
// ===========================================================================

describe('MG-67 real @azure/cosmos error shapes classify fail-closed', () => {
  it('a real 403 from the data plane exits AUTH before anything is sent', async () => {
    // The shape the dev account actually produces for a caller holding only
    // control-plane RBAC: ErrorResponse with the status on `code`. Its `name`
    // is plain 'Error', so nothing about this classifies by name — only the
    // status does, which is precisely why it is worth pinning against the real
    // class rather than a fake with a convenient `statusCode`.
    const error = new cosmos.ErrorResponse(
      'Request blocked by Auth mgv2: principal does not have required RBAC permissions to perform action'
    );
    error.code = 403;

    const err = await refusal(
      () => preflight({ reader: throwingReader(error), runId: RUN_ID }),
      '403 pre-send read'
    );

    assert.equal(err.exitCode, EXIT.AUTH);
    assert.match(err.message, /NOTHING WAS SENT/);
    assert.match(err.message, /says nothing about whether the route works/);
  });

  it('a real transport failure exits TRANSPORT, not AUTH and not an absence', async () => {
    // RestError is what @azure/core-rest-pipeline surfaces through the Cosmos
    // client for a dropped connection. It must NOT be swept into AUTH — an
    // operator sent to re-issue an RBAC grant for a reset connection is an
    // operator who then re-runs a grant they already hold.
    const error = new cosmos.RestError('read ECONNRESET', { code: 'ECONNRESET' });

    const err = await refusal(
      () => preflight({ reader: throwingReader(error), runId: RUN_ID }),
      'transport pre-send read'
    );

    assert.equal(err.exitCode, EXIT.TRANSPORT);
    assert.notEqual(err.exitCode, EXIT.AUTH);
    assert.notEqual(err.exitCode, EXIT.OK);
    assert.match(err.message, /NOTHING WAS SENT/);
  });

  it('does not leak a credential a real ErrorResponse echoed back in its message', async () => {
    // Cosmos error bodies are JSON and the SDK puts them in `message`; a
    // request the service echoed can carry whatever the caller sent.
    const error = new cosmos.ErrorResponse(
      `Message: {"Errors":["Request rejected"],"AccountKey":"${PLANTED.accountKey}","authorization":"Bearer ${PLANTED.deviceKey}"}`
    );
    error.code = 401;

    const err = await refusal(
      () => preflight({ reader: throwingReader(error), runId: RUN_ID }),
      'ErrorResponse leak'
    );

    assert.equal(err.exitCode, EXIT.AUTH);
    assertNoPlantedSecret(err.message, 'preflight AUTH failure');
  });
});

// ===========================================================================
// 5. THE EVIDENCE-EMISSION CONTRACT, THROUGH A REAL SDK FAILURE AFTER THE SEND.
//
// Everything in sections 3 and 4 fails BEFORE anything is written: the reader
// could not be built, or the pre-send read was refused. Those runs changed
// nothing, and an exit code is the whole of what the operator needs.
//
// This section is the other half. The send has happened, `az` accepted every
// message, and the read-back is what fails. The contract says there is exactly
// ONE evidence-emission path and it runs on EVERY outcome, that the record
// distinguishes four id sets, and that an id once OBSERVED is never discarded by
// a later failure. MG-53 halts on any source document its recorded set does not
// account for and cannot tell such a document from the unknown writer that halt
// exists to catch — so a run that leaves documents in the container and no
// artifact behind stops the downstream migration in the one way the operator
// cannot diagnose.
//
// WHY THESE CASES BELONG IN THIS TIER rather than the fake one, which already
// sweeps every terminal outcome with hand-written errors:
//
//   * The error is a REAL AggregateAuthenticationError or RestError, and it
//     travels further than any error in the fake tier does — through the
//     confirmation result's `reason`, into the evidence record's
//     `outcomeReason`, and onto DISK. A file is a leak surface a log line is
//     not: it outlives the terminal, and MG-53 and MG-54 read it as a program
//     input.
//   * The evidence record's credential guard is FAIL-CLOSED — a
//     credential-shaped value refuses the entire write. So real error text
//     reaching `outcomeReason` is not only a leak risk; a scrub that left a
//     base64-shaped run behind would convert a run with live documents into an
//     UNRECORDED one. Both halves of that are asserted, and only a real error
//     produces the multi-line, credential-quoting text that tests it.
//
// Still offline: `az` is an injected fake, the reader is injected, and no client
// is constructed at all.
// ===========================================================================

const HUB = 'meatgeek-v2-dev-iothub-259d4bf5b628';
const FIXTURES_DIR = path.dirname(fileURLToPath(import.meta.url));

/** The measured container definition every run below is shaped by. */
const cleanDefinitionText = await readFile(
  path.join(FIXTURES_DIR, 'fixtures', 'container-show-clean.json'),
  'utf8'
);

// The partition key path container-show-clean.json declares. Written out rather
// than parsed so that a fixture edited to a different shape breaks these tests
// loudly instead of quietly rebuilding documents to match it — the tool MEASURES
// this (HR4); the test asserts against the fixture's known value.
const MEASURED_PARTITION_FIELD = 'deviceId';

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
 * The run id the read-back bound as a query PARAMETER.
 *
 * Read out of the query rather than injected through main()'s uuid seam, so the
 * documents these tests hand back are correlated to the run the tool actually
 * minted. It doubles as an assertion that the run id never reaches the query as
 * interpolated text.
 */
function runIdFrom(parameters) {
  const bound = (parameters ?? []).find(parameter => parameter.name === RUN_ID_PARAMETER);
  assert.ok(
    typeof bound?.value === 'string' && bound.value !== '',
    'the read-back must bind this run id as a query parameter'
  );
  return bound.value;
}

/** The documents a healthy route delivers for `runId`, built through the real contract. */
function deliveredDocuments(runId) {
  return buildFixtureMessages({
    runId,
    partitionKeyField: MEASURED_PARTITION_FIELD,
    deviceId: FIXTURE_DEVICE_ID,
    now: () => 1_754_000_000_000,
  }).map(message => ({ ...message.body, _ts: 1_754_000_000 }));
}

/**
 * A reader that answers the pre-send read honestly (nothing carries this run's
 * freshly minted correlator), then serves `pages` to the read-back polls, then
 * throws `error` at every poll after them.
 *
 * The split matters: throwing on the FIRST query would abort before the send and
 * prove nothing about this section. The documents have to be live before the
 * failure lands. `pages` is how a run gets to OBSERVE something before the abort
 * — the case the contract exists for.
 *
 * @param {object} options
 * @param {Array<(runId: string) => object[]>} [options.pages] one per poll, in order.
 * @param {Error} options.error thrown once the pages run out.
 */
function readerFailingAfterPreflight({ pages = [], error }) {
  let calls = 0;
  return {
    queryDocuments: async ({ parameters } = {}) => {
      calls += 1;
      if (calls === 1) return [];
      const page = pages[calls - 2];
      if (page === undefined) throw error;
      return page(runIdFrom(parameters));
    },
  };
}

/**
 * An fs seam that PASSES the destination preflight and then fails the real
 * write, so the run goes live and only the recording of it fails.
 *
 * The CLI now proves --evidence-out is usable before it sends anything, so an
 * fs that refuses everything would refuse this run at argument time and never
 * reach the path under test. The gap this models is the one the preflight
 * cannot close: it is a check at t0 about a write at t1, and the interval
 * between them spans the live send.
 */
function failingFs() {
  const absent = () => {
    const err = new Error('ENOENT');
    err.code = 'ENOENT';
    return err;
  };
  return {
    // The directory is fine; the target and its '.partial' are absent.
    stat: async target => {
      if (target.endsWith('.json') || target.endsWith(PARTIAL_SUFFIX)) throw absent();
      return { isDirectory: () => true };
    },
    // The empty preflight probe succeeds; the record write does not.
    writeFile: async target => {
      if (target.endsWith(PROBE_SUFFIX)) return;
      const err = new Error('ENOSPC: no space left on device');
      err.code = 'ENOSPC';
      throw err;
    },
    rename: async () => {},
    rm: async () => {},
  };
}

async function withTempDir(body) {
  const dir = await mkdtemp(path.join(tmpdir(), 'mg67-sdk-'));
  try {
    return await body(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

/**
 * Drive main() end to end with `az` faked, the container definition measured
 * from the real fixture, and the injected reader failing after the send.
 *
 * The wait bound is generous by default and the clock is injected, so a run that
 * needs several polls before its abort reaches the abort rather than the bound;
 * nothing here sleeps.
 */
async function runToReadBackFailure({
  error,
  evidenceOut,
  fs,
  pages = [],
  timeoutMs = 60_000,
  pollIntervalMs = 250,
}) {
  const log = recordingLog();
  let clock = 1_754_000_000_000;
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
      'container-show-clean.json',
      '--evidence-out',
      evidenceOut,
      '--timeout',
      String(timeoutMs),
      '--poll-interval',
      String(pollIntervalMs),
    ],
    createReader: async () => readerFailingAfterPreflight({ pages, error }),
    spawn: async () => ({ code: 0, stdout: '', stderr: '' }),
    log,
    readFileFn: async () => cleanDefinitionText,
    now: () => (clock += 250),
    sleep: async () => {},
    ...(fs ? { fs } : {}),
  });
  return { exitCode, log };
}

/** The ids main() logged as accepted by IoT Hub, read back off its own output. */
function sentIdsFrom(log) {
  return log.infoLines.flatMap(line => [...line.matchAll(/\(id ([^)]+)\)/g)].map(m => m[1]));
}

/**
 * A real AggregateAuthenticationError carrying planted credentials, built fresh
 * per test so no assertion can depend on a mutation another made.
 */
function leakyRealAuthError() {
  return new identity.AggregateAuthenticationError(
    [
      new identity.CredentialUnavailableError(
        `EnvironmentCredential: AccountKey=${PLANTED.accountKey}`
      ),
      new identity.CredentialUnavailableError(
        `ManagedIdentityCredential: SharedAccessKey=${PLANTED.deviceKey}`
      ),
    ],
    'DefaultAzureCredential failed to retrieve a token for the read-back'
  );
}

/**
 * The contract's invariants, asserted structurally against a record — the same
 * checks whatever produced it.
 *
 * Written as one helper on purpose. The defect this contract answers appeared
 * five times on five paths because each path was checked for the symptom it
 * happened to exhibit; a shared assertion means a new path is either checked
 * against all of it or not checked at all.
 */
function assertContractShape(record, { exit, sets }) {
  // 1. THE RECORD EXISTS FOR A RUN THAT ATTEMPTED SOMETHING, and names its
  //    outcome as a code and as a stable slug.
  assert.equal(record.attempted, true, 'a run that attempted a send is always recorded as such');
  assert.equal(record.exitCode, exit);
  assert.equal(record.exitLabel, exitLabel(exit));

  // 2. THE FOUR ID SETS, INDIVIDUALLY. Counts and lists both, so a count that
  //    drifts from its list is caught rather than trusted.
  for (const [name, expected] of Object.entries(sets)) {
    const ids = record[`${name}Ids`];
    assert.ok(Array.isArray(ids), `${name}Ids must be a list`);
    assert.equal(ids.length, expected, `${name}Ids`);
    assert.equal(ids.length, new Set(ids).size, `${name}Ids must not repeat`);
    assert.equal(record[`${name}Count`], expected, `${name}Count`);
  }

  // 3. THE UNION A DOWNSTREAM TICKET MUST ACCOUNT FOR — everything that is, or
  //    may be, in the container. Computed once here rather than left for MG-53
  //    to assemble out of three fields.
  assert.deepEqual(
    [...record.accountableIds].sort(),
    [...new Set([...record.observedIds, ...record.acceptedIds, ...record.ambiguousIds])].sort(),
    'accountableIds must be the union of observed, accepted and ambiguous'
  );
  assert.equal(record.accountableCount, record.accountableIds.length);

  // 4. CERTAINTY IS NEVER OVERCLAIMED. Nothing short of the full read-back is
  //    confirmed, and every failing outcome is flagged uncertain.
  assert.equal(record.confirmed, exit === EXIT.OK, 'only an OK run may be recorded as confirmed');
  assert.equal(record.uncertain, true, 'a run that did not complete its read-back is uncertain');

  // 5. DIVERGENCE IS WITNESSED, NEVER INFERRED. Every case here observed only
  //    ids the sender requested — including the ones that observed FEWER than
  //    they sent, which is a shortfall and not a platform renaming. Asserting
  //    the latter in the one artifact MG-53 and MG-54 parse mechanically would
  //    make a downstream ticket act on a claim nobody witnessed.
  assert.equal(record.idDivergence, false, 'idDivergence must never be inferred from a shortfall');
  for (const id of record.observedIds) {
    assert.ok(record.requestedIds.includes(id), `observed id ${id} was never requested`);
  }

  // 6. The schema-version-1 aliases still name the OBSERVED set, so a consumer
  //    written against either spelling reads the same documents.
  assert.deepEqual(record.ids, record.observedIds);
  assert.equal(record.count, record.observedIds.length);
  assert.equal(record.expectedCount, MESSAGES_PER_RUN);

  // 7. The synthetic contract and the measured shape are recorded whatever the
  //    outcome — a failure record MG-53 cannot interpret is not a record.
  assert.equal(record.marker.value, SYNTHETIC_MARKER);
  assert.equal(record.partitionKeyField, MEASURED_PARTITION_FIELD);
  assert.equal(record.measuredDefaultTtl, 604_800);
  assert.equal(typeof record.runInstant, 'string');
  assert.equal(
    typeof record.waitBoundMs,
    'number',
    'the wait bound used is reported on every path'
  );
}

describe('MG-67 a real SDK failure after the send still records the run', () => {
  it('an AUTH abort with nothing observed records four correct id sets and exits AUTH, not OK', async () => {
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      const { exitCode, log } = await runToReadBackFailure({
        error: leakyRealAuthError(),
        evidenceOut,
      });

      // The read-back failure keeps its own code: the record was written, so
      // nothing about the recording changes the diagnosis.
      assert.equal(exitCode, EXIT.AUTH, `expected AUTH, got ${exitCode} (${exitLabel(exitCode)})`);
      assert.notEqual(exitCode, EXIT.OK, 'an unread-back run is never a success');
      assert.notEqual(exitCode, EXIT.TIMEOUT, 'an auth failure is never a timeout');

      const record = JSON.parse(await readFile(evidenceOut, 'utf8'));
      // az accepted all three and the read-back saw none of them: three
      // documents are LIVE and unobserved, which is exactly what the record has
      // to say and exactly what "nothing was written" would get wrong.
      assertContractShape(record, {
        exit: EXIT.AUTH,
        sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 0 },
      });
      assert.equal(record.outcome, 'auth-failure');
      assert.deepEqual(record.requestedIds, sentIdsFrom(log), 'the record must name what was sent');
    });
  });

  it('keeps ids it already OBSERVED when a real AggregateAuthenticationError aborts the run', async () => {
    // THE CASE THE CONTRACT EXISTS FOR, against the real error class. Two
    // documents are read back, and THEN the credential fails. An id once
    // observed is never discarded by a later failure: the auth abort changes the
    // outcome, not the history. Dropping them here would tell MG-53 that two
    // documents in the source container are unaccounted for — indistinguishable,
    // from where it stands, from the unknown writer it halts on.
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      const { exitCode } = await runToReadBackFailure({
        error: leakyRealAuthError(),
        evidenceOut,
        pages: [runId => deliveredDocuments(runId).slice(0, 2)],
      });

      assert.equal(exitCode, EXIT.AUTH);
      const record = JSON.parse(await readFile(evidenceOut, 'utf8'));
      assertContractShape(record, {
        exit: EXIT.AUTH,
        sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 2 },
      });
      // Named, not merely counted: MG-54 deletes by these ids.
      assert.deepEqual(record.observedIds, [`${record.runId}-1`, `${record.runId}-2`]);
      assert.equal(record.accountableCount, 3, 'the third document is live and unobserved');
    });
  });

  it('keeps ids it already OBSERVED when a real RestError exhausts the transport budget', async () => {
    // The same clause on the other abort. TRANSPORT and AUTH are never collapsed
    // into one another, and neither of them may quietly become an absence.
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      const { exitCode } = await runToReadBackFailure({
        error: new cosmos.RestError('read ECONNRESET', { code: 'ECONNRESET' }),
        evidenceOut,
        pages: [runId => deliveredDocuments(runId).slice(0, 1)],
      });

      assert.equal(exitCode, EXIT.TRANSPORT);
      assert.notEqual(exitCode, EXIT.AUTH, 'a reset connection is not a credential problem');
      assert.notEqual(exitCode, EXIT.TIMEOUT, 'retries exhausted is not the bound elapsing');
      const record = JSON.parse(await readFile(evidenceOut, 'utf8'));
      assertContractShape(record, {
        exit: EXIT.TRANSPORT,
        sets: { requested: 3, accepted: 3, ambiguous: 0, observed: 1 },
      });
      assert.equal(record.outcome, 'transport-abort');
      assert.deepEqual(record.observedIds, [`${record.runId}-1`]);
    });
  });

  it('lets no credential the real error inlined reach the artifact on disk or the operator', async () => {
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      const error = leakyRealAuthError();
      // The premise, asserted rather than assumed: if @azure/identity ever stops
      // inlining inner messages, this test is no longer exercising the leak
      // vector it was written for and must be re-derived, not deleted.
      assert.ok(error.message.includes(PLANTED.accountKey));

      const { exitCode, log } = await runToReadBackFailure({
        error,
        evidenceOut,
        pages: [runId => deliveredDocuments(runId).slice(0, 2)],
      });
      assert.equal(exitCode, EXIT.AUTH);

      // The raw bytes, not the parsed record: a secret in a key name, a nested
      // field or a string this tier did not think to look at is still on disk.
      const raw = await readFile(evidenceOut, 'utf8');
      assertNoPlantedSecret(raw, 'the evidence artifact');
      const record = JSON.parse(raw);
      // outcomeReason is the field the real error's text actually travels in, so
      // the scrub is asserted where it is load-bearing and not only file-wide.
      assertNoPlantedSecret(record.outcomeReason, 'the evidence record outcomeReason');
      // All FOUR id sets, individually: the guard walks the record structurally
      // and the contract gave it three more lists to walk than it once had.
      for (const key of ['requestedIds', 'acceptedIds', 'ambiguousIds', 'observedIds']) {
        assertNoPlantedSecret(record[key].join(' '), `the evidence record ${key}`);
      }
      assertNoPlantedSecret(log.all(), 'the operator-facing output of a recorded failure');
    });
  });

  it('still WRITES the record when the real error reaches it: a fail-closed guard must not unrecord a live run', async () => {
    // The other half of the guard, and the reason a real error is worth testing
    // against. assertNoCredentialShape REFUSES the write on a credential-shaped
    // value — so a scrub that let a base64-shaped run through would not leak, it
    // would turn a run with two live, observed documents into an UNRECORDED one.
    // That is the worse of the two failures: the leak is caught above, and this
    // asserts the record survives the same input.
    await withTempDir(async dir => {
      const evidenceOut = path.join(dir, 'evidence.json');
      const { exitCode } = await runToReadBackFailure({
        error: leakyRealAuthError(),
        evidenceOut,
        pages: [runId => deliveredDocuments(runId).slice(0, 2)],
      });

      assert.equal(
        exitCode,
        EXIT.AUTH,
        'the record was written, so the run keeps its own diagnosis rather than becoming EVIDENCE_UNRECORDED'
      );
      assert.notEqual(exitCode, EXIT.EVIDENCE_UNRECORDED);
      const record = JSON.parse(await readFile(evidenceOut, 'utf8'));
      assert.equal(record.observedCount, 2, 'the documents the run did read back are on disk');
      assert.notEqual(
        record.outcomeReason,
        '',
        'the diagnosis survives the scrub, in scrubbed form'
      );
    });
  });

  it('exits EVIDENCE_UNRECORDED when the record cannot be written, never USAGE and never the read-back code', async () => {
    await withTempDir(async dir => {
      const { exitCode, log } = await runToReadBackFailure({
        error: leakyRealAuthError(),
        evidenceOut: path.join(dir, 'evidence.json'),
        fs: failingFs(),
        pages: [runId => deliveredDocuments(runId).slice(0, 2)],
      });

      // USAGE means "bad arguments, nothing live happened". Three documents are
      // in the container; reporting that would be the worst answer this tool can
      // give, and it is the answer this exit code exists to prevent.
      assert.equal(exitCode, EXIT.EVIDENCE_UNRECORDED);
      assert.notEqual(exitCode, EXIT.USAGE);
      assert.notEqual(exitCode, EXIT.OK);
      assert.notEqual(
        exitCode,
        EXIT.AUTH,
        'an unrecorded run outranks its own diagnosis: the operator must be sent to the ids first'
      );

      const output = log.all();
      assert.match(output, /EVIDENCE NOT RECORDED/);
      // The two id sets are reported SEPARATELY and in the right words: what was
      // observed is in the container, and what az merely accepted may be. A line
      // that flattened them would be this tool guessing on the operator's behalf.
      assert.match(output, /2 document\(s\) ARE in/);
      assert.match(output, /1 document\(s\) MAY BE in/);
      // Never the sentence the contract exists to delete.
      assert.equal(
        /nothing was written/i.test(output),
        false,
        'no output may claim nothing was written once a send has been attempted'
      );
      // The confirmation's own outcome is still on the lines above, so the
      // diagnosis is not lost — only the code the operator scripts against.
      // Substring, not a regex: exit labels are prose and one of them already
      // carries parentheses, so a RegExp built from a label is a trap waiting
      // for the next label this assertion is pointed at.
      assert.ok(
        output.includes(exitLabel(EXIT.AUTH)),
        'the read-back diagnosis must survive on the lines above'
      );

      const sent = sentIdsFrom(log);
      assert.equal(sent.length, MESSAGES_PER_RUN);
      for (const id of sent) {
        assert.ok(
          output.includes(id),
          `id ${id} is live and was not named in the unrecorded-run output`
        );
      }
      assertNoPlantedSecret(output, 'the unrecorded-run output');
    });
  });
});

describe('MG-67 no real SDK error can manufacture a tool-state exit code', () => {
  // classifyError answers AUTH or TRANSPORT and nothing else, by design: absence,
  // timeout, marker violation and ambiguity are conclusions drawn from what was
  // READ, never from an exception. The codes below describe the tool's own state
  // rather than the service's — "your arguments were wrong, nothing happened"
  // and "the live container changed and nothing recorded it" — and an SDK error
  // that could produce either would misreport which refusal occurred. The set of
  // real error classes is what only this tier can enumerate.
  const REAL_SDK_ERRORS = () => [
    ['CredentialUnavailableError', new identity.CredentialUnavailableError('no credential')],
    ['AuthenticationError', new identity.AuthenticationError(401, 'interaction required')],
    [
      'AggregateAuthenticationError',
      new identity.AggregateAuthenticationError(
        [new identity.CredentialUnavailableError('please run az login')],
        'DefaultAzureCredential failed'
      ),
    ],
    ['RestError/ECONNRESET', new cosmos.RestError('read ECONNRESET', { code: 'ECONNRESET' })],
    ['RestError/ETIMEDOUT', new cosmos.RestError('connect ETIMEDOUT', { code: 'ETIMEDOUT' })],
    ['ErrorResponse/403', Object.assign(new cosmos.ErrorResponse('RBAC denied'), { code: 403 })],
    [
      'ErrorResponse/429',
      Object.assign(new cosmos.ErrorResponse('too many requests'), { code: 429 }),
    ],
    ['ErrorResponse/500', Object.assign(new cosmos.ErrorResponse('service error'), { code: 500 })],
  ];

  for (const [name, error] of REAL_SDK_ERRORS()) {
    it(`a real ${name} classifies as AUTH or TRANSPORT only`, () => {
      const code = classifyError(error);
      assert.ok(
        code === EXIT.AUTH || code === EXIT.TRANSPORT,
        `${name} classified as ${code} (${exitLabel(code)})`
      );
      assert.notEqual(code, EXIT.USAGE, 'a service error must never read as "nothing happened"');
      assert.notEqual(code, EXIT.EVIDENCE_UNRECORDED, 'that code describes this tool, not Azure');
      assert.notEqual(code, EXIT.TIMEOUT, 'an exception is never an absence');
      assert.notEqual(code, EXIT.OK);
    });
  }
});

// ===========================================================================
// 7. NO REAL SDK ERROR CAN REACH EXIT 0 — AND NONE IS SILENTLY DOWNGRADED.
//
// Section 6 above asks what classifyError ANSWERS for each real error class.
// This section asks the next question, and it is the one with the operator
// consequence: what the single exit funnel does with that answer.
//
// The funnel is now fail-closed by construction. resolveOutcomeCode owns the
// only decision that a run exits 0, it requires a confirmation that both
// carries EXIT.OK and says confirmed:true, and every other shape — including
// one it was not written to expect — comes back as UNANTICIPATED_OUTCOME_CODE
// with a sentence naming what was found. There is no `?? EXIT.OK` left in it.
// That inversion is the ticket's central invariant and the fake tier proves it
// directly, hand-building each unanticipated state.
//
// What the fake tier CANNOT prove is that a real failure still arrives at that
// funnel wearing a code the funnel recognises. The fail-closed default has a
// quiet cost: an exit code outside the vocabulary is not trusted, so it is
// REPLACED. A classifier that grew a case answering with some new code — for a
// real SDK shape that only exists once the packages are installed — would not
// fail loudly. Every such run would report a correlation ambiguity, and an
// operator staring at exit 7 diagnoses the route and the marker while the real
// answer was a missing RBAC grant on the account. The fake tier builds its
// errors by hand and so can only ever confirm that the codes IT chose are
// known; only here does a real @azure/identity or @azure/cosmos error travel
// classifyError -> toFixtureError -> resolveOutcomeCode -> settleRun end to
// end.
//
// So each real error class is asserted twice over: its code is IN the
// vocabulary and survives the funnel unchanged (not downgraded), and the funnel
// returns it nonzero (not success). Both directions matter — an auth failure
// reported as an ambiguity is the wrong diagnosis, and an auth failure reported
// as a confirmation is a false proof of the only thing this tool exists to
// prove.
//
// Still offline: no client is constructed and no client method is called. Every
// error below is instantiated directly from the installed packages.
// ===========================================================================

describe('MG-67 no real SDK error can reach exit 0 through the funnel', () => {
  // The same real classes section 6 enumerates. Rebuilt per call so no
  // assertion can depend on a mutation another made, and deliberately NOT
  // shared with that section's list: these two sections must be able to
  // disagree about coverage rather than silently track each other.
  const REAL_SDK_ERRORS = () => [
    ['CredentialUnavailableError', new identity.CredentialUnavailableError('no credential')],
    ['AuthenticationError', new identity.AuthenticationError(401, 'interaction required')],
    ['AuthenticationRequiredError', new identity.AuthenticationRequiredError({ scopes: [] })],
    ['AggregateAuthenticationError', leakyRealAuthError()],
    ['RestError/ECONNRESET', new cosmos.RestError('read ECONNRESET', { code: 'ECONNRESET' })],
    ['RestError/ETIMEDOUT', new cosmos.RestError('connect ETIMEDOUT', { code: 'ETIMEDOUT' })],
    ['ErrorResponse/403', Object.assign(new cosmos.ErrorResponse('RBAC denied'), { code: 403 })],
    [
      'ErrorResponse/429',
      Object.assign(new cosmos.ErrorResponse('too many requests'), { code: 429 }),
    ],
    ['ErrorResponse/500', Object.assign(new cosmos.ErrorResponse('service error'), { code: 500 })],
  ];

  /**
   * Settle a run that holds ONLY this failure — no confirmation, and no ledger.
   *
   * That is the real shape of an abort before the send: the pre-send read was
   * refused, or the reader could never be built. A null ledger means the run
   * attempted nothing, which is the one case allowed to exit without an
   * evidence record, so nothing here writes a file and the `fs` seam is never
   * reached.
   */
  const settleWithFailure = async failure => {
    const log = recordingLog();
    const exitCode = await settleRun({
      cfg: {
        database: DATABASE,
        container: CONTAINER,
        device: FIXTURE_DEVICE_ID,
        timeoutMs: 60_000,
        pollIntervalMs: 250,
      },
      definition: { partitionKeyField: MEASURED_PARTITION_FIELD, measuredDefaultTtl: 604_800 },
      ledger: null,
      confirmation: null,
      failure,
      device: FIXTURE_DEVICE_ID,
      hub: HUB,
      log,
      now: () => 1_754_000_000_000,
      fs: {
        stat: async () => {
          throw new Error('settleRun must not touch the filesystem for a run with no ledger');
        },
        writeFile: async () => {
          throw new Error('settleRun must not write a record for a run that attempted nothing');
        },
        rename: async () => {},
        rm: async () => {},
      },
    });
    return { exitCode, log };
  };

  for (const [name, error] of REAL_SDK_ERRORS()) {
    it(`a real ${name} exits as its own class, never 0 and never a downgrade`, async () => {
      // 1. The classification, and the property the funnel depends on: the code
      //    is one this tool's vocabulary minted. This is the assertion that
      //    catches a classifier grown a case the funnel does not know.
      const classified = classifyError(error);
      assert.ok(
        isKnownExitCode(classified),
        `${name} classified as ${classified}, which is outside this tool's exit vocabulary — the funnel would replace it with ${UNANTICIPATED_OUTCOME_CODE} (${exitLabel(UNANTICIPATED_OUTCOME_CODE)}) and misreport the diagnosis`
      );
      assert.notEqual(classified, EXIT.OK, 'an exception is never a confirmation');

      // 2. Through the wrapper every catch block in the tool goes through.
      const failure = toFixtureError(error, 'reading the destination container');
      assert.ok(failure instanceof FixtureError);
      assert.equal(failure.exitCode, classified, 'the wrapper must not re-map the classification');

      // 3. Through the resolver that owns the exit-0 decision. `unanticipated`
      //    false is the whole point: the funnel RECOGNISED this failure rather
      //    than falling back, so the operator gets the auth/transport
      //    diagnosis instead of a correlation ambiguity.
      const outcome = resolveOutcomeCode({ confirmation: null, failure });
      assert.equal(outcome.exitCode, classified, `${name} was downgraded by the funnel`);
      assert.equal(outcome.unanticipated, false, `${name} reached the funnel's fall-through`);
      assert.equal(outcome.reason, null);

      // 4. And through the funnel itself, which is what main() returns.
      const { exitCode, log } = await settleWithFailure(failure);
      assert.equal(exitCode, classified);
      assert.notEqual(exitCode, EXIT.OK, `a real ${name} must never settle as success`);
      assert.ok(
        exitCode === EXIT.AUTH || exitCode === EXIT.TRANSPORT,
        `${name} settled as ${exitCode} (${exitLabel(exitCode)})`
      );

      // 5. HR1 on the settlement path too. The failure message the funnel
      //    prints is built from the real error's text, and for
      //    AggregateAuthenticationError that text inlines every inner
      //    credential's message.
      const output = log.all();
      assertNoPlantedSecret(output, `settling a real ${name}`);
      assert.ok(output.includes(FIXTURE_DEVICE_ID), 'failure output names the device');
      assert.ok(output.includes(HUB), 'failure output names the hub');
      assert.ok(output.includes(exitLabel(exitCode)), 'failure output names the outcome');
    });
  }

  it('the funnel refuses success for a real error even if one arrives carrying exit 0', async () => {
    // The direction the vocabulary check cannot cover. A FixtureError built
    // around a real SDK error but carrying EXIT.OK is not a state this tool
    // produces — which is exactly why it is worth pinning: "the run aborted
    // with a failure carrying exit code 0" must be refused rather than
    // honoured, because a failure IS the evidence that nothing was confirmed.
    const failure = new FixtureError(EXIT.OK, toFixtureError(leakyRealAuthError(), 'read').message);

    const outcome = resolveOutcomeCode({ confirmation: null, failure });
    assert.equal(outcome.unanticipated, true);
    assert.equal(outcome.exitCode, UNANTICIPATED_OUTCOME_CODE);
    assert.notEqual(outcome.exitCode, EXIT.OK);

    const { exitCode, log } = await settleWithFailure(failure);
    assert.equal(exitCode, UNANTICIPATED_OUTCOME_CODE);
    assert.notEqual(exitCode, EXIT.OK, 'exit 0 requires a confirmation, not the absence of one');
    // The operator is told the tool reached a state it does not understand.
    // A code with no sentence behind it is unreportable as a defect.
    assert.ok(
      log.all().includes('neither') || log.all().includes('exit code 0'),
      'an unanticipated state must say what was found'
    );
    assertNoPlantedSecret(log.all(), 'settling a fabricated exit-0 failure');
  });

  it('a real SDK failure at the READER does not become a confirmation end to end', async () => {
    // The same property through main() rather than through the funnel alone, so
    // nothing between argument parsing and the return can manufacture a 0. The
    // reader throws a real AggregateAuthenticationError on its FIRST query,
    // which is the pre-send read: the run aborts having sent nothing, so there
    // is no evidence record to write and no live document to account for.
    await withTempDir(async dir => {
      const log = recordingLog();
      const spawned = [];
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
          'container-show-clean.json',
          '--evidence-out',
          path.join(dir, 'evidence.json'),
        ],
        createReader: async () => ({
          queryDocuments: async () => {
            throw leakyRealAuthError();
          },
        }),
        spawn: async (...args) => {
          spawned.push(args);
          return { code: 0, stdout: '', stderr: '' };
        },
        log,
        readFileFn: async () => cleanDefinitionText,
        now: () => 1_754_000_000_000,
        sleep: async () => {},
      });

      assert.equal(exitCode, EXIT.AUTH, 'a credential that cannot be acquired is an AUTH refusal');
      assert.notEqual(exitCode, EXIT.OK);
      assert.notEqual(exitCode, EXIT.TIMEOUT, 'an auth failure is never an absence');
      assert.equal(spawned.length, 0, 'a refused pre-send read must send nothing');
      assertNoPlantedSecret(log.all(), 'an end-to-end AUTH abort');
    });
  });
});
