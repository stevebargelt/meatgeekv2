// The registry lists every non-live suite in the repository, and stays that
// way: a new jest config or fixture harness without an entry fails here.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { droppedEnv, suites } from '../suites.mjs';
import { COPY_ENV, ENV_ALLOWLIST, envNameMatches, HARNESS_ENV, KNOWN_NEEDS } from '../lib.mjs';
import { scanEnv, sourceFiles, suiteSourceRoots, workflowRunEnv } from './env-scan.mjs';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');
const commandText = s => s.command.join(' ');

function findFiles(dir, pred, out = []) {
  for (const e of readdirSync(path.join(REPO_ROOT, dir), { withFileTypes: true })) {
    if (['node_modules', '.terraform', '.nx', 'dist', '.git'].includes(e.name)) continue;
    const rel = path.posix.join(dir, e.name);
    if (e.isDirectory()) findFiles(rel, pred, out);
    else if (pred(e.name, rel)) out.push(rel);
  }
  return out;
}

test('ids are unique and entries are well formed', () => {
  const ids = suites.map(s => s.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const s of suites) {
    assert.match(s.id, /^[a-z0-9-]+$/, s.id);
    assert.ok(Array.isArray(s.command) && s.command.length > 0, s.id);
    assert.ok(Array.isArray(s.paths) && s.paths.length > 0, `${s.id} has affected paths`);
    for (const n of s.needs) assert.ok(KNOWN_NEEDS.includes(n), `${s.id}: unknown need ${n}`);
    assert.ok(existsSync(path.join(REPO_ROOT, s.cwd ?? '.')), `${s.id}: cwd exists`);
    assert.ok(s.timeoutSec > 0, `${s.id} has a hang guard`);
    if (s.needs.includes('go'))
      assert.ok(existsSync(path.join(REPO_ROOT, s.goModFile)), `${s.id}: goModFile`);
  }
});

test('every jest config except the live acceptance one has a suite', () => {
  const configs = [
    ...findFiles('apps', n => /^jest(\..+)?\.config\.ts$/.test(n)),
    ...findFiles('libs', n => /^jest(\..+)?\.config\.ts$/.test(n)),
  ].filter(f => f !== 'apps/api/acceptance/jest.config.ts');
  assert.ok(configs.length >= 8, `found ${configs.length} jest configs`);
  for (const c of configs)
    assert.ok(
      suites.some(s => s.command.includes(c)),
      `no suite runs ${c}`
    );
});

test('every fixture harness under apps/infrastructure/scripts/fixtures has a suite', () => {
  const runners = readdirSync(path.join(REPO_ROOT, 'apps/infrastructure/scripts/fixtures')).filter(
    f => /^run-.*\.sh$/.test(f)
  );
  assert.ok(runners.length >= 7);
  for (const f of runners) {
    assert.ok(
      suites.some(s => commandText(s) === `bash apps/infrastructure/scripts/fixtures/${f}`),
      `no suite runs ${f}`
    );
  }
});

test('the Go, Node, shell, Terraform and browser suites the issue names are all present', () => {
  const ids = new Set(suites.map(s => s.id));
  for (const id of [
    'go-data-pusher',
    'go-device-controller',
    'api',
    'api-emulator',
    'web',
    'web-e2e',
    'api-interfaces',
    'api-specs',
    'data-models',
    'utils',
    'iot-fixture',
    'iot-fixture-sdk',
    'cosmos-export',
    'cosmos-export-sdk',
    'bootstrap',
    'bootstrap-oidc-subject',
    'terraform-tests',
    'playwright-web-e2e',
  ]) {
    assert.ok(ids.has(id), `missing ${id}`);
  }
  const go = suites.filter(s => s.needs.includes('go'));
  for (const s of go) {
    assert.ok(s.command.includes('-race'), `${s.id} runs with the race detector`);
    assert.ok(s.command.includes('-count=1'), `${s.id} bypasses the go test cache`);
  }
});

test('no suite reaches the live cloud or goes through Nx', () => {
  for (const s of suites) {
    const text = commandText(s);
    assert.doesNotMatch(text, /acceptance|playwright\.live|e2e-live/, s.id);
    assert.doesNotMatch(
      text,
      /\bnx\b/,
      `${s.id}: the repeated command must not be an Nx target (cache)`
    );
  }
});

// --- HAR-119: the environment a run gets --------------------------------------

const allowed = (s, name) =>
  envNameMatches(
    name,
    [...ENV_ALLOWLIST, ...HARNESS_ENV, COPY_ENV, ...(s.passEnv ?? [])],
    'linux'
  ) ||
  Object.hasOwn(s.env ?? {}, name) ||
  Object.hasOwn(s.copyEnv?.(1) ?? {}, name);

test('every suite that runs Terraform turns off its checkpoint call, and so does terraform-tests.sh', () => {
  const tf = suites.filter(s => s.needs.includes('terraform'));
  assert.ok(tf.length >= 3, tf.map(s => s.id).join(', '));
  for (const s of tf) assert.equal(s.env?.CHECKPOINT_DISABLE, '1', s.id);
  const script = readFileSync(path.join(REPO_ROOT, 'tools/test-repeat/terraform-tests.sh'), 'utf8');
  assert.match(script, /^export CHECKPOINT_DISABLE=1$/m);
});

test('every variable test-repeat.yml gives the run step is allowlisted, passed, or only the step command line uses it', () => {
  // Nothing a suite needs from CI may be dropped silently. What CI provides is
  // the runner's own variables (GITHUB_*, RUNNER_*, PATH, HOME, ... all
  // allowlisted) and what the workflow sets, which this reads.
  const text = readFileSync(path.join(REPO_ROOT, '.github/workflows/test-repeat.yml'), 'utf8');
  const { workflowEnv, runJobs } = workflowRunEnv(text);
  assert.deepEqual(
    runJobs.map(j => j.name),
    ['repeat', 'repeat-emulator']
  );
  // The emulator job runs the emulator suites; the other job runs the rest.
  const emulator = s => s.needs.includes('cosmos-emulator');
  const suitesOf = job =>
    suites.filter(s => (/emulator_matrix/.test(job.text) ? emulator(s) : !emulator(s)));
  // Used only in ${{ env.NAME }} expressions: never in a process's environment
  // as far as any suite is concerned.
  const expressionOnly = name =>
    new RegExp(`\\benv\\.${name}\\b`).test(text) &&
    !new RegExp(`\\$(?:env:)?\\{?${name}\\b`).test(text);
  let checked = 0;
  for (const job of runJobs) {
    const jobSuites = suitesOf(job);
    assert.ok(jobSuites.length > 0, job.name);
    for (const name of job.env) {
      checked++;
      if (workflowEnv.has(name) && expressionOnly(name)) continue;
      // An input of the harness's own command line in that job's run step
      // (--runs "$RUNS"), not of any suite.
      if (new RegExp(`\\$(?:env:)?\\{?${name}\\b`).test(job.text)) continue;
      const dropped = jobSuites.filter(s => !allowed(s, name)).map(s => s.id);
      assert.deepEqual(
        dropped,
        [],
        `${job.name} sets ${name}, which these suites would never see: add it to their passEnv`
      );
    }
  }
  assert.ok(checked >= 8, `checked ${checked} variables`);
  // The one a suite needs today, pinned: the emulator's TLS certificate.
  assert.ok(runJobs.find(j => j.name === 'repeat-emulator').env.has('NODE_EXTRA_CA_CERTS'));
});

test("every variable a suite's code reads with no fallback is allowlisted, passed, set by the suite, or deliberately dropped", () => {
  // As far as a static scan can tell (test/env-scan.mjs says how far).
  const notEnv = {
    // Shell parameters bash sets itself.
    BASH: 'bash',
    BASH_VERSION: 'bash',
    BASH_SOURCE: 'bash',
    // `$ARGS` and `$ENV{…}` inside jq and perl programs in shell scripts.
    ARGS: 'jq',
    ENV: 'perl',
  };
  const problems = [];
  let scanned = 0;
  for (const s of suites) {
    const files = suiteSourceRoots(REPO_ROOT, s)
      .flatMap(r => sourceFiles(REPO_ROOT, r))
      // The live suites are out of the registry; their code is not run. The
      // harness's own fixtures run under test/fixtures/registry.mjs, with that
      // registry's passEnv, and this file's scan samples are strings.
      .filter(
        f => !/(^|\/)(acceptance|live)\//.test(f) && !f.startsWith('tools/test-repeat/test/')
      );
    scanned += files.length;
    const { reads, writes } = scanEnv(REPO_ROOT, files);
    for (const [name, file] of reads) {
      if (writes.has(name) || allowed(s, name) || notEnv[name] || droppedEnv[name]) continue;
      problems.push(`${s.id}: ${file} reads ${name}`);
    }
  }
  assert.ok(scanned > 300, `scanned ${scanned} files`);
  assert.deepEqual(
    problems,
    [],
    "add each to the suite's passEnv if a run needs it, or to droppedEnv in suites.mjs with the reason"
  );
  for (const [name, why] of Object.entries(droppedEnv))
    assert.ok(why.length > 20 && !envNameMatches(name, ENV_ALLOWLIST), name);
});

test('the env scan sees the read shapes it claims to, and their writes', () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'env-scan-'));
  try {
    const files = {
      'a.ts': [
        'const a = process.env.JS_DOT;',
        "const b = process.env['JS_BRACKET'];",
        "const c = process.env.JS_FALLBACK ?? 'x';",
        "process.env.JS_WRITTEN = '1'; use(process.env.JS_WRITTEN);",
        '// process.env.JS_COMMENT',
      ].join('\n'),
      'b.go': 'v := os.Getenv("GO_READ")\nt.Setenv("GO_SET", "")\n_ = os.Getenv("GO_SET")\n',
      'c.sh': [
        'echo "$SH_PLAIN ${SH_BRACED} ${SH_REQUIRED:?} ${SH_DEFAULTED:-x}"',
        'SH_ASSIGNED=1; echo "$SH_ASSIGNED"',
        'export SH_EXPORTED; echo "$SH_EXPORTED"',
        '# $SH_COMMENT',
      ].join('\n'),
    };
    for (const [f, t] of Object.entries(files)) writeFileSync(path.join(dir, f), t);
    const { reads, writes } = scanEnv(dir, Object.keys(files));
    const external = [...reads.keys()].filter(n => !writes.has(n)).sort();
    assert.deepEqual(external, [
      'GO_READ',
      'JS_BRACKET',
      'JS_DOT',
      'SH_BRACED',
      'SH_PLAIN',
      'SH_REQUIRED',
    ]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('the env scan reads the run step environment test-repeat.yml gives each job', () => {
  const { workflowEnv, runJobs } = workflowRunEnv(
    [
      'env:',
      '  TOP: 1',
      'jobs:',
      '  other:',
      '    steps:',
      '      - run: echo',
      '        env:',
      '          NOT_A_RUN_JOB: 1',
      '  runner:',
      '    steps:',
      '      - run: echo "WRITTEN=1" >> "$GITHUB_ENV"',
      '      - name: Run',
      '        env:',
      '          STEP: x',
      '        run: node tools/test-repeat/test-repeat.mjs run "$STEP"',
    ].join('\n')
  );
  assert.deepEqual([...workflowEnv], ['TOP']);
  assert.deepEqual(
    runJobs.map(j => [j.name, [...j.env].sort()]),
    [['runner', ['STEP', 'TOP', 'WRITTEN']]]
  );
});
