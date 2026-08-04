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

export function describeError(err) {
  if (err instanceof ExportError) return err.message;
  const parts = [];
  const name = err?.name;
  if (name) parts.push(String(name));
  const code = err?.statusCode ?? err?.code;
  if (code !== undefined && code !== null) parts.push(`status=${code}`);
  const raw = typeof err?.message === 'string' ? err.message : '';
  const scrubbed = raw.replace(BRACKETED, '[redacted]').split('\n')[0].trim().slice(0, 200);
  if (scrubbed) parts.push(scrubbed);
  return parts.join(' ') || 'unknown error';
}

export function classifyError(err) {
  const status = Number(err?.statusCode ?? err?.code);
  if (status === 429) return EXIT.THROTTLED;
  if (status === 401 || status === 403) return EXIT.AUTH;
  const name = String(err?.name ?? '');
  if (name === 'AuthenticationError' || name.startsWith('Credential')) return EXIT.AUTH;
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

export async function listTargets(client, filters = {}) {
  const dbFilter = filters.databases?.length ? new Set(filters.databases) : null;
  const containerFilter = filters.containers?.length ? new Set(filters.containers) : null;
  const targets = [];
  let databases;
  try {
    databases = await client.databases.readAll().fetchAll();
  } catch (err) {
    throw toExportError(err, 'enumerating databases');
  }
  for (const db of databases.resources ?? []) {
    if (dbFilter && !dbFilter.has(db.id)) continue;
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
