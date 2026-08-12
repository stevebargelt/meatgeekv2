#!/usr/bin/env node
// MeatGeek — dev IoT device fixture sender (MG-67).
//
//   node apps/infrastructure/scripts/iot-fixture/send-fixture.mjs \
//     --hub meatgeek-v2-dev-iothub-259d4bf5b628 \
//     --device meatgeek-v2-dev-synthetic-fixture-device \
//     --account mgv2-dev-f640e19ae7ab \
//     --database meatgeek-v2-dev-db \
//     --container temperatures \
//     --container-definition ./temperatures.json \
//     --evidence-out ./mg67-evidence.json
//
// This is the ONLY file in the tool that touches a credential boundary or a
// child process. Every decision it makes — what a fixture document is, what the
// container's shape measured as, whether the run is confirmed, what the evidence
// record says — comes from the sibling modules, which construct nothing and
// spawn nothing. That split is what makes every failure path in this tool
// reachable from a test with no az binary, no Azure package and no network.
//
// ---------------------------------------------------------------------------
// HR1 — THE CREDENTIAL POSTURE. This is a stop condition, not a preference.
// ---------------------------------------------------------------------------
//
// THE SEND HANDLES NO CREDENTIAL AT ALL. `az iot device send-d2c-message`
// addresses the hub and the device BY NAME and resolves the device key itself,
// server-side, under the operator's already-authenticated Azure identity. This
// process therefore never reads, holds, stores or can leak one. There is no
// key mode, no connection-string mode, no SAS mode and no certificate mode
// anywhere in this tool — not as a fallback, not behind a flag. A key mode
// could not work regardless (the Cosmos account runs
// local_authentication_enabled = false, and the read-back is AAD-only), so the
// only thing a key path could add here is an exposure.
//
// NOTHING CREDENTIAL-SHAPED IS ACCEPTED. Every spelling of a credential flag is
// refused BY NAME with a usage error, and the argv handed to az is scanned
// against the tool's own scrubber before the spawn: if any element is
// credential-shaped, the send refuses rather than proceeding. A future edit that
// grows a key argument fails there instead of at a review.
//
// THE INVOCATION SHAPE IS PART OF THE CONTRACT, not just this tool's own output.
// az persists invocations under ~/.azure and prints request signatures under
// verbosity, which is disk this repo's redaction posture cannot reach. So
// `--debug` and `--verbose` are never passed, and are refused if an operator
// passes them through; and the child's raw argv and raw stderr are NEVER echoed.
// Child stderr goes through scrubChildOutput() before any operator-facing line
// exists, on every path including every failure path.
//
// FAILURE OUTPUT NAMES THE DEVICE, THE HUB, THE OUTCOME AND THE EXIT LABEL —
// never a secret, on any path.
//
// ---------------------------------------------------------------------------
// HR2/HR5 — WHAT AN EXIT 0 MEANS.
// ---------------------------------------------------------------------------
//
// Exactly one thing: the expected count of marker-carrying, run-correlated
// documents was READ BACK OUT of the destination Cosmos container within an
// explicit, reported wait bound, AND the evidence recording them was written. A
// green hub metric, a green route metric and a green /api/health/cosmos observe
// no document and are not consulted here (MG-24 and MG-58 are the precedents for
// shipping behind a green signal that proved nothing).
//
// THE FUNNEL THAT CHOOSES THE CODE CANNOT DEFAULT TO 0. It used to: the single
// exit funnel read `confirmation ? confirmation.exitCode : (failure?.exitCode ??
// EXIT.OK)`, so a run holding NEITHER — an unanticipated state by construction,
// since one of the two exists on every path this file writes — fell through to
// success. That is the ticket's central invariant inverted at its last line. The
// decision now lives in fixture-core's resolveOutcomeCode(), which returns 0
// only for a confirmation that carries both EXIT.OK and confirmed:true, and
// reports every other shape — including ones it was not written to expect — as
// an explicit unanticipated outcome with its own nonzero code. settleRun()
// re-checks the same invariant immediately before returning, so no step added
// between the resolution and the exit can manufacture a 0 either.
//
// THE EVIDENCE DESTINATION IS RESERVED BEFORE THE FIRST SEND. --evidence-out is
// a DIRECTORY, and every run exclusively owns one file inside it whose name is
// derived from the run's unique id — so two runs can never name the same file and
// there is nothing to coordinate. The reservation proves the directory usable and
// the publication primitive available, and atomically claims the derived file,
// ALL before anything live happens. An unusable directory or a reused destination
// is a usage-class refusal while nothing live has happened; discovering it after
// the send would leave synthetic documents in the live container that the tool is
// only then refusing to record — the unrecorded-document condition that halts
// MG-53, for a reason it could have seen for free. Because the run OWNS its
// destination, the after-the-send write needs no concurrency dance and there is
// no flag that could replace an existing record.
//
// A PRE-FLIGHT READ RUNS BEFORE ANYTHING IS SENT. It serves three purposes and
// is worth the extra round trip for each of them:
//   1. HR5 says the proof is a document "not present before the run". The
//      pre-flight asserts exactly that, for this run's freshly minted id,
//      BEFORE the send — otherwise "newly identified" is an assumption.
//   2. The single most likely failure of the live run is a Cosmos data-plane
//      role assignment that has not propagated. Discovering that AFTER sending
//      would leave three unconfirmable documents in the source container, which
//      is precisely the unrecorded-document condition that halts MG-53.
//   3. It proves the read path works, so a later absence is a fact about the
//      route rather than about the reader.
//
// ---------------------------------------------------------------------------
// THE EVIDENCE-EMISSION CONTRACT. One path, every outcome.
// ---------------------------------------------------------------------------
//
// There is exactly ONE place in this file that emits an evidence record, and it
// runs on EVERY outcome — confirmed, timeout, auth, transport, marker violation,
// ambiguity, send failure. No exit path bypasses it. A record is emitted
// whenever ANY message was ATTEMPTED; only a run that refused before its first
// attempt (bad arguments, an unmeasurable container, a refused pre-send read)
// exits without one.
//
// That is deliberately not a list of special cases. The same defect kept
// reappearing on newly reachable paths — a later error discarding ids the tool
// already knew — and each instance was individually repairable where it
// appeared. That is a missing contract, not a bug, so the contract lives in
// fixture-core (createRunLedger, the four id sets) and this file threads ONE
// ledger through the run and hands it to ONE emitter. A path added later
// inherits the behaviour by passing through the same funnel rather than by its
// author remembering to.
//
// WHAT THE RUN KNOWS, in four sets that are not interchangeable:
//   requestedIds  attempted. Recorded at the moment the attempt begins.
//   acceptedIds   az reported success.
//   ambiguousIds  az reported FAILURE and acceptance is UNKNOWN — the CLI can
//                 fail AFTER IoT Hub took the message, so a send failure is
//                 ambiguous BY CONSTRUCTION.
//   observedIds   read back out of Cosmos. Monotonic: once observed, never
//                 discarded by a later failure.
//
// TWO THINGS THIS FILE MAY NEVER SAY:
//   1. That NOTHING WAS WRITTEN, when anything was attempted. "az failed on
//      message 1 of 3" is not "no document exists"; it is one document of
//      unknown fate. Reporting the second is an error dressed as a known
//      absence — the MG-66 conflation, on the write side.
//   2. That ids DIVERGED, on anything but a witnessed observation. Divergence is
//      an observed id the sender did not request. It is never inferred from a
//      count shortfall: asserting a platform renaming nobody saw, in the one
//      artifact MG-53 and MG-54 parse mechanically, makes a downstream ticket
//      act on a fabricated claim. fixture-core owns that judgement
//      (observedIdsDiverge) so producer and consumer cannot disagree.
//
// An evidence write that itself fails after a send has happened is its own exit
// code (10), never USAGE, and prints the ids so the operator can record them by
// hand. MG-53 halts on any source document its recorded set does not account
// for, and cannot tell such a document apart from the unknown-writer finding
// that halt exists to catch; so "documents landed and nothing recorded them" is
// the one outcome this tool must never produce quietly.
//
// EXIT CODES (fixture-core owns the vocabulary; every class is distinct):
//   0 confirmed-in-cosmos          5 transport abort
//   1 usage error                  6 synthetic marker violation
//   2 send failure                 7 correlation ambiguity
//   3 confirmation timeout         8 container definition refusal
//   4 auth failure                 9 delivered, unexpected partition
//  10 evidence unrecorded (documents may be live)

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

import {
  DECLARED_DEFAULT_TTL_SECONDS,
  describeContainerDefinition,
  parseContainerDefinition,
} from './container-definition.mjs';
import {
  buildEvidenceRecord,
  describeEvidence,
  describeReservation,
  releaseReservation,
  reserveEvidenceDestination,
  writeEvidenceRecord,
} from './evidence.mjs';
import {
  CONFIRMATION_QUERY,
  DEFAULT_CONFIRMATION_TIMEOUT_MS,
  DEFAULT_POLL_INTERVAL_MS,
  EXIT,
  FIXTURE_DEVICE_ID,
  FixtureError,
  MESSAGES_PER_RUN,
  RUN_ID_PARAMETER,
  SYNTHETIC_MARKER,
  SYNTHETIC_MARKER_FIELD,
  TICKET,
  TOOL_NAME,
  TOOL_VERSION,
  UNANTICIPATED_OUTCOME_CODE,
  abortedConfirmation,
  buildFixtureMessages,
  classifyError,
  confirmArrival,
  createRunLedger,
  defaultLog,
  describeConfirmation,
  describeError,
  describeIdSets,
  exitLabel,
  formatD2cProperties,
  mergeIds,
  mustEmitEvidence,
  newRunId,
  resolveOutcomeCode,
  scrubChildOutput,
  scrubSecrets,
} from './fixture-core.mjs';

export const AZ_COMMAND = 'az';

// A bounded wait for the child, so a hung az cannot hang the run. Exceeded, it
// is a SEND FAILURE — never an absence, and never something the confirmation is
// asked to explain.
export const DEFAULT_SEND_TIMEOUT_MS = 120_000;

const USAGE = `${TOOL_NAME} ${TOOL_VERSION} — send ${MESSAGES_PER_RUN} synthetic ${TICKET} messages from the
durable dev fixture device and PROVE they were read back out of Cosmos.

USAGE
  send-fixture.mjs --hub <name> --account <name> --database <id> --container <id>
                   --container-definition <path|-> --evidence-out <dir>
                   [--device <id>] [--timeout <ms>] [--poll-interval <ms>]

WHAT IT DOES, IN ORDER
  1. Measures the destination container's partition key path and its ACTUAL
     default_ttl from the --container-definition document. Nothing is assumed:
     a document missing either is refused (exit 8), never defaulted.
  2. RESERVES this run's evidence file inside --evidence-out — a per-run,
     immutable artifact whose name is derived from this run's unique id — BEFORE
     anything live happens. The reservation proves the directory usable and the
     publication primitive available, and atomically claims the file. A reused
     destination or an unusable directory is a usage error (exit 1) while nothing
     has been sent, rather than documents in the container this tool then refuses
     to record. Two runs never share a destination, so there is nothing to
     coordinate and no flag that could replace an existing record.
  3. Reads the destination container ONCE, before sending, and requires this
     run's id to be absent. That is what makes the proof a NEWLY identified
     document, and it surfaces a missing data-plane role assignment BEFORE any
     document is written that could not then be confirmed.
  4. Sends ${MESSAGES_PER_RUN} D2C messages via 'az iot device send-d2c-message', each
     carrying the ${SYNTHETIC_MARKER_FIELD}=${SYNTHETIC_MARKER} marker and this
     run's unique correlator, and each declaring JSON content type and utf-8
     encoding (without those the hub writes an opaque payload, not a queryable
     JSON document).
  5. Polls the container within an explicit, reported wait bound until the full
     set is read back. Anything less is a failure with its own exit code.
  6. Writes the machine-readable evidence artifact MG-53 and MG-54 consume.

TARGET
  --hub <name>                 IoT hub name, e.g. meatgeek-v2-dev-iothub-259d4bf5b628
  --device <id>                Device id. Default: ${FIXTURE_DEVICE_ID}
  --account <name>             Cosmos account name; the endpoint is derived as
                               https://<name>.documents.azure.com:443/
  --database <id>              e.g. meatgeek-v2-dev-db
  --container <id>             The container the IoT route targets, e.g. temperatures

MEASUREMENT (HR4 — measured, never assumed)
  --container-definition <path|->
                               An 'az cosmosdb sql container show' document. '-'
                               reads stdin. Produce it with:

                                 az cosmosdb sql container show \\
                                   --account-name <account> -g <resource-group> \\
                                   --database-name <database> --name <container> \\
                                   | node .../send-fixture.mjs ... --container-definition -

                               az holds the identity; this tool holds none. The
                               declared dev comparand is ${DECLARED_DEFAULT_TTL_SECONDS}s; a measured value
                               that differs is reported as configuration drift and
                               RECORDED — the measured number is what is used.

WAIT (HR2 — bounded, reported, and never infinite)
  --timeout <ms>               Confirmation wait bound. Default ${DEFAULT_CONFIRMATION_TIMEOUT_MS}.
                               The bound actually used is reported on every path.
                               The bound elapsing exits ${EXIT.TIMEOUT}.
  --poll-interval <ms>         Poll cadence within the bound. Default ${DEFAULT_POLL_INTERVAL_MS}.

EVIDENCE (HR3 — recorded, machine-readable)
  --evidence-out <dir>         Required. A DIRECTORY the tool writes a per-run,
                               IMMUTABLE JSON artifact into. The file name is
                               DERIVED from this run's unique id, so every run
                               exclusively owns one destination — two runs can
                               never name the same file, overlapping runs are
                               fully supported, and there is nothing to coordinate.
                               The artifact carries the observed document ids and
                               their count, the marker, the run id, the partition
                               key path and value, the MEASURED default_ttl with
                               the declared value and any drift, the wait bound
                               used, the observed arrival delay and the
                               run/expiry instants.

                               RESERVED BEFORE THE FIRST SEND. The directory has
                               to exist and the publication primitive has to work
                               there, and the derived file is atomically claimed —
                               all BEFORE anything live happens. A reused
                               destination (a file already at the derived name)
                               fails outright, usage-class, while nothing is live.
                               There is NO flag that replaces an existing record:
                               an evidence artifact is immutable and per-run.

                               WRITTEN ON EVERY OUTCOME, not just on success. Any
                               run that ATTEMPTED a send emits one, and it carries
                               four separate id sets: attempted, accepted by IoT
                               Hub, of UNKNOWN acceptance (az failed, which can
                               happen after the hub took the message), and read
                               back out of Cosmos. A failure record is never
                               readable as proof — confirmed stays false — and it
                               never claims that nothing was written.

AUTH — THERE IS NO CREDENTIAL TO SUPPLY, AND NONE IS ACCEPTED
  Send:      'az iot device send-d2c-message' resolves the device key itself from
             the hub under your already-authenticated identity. Run 'az login'
             first. The command needs the azure-iot extension:
             'az extension add --name azure-iot'. This tool never reads, holds
             or logs a device key, and refuses --key, --device-key, --login,
             --connection-string, --sas, --certificate and every neighbouring
             spelling.
  Read-back: Azure Entra ID via DefaultAzureCredential, and ONLY that. The dev
             account runs local_authentication_enabled = false, so key auth
             could not work even if this tool offered it.

             Cosmos DATA-PLANE access is not granted by control-plane RBAC:
             Subscription Owner alone gets a 403 here. CHECK FIRST whether you
             already hold a suitable account-scope data-plane assignment — if
             you do, the grant below is SKIPPED ENTIRELY and there is nothing to
             remove afterwards, because this run created nothing:

               ME=$(az ad signed-in-user show --query id -o tsv)
               az cosmosdb sql role assignment list \\
                 --account-name <account> -g <resource-group> -o json \\
                 | jq -r --arg p "$ME" '[.[] | select(.principalId==$p)
                     | select((.scope|test("/dbs/"))|not) | .name] | join(" ")'

             NON-EMPTY OUTPUT MEANS SKIP: create nothing, delete nothing, and
             record the skip. That assignment predates this ticket and is NOT
             yours to remove — if you believe it is stale, that is a finding to
             raise, not a step here. ONLY IF THE OUTPUT IS EMPTY, grant yourself
             the built-in Data Reader at ACCOUNT scope, CAPTURE THE ASSIGNMENT
             ID the create returns, and remove it afterwards BY THAT ID:

               MG67_ROLE_ASSIGNMENT_ID=$(az cosmosdb sql role assignment create \\
                 --account-name <account> -g <resource-group> \\
                 --role-definition-id 00000000-0000-0000-0000-000000000001 \\
                 --principal-id "$(az ad signed-in-user show --query id -o tsv)" \\
                 --scope "/" --query id -o tsv)
               echo "$MG67_ROLE_ASSIGNMENT_ID"   # record this in the ticket NOW

               # ...run this tool... then remove EXACTLY what was created:
               az cosmosdb sql role assignment delete \\
                 --account-name <account> -g <resource-group> \\
                 --role-assignment-id "$MG67_ROLE_ASSIGNMENT_ID" --yes

             REMOVE BY ASSIGNMENT ID, NEVER BY A NAME OR PRINCIPAL MATCH. This
             account is shared live infrastructure and your principal may
             already hold a Data Reader assignment somebody else's work depends
             on; a list-and-match removal can delete THAT one instead of the one
             this run created, silently revoking access nobody asked you to
             touch. If the id was not captured, or the delete does not match it,
             STOP and report rather than guessing at which assignment to remove
             — a stale extra assignment is a finding to raise, and deleting the
             wrong one is an outage.

             Assignments take a minute or two to propagate. A 401/403 exits ${EXIT.AUTH}
             immediately and is NEVER retried or reported as a timeout or an
             absence — it says nothing about whether the route delivered.

EXIT CODES
  0 confirmed-in-cosmos       5 transport abort
  1 usage error               6 synthetic marker violation
  2 send failure              7 correlation ambiguity
  3 confirmation timeout      8 container definition refusal
  4 auth failure              9 delivered, unexpected partition
 10 evidence unrecorded (documents may be live)

  Exit 0 means one thing: ${MESSAGES_PER_RUN} marker-carrying, run-correlated documents were
  READ BACK OUT of ${'<container>'} and the evidence recording them was written.
  Absence of an error is never success.

  Exit ${EXIT.EVIDENCE_UNRECORDED} means the live container changed and NOTHING RECORDED IT: a send
  happened, and the evidence file could not be written. The ids are printed on
  stderr — copy them into the ticket before doing anything else, because MG-53
  halts on a source document its recorded set does not account for. It takes
  precedence over the confirmation's own code (printed on the lines above it),
  because recording the ids is the action that has to come first.
`;

// ---------------------------------------------------------------------------
// Argument parsing.
// ---------------------------------------------------------------------------

const FLAGS_WITH_VALUES = new Set([
  '--hub',
  '--device',
  '--account',
  '--database',
  '--container',
  '--container-definition',
  '--timeout',
  '--poll-interval',
  '--evidence-out',
]);

// Refused BY NAME, with the reason, rather than falling through to "unknown
// argument". An operator reaching for one of these has a mental model this tool
// must correct explicitly: there is no credential mode here, and a secret passed
// as an argument lands in shell history, in `ps` output for every user on the
// box, and — for anything forwarded to az — under ~/.azure on disk.
const REFUSED_CREDENTIAL_FLAGS = Object.freeze(
  new Map([
    ['--key', 'a key'],
    ['--device-key', 'a device key'],
    ['--primary-key', 'a device key'],
    ['--secondary-key', 'a device key'],
    ['--account-key', 'an account key'],
    ['--master-key', 'an account key'],
    ['--symmetric-key', 'a device key'],
    ['--connection-string', 'a connection string'],
    ['--login', 'a connection string'],
    ['--cs', 'a connection string'],
    ['--sas', 'a SAS token'],
    ['--sas-token', 'a SAS token'],
    ['--token', 'a token'],
    ['--password', 'a password'],
    ['--secret', 'a secret'],
    ['--certificate', 'a certificate'],
    ['--cert', 'a certificate'],
    ['--cert-file', 'a certificate'],
    ['--auth', 'an auth mode selector'],
  ])
);

// Refused for a different reason: these do not carry a secret, they make az
// PRINT one. Under verbosity az emits request signatures and full request
// bodies, and it persists invocations under ~/.azure regardless.
const REFUSED_VERBOSITY_FLAGS = Object.freeze(new Set(['--debug', '--verbose']));

function usageError(message) {
  return new FixtureError(EXIT.USAGE, message);
}

function positiveInteger(value, flag) {
  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw usageError(`${flag} must be a positive integer of milliseconds, got '${safe(value)}'`);
  }
  return n;
}

// Anything echoed back to the operator that came from OUTSIDE this file — an
// argument, a path, a name — goes through the scrubber first. HR1 applies on
// every path, and a rejected argument is a failure path.
const safe = (value, max = 120) =>
  scrubSecrets(typeof value === 'string' ? value : String(value)).slice(0, max);

export function parseArgs(argv) {
  const cfg = {
    hub: null,
    device: FIXTURE_DEVICE_ID,
    account: null,
    database: null,
    container: null,
    containerDefinition: null,
    timeoutMs: DEFAULT_CONFIRMATION_TIMEOUT_MS,
    pollIntervalMs: DEFAULT_POLL_INTERVAL_MS,
    evidenceOut: null,
    help: false,
  };

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    let flag = arg;
    let inlineValue = null;
    const eq = arg.indexOf('=');
    if (arg.startsWith('--') && eq !== -1) {
      flag = arg.slice(0, eq);
      inlineValue = arg.slice(eq + 1);
    }

    // Checked BEFORE the value is consumed, so a refused flag's value is never
    // read into a variable and can never reach a log line.
    const refusedKind = REFUSED_CREDENTIAL_FLAGS.get(flag);
    if (refusedKind !== undefined) {
      throw usageError(
        `${flag} is not accepted: this tool has no key, connection-string, SAS or certificate mode at all. ` +
          `'az iot device send-d2c-message' resolves the device key itself under your authenticated identity, and the Cosmos read-back is AAD-only. ` +
          `Supplying ${refusedKind} as an argument would put it in shell history and in 'ps' output for nothing. Run 'az login' instead. ` +
          '(The value you passed was not read and is not echoed here.)'
      );
    }
    if (REFUSED_VERBOSITY_FLAGS.has(flag)) {
      throw usageError(
        `${flag} is not accepted: it is an az verbosity flag, and under verbosity az prints request signatures and persists them under ~/.azure, outside anything this tool can scrub. This tool never passes it through.`
      );
    }

    let value = inlineValue;
    if (FLAGS_WITH_VALUES.has(flag) && value === null) {
      value = argv[i + 1];
      i += 1;
      // '-' is the stdin sentinel for --container-definition and is the one
      // value allowed to start with a dash.
      if (value === undefined || (value.startsWith('--') && value !== '-')) {
        throw usageError(`${flag} needs a value`);
      }
    }

    switch (flag) {
      case '--hub':
        cfg.hub = value;
        break;
      case '--device':
        cfg.device = value;
        break;
      case '--account':
        cfg.account = value;
        break;
      case '--database':
        cfg.database = value;
        break;
      case '--container':
        cfg.container = value;
        break;
      case '--container-definition':
        cfg.containerDefinition = value;
        break;
      case '--timeout':
        cfg.timeoutMs = positiveInteger(value, '--timeout');
        break;
      case '--poll-interval':
        cfg.pollIntervalMs = positiveInteger(value, '--poll-interval');
        break;
      case '--evidence-out':
        cfg.evidenceOut = value;
        break;
      case '--help':
      case '-h':
        cfg.help = true;
        break;
      default:
        throw usageError(`unknown argument '${safe(arg)}'`);
    }
  }
  return cfg;
}

// Names that go onto an az command line and into the evidence record. Refused
// rather than escaped: an Azure resource name is a short, boring token, and
// anything else here is either a typo or an attempt to smuggle a second
// argument into the child's argv.
const AZURE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;

function requireName(value, flag) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw usageError(`${flag} is required`);
  }
  if (!AZURE_NAME.test(value)) {
    throw usageError(
      `${flag} must be a plain Azure resource name (letters, digits, '.', '_', '-'), got '${safe(value)}'`
    );
  }
  return value;
}

export function requireComplete(cfg) {
  requireName(cfg.hub, '--hub');
  requireName(cfg.device, '--device');
  requireName(cfg.account, '--account');
  requireName(cfg.database, '--database');
  requireName(cfg.container, '--container');
  if (typeof cfg.containerDefinition !== 'string' || cfg.containerDefinition.trim() === '') {
    throw usageError(
      '--container-definition <path|-> is required: the partition key and the default_ttl are MEASURED from the live container, never assumed (HR4)'
    );
  }
  if (typeof cfg.evidenceOut !== 'string' || cfg.evidenceOut.trim() === '') {
    throw usageError(
      '--evidence-out <dir> is required: it names a DIRECTORY the tool writes a per-run, immutable artifact into. MG-53 and MG-54 read that artifact as a program input, and an unrecorded run leaves documents in the container that no record accounts for'
    );
  }
  return cfg;
}

export function endpointFor(account) {
  return `https://${account}.documents.azure.com:443/`;
}

// ---------------------------------------------------------------------------
// The az child process — the one credential boundary in the tool.
// ---------------------------------------------------------------------------

/**
 * The argv for one D2C send. Hub and device BY NAME ONLY; no credential of any
 * kind, and no verbosity flag. `--only-show-errors` and `--output none` keep the
 * child quiet: what az does not print cannot need scrubbing.
 */
export function buildSendArgv({ hub, device, message }) {
  return [
    'iot',
    'device',
    'send-d2c-message',
    '--hub-name',
    hub,
    '--device-id',
    device,
    '--data',
    JSON.stringify(message.body),
    '--properties',
    formatD2cProperties(message.systemProperties),
    '--only-show-errors',
    '--output',
    'none',
  ];
}

/**
 * The last gate before a child process exists.
 *
 * Belt and braces over buildSendArgv, on purpose: the argv is the one thing this
 * tool hands to a program that writes it to disk (~/.azure) and to `ps`, where
 * nothing downstream can redact it. So rather than trusting that the builder
 * stays correct, every element is checked here — a future edit that adds a
 * credential argument, or a verbosity flag, fails at this line instead of at a
 * review.
 *
 * Credential shape is judged by the tool's OWN scrubber: an element the scrubber
 * would rewrite is by definition credential-shaped, so the two can never drift
 * apart. The offending value is never echoed.
 */
export function assertArgvIsCredentialFree(argv) {
  argv.forEach((element, index) => {
    if (typeof element !== 'string') {
      throw usageError(`refusing to spawn az: argument ${index} is not a string`);
    }
    if (REFUSED_VERBOSITY_FLAGS.has(element)) {
      throw usageError(
        `refusing to spawn az: the argv carries ${element}, under which az prints request signatures and persists them under ~/.azure`
      );
    }
    if (REFUSED_CREDENTIAL_FLAGS.has(element)) {
      throw usageError(
        `refusing to spawn az: the argv carries ${element}, and this tool has no credential mode`
      );
    }
    if (scrubSecrets(element) !== element) {
      throw usageError(
        `refusing to spawn az: argument ${index} is credential-shaped and would be written to ~/.azure and to 'ps' where nothing can redact it. The value is not echoed.`
      );
    }
  });
  return argv;
}

/**
 * Spawn az with an ARGV ARRAY and no shell, so nothing here is ever parsed as a
 * command line. stdin is closed: this command needs none, and a child that can
 * prompt is a child that can hang a run.
 *
 * The child INHERITS the operator's environment, because az needs HOME, PATH
 * and AZURE_CONFIG_DIR to find the login this tool relies on instead of a
 * credential. Nothing is added to it: this process reads no environment
 * variable of its own (asserted in the source-posture tests), so there is
 * nothing here that could put a secret into a child that did not already have
 * it.
 *
 * Injected everywhere else in the tool; this is the only implementation that
 * touches a real process.
 */
export function realSpawn(command, argv, { timeoutMs = DEFAULT_SEND_TIMEOUT_MS } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, argv, {
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: timeoutMs,
      killSignal: 'SIGTERM',
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', chunk => {
      stdout += chunk;
    });
    child.stderr.on('data', chunk => {
      stderr += chunk;
    });
    child.on('error', reject);
    child.on('close', (code, signal) => {
      // A killed child has a null exit code. Reported as a distinct nonzero so
      // "az was killed at the bound" never reads as "az succeeded".
      resolve({ code: code === null ? 124 : code, signal: signal ?? null, stdout, stderr });
    });
  });
}

/**
 * Send every message in the run, in order, recording each attempt's fate in the
 * run LEDGER as it happens. Any nonzero az exit, or any failure to spawn at all,
 * aborts the run as SEND_FAILURE — a partially sent run is not quietly
 * continued, because the confirmation would then look for documents the sender
 * knows it never got to send and report the miss as the route's fault.
 *
 * THE LEDGER IS NOT OPTIONAL, and the ORDER around each spawn is the contract:
 * `request(id)` immediately BEFORE the attempt, then exactly one of `accept(id)`
 * / `markAmbiguous(id)` after it. There is no way to send a message this run
 * cannot afterwards account for, because the accounting happens first.
 *
 * A FAILED SEND IS AMBIGUOUS, NOT AN ABSENCE. `az` can exit nonzero AFTER IoT
 * Hub accepted the message — a failure on teardown, a killed process, a lost
 * response — so the message it failed on is recorded as of UNKNOWN acceptance.
 * Nothing here, in any message on any path, may tell the operator that nothing
 * was written: that is an error reported as a known absence, which is the exact
 * conflation MG-66 exists to prevent, reproduced on the write side.
 *
 * Ids are logged per message as they go, too: a run that dies mid-flight leaves
 * them in the operator's terminal even if the process is killed before it can
 * write anything. An id this tool caused to exist and did not record is the
 * condition that halts MG-53 — and it halts there indistinguishably from the
 * unknown writer that halt is looking for.
 *
 * The child's stdout is DISCARDED and its stderr is scrubbed before it reaches
 * any operator-facing line. Neither the raw argv nor the raw stderr is ever
 * echoed.
 *
 * @returns {Promise<string[]>} the ids az reported success for.
 */
export async function sendMessages({
  messages,
  hub,
  device,
  spawn: spawnFn,
  ledger,
  sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  log = defaultLog,
}) {
  if (!ledger || typeof ledger.request !== 'function') {
    throw usageError(
      'sendMessages needs the run ledger from createRunLedger(): a message may not be attempted before the attempt is recorded, or the run could send a document it cannot account for'
    );
  }

  const accepted = [];
  for (const message of messages) {
    const argv = assertArgvIsCredentialFree(buildSendArgv({ hub, device, message }));
    const id = message.body.id;
    // BEFORE the spawn. A process killed between here and the outcome leaves an
    // id the ledger resolves as ambiguous rather than as never-attempted.
    ledger.request(id);

    let outcome;
    try {
      outcome = await spawnFn(AZ_COMMAND, argv, { timeoutMs: sendTimeoutMs });
    } catch (err) {
      // Spawn itself failed — az is not on PATH, or the process could not be
      // created. Even here acceptance is recorded as UNKNOWN rather than as
      // "not sent": this tool cannot see the difference between a process that
      // never ran and one that ran and could not be reaped, and guessing the
      // convenient one is how an id goes unaccounted for.
      ledger.markAmbiguous(id);
      throw new FixtureError(
        EXIT.SEND_FAILURE,
        `failed to run '${AZ_COMMAND} iot device send-d2c-message' for device ${safe(device)} on hub ${safe(hub)} (message ${message.sequence} of ${messages.length}, id ${id}): ${describeError(err)}. Is the Azure CLI on PATH, with the azure-iot extension installed ('az extension add --name azure-iot')? Acceptance of this message is UNKNOWN and it is recorded as such.`
      );
    }

    if (outcome?.code !== 0) {
      ledger.markAmbiguous(id);
      const detail = scrubChildOutput(outcome?.stderr ?? '');
      throw new FixtureError(
        EXIT.SEND_FAILURE,
        `'${AZ_COMMAND} iot device send-d2c-message' exited ${outcome?.code} sending message ${message.sequence} of ${messages.length} (id ${id}) for device ${safe(device)} on hub ${safe(hub)}${outcome?.signal ? ` (signal ${safe(outcome.signal)})` : ''}` +
          `${detail ? `\n  az: ${detail.split('\n').join('\n  az: ')}` : ' (az produced no diagnostic output)'}` +
          `\n  az reporting failure does NOT establish that IoT Hub rejected the message — the CLI can fail after the hub took it — so this message's acceptance is UNKNOWN and it is recorded as of unknown acceptance, never as not written.`
      );
    }

    ledger.accept(id);
    accepted.push(id);
    // The id is on the line, not just the sequence number: this log is the last
    // record of a document that exists if the process dies here.
    log.info(
      `${TOOL_NAME}: sent message ${message.sequence}/${messages.length} (id ${id}) from ${device} to hub ${hub}`
    );
  }
  return accepted;
}

// ---------------------------------------------------------------------------
// The Cosmos read-back client — AAD only, constructed at the edge.
// ---------------------------------------------------------------------------

/**
 * The reader seam confirmArrival() is injected with, over the real SDK.
 *
 * AAD-ONLY BY CONSTRUCTION: there is no `key` and no `connectionString`
 * property anywhere in this function, and no branch that could introduce one.
 * The dev account runs local_authentication_enabled = false, so key auth could
 * not work; and a mode that cannot work but can leak is all cost.
 *
 * The two SDK modules load through injectable thunks for the same reason the
 * reader is injected into the core: it is the only way to assert what the auth
 * wiring hands to CosmosClient without an Azure account, and the dependency-free
 * CI tier installs neither package.
 */
export async function createRealReader({
  endpoint,
  database,
  container,
  loadCosmos = () => import('@azure/cosmos'),
  loadIdentity = () => import('@azure/identity'),
}) {
  let client;
  try {
    const { CosmosClient } = await loadCosmos();
    const { DefaultAzureCredential } = await loadIdentity();
    client = new CosmosClient({
      endpoint,
      aadCredentials: new DefaultAzureCredential(),
    });
  } catch (err) {
    // A credential that cannot be acquired at all is an AUTH failure, not a
    // crash and emphatically not an absence: an operator who has not run
    // `az login` must not be told the route failed to deliver.
    const code = classifyError(err);
    throw new FixtureError(
      code,
      `could not construct the AAD Cosmos reader for ${safe(endpoint)}: ${describeError(err)}` +
        (code === EXIT.AUTH
          ? " — run 'az login'. This says NOTHING about whether the route delivered."
          : '')
    );
  }
  return cosmosReader(client, { database, container });
}

/**
 * Adapt a Cosmos client to the reader seam: one parameterised item query, and
 * nothing else. The run id travels as a BOUND PARAMETER, never interpolated into
 * the query text, and the query text itself is a module constant in
 * fixture-core.
 *
 * An absent `partitionKey` IS the cross-partition sweep — the distinction
 * carries its own exit code upstream, so it is expressed in the request rather
 * than filtered afterwards.
 *
 * Exported separately from the client construction so the adaptation is testable
 * against the fake client with no SDK present.
 */
export function cosmosReader(client, { database, container }) {
  return {
    async queryDocuments({ query, parameters, partitionKey } = {}) {
      const options = {};
      if (partitionKey !== undefined) options.partitionKey = partitionKey;
      const response = await client
        .database(database)
        .container(container)
        .items.query({ query, parameters }, options)
        .fetchAll();
      // Returned verbatim, including a missing `resources`. A reader that
      // answers with something other than a list is UNREADABLE upstream, which
      // is a failure — substituting [] here would launder it into an absence.
      return response?.resources;
    },
  };
}

// ---------------------------------------------------------------------------
// The run.
// ---------------------------------------------------------------------------

async function readDefinitionText(source, { readFileFn, stdin }) {
  if (source === '-') {
    const chunks = [];
    for await (const chunk of stdin) chunks.push(chunk);
    return Buffer.concat(chunks.map(Buffer.from)).toString('utf8');
  }
  try {
    return await readFileFn(source, 'utf8');
  } catch (err) {
    throw new FixtureError(
      EXIT.CONTAINER_DEFINITION,
      `could not read the container definition at ${safe(source)}: ${err?.code ?? describeError(err)}. Produce it with 'az cosmosdb sql container show', or pass '-' to read it from stdin. No partition key and no TTL is ever assumed in its absence.`
    );
  }
}

/**
 * HR5's "not present before the run", asserted rather than assumed.
 *
 * A freshly minted uuid-based run id cannot already be in the container, so a
 * non-empty answer here means the read-back could not be trusted to identify
 * THIS run's documents — which is a correlation ambiguity and a stop condition,
 * not something to send into and hope. An auth or transport failure here aborts
 * before anything is written, which is the whole point of doing it first.
 */
export async function preflight({ reader, runId }) {
  let documents;
  try {
    documents = await reader.queryDocuments({
      query: CONFIRMATION_QUERY,
      parameters: [{ name: RUN_ID_PARAMETER, value: runId }],
    });
  } catch (err) {
    const code = classifyError(err);
    throw new FixtureError(
      code,
      code === EXIT.AUTH
        ? `the pre-send read of the destination container was refused: ${describeError(err)} — NOTHING WAS SENT. Cosmos data-plane access is not granted by control-plane RBAC; see --help for the account-scope Data Reader assignment. This says nothing about whether the route works.`
        : `the pre-send read of the destination container failed: ${describeError(err)} — NOTHING WAS SENT, rather than writing documents this run could not then confirm.`
    );
  }
  if (!Array.isArray(documents)) {
    throw new FixtureError(
      EXIT.AMBIGUOUS,
      'the pre-send read returned something other than a list of documents — unreadable is a failure, not an absence, and NOTHING WAS SENT'
    );
  }
  if (documents.length !== 0) {
    throw new FixtureError(
      EXIT.AMBIGUOUS,
      `the pre-send read already found ${documents.length} document(s) carrying this run's freshly minted correlator — a later read-back could not be attributed to this run, so NOTHING WAS SENT`
    );
  }
  return true;
}

/**
 * THE ONE EVIDENCE-EMISSION PATH. Every outcome that attempted a send arrives
 * here, and nothing else in this file writes a record.
 *
 * It is a single function rather than a call at each exit for the reason the
 * header gives: the defect this contract answers appeared five separate times on
 * five separate paths, and a per-path repair leaves the sixth path to be found
 * by whoever adds it. There is no per-outcome branch here — the ledger already
 * knows what the run knows, on every path, and this function does the same thing
 * with it every time.
 *
 * WHY A WRITE FAILURE TAKES THE EXIT CODE (EXIT.EVIDENCE_UNRECORDED) FROM THE
 * OUTCOME. Recording is not decoration on the result; it is what makes the run
 * accountable. An unrecorded document halts MG-53 whatever the confirmation
 * concluded, and MG-53 cannot tell it apart from the unknown writer that halt
 * exists to catch. So the write failure sets the code on EVERY path, including a
 * confirmed one and including an auth failure — and the confirmation's own
 * outcome and label are printed on the lines above, so the operator loses
 * nothing but the code they script against.
 *
 * BUILDING THE RECORD IS INSIDE THE GUARD, not before it. A record that cannot
 * be BUILT leaves the documents exactly as unaccounted for as one that cannot be
 * written, and buildEvidenceRecord refuses with EXIT.USAGE — which is the code
 * this function exists to keep away from a run that changed the live system.
 *
 * @returns {Promise<number>} `outcomeCode` if the record is on disk, otherwise
 *   EXIT.EVIDENCE_UNRECORDED.
 */
async function emitEvidence({
  ledger,
  snapshot,
  reservation,
  confirmation,
  definition,
  cfg,
  outcomeCode,
  log,
  now,
  fs,
}) {
  let record;
  try {
    record = buildEvidenceRecord({
      // The LEDGER, not a set of ids assembled here: it is snapshotted against
      // the confirmation inside the builder, so this call site cannot forget to
      // fold the read-back's observations in, and cannot narrow the four sets to
      // whichever one this path happened to have.
      ledger,
      confirmation,
      containerDefinition: definition,
      target: {
        hub: cfg.hub,
        account: cfg.account,
        database: cfg.database,
        container: cfg.container,
      },
      deviceId: cfg.device,
      now,
    });
    await writeEvidenceRecord(record, reservation, {
      ...(fs ? { fs } : {}),
    });
  } catch (err) {
    // Why the write failed, first — it is usually a missing directory or an
    // existing file this run refused to clobber, both of which the operator can
    // fix and re-run against.
    log.error(`${TOOL_NAME}: ${describeError(err)}`);
    const where = `${cfg.database}/${cfg.container} from run ${snapshot.runId}, marked ${SYNTHETIC_MARKER_FIELD}=${SYNTHETIC_MARKER}`;
    const observed = [...snapshot.observedIds];
    // Everything that may be there and was not read back. Accepted and ambiguous
    // alike: az saying "ok" is not an observation either, and the operator's
    // action for both is the same.
    const mayExist = mergeIds(snapshot.acceptedIds, snapshot.ambiguousIds).filter(
      id => !observed.includes(id)
    );
    log.error(
      `${TOOL_NAME}: EVIDENCE NOT RECORDED — ${observed.length + mayExist.length} document id(s) from this run are unrecorded`
    );
    if (observed.length) {
      log.error(
        `${TOOL_NAME}: ${observed.length} document(s) ARE in ${where}: ${observed.join(', ')}`
      );
    }
    if (mayExist.length) {
      // "MAY BE", never "were not written". Acceptance unknown is not absence.
      log.error(
        `${TOOL_NAME}: ${mayExist.length} document(s) MAY BE in ${where} (acceptance not established by a read-back): ${mayExist.join(', ')}`
      );
    }
    log.error(
      `${TOOL_NAME}: RECORD THESE IDS BY HAND against ${TICKET} before anything else — MG-53 halts on a source document its recorded set does not account for, and cannot tell one from an unknown writer`
    );
    log.error(
      `${TOOL_NAME}: the evidence for run ${snapshot.runId} could not be written to ${safe(reservation?.path ?? cfg.evidenceOut)} — this is NOT "nothing happened", and the outcome reported above (exit ${outcomeCode}, ${exitLabel(outcomeCode)}) stands as the diagnosis`
    );
    return EXIT.EVIDENCE_UNRECORDED;
  }
  // Outside the guard: the record is on disk by here, so a failure to FORMAT the
  // summary line is not an unrecorded run and must not be reported as one.
  log.info(`${TOOL_NAME}: ${describeEvidence(record, reservation.path)}`);
  return outcomeCode;
}

/**
 * The recorded reason for a run that aborted before any read-back.
 *
 * SYNTHESIZED FROM THE RUN'S OWN FACTS, never from the failure's message. The
 * operator-facing diagnosis may quote text the az CHILD produced, and however
 * carefully that is scrubbed it is still outside text: the evidence record's
 * credential guard is fail-closed and refuses a record carrying anything
 * credential-SHAPED, so embedding child output here would turn a diagnosable
 * send failure into an unrecorded run — the worse outcome of the two, and
 * exactly the one this contract exists to prevent. The full message is already
 * on the operator's screen; what the artifact needs is the accounting.
 */
function abortReason(snapshot, exitCode) {
  return (
    `the run aborted before any read-back: ${exitLabel(exitCode)} (exit ${exitCode}). ` +
    `${snapshot.requestedIds.length} message(s) attempted, ${snapshot.acceptedIds.length} accepted by IoT Hub, ` +
    `${snapshot.ambiguousIds.length} of UNKNOWN acceptance — az reporting failure does not establish that the hub rejected a message, ` +
    'so none of these ids may be read as evidence that nothing was written. No read-back was attempted, so nothing here observed a document. ' +
    'The operator-facing diagnosis is not embedded in this record: it can quote child-process output, and this artifact carries only what the run itself established.'
  );
}

/**
 * The run's single exit funnel: report the outcome, emit the evidence, choose
 * the code. Called exactly once, from main(), on every path.
 *
 * The reporting happens BEFORE the emission and independently of it, so the
 * diagnosis is on the operator's screen whatever the write does to the exit
 * code.
 *
 * IT DOES NOT DEFAULT TO SUCCESS, and that is the property this function is
 * most on the hook for. It used to open with
 * `confirmation ? confirmation.exitCode : (failure?.exitCode ?? EXIT.OK)`, so a
 * run carrying neither — a state the code did not anticipate, and therefore the
 * state it knows least about — exited 0. Exit 0 is this tool's ONE claim: a
 * specific, newly identified, marker-carrying document was read back out of the
 * destination container. A state nobody predicted is the last one permitted to
 * make it. resolveOutcomeCode() now owns the decision and inverts the default;
 * this function only prints what it says and re-checks the invariant on the way
 * out.
 *
 * Exported for the tests that hand it states main() cannot be made to produce.
 */
export async function settleRun({
  cfg,
  definition,
  ledger,
  reservation,
  confirmation,
  failure,
  device,
  hub,
  log,
  now,
  fs,
}) {
  try {
    if (confirmation) {
      const report = line => (confirmation.confirmed ? log.info(line) : log.error(line));
      report(`${TOOL_NAME}: ${describeConfirmation(confirmation)}`);
      if (!confirmation.confirmed) report(`${TOOL_NAME}: ${confirmation.reason}`);
    }
    if (failure) log.error(`${TOOL_NAME}: ${failure.message}`);

    // A run that never minted a ledger never attempted anything: a usage refusal,
    // an unmeasurable container, a refused pre-send read. It is the ONLY case that
    // may exit without a record, and it is the only case where "nothing was
    // written" is a fact rather than a guess.
    const snapshot = ledger ? ledger.snapshot({ confirmation }) : null;

    // THE ONLY PLACE A CODE IS CHOSEN, and it is fail-closed by construction:
    // exit 0 requires a confirmation that both carries EXIT.OK and says
    // confirmed:true, and every other shape — including any this file was not
    // written to produce — comes back nonzero with a sentence naming what was
    // found. There is no `?? EXIT.OK` here any more, and there is not one in
    // resolveOutcomeCode either.
    const outcome = resolveOutcomeCode({ confirmation, failure });
    let exitCode = outcome.exitCode;
    if (outcome.unanticipated) {
      // Printed rather than swallowed: an unanticipated state is a defect in this
      // tool, and an operator who sees only the code cannot report it.
      log.error(`${TOOL_NAME}: ${outcome.reason}`);
    }

    // USAGE means "bad arguments, nothing live happened". A run that attempted a
    // send cannot honestly report it whatever went wrong afterwards, so the code
    // becomes the ambiguity it actually is. The original message is already on the
    // operator's screen, so the diagnosis is not lost — only the misleading code.
    if (snapshot?.attempted && exitCode === EXIT.USAGE) {
      log.error(
        `${TOOL_NAME}: reporting exit ${EXIT.AMBIGUOUS} (${exitLabel(EXIT.AMBIGUOUS)}) rather than a usage error — this run had already attempted a send, and "bad arguments, nothing happened" would be false`
      );
      exitCode = EXIT.AMBIGUOUS;
    }

    if (snapshot && mustEmitEvidence(snapshot)) {
      log.info(`${TOOL_NAME}: run ${snapshot.runId} — ${describeIdSets(snapshot)}`);
      if (!confirmation) {
        log.error(
          `${TOOL_NAME}: recording every id this run attempted before exiting — a document this tool caused to exist and did not record is what halts MG-53, and halts it indistinguishably from an unknown writer`
        );
      }
      exitCode = await emitEvidence({
        ledger,
        snapshot,
        reservation,
        // A run that never reached the read-back still has a recordable shape. Its
        // observed ids come from the snapshot rather than from nothing, so a path
        // that DID observe documents and then aborted keeps them.
        confirmation:
          confirmation ??
          abortedConfirmation({
            runId: snapshot.runId,
            exitCode,
            reason: abortReason(snapshot, exitCode),
            observedIds: [...snapshot.observedIds],
            partitionValue: cfg.device,
            partitionKeyField: definition.partitionKeyField,
            timeoutMs: cfg.timeoutMs,
            pollIntervalMs: cfg.pollIntervalMs,
          }),
        definition,
        cfg,
        outcomeCode: exitCode,
        log,
        now,
        fs,
      });
    }

    // THE LAST LINE, AND DELIBERATELY REDUNDANT WITH resolveOutcomeCode ABOVE.
    // Between the resolution and this return sits the evidence emission, which
    // returns a code of its own, and whatever a later edit adds beside it. Nothing
    // in that gap may manufacture a 0, and re-asserting the invariant here is what
    // makes that structural rather than a property of the control flow as it
    // happens to be written today. If this ever fires, resolveOutcomeCode and the
    // path between them disagree — which is itself an unanticipated state.
    if (exitCode === EXIT.OK && confirmation?.confirmed !== true) {
      log.error(
        `${TOOL_NAME}: refusing to exit 0 — the settlement arrived at success without a confirmation establishing it, and exit 0 states that a specific, newly identified document was read back out of the destination container. Exiting ${UNANTICIPATED_OUTCOME_CODE} (${exitLabel(UNANTICIPATED_OUTCOME_CODE)}) instead.`
      );
      exitCode = UNANTICIPATED_OUTCOME_CODE;
    }

    if (exitCode === EXIT.OK) {
      log.info(
        `${TOOL_NAME}: CONFIRMED — ${confirmation.observedCount} synthetic document(s) sent from ${device} via hub ${hub} were read back out of ${cfg.database}/${cfg.container}`
      );
      return exitCode;
    }
    // Names the device, the hub, the outcome and the exit label. Never a secret,
    // on any path: every fragment here is either built from scrubbed input or
    // produced by a sibling module under the same obligation.
    log.error(
      `${TOOL_NAME}: device ${device} on hub ${hub} — exit ${exitCode} (${exitLabel(exitCode)})`
    );
    return exitCode;
  } finally {
    // Release the reservation's placeholder — but ONLY if it is still the empty
    // file the reservation created. A published record is non-empty and is left
    // untouched, so this is safe on EVERY path: the confirmed run keeps its
    // record, while a run that reserved and then wrote nothing (a refused
    // pre-send read, or a settlement whose logging threw before the write) leaves
    // no zero-byte file a consumer could mistake for an empty evidence record.
    // Best-effort, and never changes the exit code.
    if (reservation) {
      await releaseReservation(reservation, fs ? { fs } : {}).catch(() => {});
    }
  }
}

/**
 * Emit a line, and never throw doing it.
 *
 * Used ONLY by the last-resort handler below, whose whole job is to survive a
 * broken reporting step — and the most likely way that step breaks is the log
 * itself. `node send-fixture.mjs ... | head -1` closes stdout under a running
 * process and the next write raises EPIPE; a handler that reported that failure
 * through the same channel would rethrow from inside its own recovery.
 */
function safeLog(log, level, line) {
  try {
    log?.[level]?.(line);
  } catch {
    // Deliberately swallowed. There is no third channel to report a broken
    // reporting channel on, and the exit CODE — which is what an operator
    // scripts against and the only thing that survives a closed stdout — is
    // still chosen correctly below.
  }
}

/**
 * The exit code for a run whose SETTLEMENT threw — the report, the record or the
 * final line, after the live work was already done.
 *
 * WHY THIS EXISTS. settleRun() used to be called outside main()'s try/catch, so
 * a throw there escaped as an unhandled rejection and node exited 1. Exit 1 is
 * USAGE: "bad arguments, nothing live happened". Telling an operator that while
 * three synthetic documents sit in the source container is the single worst
 * answer this tool can give — it is the exact sentence MG-53 halts on, and it
 * would send them looking at their command line instead of at the container.
 * That path is not hypothetical: emitEvidence() logs its summary line OUTSIDE
 * its own guard (deliberately — a formatting failure is not an unrecorded run),
 * and a closed stdout throws there on a fully successful run.
 *
 * WHAT IT CHOOSES, and why fail-closed points at 10 rather than at the outcome:
 *   - The run ATTEMPTED a send → EXIT.EVIDENCE_UNRECORDED. The settlement did
 *     not complete, so whether the artifact reached disk is UNESTABLISHED, and
 *     an unestablished recording is treated as no recording. The operator's
 *     action is the one that code already names: copy the ids off stderr, then
 *     check whether the artifact exists. Over-reporting an unrecorded run costs
 *     a look at a file; under-reporting one loses the ids.
 *   - The run attempted NOTHING → whatever the run had already concluded
 *     (a usage refusal, an unmeasurable container, a refused pre-send read).
 *     Exit 1 is honest there: nothing live happened, which is what it means. A
 *     concluded OK is the one code that cannot stand, since a settlement that
 *     threw confirmed nothing.
 */
function lastResortExit({
  err,
  ledger,
  reservation,
  confirmation,
  failure,
  cfg,
  device,
  hub,
  log,
}) {
  // Fail-closed on the snapshot too: if the ledger cannot say what the run
  // attempted, a minted ledger is assumed to mean a send was.
  let attempted = ledger !== null;
  let ids = [];
  try {
    const snapshot = ledger ? ledger.snapshot({ confirmation }) : null;
    if (snapshot) {
      attempted = Boolean(snapshot.attempted);
      // mergeIds is binary; nested so the union is the whole accountable set.
      ids = mergeIds(mergeIds(snapshot.observedIds, snapshot.acceptedIds), snapshot.ambiguousIds);
    }
  } catch {
    // Keep `attempted` as the pessimistic default set above.
  }

  const concluded = confirmation?.exitCode ?? failure?.exitCode ?? EXIT.AMBIGUOUS;
  const exitCode = attempted
    ? EXIT.EVIDENCE_UNRECORDED
    : concluded === EXIT.OK
      ? EXIT.AMBIGUOUS
      : concluded;

  // Even the description is defensive: this handler is the last thing between a
  // live send and the exit code, and it may not fail to produce one because
  // formatting a diagnosis went wrong.
  let why = 'unknown error';
  try {
    why = describeError(err);
  } catch {
    /* the diagnosis is worth less than the code, and the code is chosen above */
  }
  safeLog(
    log,
    'error',
    `${TOOL_NAME}: the run could not be settled — ${why}. Reporting the outcome is what failed, not the send.`
  );
  if (attempted) {
    safeLog(
      log,
      'error',
      `${TOOL_NAME}: ${ids.length} document id(s) from this run ARE or MAY BE in ${cfg ? `${cfg.database}/${cfg.container}` : 'the destination container'}, marked ${SYNTHETIC_MARKER_FIELD}=${SYNTHETIC_MARKER}${ids.length ? `: ${ids.join(', ')}` : ''}`
    );
    safeLog(
      log,
      'error',
      `${TOOL_NAME}: RECORD THESE IDS BY HAND against ${TICKET}, then check whether ${reservation?.path ? safe(reservation.path) : cfg?.evidenceOut ? `the run's file under ${safe(cfg.evidenceOut)}` : 'the evidence file'} exists — the settlement did not finish, so whether it was written is UNESTABLISHED and is treated here as unwritten. This is NOT "nothing happened".`
    );
  }
  safeLog(
    log,
    'error',
    `${TOOL_NAME}: device ${device} on hub ${hub} — exit ${exitCode} (${exitLabel(exitCode)})`
  );
  return exitCode;
}

/**
 * Wire the whole flow. Every seam a test needs is a parameter: the spawn, the
 * reader construction, the clock, the uuid source, the sleep and the log. The
 * defaults are the only thing the CLI entry point passes.
 *
 * IT DOES NOT THROW. Every path — including the settlement that reports and
 * records the run — is inside a guard, because the one code this tool must never
 * reach by accident (1, "nothing live happened") is exactly the code an
 * unhandled rejection produces.
 *
 * @returns {Promise<number>} the process exit code.
 */
export async function main({
  argv,
  createReader = createRealReader,
  spawn: spawnFn = realSpawn,
  log = defaultLog,
  readFileFn = readFile,
  stdin = process.stdin,
  now = Date.now,
  sleep,
  uuid,
  fs,
} = {}) {
  let device = '(unspecified)';
  let hub = '(unspecified)';
  // Everything settleRun() needs, assigned as the run establishes it. `ledger`
  // is the pivot: non-null means a run id was minted and a send may have been
  // attempted, so an evidence record is owed.
  let cfg = null;
  let definition = null;
  let ledger = null;
  let reservation = null;
  let confirmation = null;
  let failure = null;

  try {
    cfg = parseArgs(argv ?? []);
    if (cfg.help) {
      log.info(USAGE);
      return EXIT.OK;
    }
    requireComplete(cfg);
    device = cfg.device;
    hub = cfg.hub;

    // ---- 1. Measure the container. Nothing is assumed. -------------------
    const definitionText = await readDefinitionText(cfg.containerDefinition, {
      readFileFn,
      stdin,
    });
    definition = parseContainerDefinition(definitionText, {
      expectedContainer: cfg.container,
    });
    log.info(`${TOOL_NAME}: measured ${describeContainerDefinition(definition)}`);
    if (definition.ttlDriftFinding) {
      // A finding, surfaced and recorded — not silently adopted, and not fatal.
      log.error(`${TOOL_NAME}: FINDING — ${definition.ttlDriftFinding.message}`);
    }

    // ---- 2. Mint the run and RESERVE its destination BEFORE anything live. -
    // Every run exclusively owns one destination: --evidence-out is a directory,
    // and the file name is derived from this run's unique id, so no two runs can
    // name the same file and there is nothing to coordinate. The reservation
    // atomically claims that file — proving the directory usable and the
    // publication primitive available — BEFORE a single message is sent. A reused
    // destination fails here, usage-class, while nothing is live; learning it
    // AFTER the send would leave documents in the container this tool then
    // refused to record, the unrecorded-document condition MG-53 halts on and
    // cannot tell apart from an unknown writer.
    const runId = uuid ? newRunId(uuid) : newRunId();
    reservation = await reserveEvidenceDestination(cfg.evidenceOut, runId, fs ? { fs } : {});
    log.info(`${TOOL_NAME}: ${describeReservation(reservation)}`);

    // ---- 3. The run's LEDGER and the bodies. ----------------------------
    // The ledger is created before anything can be attempted, and is what makes
    // the evidence obligation structural rather than remembered: from here on,
    // every exit passes through settleRun() and settleRun() writes a record for
    // any run that attempted a send into the destination reserved above.
    ledger = createRunLedger({ runId });
    const messages = buildFixtureMessages({
      runId,
      partitionKeyField: definition.partitionKeyField,
      deviceId: cfg.device,
      now,
    });
    log.info(
      `${TOOL_NAME}: run ${runId} — ${messages.length} message(s) marked ${SYNTHETIC_MARKER_FIELD}=${SYNTHETIC_MARKER}, partition ${definition.partitionKeyPath}=${cfg.device}`
    );

    // ---- 4. Prove the read path BEFORE writing anything. ------------------
    const reader = await createReader({
      endpoint: endpointFor(cfg.account),
      database: cfg.database,
      container: cfg.container,
    });
    await preflight({ reader, runId });
    log.info(
      `${TOOL_NAME}: pre-send read confirms no document carries run ${runId} — anything found after this is newly identified`
    );

    // ---- 5. Send. ---------------------------------------------------------
    // No try/catch and no per-path recording here. A send that aborts part-way
    // has already told the ledger which ids it attempted and what became of
    // each, and settleRun() below writes the record for ANY run that attempted
    // one. That is the contract: this call site cannot forget, because it has
    // nothing to remember.
    await sendMessages({
      messages,
      hub: cfg.hub,
      device: cfg.device,
      spawn: spawnFn,
      ledger,
      log,
    });

    // ---- 6. Confirm, within an explicit reported bound. -------------------
    confirmation = await confirmArrival({
      reader,
      runId,
      partitionValue: cfg.device,
      partitionKeyField: definition.partitionKeyField,
      timeoutMs: cfg.timeoutMs,
      pollIntervalMs: cfg.pollIntervalMs,
      now,
      ...(sleep ? { sleep } : {}),
    });
  } catch (err) {
    failure =
      err instanceof FixtureError ? err : new FixtureError(classifyError(err), describeError(err));
  }

  // ---- 7. One exit funnel: report, record, choose the code. ---------------
  // Reached on EVERY outcome, including the ones that threw. Nothing above this
  // line returns except --help, which cannot have attempted a send.
  //
  // INSIDE ITS OWN GUARD, and that is the point rather than a precaution. The
  // settlement runs AFTER the live effect — after documents may already be in
  // the source container — so a throw here escaping the function would surface
  // as an unhandled rejection and exit 1, the code that means "nothing live
  // happened". No path after a send may produce that code.
  try {
    // Nothing is patched up here. A run holding neither a confirmation nor a
    // failure used to be repaired at this call site, which left settleRun's own
    // `?? EXIT.OK` default in place underneath — correct only for as long as
    // this one guard covered every way of reaching it, and it covered only the
    // case where a ledger existed. The funnel is fail-closed itself now, so an
    // unanticipated state is refused where the code is chosen rather than
    // wherever someone thought to look for it.
    //
    // Awaited, not returned: a returned promise settles outside this try and
    // would take its rejection with it.
    return await settleRun({
      cfg,
      definition,
      ledger,
      reservation,
      confirmation,
      failure,
      device,
      hub,
      log,
      now,
      fs,
    });
  } catch (err) {
    return lastResortExit({
      err,
      ledger,
      reservation,
      confirmation,
      failure,
      cfg,
      device,
      hub,
      log,
    });
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  // main() is written not to throw, and this catch is what makes that a property
  // of the ENTRY POINT rather than a promise about main()'s internals: an
  // unhandled rejection here exits 1, and 1 means "bad arguments, nothing live
  // happened". A future edit that grows a throwing path lands on AMBIGUOUS —
  // "this run established nothing" — which is never a claim that nothing ran.
  try {
    const code = await main({ argv: process.argv.slice(2) });
    process.exitCode = Number.isInteger(code) ? code : EXIT.AMBIGUOUS;
  } catch (err) {
    process.exitCode = EXIT.AMBIGUOUS;
    safeLog(defaultLog, 'error', `${TOOL_NAME}: the run ended abnormally — ${describeError(err)}`);
  }
}
