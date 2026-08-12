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
import {
  link as realLink,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseContainerDefinition } from './container-definition.mjs';
import { fakeClock, fakeReader, forbiddenError } from './fake-azure.mjs';
import {
  CONFIRMATION_QUERY,
  EXIT,
  FIXTURE_DEVICE_ID,
  FixtureError,
  ID_SET_NAMES,
  MESSAGES_PER_RUN,
  PARTITION_VALUE_ABSENT,
  PARTITION_VALUE_UNUSABLE,
  RUN_ID_FIELD,
  SEQUENCE_FIELD,
  SYNTHETIC_MARKER,
  SYNTHETIC_MARKER_FIELD,
  TICKET,
  abortedConfirmation,
  buildFixtureMessages,
  confirmArrival,
  createRunLedger,
  exitLabel,
} from './fixture-core.mjs';
import {
  EVIDENCE_KIND,
  EVIDENCE_RECORD_KEYS,
  EVIDENCE_SCHEMA_VERSION,
  OUTCOME_NAMES,
  PARTIAL_SUFFIX,
  SUPERSEDED_SUFFIX,
  UNKNOWN_WRITER_CHECK,
  assertNoCredentialShape,
  buildEvidenceRecord,
  classifyPartitionValues,
  describeDestination,
  describeEvidence,
  findCredentialRisks,
  foreignPartials,
  outcomeName,
  partialPathFor,
  partialsForDestination,
  preflightEvidenceDestination,
  probePathFor,
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

// A confirmed record for an ARBITRARY run id. Two records built by
// buildSuccessRecord() share this file's fixed run id, which is exactly the
// thing the concurrency tests below have to vary: a per-run temp path is
// indistinguishable from a per-destination one until two run ids differ.
async function buildRecordForRun(runId, millis = RUN_MILLIS) {
  const messages = buildFixtureMessages({
    runId,
    partitionKeyField: 'deviceId',
    now: fixedClock(RUN_MILLIS - 5000),
  });
  const clock = fakeClock({ start: RUN_MILLIS - 5000 });
  const confirmation = await confirmArrival({
    reader: fakeReader({ script: [{ docs: [] }, { docs: messages.map(message => message.body) }] }),
    runId,
    partitionKeyField: 'deviceId',
    partitionValue: FIXTURE_DEVICE_ID,
    now: clock.now,
    sleep: clock.sleep,
  });
  assert.equal(confirmation.confirmed, true, 'fixture setup: expected a confirmed result');
  return buildEvidenceRecord({
    confirmation,
    containerDefinition: await cleanDefinition(),
    requestedIds: requestedIdsOf(messages),
    target: TARGET,
    now: fixedClock(millis),
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
    // Both directions, deliberately: the finding may not be read as proof the
    // path carried a message, and may not be read as proof that it did not.
    assert.match(finding.message, /must not be read either as proof/);
    assert.match(finding.message, /or as proof that it did not/);
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

describe('the evidence-emission contract: one record, four id sets, every outcome', () => {
  // These tests assert the CONTRACT rather than the paths that violated it
  // before it existed. The property is: whatever the run did, there is a record,
  // and its four id sets are individually correct — requested (attempted),
  // accepted (az said yes), ambiguous (az said no and acceptance is UNKNOWN),
  // observed (read back, never discarded). A record that collapses any two of
  // them is unusable to MG-53 and MG-54, and a run that emits none at all leaves
  // documents nothing accounts for.

  // The ledger, driven exactly as the sender drives it: request immediately
  // before the attempt, then exactly one of accept / markAmbiguous.
  function ledgerAfterSend({ messages, failAt = null, runId = RUN_ID }) {
    const ledger = createRunLedger({ runId });
    for (const [index, message] of messages.entries()) {
      ledger.request(message.body.id);
      if (failAt !== null && index >= failAt) {
        // az reported failure. Acceptance is UNKNOWN from here: the CLI can fail
        // after IoT Hub took the message, so the run stops and every id from the
        // failure onward is ambiguous rather than not-sent.
        ledger.markAmbiguous(message.body.id);
        break;
      }
      ledger.accept(message.body.id);
    }
    return ledger;
  }

  const ID_SET_COUNTS = Object.freeze({
    requestedIds: 'requestedCount',
    acceptedIds: 'acceptedCount',
    ambiguousIds: 'ambiguousCount',
    observedIds: 'observedCount',
  });

  function assertIdSets(record, expected) {
    for (const name of ID_SET_NAMES) {
      assert.deepEqual(record[name], expected[name], `${name} is wrong`);
      assert.equal(
        record[ID_SET_COUNTS[name]],
        expected[name].length,
        `${ID_SET_COUNTS[name]} must equal ${name}.length`
      );
    }
    // The union a downstream ticket acts on: everything that is, or may be, in
    // the container. Never a subset of it, and never inferred downstream out of
    // three fields.
    for (const id of [...expected.acceptedIds, ...expected.ambiguousIds, ...expected.observedIds]) {
      assert.ok(record.accountableIds.includes(id), `${id} is missing from accountableIds`);
    }
    assert.equal(record.accountableCount, record.accountableIds.length);
    // The schema-v1 aliases name the OBSERVED set and nothing else.
    assert.deepEqual(record.ids, record.observedIds);
    assert.equal(record.count, record.observedCount);
  }

  it('names a distinct outcome for every exit code the tool can produce', () => {
    const codes = Object.values(EXIT);
    const names = codes.map(code => outcomeName(code));
    for (const [index, name] of names.entries()) {
      assert.equal(typeof name, 'string', `exit ${codes[index]} has no outcome name`);
      assert.notEqual(name.trim(), '');
    }
    // Distinct, so a consumer branching on the name branches on the outcome. Two
    // outcomes sharing a name is the same defect as two sharing an exit code.
    assert.equal(new Set(names).size, codes.length);
    assert.equal(Object.keys(OUTCOME_NAMES).length, codes.length);
  });

  it('builds a record for EVERY terminal outcome the tool can reach after a send', async () => {
    const definition = await cleanDefinition();
    const messages = sentMessages();
    // A run that attempted one message and got a failure back: the id set shape
    // is the same whatever the failure was, which is the point — the outcome
    // varies, the obligation to record does not.
    const attempted = messages[0].body.id;

    for (const code of Object.values(EXIT).filter(value => value !== EXIT.OK)) {
      const ledger = createRunLedger({ runId: RUN_ID });
      ledger.request(attempted);
      ledger.markAmbiguous(attempted);
      const record = buildEvidenceRecord({
        idSets: ledger.snapshot(),
        // No confirmation at all: several of these outcomes happen before the
        // read-back is ever reached, and the absence of a confirmation may never
        // be a reason to omit the record.
        outcome: { exitCode: code, reason: `terminal outcome ${exitLabel(code)}` },
        runId: RUN_ID,
        containerDefinition: definition,
        target: TARGET,
        now: fixedClock(),
      });

      assert.equal(record.exitCode, code);
      assert.equal(record.outcome, outcomeName(code));
      assert.equal(record.exitLabel, exitLabel(code));
      assert.equal(record.confirmed, false);
      assert.equal(record.attempted, true);
      assert.equal(record.uncertain, true, `exit ${code} must be recorded as uncertain`);
      assertIdSets(record, {
        requestedIds: [attempted],
        acceptedIds: [],
        ambiguousIds: [attempted],
        observedIds: [],
      });
      // Round-trips: the artifact is a program input, not a log line.
      assert.deepEqual(JSON.parse(serializeEvidenceRecord(record)).accountableIds, [attempted]);
    }
  });

  it('builds a confirmed record whose four sets agree, and which is the only certain one', async () => {
    const messages = sentMessages();
    const { confirmation } = await successfulConfirmation();
    const ids = requestedIdsOf(messages);
    const record = buildEvidenceRecord({
      ledger: ledgerAfterSend({ messages }),
      confirmation,
      containerDefinition: await cleanDefinition(),
      target: TARGET,
      now: fixedClock(),
    });

    assert.equal(record.confirmed, true);
    assert.equal(record.exitCode, EXIT.OK);
    assert.equal(record.outcome, outcomeName(EXIT.OK));
    // The ONE case where nothing is uncertain: every message was accepted and
    // every document was read back.
    assert.equal(record.uncertain, false);
    assertIdSets(record, {
      requestedIds: ids,
      acceptedIds: ids,
      ambiguousIds: [],
      observedIds: ids,
    });
    assert.equal(
      record.findings.some(finding => finding.kind === 'ambiguous-acceptance'),
      false
    );
  });

  it('records az failing on message 1 of 3 WITHOUT claiming nothing was written', async () => {
    // The path that used to emit no artifact at all and tell the operator
    // "nothing was written". az failed on the FIRST message, so nothing was
    // accepted — and acceptance is UNKNOWN, not negative: the CLI can fail after
    // IoT Hub took the message.
    const messages = sentMessages();
    const first = messages[0].body.id;
    const record = buildEvidenceRecord({
      ledger: ledgerAfterSend({ messages, failAt: 0 }),
      outcome: {
        exitCode: EXIT.SEND_FAILURE,
        reason: 'az reported failure on the first message; acceptance is unknown',
      },
      runId: RUN_ID,
      containerDefinition: await cleanDefinition(),
      target: TARGET,
      now: fixedClock(),
    });

    assert.equal(record.exitCode, EXIT.SEND_FAILURE);
    assert.equal(record.attempted, true);
    assert.equal(record.uncertain, true);
    assertIdSets(record, {
      requestedIds: [first],
      acceptedIds: [],
      ambiguousIds: [first],
      observedIds: [],
    });
    // The crux, recorded as a finding rather than left for a reader to infer
    // from an empty acceptedIds.
    const finding = record.findings.find(item => item.kind === 'ambiguous-acceptance');
    assert.ok(finding, 'an unknown acceptance must be recorded as its own finding');
    assert.match(finding.message, /UNKNOWN acceptance/);
    assert.match(finding.message, /never be read as evidence that nothing was written/);
    // And the id is in the set MG-53 accounts for, which is what makes the
    // difference between a halt it can diagnose and one it cannot.
    assert.deepEqual(record.accountableIds, [first]);
    // A count of zero observed documents is never on its own the claim that
    // nothing arrived: the record says so in three independent fields.
    assert.equal(record.count, 0);
    assert.equal(record.accountableCount, 1);
    assert.equal(record.uncertain, true);
  });

  it('keeps a document it observed when the run then aborts on auth', async () => {
    // A read-back saw one document, and the NEXT poll was refused. The auth
    // failure is new information about the reader, not a retraction of what was
    // already read — and the id it read is in the container whatever happens
    // next.
    const messages = sentMessages();
    const delivered = messages[0].body;
    const confirmation = await confirmationFor({
      script: [{ docs: [delivered] }, { error: forbiddenError() }],
    });
    assert.equal(confirmation.exitCode, EXIT.AUTH, 'fixture setup');
    assert.deepEqual([...confirmation.observedIds], [delivered.id], 'fixture setup');

    const record = buildEvidenceRecord({
      ledger: ledgerAfterSend({ messages }),
      confirmation,
      containerDefinition: await cleanDefinition(),
      target: TARGET,
      now: fixedClock(),
    });

    assert.equal(record.exitCode, EXIT.AUTH);
    assert.equal(record.confirmed, false);
    assert.equal(record.uncertain, true);
    assertIdSets(record, {
      requestedIds: requestedIdsOf(messages),
      acceptedIds: requestedIdsOf(messages),
      ambiguousIds: [],
      observedIds: [delivered.id],
    });
    // An auth failure is never an absence, and never a timeout.
    assert.notEqual(record.exitCode, EXIT.TIMEOUT);
    assert.equal(record.count, 1);

    // And the observed id cannot be lost after the fact: the record's lists are
    // frozen, so a consumer cannot drop an id the run recorded.
    assert.throws(() => record.observedIds.pop(), TypeError);
    assert.throws(() => record.accountableIds.push('invented'), TypeError);
    assert.deepEqual(record.observedIds, [delivered.id]);
  });

  it('refuses an outcome that disagrees with the confirmation it was given', async () => {
    const { confirmation } = await successfulConfirmation();
    const definition = await cleanDefinition();
    assert.throws(
      () =>
        buildEvidenceRecord({
          ledger: ledgerAfterSend({ messages: sentMessages() }),
          confirmation,
          // A caller believing it recorded a timeout while the confirmation says
          // otherwise would write an artifact nobody can audit.
          outcome: { exitCode: EXIT.TIMEOUT, reason: 'disagrees with the confirmation' },
          containerDefinition: definition,
          target: TARGET,
          now: fixedClock(),
        }),
      err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
    );
  });

  it('folds the read-back ids in even when the snapshot was taken before it', async () => {
    // Observation is monotonic in THREE places — the ledger, the confirmation and
    // here — so a caller that snapshotted early cannot lose an id by being
    // early.
    const messages = sentMessages();
    const { confirmation } = await successfulConfirmation();
    const stale = ledgerAfterSend({ messages }).snapshot(); // no confirmation folded in
    assert.deepEqual([...stale.observedIds], [], 'fixture setup: a stale snapshot saw nothing');

    const record = buildEvidenceRecord({
      idSets: stale,
      confirmation,
      containerDefinition: await cleanDefinition(),
      target: TARGET,
      now: fixedClock(),
    });
    assert.deepEqual(record.observedIds, requestedIdsOf(messages));
    assert.equal(record.confirmed, true);
  });

  it('refuses a ledger and a confirmation that name different runs', async () => {
    const { confirmation } = await successfulConfirmation();
    const otherRun = `${RUN_ID}-other`;
    assert.throws(
      () =>
        buildEvidenceRecord({
          ledger: ledgerAfterSend({ messages: sentMessages(), runId: otherRun }),
          confirmation,
          containerDefinition: DEFINITION_OF_TARGET_CONTAINER,
          target: TARGET,
          now: fixedClock(),
        }),
      err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
    );
  });

  it('refuses an outcome that could be mistaken for a success, or that has no name', async () => {
    const definition = await cleanDefinition();
    const ledger = createRunLedger({ runId: RUN_ID });
    ledger.request('mg67-doc-1');
    ledger.markAmbiguous('mg67-doc-1');
    const build = extra =>
      buildEvidenceRecord({
        idSets: ledger.snapshot(),
        runId: RUN_ID,
        containerDefinition: definition,
        target: TARGET,
        now: fixedClock(),
        ...extra,
      });

    // No confirmation and no outcome: the caller has to say what happened. It
    // may not omit the record, and it may not leave the outcome blank either.
    assert.throws(build, err => err instanceof FixtureError && err.exitCode === EXIT.USAGE);
    for (const outcome of [
      { exitCode: EXIT.OK, reason: 'a run with no confirmation cannot be confirmed' },
      { exitCode: -1, reason: 'not an outcome' },
      { exitCode: EXIT.TIMEOUT },
      { exitCode: EXIT.TIMEOUT, reason: '   ' },
    ]) {
      assert.throws(
        () => build({ outcome }),
        err => err instanceof FixtureError && err.exitCode === EXIT.USAGE,
        `outcome ${JSON.stringify(outcome)} must be refused`
      );
    }
    // An exit code this tool never declares: MG-53 cannot gate on an outcome it
    // cannot name, so the record is refused rather than written unreadable.
    assert.throws(
      () => build({ outcome: { exitCode: 99, reason: 'undeclared' } }),
      err => err instanceof FixtureError && err.exitCode === EXIT.USAGE
    );
  });

  it('refuses an id set that is not a set of usable ids', async () => {
    const definition = await cleanDefinition();
    for (const broken of [
      { requestedIds: 'mg67-doc-1' },
      { requestedIds: ['mg67-doc-1'], acceptedIds: [''] },
      { requestedIds: ['mg67-doc-1'], ambiguousIds: [null] },
      { observedIds: [{ id: 'mg67-doc-1' }] },
    ]) {
      assert.throws(
        () =>
          buildEvidenceRecord({
            idSets: broken,
            runId: RUN_ID,
            outcome: { exitCode: EXIT.SEND_FAILURE, reason: 'send failed' },
            containerDefinition: definition,
            target: TARGET,
            now: fixedClock(),
          }),
        err => err instanceof FixtureError && err.exitCode === EXIT.USAGE,
        `id sets ${JSON.stringify(broken)} must be refused — an id that cannot be named cannot be evidence`
      );
    }
  });

  it('adapts a caller that knows only what it attempted, fail-closed', async () => {
    // The compatibility path: no ledger, just the ids a caller attempted. Every
    // one that was not read back is recorded as UNKNOWN acceptance, never as
    // accepted and never as not-sent.
    const messages = sentMessages();
    const confirmation = await confirmationFor({ fallback: { docs: [] } });
    assert.equal(confirmation.exitCode, EXIT.TIMEOUT, 'fixture setup');
    const record = buildEvidenceRecord({
      requestedIds: requestedIdsOf(messages),
      confirmation,
      containerDefinition: await cleanDefinition(),
      target: TARGET,
      now: fixedClock(),
    });
    assertIdSets(record, {
      requestedIds: requestedIdsOf(messages),
      acceptedIds: [],
      ambiguousIds: requestedIdsOf(messages),
      observedIds: [],
    });
    assert.equal(record.uncertain, true);
    assert.ok(record.findings.some(finding => finding.kind === 'ambiguous-acceptance'));
  });

  it('records the documents the read-back could NOT attribute to this run, apart from its own', async () => {
    // A document the CORRELATED read-back returned that this run cannot claim.
    // Note the stray carries THIS run's correlator and is missing the marker —
    // it has to, because the query filtered on the run id, which is exactly why
    // this set is not and cannot be the unknown-writer stop condition (see the
    // retraction suite below). It is still named in the artifact: an operator
    // cannot investigate a document nobody named, and it is kept strictly out of
    // the observed set, since counting it as ours would tell MG-53 that a
    // document it must halt on is accounted for.
    const messages = sentMessages();
    const stray = { id: 'not-ours-0', [RUN_ID_FIELD]: RUN_ID };
    const confirmation = await confirmationFor({ fallback: { docs: [stray] } });
    assert.equal(confirmation.exitCode, EXIT.MARKER_VIOLATION, 'fixture setup');

    const record = buildEvidenceRecord({
      ledger: ledgerAfterSend({ messages }),
      confirmation,
      containerDefinition: await cleanDefinition(),
      target: TARGET,
      now: fixedClock(),
    });
    assert.deepEqual(record.anomalousIds, [stray.id]);
    assert.equal(record.anomalousCount, 1);
    assert.equal(record.observedIds.includes(stray.id), false);
    assert.equal(record.accountableIds.includes(stray.id), false);
    const finding = record.findings.find(item => item.kind === 'unattributable-documents');
    assert.ok(finding, 'an unattributable document must be recorded as a finding');
    assert.match(describeEvidence(record, '/tmp/e.json'), /1 UNATTRIBUTABLE/);
  });
});

describe('the record retracts the unknown-writer claim it cannot honour', () => {
  // The defect this suite pins down: `anomalousIds` was DESCRIBED as the artifact
  // form of the runbook's first stop condition — any unexpected document in the
  // source containers, i.e. an unknown writer — while the read-back it derives
  // from filters on this run's own correlator. So it can STRUCTURALLY never
  // contain such a document, and a permanently-empty `anomalousIds` read by
  // MG-53 as "no unknown writer" is a vacuous proof of precisely the kind this
  // ticket exists to eliminate. The claim is retracted, in the artifact MG-53
  // parses mechanically, and these tests hold the retraction in place.

  // Anchored to the real query rather than to prose. If a later author makes the
  // read-back unfiltered, this test fails and forces the retraction to be
  // reconsidered on purpose instead of leaving a stale disclaimer behind.
  it('is filtered to this run, which is WHY the check is impossible here', () => {
    assert.match(
      CONFIRMATION_QUERY,
      new RegExp(`c\\.${RUN_ID_FIELD}\\s*=\\s*@runId`),
      'the confirmation query must pin this run id — the retraction below is justified by this predicate'
    );
  });

  it('declares the check UNPERFORMED, naming what does perform it', async () => {
    const parsed = JSON.parse(serializeEvidenceRecord(await buildSuccessRecord()));

    assert.equal(parsed.unknownWriterCheck.checked, false);
    assert.equal(parsed.unknownWriterCheck.by, 'operator-unfiltered-enumeration');
    assert.equal(parsed.unknownWriterCheck.kind, 'not-performed-by-this-tool');
    // The message has to say the two things a consumer would otherwise get
    // wrong: that the read-back is filtered, and that an unfiltered enumeration
    // is what checks the stop condition.
    assert.match(parsed.unknownWriterCheck.message, /filtered/i);
    assert.match(parsed.unknownWriterCheck.message, /unfiltered enumeration/i);
    assert.deepEqual(parsed.unknownWriterCheck, { ...UNKNOWN_WRITER_CHECK });
  });

  // The exact reading that would be wrong. A confirmed run with nothing
  // anomalous is the COMMON case — every healthy run looks like this — so it is
  // the case in which a consumer is most likely to mistake the zero for a
  // cleared stop condition, and the record must contradict that reading on it.
  it('still declares it unperformed on a clean run, where the zero would mislead', async () => {
    const record = await buildSuccessRecord();
    assert.equal(record.anomalousCount, 0, 'fixture setup: the clean run finds nothing anomalous');
    assert.equal(record.confirmed, true);
    assert.equal(record.unknownWriterCheck.checked, false);
  });

  // Present on EVERY outcome, for the same reason the id sets are: a consumer
  // that has to remember to look for a field will read its absence as a pass.
  it('carries the declaration on every outcome, not only the confirmed one', async () => {
    const messages = sentMessages();
    const timedOut = buildEvidenceRecord({
      requestedIds: requestedIdsOf(messages),
      confirmation: await confirmationFor({ fallback: { docs: [] } }),
      containerDefinition: await cleanDefinition(),
      target: TARGET,
      now: fixedClock(),
    });
    const aborted = buildEvidenceRecord({
      confirmation: abortedConfirmation({
        runId: RUN_ID,
        exitCode: EXIT.SEND_FAILURE,
        reason: 'the send aborted before any read-back was attempted',
        partitionValue: FIXTURE_DEVICE_ID,
        partitionKeyField: 'deviceId',
      }),
      containerDefinition: await cleanDefinition(),
      requestedIds: requestedIdsOf(messages).slice(0, 1),
      target: TARGET,
      now: fixedClock(),
    });

    for (const [context, record] of [
      ['timeout', timedOut],
      ['aborted send', aborted],
    ]) {
      assert.equal(record.exitCode === EXIT.OK, false, `${context}: fixture setup`);
      assert.equal(record.unknownWriterCheck.checked, false, context);
      assert.match(record.unknownWriterCheck.message, /unfiltered enumeration/i, context);
    }
  });

  // The retraction is only worth anything if the claim is gone from the place it
  // actually lived: the finding's own prose, which is what an operator reads and
  // what a consumer greps. A finding that still called itself the stop condition
  // would make the new field a contradiction rather than a correction.
  it('does not claim the stop condition in the unattributable finding', async () => {
    const stray = { id: 'not-ours-0', [RUN_ID_FIELD]: RUN_ID };
    const record = buildEvidenceRecord({
      requestedIds: requestedIdsOf(sentMessages()),
      confirmation: await confirmationFor({ fallback: { docs: [stray] } }),
      containerDefinition: await cleanDefinition(),
      target: TARGET,
      now: fixedClock(),
    });

    const finding = record.findings.find(item => item.kind === 'unattributable-documents');
    assert.ok(finding, 'fixture setup: the stray must still be recorded as a finding');
    // It says what it DOES detect...
    assert.match(finding.message, new RegExp(RUN_ID_FIELD));
    // ...and explicitly disclaims what it does not.
    assert.match(finding.message, /NOT evidence about an unknown writer/);
    assert.match(finding.message, /unknownWriterCheck/);
    assert.equal(
      /first stop condition|unexpected document in the source containers/i.test(finding.message),
      false,
      'the finding must not describe itself as the unknown-writer stop condition it cannot detect'
    );
  });

  // Nothing anywhere in the serialized artifact may assert the detection. This
  // is the mechanical version of the rule, so a claim reintroduced under some
  // other key is caught too.
  it('asserts the detection nowhere in the serialized artifact', async () => {
    for (const record of [
      await buildSuccessRecord(),
      await buildSuccessRecord({ containerDefinition: await driftDefinition() }),
    ]) {
      const serialized = serializeEvidenceRecord(record);
      const claims = [
        /first stop condition/i,
        /stop condition 1 (?:is|was) (?:checked|satisfied|cleared)/i,
        /no unknown writer/i,
        /unexpected document in the source containers is/i,
      ];
      for (const claim of claims) {
        assert.equal(
          claim.test(serialized),
          false,
          `the artifact must not claim the unknown-writer detection: ${claim}`
        );
      }
      // The one permitted mention is the retraction, and it is a denial.
      assert.match(serialized, /is NOT checked by this tool/);
    }
  });
});

describe('idDivergence is witnessed, never inferred', () => {
  it('is FALSE for an incomplete read-back whose ids the platform honoured', async () => {
    // Two of three arrived, under the ids the sender chose. That is an
    // incomplete read-back — nothing about it witnesses a platform renaming, and
    // asserting one in the artifact MG-53 and MG-54 parse mechanically would have
    // a downstream ticket act on a fabricated claim.
    const messages = sentMessages();
    const delivered = messages.slice(0, 2).map(message => message.body);
    const confirmation = await confirmationFor({ fallback: { docs: delivered } });
    assert.equal(confirmation.exitCode, EXIT.AMBIGUOUS, 'fixture setup');

    const record = buildEvidenceRecord({
      idSets: {
        runId: RUN_ID,
        requestedIds: requestedIdsOf(messages),
        acceptedIds: requestedIdsOf(messages),
        ambiguousIds: [],
        observedIds: [],
      },
      confirmation,
      containerDefinition: await cleanDefinition(),
      target: TARGET,
      now: fixedClock(),
    });

    assert.equal(record.count, 2);
    assert.equal(record.requestedCount, MESSAGES_PER_RUN);
    assert.equal(
      record.idDivergence,
      false,
      'a count shortfall is an incomplete read-back, not a witnessed divergence'
    );
    assert.equal(
      record.findings.some(finding => finding.kind === 'id-divergence'),
      false
    );
    assert.equal(describeEvidence(record, '/tmp/e.json').includes('ID DIVERGENCE'), false);
  });

  it('is TRUE only when an OBSERVED document carries an id nobody requested', async () => {
    const messages = sentMessages();
    // One document arrived under an id of the platform's choosing. Witnessed:
    // the document exists and its id is not one of ours.
    const delivered = messages.map((message, index) =>
      index === 0 ? { ...message.body, id: 'cosmos-assigned-0' } : message.body
    );
    const { confirmation } = await successfulConfirmation(delivered);
    const record = buildEvidenceRecord({
      ledger: (() => {
        const ledger = createRunLedger({ runId: RUN_ID });
        for (const message of messages) {
          ledger.request(message.body.id);
          ledger.accept(message.body.id);
        }
        return ledger;
      })(),
      confirmation,
      containerDefinition: await cleanDefinition(),
      target: TARGET,
      now: fixedClock(),
    });

    assert.equal(record.idDivergence, true);
    assert.ok(record.observedIds.includes('cosmos-assigned-0'));
    assert.deepEqual(record.requestedIds, requestedIdsOf(messages));
    const finding = record.findings.find(item => item.kind === 'id-divergence');
    assert.ok(finding);
    assert.match(finding.message, /1 document\(s\) were OBSERVED under an id the sender did not/);
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

  it('scans all FOUR id sets, not just the one the record used to carry', async () => {
    // The guard walks the record structurally, so this holds for a set added
    // later too — but the contract now has four, and each of them is a place a
    // caller could put a string this module did not author.
    const definition = await cleanDefinition();
    const shaped = 'AccountKey=NOT-A-KEY-THIS-IS-A-TEST-FIXTURE-VALUE-ONLY==';
    for (const name of ID_SET_NAMES) {
      const idSets = {
        runId: RUN_ID,
        requestedIds: ['mg67-doc-1'],
        acceptedIds: ['mg67-doc-1'],
        ambiguousIds: [],
        observedIds: [],
        [name]: [shaped],
      };
      let message = '';
      try {
        buildEvidenceRecord({
          idSets,
          runId: RUN_ID,
          outcome: { exitCode: EXIT.SEND_FAILURE, reason: 'send failed' },
          containerDefinition: definition,
          target: TARGET,
          now: fixedClock(),
        });
      } catch (err) {
        assert.ok(err instanceof FixtureError && err.exitCode === EXIT.USAGE);
        message = err.message;
      }
      assert.notEqual(message, '', `a credential-shaped id in ${name} must be refused`);
      // Names the path, never the value — the refusal is an output path too.
      assert.ok(message.includes(name), `the refusal must name ${name}`);
      assert.equal(message.includes(shaped), false, 'the refusal echoed the value');
    }
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
        // The PUBLICATION step, which is now an exclusive create rather than a
        // rename. A failure here is not EEXIST — it is the filesystem refusing
        // for some other reason — and it must still leave nothing behind.
        link: async () => {
          throw Object.assign(new Error('EXDEV'), { code: 'EXDEV' });
        },
        rm: async (file, options) => {
          removed.push(file);
          return rm(file, options);
        },
      };

      await assert.rejects(
        writeEvidenceRecord(record, target, { fs }),
        // NOT usage. This function runs only after the send, so every refusal it
        // makes describes a run whose documents are in the container.
        err => err instanceof FixtureError && err.exitCode === EXIT.EVIDENCE_UNRECORDED
      );
      assert.deepEqual(removed, [partialPathFor(target, record.runId)]);
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
        err => err instanceof FixtureError && err.exitCode === EXIT.EVIDENCE_UNRECORDED
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
        err => err instanceof FixtureError && err.exitCode === EXIT.EVIDENCE_UNRECORDED
      );
    }
  });
});

// ===========================================================================
// THE EVIDENCE-WRITE INTEGRITY CONTRACT.
//
// The record is the artifact MG-53 and MG-54 consume mechanically to decide
// whether to halt a migration. So the writer must never DESTROY a record, never
// PUBLISH THE WRONG ONE under the right name, and never report success when it
// has done either. The second is the worse failure of the two: a missing file is
// detectable downstream, a well-formed file holding another run's ids is not.
//
// These tests assert the CONTRACT rather than the three symptoms that exposed
// it, so a repair that fixes the symptom and reopens the hole elsewhere fails
// here too.
// ===========================================================================
describe('the evidence write never destroys or swaps a record', () => {
  const OTHER_RUN_ID = 'mg-67-run-00000000-0000-4000-8000-00000000dead';

  // Rule 1. Only ENOENT is an absence.
  it('refuses a destination whose state cannot be READ, rather than writing over it', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const earlier = await buildSuccessRecord();
      await writeEvidenceRecord(earlier, target);

      const writes = [];
      const record = await buildSuccessRecord({ build: { now: fixedClock(RUN_MILLIS + 60_000) } });
      // The stat fails for a reason that is NOT "no file there". Read as an
      // absence — which is what a bare `catch {}` does — the write below renames
      // straight over the earlier run's record and returns success, losing the
      // only account of documents that are still in the container.
      const fs = {
        stat: async () => {
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
        writeFile: async file => {
          writes.push(file);
        },
        rename: async () => {
          throw new Error('the rename must never be reached');
        },
        rm: async () => {},
      };

      await assert.rejects(
        writeEvidenceRecord(record, target, { fs }),
        error => error instanceof FixtureError && error.exitCode === EXIT.EVIDENCE_UNRECORDED
      );
      assert.deepEqual(
        writes,
        [],
        'nothing may be written on a destination that could not be read'
      );
      // The earlier run's record is byte-for-byte intact.
      assert.equal(await readFile(target, 'utf8'), serializeEvidenceRecord(earlier));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('names the unreadable path and says the run is unrecorded, without claiming an absence', async () => {
    const record = await buildSuccessRecord();
    const fs = {
      stat: async () => {
        throw Object.assign(new Error('EIO'), { code: 'EIO' });
      },
      readdir: async () => [],
      writeFile: async () => {},
      rename: async () => {},
      rm: async () => {},
    };
    await assert.rejects(writeEvidenceRecord(record, '/nope/mg67-evidence.json', { fs }), error => {
      assert.match(error.message, /cannot determine whether/);
      assert.match(error.message, /EIO/);
      assert.match(error.message, /not an absence/);
      assert.match(error.message, /evidence is NOT recorded/);
      return true;
    });
  });

  // Rule 2. The temp path belongs to the run, not to the destination.
  it('gives two runs sharing a destination disjoint temp paths', async () => {
    const target = '/tmp/shared-evidence.json';
    const mine = partialPathFor(target, RUN_ID);
    const theirs = partialPathFor(target, OTHER_RUN_ID);

    assert.notEqual(mine, theirs, 'two runs must not share one partial file');
    assert.ok(mine.startsWith(`${target}.`), 'the partial stays beside the target, for the rename');
    assert.ok(mine.endsWith(PARTIAL_SUFFIX));
    assert.ok(mine.includes(RUN_ID), 'the partial is named for the run that owns it');
  });

  it('refuses to derive a temp path from a run id that is missing or unusable as a filename', async () => {
    for (const bad of [undefined, null, '', '   ', 42, 'run/../../etc/passwd', 'run id']) {
      assert.throws(
        () => partialPathFor('/tmp/mg67-evidence.json', bad),
        error => error instanceof FixtureError && error.exitCode === EXIT.EVIDENCE_UNRECORDED,
        `a run id of ${JSON.stringify(bad)} must not silently map onto a shared or traversing path`
      );
    }
  });

  // The interleave itself, ordered by hand and asserted on CONTENT: run A writes
  // its bytes, run B writes ITS bytes to the partial B would use, then A
  // renames. With a partial derived from the destination alone those are one
  // file, so A's rename publishes B's record under A's write and A exits 0 —
  // a wrong-record-under-the-right-name failure nothing downstream can detect.
  it("never publishes another run's record under this run's write", async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const runA = await buildRecordForRun(RUN_ID);
      const runB = await buildRecordForRun(OTHER_RUN_ID, RUN_MILLIS + 60_000);
      assert.notEqual(runA.runId, runB.runId, 'fixture setup: two DIFFERENT runs');
      assert.notEqual(
        serializeEvidenceRecord(runA),
        serializeEvidenceRecord(runB),
        'fixture setup: the two runs must be distinguishable on disk'
      );

      // A real filesystem. The only injection is run B landing in the window
      // between A's write and A's rename — the window the old naming shared.
      const fs = {
        writeFile: async (file, contents) => {
          await writeFile(file, contents, 'utf8');
          if (file.endsWith(PARTIAL_SUFFIX)) {
            // B, mid-flight, writing to the path B derives for itself.
            await writeFile(
              partialPathFor(target, runB.runId),
              serializeEvidenceRecord(runB),
              'utf8'
            );
          }
        },
      };

      const written = await writeEvidenceRecord(runA, target, { fs });

      // A reported success, so the file A named must hold A's record. This is
      // the assertion the old shared-partial naming fails.
      assert.equal(written.path, target);
      const onDisk = await readFile(target, 'utf8');
      assert.equal(onDisk, serializeEvidenceRecord(runA));
      assert.equal(JSON.parse(onDisk).runId, runA.runId);
      assert.notEqual(JSON.parse(onDisk).runId, runB.runId);
      // B's in-flight partial is still B's, untouched by A's rename.
      assert.equal(
        await readFile(partialPathFor(target, runB.runId), 'utf8'),
        serializeEvidenceRecord(runB)
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // Rule 3. --overwrite is not --destroy-anything.
  for (const overwrite of [false, true]) {
    it(`refuses a destination another run holds a partial on (overwrite: ${overwrite})`, async () => {
      const dir = await tempDir();
      try {
        const target = path.join(dir, 'mg67-evidence.json');
        const foreignPartial = partialPathFor(target, OTHER_RUN_ID);
        await writeFile(foreignPartial, '{"a run still writing":', 'utf8');

        const record = await buildSuccessRecord();
        await assert.rejects(
          writeEvidenceRecord(record, target, { overwrite }),
          error => error instanceof FixtureError && error.exitCode === EXIT.EVIDENCE_UNRECORDED
        );
        // Untouched: the other run is going to rename this into place, and this
        // run has no business removing it.
        assert.equal(await readFile(foreignPartial, 'utf8'), '{"a run still writing":');
        assert.deepEqual(
          await readdir(dir),
          [path.basename(foreignPartial)],
          'nothing was written and nothing was destroyed'
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    });
  }

  it("does not treat this run's OWN leftover partial as a foreign one", async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const record = await buildSuccessRecord();
      // A previous attempt of THIS run died between write and rename. Refusing
      // here would strand a run's evidence over its own debris, which is the
      // opposite of the guard's purpose.
      await writeFile(partialPathFor(target, record.runId), '{"mine, half written":', 'utf8');

      await writeEvidenceRecord(record, target);
      assert.equal(await readFile(target, 'utf8'), serializeEvidenceRecord(record));
      assert.deepEqual(await readdir(dir), ['mg67-evidence.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('treats a partial with no identifiable owner as foreign', async () => {
    // The pre-per-run spelling, and anything else a crash left. "I cannot tell
    // whose this is" is not "it is mine".
    const found = foreignPartials(
      ['evidence.json', 'evidence.json.partial', `evidence.json.${RUN_ID}${PARTIAL_SUFFIX}`],
      'evidence.json',
      RUN_ID
    );
    assert.deepEqual(
      found.map(partial => partial.name),
      ['evidence.json.partial']
    );
    assert.equal(found[0].owner, null);
  });

  it('matches only partials belonging to THIS destination', async () => {
    const entries = [
      'evidence.json',
      'evidence.json.preflight',
      `evidence.json.${RUN_ID}${PARTIAL_SUFFIX}`,
      `other.json.${RUN_ID}${PARTIAL_SUFFIX}`,
      'evidence.jsonsomething.partial',
    ];
    assert.deepEqual(
      partialsForDestination(entries, 'evidence.json').map(partial => partial.name),
      [`evidence.json.${RUN_ID}${PARTIAL_SUFFIX}`],
      "a sibling destination's partial is not this destination's business"
    );
    // With no run id — the preflight's position, before one is minted —
    // everything found is foreign.
    assert.equal(foreignPartials(entries, 'evidence.json').length, 1);
    assert.equal(foreignPartials(entries, 'evidence.json', RUN_ID).length, 0);
  });

  it('refuses when the destination directory cannot be enumerated at all', async () => {
    const record = await buildSuccessRecord();
    const fs = {
      readdir: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      stat: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      writeFile: async () => {
        throw new Error('the write must never be reached');
      },
      rename: async () => {},
      rm: async () => {},
    };
    await assert.rejects(writeEvidenceRecord(record, '/tmp/mg67-evidence.json', { fs }), error => {
      assert.equal(error.exitCode, EXIT.EVIDENCE_UNRECORDED);
      assert.match(error.message, /cannot enumerate/);
      assert.match(error.message, /Refused rather than assumed empty/);
      return true;
    });
  });

  // The rule that outlives these three findings: nothing the write path refuses
  // may say "nothing live happened", because by the time it runs, something did.
  it('never refuses with a code that means nothing live happened', async () => {
    const unreadable = code => async () => {
      throw Object.assign(new Error(code), { code });
    };
    // Each case gets a FRESH directory and sets up only its own condition, so
    // every refusal here is reached by the reason its label names rather than by
    // whichever guard the previous case happened to leave armed.
    const CASES = [
      ['an unreadable destination', async () => ({ fs: { stat: unreadable('EACCES') } })],
      ['an unenumerable directory', async () => ({ fs: { readdir: unreadable('EACCES') } })],
      ['a path that is not a path', async () => ({ at: '' })],
      [
        'an existing record',
        async (target, record) => {
          await writeEvidenceRecord(record, target);
          return {};
        },
      ],
      [
        'a concurrent run, even under overwrite',
        async target => {
          await writeFile(partialPathFor(target, OTHER_RUN_ID), '{', 'utf8');
          return { overwrite: true };
        },
      ],
      [
        'a record with no usable run id',
        async (_target, record) => ({ record: { ...record, runId: 'not a filename' } }),
      ],
    ];

    for (const [label, setup] of CASES) {
      const dir = await tempDir();
      try {
        const target = path.join(dir, 'mg67-evidence.json');
        const record = await buildSuccessRecord();
        const { at = target, record: written = record, ...options } = await setup(target, record);
        await assert.rejects(
          writeEvidenceRecord(written, at, options),
          error => {
            assert.ok(error instanceof FixtureError, `${label}: expected a FixtureError`);
            // The rule that outlives these three findings: by the time this
            // function runs, documents are in the container.
            assert.notEqual(
              error.exitCode,
              EXIT.USAGE,
              `${label}: must not read as "nothing live"`
            );
            assert.notEqual(error.exitCode, EXIT.OK, `${label}: a refusal is never success`);
            assert.equal(error.exitCode, EXIT.EVIDENCE_UNRECORDED, `${label}: wrong code`);
            return true;
          },
          label
        );
      } finally {
        await rm(dir, { recursive: true, force: true });
      }
    }
  });
});

// Rule 4. The destination is taken by EXCLUSION, not by checking.
//
// Every test above drives ONE writer past a destination whose state it inspects.
// That is check-then-act, and check-then-act has a window by construction: two
// genuinely concurrent runs each read a free destination, each proceed, and one
// record is destroyed by the other's publication with BOTH runs exiting 0. In
// the artifact MG-53 and MG-54 parse to decide whether to halt a migration, that
// is silent data destruction reported as success.
//
// So these tests do not measure the window — a test that merely made the gap
// smaller would pass against the defect. They run writers that are genuinely
// simultaneous AT THE PUBLICATION ITSELF, held there by a barrier that does not
// release until every one of them has arrived, and they demand the invariant
// exclusion gives and narrowing cannot: EXACTLY ONE SUCCESS, every other writer
// refused explicitly and nonzero, never two successes.
describe('two concurrent runs cannot both publish to one destination', () => {
  const RUN_A = 'mg-67-run-00000000-0000-4000-8000-0000000000aa';
  const RUN_B = 'mg-67-run-00000000-0000-4000-8000-0000000000bb';
  const PRIOR_RUN = 'mg-67-run-00000000-0000-4000-8000-00000000pr01'.replace('pr01', '0f01');

  // Releases only once EVERY writer has arrived, so the publications are truly
  // concurrent rather than merely close together. A writer that never arrives
  // hangs the test, which is the correct failure: it means the code did not
  // reach the publication at all.
  function meetingPoint(count) {
    let arrived = 0;
    let open;
    const gate = new Promise(resolve => {
      open = resolve;
    });
    return async () => {
      arrived += 1;
      if (arrived >= count) open();
      await gate;
    };
  }

  const settleAll = promises => Promise.allSettled(promises);

  function splitOutcomes(outcomes) {
    return {
      published: outcomes.filter(outcome => outcome.status === 'fulfilled'),
      refused: outcomes.filter(outcome => outcome.status === 'rejected').map(o => o.reason),
    };
  }

  function assertRefusal(error, label) {
    assert.ok(error instanceof FixtureError, `${label}: expected a FixtureError`);
    assert.equal(error.exitCode, EXIT.EVIDENCE_UNRECORDED, `${label}: wrong exit code`);
    assert.notEqual(error.exitCode, EXIT.OK, `${label}: a refusal is never a success`);
    assert.notEqual(error.exitCode, EXIT.USAGE, `${label}: documents are in the container by now`);
  }

  it('publishes exactly one record and refuses the other, explicitly and nonzero', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const a = await buildRecordForRun(RUN_A);
      const b = await buildRecordForRun(RUN_B, RUN_MILLIS + 1000);

      // Ordered log of what each writer did, so the test can prove the
      // exclusion happened at the publication and NOT at one of the checks.
      const trace = [];
      const meet = meetingPoint(2);
      const fs = {
        writeFile: async (file, contents) => {
          trace.push(`write:${path.basename(file)}`);
          return writeFile(file, contents, 'utf8');
        },
        link: async (from, to) => {
          await meet();
          trace.push(`link:${path.basename(from)}`);
          return realLink(from, to);
        },
      };

      const { published, refused } = splitOutcomes(
        await settleAll([
          writeEvidenceRecord(a, target, { fs }),
          writeEvidenceRecord(b, target, { fs }),
        ])
      );

      assert.equal(published.length, 1, 'exactly one run may publish');
      assert.equal(refused.length, 1, 'and the other must be TOLD, not silently overwritten');
      assertRefusal(refused[0], 'the losing run');
      assert.match(
        refused[0].message,
        /claimed by another run/,
        'the refusal must come from the exclusive publication, not from a check'
      );

      // Both writers got all the way to the publication before either published:
      // every check-then-act guard passed for BOTH of them, which is precisely
      // the situation in which checking cannot help and only exclusion can.
      const firstLink = trace.findIndex(entry => entry.startsWith('link:'));
      const partialWrites = trace
        .slice(0, firstLink)
        .filter(entry => entry.endsWith(PARTIAL_SUFFIX)).length;
      assert.equal(partialWrites, 2, 'both runs passed every guard before either published');

      // The file holds ONE complete record — the winner's, whole, never a blend.
      const written = JSON.parse(await readFile(target, 'utf8'));
      assert.equal(written.runId, published[0].value.record.runId);
      assert.equal(written.count, MESSAGES_PER_RUN);
      const loserRunId = written.runId === RUN_A ? RUN_B : RUN_A;
      assert.equal(
        JSON.stringify(written).includes(loserRunId),
        false,
        'no fragment of the refused run appears in the published record'
      );
      assert.deepEqual(await readdir(dir), ['mg67-evidence.json'], 'and no debris is left');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The load-bearing test. Every check-then-act guard is BLINDED — stat always
  // answers "nothing there", the directory always enumerates empty — so not one
  // of them can refuse anything. If the exclusion lived in the checks, both runs
  // would publish here and one record would be lost. It lives in the filesystem,
  // so exactly one still does.
  it('still admits exactly one run when every check-then-act guard is blinded', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const a = await buildRecordForRun(RUN_A);
      const b = await buildRecordForRun(RUN_B, RUN_MILLIS + 1000);

      const meet = meetingPoint(2);
      const blinded = {
        stat: async () => {
          throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
        },
        readdir: async () => [],
        link: async (from, to) => {
          await meet();
          return realLink(from, to);
        },
      };

      const { published, refused } = splitOutcomes(
        await settleAll([
          writeEvidenceRecord(a, target, { fs: blinded }),
          writeEvidenceRecord(b, target, { fs: blinded }),
        ])
      );

      assert.equal(published.length, 1, 'the filesystem adjudicates, not the checks');
      assert.equal(refused.length, 1);
      assertRefusal(refused[0], 'the losing run with the guards blinded');
      assert.match(refused[0].message, /claimed by another run/);

      const written = JSON.parse(await readFile(target, 'utf8'));
      assert.equal(written.runId, published[0].value.record.runId);
      assert.deepEqual(await readdir(dir), ['mg67-evidence.json']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('admits exactly one of FIVE simultaneous runs, and refuses the other four', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const runIds = ['a1', 'b2', 'c3', 'd4', 'e5'].map(
        suffix => `mg-67-run-00000000-0000-4000-8000-0000000000${suffix}`
      );
      const records = [];
      for (const [index, runId] of runIds.entries()) {
        records.push(await buildRecordForRun(runId, RUN_MILLIS + index * 1000));
      }

      const meet = meetingPoint(records.length);
      const fs = {
        link: async (from, to) => {
          await meet();
          return realLink(from, to);
        },
      };

      const { published, refused } = splitOutcomes(
        await settleAll(records.map(record => writeEvidenceRecord(record, target, { fs })))
      );

      assert.equal(published.length, 1, 'one destination admits one record, at any concurrency');
      assert.equal(refused.length, 4);
      for (const [index, error] of refused.entries()) assertRefusal(error, `refused run ${index}`);
      assert.deepEqual(await readdir(dir), ['mg67-evidence.json'], 'four partials cleaned up');
      const written = JSON.parse(await readFile(target, 'utf8'));
      assert.equal(written.runId, published[0].value.record.runId);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // `--overwrite` is the path the fix could most easily have missed. It exists
  // to replace the operator's OWN earlier record, and doing that by clobbering
  // would put the race straight back: two overwriting runs would each destroy
  // the other's publication and both report success. It goes through the same
  // exclusion, so it cannot.
  it('holds the same exclusion under --overwrite, which is not a force flag', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      // The operator's own earlier record, which --overwrite may legitimately
      // replace — but only ONCE, and only by a run that says so.
      await writeEvidenceRecord(await buildRecordForRun(PRIOR_RUN), target);

      const a = await buildRecordForRun(RUN_A);
      const b = await buildRecordForRun(RUN_B, RUN_MILLIS + 1000);
      const meet = meetingPoint(2);
      const fs = {
        link: async (from, to) => {
          await meet();
          return realLink(from, to);
        },
      };

      const { published, refused } = splitOutcomes(
        await settleAll([
          writeEvidenceRecord(a, target, { fs, overwrite: true }),
          writeEvidenceRecord(b, target, { fs, overwrite: true }),
        ])
      );

      assert.equal(published.length, 1, 'two overwriting runs cannot both replace the record');
      assert.equal(refused.length, 1, 'and the loser is told, rather than silently discarded');
      assertRefusal(refused[0], 'the losing overwriting run');

      const written = JSON.parse(await readFile(target, 'utf8'));
      assert.equal(written.runId, published[0].value.record.runId);
      assert.ok([RUN_A, RUN_B].includes(written.runId), 'the published record is a real one');

      // Whichever run claimed the prior record, it is either gone (replaced, as
      // --overwrite asks) or still on disk under its superseded name AND named
      // in the refusal. What it may never be is silently lost.
      const remaining = (await readdir(dir)).sort();
      const stranded = remaining.find(name => name.endsWith(SUPERSEDED_SUFFIX));
      if (stranded) {
        assert.match(
          refused[0].message,
          /could NOT be restored/,
          'a record moved aside and not put back must be reported, never left to be discovered'
        );
        assert.ok(refused[0].message.includes(stranded), 'and named by path');
        assert.equal(
          JSON.parse(await readFile(path.join(dir, stranded), 'utf8')).runId,
          PRIOR_RUN,
          'the stranded file holds the prior record, intact'
        );
      } else {
        assert.deepEqual(remaining, ['mg67-evidence.json'], 'no debris when the claimer won');
      }
      assert.equal(
        remaining.some(name => name.endsWith(PARTIAL_SUFFIX)),
        false,
        'and neither run left a partial behind'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // The rollback uses the exclusive primitive too. An overwriting run that
  // claimed the prior record and then failed to publish must not put it back
  // over a record some other run has since published.
  it('never restores a superseded record over another run publication', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      await writeEvidenceRecord(await buildRecordForRun(PRIOR_RUN), target);
      const winner = await buildRecordForRun(RUN_B, RUN_MILLIS + 1000);
      const record = await buildRecordForRun(RUN_A);

      // This run claims the prior record, then finds the destination taken: a
      // second run published in the interval. Its rollback must lose.
      let claimed = false;
      const fs = {
        link: async (from, to) => {
          if (!claimed) {
            claimed = true;
            // The concurrent run publishes right here, in the interval between
            // this run's claim and this run's publication. Its directory scan is
            // blinded so it behaves like a run that started before this one's
            // partial appeared — the check-then-act guard is not what is under
            // test here, the rollback is.
            await writeEvidenceRecord(winner, target, { fs: { readdir: async () => [] } });
          }
          return realLink(from, to);
        },
      };

      await assert.rejects(writeEvidenceRecord(record, target, { fs, overwrite: true }), error => {
        assertRefusal(error, 'the run whose destination was taken mid-write');
        assert.match(error.message, /claimed by another run/);
        assert.match(error.message, /could NOT be restored/);
        return true;
      });

      assert.equal(
        JSON.parse(await readFile(target, 'utf8')).runId,
        RUN_B,
        "the concurrent run's published record was not clobbered by the rollback"
      );
      const stranded = (await readdir(dir)).find(name => name.endsWith(SUPERSEDED_SUFFIX));
      assert.ok(stranded, 'and the prior record it could not restore is still on disk');
      assert.equal(
        JSON.parse(await readFile(path.join(dir, stranded), 'utf8')).runId,
        PRIOR_RUN,
        'intact, under its superseded name'
      );
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// The destination is checked BEFORE the sender changes the live system.
//
// The failure this block exists to catch is not "the write refused" — the write
// already refuses correctly, and those tests are above. It is the ORDER: an
// unusable --evidence-out path used to be discovered only after three synthetic
// documents were in the live container, leaving documents no record accounts for
// and MG-53 halting on them. Every refusal here is asserted to be EXIT.USAGE,
// the code that means "nothing live happened", and asserted to leave the
// directory exactly as it found it.
describe('the evidence destination is proven usable before anything live happens', () => {
  const refusalOf = async promise => {
    try {
      await promise;
    } catch (err) {
      return err;
    }
    return null;
  };

  const assertUsageRefusal = (err, context) => {
    assert.ok(err instanceof FixtureError, `${context}: expected a FixtureError, got ${err}`);
    // USAGE and nothing else. A destination problem found before the send is
    // "fix the invocation", never one of the outcome codes: reporting it as
    // TIMEOUT or EVIDENCE_UNRECORDED would tell the operator that documents may
    // be in the container when none can be.
    assert.equal(err.exitCode, EXIT.USAGE, `${context}: wrong exit code`);
    return err;
  };

  it('passes for a fresh path and leaves the directory exactly as it found it', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const result = await preflightEvidenceDestination(target);

      assert.equal(result.path, target);
      assert.equal(result.writable, true);
      assert.equal(result.exists, false);
      assert.equal(result.directory, dir);
      assert.equal(result.probePath, probePathFor(target));
      // The probe is removed: a preflight that left a file behind would be a
      // live effect of its own, and a `.preflight` sibling sitting next to the
      // target is exactly the debris a later operator picks up by hand.
      assert.deepEqual(await readdir(dir), [], 'the preflight left something behind');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an existing record before the send, and does not touch it', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const first = await buildSuccessRecord();
      await writeEvidenceRecord(first, target);

      const err = assertUsageRefusal(
        await refusalOf(preflightEvidenceDestination(target)),
        'an existing record'
      );
      // The operator is told, at a point where it is still free to fix, that
      // nothing was sent for this run.
      assert.match(err.message, /Nothing has been sent for this run/);
      assert.equal(await readFile(target, 'utf8'), serializeEvidenceRecord(first));

      // Deliberate overwrite is still possible, and reports what it will replace.
      const result = await preflightEvidenceDestination(target, { overwrite: true });
      assert.equal(result.exists, true);
      assert.match(describeDestination(result), /WILL BE REPLACED/);
      // Still untouched: a preflight decides, it does not write.
      assert.equal(await readFile(target, 'utf8'), serializeEvidenceRecord(first));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a directory that does not exist rather than creating one', async () => {
    const dir = await tempDir();
    try {
      const missing = path.join(dir, 'does-not-exist');
      const err = assertUsageRefusal(
        await refusalOf(preflightEvidenceDestination(path.join(missing, 'evidence.json'))),
        'a missing directory'
      );
      assert.match(err.message, /directory for the evidence file does not exist/);
      assert.deepEqual(await readdir(dir), [], 'the preflight created a directory');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a destination that is a directory, with overwrite as well', async () => {
    const dir = await tempDir();
    try {
      // The path the operator gave IS a directory — a plausible slip, and one
      // whose rename would fail at write time, i.e. after the send.
      const asDirectory = path.join(dir, 'evidence.json');
      await mkdir(asDirectory);
      for (const options of [{}, { overwrite: true }]) {
        const err = assertUsageRefusal(
          await refusalOf(preflightEvidenceDestination(asDirectory, options)),
          `a directory destination with ${JSON.stringify(options)}`
        );
        assert.match(err.message, /is a directory/);
      }
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a partial left by a crashed or concurrent run', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      await writeFile(
        partialPathFor(target, 'mg-67-run-00000000-0000-4000-8000-00000000dead'),
        '{"half":',
        'utf8'
      );

      const err = assertUsageRefusal(
        await refusalOf(preflightEvidenceDestination(target)),
        'a pre-existing partial'
      );
      // The rename this preflight prevents would destroy a concurrent run's
      // record, and at preflight time refusing costs nothing.
      assert.match(err.message, /partial evidence file already exists/);
      assert.match(err.message, /another run is writing this same path/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  // --overwrite is not --destroy-anything.
  //
  // The flag authorises replacing the operator's OWN earlier record. Letting it
  // also bypass this guard lets one run delete a record another run is in the
  // middle of writing — and both runs still report success, because neither can
  // see what the other lost.
  it("refuses a concurrent run's partial under --overwrite as well", async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const foreign = partialPathFor(target, 'mg-67-run-00000000-0000-4000-8000-00000000dead');
      // The destination ALSO holds an earlier record, so --overwrite is a
      // legitimate ask here — and still does not license this.
      await writeFile(target, '{"an":"earlier run"}\n', 'utf8');
      await writeFile(foreign, '{"a run still writing":', 'utf8');

      const err = assertUsageRefusal(
        await refusalOf(preflightEvidenceDestination(target, { overwrite: true })),
        'a foreign partial under overwrite'
      );
      assert.match(err.message, /partial evidence file already exists/);
      assert.match(err.message, /refused with overwrite as well/i);
      assert.match(err.message, /Nothing has been sent for this run/);
      // Neither file was touched: a preflight decides, it does not clean up.
      assert.equal(await readFile(foreign, 'utf8'), '{"a run still writing":');
      assert.equal(await readFile(target, 'utf8'), '{"an":"earlier run"}\n');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it("passes a destination holding only the caller's OWN partial", async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      await writeFile(partialPathFor(target, RUN_ID), '{"mine":', 'utf8');
      // The guard is about OTHER runs. A caller that already minted its run id
      // and is re-checking its own destination is not a concurrent run.
      const result = await preflightEvidenceDestination(target, { runId: RUN_ID });
      assert.equal(result.writable, true);
      assert.deepEqual(result.partialsFound, []);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a directory it cannot enumerate rather than assuming no run holds it', async () => {
    // The concurrency guard reads a directory listing, so a listing it cannot
    // get is a guard it cannot run — and an unrunnable guard must refuse, not
    // wave the run through. Same discipline as the stat above.
    const target = '/nope/mg67-evidence.json';
    const fs = {
      stat: async where =>
        where === target
          ? Promise.reject(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
          : { isDirectory: () => true },
      readdir: async () => {
        throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
      },
      writeFile: async () => {
        throw new Error('the probe must not be reached');
      },
      rm: async () => {},
    };
    const err = assertUsageRefusal(
      await refusalOf(preflightEvidenceDestination(target, { fs })),
      'an unenumerable directory'
    );
    assert.match(err.message, /cannot enumerate/);
    assert.match(err.message, /EACCES/);
    assert.match(err.message, /Refused rather than assumed empty/);
  });

  it('refuses a destination it cannot write to, before a single message is sent', async () => {
    // A read-only mount, as the filesystem reports it. Injected, because a real
    // one is not creatable in this container and the case is the whole point.
    const writes = [];
    const fs = {
      stat: async () => {
        throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
      },
      writeFile: async file => {
        writes.push(file);
        throw Object.assign(new Error('EROFS'), { code: 'EROFS' });
      },
      rm: async () => {},
    };
    // The directory has to exist for the probe to be reached, so stat answers
    // ENOENT only for the file: this fs answers ENOENT for everything, so use a
    // real directory and only the write fails.
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const err = assertUsageRefusal(
        await refusalOf(
          preflightEvidenceDestination(target, {
            fs: { ...fs, stat: async p => (p === dir ? { isDirectory: () => true } : fs.stat(p)) },
          })
        ),
        'a read-only destination'
      );
      assert.match(err.message, /is not writable/);
      assert.match(err.message, /EROFS/);
      // The sentence an operator needs: this refusal is not a report about the
      // container.
      assert.match(err.message, /no synthetic document is in the container from this run/);
      assert.deepEqual(writes, [probePathFor(target)]);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses an unreadable destination rather than reading it as absent', async () => {
    // The tool's own filesystem gets the same discipline as its read-back: an
    // error is not an absence. A stat that fails for any reason other than
    // ENOENT is refused, not assumed to mean "the path is free".
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      const fs = {
        stat: async p => {
          if (p === dir) return { isDirectory: () => true };
          throw Object.assign(new Error('EACCES'), { code: 'EACCES' });
        },
        writeFile: async () => {
          throw new Error('the probe must not be reached');
        },
        rm: async () => {},
      };
      const err = assertUsageRefusal(
        await refusalOf(preflightEvidenceDestination(target, { fs })),
        'an unreadable destination'
      );
      assert.match(err.message, /cannot determine whether/);
      assert.match(err.message, /EACCES/);
      assert.match(err.message, /not assumed to be free/);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('refuses a path that is not a path', async () => {
    for (const bad of ['', '   ', undefined, null, 42, {}]) {
      assertUsageRefusal(
        await refusalOf(preflightEvidenceDestination(bad)),
        `the path ${JSON.stringify(bad)}`
      );
    }
  });

  it('is not a promise: the write-time refusal still decides', async () => {
    const dir = await tempDir();
    try {
      const target = path.join(dir, 'mg67-evidence.json');
      // Passes at t0...
      assert.equal((await preflightEvidenceDestination(target)).writable, true);
      // ...and the path is taken at t1, by a concurrent run or by hand.
      const other = await buildSuccessRecord();
      await writeEvidenceRecord(other, target);

      // The write-time guard is the authoritative one and MUST still refuse. A
      // preflight that had been allowed to stand in for it would clobber a
      // record whose documents are still in the container.
      const record = await buildSuccessRecord({
        build: { now: fixedClock(RUN_MILLIS + 60_000) },
      });
      await assert.rejects(
        writeEvidenceRecord(record, target),
        // The write path's own class: by t1 the send has happened, so this
        // refusal can never be the "nothing live happened" code the preflight
        // above legitimately uses at t0.
        err => err instanceof FixtureError && err.exitCode === EXIT.EVIDENCE_UNRECORDED
      );
      assert.equal(await readFile(target, 'utf8'), serializeEvidenceRecord(other));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('has no live effect and reaches nothing outside the filesystem', async () => {
    const source = await readLocal('./evidence.mjs');
    // The preflight's whole justification is that it is purely local: if it
    // could send, spawn or fetch, running it before the send would be exactly
    // the harm it exists to prevent. The module-wide assertions above cover the
    // imports; this pins the claim to the preflight's own contract.
    assert.match(source, /preflightEvidenceDestination/);
    assert.equal(/\bspawn\b/.test(source), false, 'evidence.mjs can spawn a process');
  });
});

// Where the documents landed is RECORDED, and the states are never flattened.
//
// The architect's top-ranked risk for this route is that nothing between the
// device and Cosmos injects a partition key, so a body missing the field yields
// a stored document with NO partition key — not one under a different key. The
// two need different repairs, so the artifact MG-53 and MG-54 parse has to keep
// them apart. An empty observedPartitionValues discards the distinction entirely.
describe('the partition the documents landed in', () => {
  const BOUND = 20_000;
  const INTERVAL = 5_000;
  const POLLS_TO_BOUND = 5;
  const emptyPolls = () => Array.from({ length: POLLS_TO_BOUND }, () => ({ docs: [] }));

  // Documents as COSMOS returns them: the platform assigns the id, and the
  // partition key is whatever the BODY carried.
  const routed = ({ partitionValue = FIXTURE_DEVICE_ID, mutate } = {}) =>
    Array.from({ length: MESSAGES_PER_RUN }, (_, i) => {
      const doc = {
        id: `cosmos-assigned-${i + 1}`,
        deviceId: partitionValue,
        timestamp: '2026-08-11T08:59:55.000Z',
        [SYNTHETIC_MARKER_FIELD]: SYNTHETIC_MARKER,
        [RUN_ID_FIELD]: RUN_ID,
        [SEQUENCE_FIELD]: i + 1,
      };
      if (mutate) mutate(doc);
      return doc;
    });

  const recordFor = async documents => {
    const confirmation = await confirmationFor(
      { script: [...emptyPolls(), { docs: documents }] },
      { timeoutMs: BOUND, pollIntervalMs: INTERVAL }
    );
    return buildEvidenceRecord({
      confirmation,
      containerDefinition: await cleanDefinition(),
      requestedIds: requestedIdsOf(sentMessages()),
      target: TARGET,
      now: fixedClock(),
    });
  };

  const partitionFinding = record => record.findings.find(f => f.kind === 'partition-landing');

  it('records "no partition key field at all" as its own state, never as an empty list', async () => {
    const record = await recordFor(routed({ mutate: doc => delete doc.deviceId }));

    assert.equal(record.exitCode, EXIT.UNEXPECTED_PARTITION);
    // THE fact this block exists for: the state is recorded, not discarded.
    assert.deepEqual(record.observedPartitionValues, [PARTITION_VALUE_ABSENT]);
    assert.notDeepEqual(record.observedPartitionValues, []);

    const finding = partitionFinding(record);
    assert.ok(finding, 'no partition-landing finding was recorded');
    assert.match(finding.message, /NO deviceId FIELD AT ALL/);
    assert.match(finding.message, new RegExp(PARTITION_VALUE_ABSENT));
    // And it must not state the thing that is factually false about a document
    // carrying no deviceId at all.
    assert.doesNotMatch(
      finding.message,
      /DIFFERENT deviceId/,
      'described a document with no partition key as carrying a different one'
    );
    // The confirmation's own sentence travels into the record unaltered, so the
    // two artifacts cannot disagree about what happened.
    assert.match(record.outcomeReason, /NO deviceId FIELD AT ALL/);
    // Still parses, still passes the credential guard with the reserved tokens
    // in it.
    assert.deepEqual(JSON.parse(serializeEvidenceRecord(record)).observedPartitionValues, [
      PARTITION_VALUE_ABSENT,
    ]);
  });

  it('records a DIFFERENT partition value as a different state, naming the value', async () => {
    const record = await recordFor(routed({ partitionValue: 'some-other-partition' }));

    assert.equal(record.exitCode, EXIT.UNEXPECTED_PARTITION);
    assert.deepEqual(record.observedPartitionValues, ['some-other-partition']);
    const finding = partitionFinding(record);
    assert.ok(finding, 'no partition-landing finding was recorded');
    assert.match(finding.message, /DIFFERENT deviceId/);
    assert.match(finding.message, /some-other-partition/);
    // The two states are distinguishable in the record, which is the whole
    // point: this one must not claim the field was missing.
    assert.doesNotMatch(finding.message, /FIELD AT ALL/);
    assert.equal(finding.measured, 1);
  });

  it('records a present-but-unusable value as a third state', async () => {
    const record = await recordFor(routed({ mutate: doc => (doc.deviceId = '') }));

    assert.deepEqual(record.observedPartitionValues, [PARTITION_VALUE_UNUSABLE]);
    const finding = partitionFinding(record);
    assert.ok(finding, 'no partition-landing finding was recorded');
    assert.match(finding.message, /present but empty or not a string/);
    assert.doesNotMatch(finding.message, /FIELD AT ALL/);
  });

  it('records no partition finding for a run that landed where it was sent', async () => {
    const record = await buildSuccessRecord();
    assert.equal(record.confirmed, true);
    assert.deepEqual(record.observedPartitionValues, [FIXTURE_DEVICE_ID]);
    assert.equal(
      partitionFinding(record),
      undefined,
      'a healthy run was reported as a partition anomaly'
    );
  });

  it('splits recorded values into the three states a consumer branches on', () => {
    const split = classifyPartitionValues(
      [FIXTURE_DEVICE_ID, 'elsewhere', PARTITION_VALUE_ABSENT, PARTITION_VALUE_UNUSABLE],
      FIXTURE_DEVICE_ID
    );
    assert.deepEqual(split.expected, [FIXTURE_DEVICE_ID]);
    // The reserved tokens are NOT "a different value": that is the conflation
    // this classification exists to make impossible downstream.
    assert.deepEqual(split.differentValue, ['elsewhere']);
    assert.equal(split.absent, true);
    assert.equal(split.unusable, true);

    const clean = classifyPartitionValues([FIXTURE_DEVICE_ID], FIXTURE_DEVICE_ID);
    assert.deepEqual(clean.differentValue, []);
    assert.equal(clean.absent, false);
    assert.equal(clean.unusable, false);
    // Tolerates a confirmation that recorded nothing, without inventing a state.
    const none = classifyPartitionValues(undefined, FIXTURE_DEVICE_ID);
    assert.deepEqual(none.expected, []);
    assert.equal(none.absent, false);
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
