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
// EXIT CODES (fixture-core owns the vocabulary; every class is distinct):
//   0 confirmed-in-cosmos          5 transport abort
//   1 usage error                  6 synthetic marker violation
//   2 send failure                 7 correlation ambiguity
//   3 confirmation timeout         8 container definition refusal
//   4 auth failure                 9 delivered, unexpected partition

import { spawn } from 'node:child_process';
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';

import {
  DECLARED_DEFAULT_TTL_SECONDS,
  describeContainerDefinition,
  parseContainerDefinition,
} from './container-definition.mjs';
import { buildEvidenceRecord, describeEvidence, writeEvidenceRecord } from './evidence.mjs';
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
  buildFixtureMessages,
  classifyError,
  confirmArrival,
  defaultLog,
  describeConfirmation,
  describeError,
  exitLabel,
  formatD2cProperties,
  newRunId,
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
                   --container-definition <path|-> --evidence-out <path>
                   [--device <id>] [--timeout <ms>] [--poll-interval <ms>] [--overwrite]

WHAT IT DOES, IN ORDER
  1. Measures the destination container's partition key path and its ACTUAL
     default_ttl from the --container-definition document. Nothing is assumed:
     a document missing either is refused (exit 8), never defaulted.
  2. Reads the destination container ONCE, before sending, and requires this
     run's id to be absent. That is what makes the proof a NEWLY identified
     document, and it surfaces a missing data-plane role assignment BEFORE any
     document is written that could not then be confirmed.
  3. Sends ${MESSAGES_PER_RUN} D2C messages via 'az iot device send-d2c-message', each
     carrying the ${SYNTHETIC_MARKER_FIELD}=${SYNTHETIC_MARKER} marker and this
     run's unique correlator, and each declaring JSON content type and utf-8
     encoding (without those the hub writes an opaque payload, not a queryable
     JSON document).
  4. Polls the container within an explicit, reported wait bound until the full
     set is read back. Anything less is a failure with its own exit code.
  5. Writes the machine-readable evidence artifact MG-53 and MG-54 consume.

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
  --evidence-out <path>        Required. One JSON document carrying the observed
                               document ids and their count, the marker, the run
                               id, the partition key path and value, the MEASURED
                               default_ttl with the declared value and any drift,
                               the wait bound used, the observed arrival delay and
                               the run/expiry instants. Refuses to overwrite an
                               existing file unless --overwrite is passed: that
                               file records an earlier run whose documents are
                               still in the container.
  --overwrite                  Replace an existing --evidence-out file.

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
             Subscription Owner alone gets a 403 here. Grant yourself the
             built-in Data Reader at ACCOUNT scope, and REMOVE it afterwards:

               az cosmosdb sql role assignment create \\
                 --account-name <account> -g <resource-group> \\
                 --role-definition-id 00000000-0000-0000-0000-000000000001 \\
                 --principal-id "$(az ad signed-in-user show --query id -o tsv)" \\
                 --scope "/"

             Assignments take a minute or two to propagate. A 401/403 exits ${EXIT.AUTH}
             immediately and is NEVER retried or reported as a timeout or an
             absence — it says nothing about whether the route delivered.

EXIT CODES
  0 confirmed-in-cosmos       5 transport abort
  1 usage error               6 synthetic marker violation
  2 send failure              7 correlation ambiguity
  3 confirmation timeout      8 container definition refusal
  4 auth failure              9 delivered, unexpected partition

  Exit 0 means one thing: ${MESSAGES_PER_RUN} marker-carrying, run-correlated documents were
  READ BACK OUT of ${'<container>'} and the evidence recording them was written.
  Absence of an error is never success.
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
    overwrite: false,
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
      case '--overwrite':
        cfg.overwrite = true;
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
      '--evidence-out <path> is required: MG-53 and MG-54 read this artifact as a program input, and an unrecorded run leaves documents in the container that no record accounts for'
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
 * Send every message in the run, in order. Any nonzero az exit, or any failure
 * to spawn at all, aborts the run as SEND_FAILURE — a partially sent run is not
 * quietly continued, because the confirmation would then look for documents the
 * sender knows were never sent and report the miss as the route's fault.
 *
 * The child's stdout is DISCARDED and its stderr is scrubbed before it reaches
 * any operator-facing line. Neither the raw argv nor the raw stderr is ever
 * echoed.
 */
export async function sendMessages({
  messages,
  hub,
  device,
  spawn: spawnFn,
  sendTimeoutMs = DEFAULT_SEND_TIMEOUT_MS,
  log = defaultLog,
}) {
  const sentIds = [];
  for (const message of messages) {
    const argv = assertArgvIsCredentialFree(buildSendArgv({ hub, device, message }));
    let outcome;
    try {
      outcome = await spawnFn(AZ_COMMAND, argv, { timeoutMs: sendTimeoutMs });
    } catch (err) {
      // Spawn itself failed — az is not on PATH, or the process could not be
      // created. Named as a send failure, never as an absence.
      throw new FixtureError(
        EXIT.SEND_FAILURE,
        `failed to run '${AZ_COMMAND} iot device send-d2c-message' for device ${safe(device)} on hub ${safe(hub)} (message ${message.sequence} of ${messages.length}): ${describeError(err)}. Is the Azure CLI on PATH, with the azure-iot extension installed ('az extension add --name azure-iot')?`
      );
    }

    if (outcome?.code !== 0) {
      const detail = scrubChildOutput(outcome?.stderr ?? '');
      throw new FixtureError(
        EXIT.SEND_FAILURE,
        `'${AZ_COMMAND} iot device send-d2c-message' exited ${outcome?.code} sending message ${message.sequence} of ${messages.length} for device ${safe(device)} on hub ${safe(hub)}${outcome?.signal ? ` (signal ${safe(outcome.signal)})` : ''}` +
          `${detail ? `\n  az: ${detail.split('\n').join('\n  az: ')}` : ' (az produced no diagnostic output)'}`
      );
    }
    sentIds.push(message.body.id);
    log.info(
      `${TOOL_NAME}: sent message ${message.sequence}/${messages.length} from ${device} to hub ${hub}`
    );
  }
  return sentIds;
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
 * Wire the whole flow. Every seam a test needs is a parameter: the spawn, the
 * reader construction, the clock, the uuid source, the sleep and the log. The
 * defaults are the only thing the CLI entry point passes.
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
  try {
    const cfg = parseArgs(argv ?? []);
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
    const definition = parseContainerDefinition(definitionText, {
      expectedContainer: cfg.container,
    });
    log.info(`${TOOL_NAME}: measured ${describeContainerDefinition(definition)}`);
    if (definition.ttlDriftFinding) {
      // A finding, surfaced and recorded — not silently adopted, and not fatal.
      log.error(`${TOOL_NAME}: FINDING — ${definition.ttlDriftFinding.message}`);
    }

    // ---- 2. Mint the run and build the bodies. ---------------------------
    const runId = uuid ? newRunId(uuid) : newRunId();
    const messages = buildFixtureMessages({
      runId,
      partitionKeyField: definition.partitionKeyField,
      deviceId: cfg.device,
      now,
    });
    log.info(
      `${TOOL_NAME}: run ${runId} — ${messages.length} message(s) marked ${SYNTHETIC_MARKER_FIELD}=${SYNTHETIC_MARKER}, partition ${definition.partitionKeyPath}=${cfg.device}`
    );

    // ---- 3. Prove the read path BEFORE writing anything. ------------------
    const reader = await createReader({
      endpoint: endpointFor(cfg.account),
      database: cfg.database,
      container: cfg.container,
    });
    await preflight({ reader, runId });
    log.info(
      `${TOOL_NAME}: pre-send read confirms no document carries run ${runId} — anything found after this is newly identified`
    );

    // ---- 4. Send. ---------------------------------------------------------
    const requestedIds = await sendMessages({
      messages,
      hub: cfg.hub,
      device: cfg.device,
      spawn: spawnFn,
      log,
    });

    // ---- 5. Confirm, within an explicit reported bound. -------------------
    const confirmation = await confirmArrival({
      reader,
      runId,
      partitionValue: cfg.device,
      partitionKeyField: definition.partitionKeyField,
      timeoutMs: cfg.timeoutMs,
      pollIntervalMs: cfg.pollIntervalMs,
      now,
      ...(sleep ? { sleep } : {}),
    });
    // Bound as a closure rather than lifted off `log`, so a caller whose logger
    // is a method on an object still gets its own receiver.
    const report = line => (confirmation.confirmed ? log.info(line) : log.error(line));
    report(`${TOOL_NAME}: ${describeConfirmation(confirmation)}`);
    if (!confirmation.confirmed) {
      report(`${TOOL_NAME}: ${confirmation.reason}`);
    }

    // ---- 6. Record what was observed, confirmed or not. -------------------
    // The record is written on FAILURE paths too, and says so in its own
    // findings: a run that sent documents it could not confirm has left them in
    // the container, and MG-53 halts on a document no record accounts for. What
    // it never does is claim a success the confirmation did not conclude —
    // buildEvidenceRecord refuses to build a confirmed record from a nonzero
    // result.
    const record = buildEvidenceRecord({
      confirmation,
      containerDefinition: definition,
      requestedIds,
      target: {
        hub: cfg.hub,
        account: cfg.account,
        database: cfg.database,
        container: cfg.container,
      },
      deviceId: cfg.device,
      now,
    });
    try {
      await writeEvidenceRecord(record, cfg.evidenceOut, {
        overwrite: cfg.overwrite,
        ...(fs ? { fs } : {}),
      });
      log.info(`${TOOL_NAME}: ${describeEvidence(record, cfg.evidenceOut)}`);
    } catch (err) {
      // A confirmed run whose evidence could not be written is NOT a success:
      // the documents are in the container and nothing records them, which is
      // exactly the condition that halts MG-53. So it exits nonzero — and prints
      // the ids, so the operator can record them by hand. On an already-failing
      // run the confirmation's own code is the more informative one and wins.
      log.error(`${TOOL_NAME}: ${describeError(err)}`);
      if (confirmation.confirmed) {
        log.error(
          `${TOOL_NAME}: the run WAS confirmed but no evidence was recorded — run ${runId}, ${confirmation.observedCount} document(s): ${confirmation.observedIds.join(', ')}`
        );
        throw err instanceof FixtureError ? err : usageError(describeError(err));
      }
    }

    if (confirmation.confirmed) {
      log.info(
        `${TOOL_NAME}: CONFIRMED — ${confirmation.observedCount} synthetic document(s) sent from ${cfg.device} via hub ${cfg.hub} were read back out of ${cfg.database}/${cfg.container}`
      );
    }
    return confirmation.exitCode;
  } catch (err) {
    const error =
      err instanceof FixtureError ? err : new FixtureError(classifyError(err), describeError(err));
    // Names the device, the hub, the outcome and the exit label. Never a secret,
    // on any path: `error.message` is either built here from scrubbed fragments
    // or produced by a sibling module under the same obligation.
    log.error(`${TOOL_NAME}: ${error.message}`);
    log.error(
      `${TOOL_NAME}: device ${device} on hub ${hub} — exit ${error.exitCode} (${exitLabel(error.exitCode)})`
    );
    return error.exitCode;
  }
}

const invokedDirectly = process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (invokedDirectly) {
  process.exitCode = await main({ argv: process.argv.slice(2) });
}
