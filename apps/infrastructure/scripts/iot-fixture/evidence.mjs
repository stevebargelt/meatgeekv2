// MeatGeek — the machine-readable evidence artifact for the dev fixture run (MG-67).
//
// WHAT THIS IS FOR. Two later tickets read this file as a PROGRAM INPUT, not as
// prose: MG-53 refuses to proceed if the source containers hold any document
// this fixture did not produce, and MG-54's destructive authorization cites
// these documents by id and count. The operator runbook
// (docs/infrastructure/mg67-device-fixture-verification.md) is a separate
// artifact and must never be the thing they parse — a human-readable procedure
// that drifts from the code is a documentation bug, while a machine-readable
// record that drifts is a wrong deletion. So this module owns exactly one JSON
// document, with a declared schema version and a closed key set.
//
// ===========================================================================
// THE EVIDENCE-EMISSION CONTRACT (schema version 2)
//
// The contract itself lives in fixture-core.mjs (createRunLedger, mergeIds,
// observedIdsDiverge, mustEmitEvidence). This module is its ARTIFACT SIDE: it
// transcribes a ledger snapshot, and it deliberately has no idea of its own
// about what a run put in the container.
//
// The record therefore distinguishes FOUR id sets, which earlier versions of
// this file conflated into one `requestedIds`:
//
//   requestedIds  minted by the sender AND ATTEMPTED.
//   acceptedIds   az reported success.
//   ambiguousIds  az reported failure and acceptance is UNKNOWN. The CLI can
//                 fail AFTER IoT Hub accepted the message, so a send failure is
//                 ambiguous BY CONSTRUCTION and is never recorded as
//                 definitively not-sent.
//   observedIds   read back out of Cosmos, including anything a partial poll saw
//                 before a later abort. Once observed, never discarded.
//
// Plus `outcome`, `exitCode` and `uncertain` — and `accountableIds`, the union
// of accepted, ambiguous and observed, which is the set a downstream ticket must
// account for. Computing that union downstream out of three fields is how the
// wrong subset gets acted on, so it is computed here, once.
//
// TWO RULES THIS MODULE ENFORCES STRUCTURALLY, because both were violated by
// the shape it replaces:
//
//   1. NO RECORD ASSERTS THAT NOTHING WAS WRITTEN. A run that attempted anything
//      at all gets a record, and that record's `uncertain`, `ambiguousIds` and
//      `accountableIds` say what may be in the container. `count: 0` never means
//      "nothing arrived" on its own — the earlier shape let it read that way,
//      which is the MG-66 error-as-absence conflation reproduced on the WRITE
//      side. There is no path here that needs a confirmation to exist: pass
//      `outcome` instead and the record still builds.
//   2. `idDivergence` IS WITNESSED, NEVER INFERRED. It is true only when a
//      document that was ACTUALLY OBSERVED carries an id the sender did not
//      request (fixture-core's observedIdsDiverge). It is never derived from a
//      count shortfall: "we asked for three and saw two" is an incomplete
//      read-back, and calling that divergence would assert a platform renaming
//      behaviour nobody witnessed, in the one artifact MG-53 and MG-54 parse
//      mechanically.
//
// `confirmed: true` with `uncertain: true` is a legitimate, deliberate
// combination: the expected set was read back out of the container (the proof
// holds) AND some message's acceptance was never established by the sender. Both
// facts are true, and collapsing either into the other loses information a
// downstream halt turns on.
// ===========================================================================
//
// ===========================================================================
// WHAT THIS RECORD DOES NOT DETECT, SAID IN THE RECORD ITSELF
//
// An earlier version of this file described `anomalousIds` as the artifact form
// of the runbook's FIRST stop condition — "any unexpected document found in the
// source containers", i.e. a document written by an unknown writer. It is not,
// and it structurally cannot be.
//
// The read-back this tool performs is fixture-core's CONFIRMATION_QUERY:
//
//     SELECT * FROM c WHERE c.<RUN_ID_FIELD> = @runId
//
// It is FILTERED TO THIS RUN'S OWN CORRELATOR. A document an unknown writer put
// in the container does not carry this run's freshly minted run id, so it is
// never returned, so it can never reach `anomalousIds` — on any path, including
// the cross-partition sweep, which uses the same predicate. `anomalousCount: 0`
// therefore says NOTHING WHATSOEVER about unknown writers. It is not weak
// evidence of their absence; it is no evidence at all.
//
// A field that claims a detection it cannot perform is worse than an absent
// one: MG-53 reading a permanently-empty `anomalousIds` as "no unknown writer"
// and proceeding is a vacuous proof of exactly the kind this ticket exists to
// eliminate. So the claim is RETRACTED here rather than restated:
//
//   * `anomalousIds` keeps its real, narrower meaning — documents the CORRELATED
//     read-back returned that this run cannot claim. Because the query already
//     pinned the run id, such a document carries THIS run's correlator while
//     failing to carry the synthetic marker (a sender-side defect) or while
//     naming a foreign run (a correlator collision). Both are real, both are
//     recorded by id because an operator cannot investigate a document nobody
//     named, and NEITHER is an unknown writer.
//   * `unknownWriterCheck` is a permanent, explicit `checked: false` declaring
//     that stop condition 1 is NOT evaluated by this tool and naming what does
//     evaluate it: the operator's UNFILTERED enumeration of the source
//     containers, a host-phase step, compared against `accountableIds`. A
//     mechanical consumer reads that field and knows it must do the enumeration
//     itself instead of trusting a zero here.
//
// THE SCHEMA VERSION DOES NOT BUMP for this. No existing key is removed and none
// is re-meant: `anomalousIds` always held what it still holds, and only the
// prose claim attached to it — which no consumer branches on — was wrong.
// `unknownWriterCheck` is purely additive, and a v2 reader that ignores it is no
// worse off than it was. The runbook is the thing that told a consumer to gate
// on `anomalousIds`, and that is where the retraction has to be repeated.
// ===========================================================================
//
// WHY THE MEASURED TTL AND THE ABSOLUTE INSTANT ARE BOTH HERE. A downstream
// count that comes back SMALLER than the count recorded here has two possible
// explanations that call for opposite responses: expected TTL expiry (proceed)
// or "the write never happened / something removed them" (halt). Telling those
// apart needs the container's own measured retention AND the wall-clock instant
// the run happened at. Recording either without the other leaves MG-53 guessing,
// which is precisely the guess HR4 exists to eliminate. Both are recorded, the
// TTL is the MEASURED value from container-definition.mjs (never the declared
// one), and any drift between them is carried as a finding rather than resolved.
//
// THE EXPIRY INSTANT IS AN UPPER BOUND, DELIBERATELY. Cosmos starts a document's
// TTL clock when the DOCUMENT is written, which happened up to `observedArrivalMs`
// before this record's clock was read. `expiryInstant` is `runInstant` plus the
// measured TTL, so the true expiry is at most `observedArrivalMs` EARLIER than
// the instant recorded here. Both numbers are in the record: a consumer sitting
// near the boundary must treat the window
// [expiryInstant − observedArrivalMs, expiryInstant] as indeterminate rather than
// concluding either way. Saying so here is cheaper than a downstream ticket
// re-deriving it wrong.
//
// THE CLOCK IS INJECTED so the artifact is byte-reproducible under test: the
// same inputs and the same clock produce the same bytes, which is what lets a
// test assert on the whole serialized document rather than field by field.
//
// NO FIELD OF THIS RECORD CAN HOLD A CREDENTIAL, and that is enforced at WRITE
// time rather than asserted in a comment (HR1 is a stop condition and applies to
// every artifact this tool produces, not only to its terminal output). Three
// guards, all in assertNoCredentialShape():
//
//   1. A CLOSED KEY SET. Every key at every depth must appear in
//      EVIDENCE_RECORD_KEYS. A future edit that adds `deviceKey` or
//      `connectionString` to the record is refused by construction — it does not
//      have to be recognised as credential-shaped first.
//   2. A CREDENTIAL-SHAPED KEY-NAME scan over what did get allowed.
//   3. A CREDENTIAL-SHAPED VALUE scan over every string in the record. This now
//      covers FOUR id sets rather than one, and the guard walks the record
//      structurally, so a set added later is scanned without anyone remembering.
//
// A hit REFUSES THE WRITE rather than redacting. This is the one place in the
// tool where redaction would be the wrong answer: a redacted document id is
// silently useless to MG-54, and an evidence file that quietly lost its evidence
// is worse than one that was never written. The refusal names the field, never
// the value.
//
// This module is NOT the MG-49/MG-63 scrubber and does not reopen it. That
// scrubber renders untrusted TEXT fit for an operator's terminal and has no
// exemption list on purpose. This is a structural guard over a record whose
// every key this module authors, so a reviewed, justified exemption for the
// three `partitionKey*` names (a partition key PATH is not a secret) is sound
// here in a way it would not be there.
//
// WRITES ARE ATOMIC AND NON-DESTRUCTIVE. The record is written to a sibling
// `.partial` file and renamed into place, so no reader ever sees a half-written
// document; a failed write removes the partial rather than leaving debris that
// looks like evidence. An EXISTING file at the target path is REFUSED rather
// than overwritten: the earlier run's documents are still in the container, and
// clobbering the record of them manufactures exactly the "unrecorded document"
// condition that halts MG-53. The operator picks a new path, or passes
// `overwrite: true` deliberately.

import { rename, rm, stat, writeFile } from 'node:fs/promises';

import {
  EXIT,
  FIXTURE_DEVICE_ID,
  FixtureError,
  ID_SET_NAMES,
  MESSAGES_PER_RUN,
  RUN_ID_FIELD,
  SYNTHETIC_MARKER,
  SYNTHETIC_MARKER_FIELD,
  TICKET,
  TOOL_NAME,
  TOOL_VERSION,
  exitLabel,
  mergeIds,
  observedIdsDiverge,
} from './fixture-core.mjs';

// Bumped when a key is added, removed or re-meant. MG-53 and MG-54 read this
// first and refuse a version they were not written against — a silently
// reshaped record consumed by an older reader is how a deletion gate acts on a
// field that no longer means what it did.
//
// 2: the four id sets, `outcome`, `uncertain`, `attempted` and `accountableIds`.
// Version 1 carried a single `requestedIds` whose meaning shifted with the code
// path that built it, which is exactly the ambiguity a mechanical consumer
// cannot survive.
export const EVIDENCE_SCHEMA_VERSION = 2;
export const EVIDENCE_KIND = 'mg67-device-fixture-evidence';

// ---------------------------------------------------------------------------
// The unknown-writer retraction (see the header block).
//
// A CONSTANT, not a computed field: there is no input to this tool that could
// make it true, because nothing this tool does enumerates the container without
// the run-id predicate. Making it a constant is the point — a field that could
// flip to `checked: true` would invite a future author to flip it from a
// filtered read, which is the defect being retracted.
//
// It is emitted on EVERY record, confirmed or not, for the same reason the four
// id sets are: a consumer that has to remember to check for a field's presence
// is a consumer that will read its absence as a pass.
// ---------------------------------------------------------------------------
export const UNKNOWN_WRITER_CHECK = Object.freeze({
  kind: 'not-performed-by-this-tool',
  checked: false,
  by: 'operator-unfiltered-enumeration',
  message:
    'Stop condition 1 (any unexpected document found in the source containers, i.e. a document written by an unknown writer) is NOT checked by this tool and is NOT what anomalousIds records. ' +
    "This tool's read-back is filtered to this run's own correlator, so a document an unknown writer produced is never returned by it and can never appear in anomalousIds; anomalousCount of 0 is therefore no evidence at all about unknown writers, not weak evidence of their absence. " +
    'Checking stop condition 1 requires an UNFILTERED enumeration of the source containers, which is an operator host-phase step, compared against accountableIds recorded here.',
});

// Written next to the target so the rename is same-filesystem and therefore
// atomic. A cross-device rename is not, and a temp directory elsewhere would
// silently degrade the one property this write has.
export const PARTIAL_SUFFIX = '.partial';

export const partialPathFor = filePath => `${filePath}${PARTIAL_SUFFIX}`;

// ---------------------------------------------------------------------------
// The outcome name.
//
// A STABLE SLUG per exit code, for a consumer that branches on the outcome. It
// is not a duplicate of `exitLabel`: the label is operator-facing prose and is
// allowed to be reworded, while these slugs are part of the artifact's schema
// and change only with a version bump. `exitCode` alone would do for a script,
// but a number in a JSON file that a human also reads is how the wrong branch
// gets written; both are recorded.
//
// An exit code with no slug is REFUSED rather than recorded as 'unknown': an
// outcome MG-53 cannot name is an outcome it cannot gate on, and a record it
// cannot read is worse than a build refusal the operator sees immediately.
// ---------------------------------------------------------------------------
export const OUTCOME_NAMES = Object.freeze({
  [EXIT.OK]: 'confirmed-in-cosmos',
  [EXIT.USAGE]: 'usage-refusal',
  [EXIT.SEND_FAILURE]: 'send-failure',
  [EXIT.TIMEOUT]: 'confirmation-timeout',
  [EXIT.AUTH]: 'auth-failure',
  [EXIT.TRANSPORT]: 'transport-abort',
  [EXIT.MARKER_VIOLATION]: 'marker-violation',
  [EXIT.AMBIGUOUS]: 'correlation-ambiguity',
  [EXIT.CONTAINER_DEFINITION]: 'container-definition-refusal',
  [EXIT.UNEXPECTED_PARTITION]: 'delivered-unexpected-partition',
  [EXIT.EVIDENCE_UNRECORDED]: 'evidence-unrecorded',
});

export function outcomeName(exitCode) {
  return OUTCOME_NAMES[exitCode];
}

// ---------------------------------------------------------------------------
// The closed key set (guard 1).
//
// Flat and depth-agnostic on purpose: a nested spec would have to be kept in
// step with the builder, and the property being defended is "no key this module
// did not author appears anywhere in the record", which a flat set states
// exactly. Adding a field means adding it here, which is the review moment.
// ---------------------------------------------------------------------------
export const EVIDENCE_RECORD_KEYS = Object.freeze(
  new Set([
    // Provenance.
    'schemaVersion',
    'kind',
    'ticket',
    'tool',
    'toolVersion',
    // The run and its outcome.
    'runId',
    'runInstant',
    'confirmed',
    'uncertain',
    'attempted',
    'outcome',
    'exitCode',
    'exitLabel',
    'outcomeReason',
    'scope',
    // The synthetic contract (HR3).
    'marker',
    'field',
    'value',
    'runIdField',
    'deviceId',
    // Where the documents live.
    'target',
    'hub',
    'account',
    'database',
    'container',
    'containerName',
    'partitionKeyPath',
    'partitionKeyField',
    'partitionValue',
    'observedPartitionValues',
    // The four id sets of the evidence-emission contract, plus the union a
    // downstream ticket must account for, plus the documents this run cannot
    // claim (kept strictly apart from its own).
    ...ID_SET_NAMES,
    'requestedCount',
    'acceptedCount',
    'ambiguousCount',
    'observedCount',
    'accountableIds',
    'accountableCount',
    'anomalousIds',
    'anomalousCount',
    // The explicit retraction: stop condition 1 is not checked here, and this
    // says so mechanically rather than leaving a zero to be misread.
    'unknownWriterCheck',
    'checked',
    'by',
    // Schema-version-1 names for the OBSERVED set, retained as aliases so a
    // consumer written against either name reads the same documents.
    'ids',
    'count',
    'expectedCount',
    'idDivergence',
    // Retention (HR4).
    'measuredDefaultTtl',
    'declaredDefaultTtl',
    'ttlExpires',
    'ttlDriftFinding',
    'expiryInstant',
    // The wait, as actually used.
    'waitBoundMs',
    'pollIntervalMs',
    'observedArrivalMs',
    'elapsedMs',
    'polls',
    'crossPartitionSweepRun',
    // Findings, and the shape one takes.
    'findings',
    'measured',
    'declared',
    'message',
  ])
);

// ---------------------------------------------------------------------------
// Credential shapes (guards 2 and 3).
// ---------------------------------------------------------------------------

// Key names that would announce a credential. `key` alone is NOT in the
// alternation: this record legitimately carries a partition KEY PATH, and a
// pattern that flagged it would either be disabled by the next author or force
// the field to be renamed into something less clear. Every compound spelling a
// credential actually uses is listed, and anything not anticipated is caught by
// the closed key set above rather than by this pattern.
const CREDENTIAL_KEY_NAME =
  /(secret|password|passwd|pwd|token|credential|connectionstring|conn_?str|sas|signature|certificate|thumbprint|accountkey|primarykey|secondarykey|masterkey|devicekey|sharedaccess|apikey|authkey|privatekey)/i;

// The three names for which `Key` is the container's partition key and nothing
// else. Reviewed, justified and closed — this is not the MG-63 scrubber, whose
// lack of an exemption list is deliberate and untouched.
const PARTITION_KEY_NAMES = Object.freeze(
  new Set(['partitionKeyPath', 'partitionKeyField', 'partitionValue'])
);

// Values that look like a credential regardless of what they are called. Each
// one refuses the write; none of them redacts.
const CREDENTIAL_VALUE_PATTERNS = Object.freeze([
  [/\bBearer\s+\S+/i, 'a bearer token'],
  // Three base64url segments, each long enough that dotted host names and
  // namespaced identifiers do not match. Same threshold as the tool's scrubber.
  [/\b[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/, 'a JWT-shaped value'],
  // Connection-string and SAS field assignments, in any of the spellings az,
  // the IoT SDKs and the Cosmos SDK emit.
  [
    /\b(AccountKey|SharedAccessKey|SharedAccessKeyName|SharedAccessSignature|AccountEndpoint|HostName|DeviceId=[^;]*;SharedAccess|Password|Pwd)\s*=/i,
    'a connection-string or SAS field',
  ],
  // A long unbroken base64 run. A device key is 44 base64 characters, and
  // nothing this record legitimately carries — an ISO instant, a hyphenated run
  // id, a container name, an operator-facing sentence — is a 40-character run
  // with no separator in it. A false positive here costs a named refusal the
  // operator can act on; a false negative costs a committed key.
  [/[A-Za-z0-9+/]{40,}={0,2}/, 'a long base64-shaped run'],
]);

function usageRefusal(message) {
  return new FixtureError(EXIT.USAGE, message);
}

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw usageRefusal(`${name} must be a non-empty string`);
  }
  return value;
}

/**
 * Walk the record and report every credential risk found, as a list of
 * findings naming the PATH and the SHAPE — never the value. Returns [] for a
 * clean record.
 *
 * Exported because the write path and the tests are two callers with the same
 * question, and because a caller that wants to inspect before writing should
 * not have to catch an exception to do it.
 */
export function findCredentialRisks(value, path = '$') {
  const risks = [];

  if (Array.isArray(value)) {
    value.forEach((item, index) => risks.push(...findCredentialRisks(item, `${path}[${index}]`)));
    return risks;
  }

  if (isPlainObject(value)) {
    for (const [key, child] of Object.entries(value)) {
      const childPath = `${path}.${key}`;
      // Guard 1: the closed key set.
      if (!EVIDENCE_RECORD_KEYS.has(key)) {
        risks.push({
          path: childPath,
          shape: 'a key this record does not declare',
          detail: `"${key}" is not in EVIDENCE_RECORD_KEYS — the evidence record has a closed key set so that a field able to hold a credential cannot be added without passing through this list`,
        });
      }
      // Guard 2: credential-shaped key names.
      if (!PARTITION_KEY_NAMES.has(key) && CREDENTIAL_KEY_NAME.test(key)) {
        risks.push({
          path: childPath,
          shape: 'a credential-shaped key name',
          detail: `"${key}" names a credential; this record carries none, on any path`,
        });
      }
      risks.push(...findCredentialRisks(child, childPath));
    }
    return risks;
  }

  // Guard 3: credential-shaped values. Only strings are inspected; numbers,
  // booleans and null cannot carry a secret.
  if (typeof value === 'string') {
    for (const [pattern, shape] of CREDENTIAL_VALUE_PATTERNS) {
      if (pattern.test(value)) {
        // The value is NOT echoed, not even truncated: a prefix of a secret is
        // still a fact about the secret.
        risks.push({ path, shape, detail: `the value at ${path} matches ${shape}` });
      }
    }
  }
  return risks;
}

/**
 * Fail-closed gate over a record about to be serialized or written. Throws a
 * FixtureError naming every risk by path and shape.
 *
 * The exit code is EXIT.USAGE deliberately, and this module is the wrong place
 * to decide otherwise: a record carrying a credential-shaped field is a
 * caller-contract violation detected before any file exists, and this module
 * cannot know whether the CALLER has already changed the live system. It is
 * emphatically not one of the outcome codes — reporting it as TIMEOUT or
 * AMBIGUOUS would attribute a bug in this tool to the route.
 *
 * The caller that DOES know translates: send-fixture.mjs maps any refusal to
 * build or write this record, once a send has been attempted, to
 * EXIT.EVIDENCE_UNRECORDED — because at that point documents are (or may be) in
 * the container and USAGE would tell the operator nothing happened.
 */
export function assertNoCredentialShape(record) {
  const risks = findCredentialRisks(record);
  if (risks.length === 0) return record;
  const detail = risks.map(risk => `${risk.path}: ${risk.shape}`).join('; ');
  throw usageRefusal(
    `refusing to write the evidence record: ${risks.length} credential-shape risk(s) — ${detail}. ` +
      'The record is not written and the value is not echoed. This artifact is attached to a ticket and read by MG-53 and MG-54; nothing that could be a credential belongs in it.'
  );
}

// ---------------------------------------------------------------------------
// Resolving the four id sets.
//
// Three accepted input shapes, ONE resolved answer. The ledger is the intended
// one; the others exist so that no caller is forced to fabricate a shape it does
// not have, which is how a set gets dropped.
// ---------------------------------------------------------------------------

function normalizeIdSets(source, name) {
  if (!isPlainObject(source)) {
    throw usageRefusal(`${name} must be the snapshot object createRunLedger() returns`);
  }
  const sets = {};
  for (const key of ID_SET_NAMES) {
    const value = source[key] ?? [];
    if (!Array.isArray(value)) {
      throw usageRefusal(
        `${name}.${key} must be an array of document ids — the evidence-emission contract has four id sets and none of them is optional`
      );
    }
    // Through the tool's one union, so an unusable id is refused here exactly as
    // it is everywhere else: an id that cannot be named cannot be evidence.
    sets[key] = mergeIds(value);
  }
  // The snapshot's own verdicts travel with it. They are only ever used to make
  // this record MORE uncertain, never less: a ledger that knows something this
  // module cannot derive must be able to say so.
  sets.runId = typeof source.runId === 'string' ? source.runId : null;
  sets.uncertain = source.uncertain === true;
  return sets;
}

/**
 * The adapter for a caller that has NOT threaded a ledger through — it knows
 * which ids it attempted and nothing about their acceptance.
 *
 * Fail-closed by construction: every attempted id that was not READ BACK is
 * recorded as AMBIGUOUS, never as accepted and never as not-sent. That
 * understates acceptance (an id az did report success for lands in the ambiguous
 * set), and understating is the safe direction: the record says "this may be in
 * the container", which is the sentence that keeps MG-53 from meeting a document
 * nothing accounts for. It never says "this was not written".
 */
function idSetsFromAttempted({ requestedIds, confirmation }) {
  const requested = mergeIds(Array.isArray(requestedIds) ? requestedIds : []);
  const observed = mergeIds(
    confirmation && Array.isArray(confirmation.observedIds) ? confirmation.observedIds : []
  );
  const seen = new Set(observed);
  return {
    requestedIds: requested,
    acceptedIds: [],
    ambiguousIds: requested.filter(id => !seen.has(id)),
    observedIds: observed,
    runId: null,
    // Nothing extra is claimed here: `uncertain` is derived below from the
    // ambiguous set and the confirmation, both of which this adapter has.
    uncertain: false,
  };
}

function resolveIdSets({ idSets, ledger, requestedIds, confirmation }) {
  if (ledger !== undefined && ledger !== null) {
    if (typeof ledger.snapshot !== 'function') {
      throw usageRefusal('ledger must be the object createRunLedger() returns');
    }
    return normalizeIdSets(ledger.snapshot({ confirmation }), 'the ledger snapshot');
  }
  if (idSets !== undefined && idSets !== null) return normalizeIdSets(idSets, 'idSets');
  return idSetsFromAttempted({ requestedIds, confirmation });
}

// ---------------------------------------------------------------------------
// Building the record.
// ---------------------------------------------------------------------------

function requireConfirmation(confirmation) {
  if (!isPlainObject(confirmation)) {
    throw usageRefusal('confirmation must be the result object returned by confirmArrival()');
  }
  for (const field of ['runId', 'exitCode', 'waitBoundMs', 'observedIds', 'expectedCount']) {
    if (confirmation[field] === undefined) {
      throw usageRefusal(
        `confirmation.${field} is missing — this must be the result object confirmArrival() returned, not a summary of it`
      );
    }
  }
  return confirmation;
}

/**
 * The outcome of a run that never reached a read-back at all, for a caller with
 * no confirmation to hand.
 *
 * It exists so that "the run had no confirmation" is never a reason to skip the
 * record. A nonzero exit code is required: a run that did not confirm anything
 * cannot be recorded as confirmed, and there is no shape here that lets it be.
 */
function requireOutcome(outcome) {
  if (!isPlainObject(outcome)) {
    throw usageRefusal(
      'with no confirmation, outcome must name the failure: {exitCode, reason}. A run that attempted a send is recorded on EVERY path, so an absent confirmation is never a reason to omit the record'
    );
  }
  if (!Number.isInteger(outcome.exitCode) || outcome.exitCode <= 0) {
    throw usageRefusal(
      'outcome.exitCode must be the nonzero code of the failure — a run with no confirmation observed no document and cannot be recorded as confirmed'
    );
  }
  requireNonEmptyString(outcome.reason, 'outcome.reason');
  return outcome;
}

function requireDefinition(definition) {
  if (!isPlainObject(definition)) {
    throw usageRefusal(
      'containerDefinition must be the result object returned by parseContainerDefinition()'
    );
  }
  for (const field of ['partitionKeyPath', 'partitionKeyField', 'measuredDefaultTtl']) {
    if (definition[field] === undefined || definition[field] === null) {
      throw usageRefusal(
        `containerDefinition.${field} is missing — the container shape must be MEASURED (HR4); no default is substituted here either`
      );
    }
  }
  return definition;
}

function requireTarget(target) {
  if (!isPlainObject(target)) {
    throw usageRefusal('target must name the hub, account, database and container');
  }
  // A record that does not say WHICH account, database and container it
  // describes is not mechanically consumable: MG-53 has to know where to look
  // for the documents it is checking, and MG-54 has to know what it is
  // authorised to delete FROM. These are names only — no endpoint carries a
  // credential, and the closed key set has no room for one.
  return Object.freeze({
    hub: requireNonEmptyString(target.hub, 'target.hub'),
    account: requireNonEmptyString(target.account, 'target.account'),
    database: requireNonEmptyString(target.database, 'target.database'),
    container: requireNonEmptyString(target.container, 'target.container'),
  });
}

function instantFrom(millis) {
  if (!Number.isFinite(millis)) {
    throw usageRefusal('the injected clock returned a non-finite instant');
  }
  return new Date(millis).toISOString();
}

/**
 * Build the evidence record for a run, on ANY outcome.
 *
 * Pure: it reads no file, no environment variable and no wall clock except the
 * injected one. It records what the run KNOWS, never what it hoped for, and it
 * has no path that can claim nothing was written (see the contract in the
 * header).
 *
 * @param {object} options
 * @param {object} [options.ledger] the run's ledger from createRunLedger(). The
 *   intended input: it is snapshotted here WITH the confirmation, so a caller
 *   cannot forget to fold the read-back's ids in.
 * @param {object} [options.idSets] a ledger snapshot, if the caller took it
 *   itself. The four sets are taken verbatim, then the confirmation's observed
 *   ids are merged in regardless — observation is monotonic in every place it
 *   passes through.
 * @param {string[]} [options.requestedIds] the fallback for a caller with
 *   neither: the ids it ATTEMPTED. Adapted fail-closed, see
 *   idSetsFromAttempted.
 * @param {object|null} [options.confirmation] the confirmArrival() (or
 *   abortedConfirmation()) result. May be null for a run that never reached the
 *   read-back, in which case `outcome` supplies the failure.
 * @param {{exitCode: number, reason: string}} [options.outcome] required when
 *   there is no confirmation.
 * @param {string} [options.runId] required when there is no confirmation to take
 *   it from.
 * @param {object} options.containerDefinition from parseContainerDefinition().
 * @param {{hub: string, account: string, database: string, container: string}} options.target
 * @param {string} [options.deviceId] the durable fixture device.
 * @param {Function} [options.now] injected clock; byte-reproducibility depends on it.
 */
export function buildEvidenceRecord({
  ledger,
  idSets,
  requestedIds,
  confirmation = null,
  outcome,
  runId,
  containerDefinition,
  target,
  deviceId = FIXTURE_DEVICE_ID,
  now = Date.now,
} = {}) {
  const hasConfirmation = confirmation !== null && confirmation !== undefined;
  if (hasConfirmation) requireConfirmation(confirmation);
  const failure = hasConfirmation ? null : requireOutcome(outcome);
  // Both given, disagreeing: the confirmation governs, and silently preferring it
  // would record an outcome the caller did not mean. A record whose exit code is
  // not the one the caller believed it wrote is unauditable, so it refuses and
  // says which input governs.
  if (hasConfirmation && isPlainObject(outcome) && outcome.exitCode !== confirmation.exitCode) {
    throw usageRefusal(
      `the confirmation exits ${confirmation.exitCode} but the supplied outcome claims ${JSON.stringify(outcome.exitCode)} — the confirmation governs when one is present, so pass no outcome alongside it rather than one that disagrees with it`
    );
  }
  requireDefinition(containerDefinition);
  const targetNames = requireTarget(target);
  requireNonEmptyString(deviceId, 'deviceId');

  const sets = resolveIdSets({ idSets, ledger, requestedIds, confirmation });

  const recordRunId = requireNonEmptyString(confirmation?.runId ?? sets.runId ?? runId, 'runId');
  // A ledger belonging to a different run than the confirmation is a wiring bug,
  // and the record it would produce is the worst kind: internally plausible and
  // attributing one run's documents to another. MG-54 deletes by these ids.
  for (const [source, value] of [
    ['the confirmation', confirmation?.runId],
    ['the ledger snapshot', sets.runId],
    ['runId', runId],
  ]) {
    if (typeof value === 'string' && value !== recordRunId) {
      throw usageRefusal(
        `${source} names a different run than this record does — an id set attributed to the wrong run is a wrong deletion downstream, so no evidence is written from it`
      );
    }
  }

  // Measuring one container and sending to another would record a retention and
  // a partition key that do not describe where the documents actually are — a
  // wrong record is worse than no record, so it refuses.
  if (
    typeof containerDefinition.containerName === 'string' &&
    containerDefinition.containerName !== targetNames.container
  ) {
    throw usageRefusal(
      `the measured definition describes container "${containerDefinition.containerName}" but the run targeted "${targetNames.container}" — recording a retention and a partition key measured from a different container would misdescribe where these documents are`
    );
  }

  const exitCode = hasConfirmation ? confirmation.exitCode : failure.exitCode;
  const outcomeSlug = outcomeName(exitCode);
  if (outcomeSlug === undefined) {
    throw usageRefusal(
      `exit code ${JSON.stringify(exitCode)} is not one of this tool's declared outcomes — an outcome MG-53 cannot name is one it cannot gate on, so the record is refused rather than written with an unreadable outcome`
    );
  }

  // OBSERVATION IS MONOTONIC, enforced here as well as in the ledger and in the
  // confirmation. Three places, one direction: nothing in this tool may remove an
  // id from the observed set, and a path added later inherits that by passing
  // through this line rather than by remembering to.
  const observedIds = mergeIds(
    sets.observedIds,
    hasConfirmation && Array.isArray(confirmation.observedIds) ? confirmation.observedIds : []
  );
  const requested = sets.requestedIds;
  const accepted = sets.acceptedIds;
  const ambiguous = sets.ambiguousIds;
  const count = observedIds.length;

  // A record must never claim more than the confirmation concluded. The
  // confirmation is the only thing entitled to say a run succeeded, and this
  // module is downstream of it: an inconsistency here is a bug in the caller's
  // wiring, and manufacturing a confirmed record out of it is precisely the
  // false proof this ticket exists to make impossible.
  const confirmed = confirmation?.confirmed === true && exitCode === EXIT.OK;
  if (confirmation?.confirmed === true && exitCode !== EXIT.OK) {
    throw usageRefusal(
      `the confirmation claims confirmed:true with exit code ${exitCode} — a confirmed run exits ${EXIT.OK}, so this result is internally inconsistent and no evidence is written from it`
    );
  }
  const expectedCount = confirmation?.expectedCount ?? MESSAGES_PER_RUN;
  if (confirmed && count !== expectedCount) {
    throw usageRefusal(
      `the confirmation claims success with ${count} observed document(s) against an expected ${expectedCount} — a confirmed run reads back the full expected set, so this result is internally inconsistent and no evidence is written from it`
    );
  }

  // Witnessed, never inferred. fixture-core owns the definition so that the
  // producer and every consumer of the flag mean the same thing by it.
  const idDivergence = observedIdsDiverge({ observedIds, requestedIds: requested });

  // The set a downstream ticket must ACCOUNT FOR: everything that is, or may be,
  // in the container. Computed here rather than left as a union for MG-53 to get
  // right — an off-by-one-set union is a document nothing accounts for, which is
  // the halt this artifact exists to prevent.
  const accountableIds = mergeIds(mergeIds(observedIds, accepted), ambiguous);

  const attempted = requested.length > 0 || accountableIds.length > 0;
  // Never weakened by an OR of anything: any one of these is sufficient, and the
  // ledger's own verdict is honoured if it is stricter than what is derivable
  // here.
  const uncertain = ambiguous.length > 0 || !confirmed || !hasConfirmation || sets.uncertain;

  // Documents the CORRELATED read-back returned that this run cannot claim. Kept
  // strictly apart from the observed set — recording one as ours would tell
  // MG-53 that a document it must halt on is accounted for — and recorded rather
  // than left in a log line, because an operator cannot investigate a document
  // nobody named.
  //
  // NOT the runbook's first stop condition, and deliberately no longer described
  // as it: the query that produced these already pinned this run's id, so every
  // id here belongs to a document carrying THIS run's correlator. See the header
  // block and `unknownWriterCheck` below.
  const anomalousIds = mergeIds(
    hasConfirmation && Array.isArray(confirmation.anomalousIds) ? confirmation.anomalousIds : []
  );

  const runMillis = now();
  const runInstant = instantFrom(runMillis);
  const measuredDefaultTtl = containerDefinition.measuredDefaultTtl;
  // -1 means TTL is enabled with no default expiry: nothing ages out, so there
  // is no expiry instant to derive and a downstream zero count could NOT be
  // explained by expiry. Recording a fabricated instant here would hand MG-53
  // the wrong explanation.
  const ttlExpires =
    containerDefinition.ttlExpires === undefined
      ? measuredDefaultTtl > 0
      : containerDefinition.ttlExpires === true;
  const expiryInstant = ttlExpires ? instantFrom(runMillis + measuredDefaultTtl * 1000) : null;
  const ttlDriftFinding = containerDefinition.ttlDriftFinding ?? null;

  const findings = [];
  if (ttlDriftFinding) {
    findings.push(
      Object.freeze({
        kind: ttlDriftFinding.kind ?? 'ttl-drift',
        measured: ttlDriftFinding.measured ?? measuredDefaultTtl,
        declared: ttlDriftFinding.declared ?? containerDefinition.declaredDefaultTtl ?? null,
        message: ttlDriftFinding.message ?? 'measured default_ttl differs from the declared value',
      })
    );
  }
  if (idDivergence) {
    // An observation, NOT a failure, and recorded on every outcome rather than
    // only on a confirmed one: the correlation key is the marker plus the run
    // id, so a platform that renamed every document still leaves the proof
    // intact — and MG-54 cites ids, which have to be the ids that exist.
    findings.push(
      Object.freeze({
        kind: 'id-divergence',
        measured: count,
        declared: requested.length,
        message: `${observedIds.filter(id => !requested.includes(id)).length} document(s) were OBSERVED under an id the sender did not request; both lists are recorded and the OBSERVED ids are the ones that exist in the container`,
      })
    );
  }
  if (ambiguous.length > 0) {
    // The crux of the contract, said out loud in the artifact. A send failure is
    // ambiguous BY CONSTRUCTION: az can fail after IoT Hub accepted the message,
    // so these ids may be in the container and must never be read as not-sent.
    findings.push(
      Object.freeze({
        kind: 'ambiguous-acceptance',
        measured: ambiguous.length,
        declared: requested.length,
        message: `${ambiguous.length} of ${requested.length} attempted message(s) have UNKNOWN acceptance — az reported failure, which can happen after IoT Hub took the message, so these ids MAY be in the container and must never be read as evidence that nothing was written`,
      })
    );
  }
  if (anomalousIds.length > 0) {
    findings.push(
      Object.freeze({
        kind: 'unattributable-documents',
        measured: anomalousIds.length,
        declared: count,
        // Says what it actually detects. The read-back is filtered to this run's
        // correlator, so these documents carry THIS run's run id and failed the
        // marker or named a foreign run — a sender-side defect or a correlator
        // collision, investigable by id. Claiming them as the unknown-writer
        // stop condition would be a detection this record cannot perform.
        message: `${anomalousIds.length} document(s) returned by the correlated read-back are NOT attributable to this run and are recorded by id, apart from this run's own. The read-back is filtered to this run's ${RUN_ID_FIELD}, so these carry THIS run's correlator and are a sender-side marker defect or a correlator collision — investigate them by id. They are NOT evidence about an unknown writer: see unknownWriterCheck, and check that stop condition with an unfiltered enumeration.`,
      })
    );
  }
  if (!ttlExpires) {
    findings.push(
      Object.freeze({
        kind: 'no-ttl-expiry',
        measured: measuredDefaultTtl,
        declared: containerDefinition.declaredDefaultTtl ?? null,
        message:
          'the measured default_ttl is -1 (TTL enabled, no default expiry): these documents do not age out, so a later zero count must NOT be read as expiry',
      })
    );
  }
  if (!confirmed) {
    findings.push(
      Object.freeze({
        kind: 'unconfirmed-run',
        measured: count,
        declared: expectedCount,
        message: `this run was NOT confirmed (exit ${exitCode}, ${exitLabel(exitCode)}); the record exists to preserve what was observed and what may exist, and must not be read either as proof that the path carried a message or as proof that it did not`,
      })
    );
  }

  const record = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: EVIDENCE_KIND,
    ticket: TICKET,
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,

    runId: recordRunId,
    runInstant,
    confirmed,
    // True whenever anything was attempted whose acceptance is unknown, or no
    // confirmation completed. A consumer reading `count: 0` alongside
    // `uncertain: true` is being told "this run does not know what is in the
    // container", which is never the same sentence as "nothing is".
    uncertain,
    attempted,
    outcome: outcomeSlug,
    exitCode,
    exitLabel: exitLabel(exitCode),
    outcomeReason: (hasConfirmation ? confirmation.reason : failure.reason) ?? '',
    scope: (hasConfirmation ? confirmation.scope : null) ?? null,

    marker: {
      field: SYNTHETIC_MARKER_FIELD,
      value: SYNTHETIC_MARKER,
      runIdField: RUN_ID_FIELD,
    },
    deviceId,

    target: targetNames,
    containerName: containerDefinition.containerName ?? null,
    partitionKeyPath: containerDefinition.partitionKeyPath,
    partitionKeyField: containerDefinition.partitionKeyField,
    partitionValue: confirmation?.partitionValue ?? deviceId,
    observedPartitionValues: [...(confirmation?.observedPartitionValues ?? [])],

    // The four sets of the evidence-emission contract, each with its own count.
    requestedIds: requested,
    requestedCount: requested.length,
    acceptedIds: accepted,
    acceptedCount: accepted.length,
    ambiguousIds: ambiguous,
    ambiguousCount: ambiguous.length,
    observedIds,
    observedCount: count,

    // Everything that is or may be in the container, unioned once, here.
    accountableIds,
    accountableCount: accountableIds.length,
    // And everything the CORRELATED read-back saw that this run cannot claim —
    // which, because that read-back is filtered to this run's id, is never a
    // document an unknown writer produced. The next field says so out loud so a
    // mechanical consumer cannot read `anomalousCount: 0` as a cleared stop
    // condition.
    anomalousIds,
    anomalousCount: anomalousIds.length,
    unknownWriterCheck: UNKNOWN_WRITER_CHECK,

    // Schema-version-1 aliases for the OBSERVED set. Derived from the same
    // array, so the two names cannot disagree about what was read back.
    ids: observedIds,
    count,
    expectedCount,
    idDivergence,

    measuredDefaultTtl,
    declaredDefaultTtl: containerDefinition.declaredDefaultTtl ?? null,
    ttlExpires,
    ttlDriftFinding: ttlDriftFinding
      ? {
          kind: ttlDriftFinding.kind ?? 'ttl-drift',
          measured: ttlDriftFinding.measured ?? measuredDefaultTtl,
          declared: ttlDriftFinding.declared ?? containerDefinition.declaredDefaultTtl ?? null,
          message: ttlDriftFinding.message ?? '',
        }
      : null,
    expiryInstant,

    waitBoundMs: confirmation?.waitBoundMs ?? null,
    pollIntervalMs: confirmation?.pollIntervalMs ?? null,
    observedArrivalMs: confirmation?.observedArrivalMs ?? null,
    elapsedMs: confirmation?.elapsedMs ?? null,
    polls: confirmation?.polls ?? null,
    crossPartitionSweepRun: confirmation?.crossPartitionSweepRun === true,

    findings,
  };

  // The guard runs at BUILD time as well as at write time. A caller that only
  // serializes the record (to attach it to a ticket by hand, say) gets the same
  // refusal as one that writes it.
  assertNoCredentialShape(record);
  // Deep enough to cover every list: Object.freeze is shallow, and an id set a
  // consumer can mutate is an id set that can lose an id after it was recorded.
  // `ids` and `observedIds` are deliberately the SAME array — two names for one
  // set cannot drift if there is only one set.
  for (const list of [
    record.requestedIds,
    record.acceptedIds,
    record.ambiguousIds,
    record.observedIds,
    record.accountableIds,
    record.anomalousIds,
    record.observedPartitionValues,
    record.findings,
  ]) {
    Object.freeze(list);
  }
  Object.freeze(record.marker);
  if (record.ttlDriftFinding) Object.freeze(record.ttlDriftFinding);
  return Object.freeze(record);
}

/**
 * The record's exact bytes. Key order is the builder's literal order, so the
 * same inputs and the same injected clock produce the same file every time —
 * which is what makes a byte-level assertion in a test meaningful.
 */
export function serializeEvidenceRecord(record) {
  assertNoCredentialShape(record);
  return `${JSON.stringify(record, null, 2)}\n`;
}

/**
 * Write the record atomically to `filePath`.
 *
 * Partial-then-rename, so no reader ever sees a half-written document and a
 * failed write leaves no debris that could be mistaken for evidence. Refuses to
 * overwrite an existing file unless `overwrite` is passed: the earlier run's
 * documents are still in the container, and destroying the record of them
 * manufactures the unrecorded-document condition that halts MG-53.
 *
 * @param {object} record from buildEvidenceRecord().
 * @param {string} filePath operator-chosen destination.
 * @param {{fs?: object, overwrite?: boolean}} [options] fs is injected so the
 *   rename-failure path is testable without breaking a real filesystem.
 */
export async function writeEvidenceRecord(record, filePath, options = {}) {
  const { fs = { writeFile, rename, rm, stat }, overwrite = false } = options;
  requireNonEmptyString(filePath, 'filePath');
  const serialized = serializeEvidenceRecord(record);
  const partialPath = partialPathFor(filePath);

  if (!overwrite) {
    let existing = null;
    try {
      existing = await fs.stat(filePath);
    } catch {
      // Absent is the expected case. Any other stat failure (a permission
      // problem, say) surfaces below when the write itself fails, with the
      // error that actually describes it.
    }
    if (existing) {
      throw usageRefusal(
        `refusing to overwrite the existing evidence file at ${filePath}: it records an earlier run whose documents are still in the container, and MG-53 halts on a document no record accounts for. Choose a new path, or pass overwrite explicitly.`
      );
    }
  }

  try {
    await fs.writeFile(partialPath, serialized, 'utf8');
    await fs.rename(partialPath, filePath);
  } catch (err) {
    // No partial is left behind. A `.partial` file lying next to the target
    // looks enough like evidence to be picked up by hand, and this write is the
    // one that failed.
    await fs.rm(partialPath, { force: true }).catch(() => {});
    throw usageRefusal(
      `failed to write the evidence record to ${filePath}: ${err?.code ?? err?.name ?? 'write error'}. No partial file was left behind, and no evidence was recorded for this run.`
    );
  }

  return Object.freeze({ path: filePath, bytes: Buffer.byteLength(serialized), record });
}

/**
 * One operator-facing line, built only from the record's own fields.
 *
 * It states the observed count AND the count that may exist. A line that named
 * only the first reads as "nothing arrived" on every failure path, which is the
 * sentence this contract exists to stop the tool from saying.
 */
export function describeEvidence(record, filePath) {
  const ttl =
    record.measuredDefaultTtl === -1
      ? 'measured default_ttl -1 (no expiry)'
      : `measured default_ttl ${record.measuredDefaultTtl}s, expires ${record.expiryInstant}`;
  const drift = record.ttlDriftFinding ? ' [TTL DRIFT]' : '';
  const divergence = record.idDivergence ? ' [ID DIVERGENCE]' : '';
  const anomalies = record.anomalousCount > 0 ? ` [${record.anomalousCount} UNATTRIBUTABLE]` : '';
  // Only said when the two numbers differ: on a confirmed run they are the same
  // set, and repeating it would bury the difference where it matters.
  const accountable =
    record.accountableCount === record.count
      ? ''
      : `, ${record.accountableCount} document(s) are or MAY BE in the container (${record.ambiguousCount} of unknown acceptance)`;
  return (
    `evidence ${filePath}: ${record.confirmed ? 'CONFIRMED' : `NOT CONFIRMED (${record.exitLabel})`} — ` +
    `${record.count}/${record.expectedCount} document(s) read back for run ${record.runId} ` +
    `in ${record.target.database}/${record.target.container}${accountable}, ${ttl}${drift}${divergence}${anomalies}`
  );
}
