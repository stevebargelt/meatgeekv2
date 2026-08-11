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
// WHAT ONLY THIS TIER CAN PROVE. Three things, each of them a way the tool
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
//
// NOTHING HERE MAY CONTACT AZURE. Constructing a client and constructing a
// credential are both offline; calling any client method is not, and is out of
// scope for this tier as much as for the other. No test below calls a client
// method, and no test below calls getToken().

import { strict as assert } from 'node:assert';
import { describe, it } from 'node:test';

import { EXIT, FixtureError } from './fixture-core.mjs';
import { createRealReader, endpointFor, preflight } from './send-fixture.mjs';

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
