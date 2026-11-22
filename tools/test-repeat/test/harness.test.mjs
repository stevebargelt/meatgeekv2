// The repeat loop, end to end: the real CLI against fixture suites.
//
// HAR-119: nothing here waits on a clock. Each test runs the CLI to completion
// (spawnSync, no timeout) and asserts on what it printed and wrote; no fixture
// run has a hang guard (fixtures/registry.mjs), so how fast a child starts
// cannot decide a result. The one hang guard is the test-repeat-harness
// suite's timeoutSec.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(HERE, '..', 'test-repeat.mjs');
const REGISTRY = path.join(HERE, 'fixtures', 'registry.mjs');

function harness(args, env = {}, { logDir } = {}) {
  const work = mkdtempSync(path.join(os.tmpdir(), 'test-repeat-selftest-'));
  const result = path.join(work, 'result.json');
  const r = spawnSync(
    process.execPath,
    [
      CLI,
      ...args,
      '--registry',
      REGISTRY,
      '--result',
      result,
      '--log-dir',
      logDir ?? path.join(work, 'logs'),
    ],
    // An env value of undefined unsets that variable for the CLI.
    {
      encoding: 'utf8',
      env: Object.fromEntries(
        Object.entries({ ...process.env, ...env }).filter(([, v]) => v !== undefined)
      ),
    }
  );
  let json = null;
  try {
    json = JSON.parse(readFileSync(result, 'utf8'));
  } catch {
    // No result file; the assertions below say so.
  }
  return { ...r, json, work, cleanup: () => rmSync(work, { recursive: true, force: true }) };
}

test('a suite that fails on run 3 of 5 exits non-zero and reports 2/5 passed, failed on run 3', () => {
  const r = harness(['run', 'fixture-fail-on-3', '--runs', '5']);
  try {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^fixture-fail-on-3: 2\/5 passed, failed on run 3$/m);
    // It stopped at the first failure: runs 4 and 5 never started.
    assert.match(r.stdout, /run 2 passed/);
    assert.match(r.stdout, /run 3 FAILED \(exit 1/);
    assert.doesNotMatch(r.stdout, /run 4/);
    // The failing run's output tail is printed, and only its tail.
    assert.match(r.stdout, /output tail of failing run 3/);
    assert.match(r.stdout, /boom on invocation 3/);
    assert.doesNotMatch(r.stdout, /fixture filler line 100\b/);
    assert.equal(r.json.requested, 5);
    assert.equal(r.json.passed, 2);
    assert.equal(r.json.failedRun, 3);
    assert.equal(r.json.ok, false);
    // The failing run's full log is kept, the passing runs' logs are not, and
    // the tail's header names the kept file.
    const logs = readdirSync(path.join(r.work, 'logs'));
    assert.equal(logs.length, 1, logs.join(', '));
    assert.match(logs[0], /^fixture-fail-on-3-repeat-[0-9a-f]{8}-copy1-run3\.log$/);
    assert.equal(fullLogNamed(r.stdout), path.join(r.work, 'logs', logs[0]));
    assert.equal(r.json.copies[0].failedLog, path.join(r.work, 'logs', logs[0]));
  } finally {
    r.cleanup();
  }
});

test('a passing suite reports 5/5 and exits 0', () => {
  const r = harness(['run', 'fixture-pass', '--runs', '5']);
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^fixture-pass: 5\/5 passed$/m);
    for (let n = 1; n <= 5; n++) assert.match(r.stdout, new RegExp(`run ${n} passed`));
    assert.equal(r.json.passed, 5);
    assert.equal(r.json.failedRun, null);
    assert.equal(r.json.runDurationsMs.length, 5);
    assert.equal(r.json.ok, true);
  } finally {
    r.cleanup();
  }
});

test('every run really executes: the invocation count of the suite advances each run', () => {
  // fixture-fail-on-3 fails only if its third invocation happens, so a harness
  // that skipped or cached runs could not produce "failed on run 3".
  const r = harness(['run', 'fixture-fail-on-3', '--runs', '2']);
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.match(r.stdout, /^fixture-fail-on-3: 2\/2 passed$/m);
  } finally {
    r.cleanup();
  }
});

test('--parallel 3 runs three concurrent copies, each in its own temp dir, reported per copy', () => {
  // Each copy of fixture-barrier finishes only once all three have started, so
  // the run can pass only if the copies are alive at the same time. No clock
  // is involved: however slowly the copies start, the last one releases all
  // three. (Were they serial, the first copy would wait for ever: a hang, not
  // a pass.)
  const barrier = mkdtempSync(path.join(os.tmpdir(), 'test-repeat-barrier-'));
  const r = harness(['run', 'fixture-barrier', '--runs', '1', '--parallel', '3'], {
    BARRIER_DIR: barrier,
    BARRIER_COUNT: '3',
  });
  try {
    assert.equal(r.status, 0, r.stdout + r.stderr);
    for (let c = 1; c <= 3; c++)
      assert.match(r.stdout, new RegExp(`^fixture-barrier \\[copy ${c}/3\\]: 1/1 passed$`, 'm'));
    assert.match(r.stdout, /^fixture-barrier: 3\/3 parallel copies passed$/m);
    const markers = readdirSync(barrier).map(f =>
      JSON.parse(readFileSync(path.join(barrier, f), 'utf8'))
    );
    assert.equal(markers.length, 3);
    assert.equal(new Set(markers.map(m => m.pid)).size, 3);
    assert.equal(new Set(markers.map(m => m.tmpdir)).size, 3, 'each copy gets its own temp dir');
    assert.equal(r.json.parallel, 3);
    assert.equal(r.json.copies.length, 3);
    assert.equal(new Set(r.json.copies.map(c => c.tmpdir)).size, 3);
    assert.equal(r.json.passed, 3);
  } finally {
    r.cleanup();
    rmSync(barrier, { recursive: true, force: true });
  }
});

test('parallel copies count their runs separately and fail separately', () => {
  const r = harness(['run', 'fixture-fail-on-3', '--runs', '4', '--parallel', '2']);
  try {
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stdout, /^fixture-fail-on-3 \[copy 1\/2\]: 2\/4 passed, failed on run 3$/m);
    assert.match(r.stdout, /^fixture-fail-on-3 \[copy 2\/2\]: 2\/4 passed, failed on run 3$/m);
    assert.match(r.stdout, /^fixture-fail-on-3: 0\/2 parallel copies passed$/m);
  } finally {
    r.cleanup();
  }
});

test('loadArgs reach every copy under --parallel and never the serial pass', () => {
  // The fixture fails when it is given --load-only, its suite's loadArgs.
  const serial = harness(['run', 'fixture-load-args', '--runs', '2']);
  try {
    assert.equal(serial.status, 0, serial.stdout + serial.stderr);
    assert.match(serial.stdout, /^fixture-load-args: 2\/2 passed$/m);
    assert.doesNotMatch(serial.stdout, /each copy runs with/);
    assert.deepEqual(serial.json.loadArgs, []);
  } finally {
    serial.cleanup();
  }
  const load = harness(['run', 'fixture-load-args', '--runs', '1', '--parallel', '2']);
  try {
    assert.equal(load.status, 1, load.stdout + load.stderr);
    assert.match(
      load.stdout,
      /^fixture-load-args: each copy runs with --load-only: fixture reason$/m
    );
    assert.match(load.stdout, /^fixture-load-args \[copy 1\/2\]: 0\/1 passed, failed on run 1$/m);
    assert.match(load.stdout, /^fixture-load-args \[copy 2\/2\]: 0\/1 passed, failed on run 1$/m);
    assert.match(load.stdout, /refused: ran with --load-only/);
    assert.deepEqual(load.json.loadArgs, ['--load-only']);
  } finally {
    load.cleanup();
  }
});

test('a shard runs its own block of run numbers', () => {
  // 5 runs over 2 shards: shard 1 is runs 1-3, shard 2 is runs 4-5. The
  // fixture's count restarts per invocation of the harness, so shard 2's
  // third local run never happens and it passes.
  const one = harness(['run', 'fixture-fail-on-3', '--runs', '5', '--shard', '1/2']);
  const two = harness(['run', 'fixture-fail-on-3', '--runs', '5', '--shard', '2/2']);
  try {
    assert.equal(one.status, 1);
    assert.match(one.stdout, /shard 1\/2, runs 1-3/);
    assert.match(one.stdout, /^fixture-fail-on-3: 2\/3 passed, failed on run 3$/m);
    assert.equal(two.status, 0, two.stdout + two.stderr);
    assert.match(two.stdout, /shard 2\/2, runs 4-5/);
    assert.match(two.stdout, /run 4 passed/);
    assert.match(two.stdout, /run 5 passed/);
    assert.deepEqual([two.json.startRun, two.json.requested], [4, 2]);
  } finally {
    one.cleanup();
    two.cleanup();
  }
});

test('a failing prepare step exits 2 and writes a failed result', () => {
  const r = harness(['run', 'fixture-prepare-fails', '--runs', '3']);
  try {
    assert.equal(r.status, 2, r.stdout + r.stderr);
    assert.match(r.stderr, /prepare step .* exited 4/);
    assert.equal(r.json.ok, false);
    assert.equal(r.json.passed, 0);
  } finally {
    r.cleanup();
  }
});

test('an unknown suite is a usage error', () => {
  const r = harness(['run', 'no-such-suite']);
  try {
    assert.equal(r.status, 2);
    assert.match(r.stderr, /unknown suite no-such-suite/);
  } finally {
    r.cleanup();
  }
});

/** The path in the "full log <path>" of the output-tail header. */
function fullLogNamed(stdout) {
  return /; full log (.+?)\) -----$/m.exec(stdout)?.[1] ?? null;
}

test('two invocations into the same log dir that both fail on run 1 leave two distinct logs', () => {
  // HAR-119: the load pass after the serial pass, or a re-run, writes into the
  // same --log-dir. Each invocation's failing log must survive the other.
  const logDir = mkdtempSync(path.join(os.tmpdir(), 'test-repeat-shared-logs-'));
  const first = harness(['run', 'fixture-fail-first', '--runs', '3'], {}, { logDir });
  const second = harness(['run', 'fixture-fail-first', '--runs', '3'], {}, { logDir });
  try {
    for (const r of [first, second]) {
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stdout, /^fixture-fail-first: 0\/3 passed, failed on run 1$/m);
    }
    const logs = readdirSync(logDir).sort();
    assert.equal(logs.length, 2, logs.join(', '));
    for (const l of logs) {
      assert.match(l, /^fixture-fail-first-repeat-[0-9a-f]{8}-copy1-run1\.log$/);
      assert.match(readFileSync(path.join(logDir, l), 'utf8'), /boom on invocation 1/);
    }
    // Each invocation's printed path is its own log, and both still exist.
    const named = [first, second].map(r => fullLogNamed(r.stdout));
    assert.notEqual(named[0], named[1]);
    assert.deepEqual(
      [...named].sort(),
      logs.map(l => path.join(logDir, l))
    );
    for (const p of named) assert.ok(existsSync(p), p);
  } finally {
    first.cleanup();
    second.cleanup();
    rmSync(logDir, { recursive: true, force: true });
  }
});

test("a variable in the caller's environment reaches no run, and no prepare step, unless passEnv lists it", () => {
  // HAR-112: TF_DESTROY_GUARD_* set in the caller's shell reached every suite.
  const caller = { TF_DESTROY_GUARD_EXPECTED_DESTROYS: 'x', FIXTURE_FROM_SUITE: 'from-caller' };
  const dropped = harness(['run', 'fixture-env-dropped', '--runs', '2'], caller);
  try {
    // Unset in the run; the suite's own env wins over the caller's; the
    // allowlist (PATH) and the harness's TMPDIR still arrive. The prepare step
    // exits 5 if it sees the variable.
    assert.equal(dropped.status, 0, dropped.stdout + dropped.stderr);
    assert.match(dropped.stdout, /^fixture-env-dropped: 2\/2 passed$/m);
  } finally {
    dropped.cleanup();
  }
  const passed = harness(['run', 'fixture-env-passed', '--runs', '2'], caller);
  try {
    // The control: the same caller variable does arrive when passEnv lists it,
    // so the first case proves a drop, not a variable that was never there.
    assert.equal(passed.status, 0, passed.stdout + passed.stderr);
    assert.match(passed.stdout, /^fixture-env-passed: 2\/2 passed$/m);
  } finally {
    passed.cleanup();
  }
  const missing = harness(['run', 'fixture-env-passed', '--runs', '1', '--skip-prepare'], {
    TF_DESTROY_GUARD_EXPECTED_DESTROYS: undefined,
  });
  try {
    // And the fixture really checks: without the caller variable it fails.
    assert.equal(missing.status, 1, missing.stdout + missing.stderr);
    assert.match(
      missing.stdout,
      /env mismatch: wanted TF_DESTROY_GUARD_EXPECTED_DESTROYS=x, got TF_DESTROY_GUARD_EXPECTED_DESTROYS=\(unset\)/
    );
  } finally {
    missing.cleanup();
  }
});
