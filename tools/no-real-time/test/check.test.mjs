// The CLI, end to end, on the case trees under fixtures/cases/ and on the
// repository itself. Each test runs check.mjs to completion (spawnSync, no
// deadline) and asserts on its exit code and what it printed: no clock is
// involved, so how fast a child process starts cannot decide a result.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseExceptions } from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const CHECK = path.join(HERE, '../check.mjs');
const CASES = path.join(HERE, 'fixtures/cases');
const REAL_EXCEPTIONS = path.join(HERE, '../exceptions.json');

function run(...args) {
  const r = spawnSync(process.execPath, [CHECK, ...args], { encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout, stderr: r.stderr };
}

const onCase = (name, exceptions = path.join(CASES, name, 'exceptions.json')) =>
  run('--root', path.join(CASES, name), '--walk', '--exceptions', exceptions);

function withTempFile(content, fn) {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'no-real-time-'));
  try {
    const file = path.join(dir, 'exceptions.json');
    writeFileSync(file, typeof content === 'string' ? content : JSON.stringify(content));
    return fn(file);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

const HIT_LINE = /^[^\s:]+:\d+: [a-z]+-[a-z0-9-]+: .+ — .+$/;

test('the repository tree passes, and the summary counts files per language', () => {
  const r = run();
  assert.equal(r.status, 0, r.stdout + r.stderr);
  const summary = r.stdout.trim().split('\n').pop();
  const m =
    /^no-real-time: scanned (\d+) files \(go (\d+), ts (\d+), js (\d+), sh (\d+)\); 0 violations, /.exec(
      summary
    );
  assert.ok(m, summary);
  const [total, ...langs] = m.slice(1).map(Number);
  assert.equal(
    langs.reduce((a, b) => a + b, 0),
    total
  );
  for (const n of langs) assert.ok(n > 0, summary);
  assert.match(summary, / 0 stale;/);
});

test('a new spec that sleeps on a real timer fails with its file, line and rule id', () => {
  const r = onCase('probe');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  const lines = r.stdout.trim().split('\n');
  assert.equal(lines.length, 2, r.stdout);
  assert.match(lines[0], /^apps\/web\/src\/zz-guard-probe\.spec\.ts:3: js-timer: /);
  assert.match(lines[0], HIT_LINE);
  assert.match(
    lines[1],
    /^no-real-time: scanned 1 files \(go 0, ts 1, js 0, sh 0\); 1 violation, /
  );
});

test('an exception suppresses its hit', () => {
  const r = onCase('exception');
  assert.equal(r.status, 0, r.stdout + r.stderr);
  assert.match(r.stdout, /0 violations, 1 excepted hit \(1 exception\), 0 stale;/);
  const v = run(
    '--root',
    path.join(CASES, 'exception'),
    '--walk',
    '--exceptions',
    path.join(CASES, 'exception/exceptions.json'),
    '--verbose'
  );
  assert.match(
    v.stdout,
    /^excepted apps\/web\/src\/excepted\.spec\.ts:3: js-timer: .* \(A condition poll with no deadline of its own\.\)$/m
  );
});

test('without its exception the same hit fails', () => {
  withTempFile({ outOfScope: [], exceptions: [] }, file => {
    const r = onCase('exception', file);
    assert.equal(r.status, 1);
    assert.match(r.stdout, /^apps\/web\/src\/excepted\.spec\.ts:3: js-timer: /m);
  });
});

test('a stale exception and a stale out-of-scope path fail the check', () => {
  const r = onCase('stale');
  assert.equal(r.status, 1, r.stdout + r.stderr);
  assert.match(
    r.stdout,
    /^apps\/web\/src\/clean\.spec\.ts: stale exception: js-timer line ".*" matches nothing — delete the entry$/m
  );
  assert.match(
    r.stdout,
    /^apps\/gone\/\*\*: stale out-of-scope path: it matches no file — delete the entry$/m
  );
  assert.match(r.stdout, /0 violations, 0 excepted hits \(1 exception\), 2 stale;/);
});

test('the live paths are skipped; the non-live *.test.ts beside the live proof is not', () => {
  // The real exceptions.json's live entries, without its fixtures entry (which
  // matches nothing in this tree and would be stale here).
  const real = JSON.parse(readFileSync(REAL_EXCEPTIONS, 'utf8'));
  const live = real.outOfScope.filter(e => !e.path.startsWith('tools/no-real-time/'));
  assert.deepEqual(
    live.map(e => e.path),
    [
      'apps/api/acceptance/live.acceptance.ts',
      'apps/api/acceptance/proofs/**',
      'apps/api/acceptance/lib/**',
      'apps/web-e2e/live/**',
      'apps/ios/MeatGeekLiveUITests/**',
    ]
  );
  withTempFile({ outOfScope: live, exceptions: [] }, file => {
    const r = onCase('live', file);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    const hits = r.stdout.split('\n').filter(l => HIT_LINE.test(l));
    assert.deepEqual(
      hits.map(l => l.split(':').slice(0, 3).join(':')),
      [
        'apps/ios/MeatGeekUITests/helpers.test.sh:3: sh-sleep',
        'apps/web-e2e/live/helpers.test.ts:3: js-timer',
      ]
    );
    // devices.spec.ts, clock.test.ts, browser-proof.spec.ts, global-setup.test.mjs,
    // and (HAR-169) the live iOS target's live-proof.test.sh. live.acceptance.ts
    // is not a test file by name, so it was never in scope. The iOS UI tests
    // beside the live target stay in scope: their sleep is a hit.
    assert.match(r.stdout, /5 out of scope by path$/m);
  });
});

test('the guard fixtures are out of scope of the real scan, by path, with a reason', () => {
  const real = JSON.parse(readFileSync(REAL_EXCEPTIONS, 'utf8'));
  const entry = real.outOfScope.find(e => e.path === 'tools/no-real-time/test/fixtures/**');
  assert.ok(entry && entry.reason.trim().length > 0);
});

test('the real exceptions list is short, and every entry has a reason', () => {
  const { config, errors } = parseExceptions(readFileSync(REAL_EXCEPTIONS, 'utf8'));
  assert.deepEqual(errors, []);
  assert.ok(config.exceptions.length <= 15, `${config.exceptions.length} exceptions`);
  for (const e of [...config.exceptions, ...config.outOfScope])
    assert.ok(e.reason.trim().length >= 20, `${e.path}: a reason a reviewer can check`);
});

test('a malformed exceptions file is a configuration error (exit 2), not a pass', () => {
  const cases = [
    ['not json', '{'],
    ['no reason', { exceptions: [{ path: 'a.spec.ts', rule: 'js-timer', line: 'x' }] }],
    [
      'empty reason',
      { exceptions: [{ path: 'a.spec.ts', rule: 'js-timer', line: 'x', reason: ' ' }] },
    ],
    [
      'unknown rule',
      { exceptions: [{ path: 'a.spec.ts', rule: 'js-nap', line: 'x', reason: 'r' }] },
    ],
    [
      'line and pattern',
      {
        exceptions: [{ path: 'a.spec.ts', rule: 'js-timer', line: 'x', pattern: 'x', reason: 'r' }],
      },
    ],
    ['neither', { exceptions: [{ path: 'a.spec.ts', rule: 'js-timer', reason: 'r' }] }],
    [
      'bad pattern',
      { exceptions: [{ path: 'a.spec.ts', rule: 'js-timer', pattern: '(', reason: 'r' }] },
    ],
    ['out of scope without a reason', { outOfScope: [{ path: 'apps/**' }] }],
  ];
  for (const [what, content] of cases)
    withTempFile(content, file => {
      const r = onCase('exception', file);
      assert.equal(r.status, 2, `${what}: ${r.stdout}${r.stderr}`);
      assert.match(r.stderr, /^no-real-time: /m, what);
    });
});

test('an unknown argument is a usage error (exit 2)', () => {
  const r = run('--nope');
  assert.equal(r.status, 2);
  assert.match(r.stderr, /unknown argument --nope/);
});
