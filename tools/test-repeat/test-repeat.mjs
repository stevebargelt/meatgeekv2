#!/usr/bin/env node
// HAR-107 — run a test suite N times in a row, and prove it.
//
//   node tools/test-repeat/test-repeat.mjs list
//   node tools/test-repeat/test-repeat.mjs run <suite> [--runs N] [--shard i/S]
//        [--parallel K] [--result file.json] [--log-dir dir] [--skip-prepare]
//        [--tail lines] [--run-timeout seconds]
//   node tools/test-repeat/test-repeat.mjs select (--affected <base> | --files a,b)
//        [--labels l1,l2] [--runs N] [--out selection.json] [--github-output]
//   node tools/test-repeat/test-repeat.mjs summary --selection selection.json
//        --results <dir>
//
// Every subcommand takes --registry <file.mjs> (default: ./suites.mjs); the
// self-tests use it to point the harness at fixture suites.
//
// `run` exits 0 when every run passed, 1 when one failed, 2 on a usage or
// prepare error. See README.md.

import { execFileSync } from 'node:child_process';
import { appendFileSync, readdirSync, readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  DEFAULT_RUNS,
  parseShard,
  prepareSuite,
  renderSummary,
  repeatSuite,
  selectSuites,
  writeJson,
} from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(HERE, '../..');

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) {
      positional.push(a);
      continue;
    }
    const eq = a.indexOf('=');
    if (eq !== -1) {
      flags[a.slice(2, eq)] = a.slice(eq + 1);
    } else if (i + 1 < argv.length && !argv[i + 1].startsWith('--')) {
      flags[a.slice(2)] = argv[++i];
    } else {
      flags[a.slice(2)] = true;
    }
  }
  return { positional, flags };
}

function positiveInt(value, name) {
  const n = Number(value);
  if (!Number.isInteger(n) || n < 1)
    throw new UsageError(`${name} must be a positive integer, got ${value}`);
  return n;
}

class UsageError extends Error {}

async function loadRegistry(flags) {
  const file = flags.registry ? path.resolve(flags.registry) : path.join(HERE, 'suites.mjs');
  const mod = await import(pathToFileURL(file).href);
  const suites = mod.suites ?? mod.default;
  if (!Array.isArray(suites) || suites.length === 0)
    throw new UsageError(`${file} exports no suites`);
  return suites;
}

function changedFilesSince(base) {
  const out = execFileSync('git', ['diff', '--name-only', `${base}...HEAD`], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
  });
  return out.split('\n').filter(Boolean);
}

const list = v =>
  typeof v === 'string'
    ? v
        .split(/[,\n]/)
        .map(s => s.trim())
        .filter(Boolean)
    : [];

async function cmdList(flags) {
  const suites = await loadRegistry(flags);
  if (flags.json) {
    process.stdout.write(`${JSON.stringify(suites, null, 2)}\n`);
    return 0;
  }
  for (const s of suites) {
    const extra = [
      s.shards > 1 ? `shards=${s.shards}` : '',
      s.needs.length ? `needs=${s.needs.join(',')}` : '',
    ]
      .filter(Boolean)
      .join(' ');
    process.stdout.write(
      `${s.id.padEnd(40)} ${s.command.join(' ')}${extra ? `   [${extra}]` : ''}\n`
    );
  }
  return 0;
}

async function cmdRun(positional, flags) {
  const suites = await loadRegistry(flags);
  const id = positional[0];
  if (!id) throw new UsageError('run needs a suite id (see `list`)');
  const suite = suites.find(s => s.id === id);
  if (!suite) throw new UsageError(`unknown suite ${id} (see \`list\`)`);
  const runs = flags.runs ? positiveInt(flags.runs, '--runs') : DEFAULT_RUNS;
  const shard = flags.shard ? parseShard(flags.shard) : { index: 1, total: 1 };
  const parallel = flags.parallel ? positiveInt(flags.parallel, '--parallel') : 1;
  const logDir = path.resolve(flags['log-dir'] ?? path.join(os.tmpdir(), 'test-repeat-logs'));
  const kind = flags.kind === 'load' ? 'load' : 'repeat';

  if (!flags['skip-prepare']) {
    try {
      await prepareSuite(suite, { repoRoot: REPO_ROOT });
    } catch (err) {
      process.stderr.write(`test-repeat: ${err.message}\n`);
      if (flags.result) {
        writeJson(flags.result, {
          suite: suite.id,
          kind,
          shard: `${shard.index}/${shard.total}`,
          runsTotal: runs,
          requested: 0,
          passed: 0,
          failedRun: null,
          error: err.message,
          durationMs: 0,
          runDurationsMs: [],
          copies: [],
          ok: false,
        });
      }
      return 2;
    }
  }

  const result = await repeatSuite(suite, {
    repoRoot: REPO_ROOT,
    runs,
    shard,
    parallel,
    kind,
    logDir,
    tailLines: flags.tail ? positiveInt(flags.tail, '--tail') : 80,
    timeoutSec: flags['run-timeout']
      ? positiveInt(flags['run-timeout'], '--run-timeout')
      : undefined,
  });
  if (flags.result) writeJson(flags.result, result);
  return result.ok ? 0 : 1;
}

async function cmdSelect(flags) {
  const suites = await loadRegistry(flags);
  let changedFiles;
  if (typeof flags.affected === 'string') changedFiles = changedFilesSince(flags.affected);
  else if (typeof flags.files === 'string') changedFiles = list(flags.files);
  else throw new UsageError('select needs --affected <base> or --files a,b');
  const labels = parseLabels(flags.labels);
  const selection = selectSuites({
    suites,
    changedFiles,
    labels,
    runs: flags.runs ? positiveInt(flags.runs, '--runs') : DEFAULT_RUNS,
  });
  if (flags.out) writeJson(flags.out, selection);

  const repeatMatrix = { include: selection.entries.filter(e => !e.emulator) };
  const emulatorMatrix = { include: selection.entries.filter(e => e.emulator) };
  if (flags['github-output']) {
    const file = process.env.GITHUB_OUTPUT;
    if (!file) throw new UsageError('--github-output needs $GITHUB_OUTPUT');
    appendFileSync(
      file,
      [
        `selection=${JSON.stringify(selection)}`,
        `matrix=${JSON.stringify(repeatMatrix)}`,
        `has_matrix=${repeatMatrix.include.length > 0}`,
        `emulator_matrix=${JSON.stringify(emulatorMatrix)}`,
        `has_emulator=${emulatorMatrix.include.length > 0}`,
        '',
      ].join('\n')
    );
  }
  for (const s of selection.suites) {
    process.stdout.write(
      `${s.id.padEnd(40)} ${s.selected ? `${s.runs} run(s) — ${s.reason}` : 'not affected'}\n`
    );
  }
  process.stdout.write(`${selection.entries.length} CI job(s)\n`);
  return 0;
}

/** Labels arrive as a JSON array (from toJSON in the workflow) or a comma list. */
function parseLabels(value) {
  if (typeof value !== 'string' || value.trim() === '') return [];
  const t = value.trim();
  if (t.startsWith('[')) {
    const parsed = JSON.parse(t);
    if (!Array.isArray(parsed)) throw new UsageError('--labels JSON must be an array');
    return parsed.map(String);
  }
  return list(t);
}

async function cmdSummary(flags) {
  if (typeof flags.selection !== 'string' || typeof flags.results !== 'string') {
    throw new UsageError('summary needs --selection <file> and --results <dir>');
  }
  const selection = JSON.parse(readFileSync(flags.selection, 'utf8'));
  const results = [];
  let files = [];
  try {
    files = readdirSync(flags.results).filter(f => f.endsWith('.json'));
  } catch {
    // No results directory: every selected entry reports "no result".
  }
  for (const f of files)
    results.push(JSON.parse(readFileSync(path.join(flags.results, f), 'utf8')));
  const { markdown, ok } = renderSummary(selection, results);
  process.stdout.write(`${markdown}\n`);
  if (flags['step-summary'] && process.env.GITHUB_STEP_SUMMARY) {
    appendFileSync(process.env.GITHUB_STEP_SUMMARY, `${markdown}\n`);
  }
  return ok ? 0 : 1;
}

async function main(argv) {
  const [cmd, ...rest] = argv;
  const { positional, flags } = parseArgs(rest);
  switch (cmd) {
    case 'list':
      return cmdList(flags);
    case 'run':
      return cmdRun(positional, flags);
    case 'select':
      return cmdSelect(flags);
    case 'summary':
      return cmdSummary(flags);
    default:
      throw new UsageError(`unknown command ${cmd ?? '(none)'}; use list, run, select or summary`);
  }
}

main(process.argv.slice(2)).then(
  code => {
    process.exitCode = code;
  },
  err => {
    process.stderr.write(`test-repeat: ${err.message}\n`);
    process.exitCode = 2;
  }
);
