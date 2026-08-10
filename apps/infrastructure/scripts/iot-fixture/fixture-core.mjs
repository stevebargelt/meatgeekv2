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
const RESERVED_BODY_FIELDS = new Set([
  'id',
  'timestamp',
  'ticket',
  SYNTHETIC_MARKER_FIELD,
  RUN_ID_FIELD,
  SEQUENCE_FIELD,
]);

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
  requireNonEmptyString(value, 'partitionKeyField');
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(value)) {
    // Scrubbed before it is echoed: this is the one value here that came from
    // OUTSIDE (the measured container definition), and by this line it is
    // already known NOT to be a plain field name — so it is arbitrary text on a
    // failure path, which is exactly what HR1 says must not go out unscrubbed.
    throw new FixtureError(
      EXIT.USAGE,
      `partitionKeyField must be a single plain field name, not a path: got "${scrubSecrets(value)}"`
    );
  }
  if (RESERVED_BODY_FIELDS.has(value)) {
    throw new FixtureError(
      EXIT.USAGE,
      `the measured partition key field "${value}" collides with a fixture contract field; ` +
        'the marker and run id could not survive it, so this refuses rather than sending'
    );
  }
  return value;
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
