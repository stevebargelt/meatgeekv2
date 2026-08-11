// MeatGeek — dev IoT device fixture core (MG-67).
//
// This module is the foundation of a tool whose ONLY job is to prove, once and
// repeatably, that the device -> IoT Hub -> route -> Cosmos path carries a
// message. That path is the only write path in the product and nothing has ever
// been observed to traverse it: measured 2026-08-10, every container in the dev
// database held zero documents.
//
// So the failure this code is built to refuse is not "the send crashed" — it is
// "the tool exited 0 without a document having been read back out of Cosmos".
// Exit 0 means exactly one thing: the expected count of marker-carrying,
// run-correlated documents was READ BACK OUT of the destination container. An
// absence of errors is never success, an auth failure is never an absence, a
// timeout is never a success, and an unreadable or ambiguous read-back is a
// failure rather than either. Every one of those outcomes gets its OWN nonzero
// exit code below, because two downstream tickets (MG-53's source-only-holds-
// recorded-documents check, MG-54's disposal authorization) act on what this
// tool concluded, and a collapsed vocabulary would make "the route is broken"
// indistinguishable from "your RBAC grant has not propagated yet".
//
// WHY THIS IS A SIBLING OF cosmos-export AND NOT A SHARED BASE. The scrubber and
// the fake here are deliberately near-duplicates of the ones in
// apps/infrastructure/scripts/cosmos-export/ (MG-48/MG-49) and this module
// imports NOTHING from that directory. Two reasons, both concrete: that tool is
// MG-66's live surface and must not move underneath it, and its fake models a
// count-only `SELECT VALUE COUNT(1)` query — the exact shape this tool may not
// use, because a count delta is not a correlation. Three similar functions in
// three tools beat a premature base class that couples a one-off proof to a
// deletion gate.
//
// The MG-63 over-redaction limitation in the sibling scrubber (a credential-
// shaped key name ALWAYS redacts, so `partitionKey=deviceId` reads
// `partitionKey=[redacted]`) is reproduced here deliberately and is NOT
// reopened. It is an accepted diagnostic-readability cost that deletes a whole
// class of "where does the value end" leaks.
//
// READ-ONLY AGAINST COSMOS: this tool is a Cosmos READER. It causes documents to
// arrive by sending a device message; it never writes to Cosmos, and it creates,
// repoints or deletes no Cosmos resource. fixture-core.test.mjs asserts that
// mechanically against the source text.
//
// ACCEPTED DEVIATION FROM libs/api-specs TemperatureReading, FLAGGED TO MG-59.
// spec/components/schemas/temperature.yaml declares `additionalProperties: false`
// on TemperatureReading, and the bodies this module builds deliberately carry
// four properties that schema forbids: the synthetic marker, the run id, the
// sequence and the ticket. That is not an oversight and the schema is NOT edited
// here. HR3 requires an unmistakable marker IN THE BODY — it is the only field
// that survives the trip through the hub into a Cosmos document, and without it
// MG-53 cannot tell a fixture document from a real reading and MG-54 cannot cite
// what it is authorised to dispose of. The fixture is not an API producer: no
// handler validates these bodies against the schema, because nothing in the repo
// reads this container at all yet (that absence is MG-59's subject). When MG-59
// gives the API a real Cosmos reader, it inherits the question of whether a
// strict validator must tolerate marked fixture documents; this comment is the
// flag. Marker fields are namespaced enough (`syntheticFixture`, `fixtureRunId`,
// `fixtureSequence`) that they cannot collide with a future telemetry field.
//
// A FINDING THIS TICKET RECORDS AND DOES NOT FIX: IoT Hub writes a JSON document
// to a Cosmos endpoint only when the D2C message declares both a JSON content
// type and utf-8 encoding as SYSTEM properties. Absent them the routed payload
// is treated as opaque and the body is not queryable as JSON, which would make
// the marker unfindable and this whole proof impossible. This module sets both
// explicitly (see D2C_SYSTEM_PROPERTIES). The repo's REAL producer,
// apps/data-pusher, sets NEITHER — buildPublishProperties (apps/data-pusher/
// cmd/main.go) emits only messageId, correlation.id and traceparent, and
// buildPublishTopic URL-encodes exactly those onto the MQTT topic. So this
// ticket's proof covers the FIXTURE's message shape and not the data-pusher's.
// That gap is a latent defect recorded in the MG-67 runbook, deliberately not
// fixed here: fixing a live producer is not in this ticket's scope, and doing it
// under cover of a verification ticket is how unreviewed producer changes ship.

import { randomUUID } from 'node:crypto';

export const TOOL_NAME = 'iot-fixture';
export const TOOL_VERSION = '1.0.0';
export const TICKET = 'MG-67';

// The operator scripts around these and MG-53/MG-54 read them, so they are part
// of the contract. Every failure class gets its own code: collapsing any two of
// them is the defect this vocabulary exists to prevent.
//
// Kept below 126 on purpose — 126, 127 and 128+n are the shell's own, and a tool
// whose exit code can be confused with "command not found" cannot be scripted
// against. AUTH=4 and TRANSPORT=5 match cosmos-export's numbering so an operator
// running both tools in one session reads them the same way.
export const EXIT = {
  // Confirmed: the expected marked, run-correlated documents were read back.
  OK: 0,
  // Bad or missing arguments. Never used for anything the live system did.
  USAGE: 1,
  // `az iot device send-d2c-message` itself failed. Nothing was sent.
  SEND_FAILURE: 2,
  // The bounded confirmation wait elapsed with the documents not found.
  TIMEOUT: 3,
  // 401/403, or a credential that could not be acquired at all. Exits
  // immediately and is NEVER retried, never reported as timeout or absence.
  AUTH: 4,
  // A transport failure with retries exhausted. Aborts rather than continuing.
  TRANSPORT: 5,
  // A document was read back WITHOUT the synthetic marker. A defect in the
  // sender, not an acceptable variant.
  MARKER_VIOLATION: 6,
  // The read-back could not be tied to this run deterministically: fewer
  // documents than sent, a duplicate run id, an unparseable document. A failure,
  // never an absence and never a success.
  AMBIGUOUS: 7,
  // The live container definition could not be measured (malformed, no
  // default_ttl, no partition key path). A fail-closed refusal — never a
  // hardcoded default. Consumed by container-definition.mjs.
  CONTAINER_DEFINITION: 8,
  // The documents ARRIVED but not under the expected partition. A distinct
  // outcome from absence: nothing between the device and Cosmos injects a
  // partition key, so reporting this as "not delivered" would call a working
  // route broken. Consumed by the confirmation read-back.
  UNEXPECTED_PARTITION: 9,
  // A send happened — documents are, or may be, in the destination container —
  // and the evidence recording them could NOT be written.
  //
  // Its own code because it is the one outcome where the live system CHANGED and
  // no record of the change survives, and because the operator's first action is
  // unlike every other code's: copy the ids off stderr into the ticket, before
  // diagnosing anything. It must never be reported as USAGE, which means "bad
  // arguments, nothing live happened" — telling an operator nothing happened
  // while documents sit in the container is the worst answer this tool can give.
  //
  // It DOMINATES the confirmation outcome, including AUTH. An unrecorded
  // document halts MG-53 whatever the confirmation concluded, and MG-53 cannot
  // tell one apart from the unknown-writer finding its halt exists to catch. The
  // confirmation's own outcome and label are still printed on the lines above,
  // so nothing is lost — only the code the operator scripts against changes.
  EVIDENCE_UNRECORDED: 10,
};

const EXIT_LABELS = {
  [EXIT.OK]: 'confirmed-in-cosmos',
  [EXIT.USAGE]: 'usage error',
  [EXIT.SEND_FAILURE]: 'send failure',
  [EXIT.TIMEOUT]: 'confirmation timeout',
  [EXIT.AUTH]: 'auth failure',
  [EXIT.TRANSPORT]: 'transport abort',
  [EXIT.MARKER_VIOLATION]: 'synthetic marker violation',
  [EXIT.AMBIGUOUS]: 'correlation ambiguity',
  [EXIT.CONTAINER_DEFINITION]: 'container definition refusal',
  [EXIT.UNEXPECTED_PARTITION]: 'delivered, unexpected partition',
  [EXIT.EVIDENCE_UNRECORDED]: 'evidence unrecorded (documents may be live)',
};

export function exitLabel(code) {
  return EXIT_LABELS[code] ?? 'unknown';
}

export class FixtureError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'FixtureError';
    this.exitCode = exitCode;
  }
}

export const defaultLog = {
  info: line => process.stdout.write(`${line}\n`),
  error: line => process.stderr.write(`${line}\n`),
};

// ---------------------------------------------------------------------------
// Secret scrubbing.
//
// HR1 of this ticket is a stop condition: no credential reaches stdout, stderr
// or any log on ANY path, including every failure path. Two sources of untrusted
// text land here — SDK error messages from the Cosmos read-back, and the stderr
// of the `az` child process, which is text this repo does not author. Both go
// through the same scrub before an operator-facing line exists.
// ---------------------------------------------------------------------------

// Anything bracket-shaped could be a document the service (or az) echoed back.
// Replaced wholesale rather than trusted: an over-redacted diagnostic is a cost
// worth paying, an echoed document body is not.
const BRACKETED = /[{[][\s\S]*[}\]]/g;

// Bracket-shape is only half the problem. An error can carry a credential inline
// and unbracketed — an AccountKey lifted out of a connection string, a bearer
// token, a SAS signature — so secrets are matched by SHAPE and the value is
// replaced whole: never a prefix, never a length, never a hash, because each of
// those is still a fact about the secret.
//
// There is deliberately NO exemption list (see the MG-63 note in the header).
// A credential-shaped key name always redacts.
const CREDENTIAL_KEY =
  /(?<![\w-])(["']?)([\w-]*(?:key|token|secret|password|credential|sig)[\w-]*)(["']?)(\s*[=:]\s*)/gi;

const SECRET_PATTERNS = [
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]'],
  // A JWT: three base64url segments, each long enough that dotted host names
  // and namespaced identifiers do not match.
  [/\b[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g, '[redacted]'],
  // Connection-string / SAS fields, value running to whatever delimits it.
  [/\b(AccountEndpoint|HostName|SharedAccessKeyName|sv)\s*=\s*[^;&\s]*/gi, '$1=[redacted]'],
];

// A credential-shaped key name's value is not parsed — it is consumed to the end
// of the line and replaced whole. Deciding where a quoted value ENDS is what
// leaked twice in the sibling tool: mismatched, escaped, unterminated and nested
// quotes are unbounded, and error text is precisely where malformed input turns
// up. A line break is the one boundary a value cannot straddle, so quote
// characters are ordinary content here and an ambiguous parse always redacts
// more.
function redactCredentialValues(text) {
  CREDENTIAL_KEY.lastIndex = 0;
  let out = '';
  let cursor = 0;
  let match;
  while ((match = CREDENTIAL_KEY.exec(text)) !== null) {
    const lineEnd = text.indexOf('\n', CREDENTIAL_KEY.lastIndex);
    const end = lineEnd === -1 ? text.length : lineEnd;
    out += text.slice(cursor, match.index) + match[0] + '[redacted]';
    cursor = end;
    CREDENTIAL_KEY.lastIndex = end;
  }
  return out + text.slice(cursor);
}

// Exported because the `az` child's stderr and this tool's own error text are
// different callers with the same obligation.
export function scrubSecrets(text) {
  if (typeof text !== 'string') return '';
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return redactCredentialValues(out);
}

export function describeError(err) {
  // A FixtureError message is ours by construction and secret-free: it is built
  // from argument names, the device, the hub and an outcome. Text that came from
  // somewhere else is scrubbed BEFORE it is embedded in one (see
  // toFixtureError, and scrubChildOutput for the az child), so passing it
  // through here cannot launder anything past the scrub.
  if (err instanceof FixtureError) return err.message;
  const parts = [];
  const name = err?.name;
  if (name) parts.push(String(name));
  const code = err?.statusCode ?? err?.code;
  if (code !== undefined && code !== null) parts.push(`status=${code}`);
  const raw = typeof err?.message === 'string' ? err.message : '';
  // Both scrubs run on the whole message BEFORE the 200-char cap: truncating
  // first can cut a secret in half and leave the first half in the log.
  const scrubbed = scrubSecrets(raw.replace(BRACKETED, '[redacted]'))
    .split('\n')[0]
    .trim()
    .slice(0, 200);
  if (scrubbed) parts.push(scrubbed);
  return parts.join(' ') || 'unknown error';
}

export const CHILD_OUTPUT_MAX_LINES = 5;
export const CHILD_OUTPUT_MAX_LINE_LENGTH = 200;

// The `az` CLI's stderr, rendered fit for an operator's terminal.
//
// This is the one text in the tool that another program wrote, and az is
// chatty: it prints tracebacks, and under verbosity it prints request
// signatures. The tool never asks for verbosity (see send-fixture.mjs), but the
// scrub does not depend on that promise holding.
//
// Bracket redaction runs over the WHOLE text before the split, not per line: a
// JSON object az printed across several lines has its braces on different lines,
// and a per-line scrub would leave every inner value intact.
export function scrubChildOutput(
  text,
  { maxLines = CHILD_OUTPUT_MAX_LINES, maxLineLength = CHILD_OUTPUT_MAX_LINE_LENGTH } = {}
) {
  if (typeof text !== 'string' || text.trim() === '') return '';
  const scrubbed = scrubSecrets(text.replace(BRACKETED, '[redacted]'));
  const lines = scrubbed
    .split('\n')
    .map(line => line.trim())
    .filter(Boolean);
  // Length capping happens AFTER the scrub, so a cap can never expose half of
  // something the scrub would have replaced.
  const kept = lines.slice(0, maxLines).map(line => line.slice(0, maxLineLength));
  if (lines.length > maxLines) {
    kept.push(`... ${lines.length - maxLines} further line(s) suppressed`);
  }
  return kept.join('\n');
}

// ---------------------------------------------------------------------------
// Error classification.
// ---------------------------------------------------------------------------

// The @azure/identity credential-acquisition failures. AggregateAuthentication-
// Error is the common one for DefaultAzureCredential with nothing logged in —
// which is precisely how this tool fails on an operator's machine before
// `az login`, so it must read as AUTH and not as "the route did not deliver".
const IDENTITY_AUTH_ERRORS = new Set([
  'CredentialUnavailableError',
  'AuthenticationError',
  'AuthenticationRequiredError',
  'AggregateAuthenticationError',
]);

// Classifies an error raised while READING Cosmos back. Returns AUTH or
// TRANSPORT and nothing else: absence, timeout, marker violation and ambiguity
// are conclusions the confirmation loop draws from what it read, never from an
// exception, and this function must not be able to manufacture one of them.
//
// There is deliberately no throttling class. This tool reads a handful of
// documents, so a 429 is a retryable transport condition; one that exhausts its
// retries aborts as TRANSPORT. It never degrades into an absence.
export function classifyError(err) {
  const status = Number(err?.statusCode ?? err?.code);
  if (status === 401 || status === 403) return EXIT.AUTH;
  // A credential that cannot be acquired at all carries no HTTP status, so it is
  // recognised by name — and by EXACT name. @azure/identity's set is finite and
  // documented, while a substring match on 'Credential' or 'Authentication' also
  // swallows names like CredentialTransportError, sending an operator off to
  // re-issue an RBAC grant for what was really a connection reset.
  if (IDENTITY_AUTH_ERRORS.has(String(err?.name ?? ''))) return EXIT.AUTH;
  const code = err?.code;
  if (code === 'Unauthorized' || code === 'Forbidden') return EXIT.AUTH;
  return EXIT.TRANSPORT;
}

// Wraps any thrown value as a FixtureError carrying an exit code, with the
// message scrubbed. Every catch block in this tool goes through here rather than
// formatting an error itself: one scrub site, so a new call site cannot forget.
export function toFixtureError(err, context) {
  if (err instanceof FixtureError) return err;
  const code = classifyError(err);
  const detail = describeError(err);
  const suffix =
    code === EXIT.AUTH
      ? ' — auth failure, NOT an absence: this says nothing about whether the route delivered'
      : ' — retries exhausted, aborting rather than reporting an absence';
  return new FixtureError(code, `${context}: ${detail}${suffix}`);
}

// ---------------------------------------------------------------------------
// The synthetic document contract (HR3).
//
// Everything below decides what a fixture document IS, and it is load-bearing
// for two later tickets rather than housekeeping. MG-53 will refuse to proceed
// if the source containers hold any document this fixture did not produce, and
// MG-54's destructive authorization cites these documents by id and count. Both
// need a match rule with ZERO ambiguity, which is why correlation here is a
// field a human can read and a script can match exactly — not a timestamp
// window, not a count delta, not "the newest N documents".
//
// The correlation key is MARKER + RUN ID, and deliberately not the document id.
// Nothing in this repo records what id a routed document ends up with: the IoT
// Hub Cosmos endpoint assigns one when the body does not supply one, and whether
// it honours a supplied `id` is platform behaviour no file here pins down. A
// sender-chosen `id` is included anyway because it costs nothing and makes the
// requested-vs-observed comparison in the evidence record meaningful — but the
// read-back matches on marker + run id, so a platform that renames every
// document still leaves the proof intact.
// ---------------------------------------------------------------------------

// The durable dev fixture device. It outlives this ticket — MG-62 reuses it for
// the post-cutover proof — so it is named for what it is rather than for the
// ticket that first needed it, and it reads unmistakably as a test fixture
// rather than as somebody's grill.
export const FIXTURE_DEVICE_ID = 'meatgeek-v2-dev-synthetic-fixture-device';

// The marker. Field name and value are both greppable, and the value names the
// ticket so a document found in six months explains its own provenance. Derived
// from TICKET rather than spelled twice: the two cannot drift apart.
export const SYNTHETIC_MARKER_FIELD = 'syntheticFixture';
export const SYNTHETIC_MARKER = `${TICKET}-SYNTHETIC-FIXTURE`;

// The per-run correlator and the within-run ordinal.
export const RUN_ID_FIELD = 'fixtureRunId';
export const SEQUENCE_FIELD = 'fixtureSequence';

// Fixed, small, and a constant rather than a flag ON PURPOSE. The evidence
// record states a count that MG-53 checks the source against; if an operator
// could pass --count, the recorded number and the code would drift and a
// mismatch downstream would be unattributable. Three is enough to make a
// partial read-back (2 of 3) an observable outcome rather than a theoretical
// one, and small enough that the fixture leaves almost nothing behind.
export const MESSAGES_PER_RUN = 3;

// Contract fields a partition key may not land on: overwriting any of them
// would silently break correlation, which is exactly the failure this tool
// exists to make impossible.
export const RESERVED_BODY_FIELDS = Object.freeze(
  new Set(['id', 'timestamp', 'ticket', SYNTHETIC_MARKER_FIELD, RUN_ID_FIELD, SEQUENCE_FIELD])
);

// THE ONE DEFINITION OF A LEGAL PARTITION KEY FIELD, shared with
// container-definition.mjs so the measurement and the sender cannot disagree
// about what they will accept.
//
// They did disagree once, and the symptom was an exit code that misreported
// which refusal had occurred: container-definition accepted a hyphenated or
// digit-leading field, the sender then refused it as EXIT.USAGE ("bad
// arguments"), and an operator reading that code was told their command line was
// wrong when the truth was that the measured container has a shape this fixture
// cannot address. One predicate, two callers, and the refusal now carries the
// code of whichever caller detected it — EXIT.CONTAINER_DEFINITION for a
// MEASURED value, since container-definition.mjs checks first and is the only
// path a live container's shape can enter by.
//
// Identifier-shaped is the requirement rather than "any JSON key": the field
// name is spelled unquoted in the ad-hoc verification queries the runbook hands
// the operator (SELECT c.<field> ...), and a name needing bracket-quoting there
// is a name this tool would be guessing the escaping for.
export const PARTITION_KEY_FIELD_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;

/**
 * Why this value cannot be the fixture's partition key field, or null if it can.
 * The returned reason is a fragment a caller embeds in its own refusal, so it
 * names the problem without claiming an exit code — the caller owns that.
 *
 * Returns a reason rather than throwing because the two callers refuse with
 * different codes, and a shared thrower would have to pick one of them.
 */
export function partitionKeyFieldProblem(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    return 'it is not a non-empty string';
  }
  if (!PARTITION_KEY_FIELD_PATTERN.test(value)) {
    return (
      'it is not a single plain field name (letters, digits and underscore, not starting with a digit) — ' +
      'this fixture writes the partition value as one flat body field and spells that field unquoted in a query'
    );
  }
  if (RESERVED_BODY_FIELDS.has(value)) {
    return 'it collides with a fixture contract field, so the marker or the run id could not survive it and the correlation would be silently destroyed';
  }
  return null;
}

// IoT Hub system properties, in az's `$.`-prefixed spelling. `$.ct` and `$.ce`
// are the two that decide whether the routed payload becomes a queryable JSON
// document or an opaque blob (see the finding in the module header). `$.mid`
// carries the per-message id hub-side, which is a diagnostic handle only — the
// route does not propagate it into the document, so it is never the correlator.
export const D2C_CONTENT_TYPE = 'application/json';
export const D2C_CONTENT_ENCODING = 'utf-8';
export const D2C_SYSTEM_PROPERTIES = {
  CONTENT_TYPE: '$.ct',
  CONTENT_ENCODING: '$.ce',
  MESSAGE_ID: '$.mid',
};

function requireNonEmptyString(value, name) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new FixtureError(EXIT.USAGE, `${name} must be a non-empty string`);
  }
  return value;
}

// The BODY FIELD the partition key names — `deviceId` for a container whose
// partition key path is `/deviceId`, the spelling apps/data-pusher/internal/
// wire/types.go already marshals. Parsing the path is container-definition's
// job; this refuses anything that is not already a single plain field name, so
// a `/a/b` path or a raw path with its leading slash fails loudly here instead
// of producing a body with a property nothing can query.
function requirePartitionKeyField(value) {
  const problem = partitionKeyFieldProblem(value);
  if (problem === null) return value;
  // EXIT.USAGE is correct HERE and only here: by the time a MEASURED value
  // reaches this function, container-definition.mjs has already applied the same
  // predicate and refused with EXIT.CONTAINER_DEFINITION, so anything that gets
  // this far is a caller passing a field no container measured — a
  // caller-contract bug, detected before anything live happened.
  //
  // Scrubbed before it is echoed: this is the one value here that can have come
  // from OUTSIDE, and by this line it is already known not to be a plain field
  // name — arbitrary text on a failure path, which is exactly what HR1 says must
  // not go out unscrubbed.
  throw new FixtureError(
    EXIT.USAGE,
    `partitionKeyField "${scrubSecrets(String(value)).slice(0, 80)}" cannot be used: ${problem}`
  );
}

// A fresh correlator per invocation, from crypto.randomUUID. Nothing here reads
// a counter, a file, an environment variable or anything a previous run wrote —
// HR2's repeatability is a property of the generator, not of operator
// discipline. The uuid source is injectable so a test can pin the value; the
// default is the only thing the CLI ever passes.
export function newRunId(uuid = randomUUID) {
  return `${TICKET.toLowerCase()}-run-${uuid()}`;
}

// Builds the run's messages. Every body carries the marker, the run id, the
// fixture device under the container's own partition key spelling, and a
// timestamp; every message declares JSON content type and utf-8 encoding.
//
// `now` is injected so the artifact under test is byte-reproducible. There is
// deliberately no `count` parameter — see MESSAGES_PER_RUN.
export function buildFixtureMessages({
  runId,
  partitionKeyField,
  deviceId = FIXTURE_DEVICE_ID,
  now = Date.now,
} = {}) {
  requireNonEmptyString(runId, 'runId');
  requireNonEmptyString(deviceId, 'deviceId');
  requirePartitionKeyField(partitionKeyField);

  return Array.from({ length: MESSAGES_PER_RUN }, (_, index) => {
    const sequence = index + 1;
    // Both identifiers derive from the run id, so two runs cannot collide even
    // if they start in the same millisecond.
    const messageId = `${runId}-${sequence}`;
    return {
      messageId,
      sequence,
      body: {
        id: messageId,
        [partitionKeyField]: deviceId,
        timestamp: new Date(now()).toISOString(),
        [SYNTHETIC_MARKER_FIELD]: SYNTHETIC_MARKER,
        [RUN_ID_FIELD]: runId,
        [SEQUENCE_FIELD]: sequence,
        ticket: TICKET,
      },
      systemProperties: {
        [D2C_SYSTEM_PROPERTIES.CONTENT_TYPE]: D2C_CONTENT_TYPE,
        [D2C_SYSTEM_PROPERTIES.CONTENT_ENCODING]: D2C_CONTENT_ENCODING,
        [D2C_SYSTEM_PROPERTIES.MESSAGE_ID]: messageId,
      },
    };
  });
}

// az's `--properties` takes `key=value` pairs joined by `;`. Values are refused
// rather than escaped if they carry a delimiter: a silently mangled `$.ct`
// means the hub writes an opaque payload instead of a JSON document, and the
// run would then fail as an absence for a reason that had nothing to do with
// the route.
export function formatD2cProperties(systemProperties) {
  const entries = Object.entries(systemProperties ?? {});
  if (entries.length === 0) {
    throw new FixtureError(EXIT.USAGE, 'refusing to send a message with no system properties');
  }
  return entries
    .map(([key, value]) => {
      const pair = `${key}=${value}`;
      if (/[;\s]/.test(pair)) {
        throw new FixtureError(EXIT.USAGE, `system property "${key}" carries a delimiter`);
      }
      return pair;
    })
    .join(';');
}

const isPlainObject = value => typeof value === 'object' && value !== null && !Array.isArray(value);

// Does this document carry the marker AT ALL? Separate from the run-correlated
// check because the two failures are different: a document without the marker
// in a read-back is a MARKER VIOLATION (a defect in this sender, per HR3), while
// a marked document from an earlier run is simply not this run's.
export function hasSyntheticMarker(doc) {
  return isPlainObject(doc) && doc[SYNTHETIC_MARKER_FIELD] === SYNTHETIC_MARKER;
}

// The zero-ambiguity validator the read-back gates on. Strict identity on both
// fields: a truthy value is not the marker, a prefix is not the marker, and a
// different run's id is not this run's. Anything that is not a plain object —
// null, an array, a JSON string the caller forgot to parse — is not a synthetic
// document, and extra properties the platform added (_ts, _rid, _etag) are
// ignored.
//
// A missing runId THROWS rather than returning false: it is a caller-contract
// error, and returning false would make it look like an absence and eventually
// like a timeout, which is precisely the class of quiet misattribution this
// tool exists to refuse.
export function isSyntheticDocument(doc, runId) {
  requireNonEmptyString(runId, 'runId');
  if (!hasSyntheticMarker(doc)) return false;
  return doc[RUN_ID_FIELD] === runId;
}

// ---------------------------------------------------------------------------
// The fail-closed confirmation read-back (HR2).
//
// This is the part of the tool that decides whether a run SUCCEEDED, so it is
// written to be structurally incapable of the one failure this ticket exists to
// refuse: exiting 0 without a specific, newly identified, marker-carrying
// document having been READ BACK OUT of the destination container. A green hub
// metric, a green route metric and a green /api/health/cosmos observe no
// document and are not offered here as proof of anything (MG-24 and MG-58 are
// the precedents for shipping behind a green signal that proved nothing).
//
// FOUR DESIGN DECISIONS WORTH THE WORDS.
//
// 1. THE READER IS INJECTED and this module constructs no client. Client
//    construction needs @azure/cosmos and @azure/identity, which the
//    credentialless validate-infrastructure CI job does not install; keeping the
//    seam here means every outcome below — including the ones no live hub can be
//    made to produce on demand — is reachable in a test with no network, no
//    package and no credential. The adapter lives at the CLI edge (step 6).
//
// 2. THE PREDICATE MATCHES ON THE RUN ID ALONE, not on marker AND run id, even
//    though the correlation key is both. If the query filtered on the marker,
//    the marker check would be tautological: the service would filter out
//    exactly the documents the check exists to catch, and MARKER VIOLATION would
//    be an outcome only the fake could ever produce. So the read-back asks for
//    this run's documents and then VALIDATES the marker itself, in code. A
//    document carrying this run's id without the marker is a defect in the
//    sender (HR3) and fails the run.
//
// 3. NOTHING BETWEEN THE DEVICE AND COSMOS INJECTS A PARTITION KEY. The IoT Hub
//    cosmos-storage endpoint declares none, so the document body is the only
//    source of the partition value, and a body whose partition field the
//    container does not recognise would land somewhere other than where this
//    tool looks first. "Delivered under an unexpected partition" and "not
//    delivered" are therefore genuinely different findings about the route, and
//    conflating them would report a WORKING route as broken. Hence the single
//    cross-partition sweep before any absence is reported, and its own exit code.
//
// 4. EVERY PATH RETURNS A RESULT RATHER THAN THROWING. The wait bound actually
//    used, the polls issued, the ids observed and the elapsed time are the
//    evidence this ticket exists to produce, and they are needed MOST on the
//    failure paths — a thrown error would drop them. The result carries the exit
//    code the CLI exits with; `confirmed` is true on exactly one path. Argument
//    errors still throw, because they are a caller-contract bug detected before
//    a wait exists, and there is no bound to report yet.
// ---------------------------------------------------------------------------

// Generous on purpose. Routing is asynchronous and nothing in this repo records
// how long the dev route actually takes, because no message has ever traversed
// it — so the FIRST live run's observed arrival delay is the calibration every
// later ticket inherits (it is recorded in the evidence artifact). The bound is
// a parameter, is reported on every path, and is never infinite: an elapsed
// bound exits nonzero.
export const DEFAULT_CONFIRMATION_TIMEOUT_MS = 180_000;
export const DEFAULT_POLL_INTERVAL_MS = 5_000;
// Retries across the whole wait, for TRANSPORT failures only. An auth failure is
// never retried at all.
export const DEFAULT_TRANSPORT_RETRIES = 3;

// Built from a MODULE CONSTANT, never from measured or operator-supplied text:
// the only value that varies is the run id, and it travels as a bound parameter
// rather than as interpolated SQL. `SELECT *` is deliberate — the marker, the id
// and the partition value all have to be inspected, and a projection that
// dropped one would hide the failure it was meant to surface.
export const CONFIRMATION_QUERY = `SELECT * FROM c WHERE c.${RUN_ID_FIELD} = @runId`;
export const RUN_ID_PARAMETER = '@runId';

const defaultSleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function requirePositiveInteger(value, name) {
  if (!Number.isInteger(value) || value <= 0) {
    throw new FixtureError(
      EXIT.USAGE,
      `${name} must be a positive integer (got ${safeFragment(value)}) — an unbounded or unreportable wait is not a wait`
    );
  }
  return value;
}

function requireReader(reader) {
  if (!reader || typeof reader.queryDocuments !== 'function') {
    throw new FixtureError(
      EXIT.USAGE,
      'a reader exposing queryDocuments() must be injected; this module constructs no Cosmos client'
    );
  }
  return reader;
}

// Any fragment that came from OUTSIDE this module — a document id, a partition
// value the platform stored, a rejected argument — before it is embedded in an
// operator-facing line. HR1 applies on every path, including the ones carrying
// data this tool believes is its own.
function safeFragment(value, max = 80) {
  return scrubSecrets(typeof value === 'string' ? value : String(value)).slice(0, max);
}

const typeName = value =>
  value === null ? 'null' : Array.isArray(value) ? 'an array' : typeof value;

/**
 * Judge one read-back page. Pure, and separated from the polling so the
 * ambiguity rules can be read (and tested) without a clock.
 *
 * Returns one of:
 *   { kind: 'empty' }                       nothing yet — keep polling
 *   { kind: 'partial', ids }                some arrived — keep polling, not yet a verdict
 *   { kind: 'complete', ids }               the expected count, all marked and run-correlated
 *   { kind: ..., exitCode, reason, ids }    a TERMINAL failure
 *
 * Only 'complete' can become an exit 0. 'partial' is not a success and not an
 * error yet: routing is asynchronous and documents trickle in, so an incomplete
 * page mid-wait means keep waiting — but an incomplete page when the bound
 * elapses is AMBIGUOUS, never an absence and never a success.
 */
export function evaluateReadBack(documents, { runId, expectedCount = MESSAGES_PER_RUN } = {}) {
  requireNonEmptyString(runId, 'runId');
  requirePositiveInteger(expectedCount, 'expectedCount');

  // A reader that answered with something other than a list is UNREADABLE. It is
  // emphatically not "no documents": treating it as an absence is how an error
  // becomes a false negative, which is the MG-66 conflation this tool must not
  // reproduce.
  if (!Array.isArray(documents)) {
    return {
      kind: 'unreadable',
      exitCode: EXIT.AMBIGUOUS,
      ids: [],
      reason: `the read-back returned ${typeName(documents)} rather than a list of documents — unreadable, which is a failure and not an absence`,
    };
  }
  if (documents.length === 0) return { kind: 'empty', ids: [] };

  for (const doc of documents) {
    if (!isPlainObject(doc)) {
      return {
        kind: 'unreadable',
        exitCode: EXIT.AMBIGUOUS,
        ids: [],
        reason: `the read-back returned ${typeName(doc)} where a document was expected — unparseable, so no correlation can be established`,
      };
    }
    // HR3: a document reaching Cosmos without the marker is a defect in the
    // sender, not an acceptable variant. Its own exit code, because "the sender
    // built a body wrong" and "the route did not deliver" call for opposite
    // responses from an operator.
    if (!hasSyntheticMarker(doc)) {
      return {
        kind: 'unmarked',
        exitCode: EXIT.MARKER_VIOLATION,
        ids: [],
        reason: `a document correlated to this run carries no ${SYNTHETIC_MARKER_FIELD}=${SYNTHETIC_MARKER} marker — that is a defect in the sender, and an unmarked document must never be counted as proof`,
      };
    }
    // The predicate asked for this run only, so a foreign run id here means the
    // read-back cannot be trusted to mean what it says. Ambiguity, not success.
    if (doc[RUN_ID_FIELD] !== runId) {
      return {
        kind: 'foreign',
        exitCode: EXIT.AMBIGUOUS,
        ids: [],
        reason: `the read-back returned a document whose ${RUN_ID_FIELD} is not this run's — the correlation cannot be established deterministically`,
      };
    }
    // Evidence is recorded BY ID (MG-54 cites them in a destructive
    // authorization). A document that cannot be named cannot be recorded, so it
    // cannot be counted.
    if (typeof doc.id !== 'string' || doc.id.trim() === '') {
      return {
        kind: 'unidentified',
        exitCode: EXIT.AMBIGUOUS,
        ids: [],
        reason:
          'the read-back returned a document with no usable id — it could not be recorded as evidence, so it is not counted as arrival',
      };
    }
  }

  // The ids the read-back ACTUALLY observed. Whether the platform honoured the
  // sender's chosen id is behaviour no file in this repo pins down, so what the
  // sender hoped for is never substituted here.
  const ids = documents.map(doc => doc.id);
  if (new Set(ids).size !== ids.length) {
    return {
      kind: 'duplicate-id',
      exitCode: EXIT.AMBIGUOUS,
      ids,
      reason: `the read-back returned ${ids.length} documents sharing ${new Set(ids).size} id(s) — a duplicate cannot be told from a second arrival`,
    };
  }
  const sequences = documents.map(doc => doc[SEQUENCE_FIELD]);
  if (new Set(sequences).size !== sequences.length) {
    return {
      kind: 'duplicate-sequence',
      exitCode: EXIT.AMBIGUOUS,
      ids,
      reason: `two documents claim the same ${SEQUENCE_FIELD} within one run — a run-id collision or a redelivery, either way not a deterministic correlation`,
    };
  }
  if (documents.length > expectedCount) {
    return {
      kind: 'excess',
      exitCode: EXIT.AMBIGUOUS,
      ids,
      reason: `the read-back found ${documents.length} documents for a run that sent ${expectedCount} — more than was sent is as ambiguous as fewer, and MG-53 halts on an unrecorded document`,
    };
  }
  if (documents.length < expectedCount) return { kind: 'partial', ids };
  return { kind: 'complete', ids };
}

/**
 * Poll the destination container until this run's documents are read back, or
 * until a failure class is established. Never sleeps for longer than the bound,
 * never retries an auth failure, and never returns confirmed:true for anything
 * short of the expected count of marked, run-correlated documents.
 *
 * @param {object} options
 * @param {{queryDocuments: Function}} options.reader injected; see decision 1.
 * @param {string} options.runId this invocation's correlator.
 * @param {string} [options.partitionValue] the value the bodies carry under the
 *   container's partition key field — the fixture device by default.
 * @param {string|null} [options.partitionKeyField] reporting only: when given,
 *   the sweep records which partition the documents actually landed under.
 * @param {Function} [options.now] injected clock, so tests do not sleep.
 * @param {Function} [options.sleep] injected wait, likewise.
 * @returns {Promise<object>} a frozen result carrying, on EVERY path, the exit
 *   code, its label, the wait bound actually used, the polls issued, the ids
 *   observed and the elapsed time.
 */
export async function confirmArrival({
  reader,
  runId,
  partitionValue = FIXTURE_DEVICE_ID,
  partitionKeyField = null,
  expectedCount = MESSAGES_PER_RUN,
  timeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
  maxTransportRetries = DEFAULT_TRANSPORT_RETRIES,
  now = Date.now,
  sleep = defaultSleep,
} = {}) {
  requireReader(reader);
  requireNonEmptyString(runId, 'runId');
  requireNonEmptyString(partitionValue, 'partitionValue');
  if (partitionKeyField !== null) requirePartitionKeyField(partitionKeyField);
  requirePositiveInteger(expectedCount, 'expectedCount');
  requirePositiveInteger(timeoutMs, 'timeoutMs');
  requirePositiveInteger(pollIntervalMs, 'pollIntervalMs');
  if (!Number.isInteger(maxTransportRetries) || maxTransportRetries < 0) {
    throw new FixtureError(EXIT.USAGE, 'maxTransportRetries must be a non-negative integer');
  }

  const startedAt = now();
  const deadline = startedAt + timeoutMs;
  let polls = 0;
  let transportFailures = 0;
  let crossPartitionSweepRun = false;

  // Structured ids stay verbatim — they ARE the evidence, and a scrubbed id is
  // useless to MG-53 and MG-54. Only the human-readable `reason` embeds outside
  // text, and it goes through safeFragment.
  const partitionValuesOf = documents => {
    if (partitionKeyField === null || !Array.isArray(documents)) return [];
    const values = documents
      .filter(isPlainObject)
      .map(doc => doc[partitionKeyField])
      .filter(value => typeof value === 'string' && value !== '');
    return [...new Set(values)];
  };

  const result = fields =>
    Object.freeze({
      confirmed: false,
      runId,
      expectedCount,
      // The bound ACTUALLY used, on every path, success or failure. An operator
      // reading a timeout has to be able to see what it timed out against, and
      // the evidence artifact records it as the calibration for later tickets.
      waitBoundMs: timeoutMs,
      pollIntervalMs,
      partitionValue,
      partitionKeyField,
      observedIds: Object.freeze([]),
      observedCount: 0,
      observedPartitionValues: Object.freeze([]),
      observedArrivalMs: null,
      scope: null,
      ...fields,
      polls,
      crossPartitionSweepRun,
      elapsedMs: now() - startedAt,
      exitLabel: exitLabel(fields.exitCode),
    });

  const queryPage = async scoped =>
    reader.queryDocuments({
      query: CONFIRMATION_QUERY,
      parameters: [{ name: RUN_ID_PARAMETER, value: runId }],
      // Absent partitionKey IS the cross-partition sweep. The distinction
      // carries its own exit code, so it is expressed in the request rather
      // than filtered afterwards.
      ...(scoped ? { partitionKey: partitionValue } : {}),
    });

  const authResult = (err, scope) =>
    result({
      exitCode: EXIT.AUTH,
      scope,
      reason: `auth failure reading back run ${safeFragment(runId)} — this says NOTHING about whether the route delivered, and is never reported as a timeout or an absence: ${describeError(err)}`,
    });

  const transportResult = (err, scope, budget) =>
    result({
      exitCode: EXIT.TRANSPORT,
      scope,
      reason: `transport failure reading back run ${safeFragment(runId)} (${budget}) — aborting rather than reporting an absence: ${describeError(err)}`,
    });

  let lastPartial = null;
  let lastPartialDocuments = [];

  // ---- Phase 1: the bounded, partition-scoped wait. ----------------------
  for (;;) {
    polls += 1;
    let documents = null;
    let failed = false;
    try {
      documents = await queryPage(true);
    } catch (err) {
      failed = true;
      // An auth failure exits IMMEDIATELY: no retry, no further poll, and never
      // the timeout or absence code. A principal whose data-plane role
      // assignment has not propagated is the single most likely failure of the
      // live run, and telling that operator "the route did not deliver" would
      // send them to rebuild working infrastructure.
      if (classifyError(err) === EXIT.AUTH) return authResult(err, 'expected-partition');
      transportFailures += 1;
      if (transportFailures > maxTransportRetries) {
        return transportResult(
          err,
          'expected-partition',
          `${transportFailures} failure(s) against a budget of ${maxTransportRetries}: retries exhausted`
        );
      }
    }

    if (!failed) {
      const verdict = evaluateReadBack(documents, { runId, expectedCount });
      if (verdict.exitCode) {
        return result({
          exitCode: verdict.exitCode,
          scope: 'expected-partition',
          observedIds: Object.freeze([...verdict.ids]),
          observedCount: verdict.ids.length,
          observedPartitionValues: Object.freeze(partitionValuesOf(documents)),
          reason: verdict.reason,
        });
      }
      if (verdict.kind === 'complete') {
        return result({
          confirmed: true,
          exitCode: EXIT.OK,
          scope: 'expected-partition',
          observedIds: Object.freeze([...verdict.ids]),
          observedCount: verdict.ids.length,
          observedPartitionValues: Object.freeze(partitionValuesOf(documents)),
          observedArrivalMs: now() - startedAt,
          reason: `read back ${verdict.ids.length} of ${expectedCount} marked, run-correlated document(s) out of the destination container`,
        });
      }
      if (verdict.kind === 'partial') {
        lastPartial = verdict;
        lastPartialDocuments = documents;
      }
    }

    const remaining = deadline - now();
    if (remaining <= 0) break;
    await sleep(Math.min(pollIntervalMs, remaining));
  }

  // ---- Phase 2: the bound elapsed. --------------------------------------
  // An incomplete set is NOT an absence: the documents that did arrive prove the
  // route carried something, and the ones that did not are unaccounted for. Both
  // facts are reported, and neither is a success. No sweep here — these landed
  // under the expected partition, so where the rest went is a different question
  // than the one the sweep answers.
  if (lastPartial) {
    return result({
      exitCode: EXIT.AMBIGUOUS,
      scope: 'expected-partition',
      observedIds: Object.freeze([...lastPartial.ids]),
      observedCount: lastPartial.ids.length,
      observedPartitionValues: Object.freeze(partitionValuesOf(lastPartialDocuments)),
      reason: `the ${timeoutMs}ms wait bound elapsed having read back only ${lastPartial.ids.length} of ${expectedCount} documents — an incomplete read-back is a failure, never an absence and never a success`,
    });
  }

  // Nothing under the expected partition. Before ANY absence is reported, one
  // cross-partition sweep: see decision 3. It gets a single attempt — the bound
  // has already elapsed, so there is no budget left to retry within, and an
  // unreadable sweep is a failure rather than a licence to call it absent.
  crossPartitionSweepRun = true;
  let sweep;
  try {
    sweep = await queryPage(false);
  } catch (err) {
    if (classifyError(err) === EXIT.AUTH) return authResult(err, 'cross-partition');
    transportFailures += 1;
    return transportResult(
      err,
      'cross-partition',
      'the cross-partition sweep gets a single attempt, since the wait bound has already elapsed'
    );
  }

  const sweepVerdict = evaluateReadBack(sweep, { runId, expectedCount });
  if (sweepVerdict.kind === 'empty') {
    return result({
      exitCode: EXIT.TIMEOUT,
      scope: 'cross-partition',
      reason: `no document carrying run ${safeFragment(runId)} was read back within the ${timeoutMs}ms wait bound, under the expected partition or any other — a timeout is a failure, not an absence to be explained away`,
    });
  }
  if (sweepVerdict.exitCode) {
    return result({
      exitCode: sweepVerdict.exitCode,
      scope: 'cross-partition',
      observedIds: Object.freeze([...sweepVerdict.ids]),
      observedCount: sweepVerdict.ids.length,
      observedPartitionValues: Object.freeze(partitionValuesOf(sweep)),
      reason: sweepVerdict.reason,
    });
  }

  // Delivered — just not where this tool looked first. Reporting this as an
  // absence would call a working route broken, and would send an operator to
  // debug an endpoint that is doing its job.
  const landed = partitionValuesOf(sweep);
  return result({
    exitCode: EXIT.UNEXPECTED_PARTITION,
    scope: 'cross-partition',
    observedIds: Object.freeze([...sweepVerdict.ids]),
    observedCount: sweepVerdict.ids.length,
    observedPartitionValues: Object.freeze(landed),
    observedArrivalMs: null,
    reason: `${sweepVerdict.ids.length} of ${expectedCount} document(s) for run ${safeFragment(runId)} were found OUTSIDE the expected partition ${safeFragment(partitionValue)}${landed.length ? ` (under ${landed.map(value => safeFragment(value)).join(', ')})` : ''} — the route delivered, but the partition value the body carried is not the one this run queried, so the run is not confirmed`,
  });
}

/**
 * A confirmation-shaped result for a run that NEVER REACHED the read-back —
 * today, a send that aborted part-way through.
 *
 * It exists so that a partial send is still RECORDABLE. The evidence record is
 * built from a confirmation result, and a run that put one document into the
 * container before `az` failed on the next has changed the live system exactly
 * as much as a confirmed run did, from MG-53's point of view: MG-53 halts on any
 * source document its recorded set does not account for, and an unrecorded
 * document is indistinguishable there from the unknown-writer finding that halt
 * exists to catch. Discarding the ids because the run failed is therefore not a
 * missing nicety, it is the thing that stops the downstream migration.
 *
 * It is not a confirmation and cannot be mistaken for one: `confirmed` is false,
 * no id is observed, and `scope` is 'not-attempted' — the machine-readable
 * signal that nothing was ever read back, as distinct from read back and empty.
 * `polls: 0` and `elapsedMs: 0` say the same thing to a human. The wait bound is
 * carried because every result reports the bound it was configured with, on
 * every path.
 */
export function abortedConfirmation({
  runId,
  exitCode,
  reason,
  partitionValue = FIXTURE_DEVICE_ID,
  partitionKeyField = null,
  expectedCount = MESSAGES_PER_RUN,
  timeoutMs = DEFAULT_CONFIRMATION_TIMEOUT_MS,
  pollIntervalMs = DEFAULT_POLL_INTERVAL_MS,
} = {}) {
  requireNonEmptyString(runId, 'runId');
  requireNonEmptyString(reason, 'reason');
  if (!Number.isInteger(exitCode) || exitCode <= 0) {
    throw new FixtureError(
      EXIT.USAGE,
      'abortedConfirmation needs the nonzero exit code of the failure that aborted the run — it describes a run that did NOT succeed'
    );
  }
  if (partitionKeyField !== null) requirePartitionKeyField(partitionKeyField);
  requirePositiveInteger(expectedCount, 'expectedCount');
  requirePositiveInteger(timeoutMs, 'timeoutMs');
  requirePositiveInteger(pollIntervalMs, 'pollIntervalMs');

  return Object.freeze({
    confirmed: false,
    runId,
    expectedCount,
    waitBoundMs: timeoutMs,
    pollIntervalMs,
    partitionValue,
    partitionKeyField,
    observedIds: Object.freeze([]),
    observedCount: 0,
    observedPartitionValues: Object.freeze([]),
    observedArrivalMs: null,
    scope: 'not-attempted',
    exitCode,
    reason,
    polls: 0,
    crossPartitionSweepRun: false,
    elapsedMs: 0,
    exitLabel: exitLabel(exitCode),
  });
}

// One operator-facing line for any confirmation result. Built only from the
// result's own fields, and it names the wait bound on every path so a timeout
// cannot be read without seeing what it timed out against.
export function describeConfirmation(result) {
  const arrival = result.confirmed
    ? `arrived after ${result.observedArrivalMs}ms`
    : `${result.elapsedMs}ms elapsed`;
  const sweep = result.crossPartitionSweepRun ? ', cross-partition sweep run' : '';
  return (
    `${exitLabel(result.exitCode)}: ${result.observedCount}/${result.expectedCount} marked documents ` +
    `for run ${safeFragment(result.runId)} (${result.polls} poll(s), bound ${result.waitBoundMs}ms, ${arrival}${sweep})`
  );
}
