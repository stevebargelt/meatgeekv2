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
// THE EVIDENCE-EMISSION CONTRACT (see createRunLedger at the foot of this file).
// A run that has attempted even one message has CHANGED the live system, and the
// only artifact any downstream ticket parses is the evidence record. So the
// contract is stated once here and every path falls out of it rather than being
// patched into shape one failure at a time:
//
//   - Evidence is emitted on EVERY outcome — success, timeout, auth, transport,
//     marker violation, ambiguity, send failure. Only a run that refused BEFORE
//     attempting its first send may exit without a record.
//   - Four id sets, never conflated: requestedIds (minted AND attempted),
//     acceptedIds (az reported success), ambiguousIds (az reported failure, so
//     acceptance is UNKNOWN — the CLI can fail after IoT Hub accepted the
//     message, which makes a send failure ambiguous BY CONSTRUCTION), and
//     observedIds (read back out of Cosmos, INCLUDING anything seen in a partial
//     poll before a later abort).
//   - An id, once observed, is never discarded by a subsequent failure. An auth
//     failure on poll three does not un-see the two documents poll two read back:
//     they are in the container, MG-53 halts on a source document its recorded
//     set does not account for, and there it is indistinguishable from the
//     unknown-writer finding that halt exists to catch.
//   - NOTHING may assert that nothing was written once any message was
//     attempted. "az failed" is not "the message did not arrive"; reporting it as
//     one is the absence/error conflation this whole tool exists to refuse,
//     reproduced on the write side.
//   - `uncertain` is true whenever any id is ambiguous or the run aborted before
//     a confirmation completed, and it is a field of the record rather than a
//     tone of voice in a log line.
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
  // `az iot device send-d2c-message` itself failed.
  //
  // It does NOT mean the message did not arrive, and nothing anywhere may say
  // that it does. The CLI can fail AFTER IoT Hub accepted the message — a
  // non-zero exit on teardown, a killed process, a lost response — so a send
  // failure is ambiguous BY CONSTRUCTION: the ids it covers belong in the
  // ledger's ambiguousIds, never in an assertion that nothing was written. This
  // code says "the sender could not establish that the hub took the message",
  // which is why a run that reaches it still emits an evidence record.
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

// Every code this tool is permitted to exit with. A value that is not in here
// did not come from this vocabulary, so nothing may be concluded from it —
// least of all success.
const KNOWN_EXIT_CODES = new Set(Object.values(EXIT));

export function isKnownExitCode(code) {
  return KNOWN_EXIT_CODES.has(code);
}

// The code an UNANTICIPATED run state exits with.
//
// AMBIGUOUS rather than a code of its own, deliberately: "the run concluded
// nothing I can name" IS a correlation ambiguity — nothing was tied to this run
// deterministically — and the funnel already reaches for this same code when a
// run that attempted a send would otherwise report a usage error. Minting an
// eleventh code would also mean adding a slug to evidence.mjs's closed
// OUTCOME_NAMES map, which this step does not own; if a distinct code is wanted
// later, this constant is the single place it changes.
export const UNANTICIPATED_OUTCOME_CODE = EXIT.AMBIGUOUS;

/**
 * Resolve a run's exit code from what the run actually established. Pure, and
 * the ONLY place allowed to decide that a run exits 0.
 *
 * THIS EXISTS BECAUSE THE DEFAULT WAS INVERTED. The single exit funnel used to
 * read `confirmation ? confirmation.exitCode : (failure?.exitCode ?? EXIT.OK)`,
 * so a run holding neither a confirmation nor a failure — an unanticipated
 * state by construction, since one of the two is supposed to exist on every
 * path — fell through to SUCCESS. That is fail-OPEN in the one function whose
 * entire contract is that exit 0 means exactly one thing: the expected count of
 * marker-carrying, run-correlated documents was READ BACK OUT of the
 * destination container. A state the code did not anticipate is the state it
 * knows least about, and it is the last one that may be reported as proof.
 *
 * So the default is inverted back: exit 0 requires POSITIVE CONFIRMATION to
 * have been established, and everything else — including every shape this
 * function was not written to expect — is nonzero with an explicit reason the
 * caller prints. There is no `?? EXIT.OK` anywhere in it, and no path that can
 * reach EXIT.OK without a confirmation object that both carries EXIT.OK and
 * says `confirmed: true`.
 *
 * Returns { exitCode, unanticipated, reason }. `reason` is null exactly when
 * the outcome was one this vocabulary anticipated; otherwise it is a sentence
 * naming what was found, for the caller to log before it exits.
 */
export function resolveOutcomeCode({ confirmation, failure } = {}) {
  const unanticipated = finding => ({
    exitCode: UNANTICIPATED_OUTCOME_CODE,
    unanticipated: true,
    reason:
      `${finding} — exiting ${UNANTICIPATED_OUTCOME_CODE} (${exitLabel(UNANTICIPATED_OUTCOME_CODE)}) rather than 0. ` +
      'Exit 0 states that a specific, newly identified document was read back out of the destination container, and this run established no such thing.',
  });
  const anticipated = exitCode => ({ exitCode, unanticipated: false, reason: null });

  if (confirmation !== null && confirmation !== undefined) {
    if (typeof confirmation !== 'object' || Array.isArray(confirmation)) {
      return unanticipated(`the run produced a confirmation of type ${typeName(confirmation)}`);
    }
    const { exitCode, confirmed } = confirmation;
    if (!isKnownExitCode(exitCode)) {
      return unanticipated(
        `the confirmation carried exit code ${safeFragment(String(exitCode), 20)}, which is not in this tool's vocabulary`
      );
    }
    // The two halves of a confirmation must agree. They are set together on
    // every path in confirmArrival, so a disagreement means a caller built one
    // by hand or a path was added that half-populates it — either way the run
    // cannot be read, and the direction that matters is that the OK half alone
    // never carries the exit.
    if (exitCode === EXIT.OK && confirmed !== true) {
      return unanticipated(
        'the confirmation carried exit 0 without confirmed:true, so nothing established that the documents were read back'
      );
    }
    if (exitCode !== EXIT.OK && confirmed === true) {
      return unanticipated(
        `the confirmation claims confirmed:true alongside exit ${exitCode} (${exitLabel(exitCode)}), which is internally inconsistent`
      );
    }
    return anticipated(exitCode);
  }

  // No confirmation at all: the run never reached a verdict about the container,
  // so the only honest code is the failure's own — and only if it is one this
  // vocabulary minted and is not itself success.
  if (failure !== null && failure !== undefined) {
    const exitCode = failure.exitCode;
    if (!isKnownExitCode(exitCode)) {
      return unanticipated(
        `the run aborted with a failure carrying exit code ${safeFragment(String(exitCode), 20)}, which is not in this tool's vocabulary`
      );
    }
    if (exitCode === EXIT.OK) {
      return unanticipated('the run aborted with a failure carrying exit code 0');
    }
    return anticipated(exitCode);
  }

  return unanticipated(
    'the run produced neither a confirmation nor a failure, so nothing it did is known'
  );
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
//    BUT THE SWEEP ONLY CHANGES WHICH QUERY LOOKED, and that is not a fact about
//    where anything landed. The partition label is therefore decided by the
//    partition value the RETURNED DOCUMENTS carry — the container partitions on
//    that field, so the value in the document IS the partition it is in —
//    and never by which query happened to find it. The two come apart on an
//    ordinary healthy run: a document that arrives in the CORRECT partition
//    during the round trip between the last scoped poll and the sweep is found
//    only by the sweep, and labelling it a partition anomaly would report a
//    working route as broken in the very artifact MG-62's post-cutover proof
//    reads. So a document in the expected partition is a confirmation whichever
//    query found it, and an INCOMPLETE cross-partition set stays a correlation
//    ambiguity rather than being upgraded into a partition claim: where the
//    documents this run cannot account for went is not established by the ones
//    it can.
//
//    AND "A DIFFERENT PARTITION VALUE" IS NOT THE ONLY WAY TO MISS THE EXPECTED
//    ONE. Because the endpoint injects nothing, the architect's top-ranked risk
//    for this route is a document arriving with NO partition key field at all —
//    not one arriving under some other value. Those are different facts about
//    the route and they need different repairs, so they are counted separately,
//    said separately in the outcome text, and recorded separately in
//    observedPartitionValues via the reserved tokens below. Collapsing the first
//    into the second would state something factually false ("carries a deviceId
//    other than the expected one" about a document carrying no deviceId), and
//    recording it as an empty list would discard the single fact that tells the
//    two apart — in the exact case the evidence most needs to capture.
//
// 4. EVERY PATH RETURNS A RESULT RATHER THAN THROWING. The wait bound actually
//    used, the polls issued, the ids observed and the elapsed time are the
//    evidence this ticket exists to produce, and they are needed MOST on the
//    failure paths — a thrown error would drop them. The result carries the exit
//    code the CLI exits with; `confirmed` is true on exactly one path. Argument
//    errors still throw, because they are a caller-contract bug detected before
//    a wait exists, and there is no bound to report yet.
//
// 5. OBSERVATION IS MONOTONIC, and this is enforced in ONE place — the `result`
//    builder below unions every exit path against the ids observed so far, so a
//    path cannot forget to carry them. Per the evidence-emission contract in the
//    module header: a document read back on poll two is IN THE CONTAINER, and an
//    auth failure, a transport abort or a marker violation on poll three is new
//    information about the reader, not a retraction of what it already read. The
//    union is also why a set that SHRINKS between polls is reported as ambiguity
//    rather than as a confirmation: if five distinct ids have been observed for a
//    run that sent three, "the expected count is present right now" is not a
//    proof anyone should act on. The same rule applies WITHIN one page:
//    evaluateReadBack classifies every document before choosing a verdict, so a
//    single stray document cannot make the tool report that it observed nothing
//    while this run's documents sit in the container next to it.
// ---------------------------------------------------------------------------

// RESERVED TOKENS recorded in observedPartitionValues for a document of this
// run's that carries no usable partition value. They are recorded values, not an
// absence: a document with no partition key field is its OWN state, and the
// empty list this used to record threw away the one fact distinguishing "landed
// under a different key" from "landed under no key at all".
//
// They are never confusable with a real partition value in the outcome text,
// which is composed from the CENSUS COUNTS rather than from this list — so even
// a document contriving to carry one of these literals as its partition value
// cannot make the text say something untrue. The angle brackets keep them
// visibly non-value-shaped for a human reading the artifact, and neither is a
// legal device id this fixture ever mints.
export const PARTITION_VALUE_ABSENT = '<no-partition-key-field>';
export const PARTITION_VALUE_UNUSABLE = '<unusable-partition-key-value>';

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
 * `ids` and `anomalousIds` are returned on EVERY kind, terminal or not — see the
 * two-set rule below.
 *
 * Only 'complete' can become an exit 0. 'partial' is not a success and not an
 * error yet: routing is asynchronous and documents trickle in, so an incomplete
 * page mid-wait means keep waiting — but an incomplete page when the bound
 * elapses is AMBIGUOUS, never an absence and never a success.
 *
 * THE WHOLE PAGE IS CLASSIFIED BEFORE ANY VERDICT IS CHOSEN, and this is the
 * evidence-emission contract applied one level down. The earlier shape returned
 * at the first bad document with `ids: []`, which meant a page holding two of
 * this run's documents alongside one unmarked stray reported that NOTHING had
 * been observed — while two documents this run caused sat in the container. That
 * is the same defect as an auth failure discarding an earlier poll's ids, on a
 * newly reachable path: a later finding is new information, never a retraction
 * of what was already read.
 *
 * TWO SETS, AND THEY ARE NOT INTERCHANGEABLE — the direction of the error
 * matters, so the split is deliberate rather than tidy:
 *
 *   ids            documents POSITIVELY attributable to this run: a plain
 *                  object, carrying the synthetic marker, carrying this run's
 *                  id, and nameable. These are what the evidence record's
 *                  observedIds are built from, so admitting anything less than
 *                  positively-ours would tell MG-53 that a document it should
 *                  halt on is accounted for — blinding the unknown-writer check
 *                  that halt exists to perform.
 *   anomalousIds   documents the correlated query returned that are NOT
 *                  attributable to this run (unmarked, or carrying a foreign
 *                  run id). Named, because an operator cannot investigate a
 *                  document nobody named, and NEVER counted as arrival.
 */
export function evaluateReadBack(documents, { runId, expectedCount = MESSAGES_PER_RUN } = {}) {
  requireNonEmptyString(runId, 'runId');
  requirePositiveInteger(expectedCount, 'expectedCount');

  // A reader that answered with something other than a list is UNREADABLE. It is
  // emphatically not "no documents": treating it as an absence is how an error
  // becomes a false negative, which is the MG-66 conflation this tool must not
  // reproduce. Nothing was legible here, so both sets are genuinely empty.
  if (!Array.isArray(documents)) {
    return {
      kind: 'unreadable',
      exitCode: EXIT.AMBIGUOUS,
      ids: [],
      anomalousIds: [],
      reason: `the read-back returned ${typeName(documents)} rather than a list of documents — unreadable, which is a failure and not an absence`,
    };
  }
  if (documents.length === 0) return { kind: 'empty', ids: [], anomalousIds: [] };

  const mine = [];
  const anomalous = [];
  let illegible = null;
  let unmarked = null;
  let foreign = false;
  let unidentified = false;

  const usableId = doc => (typeof doc.id === 'string' && doc.id.trim() !== '' ? doc.id : null);

  for (const doc of documents) {
    if (!isPlainObject(doc)) {
      illegible ??= typeName(doc);
      continue;
    }
    const id = usableId(doc);
    // HR3: a document reaching Cosmos without the marker is a defect in the
    // sender, not an acceptable variant. Its own exit code, because "the sender
    // built a body wrong" and "the route did not deliver" call for opposite
    // responses from an operator.
    if (!hasSyntheticMarker(doc)) {
      unmarked ??= id ?? '(a document with no usable id)';
      if (id) anomalous.push(id);
      continue;
    }
    // The predicate asked for this run only, so a foreign run id here means the
    // read-back cannot be trusted to mean what it says. Ambiguity, not success —
    // and the document is emphatically not counted as one of ours.
    if (doc[RUN_ID_FIELD] !== runId) {
      foreign = true;
      if (id) anomalous.push(id);
      continue;
    }
    // Evidence is recorded BY ID (MG-54 cites them in a destructive
    // authorization). A document that cannot be named cannot be recorded, so it
    // cannot be counted — and it cannot be listed as an anomaly either, since
    // there is nothing to list.
    if (!id) {
      unidentified = true;
      continue;
    }
    mine.push(doc);
  }

  // The ids the read-back ACTUALLY observed. Whether the platform honoured the
  // sender's chosen id is behaviour no file in this repo pins down, so what the
  // sender hoped for is never substituted here.
  const ids = mine.map(doc => doc.id);
  const anomalousIds = [...new Set(anomalous)];
  const verdict = fields => ({ ids, anomalousIds, ...fields });

  // PRECEDENCE, most structural first. A page that cannot be parsed cannot be
  // judged for markers; a marker violation outranks a correlation ambiguity
  // because it sends the operator to the sender rather than to the route.
  if (illegible !== null) {
    return verdict({
      kind: 'unreadable',
      exitCode: EXIT.AMBIGUOUS,
      reason: `the read-back returned ${illegible} where a document was expected — unparseable, so no correlation can be established`,
    });
  }
  if (unmarked !== null) {
    return verdict({
      kind: 'unmarked',
      exitCode: EXIT.MARKER_VIOLATION,
      reason: `a document correlated to this run (${safeFragment(unmarked)}) carries no ${SYNTHETIC_MARKER_FIELD}=${SYNTHETIC_MARKER} marker — that is a defect in the sender, and an unmarked document must never be counted as proof`,
    });
  }
  if (foreign) {
    return verdict({
      kind: 'foreign',
      exitCode: EXIT.AMBIGUOUS,
      reason: `the read-back returned a document whose ${RUN_ID_FIELD} is not this run's — the correlation cannot be established deterministically`,
    });
  }
  if (unidentified) {
    return verdict({
      kind: 'unidentified',
      exitCode: EXIT.AMBIGUOUS,
      reason:
        'the read-back returned a document with no usable id — it could not be recorded as evidence, so it is not counted as arrival',
    });
  }
  if (new Set(ids).size !== ids.length) {
    return verdict({
      kind: 'duplicate-id',
      exitCode: EXIT.AMBIGUOUS,
      reason: `the read-back returned ${ids.length} documents sharing ${new Set(ids).size} id(s) — a duplicate cannot be told from a second arrival`,
    });
  }
  const sequences = mine.map(doc => doc[SEQUENCE_FIELD]);
  if (new Set(sequences).size !== sequences.length) {
    return verdict({
      kind: 'duplicate-sequence',
      exitCode: EXIT.AMBIGUOUS,
      reason: `two documents claim the same ${SEQUENCE_FIELD} within one run — a run-id collision or a redelivery, either way not a deterministic correlation`,
    });
  }
  if (ids.length > expectedCount) {
    return verdict({
      kind: 'excess',
      exitCode: EXIT.AMBIGUOUS,
      reason: `the read-back found ${ids.length} documents for a run that sent ${expectedCount} — more than was sent is as ambiguous as fewer, and MG-53 halts on an unrecorded document`,
    });
  }
  if (ids.length < expectedCount) return verdict({ kind: 'partial' });
  return verdict({ kind: 'complete' });
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
  // The high-water mark of everything this read-back has ever seen. It only ever
  // grows (decision 5): no failure path removes an id from it, and every exit
  // path reports it.
  let observedSoFar = [];
  // The documents the correlated query returned that this run cannot claim. Also
  // monotonic, and kept strictly apart from the observed set: recording one of
  // these as ours would tell MG-53 that a document it must halt on is accounted
  // for. Naming them is what makes the finding actionable.
  let anomalousSoFar = [];

  // Structured ids stay verbatim — they ARE the evidence, and a scrubbed id is
  // useless to MG-53 and MG-54. Only the human-readable `reason` embeds outside
  // text, and it goes through safeFragment.
  //
  // WHERE this run's documents actually landed, counted off the partition value
  // they CARRY (decision 3). The container partitions on the measured field, so
  // that value is the partition the document is in; which query returned it is a
  // fact about the query.
  //
  // Only documents THIS RUN can claim are counted: the census answers "where did
  // OUR documents land", which is the question the unexpected-partition outcome
  // turns on, and a stray document's partition is not an answer to it.
  //
  // FOUR STATES, NOT TWO. Strict equality against the value this run queried
  // decides `inExpected`; everything else is broken out rather than lumped
  // together, because the repairs differ and because `absent` is the architect's
  // top-ranked risk for this route (nothing between the device and Cosmos
  // injects a partition key — see decision 3):
  //
  //   inExpected      carries exactly the value this run scoped to
  //   differentValue  carries some OTHER usable value — landed under another key
  //   absent          carries NO partition key field at all — landed under none
  //   unusable        carries the field, but empty or not a string
  //
  // All three of the last are NOT in the expected partition, so `elsewhere` sums
  // them and a run holding any of them cannot confirm. The fail-closed default
  // cannot cost a healthy run a false anomaly — a document this fixture built
  // always carries the field — while the opposite default would hide a real one.
  //
  // Only meaningful once partitionKeyField is known; the caller checks that
  // first, because "we cannot see where they landed" is its own answer and not a
  // partition finding. With no measured field the census reports the total it
  // could see and claims nothing else.
  const partitionCensus = documents => {
    const mine = (Array.isArray(documents) ? documents : []).filter(
      doc => isPlainObject(doc) && isSyntheticDocument(doc, runId)
    );
    const census = {
      total: mine.length,
      inExpected: 0,
      differentValue: 0,
      absent: 0,
      unusable: 0,
      elsewhere: 0,
      values: [],
    };
    if (partitionKeyField === null) return census;

    // Encounter order, deduplicated — including the reserved tokens, so one
    // recorded token means "at least one document was in that state" exactly as
    // one recorded value does.
    const values = new Set();
    for (const doc of mine) {
      const present = Object.prototype.hasOwnProperty.call(doc, partitionKeyField);
      const value = present ? doc[partitionKeyField] : undefined;
      if (!present || value === undefined || value === null) {
        census.absent += 1;
        values.add(PARTITION_VALUE_ABSENT);
      } else if (typeof value !== 'string' || value === '') {
        census.unusable += 1;
        values.add(PARTITION_VALUE_UNUSABLE);
      } else if (value === partitionValue) {
        census.inExpected += 1;
        values.add(value);
      } else {
        census.differentValue += 1;
        values.add(value);
      }
    }
    census.elsewhere = census.differentValue + census.absent + census.unusable;
    census.values = [...values];
    return census;
  };

  const partitionValuesOf = documents => partitionCensus(documents).values;

  // ONE place decides what a result says about what was observed. Callers below
  // pass only what is new to their path; the ids are unioned in here, so a path
  // added later cannot drop them by forgetting to thread them through (decision
  // 5, and the evidence-emission contract in the module header).
  const result = fields => {
    const observedIds = Object.freeze(mergeIds(observedSoFar, fields.observedIds ?? []));
    const anomalousIds = Object.freeze(mergeIds(anomalousSoFar, fields.anomalousIds ?? []));
    return Object.freeze({
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
      observedPartitionValues: Object.freeze([]),
      observedArrivalMs: null,
      scope: null,
      ...fields,
      observedIds,
      observedCount: observedIds.length,
      // Never folded into observedIds and never silently dropped: a document
      // this run cannot claim is a finding in its own right, and the operator
      // needs it BY ID to investigate it.
      //
      // It is NOT the runbook's first stop condition and must not be described
      // as one. This read-back is FILTERED to this run's correlator, so a
      // document an unknown writer produced can never appear here. Stop
      // condition 1 — any unexpected document in the source containers — is
      // checked by the operator's UNFILTERED enumeration in the host phase, and
      // nothing this function returns bears on it either way.
      anomalousIds,
      polls,
      crossPartitionSweepRun,
      elapsedMs: now() - startedAt,
      exitLabel: exitLabel(fields.exitCode),
      // Anything short of a completed confirmation leaves the contents of the
      // container an open question: a timed-out document may still arrive, and an
      // auth or transport abort says nothing at all about what is there.
      uncertain: fields.confirmed !== true,
    });
  };

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

  // THE ONE PLACE a complete page becomes a confirmation, shared by the
  // partition-scoped poll and the sweep. Sharing it is the point: the
  // monotonicity guard below cannot be present in one caller and missing from
  // the other, and a confirmation cannot come to mean two different things
  // depending on which query produced it.
  const completeResult = ({ verdict, documents, scope, note = '' }) => {
    // The count is right in THIS page, but an earlier page returned ids this one
    // does not. Confirming here would put an id in the evidence record's
    // observed set that the confirming read did not see, or leave one out that
    // was genuinely observed — either way MG-53's "the source holds only the
    // recorded documents" check would be run against a set nobody read in one
    // piece. Ambiguity, never a success.
    if (observedSoFar.length > verdict.ids.length) {
      return result({
        exitCode: EXIT.AMBIGUOUS,
        scope,
        observedPartitionValues: Object.freeze(partitionValuesOf(documents)),
        reason: `${observedSoFar.length} distinct document id(s) have been read back across ${polls} poll(s) for a run that sent ${expectedCount}, and the ${verdict.ids.length} in the latest page are not all of them — an id seen once is never unseen, so this is a correlation ambiguity rather than a confirmation`,
      });
    }
    return result({
      confirmed: true,
      exitCode: EXIT.OK,
      scope,
      observedPartitionValues: Object.freeze(partitionValuesOf(documents)),
      observedArrivalMs: now() - startedAt,
      reason: `read back ${verdict.ids.length} of ${expectedCount} marked, run-correlated document(s) out of the destination container${note}`,
    });
  };

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
      // Recorded BEFORE the branch, so every outcome below — including the ones
      // that abort — reports what this page saw.
      observedSoFar = mergeIds(observedSoFar, verdict.ids);
      anomalousSoFar = mergeIds(anomalousSoFar, verdict.anomalousIds);
      if (verdict.exitCode) {
        return result({
          exitCode: verdict.exitCode,
          scope: 'expected-partition',
          observedPartitionValues: Object.freeze(partitionValuesOf(documents)),
          reason: verdict.reason,
        });
      }
      if (verdict.kind === 'complete') {
        return completeResult({ verdict, documents, scope: 'expected-partition' });
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
      observedPartitionValues: Object.freeze(partitionValuesOf(lastPartialDocuments)),
      // Phrased off the accumulated set rather than the last page: if the pages
      // disagreed, more distinct ids may have been observed than were ever
      // present at once, and the count an operator acts on is everything seen.
      reason: `the ${timeoutMs}ms wait bound elapsed having read back ${observedSoFar.length} distinct document(s) and never the expected ${expectedCount} in one page — an incomplete read-back is a failure, never an absence and never a success`,
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
  observedSoFar = mergeIds(observedSoFar, sweepVerdict.ids);
  anomalousSoFar = mergeIds(anomalousSoFar, sweepVerdict.anomalousIds);
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
      observedPartitionValues: Object.freeze(partitionValuesOf(sweep)),
      reason: sweepVerdict.reason,
    });
  }

  // An INCOMPLETE cross-partition set is a correlation ambiguity and is never
  // upgraded into a partition claim (decision 3). "Delivered, unexpected
  // partition" is a statement about this run's documents; with some of them
  // unaccounted for, the sweep has not established where the run landed — only
  // that part of it is somewhere. Saying more than that would put a routing
  // diagnosis nobody witnessed into the artifact MG-53 and MG-54 parse.
  if (sweepVerdict.kind === 'partial') {
    return result({
      exitCode: EXIT.AMBIGUOUS,
      scope: 'cross-partition',
      observedPartitionValues: Object.freeze(partitionValuesOf(sweep)),
      reason: `the cross-partition sweep read back ${sweepVerdict.ids.length} of ${expectedCount} document(s) for run ${safeFragment(runId)} after the ${timeoutMs}ms wait bound elapsed — an incomplete set is a correlation ambiguity, never an absence, never a success, and never a partition finding about a run most of whose documents are unaccounted for`,
    });
  }

  // The full set is here. WHERE it landed is now read off the documents.
  //
  // Without a measured partition key field there is nothing to read it off, and
  // this tool does not guess: the honest answer is that the documents were found
  // and their partition could not be established, which is an ambiguity rather
  // than either a confirmation or a partition finding. (The CLI always supplies
  // the measured field, so this is a caller that asked for less than it needed.)
  if (partitionKeyField === null) {
    return result({
      exitCode: EXIT.AMBIGUOUS,
      scope: 'cross-partition',
      reason: `all ${sweepVerdict.ids.length} document(s) for run ${safeFragment(runId)} were read back by the cross-partition sweep, but no partition key field was supplied, so whether they landed under the expected partition ${safeFragment(partitionValue)} cannot be established — an unestablished partition is an ambiguity, not a confirmation and not a partition finding`,
    });
  }

  const landing = partitionCensus(sweep);
  const landed = landing.values;

  // Every document is in the partition this run queried. It is a CONFIRMATION —
  // the scoped polls simply missed them by timing, most plainly when the
  // documents arrived during the round trip between the last poll and the sweep.
  // Calling this a partition anomaly would report a healthy route as broken.
  // The bound is the thing that was wrong, and the recorded arrival delay (past
  // the bound, on this path) is exactly the calibration that says so.
  if (landing.elsewhere === 0) {
    return completeResult({
      verdict: sweepVerdict,
      documents: sweep,
      scope: 'cross-partition',
      note: ` under the EXPECTED partition ${safeFragment(partitionValue)} — found by the cross-partition sweep rather than by a scoped poll, which is a timing artefact of the ${timeoutMs}ms wait bound and NOT a partition anomaly; raise the bound to observe them in the scoped poll`,
    });
  }

  // Delivered — but not, or not entirely, where this tool looked first. Reported
  // off the partition values the documents carry, and counted, so an operator
  // reading it knows how much of the run went astray. An absence here would call
  // a working route broken and send them to debug an endpoint doing its job.
  //
  // The three ways to miss the expected partition are stated SEPARATELY, and
  // only when they actually occurred. Composed from the CENSUS COUNTS rather
  // than from the recorded value list, so the sentence stays true whatever the
  // documents carry — and so a document with no partition key field is never
  // described as carrying a different one, which is what this used to say.
  const missed = [];
  if (landing.differentValue) {
    const others = landed.filter(
      value =>
        value !== PARTITION_VALUE_ABSENT &&
        value !== PARTITION_VALUE_UNUSABLE &&
        value !== partitionValue
    );
    missed.push(
      `${landing.differentValue} carrying a DIFFERENT ${partitionKeyField} (values observed: ${others
        .map(value => safeFragment(value))
        .join(', ')})`
    );
  }
  if (landing.absent) {
    // The architect's predicted failure mode for this route, and the reason this
    // state is broken out at all: nothing between the device and Cosmos injects
    // a partition key, so a body that omits the field produces a document with
    // NO partition key rather than one under some other key. The two need
    // different repairs, and only this one points at the message body.
    missed.push(
      `${landing.absent} carrying NO ${partitionKeyField} FIELD AT ALL, recorded as ${PARTITION_VALUE_ABSENT} — landed under NO partition key rather than under a different one, which points at the message body the sender built and not at the routing target`
    );
  }
  if (landing.unusable) {
    missed.push(
      `${landing.unusable} carrying a ${partitionKeyField} that is present but empty or not a string, recorded as ${PARTITION_VALUE_UNUSABLE}`
    );
  }
  return result({
    exitCode: EXIT.UNEXPECTED_PARTITION,
    scope: 'cross-partition',
    observedPartitionValues: Object.freeze(landed),
    observedArrivalMs: null,
    reason: `${landing.elsewhere} of ${landing.total} document(s) read back for run ${safeFragment(runId)} are NOT in the expected partition ${safeFragment(partitionValue)}: ${missed.join('; ')} — the route delivered, but the partition the body put them in is not the one this run queried, so the run is not confirmed`,
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
 * It is not a confirmation and cannot be mistaken for one: `confirmed` is false
 * and `scope` says whether a read-back ever happened — 'not-attempted' is the
 * machine-readable difference between "read back and found nothing" and "never
 * read back at all", the first a fact about the route and the second a fact
 * about the run. `polls: 0` and `elapsedMs: 0` say the same thing to a human.
 * The wait bound is carried because every result reports the bound it was
 * configured with, on every path.
 *
 * `observedIds` is a parameter, defaulting to none, for the same reason the
 * confirmation's own accumulator exists: a caller that HAS read documents back
 * and then aborted for some later reason must be able to build the aborted
 * result without discarding them. Taking them here makes that structurally
 * possible rather than dependent on the caller remembering, and a non-empty set
 * moves `scope` off 'not-attempted' so the record never claims a read-back it
 * did not perform — or denies one it did.
 */
export function abortedConfirmation({
  runId,
  exitCode,
  reason,
  observedIds = [],
  anomalousIds = [],
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

  // Through the same union every other path uses, so an unusable id is refused
  // here exactly as it would be there.
  const observed = mergeIds(observedIds);
  const anomalous = mergeIds(anomalousIds);

  return Object.freeze({
    confirmed: false,
    runId,
    expectedCount,
    waitBoundMs: timeoutMs,
    pollIntervalMs,
    partitionValue,
    partitionKeyField,
    observedIds: Object.freeze(observed),
    observedCount: observed.length,
    anomalousIds: Object.freeze(anomalous),
    observedPartitionValues: Object.freeze([]),
    observedArrivalMs: null,
    // 'not-attempted' is a CLAIM — that no read-back happened — so it is only
    // made when nothing was read back.
    scope: observed.length > 0 ? 'aborted-after-read-back' : 'not-attempted',
    exitCode,
    reason,
    polls: 0,
    crossPartitionSweepRun: false,
    elapsedMs: 0,
    exitLabel: exitLabel(exitCode),
    // Always. A run that aborted before it could read anything back knows LESS
    // about the container than a timeout does, and the record must say so rather
    // than let an empty observed set read as "nothing arrived".
    uncertain: true,
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
  // Said out loud on every unconfirmed path, because the line above it is a
  // count and a count of zero is exactly what an operator misreads as "nothing
  // was written".
  const uncertain = result.uncertain ? ', container contents UNCERTAIN' : '';
  // Never merged into the count above: these are documents the read-back saw
  // and this run cannot claim, which is a finding in its own right and not a
  // footnote to a success line. It is NOT the runbook's first stop condition —
  // that one is the operator's unfiltered enumeration of the source containers,
  // which this filtered read-back cannot perform.
  const anomalies = result.anomalousIds?.length
    ? `, ${result.anomalousIds.length} document(s) NOT attributable to this run: ${result.anomalousIds
        .map(id => safeFragment(id, 40))
        .join(', ')}`
    : '';
  return (
    `${exitLabel(result.exitCode)}: ${result.observedCount}/${result.expectedCount} marked documents ` +
    `for run ${safeFragment(result.runId)} (${result.polls} poll(s), bound ${result.waitBoundMs}ms, ${arrival}${sweep}${uncertain})${anomalies}`
  );
}

// ---------------------------------------------------------------------------
// THE EVIDENCE-EMISSION CONTRACT: four id sets, one definition (see the module
// header).
//
// This ledger exists because the same defect kept turning up on newly reachable
// paths — a later error discarding ids the tool already knew — and each instance
// was individually repairable in the place it appeared. That is the shape of a
// MISSING CONTRACT rather than a bug: what was absent was a single answer to
// "what does this run know about what it put in the container, and how sure is
// it?". So the answer lives here, once, and the sender and the evidence record
// read it rather than each maintaining their own idea of it.
//
// THE FOUR SETS ARE NOT INTERCHANGEABLE:
//
//   requestedIds  minted by the sender AND ATTEMPTED. An id is requested at the
//                 moment the attempt begins, never earlier: a message the run
//                 never got to is not a message that failed, and recording one as
//                 the other would put an id in the artifact for a document that
//                 cannot exist.
//   acceptedIds   az reported success. The message is IoT Hub's problem now.
//   ambiguousIds  az reported failure — and acceptance is UNKNOWN. This set is
//                 the crux of the contract. The CLI can fail AFTER the hub
//                 accepted the message (a non-zero exit on teardown, a killed
//                 process, a lost response), so a send failure is ambiguous BY
//                 CONSTRUCTION and must never be recorded as definitively
//                 not-sent. An unresolved id is folded in here too, fail-closed:
//                 a fate the sender never recorded is not evidence of absence.
//   observedIds   READ BACK out of Cosmos, including anything a partial poll saw
//                 before a later abort. Once observed, never discarded.
//
// And `uncertain` is true whenever anything is ambiguous or no confirmation
// completed — which is what stops a downstream reader treating an empty
// observedIds as proof the run wrote nothing.
// ---------------------------------------------------------------------------

// The record's id-set field names, in one place so a consumer (MG-53, MG-54) and
// a producer cannot disagree about what the artifact is called.
export const ID_SET_NAMES = Object.freeze([
  'requestedIds',
  'acceptedIds',
  'ambiguousIds',
  'observedIds',
]);

/**
 * Order-preserving union. The ONLY way ids accumulate anywhere in this tool.
 *
 * There is deliberately no remove, no replace and no set-difference: every
 * instance of the defect this contract answers was some code path deciding that
 * an earlier observation no longer counted.
 */
export function mergeIds(existing = [], incoming = []) {
  const merged = [];
  const seen = new Set();
  for (const source of [existing, incoming]) {
    if (!Array.isArray(source)) {
      throw new FixtureError(EXIT.USAGE, 'ids must be merged from arrays of strings');
    }
    for (const id of source) {
      if (typeof id !== 'string' || id.trim() === '') {
        throw new FixtureError(
          EXIT.USAGE,
          'refusing to record an unusable document id — an id that cannot be named cannot be evidence'
        );
      }
      if (seen.has(id)) continue;
      seen.add(id);
      merged.push(id);
    }
  }
  return merged;
}

/**
 * Did the platform assign an id this run did not choose?
 *
 * Divergence is a WITNESSED fact about a document that was actually read back:
 * an observed id that is not one of the requested ones. It is NEVER inferred
 * from a count shortfall — "we asked for three and saw two" is an incomplete
 * read-back, and calling that divergence would assert a platform renaming
 * behaviour nobody observed, in the one artifact MG-53 and MG-54 parse
 * mechanically. A downstream ticket would then act on a fabricated claim.
 *
 * Whether the IoT Hub Cosmos endpoint honours a body's `id` at all is behaviour
 * no file in this repo pins down, which is exactly why it is recorded as an
 * observation rather than assumed either way.
 */
export function observedIdsDiverge({ observedIds = [], requestedIds = [] } = {}) {
  const requested = new Set(mergeIds(requestedIds));
  return mergeIds(observedIds).some(id => !requested.has(id));
}

const withoutAll = (ids, ...excluded) => {
  const drop = new Set(excluded.flat());
  return ids.filter(id => !drop.has(id));
};

/**
 * The run's id ledger. One per invocation, threaded through the send and the
 * confirmation, snapshotted into the evidence record.
 *
 * Usage is deliberately narrow, and the ORDER matters: `request(id)` is called
 * immediately before the attempt for that message, and exactly one of
 * `accept(id)` / `markAmbiguous(id)` follows it. Anything left unresolved when
 * the snapshot is taken — because the process died mid-attempt, or because a
 * caller forgot — is reported as ambiguous, never as not-sent.
 */
export function createRunLedger({ runId } = {}) {
  requireNonEmptyString(runId, 'runId');

  const requested = [];
  const accepted = [];
  const ambiguous = [];
  let observed = [];

  const requireKnown = (id, verb) => {
    if (typeof id !== 'string' || !requested.includes(id)) {
      throw new FixtureError(
        EXIT.USAGE,
        `cannot ${verb} ${safeFragment(id)}: it was never requested — an id whose attempt was not recorded cannot have an outcome recorded for it`
      );
    }
    if (accepted.includes(id) || ambiguous.includes(id)) {
      throw new FixtureError(
        EXIT.USAGE,
        `the fate of ${safeFragment(id)} is already recorded and is not revisable — a message whose acceptance became unknown never becomes known again`
      );
    }
  };

  return {
    runId,

    /** An attempt is STARTING for this id. */
    request(id) {
      requireNonEmptyString(id, 'requested id');
      if (requested.includes(id)) {
        throw new FixtureError(
          EXIT.USAGE,
          `${safeFragment(id)} was already requested — a duplicate id would make the run's own record ambiguous`
        );
      }
      requested.push(id);
      return id;
    },

    /** az reported success for this id. */
    accept(id) {
      requireKnown(id, 'accept');
      accepted.push(id);
      return id;
    },

    /**
     * az reported FAILURE for this id — which is not the same as "it did not
     * arrive", and is recorded as the unknown it is.
     */
    markAmbiguous(id) {
      requireKnown(id, 'mark ambiguous');
      ambiguous.push(id);
      return id;
    },

    /** Ids READ BACK out of Cosmos. Monotonic: this only ever adds. */
    observe(ids) {
      observed = mergeIds(observed, Array.isArray(ids) ? ids : [ids]);
      return observed.length;
    },

    /**
     * The run's knowledge, frozen. `confirmation` is the confirmArrival (or
     * abortedConfirmation) result, if the run got that far; its observed ids are
     * folded in, and its outcome decides half of `uncertain`.
     */
    snapshot({ confirmation = null } = {}) {
      const observedIds = mergeIds(
        observed,
        confirmation && Array.isArray(confirmation.observedIds) ? confirmation.observedIds : []
      );
      // Fail-closed: unresolved means unknown, and unknown belongs with the
      // ambiguous. It is never quietly dropped and never counted as not-sent.
      const ambiguousIds = mergeIds(ambiguous, withoutAll(requested, accepted, ambiguous));
      const attempted = requested.length > 0;
      return Object.freeze({
        runId,
        requestedIds: Object.freeze([...requested]),
        acceptedIds: Object.freeze([...accepted]),
        ambiguousIds: Object.freeze(ambiguousIds),
        observedIds: Object.freeze(observedIds),
        attempted,
        // Witnessed, never inferred: see observedIdsDiverge.
        idDivergence: observedIdsDiverge({ observedIds, requestedIds: requested }),
        // Two independent reasons, either sufficient: something was sent whose
        // acceptance nobody knows, or no confirmation ever completed.
        uncertain: ambiguousIds.length > 0 || confirmation?.confirmed !== true,
      });
    },
  };
}

/**
 * Must this run write an evidence record?
 *
 * Yes if it ATTEMPTED anything at all — the record is the only artifact MG-53
 * and MG-54 parse, and a document nobody recorded halts MG-53 in the one way its
 * operator cannot diagnose. Only a run that refused before its first attempt
 * (bad arguments, an unmeasurable container, a failed pre-send read) may exit
 * without one.
 */
export function mustEmitEvidence(snapshot) {
  return Boolean(snapshot?.attempted);
}

/**
 * One operator-facing line for a snapshot, on any path.
 *
 * It states the four counts and NEVER claims that nothing was written: with
 * anything attempted, the honest sentence is "N of unknown acceptance", not
 * "nothing arrived". Ids themselves are not printed here — they go in the
 * artifact, which is what a downstream ticket reads.
 */
export function describeIdSets(snapshot) {
  const parts = [
    `${snapshot.requestedIds.length} attempted`,
    `${snapshot.acceptedIds.length} accepted by IoT Hub`,
    `${snapshot.ambiguousIds.length} of UNKNOWN acceptance`,
    `${snapshot.observedIds.length} read back out of Cosmos`,
  ];
  const caveat = snapshot.uncertain
    ? ' — what the container now holds is NOT established by this run; the recorded ids are what it may hold'
    : '';
  return `${parts.join(', ')}${caveat}`;
}
