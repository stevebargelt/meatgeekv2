// HAR-107 — the logic behind tools/test-repeat/test-repeat.mjs: affected
// selection, shard arithmetic, the repeat loop and the job-summary table.
// Node built-ins only, so it runs on a bare runner before `npm ci`.

import { spawn } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import {
  mkdtempSync,
  rmSync,
  writeFileSync,
  createWriteStream,
  readFileSync,
  readdirSync,
  mkdirSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * @typedef {object} Suite
 * @property {string} id
 * @property {string} [cwd]
 * @property {string[]} command
 * @property {string[][]} [prepare]
 * @property {string[]} paths
 * @property {string[]} needs
 * @property {number} [shards]
 * @property {number} [maxParallel]
 * @property {string} [maxParallelReason]
 * @property {string[]} [loadArgs]
 * @property {string} [loadArgsReason]
 * @property {Record<string,string>} [env]
 * @property {string[]} [passEnv]
 * @property {(copy: number) => Record<string,string>} [copyEnv]
 * @property {boolean} [selfTest]
 * @property {number} [timeoutSec]
 * @property {string} [goModFile]
 */

export const KNOWN_NEEDS = ['npm', 'go', 'terraform', 'chromium', 'cosmos-emulator'];

/** A change to any of these is a change to the harness itself. */
export const HARNESS_PATHS = ['tools/test-repeat/**', '.github/workflows/test-repeat.yml'];

export const LABEL_ALL = 'test-repeat:all';
export const LABEL_LOAD = 'test-repeat:load';

// --- environment -------------------------------------------------------------

/**
 * HAR-119: what a run inherits from the caller's environment. Everything else
 * the caller has set is dropped, so a variable exported in a developer's shell
 * or set by an unrelated CI step cannot change a run (HAR-112 found
 * TF_DESTROY_GUARD_* doing exactly that). These are what the toolchains need
 * to run at all: the shell, locale, user and home, CI's own identity, and the
 * Go, Node, npm, corepack and Nx settings. A trailing `*` is a prefix. On
 * Windows names match case-insensitively (`Path` is `PATH` there).
 *
 * A suite that needs more lists it in `passEnv`; `env` sets values outright.
 */
export const ENV_ALLOWLIST = [
  'PATH',
  'HOME',
  'USER',
  'LANG',
  'LC_*',
  'TERM',
  'SHELL',
  'CI',
  'GITHUB_*',
  'RUNNER_*',
  'GO*',
  'NODE_OPTIONS',
  'npm_config_*',
  'COREPACK_*',
  'NX_*',
  // Windows: Node cannot start sockets or child processes without SystemRoot
  // and ComSpec; npm needs APPDATA; os.homedir() reads USERPROFILE.
  'SystemRoot',
  'SystemDrive',
  'windir',
  'ComSpec',
  'PATHEXT',
  'USERPROFILE',
  'USERNAME',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles*',
  'NUMBER_OF_PROCESSORS',
  'PROCESSOR_ARCHITECTURE',
];

/** Set by the harness itself on every run: each copy's own temp dir. */
export const HARNESS_ENV = ['TMPDIR', 'TMP', 'TEMP'];

/**
 * HAR-121: set by the harness on every run to the run's copy number, 1 to K
 * under --parallel K and 1 in the serial pass, so a suite can give each
 * concurrent copy its own resource (a port). Never taken from the caller, and
 * never set for a prepare step.
 */
export const COPY_ENV = 'TEST_REPEAT_COPY';

/** Does `name` match one of `patterns` (exact, or a prefix ending in `*`)? */
export function envNameMatches(name, patterns, platform = process.platform) {
  const fold = platform === 'win32' ? v => v.toUpperCase() : v => v;
  const n = fold(name);
  return patterns.some(p => {
    const q = fold(p);
    return q.endsWith('*') ? n.startsWith(q.slice(0, -1)) : n === q;
  });
}

/**
 * The environment for one of `suite`'s runs (or, with `tmp` unset, its
 * prepare steps): the allowlisted and `passEnv` variables from `parentEnv`,
 * then `suite.env`, then, for a run, `suite.copyEnv(copy)`, the temp dir and
 * TEST_REPEAT_COPY. Prepare steps keep the caller's own temp dir variables,
 * since they run once and outside any copy.
 */
export function suiteEnv(
  suite,
  { parentEnv = process.env, platform = process.platform, tmp, copy = 1 } = {}
) {
  const keep = [...ENV_ALLOWLIST, ...(suite.passEnv ?? []), ...(tmp ? [] : HARNESS_ENV)];
  const env = {};
  for (const [name, value] of Object.entries(parentEnv)) {
    if (value !== undefined && envNameMatches(name, keep, platform)) env[name] = value;
  }
  Object.assign(env, suite.env ?? {});
  if (tmp) {
    Object.assign(env, suite.copyEnv?.(copy) ?? {});
    Object.assign(env, { TMPDIR: tmp, TMP: tmp, TEMP: tmp, [COPY_ENV]: String(copy) });
  }
  return env;
}

export const DEFAULT_RUNS = 50;
export const HARNESS_RUNS = 1;
export const LOAD_PARALLEL = 8;

// --- globs -----------------------------------------------------------------

/** `**` matches across directories (including none), `*` and `?` do not. */
export function globToRegExp(glob) {
  let re = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++;
        if (glob[i + 1] === '/') {
          i++;
          re += '(?:.*/)?';
        } else {
          re += '.*';
        }
      } else {
        re += '[^/]*';
      }
    } else if (c === '?') {
      re += '[^/]';
    } else {
      re += c.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    }
  }
  return new RegExp(`^${re}$`);
}

export function matchesAny(file, globs) {
  return globs.some(g => globToRegExp(g).test(file));
}

// --- selection -------------------------------------------------------------

/**
 * Decide which suites run, and how many times.
 *
 *  - label test-repeat:all       every suite, `runs` times
 *  - a change to the harness     every suite, once (proves each command works
 *                                in CI without putting not-yet-fixed suites
 *                                through 50 runs), except a `selfTest` suite
 *                                (the harness's own tests), which runs `runs`
 *                                times: a harness change is what it tests
 *  - otherwise                   each suite whose `paths` match a changed
 *                                file, `runs` times
 *  - label test-repeat:load      adds one pass of every selected suite with
 *                                --parallel 8 (capped by the suite's
 *                                maxParallel)
 */
export function selectSuites({
  suites,
  changedFiles,
  labels = [],
  runs = DEFAULT_RUNS,
  harnessRuns = HARNESS_RUNS,
  loadParallel = LOAD_PARALLEL,
}) {
  const harnessFiles = changedFiles.filter(f => matchesAny(f, HARNESS_PATHS));
  const harnessChanged = harnessFiles.length > 0;
  const all = labels.includes(LABEL_ALL);
  const load = labels.includes(LABEL_LOAD);

  const selection = suites.map(s => {
    const hits = changedFiles.filter(f => matchesAny(f, s.paths));
    if (all) return { id: s.id, selected: true, reason: `label ${LABEL_ALL}`, runs, matched: hits };
    if (harnessChanged)
      return {
        id: s.id,
        selected: true,
        reason: s.selfTest ? 'harness changed (self-test)' : 'harness changed',
        runs: s.selfTest ? runs : harnessRuns,
        matched: hits,
      };
    if (hits.length > 0)
      return { id: s.id, selected: true, reason: 'affected', runs, matched: hits };
    return { id: s.id, selected: false, reason: 'not affected', runs: 0, matched: [] };
  });

  const entries = [];
  for (const sel of selection) {
    if (!sel.selected) continue;
    const suite = suites.find(s => s.id === sel.id);
    const shards = Math.max(1, Math.min(suite.shards ?? 1, sel.runs));
    for (let i = 1; i <= shards; i++) {
      entries.push(
        matrixEntry(suite, {
          key: shards > 1 ? `${suite.id}--shard-${i}-of-${shards}` : suite.id,
          name: shards > 1 ? `${suite.id} (shard ${i}/${shards})` : suite.id,
          kind: 'repeat',
          runs: sel.runs,
          shard: `${i}/${shards}`,
          parallel: 1,
        })
      );
    }
    if (load) {
      const parallel = Math.min(loadParallel, suite.maxParallel ?? loadParallel);
      entries.push(
        matrixEntry(suite, {
          key: `${suite.id}--load`,
          name: `${suite.id} (load x${parallel})`,
          kind: 'load',
          runs: 1,
          shard: '1/1',
          parallel,
        })
      );
    }
  }

  return {
    harnessChanged,
    harnessFiles,
    labels: { all, load },
    changedFiles,
    suites: selection,
    entries,
  };
}

function matrixEntry(suite, fields) {
  const needs = new Set(suite.needs);
  return {
    ...fields,
    suite: suite.id,
    npm: needs.has('npm'),
    go: needs.has('go'),
    terraform: needs.has('terraform'),
    chromium: needs.has('chromium'),
    emulator: needs.has('cosmos-emulator'),
    goModFile: suite.goModFile ?? '',
    goSumFile: suite.goModFile ? suite.goModFile.replace(/go\.mod$/, 'go.sum') : '',
  };
}

// --- shards ----------------------------------------------------------------

/** Parse "i/S". */
export function parseShard(text) {
  const m = /^(\d+)\/(\d+)$/.exec(String(text));
  if (!m) throw new Error(`--shard must look like i/S, got ${text}`);
  const index = Number(m[1]);
  const total = Number(m[2]);
  if (total < 1 || index < 1 || index > total) throw new Error(`--shard ${text} is out of range`);
  return { index, total };
}

/**
 * Shard i of S of N runs gets a contiguous block of run numbers; the first
 * N % S shards get one extra. Run numbers are global (1..N), so a failure is
 * reported as "run 37" whichever shard hit it.
 */
export function shardRange(runs, index, total) {
  const base = Math.floor(runs / total);
  const extra = runs % total;
  const count = base + (index <= extra ? 1 : 0);
  const start = (index - 1) * base + Math.min(index - 1, extra) + 1;
  return { start, count };
}

// --- running ---------------------------------------------------------------

/**
 * Run a command once, output to `logFile`. Resolves with
 * { code, signal, timedOut, durationMs }. The child gets its own process
 * group so a timeout kills everything it started (jest workers, a web server).
 */
export function runOnce({ argv, cwd, env, logFile, timeoutSec }) {
  return new Promise(resolve => {
    const started = process.hrtime.bigint();
    const out = createWriteStream(logFile);
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
        detached: process.platform !== 'win32',
      });
    } catch (err) {
      out.end(`test-repeat: could not start ${argv[0]}: ${err.message}\n`);
      resolve({ code: 127, signal: null, timedOut: false, durationMs: 0 });
      return;
    }
    child.stdout.pipe(out, { end: false });
    child.stderr.pipe(out, { end: false });
    let timedOut = false;
    const timer =
      timeoutSec > 0
        ? setTimeout(() => {
            timedOut = true;
            killGroup(child);
          }, timeoutSec * 1000)
        : null;
    let done = false;
    let exit = { code: null, signal: null };
    const finish = spawnError => {
      if (done) return;
      done = true;
      if (timer) clearTimeout(timer);
      const durationMs = Number(process.hrtime.bigint() - started) / 1e6;
      const trailer = spawnError
        ? `\ntest-repeat: could not start ${argv[0]}: ${spawnError.message}\n`
        : timedOut
          ? `\ntest-repeat: run killed after exceeding ${timeoutSec}s\n`
          : '';
      out.end(trailer, () =>
        resolve({ code: spawnError ? 127 : exit.code, signal: exit.signal, timedOut, durationMs })
      );
    };
    child.on('error', err => {
      // A spawn failure (ENOENT) has no process; nothing else will fire.
      if (child.pid === undefined) finish(err);
    });
    child.on('exit', (code, signal) => {
      exit = { code, signal };
      // Anything the command left running in its group goes too; otherwise a
      // leftover grandchild holding the pipes would keep 'close' from firing.
      killGroup(child);
    });
    child.on('close', () => finish(null));
  });
}

function killGroup(child) {
  if (child.pid === undefined) return;
  try {
    if (process.platform === 'win32') child.kill('SIGKILL');
    else process.kill(-child.pid, 'SIGKILL');
  } catch {
    // Already gone.
  }
}

export function tailOf(file, lines) {
  let text;
  try {
    text = readFileSync(file, 'utf8');
  } catch {
    return '';
  }
  const all = text.replace(/\n$/, '').split('\n');
  return all.slice(-lines).join('\n');
}

/**
 * Run `suite` repeatedly. With parallel = K, K copies run at once, each with
 * its own temp dir (TMPDIR/TMP/TEMP), each doing its own `count` runs and
 * stopping at its own first failure.
 *
 * Returns the result object written to --result.
 */
export async function repeatSuite(suite, opts) {
  const {
    repoRoot,
    runs,
    shard = { index: 1, total: 1 },
    parallel = 1,
    kind = 'repeat',
    logDir,
    tailLines = 80,
    log = line => process.stdout.write(`${line}\n`),
  } = opts;
  const { start, count } = shardRange(runs, shard.index, shard.total);
  const effectiveParallel = Math.max(1, Math.min(parallel, suite.maxParallel ?? parallel));
  const cwd = path.resolve(repoRoot, suite.cwd ?? '.');
  const timeoutSec = opts.timeoutSec ?? suite.timeoutSec ?? 0;
  mkdirSync(logDir, { recursive: true });

  const where =
    shard.total > 1
      ? ` (shard ${shard.index}/${shard.total}, runs ${start}-${start + count - 1})`
      : '';
  log(
    `${suite.id}${where}: ${count} run(s)${effectiveParallel > 1 ? ` in each of ${effectiveParallel} parallel copies` : ''}`
  );
  if (effectiveParallel < parallel) {
    log(
      `${suite.id}: --parallel ${parallel} capped at ${effectiveParallel}: ${suite.maxParallelReason ?? 'maxParallel'}`
    );
  }
  const loadArgs = effectiveParallel > 1 ? (suite.loadArgs ?? []) : [];
  if (loadArgs.length) {
    log(
      `${suite.id}: each copy runs with ${loadArgs.join(' ')}: ${suite.loadArgsReason ?? 'loadArgs'}`
    );
  }

  // HAR-119: log names carry the pass and an id unique to this invocation, so a
  // later invocation into the same --log-dir (the load pass after the serial
  // pass, a re-run) never reuses, and so never deletes or overwrites, the log
  // of an earlier failure.
  const logPrefix = uniqueLogPrefix(logDir, `${suite.id}-${kind}`);

  const startedAt = Date.now();
  const copies = await Promise.all(
    Array.from({ length: effectiveParallel }, (_, i) =>
      runCopy({
        suite,
        argv: [...suite.command, ...loadArgs],
        copy: i + 1,
        copies: effectiveParallel,
        start,
        count,
        cwd,
        timeoutSec,
        logDir,
        logPrefix,
        tailLines,
        log,
      })
    )
  );
  const durationMs = Date.now() - startedAt;

  const failed = copies.filter(c => c.failedRun !== null);
  const result = {
    suite: suite.id,
    kind,
    shard: `${shard.index}/${shard.total}`,
    runsTotal: runs,
    startRun: start,
    requested: count * effectiveParallel,
    passed: copies.reduce((n, c) => n + c.passed, 0),
    failedRun: failed.length ? Math.min(...failed.map(c => c.failedRun)) : null,
    parallelRequested: parallel,
    parallel: effectiveParallel,
    parallelNote: effectiveParallel < parallel ? (suite.maxParallelReason ?? 'maxParallel') : null,
    loadArgs,
    durationMs,
    runDurationsMs: copies.flatMap(c => c.runDurationsMs),
    copies: copies.map(({ tail, ...c }) => c),
    ok: failed.length === 0,
  };

  // The report lines HAR-106's fix PRs quote as evidence.
  if (effectiveParallel > 1) {
    for (const c of copies)
      log(`${suite.id} [copy ${c.copy}/${effectiveParallel}]: ${reportLine(c)}`);
    log(
      `${suite.id}: ${effectiveParallel - failed.length}/${effectiveParallel} parallel copies passed`
    );
  } else {
    log(`${suite.id}: ${reportLine(copies[0])}`);
  }
  for (const c of failed) {
    log('');
    log(
      `----- ${suite.id}${effectiveParallel > 1 ? ` copy ${c.copy}` : ''}: output tail of failing run ${c.failedRun} (last ${tailLines} lines; full log ${c.failedLog}) -----`
    );
    log(c.tail);
    log('----- end of output tail -----');
  }
  return result;
}

/**
 * `<base>-<id>`, with a random id no file in `logDir` already starts with. No
 * clock: two invocations in the same instant still differ.
 */
export function uniqueLogPrefix(logDir, base) {
  let existing = [];
  try {
    existing = readdirSync(logDir);
  } catch {
    // No directory yet: nothing to collide with.
  }
  for (;;) {
    const prefix = `${base}-${randomBytes(4).toString('hex')}`;
    if (!existing.some(f => f.startsWith(`${prefix}-`))) return prefix;
  }
}

function reportLine(c) {
  const head = `${c.passed}/${c.requested} passed`;
  return c.failedRun === null
    ? head
    : `${head}, failed on run ${c.failedRun}${c.timedOut ? ' (timed out)' : ''}`;
}

async function runCopy({
  suite,
  argv,
  copy,
  copies,
  start,
  count,
  cwd,
  timeoutSec,
  logDir,
  logPrefix,
  tailLines,
  log,
}) {
  // Kept short: tools under test put unix sockets in TMPDIR (terraform's
  // provider plugins, Nx), and a socket path is limited to ~104 bytes. An
  // already-long TMPDIR (some sandboxes nest it deeply) falls back to /tmp.
  const base = os.tmpdir().length <= 60 || process.platform === 'win32' ? os.tmpdir() : '/tmp';
  const tmp = mkdtempSync(path.join(base, `tr${copy}-`));
  const env = suiteEnv(suite, { tmp, copy });
  const tag = copies > 1 ? ` [copy ${copy}/${copies}]` : '';
  const state = {
    copy,
    tmpdir: tmp,
    requested: count,
    passed: 0,
    failedRun: null,
    timedOut: false,
    failedLog: null,
    runDurationsMs: [],
    tail: '',
  };
  try {
    for (let n = start; n < start + count; n++) {
      const logFile = path.join(logDir, `${logPrefix}-copy${copy}-run${n}.log`);
      const r = await runOnce({ argv, cwd, env, logFile, timeoutSec });
      state.runDurationsMs.push(Math.round(r.durationMs));
      const secs = (r.durationMs / 1000).toFixed(1);
      if (r.code === 0 && !r.timedOut) {
        state.passed++;
        log(`${suite.id}${tag}: run ${n} passed (${secs}s)`);
        rmSync(logFile, { force: true });
        continue;
      }
      state.failedRun = n;
      state.timedOut = r.timedOut;
      state.failedLog = logFile;
      state.tail = tailOf(logFile, tailLines);
      const why = r.timedOut
        ? `timed out after ${timeoutSec}s`
        : r.signal
          ? `signal ${r.signal}`
          : `exit ${r.code}`;
      log(`${suite.id}${tag}: run ${n} FAILED (${why}, ${secs}s)`);
      break;
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
  return state;
}

/** Run a suite's prepare commands once, output inherited. Throws on failure. */
export async function prepareSuite(suite, { repoRoot, log = l => process.stdout.write(`${l}\n`) }) {
  for (const argv of suite.prepare ?? []) {
    log(`${suite.id}: prepare: ${argv.join(' ')}`);
    const code = await new Promise(resolve => {
      const child = spawn(argv[0], argv.slice(1), {
        cwd: path.resolve(repoRoot, suite.cwd ?? '.'),
        env: suiteEnv(suite),
        stdio: ['ignore', 'inherit', 'inherit'],
      });
      child.on('error', () => resolve(127));
      child.on('close', c => resolve(c ?? 1));
    });
    if (code !== 0)
      throw new Error(`${suite.id}: prepare step \`${argv.join(' ')}\` exited ${code}`);
  }
}

// --- summary ---------------------------------------------------------------

export function formatDuration(ms) {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/**
 * The job summary: one table, one row per suite (and one per load pass), every
 * suite present — an unaffected suite says "not affected". `ok` is false when a
 * selected pass failed or never reported.
 */
export function renderSummary(selection, results) {
  const rows = [];
  let ok = true;
  const problems = [];
  const affectedCell = sel =>
    !sel.selected
      ? 'not affected'
      : sel.reason === 'affected'
        ? `yes (${sel.matched.length} file${sel.matched.length === 1 ? '' : 's'})`
        : sel.reason;

  for (const sel of selection.suites) {
    if (!sel.selected) {
      rows.push([sel.id, 'not affected', '—', '—', '—', '—']);
      continue;
    }
    for (const kind of ['repeat', 'load']) {
      const expected = selection.entries.filter(e => e.suite === sel.id && e.kind === kind);
      if (expected.length === 0) continue;
      const got = expected.map(e =>
        results.find(r => r.suite === sel.id && r.kind === kind && r.shard === e.shard)
      );
      const missing = expected.filter((_, i) => !got[i]);
      const have = got.filter(Boolean);
      const label = kind === 'load' ? `${sel.id} (load x${expected[0].parallel})` : sel.id;
      const requested = kind === 'load' ? expected[0].parallel : sel.runs;
      const passed = have.reduce((n, r) => n + r.passed, 0);
      const failedRuns = have.filter(r => r.failedRun !== null);
      let firstFail = '—';
      if (kind === 'load') {
        const failedCopies = have.flatMap(r =>
          r.copies.filter(c => c.failedRun !== null).map(c => c.copy)
        );
        if (failedCopies.length) firstFail = `copy ${failedCopies.join(', ')}`;
      } else if (failedRuns.length) {
        firstFail = `run ${Math.min(...failedRuns.map(r => r.failedRun))}`;
      }
      const runMs = have.flatMap(r => r.runDurationsMs);
      const totalMs = have.reduce((n, r) => n + r.durationMs, 0);
      let duration = have.length ? formatDuration(totalMs) : '—';
      if (runMs.length) {
        const mean = runMs.reduce((a, b) => a + b, 0) / runMs.length;
        duration += ` (${(mean / 1000).toFixed(1)}s/run${expected.length > 1 ? `, ${expected.length} shards` : ''})`;
      }
      let passedCell = `${passed}/${requested}`;
      if (missing.length) {
        passedCell += ` — no result from ${missing.map(e => `shard ${e.shard}`).join(', ')}`;
        problems.push(`${label}: ${missing.length} job(s) reported no result`);
      }
      const note = have.find(r => r.parallelNote)?.parallelNote;
      const loadArgs = have.find(r => r.loadArgs?.length)?.loadArgs;
      const affected =
        affectedCell(sel) +
        (note ? ` (parallel capped: ${note})` : '') +
        (loadArgs ? ` (each copy: \`${loadArgs.join(' ')}\`)` : '');
      if (failedRuns.length || missing.length) ok = false;
      if (failedRuns.length)
        problems.push(`${label}: ${passed}/${requested} passed, first failure ${firstFail}`);
      rows.push([label, affected, String(requested), passedCell, firstFail, duration]);
    }
  }

  const header = [
    'suite',
    'affected?',
    'runs requested',
    'runs passed',
    'first failing run',
    'duration',
  ];
  const esc = c => String(c).replace(/\|/g, '\\|');
  const lines = [
    '## test-repeat',
    '',
    selection.harnessChanged
      ? `The harness itself changed (${selection.harnessFiles.join(', ')}), so every suite runs once${selfTestNote(selection)}.`
      : selection.labels.all
        ? `Label \`${LABEL_ALL}\`: every suite runs ${selection.suites[0]?.runs ?? DEFAULT_RUNS} times.`
        : `Suites affected by this pull request's ${selection.changedFiles.length} changed file(s) run ${DEFAULT_RUNS} times.`,
    selection.labels.load
      ? `Label \`${LABEL_LOAD}\`: plus one pass of each selected suite with --parallel ${LOAD_PARALLEL}.`
      : '',
    '',
    `| ${header.join(' | ')} |`,
    `| ${header.map(() => '---').join(' | ')} |`,
    ...rows.map(r => `| ${r.map(esc).join(' | ')} |`),
    '',
  ];
  if (problems.length) lines.push('**Failed:**', '', ...problems.map(p => `- ${p}`), '');
  return {
    markdown: lines.filter((l, i, a) => !(l === '' && a[i - 1] === '')).join('\n'),
    ok,
    problems,
  };
}

function selfTestNote(selection) {
  const self = selection.suites.filter(
    s => s.selected && s.reason === 'harness changed (self-test)'
  );
  return self.length
    ? `, except the harness's own tests (${self.map(s => s.id).join(', ')}), which run ${self[0].runs} times`
    : '';
}

export function writeJson(file, value) {
  mkdirSync(path.dirname(path.resolve(file)), { recursive: true });
  writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}
