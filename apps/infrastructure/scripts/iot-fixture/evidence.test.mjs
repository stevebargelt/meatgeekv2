// Unit tests for the machine-readable evidence artifact (MG-67).
//
// The property under test is not "the record serializes". It is that the record
// is a sound PROGRAM INPUT for two later tickets: MG-53 halts on any document
// this run did not account for, and MG-54 cites these ids in a destructive
// authorization. So the failures these tests exist to catch are a record that
// claims more than the confirmation concluded, a retention or an expiry instant
// that was assumed rather than measured, a divergence between requested and
// observed ids that goes unrecorded, a field able to carry a credential, and a
// half-written file that a reader could mistake for evidence.
//
// Dependency-free by contract: node: built-ins and local files only, so this
// file runs in the credentialless validate-infrastructure job with no npm
// install and no network. The clock is injected everywhere, so no test sleeps
// and the artifact is byte-reproducible.

import { strict as assert } from 'node:assert';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseContainerDefinition } from './container-definition.mjs';
import { fakeClock, fakeReader, forbiddenError } from './fake-azure.mjs';
import {
  EXIT,
  FIXTURE_DEVICE_ID,
  FixtureError,
  MESSAGES_PER_RUN,
  RUN_ID_FIELD,
  SYNTHETIC_MARKER,
  SYNTHETIC_MARKER_FIELD,
  TICKET,
  abortedConfirmation,
  buildFixtureMessages,
  confirmArrival,
} from './fixture-core.mjs';
import {
  EVIDENCE_KIND,
  EVIDENCE_RECORD_KEYS,
  EVIDENCE_SCHEMA_VERSION,
  assertNoCredentialShape,
  buildEvidenceRecord,
  describeEvidence,
  findCredentialRisks,
  partialPathFor,
  serializeEvidenceRecord,
  writeEvidenceRecord,
} from './evidence.mjs';

const readLocal = relative => readFile(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const readFixture = name => readLocal(`./fixtures/${name}`);

const RUN_ID = 'mg-67-run-00000000-0000-4000-8000-000000000001';
const RUN_MILLIS = Date.parse('2026-08-11T09:00:00.000Z');
const TARGET = Object.freeze({
  hub: 'meatgeek-v2-dev-iothub-259d4bf5b628',
  account: 'mgv2-dev-f640e19ae7ab',
  database: 'meatgeek-v2-dev-db',
  container: 'temperatures',
});

const fixedClock =
  (millis = RUN_MILLIS) =>
  () =>
    millis;

// Hand-built definitions, used ONLY where the point of the test is a definition
// the real parser would never produce (one measured from the wrong container) or
// a poisoned input. Everything else goes through parseContainerDefinition and
// the shipped az fixtures, so the record and the measurement cannot drift apart.
const DEFINITION_OF_ANOTHER_CONTAINER = Object.freeze({
  containerName: 'sessions',
  partitionKeyPath: '/deviceId',
  partitionKeyField: 'deviceId',
  measuredDefaultTtl: 604800,
  declaredDefaultTtl: 604800,
  ttlExpires: true,
  ttlDriftFinding: null,
});

const DEFINITION_OF_TARGET_CONTAINER = Object.freeze({
  ...DEFINITION_OF_ANOTHER_CONTAINER,
  containerName: TARGET.container,
});

// The bodies the sender would have sent, and therefore the documents a healthy
// route delivers. Built through the real contract rather than hand-written, so a
// change to the marker or the correlator lands here too.
function sentMessages(runId = RUN_ID) {
  return buildFixtureMessages({
    runId,
    partitionKeyField: 'deviceId',
    now: fixedClock(RUN_MILLIS - 5000),
  });
}

const requestedIdsOf = messages => messages.map(message => message.body.id);

// A real confirmation result, produced by the real confirmArrival against the
// fake reader. Never a hand-built stand-in: the record's whole job is to
// transcribe what the confirmation concluded, and a fabricated confirmation
// would let the two drift apart silently.
async function confirmationFor(spec, overrides = {}) {
  const clock = fakeClock({ start: RUN_MILLIS - 5000 });
  return confirmArrival({
    reader: fakeReader(spec),
    runId: RUN_ID,
    partitionKeyField: 'deviceId',
    partitionValue: FIXTURE_DEVICE_ID,
    now: clock.now,
    sleep: clock.sleep,
    ...overrides,
  });
}

async function successfulConfirmation(deliveredDocuments) {
  const messages = sentMessages();
  const delivered = deliveredDocuments ?? messages.map(message => message.body);
  const confirmation = await confirmationFor({
    script: [{ docs: [] }, { docs: delivered }],
  });
  assert.equal(confirmation.confirmed, true, 'fixture setup: expected a confirmed result');
  return { confirmation, messages };
}

async function cleanDefinition() {
  return parseContainerDefinition(await readFixture('container-show-clean.json'));
}

async function driftDefinition() {
  return parseContainerDefinition(await readFixture('container-show-ttl-drift.json'));
}

async function buildSuccessRecord(overrides = {}) {
  const { confirmation, messages } = await successfulConfirmation(overrides.deliveredDocuments);
  return buildEvidenceRecord({
    confirmation,
    containerDefinition: overrides.containerDefinition ?? (await cleanDefinition()),
    requestedIds: overrides.requestedIds ?? requestedIdsOf(messages),
    target: TARGET,
    now: fixedClock(),
    ...overrides.build,
  });
}

const tempDir = () => mkdtemp(path.join(tmpdir(), 'mg67-evidence-'));

describe('the evidence record', () => {
  it('carries every key MG-53 and MG-54 read, non-empty, through a JSON round-trip', async () => {
    // Built from the DRIFT definition on purpose: it is the only input under
    // which ttlDriftFinding is non-null, and the acceptance asks for every
    // listed key to be present AND non-empty.
    const record = await buildSuccessRecord({ containerDefinition: await driftDefinition() });
    const parsed = JSON.parse(serializeEvidenceRecord(record));

    for (const key of [
      'ids',
      'count',
      'deviceId',
      'partitionKeyPath',
      'measuredDefaultTtl',
      'declaredDefaultTtl',
      'ttlDriftFinding',
      'waitBoundMs',
      'observedArrivalMs',
      'runInstant',
      'expiryInstant',
      'ticket',
    ]) {
      assert.ok(
        Object.prototype.hasOwnProperty.call(parsed, key),
        `the record must carry ${key} — a downstream ticket reads it`
      );
      const value = parsed[key];
      assert.notEqual(value, null, `${key} must not be null on a confirmed run`);
      assert.notEqual(value, undefined, `${key} must not be undefined`);
      if (typeof value === 'string') assert.notEqual(value.trim(), '', `${key} must not be empty`);
      if (Array.isArray(value)) assert.ok(value.length > 0, `${key} must not be an empty list`);
    }

    // The marker is recorded by field AND value: MG-53 matches on it, and a
    // record that named only one half would force it to hardcode the other.
    assert.equal(parsed.marker.field, SYNTHETIC_MARKER_FIELD);
    assert.equal(parsed.marker.value, SYNTHETIC_MARKER);
    assert.equal(parsed.marker.runIdField, RUN_ID_FIELD);
    assert.equal(parsed.ticket, TICKET);
    assert.equal(parsed.kind, EVIDENCE_KIND);
    assert.equal(parsed.schemaVersion, EVIDENCE_SCHEMA_VERSION);
    assert.equal(parsed.deviceId, FIXTURE_DEVICE_ID);
    assert.equal(parsed.confirmed, true);
    assert.equal(parsed.exitCode, EXIT.OK);
    // Where the documents are, by name. A record that does not say which
    // account, database and container it describes is not consumable.
    assert.deepEqual(parsed.target, TARGET);
  });

  it('records the OBSERVED ids and a count that equals their number', async () => {
    const record = await buildSuccessRecord();
    assert.equal(record.count, record.ids.length);
    assert.equal(record.count, MESSAGES_PER_RUN);
    assert.deepEqual(record.ids, requestedIdsOf(sentMessages()));
    // The count is derived, never copied from the confirmation's own tally: two
    // numbers that could disagree are a number MG-53 cannot trust.
    assert.equal(JSON.parse(serializeEvidenceRecord(record)).count, record.ids.length);
  });

  it('derives expiryInstant from runInstant plus the MEASURED ttl', async () => {
    const record = await buildSuccessRecord();
    assert.equal(record.runInstant, new Date(RUN_MILLIS).toISOString());
    assert.equal(record.measuredDefaultTtl, 604800);
    assert.equal(
      record.expiryInstant,
      new Date(RUN_MILLIS + 604800 * 1000).toISOString(),
      'expiryInstant must be runInstant plus the measured retention'
    );
    assert.equal(
      Date.parse(record.expiryInstant) - Date.parse(record.runInstant),
      record.measuredDefaultTtl * 1000
    );
    assert.equal(record.ttlExpires, true);
  });

  it('records a measured ttl that drifts from the declared one, and never substitutes', async () => {
    const definition = await driftDefinition();
    const record = await buildSuccessRecord({ containerDefinition: definition });

    assert.equal(record.measuredDefaultTtl, definition.measuredDefaultTtl);
    assert.notEqual(
      record.measuredDefaultTtl,
      record.declaredDefaultTtl,
      'fixture setup: the drift document must measure something other than the declared value'
    );
    assert.equal(record.declaredDefaultTtl, definition.declaredDefaultTtl);
    // Both numbers, so an operator reading the record can see the disagreement
    // without going back to the container.
    assert.equal(record.ttlDriftFinding.measured, definition.measuredDefaultTtl);
    assert.equal(record.ttlDriftFinding.declared, definition.declaredDefaultTtl);
    assert.ok(record.findings.some(finding => finding.kind === 'ttl-drift'));
    // The expiry follows the MEASURED value, which is the whole point of HR4.
    assert.equal(
      Date.parse(record.expiryInstant) - Date.parse(record.runInstant),
      definition.measuredDefaultTtl * 1000
    );
  });

  it('records no expiry instant when the measured ttl is -1, and says so as a finding', async () => {
    const source = JSON.parse(await readFixture('container-show-clean.json'));
    source.resource.defaultTtl = -1;
    const definition = parseContainerDefinition(JSON.stringify(source));
    const record = await buildSuccessRecord({ containerDefinition: definition });

    assert.equal(record.measuredDefaultTtl, -1);
    assert.equal(record.ttlExpires, false);
    // A fabricated instant here would hand MG-53 the wrong explanation for a
    // zero count: nothing ages out, so expiry can never be the reason.
    assert.equal(record.expiryInstant, null);
    const finding = record.findings.find(item => item.kind === 'no-ttl-expiry');
    assert.ok(finding, 'a container that never expires documents must be recorded as a finding');
    assert.match(finding.message, /must NOT be read as expiry/);
  });
});

describe('requested versus observed ids', () => {
  it('records both lists and sets the divergence flag when the platform renamed them', async () => {
    const messages = sentMessages();
    // What the platform stored: the same run's documents, with ids of its own
    // choosing. The correlation key is marker + run id, so the proof survives.
    const delivered = messages.map((message, index) => ({
      ...message.body,
      id: `cosmos-assigned-${index}`,
    }));
    const record = await buildSuccessRecord({
      deliveredDocuments: delivered,
      requestedIds: requestedIdsOf(messages),
    });

    assert.equal(record.idDivergence, true);
    assert.deepEqual(record.ids, ['cosmos-assigned-0', 'cosmos-assigned-1', 'cosmos-assigned-2']);
    assert.deepEqual(record.requestedIds, requestedIdsOf(messages));
    assert.equal(record.requestedCount, MESSAGES_PER_RUN);
    // An observation, not a failure: the run is still confirmed.
    assert.equal(record.confirmed, true);
    assert.equal(record.exitCode, EXIT.OK);
    const finding = record.findings.find(item => item.kind === 'id-divergence');
    assert.ok(finding, 'a divergence must be recorded so MG-54 cites the ids that exist');
    assert.match(finding.message, /OBSERVED ids are the ones that exist/);
  });

  it('leaves the divergence flag clear when the platform honoured the sender ids', async () => {
    const record = await buildSuccessRecord();
    assert.equal(record.idDivergence, false);
    assert.deepEqual(record.ids, record.requestedIds);
    assert.equal(
      record.findings.some(finding => finding.kind === 'id-divergence'),
      false
    );
  });
});

describe('a record never claims more than the confirmation concluded', () => {
  it('transcribes a timeout as an unconfirmed run with its own exit code', async () => {
    const messages = sentMessages();
    const confirmation = await confirmationFor({ fallback: { docs: [] } });
    assert.equal(confirmation.exitCode, EXIT.TIMEOUT, 'fixture setup');

    const record = buildEvidenceRecord({
      confirmation,
      containerDefinition: await cleanDefinition(),
      requestedIds: requestedIdsOf(messages),
      target: TARGET,
      now: fixedClock(),
    });

    assert.equal(record.confirmed, false);
    assert.equal(record.exitCode, EXIT.TIMEOUT);
    assert.deepEqual(record.ids, []);
    assert.equal(record.count, 0);
    // The wait bound is on the record on a failure path too — a timeout that
    // does not say what it timed out against is not readable.
    assert.equal(record.waitBoundMs, confirmation.waitBoundMs);
    assert.ok(record.waitBoundMs > 0);
    const finding = record.findings.find(item => item.kind === 'unconfirmed-run');
    assert.ok(finding, 'an unconfirmed run must say so in its own findings');
    assert.match(finding.message, /must not be read as proof/);
    // The requested ids are still recorded: three messages were sent, and MG-53
    // needs to know that something may yet arrive under those bodies.
    assert.deepEqual(record.requestedIds, requestedIdsOf(messages));
  });

  it('transcribes an auth failure without turning it into an absence', async () => {
    const confirmation = await confirmationFor({ script: [{ error: forbiddenError() }] });
    assert.equal(confirmation.exitCode, EXIT.AUTH, 'fixture setup');

    const record = buildEvidenceRecord({
      confirmation,
      containerDefinition: await cleanDefinition(),
      requestedIds: requestedIdsOf(sentMessages()),
      target: TARGET,
      now: fixedClock(),
    });

    assert.equal(record.confirmed, false);
    assert.equal(record.exitCode, EXIT.AUTH);
    assert.equal(record.count, 0);
    // The distinction is preserved in the artifact, not just in the exit code:
    // a reader must be able to tell "we could not look" from "nothing arrived".
    assert.notEqual(record.exitCode, EXIT.TIMEOUT);
    assert.match(record.outcomeReason, /NOTHING about whether the route delivered/);
  });

  it('refuses an internally inconsistent confirmation rather than recording it', async () => {
    const definition = await cleanDefinition();
    const { confirmation } = await successfulConfirmation();

    // confirmed:true with a nonzero exit code cannot both be true. Recording it
    // would produce an artifact claiming a success the confirmation did not.
    assert.throws(
      () =>
        buildEvidenceRecord({
          confirmation: { ...confirmation, exitCode: EXIT.TIMEOUT },
          containerDefinition: definition,
          requestedIds: requestedIdsOf(sentMessages()),
          target: TARGET,
          now: fixedClock(),
        }),
      err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
    );

    // confirmed:true with fewer observed documents than expected, likewise.
    assert.throws(
      () =>
        buildEvidenceRecord({
          confirmation: { ...confirmation, observedIds: [confirmation.observedIds[0]] },
          containerDefinition: definition,
          requestedIds: requestedIdsOf(sentMessages()),
          target: TARGET,
          now: fixedClock(),
        }),
      err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
    );
  });

  it('refuses a definition measured from a different container', async () => {
    const { confirmation } = await successfulConfirmation();
    assert.throws(
      () =>
        buildEvidenceRecord({
          confirmation,
          containerDefinition: DEFINITION_OF_ANOTHER_CONTAINER,
          requestedIds: [],
          target: TARGET,
          now: fixedClock(),
        }),
      err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
    );
  });

  it('refuses an unmeasured container definition rather than defaulting', async () => {
    const { confirmation } = await successfulConfirmation();
    for (const broken of [
      {},
      { partitionKeyPath: '/deviceId', partitionKeyField: 'deviceId' },
      { partitionKeyField: 'deviceId', measuredDefaultTtl: 604800 },
    ]) {
      assert.throws(
        () =>
          buildEvidenceRecord({
            confirmation,
            containerDefinition: broken,
            requestedIds: [],
            target: TARGET,
            now: fixedClock(),
          }),
        err => err instanceof FixtureError && err.exitCode === EXIT.USAGE,
        `a definition missing a measured field must refuse: ${JSON.stringify(broken)}`
      );
    }
  });

  it('refuses a target that does not name where the documents are', async () => {
    const { confirmation } = await successfulConfirmation();
    const definition = await cleanDefinition();
    for (const target of [
      undefined,
      {},
      { ...TARGET, container: '' },
      { ...TARGET, database: '   ' },
      { ...TARGET, account: null },
    ]) {
      assert.throws(
        () =>
          buildEvidenceRecord({
            confirmation,
            containerDefinition: definition,
            requestedIds: [],
            target,
            now: fixedClock(),
          }),
        err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
      );
    }
  });
});

describe('a run that changed the live system but observed nothing', () => {
  // The path a partial send takes: az accepted some messages, then failed, so no
  // read-back was ever attempted. Those messages are on their way to the
  // container, and a record that does not account for them leaves MG-53 facing a
  // source document it cannot distinguish from an unknown writer — which is the
  // condition that halts its whole sequence.
  const ACCEPTED_PREFIX = 1;

  async function partialSendRecord(overrides = {}) {
    const messages = sentMessages();
    const accepted = requestedIdsOf(messages).slice(0, ACCEPTED_PREFIX);
    const record = buildEvidenceRecord({
      confirmation: abortedConfirmation({
        runId: RUN_ID,
        exitCode: EXIT.SEND_FAILURE,
        reason: `the send aborted after ${accepted.length} of ${messages.length} message(s); those were accepted by IoT Hub and MAY be in the container, and NO read-back was attempted`,
        partitionValue: FIXTURE_DEVICE_ID,
        partitionKeyField: 'deviceId',
      }),
      containerDefinition: await cleanDefinition(),
      requestedIds: accepted,
      target: TARGET,
      now: fixedClock(),
      ...overrides,
    });
    return { record, accepted, messages };
  }

  it('records the ids az already accepted, so nothing it put in flight goes unaccounted for', async () => {
    const { record, accepted } = await partialSendRecord();

    // requestedIds is the ACCEPTED prefix, never the three the run intended:
    // recording an id az rejected would send MG-53 hunting a document that does
    // not exist, and omitting one it accepted is the halt this record prevents.
    assert.deepEqual(record.requestedIds, accepted);
    assert.equal(record.requestedCount, ACCEPTED_PREFIX);
    // Nothing was READ BACK, and the record says so rather than borrowing the
    // requested ids to look complete.
    assert.deepEqual(record.ids, []);
    assert.equal(record.count, 0);
    assert.equal(record.confirmed, false);
    assert.equal(record.exitCode, EXIT.SEND_FAILURE);
    // The shortfall is legible: three were expected, one was accepted, none seen.
    assert.equal(record.expectedCount, MESSAGES_PER_RUN);
    assert.equal(record.scope, 'not-attempted');
    assert.match(record.outcomeReason, /NO read-back was attempted/);
    const finding = record.findings.find(item => item.kind === 'unconfirmed-run');
    assert.ok(finding, 'a run nobody confirmed must say so in its own findings');

    // The mechanical property MG-53 depends on: the accepted id survives the
    // round trip to the artifact, under a key the runbook's field table names.
    const parsed = JSON.parse(serializeEvidenceRecord(record));
    assert.deepEqual(parsed.requestedIds, accepted);
    assert.ok(accepted.every(id => serializeEvidenceRecord(record).includes(id)));
  });

  it('claims no id divergence when no read-back observed anything', async () => {
    // A divergence is a comparison against what EXISTS. With nothing observed,
    // the empty set trivially differs from the requested one — reporting that as
    // divergence would put a platform behaviour nobody witnessed into the record
    // two tickets read as a program input.
    const { record } = await partialSendRecord();
    assert.equal(record.idDivergence, false);
    assert.equal(
      record.findings.some(finding => finding.kind === 'id-divergence'),
      false
    );

    // Same for the other two ways a run reaches the record having seen nothing.
    for (const spec of [{ fallback: { docs: [] } }, { script: [{ error: forbiddenError() }] }]) {
      const confirmation = await confirmationFor(spec);
      assert.equal(confirmation.observedCount, 0, 'fixture setup: expected nothing observed');
      const unobserved = buildEvidenceRecord({
        confirmation,
        containerDefinition: await cleanDefinition(),
        requestedIds: requestedIdsOf(sentMessages()),
        target: TARGET,
        now: fixedClock(),
      });
      assert.equal(
        unobserved.idDivergence,
        false,
        `exit ${confirmation.exitCode} claimed divergence`
      );
    }
  });

  it('still reports divergence on an unconfirmed run whose read-back DID see documents', async () => {
    // The guard above must not suppress a real observation. Two of three
    // documents arrived under ids the platform chose: the run is ambiguous, not
    // confirmed, and the divergence was genuinely witnessed — MG-54 cites the
    // ids that exist, and these are they.
    const messages = sentMessages();
    const delivered = messages
      .slice(0, 2)
      .map((message, index) => ({ ...message.body, id: `cosmos-assigned-${index}` }));
    const confirmation = await confirmationFor({ fallback: { docs: delivered } });
    assert.equal(confirmation.exitCode, EXIT.AMBIGUOUS, 'fixture setup');

    const record = buildEvidenceRecord({
      confirmation,
      containerDefinition: await cleanDefinition(),
      requestedIds: requestedIdsOf(messages),
      target: TARGET,
      now: fixedClock(),
    });

    assert.equal(record.confirmed, false);
    assert.equal(record.idDivergence, true);
    assert.deepEqual(record.ids, ['cosmos-assigned-0', 'cosmos-assigned-1']);
    assert.equal(record.count, 2);
    assert.deepEqual(record.requestedIds, requestedIdsOf(messages));
  });

  it('holds no credential and writes atomically, exactly like a confirmed record', async () => {
    // The failure paths are where a record is most likely to be assembled from
    // error text, so the guard matters here at least as much as on success.
    const { record } = await partialSendRecord();
    assert.deepEqual(findCredentialRisks(record), []);

    const dir = await tempDir();
    try {
      const target = path.join(dir, 'evidence.json');
      await writeEvidenceRecord(record, target);
      assert.deepEqual(await readdir(dir), ['evidence.json']);
      assert.deepEqual(
        JSON.parse(await readFile(target, 'utf8')).requestedIds,
        record.requestedIds
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('summarises itself as NOT CONFIRMED with the send failure named', async () => {
    const { record } = await partialSendRecord();
    const line = describeEvidence(record, '/tmp/mg67-evidence.json');
    assert.match(line, /NOT CONFIRMED \(send failure\)/);
    assert.match(line, new RegExp(`0/${MESSAGES_PER_RUN}`));
    assert.equal(line.includes('ID DIVERGENCE'), false);
  });
});

describe('no field of the record can hold a credential', () => {
  it('a clean record trips none of the guards', async () => {
    const record = await buildSuccessRecord({ containerDefinition: await driftDefinition() });
    assert.deepEqual(findCredentialRisks(record), []);
    // The partition-key trio is the one exemption, and it is exercised rather
    // than assumed: a guard that flagged partitionKeyPath would be turned off by
    // the next author.
    assert.equal(record.partitionKeyPath, '/deviceId');
    assert.equal(record.partitionKeyField, 'deviceId');
    assert.ok(record.partitionValue.length > 0);
  });

  it('the serialized record matches no credential shape, scanned independently', async () => {
    const serialized = serializeEvidenceRecord(
      await buildSuccessRecord({ containerDefinition: await driftDefinition() })
    );
    // Declared here rather than imported, so this assertion cannot pass by
    // agreeing with a weakened pattern list in the module under test.
    for (const pattern of [
      /AccountKey\s*=/i,
      /SharedAccessKey/i,
      /SharedAccessSignature/i,
      /\bBearer\s+\S/i,
      /-----BEGIN [A-Z ]*PRIVATE KEY-----/,
      /HostName\s*=/i,
      /\bsig\s*=/i,
      /[A-Za-z0-9+/]{40,}={0,2}/,
      /\b[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/,
    ]) {
      assert.equal(pattern.test(serialized), false, `the record matches ${pattern}`);
    }
  });

  it('refuses a key the record does not declare, however innocuous it looks', () => {
    const risks = findCredentialRisks({ runId: 'x', somethingNew: 'y' });
    assert.equal(risks.length, 1);
    assert.equal(risks[0].path, '$.somethingNew');
    assert.match(risks[0].detail, /closed key set/);
    assert.throws(
      () => assertNoCredentialShape({ runId: 'x', somethingNew: 'y' }),
      err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
    );
  });

  it('refuses a credential-shaped key name at any depth', () => {
    for (const shaped of [
      { deviceKey: 'x' },
      { connectionString: 'x' },
      { target: { sharedAccessSignature: 'x' } },
      { findings: [{ primaryKey: 'x' }] },
      { marker: { certificate: 'x' } },
    ]) {
      const risks = findCredentialRisks(shaped);
      assert.ok(risks.length > 0, `${JSON.stringify(shaped)} must be refused`);
      assert.throws(
        () => assertNoCredentialShape(shaped),
        err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
      );
    }
  });

  it('refuses a credential-shaped VALUE under a perfectly ordinary key', () => {
    // Every string here is SHAPED like a credential and is transparently not
    // one: the point is the shape, and a realistic-looking sample in a test file
    // is the thing HR1 forbids in the first place. Each spells out what it
    // stands for, so a diff-wide grep for credential shapes finds nothing a
    // reviewer has to go and verify.
    const secrets = [
      'HostName=notahub.example.invalid;DeviceId=notadevice;SharedAccessKey=NOT-A-KEY-THIS-IS-A-TEST-FIXTURE-VALUE-ONLY=',
      'Bearer not-a-real-bearer-token-test-fixture-value-only',
      'notaheader-testfixture.notapayload-testfixture.notasignature-testfixture',
      'AccountKey=NOT-A-KEY-THIS-IS-A-TEST-FIXTURE-VALUE-ONLY==',
      'notarealkeyNOTAREALKEYnotarealkeyNOTAREALKEY',
    ];
    for (const secret of secrets) {
      const risks = findCredentialRisks({ deviceId: secret });
      assert.ok(risks.length > 0, `a value shaped like ${secret.slice(0, 12)}... must be refused`);
      // The refusal names the field and the shape, never the value — the
      // failure path is exactly where HR1 says a secret must not appear.
      const message = (() => {
        try {
          assertNoCredentialShape({ deviceId: secret });
          return '';
        } catch (err) {
          return err.message;
        }
      })();
      assert.notEqual(message, '', 'the guard must throw');
      assert.equal(message.includes(secret), false, 'the refusal echoed the value');
      assert.ok(message.includes('deviceId'), 'the refusal must name the field');
    }
  });

  it('the guard runs at BUILD time, so a poisoned record never reaches a file', async () => {
    const { confirmation } = await successfulConfirmation();
    assert.throws(
      () =>
        buildEvidenceRecord({
          confirmation,
          containerDefinition: DEFINITION_OF_TARGET_CONTAINER,
          requestedIds: [],
          target: TARGET,
          deviceId: 'AccountKey=NOT-A-KEY-THIS-IS-A-TEST-FIXTURE-VALUE-ONLY==',
          now: fixedClock(),
        }),
      err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
    );
  });

  it('declares every key the builder emits, and no key it does not', async () => {
    const record = await buildSuccessRecord({ containerDefinition: await driftDefinition() });
    const seen = new Set();
    const walk = value => {
      if (Array.isArray(value)) return value.forEach(walk);
      if (value && typeof value === 'object') {
        for (const [key, child] of Object.entries(value)) {
          seen.add(key);
          walk(child);
        }
      }
    };
    walk(record);
    for (const key of seen) {
      assert.ok(EVIDENCE_RECORD_KEYS.has(key), `${key} is emitted but not declared`);
    }
    assert.ok(seen.size > 20, 'fixture setup: the record should be substantial');
  });
});

describe('writing the artifact', () => {
  it('writes the record atomically and leaves no partial behind', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const record = await buildSuccessRecord();
      const written = await writeEvidenceRecord(record, target);

      assert.equal(written.path, target);
      const onDisk = await readFile(target, 'utf8');
      assert.equal(onDisk, serializeEvidenceRecord(record));
      assert.deepEqual(JSON.parse(onDisk).ids, record.ids);
      // Exactly one file: the partial was renamed, not left as debris that a
      // reader could pick up and mistake for evidence.
      assert.deepEqual(await readdir(dir), ['mg67-evidence.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('leaves neither a partial nor a target file when the write fails', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const record = await buildSuccessRecord();
      const removed = [];
      const fs = {
        stat: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        writeFile: async (file, contents) => writeFile(file, contents, 'utf8'),
        rename: async () => {
          throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
        },
        rm: async (file, options) => {
          removed.push(file);
          return rm(file, options);
        },
      };

      await assert.rejects(
        writeEvidenceRecord(record, target, { fs }),
        err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
      );
      assert.deepEqual(removed, [partialPathFor(target)]);
      assert.deepEqual(await readdir(dir), [], 'a failed write must leave nothing behind');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses to overwrite an earlier run record, and does not touch it', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const first = await buildSuccessRecord();
      await writeEvidenceRecord(first, target);

      const second = await buildSuccessRecord({
        requestedIds: requestedIdsOf(sentMessages()),
        build: { now: fixedClock(RUN_MILLIS + 60_000) },
      });
      await assert.rejects(
        writeEvidenceRecord(second, target),
        err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
      );
      // The earlier run's documents are still in the container; clobbering the
      // record of them manufactures the unrecorded-document condition MG-53
      // halts on.
      assert.equal(await readFile(target, 'utf8'), serializeEvidenceRecord(first));
      assert.deepEqual(await readdir(dir), ['mg67-evidence.json']);

      // Overwriting is possible, but only deliberately.
      await writeEvidenceRecord(second, target, { overwrite: true });
      assert.equal(await readFile(target, 'utf8'), serializeEvidenceRecord(second));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('is byte-reproducible under the injected clock', async () => {
    const definition = await cleanDefinition();
    const messages = sentMessages();
    const build = async () => {
      const { confirmation } = await successfulConfirmation();
      return serializeEvidenceRecord(
        buildEvidenceRecord({
          confirmation,
          containerDefinition: definition,
          requestedIds: requestedIdsOf(messages),
          target: TARGET,
          now: fixedClock(),
        })
      );
    };
    assert.equal(await build(), await build());
  });

  it('refuses a path that is not a path', async () => {
    const record = await buildSuccessRecord();
    for (const bad of ['', '   ', undefined, null, 42]) {
      await assert.rejects(
        writeEvidenceRecord(record, bad),
        err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
      );
    }
  });
});

describe('the operator-facing summary', () => {
  it('names the outcome, the counts and the retention without inventing any', async () => {
    const record = await buildSuccessRecord();
    const line = describeEvidence(record, '/tmp/mg67-evidence.json');
    assert.match(line, /CONFIRMED/);
    assert.match(line, new RegExp(`${MESSAGES_PER_RUN}/${MESSAGES_PER_RUN}`));
    assert.match(line, /meatgeek-v2-dev-db\/temperatures/);
    assert.match(line, /604800s/);
    assert.equal(line.includes('NOT CONFIRMED'), false);
  });

  it('says NOT CONFIRMED, with the failure label, for an unconfirmed run', async () => {
    const confirmation = await confirmationFor({ fallback: { docs: [] } });
    const record = buildEvidenceRecord({
      confirmation,
      containerDefinition: await cleanDefinition(),
      requestedIds: requestedIdsOf(sentMessages()),
      target: TARGET,
      now: fixedClock(),
    });
    const line = describeEvidence(record, '/tmp/mg67-evidence.json');
    assert.match(line, /NOT CONFIRMED \(confirmation timeout\)/);
    assert.match(line, /0\/3/);
  });
});

describe('the module holds no identity and reads no ambient state', () => {
  it('imports no Azure package and opens no socket', async () => {
    const source = await readLocal('./evidence.mjs');
    for (const pattern of [
      /@azure\//,
      /node:http/,
      /node:net/,
      /node:child_process/,
      /\bfetch\(/,
      /process\.env/,
    ]) {
      assert.equal(pattern.test(source), false, `evidence.mjs matches ${pattern}`);
    }
  });

  it('records the measured retention and never a hardcoded one', async () => {
    const source = await readLocal('./evidence.mjs');
    // No retention literal exists for a later edit to reach for as a fallback.
    assert.equal(/\b604800\b/.test(source), false, 'evidence.mjs carries a retention literal');
    assert.equal(/\b7\s*\*\s*86400\b/.test(source), false);
  });
});
