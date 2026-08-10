// MeatGeek — V1 Cosmos DB export core (MG-48).
//
// This module gates a PERMANENT deletion: the V1 Cosmos account is destroyed
// once an export of it exists, and Continuous backup dies with the account. So
// the failure this code is built to refuse is not "the export crashed" — it is
// "the export exited 0 holding 90 of 100 documents". Every path below is
// therefore fail-CLOSED: a 429 with retries exhausted, a transport error
// mid-pagination, or a count that does not reconcile ABORTS the run with a
// distinct non-zero exit code. A container is never skipped, never partially
// accepted, and a page is never dropped to keep going.
//
// The Cosmos client is injected rather than constructed here. That seam is what
// makes the failure paths — which are the product — testable without Azure.
//
// READ-ONLY: no method on the injected client that creates, replaces, upserts,
// patches or deletes anything is called anywhere in this file. export-core.test.mjs
// asserts that mechanically against the source text.

import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import path from 'node:path';

export const TOOL_NAME = 'cosmos-export';
export const TOOL_VERSION = '1.0.0';
export const MANIFEST_FILENAME = 'manifest.json';
export const PARTIAL_SUFFIX = '.partial';

// The operator scripts around these, so they are part of the contract.
export const EXIT = {
  OK: 0,
  USAGE: 1,
  RECONCILE: 2,
  THROTTLED: 3,
  AUTH: 4,
  TRANSPORT: 5,
};

const EXIT_LABELS = {
  [EXIT.OK]: 'verified-complete',
  [EXIT.USAGE]: 'usage error',
  [EXIT.RECONCILE]: 'reconciliation failure',
  [EXIT.THROTTLED]: 'throttling abort',
  [EXIT.AUTH]: 'auth failure',
  [EXIT.TRANSPORT]: 'transport abort',
};

export function exitLabel(code) {
  return EXIT_LABELS[code] ?? 'unknown';
}

export class ExportError extends Error {
  constructor(exitCode, message) {
    super(message);
    this.name = 'ExportError';
    this.exitCode = exitCode;
  }
}

export const defaultLog = {
  info: line => process.stdout.write(`${line}\n`),
  error: line => process.stderr.write(`${line}\n`),
};

// Anything bracket-shaped in an SDK error message could be a document the
// service echoed back. This is real user data (cooks, sessions, devices), so it
// is replaced wholesale rather than trusted — an over-redacted diagnostic is a
// cost worth paying, a leaked document is not.
const BRACKETED = /[{[][\s\S]*[}\]]/g;

// Bracket-shape is only half the problem. An SDK error can carry a credential
// inline and unbracketed — an AccountKey lifted out of a connection string, a
// bearer token, a SAS signature — and that text goes straight to the operator's
// terminal and whatever is capturing it. So secrets are matched by SHAPE rather
// than by punctuation, and the value is replaced whole: never a prefix, never a
// length, never a hash, because each of those is still a fact about the secret.
//
// There is deliberately NO exemption list. Benign Cosmos key names like
// `partitionKey` used to be exempted so a common diagnostic stayed readable,
// and that exemption was the only thing in this scrubber that could decide NOT
// to redact — which made it the only thing worth attacking. It was: a quote
// inside `AccountKey"partitionKey=` reset where the key pattern began matching,
// the captured key became the exempt suffix, and the secret was emitted
// verbatim. Every repair for that shape ends in a rule about which characters
// delimit a key token, and every such rule is a character class an attacker
// gets to write into. So the exemption is gone and a credential-shaped key
// ALWAYS redacts. `partitionKey=deviceId` reads `partitionKey=[redacted]`; that
// is a diagnostic-readability cost, paid once, to delete the whole defect class.

// The key half of a credential pair, and ONLY the key half: optionally quoted,
// separated by '=' or ':' because the same field arrives as a connection-string
// fragment and as JSON. The opening and closing quotes are matched
// independently rather than as a backreference, so a malformed `"AccountKey':`
// is still recognised as a credential rather than falling through unmatched.
const CREDENTIAL_KEY =
  /(?<![\w-])(["']?)([\w-]*(?:key|token|secret|password|credential|sig)[\w-]*)(["']?)(\s*[=:]\s*)/gi;

const SECRET_PATTERNS = [
  [/\bBearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]'],
  // A JWT: three base64url segments. Long enough per segment that dotted host
  // names and namespaced identifiers do not match.
  [/\b[\w-]{10,}\.[\w-]{10,}\.[\w-]{10,}\b/g, '[redacted]'],
  // Connection-string / SAS fields, value running to whatever delimits it.
  [/\b(AccountEndpoint|sv)\s*=\s*[^;&\s]*/gi, '$1=[redacted]'],
];

// A credential-shaped key name's value is not parsed — it is consumed to the
// end of the line and replaced whole. Deciding where a quoted value ENDS is
// what leaked twice: mismatched, escaped, unterminated and nested quotes are
// unbounded, and SDK error text is precisely where malformed input turns up.
// A line break is the one boundary a value
// cannot straddle without the remainder being dropped anyway (describeError
// keeps only the first line), so quote characters are ordinary content here and
// an ambiguous parse always redacts more.
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

function scrubSecrets(text) {
  let out = text;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    out = out.replace(pattern, replacement);
  }
  return redactCredentialValues(out);
}

export function describeError(err) {
  if (err instanceof ExportError) return err.message;
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

// The @azure/identity credential-acquisition failures. AggregateAuthentication-
// Error is the common one for DefaultAzureCredential with nothing logged in.
const IDENTITY_AUTH_ERRORS = new Set([
  'CredentialUnavailableError',
  'AuthenticationError',
  'AuthenticationRequiredError',
  'AggregateAuthenticationError',
]);

export function classifyError(err) {
  const status = Number(err?.statusCode ?? err?.code);
  if (status === 429) return EXIT.THROTTLED;
  if (status === 401 || status === 403) return EXIT.AUTH;
  // A credential that cannot be acquired at all carries no HTTP status, so it
  // is recognised by name — and by EXACT name. @azure/identity's set is finite
  // and documented, while a substring match on 'Credential' or 'Authentication'
  // also swallows names like CredentialTransportError, sending an operator to
  // re-issue RBAC grants for what was really a connection reset. Exit 4 means
  // "your credentials are wrong"; anything else here is exit 5.
  if (IDENTITY_AUTH_ERRORS.has(String(err?.name ?? ''))) return EXIT.AUTH;
  const code = err?.code;
  if (code === 'Unauthorized' || code === 'Forbidden') return EXIT.AUTH;
  return EXIT.TRANSPORT;
}

export function toExportError(err, context) {
  if (err instanceof ExportError) return err;
  const code = classifyError(err);
  const detail = describeError(err);
  const suffix =
    code === EXIT.THROTTLED ? ' — retries exhausted, aborting rather than skipping data' : '';
  return new ExportError(code, `${context}: ${detail}${suffix}`);
}

function slug(id) {
  const safe = id.replace(/[^A-Za-z0-9._-]/g, '_');
  if (safe === id && safe.length <= 64) return safe;
  const digest = createHash('sha1').update(id).digest('hex').slice(0, 8);
  return `${safe.slice(0, 64)}~${digest}`;
}

export function fileNameFor(database, container) {
  return `${slug(database)}__${slug(container)}.jsonl`;
}

export function targetKey(database, container) {
  return `${database}/${container}`;
}

async function pathExists(p) {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

// A resource the caller named by id is simply not there. That is the same
// operator error as a filter that matched nothing under enumeration, so it is
// left to assertFiltersMatched to report with the usage exit code. ONLY 404 is
// treated this way — a 403 is an authorization failure and still aborts.
function isNotFound(err) {
  const status = Number(err?.statusCode ?? err?.code);
  return status === 404 || err?.code === 'NotFound';
}

async function containerExists(client, database, container) {
  try {
    await client.database(database).container(container).read();
    return true;
  } catch (err) {
    if (isNotFound(err)) return false;
    throw toExportError(
      err,
      `${targetKey(database, container)}: reading container metadata failed`
    );
  }
}

// MG-49: a --database export must not reach above the databases it was given.
// Cosmos scopes a data-plane role assignment at '/', at /dbs/<database> or at
// /dbs/<database>/colls/<container>, and NOTHING at account level is covered by
// a /dbs/<database> grant — so enumerating the account's databases to find the
// one the caller already named 403s a correctly-scoped least-privilege reader
// before a single document is read. A filtered run therefore ADDRESSES what it
// was given by id and discovers nothing above it: the named databases, and,
// when --container narrows it further, the named containers too. That leaves
// --container-only (no --database) on the enumerating path, where it belongs:
// finding a container in an unknown database is an account-level question.
async function listScopedTargets(client, databases, containers) {
  const targets = [];
  for (const database of databases) {
    if (containers.length) {
      for (const container of containers) {
        if (await containerExists(client, database, container)) {
          targets.push({ database, container });
        }
      }
      continue;
    }
    let listed;
    try {
      listed = await client.database(database).containers.readAll().fetchAll();
    } catch (err) {
      if (isNotFound(err)) continue;
      throw toExportError(err, `enumerating containers in ${database}`);
    }
    for (const container of listed.resources ?? []) {
      targets.push({ database, container: container.id });
    }
  }
  return targets;
}

export async function listTargets(client, filters = {}) {
  const dbFilter = filters.databases ?? [];
  const containerFilter = filters.containers?.length ? new Set(filters.containers) : null;
  if (dbFilter.length) {
    return listScopedTargets(client, dbFilter, filters.containers ?? []);
  }

  const targets = [];
  let databases;
  try {
    databases = await client.databases.readAll().fetchAll();
  } catch (err) {
    throw toExportError(err, 'enumerating databases');
  }
  for (const db of databases.resources ?? []) {
    let containers;
    try {
      containers = await client.database(db.id).containers.readAll().fetchAll();
    } catch (err) {
      throw toExportError(err, `enumerating containers in ${db.id}`);
    }
    for (const container of containers.resources ?? []) {
      if (containerFilter && !containerFilter.has(container.id)) continue;
      targets.push({ database: db.id, container: container.id });
    }
  }
  return targets;
}

// A filter that matches nothing is a typo, and a typo that exports zero
// containers while exiting 0 is the same disaster as a truncated file.
function assertFiltersMatched(targets, filters) {
  const seenDbs = new Set(targets.map(t => t.database));
  const seenContainers = new Set(targets.map(t => t.container));
  const unmatchedDbs = (filters.databases ?? []).filter(d => !seenDbs.has(d));
  const unmatchedContainers = (filters.containers ?? []).filter(c => !seenContainers.has(c));
  if (unmatchedDbs.length || unmatchedContainers.length) {
    const bits = [];
    if (unmatchedDbs.length) bits.push(`database(s) ${unmatchedDbs.join(', ')}`);
    if (unmatchedContainers.length) bits.push(`container(s) ${unmatchedContainers.join(', ')}`);
    throw new ExportError(EXIT.USAGE, `filter matched nothing in the account: ${bits.join('; ')}`);
  }
}

async function readExpectedCount(containerClient, target) {
  let response;
  try {
    response = await containerClient.items.query('SELECT VALUE COUNT(1) FROM c').fetchAll();
  } catch (err) {
    throw toExportError(err, `${targetKey(target.database, target.container)}: count query failed`);
  }
  const value = response?.resources?.[0];
  if (!Number.isInteger(value) || value < 0) {
    throw new ExportError(
      EXIT.TRANSPORT,
      `${targetKey(target.database, target.container)}: count query returned no usable scalar — refusing to export a container whose expected count is unknown`
    );
  }
  return value;
}

function writeChunk(stream, chunk) {
  return new Promise((resolve, reject) => {
    if (stream.write(chunk)) {
      resolve();
      return;
    }
    const onDrain = () => {
      stream.off('error', onError);
      resolve();
    };
    const onError = err => {
      stream.off('drain', onDrain);
      reject(err);
    };
    stream.once('drain', onDrain);
    stream.once('error', onError);
  });
}

async function closeStream(stream) {
  stream.end();
  await finished(stream);
}

const PROGRESS_EVERY = 50000;

export async function exportContainer(client, target, { outDir, pageSize, log }) {
  const key = targetKey(target.database, target.container);
  const containerClient = client.database(target.database).container(target.container);
  const expectedCount = await readExpectedCount(containerClient, target);

  const fileName = fileNameFor(target.database, target.container);
  const partialPath = path.join(outDir, `${fileName}${PARTIAL_SUFFIX}`);
  const finalPath = path.join(outDir, fileName);

  const hash = createHash('sha256');
  const stream = createWriteStream(partialPath, { flags: 'w' });
  let writtenCount = 0;
  let bytes = 0;

  try {
    const iterator = containerClient.items.readAll({ maxItemCount: pageSize }).getAsyncIterator();
    for await (const page of iterator) {
      for (const doc of page?.resources ?? []) {
        const line = `${JSON.stringify(doc)}\n`;
        hash.update(line);
        bytes += Buffer.byteLength(line);
        writtenCount += 1;
        await writeChunk(stream, line);
        if (writtenCount % PROGRESS_EVERY === 0) {
          log.info(`  ${key}: ${writtenCount}/${expectedCount} document(s) written`);
        }
      }
    }
  } catch (err) {
    await closeStream(stream).catch(() => {});
    throw toExportError(
      err,
      `${key}: ABORTED after ${writtenCount} of ${expectedCount} document(s); partial output left at ${partialPath} and is NOT part of any export`
    );
  }

  await closeStream(stream);

  if (writtenCount !== expectedCount) {
    throw new ExportError(
      EXIT.RECONCILE,
      `${key}: count reconciliation FAILED — the account reports ${expectedCount} document(s), the export wrote ${writtenCount}. Partial output left at ${partialPath} and is NOT part of any export. DO NOT DELETE THE ACCOUNT.`
    );
  }

  await rename(partialPath, finalPath);
  return {
    database: target.database,
    container: target.container,
    file: fileName,
    expectedCount,
    writtenCount,
    bytes,
    sha256: hash.digest('hex'),
  };
}

export async function runExport({
  client,
  outDir,
  endpoint,
  accountName,
  authMode,
  databases = [],
  containers = [],
  pageSize = 1000,
  force = false,
  log = defaultLog,
  nowIso,
}) {
  await mkdir(outDir, { recursive: true });
  const manifestPath = path.join(outDir, MANIFEST_FILENAME);
  if (await pathExists(manifestPath)) {
    if (!force) {
      throw new ExportError(
        EXIT.USAGE,
        `${manifestPath} already exists — that directory holds a completed export. Use an empty --out directory, or pass --force to replace it.`
      );
    }
    // Removed BEFORE the run, not overwritten after it: if this run aborts, the
    // directory must not be left holding the previous run's manifest vouching
    // for files this run has already replaced.
    await rm(manifestPath);
  }

  const filters = { databases, containers };
  const targets = await listTargets(client, filters);
  assertFiltersMatched(targets, filters);
  if (targets.length === 0) {
    throw new ExportError(
      EXIT.RECONCILE,
      'no containers found in the account — refusing to write a manifest claiming an empty account was exported'
    );
  }

  log.info(
    `${TOOL_NAME} ${TOOL_VERSION}: exporting ${targets.length} container(s) from ${accountName} (auth=${authMode})`
  );
  const entries = [];
  for (const target of targets) {
    const key = targetKey(target.database, target.container);
    log.info(`exporting ${key}`);
    const entry = await exportContainer(client, target, { outDir, pageSize, log });
    log.info(
      `  ${key}: reconciled ${entry.writtenCount}/${entry.expectedCount} document(s), ${entry.bytes} byte(s)`
    );
    entries.push(entry);
  }

  const manifest = {
    tool: TOOL_NAME,
    toolVersion: TOOL_VERSION,
    exportedAtUtc: nowIso ?? new Date().toISOString(),
    account: { name: accountName, endpoint },
    authMode,
    filters: {
      databases: databases.length ? [...databases] : null,
      containers: containers.length ? [...containers] : null,
    },
    containers: entries,
    totals: {
      containers: entries.length,
      documents: entries.reduce((n, e) => n + e.writtenCount, 0),
      bytes: entries.reduce((n, e) => n + e.bytes, 0),
    },
  };
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  log.info(
    `EXPORT VERIFIED: ${manifest.totals.containers} container(s), ${manifest.totals.documents} document(s), ${manifest.totals.bytes} byte(s) -> ${manifestPath}`
  );
  return manifest;
}

async function digestFile(filePath) {
  const hash = createHash('sha256');
  let bytes = 0;
  let lines = 0;
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk);
    bytes += chunk.length;
    for (const byte of chunk) {
      if (byte === 0x0a) lines += 1;
    }
  }
  return { sha256: hash.digest('hex'), bytes, lines };
}

async function readManifest(outDir) {
  const manifestPath = path.join(outDir, MANIFEST_FILENAME);
  let raw;
  try {
    raw = await readFile(manifestPath, 'utf8');
  } catch {
    throw new ExportError(
      EXIT.RECONCILE,
      `no ${MANIFEST_FILENAME} in ${outDir} — there is no export here to verify`
    );
  }
  let manifest;
  try {
    manifest = JSON.parse(raw);
  } catch {
    throw new ExportError(
      EXIT.RECONCILE,
      `${manifestPath} is not valid JSON — the manifest itself is damaged`
    );
  }
  if (!Array.isArray(manifest?.containers)) {
    throw new ExportError(
      EXIT.RECONCILE,
      `${manifestPath} has no container list — it did not come from ${TOOL_NAME}`
    );
  }
  return manifest;
}

// --verify's scope is whatever the export recorded, not what argv says, and the
// client has to be built already knowing it (see createRealClient's note on
// endpoint discovery), so the manifest is read once here before anything
// reaches the network. Reading it twice is cheaper than a client that cannot be
// told what scope it is allowed to touch.
export async function readManifestFilters(outDir) {
  return (await readManifest(outDir)).filters ?? {};
}

export async function runVerify({ client, outDir, log = defaultLog }) {
  const manifest = await readManifest(outDir);
  const problems = [];

  for (const entry of manifest.containers) {
    const key = targetKey(entry.database, entry.container);
    const filePath = path.join(outDir, entry.file);
    if (!(await pathExists(filePath))) {
      problems.push(
        `${key}: manifest lists ${entry.file}, but that file is missing from ${outDir}`
      );
      continue;
    }
    const { sha256, bytes, lines } = await digestFile(filePath);
    if (bytes !== entry.bytes) {
      problems.push(
        `${key}: ${entry.file} is ${bytes} byte(s) on disk, manifest recorded ${entry.bytes}`
      );
    }
    if (sha256 !== entry.sha256) {
      problems.push(
        `${key}: ${entry.file} content hash mismatch — on disk ${sha256}, manifest ${entry.sha256}`
      );
    }
    if (lines !== entry.writtenCount) {
      problems.push(
        `${key}: ${entry.file} holds ${lines} document line(s), manifest recorded ${entry.writtenCount}`
      );
    }
  }

  for (const name of await readdir(outDir)) {
    if (name.endsWith(PARTIAL_SUFFIX)) {
      problems.push(
        `aborted-run artifact present in ${outDir}: ${name} — a previous export did not complete`
      );
    }
  }

  const liveTargets = await listTargets(client, manifest.filters ?? {});
  const liveKeys = new Set(liveTargets.map(t => targetKey(t.database, t.container)));
  const manifestKeys = new Set(manifest.containers.map(e => targetKey(e.database, e.container)));

  for (const key of liveKeys) {
    if (!manifestKeys.has(key)) {
      problems.push(
        `${key}: exists in the account but is NOT in the export manifest — the export does not cover it`
      );
    }
  }

  for (const entry of manifest.containers) {
    const key = targetKey(entry.database, entry.container);
    if (!liveKeys.has(key)) {
      problems.push(
        `${key}: in the manifest but no longer present in the account — cannot re-verify its count`
      );
      continue;
    }
    const containerClient = client.database(entry.database).container(entry.container);
    const liveCount = await readExpectedCount(containerClient, entry);
    if (liveCount !== entry.writtenCount) {
      problems.push(
        `${key}: the account now reports ${liveCount} document(s), the export holds ${entry.writtenCount} — the export is stale`
      );
    }
  }

  if (problems.length) {
    throw new ExportError(
      EXIT.RECONCILE,
      `verification FAILED (${problems.length} problem(s)) — DO NOT DELETE THE ACCOUNT:\n  - ${problems.join('\n  - ')}`
    );
  }

  const documents = manifest.containers.reduce((n, e) => n + e.writtenCount, 0);
  log.info(
    `VERIFIED: ${manifest.containers.length} container(s) / ${documents} document(s) in ${outDir} still reconcile against ${manifest.account?.name ?? 'the account'} (exported ${manifest.exportedAtUtc})`
  );
  return { containers: manifest.containers.length, documents, manifest };
}
