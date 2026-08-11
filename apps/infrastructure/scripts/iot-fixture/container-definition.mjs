// MeatGeek — measuring the destination container's real shape (MG-67).
//
// HR4 of this ticket is one word: MEASURE. The synthetic documents this tool
// causes to be written age out on the container's own TTL clock, and two
// downstream tickets act on that number — MG-53 halts if the source holds a
// document it did not expect, MG-54 authorises disposing of the ones recorded
// here. A count that came back smaller than what was recorded is expected TTL
// expiry ONLY if the TTL is known; guessed, it is indistinguishable from "the
// write never happened". So nothing in this module carries a fallback: no
// hardcoded partition key path, and no hardcoded retention. A document this
// module cannot read is a REFUSAL (EXIT.CONTAINER_DEFINITION), never a default.
//
// The same measurement fixes the body shape. The routing endpoint injects no
// partition key — the message body is the only source of one — so the field the
// sender must spell is whatever the container's partition key path names, and
// that is read here rather than assumed.
//
// THE CREDENTIALLESS SPLIT. This module holds no Azure identity and opens no
// socket: `az cosmosdb sql container show` produces the document, this consumes
// it as TEXT. Same division as scripts/assert-live-host-storage.sh, where az
// produces the settings document and the logic that judges it can therefore run
// in CI with no credential at all. It is also what makes every refusal path
// below testable from the build container, which has no Azure access.
//
// DRIFT IS A FINDING, NOT A SUBSTITUTION. apps/infrastructure declares the dev
// retention as temperature_data_ttl_days = 7 (environments/dev.tfvars), and
// modules/cosmos-db converts it to seconds. That declared number appears here
// for exactly one purpose: to be COMPARED against what was measured, so an
// operator is told when the live container disagrees with the code. The measured
// value is what is returned and what the evidence records, always. A drift is
// surfaced and recorded; it is not a hard failure, because a container that
// really does hold a different TTL is still a container this proof can traverse.
//
// WHERE THIS SITS IN THE EVIDENCE-EMISSION CONTRACT. That contract says an
// evidence record is emitted on EVERY outcome once any message has been
// attempted, and that only a run which refused BEFORE its first send may exit
// without one. This module is on the second side of that line by construction:
// it is a pure function over text, it is called once to derive the body shape
// the sender needs, and it therefore cannot run after a live effect. Two
// obligations follow, and both are asserted by test rather than trusted:
//
//   - A caller must never re-measure after a send. Doing so would manufacture
//     an exit path that had live effect and no evidence record — the one hole
//     the contract exists to close.
//   - A measurement is COMPLETE OR ABSENT. Every definition this module returns
//     carries partitionKeyPath, partitionKeyField and measuredDefaultTtl,
//     non-null; a reading that could not produce all three throws instead of
//     returning a partial object. That is what lets the evidence builder — which
//     refuses a partial definition — be called unconditionally on every
//     post-send path, including the failure paths, without the refusal itself
//     becoming the reason a live run went unrecorded.
//
// REFUSALS ECHO NOTHING. A container definition is not a credential-bearing
// document, but the refusals below still never quote the input back: a parse
// failure reports an offset and a byte count, and a bad value reports its TYPE.
// The few fragments that are echoed (a container name, a partition key path) go
// through the same scrub every other operator-facing line in this tool uses.

import { EXIT, FixtureError, partitionKeyFieldProblem, scrubSecrets } from './fixture-core.mjs';

// The DECLARED dev retention, spelled the way apps/infrastructure spells it:
// environments/dev.tfvars sets temperature_data_ttl_days, main.tf multiplies by
// seconds-per-day. Written as that multiplication rather than as its product so
// this constant cannot silently disagree with the Terraform it mirrors — and so
// that no retention literal exists in this file for a future edit to reach for
// as a fallback.
export const SECONDS_PER_DAY = 86400;
export const DECLARED_TTL_DAYS = 7;
export const DECLARED_DEFAULT_TTL_SECONDS = DECLARED_TTL_DAYS * SECONDS_PER_DAY;

// A fragment echoed into a refusal is capped and scrubbed. Diagnosability is
// worth a container name; it is not worth an unbounded echo of text this repo
// did not author.
const FRAGMENT_MAX_LENGTH = 80;

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

function typeName(value) {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'an array';
  return `a ${typeof value}`;
}

function safeFragment(value) {
  if (typeof value !== 'string') return typeName(value);
  const cleaned = scrubSecrets(value).replace(/\s+/g, ' ').trim();
  if (cleaned === '') return '(empty)';
  return cleaned.length > FRAGMENT_MAX_LENGTH
    ? `${cleaned.slice(0, FRAGMENT_MAX_LENGTH)}…`
    : cleaned;
}

// Every refusal in this module is the same class, so an operator's script reads
// one exit code and the message says which of the readings failed.
function refusal(message) {
  return new FixtureError(EXIT.CONTAINER_DEFINITION, `container definition: ${message}`);
}

const SHOW_HINT =
  'expected the output of `az cosmosdb sql container show` for the destination container';

function parseJsonDocument(text) {
  if (typeof text !== 'string' || text.trim() === '') {
    // The single most likely way this happens live: az failed, printed its
    // error to stderr and nothing to stdout, and the pipe delivered an empty
    // string. Reading that as "no TTL configured" would be the exact
    // absence-for-an-error conflation this ticket exists to refuse.
    throw refusal(`no document was supplied (empty input) — ${SHOW_HINT}`);
  }
  try {
    return JSON.parse(text);
  } catch (err) {
    // Node's JSON SyntaxError quotes a slice of the offending input into its
    // message. That slice is not echoed: the offset and the size are enough for
    // an operator to find the truncation, and neither is a fact about content.
    const match = /position (\d+)/.exec(String(err?.message ?? ''));
    const where = match ? ` at byte offset ${match[1]}` : '';
    throw refusal(
      `the document is not valid JSON${where} (${text.length} bytes read) — ${SHOW_HINT}`
    );
  }
}

// az emits the ARM response: the container's real properties live under
// `resource`. An operator who narrowed the output with `--query resource` hands
// over that block directly, which is accepted — but a `resource` that is present
// and not an object is refused rather than skipped past, because that is what a
// failed `--query` looks like.
function pickResourceNode(doc) {
  if (Array.isArray(doc)) {
    throw refusal(
      'the document is a JSON array — that is the shape of `az cosmosdb sql container list`; ' +
        `this tool measures ONE container, so ${SHOW_HINT}`
    );
  }
  if (!isPlainObject(doc)) {
    throw refusal(`the document is ${typeName(doc)}, not an object — ${SHOW_HINT}`);
  }
  if (Object.prototype.hasOwnProperty.call(doc, 'resource')) {
    if (!isPlainObject(doc.resource)) {
      throw refusal(
        `"resource" is ${typeName(doc.resource)}, not an object — ${SHOW_HINT} (unnarrowed, or narrowed with --query resource)`
      );
    }
    return doc.resource;
  }
  if (isPlainObject(doc.partitionKey)) return doc;
  throw refusal(
    `the document carries neither a "resource" block nor a "partitionKey" — ${SHOW_HINT}`
  );
}

function readContainerName(doc, node) {
  if (typeof node.id === 'string' && node.id.trim() !== '') return node.id;
  if (typeof doc.name === 'string' && doc.name.trim() !== '') return doc.name;
  return null;
}

// A partition key path that this tool cannot spell as ONE flat body field is a
// refusal, not a best effort. The sender puts the value in the body and nothing
// downstream rewrites it, so a hierarchical or nested key would produce
// documents that land under a partition the confirmation read-back cannot
// address — a false failure reported against a working route.
function readPartitionKey(node) {
  const partitionKey = node.partitionKey;
  if (!isPlainObject(partitionKey)) {
    throw refusal(
      `no partitionKey block (found ${typeName(partitionKey)}) — the partition key path cannot be measured, and this tool substitutes no default`
    );
  }
  const paths = partitionKey.paths;
  if (!Array.isArray(paths) || paths.length === 0) {
    throw refusal(
      `partitionKey.paths is ${typeName(paths)} or empty — the partition key path cannot be measured, and this tool substitutes no default`
    );
  }
  if (paths.length > 1) {
    throw refusal(
      `the container has a hierarchical partition key (${paths.length} paths) — this fixture writes one flat body field and cannot address such a partition`
    );
  }
  const kind = typeof partitionKey.kind === 'string' ? partitionKey.kind : null;
  if (kind !== null && kind.toLowerCase() === 'multihash') {
    throw refusal(
      `the partition key kind is ${safeFragment(kind)} — this fixture writes one flat body field and cannot address such a partition`
    );
  }
  const path = paths[0];
  if (typeof path !== 'string' || !path.startsWith('/') || path.length < 2) {
    throw refusal(`the partition key path ${safeFragment(path)} is not a "/field" path`);
  }
  if (path.indexOf('/', 1) !== -1) {
    throw refusal(
      `the partition key path ${safeFragment(path)} is nested — this fixture writes one flat body field and cannot address such a partition`
    );
  }
  const field = path.slice(1);
  // The SHARED predicate from fixture-core, not a second opinion about what a
  // legal field is. This module and the sender used to hold slightly different
  // rules, and the cost was an exit code that misreported the refusal: a
  // hyphenated or digit-leading path measured cleanly here and was then rejected
  // by the sender as EXIT.USAGE — "bad arguments, nothing live happened" — when
  // the truth is that the MEASURED container has a shape this fixture cannot
  // address. That is this module's refusal to make, and it carries this module's
  // code (EXIT.CONTAINER_DEFINITION), like every other reading that failed here.
  const problem = partitionKeyFieldProblem(field);
  if (problem !== null) {
    throw refusal(
      `the partition key path ${safeFragment(path)} names a field this fixture cannot use: ${problem}`
    );
  }
  return {
    partitionKeyPath: path,
    partitionKeyField: field,
    partitionKeyKind: kind,
    partitionKeyVersion: Number.isInteger(partitionKey.version) ? partitionKey.version : null,
  };
}

// az serialises the ARM model as camelCase; the Terraform attribute and older
// tooling spell it with an underscore. Both are read, and if BOTH are present
// and disagree the reading is ambiguous — which is a refusal, because picking
// one would be a guess recorded as a measurement.
const TTL_KEYS = ['defaultTtl', 'default_ttl'];

function readDefaultTtl(node) {
  const present = TTL_KEYS.filter(
    key =>
      Object.prototype.hasOwnProperty.call(node, key) &&
      node[key] !== null &&
      node[key] !== undefined
  );
  if (present.length === 0) {
    // Either the container really has no default TTL, or the document did not
    // carry it. Both are "this tool did not measure a retention", and the
    // declared value is NOT stood in — a recorded retention that was assumed
    // would make a downstream zero-count unclassifiable, which is the whole
    // reason HR4 says measure.
    throw refusal(
      'no default_ttl was present — either the container has no default TTL or the document did not carry it; the retention is unmeasured and no declared value is substituted'
    );
  }
  if (present.length === 2 && node[TTL_KEYS[0]] !== node[TTL_KEYS[1]]) {
    throw refusal(
      `the document carries both "${TTL_KEYS[0]}" and "${TTL_KEYS[1]}" with different values — the retention reading is ambiguous`
    );
  }
  const raw = node[present[0]];
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw refusal(
      `default_ttl is ${typeName(raw)}, not an integer number of seconds — the retention is unmeasured and no declared value is substituted`
    );
  }
  // Cosmos defines exactly two legal shapes: a positive number of seconds, or
  // -1 for "TTL enabled, no default expiry". 0 and other negatives are neither.
  if (raw === 0 || raw < -1) {
    throw refusal(
      `default_ttl is ${raw}, which is not a legal Cosmos value (a positive number of seconds, or -1 for no expiry)`
    );
  }
  return raw;
}

function buildTtlDriftFinding(measured, declared) {
  if (measured === declared) return null;
  const shared =
    `measured default_ttl is ${measured === -1 ? '-1 (TTL enabled, no expiry)' : `${measured}s`}` +
    ` but apps/infrastructure declares ${declared}s (temperature_data_ttl_days = ${DECLARED_TTL_DAYS}) for dev`;
  const consequence =
    measured === -1
      ? 'documents written by this run will NOT age out, so a later count must not be read as expiry'
      : 'the MEASURED value is what is recorded; the declared value is not substituted';
  return Object.freeze({
    kind: 'ttl-drift',
    measured,
    declared,
    message: `configuration drift — ${shared}. ${consequence}.`,
  });
}

/**
 * Measure the destination container's shape from an `az cosmosdb sql container
 * show` document supplied as text.
 *
 * Throws a FixtureError carrying EXIT.CONTAINER_DEFINITION — and returns
 * nothing at all — for any document whose partition key path or default_ttl
 * cannot be read. No default is ever substituted for either.
 *
 * @param {string} text the az document, verbatim
 * @param {{declaredDefaultTtl?: number, expectedContainer?: string|null}} [options]
 *   declaredDefaultTtl is a COMPARAND for the drift finding only; it is never
 *   returned as a measurement. expectedContainer, when given, refuses a document
 *   that describes some other container.
 */
export function parseContainerDefinition(text, options = {}) {
  const { declaredDefaultTtl = DECLARED_DEFAULT_TTL_SECONDS, expectedContainer = null } = options;
  const doc = parseJsonDocument(text);
  const node = pickResourceNode(doc);
  const containerName = readContainerName(doc, node);

  if (expectedContainer !== null && expectedContainer !== undefined) {
    if (containerName === null) {
      throw refusal(
        `the document names no container, so it cannot be confirmed to describe ${safeFragment(expectedContainer)}`
      );
    }
    if (containerName !== expectedContainer) {
      throw refusal(
        `the document describes container ${safeFragment(containerName)}, not ${safeFragment(expectedContainer)} — measuring the wrong container would record a retention and a partition key that do not apply`
      );
    }
  }

  const partitionKey = readPartitionKey(node);
  const measuredDefaultTtl = readDefaultTtl(node);
  const ttlDriftFinding = buildTtlDriftFinding(measuredDefaultTtl, declaredDefaultTtl);

  return Object.freeze({
    containerName,
    ...partitionKey,
    measuredDefaultTtl,
    // -1 means TTL is on with no default expiry: nothing ages out. The evidence
    // record needs this to decide whether an expiry instant exists at all.
    ttlExpires: measuredDefaultTtl > 0,
    declaredDefaultTtl,
    ttlDriftFinding,
    findings: Object.freeze(ttlDriftFinding ? [ttlDriftFinding] : []),
  });
}

// One operator-facing line, built only from measured values. No branch of this
// prints anything the tool did not read out of the definition it was given.
export function describeContainerDefinition(definition) {
  const name = definition.containerName === null ? '(unnamed)' : definition.containerName;
  const kind =
    definition.partitionKeyKind === null ? 'unspecified kind' : definition.partitionKeyKind;
  const ttl =
    definition.measuredDefaultTtl === -1
      ? 'default_ttl -1 (no expiry)'
      : `default_ttl ${definition.measuredDefaultTtl}s (measured)`;
  const drift =
    definition.ttlDriftFinding === null
      ? `matches the declared ${definition.declaredDefaultTtl}s`
      : `DRIFT from the declared ${definition.declaredDefaultTtl}s`;
  return `${name}: partition key ${definition.partitionKeyPath} (${kind}), ${ttl}, ${drift}`;
}
