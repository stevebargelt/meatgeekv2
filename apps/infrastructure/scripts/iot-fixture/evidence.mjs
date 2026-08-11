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
//   3. A CREDENTIAL-SHAPED VALUE scan over every string in the record.
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
  MESSAGES_PER_RUN,
  RUN_ID_FIELD,
  SYNTHETIC_MARKER,
  SYNTHETIC_MARKER_FIELD,
  TICKET,
  TOOL_NAME,
  TOOL_VERSION,
  exitLabel,
} from './fixture-core.mjs';

// Bumped when a key is added, removed or re-meant. MG-53 and MG-54 read this
// first and refuse a version they were not written against — a silently
// reshaped record consumed by an older reader is how a deletion gate acts on a
// field that no longer means what it did.
export const EVIDENCE_SCHEMA_VERSION = 1;
export const EVIDENCE_KIND = 'mg67-device-fixture-evidence';

// Written next to the target so the rename is same-filesystem and therefore
// atomic. A cross-device rename is not, and a temp directory elsewhere would
// silently degrade the one property this write has.
export const PARTIAL_SUFFIX = '.partial';

export const partialPathFor = filePath => `${filePath}${PARTIAL_SUFFIX}`;

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
    // The run.
    'runId',
    'runInstant',
    'confirmed',
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
    // What was written, as OBSERVED and as REQUESTED.
    'ids',
    'count',
    'requestedIds',
    'requestedCount',
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

function requireStringArray(value, name) {
  if (!Array.isArray(value) || value.some(item => typeof item !== 'string' || item.trim() === '')) {
    throw usageRefusal(`${name} must be an array of non-empty strings`);
  }
  return [...value];
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
 * build or write this record, once a send has happened, to
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

const sameIdSet = (a, b) => {
  if (a.length !== b.length) return false;
  const left = [...a].sort();
  const right = [...b].sort();
  return left.every((value, index) => value === right[index]);
};

function instantFrom(millis) {
  if (!Number.isFinite(millis)) {
    throw usageRefusal('the injected clock returned a non-finite instant');
  }
  return new Date(millis).toISOString();
}

/**
 * Build the evidence record from a confirmation result and a measured container
 * definition. Pure: it reads no file, no environment variable and no wall clock
 * except the injected one.
 *
 * Records what was OBSERVED, never what was hoped for. `ids` and `count` are the
 * documents the read-back actually saw; `requestedIds` are the ids the sender
 * put in the bodies. They can legitimately differ — whether the IoT Hub Cosmos
 * endpoint honours a supplied `id` is platform behaviour no file in this repo
 * pins down — so a divergence is recorded as an OBSERVATION with both lists
 * kept, and is never a failure.
 *
 * @param {object} options
 * @param {object} options.confirmation the frozen result from confirmArrival().
 * @param {object} options.containerDefinition from parseContainerDefinition().
 * @param {string[]} options.requestedIds the `id` each sent body carried.
 * @param {{hub: string, account: string, database: string, container: string}} options.target
 * @param {string} [options.deviceId] the durable fixture device.
 * @param {Function} [options.now] injected clock; byte-reproducibility depends on it.
 */
export function buildEvidenceRecord({
  confirmation,
  containerDefinition,
  requestedIds = [],
  target,
  deviceId = FIXTURE_DEVICE_ID,
  now = Date.now,
} = {}) {
  requireConfirmation(confirmation);
  requireDefinition(containerDefinition);
  const targetNames = requireTarget(target);
  requireNonEmptyString(deviceId, 'deviceId');
  const requested = requireStringArray(requestedIds, 'requestedIds');

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

  const ids = requireStringArray(confirmation.observedIds ?? [], 'confirmation.observedIds');
  const count = ids.length;

  // A record must never claim more than the confirmation concluded. The
  // confirmation is the only thing entitled to say a run succeeded, and this
  // module is downstream of it: an inconsistency here is a bug in the caller's
  // wiring, and manufacturing a confirmed record out of it is precisely the
  // false proof this ticket exists to make impossible.
  const confirmed = confirmation.confirmed === true && confirmation.exitCode === EXIT.OK;
  if (confirmation.confirmed === true && confirmation.exitCode !== EXIT.OK) {
    throw usageRefusal(
      `the confirmation claims confirmed:true with exit code ${confirmation.exitCode} — a confirmed run exits ${EXIT.OK}, so this result is internally inconsistent and no evidence is written from it`
    );
  }
  if (confirmed && count !== confirmation.expectedCount) {
    throw usageRefusal(
      `the confirmation claims success with ${count} observed document(s) against an expected ${confirmation.expectedCount} — a confirmed run reads back the full expected set, so this result is internally inconsistent and no evidence is written from it`
    );
  }

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

  const idDivergence = !sameIdSet(ids, requested);
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
  if (confirmed && idDivergence) {
    // An observation, NOT a failure: the correlation key is the marker plus the
    // run id, so a platform that renamed every document still leaves the proof
    // intact. It is recorded because MG-54 cites ids, and the ids it must cite
    // are the ones that exist.
    findings.push(
      Object.freeze({
        kind: 'id-divergence',
        measured: count,
        declared: requested.length,
        message: `the platform assigned document ids that differ from the ${requested.length} the sender requested; both lists are recorded and the OBSERVED ids are the ones that exist in the container`,
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
        declared: confirmation.expectedCount,
        message: `this run was NOT confirmed (exit ${confirmation.exitCode}, ${exitLabel(confirmation.exitCode)}); the record exists to preserve what was observed and must not be read as proof that the path carried a message`,
      })
    );
  }

  const record = {
    schemaVersion: EVIDENCE_SCHEMA_VERSION,
    kind: EVIDENCE_KIND,
    ticket: TICKET,
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,

    runId: confirmation.runId,
    runInstant,
    confirmed,
    exitCode: confirmation.exitCode,
    exitLabel: exitLabel(confirmation.exitCode),
    outcomeReason: typeof confirmation.reason === 'string' ? confirmation.reason : '',
    scope: confirmation.scope ?? null,

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
    partitionValue: confirmation.partitionValue ?? deviceId,
    observedPartitionValues: [...(confirmation.observedPartitionValues ?? [])],

    ids,
    count,
    requestedIds: requested,
    requestedCount: requested.length,
    expectedCount: confirmation.expectedCount ?? MESSAGES_PER_RUN,
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

    waitBoundMs: confirmation.waitBoundMs,
    pollIntervalMs: confirmation.pollIntervalMs ?? null,
    observedArrivalMs: confirmation.observedArrivalMs ?? null,
    elapsedMs: confirmation.elapsedMs ?? null,
    polls: confirmation.polls ?? null,
    crossPartitionSweepRun: confirmation.crossPartitionSweepRun === true,

    findings,
  };

  // The guard runs at BUILD time as well as at write time. A caller that only
  // serializes the record (to attach it to a ticket by hand, say) gets the same
  // refusal as one that writes it.
  assertNoCredentialShape(record);
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

/** One operator-facing line, built only from the record's own fields. */
export function describeEvidence(record, filePath) {
  const ttl =
    record.measuredDefaultTtl === -1
      ? 'measured default_ttl -1 (no expiry)'
      : `measured default_ttl ${record.measuredDefaultTtl}s, expires ${record.expiryInstant}`;
  const drift = record.ttlDriftFinding ? ' [TTL DRIFT]' : '';
  const divergence = record.idDivergence ? ' [ID DIVERGENCE]' : '';
  return (
    `evidence ${filePath}: ${record.confirmed ? 'CONFIRMED' : `NOT CONFIRMED (${record.exitLabel})`} — ` +
    `${record.count}/${record.expectedCount} document(s) recorded for run ${record.runId} ` +
    `in ${record.target.database}/${record.target.container}, ${ttl}${drift}${divergence}`
  );
}
