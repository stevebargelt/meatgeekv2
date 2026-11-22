// The job-summary table.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { renderSummary, selectSuites, shardRange } from '../lib.mjs';

const reg = [
  { id: 'alpha', command: ['x'], paths: ['alpha/**'], needs: [], shards: 2 },
  { id: 'beta', command: ['x'], paths: ['beta/**'], needs: [] },
  { id: 'gamma', command: ['x'], paths: ['gamma/**'], needs: [] },
];

function result(entry, { passed, failedRun = null, perRunMs = 1000, copies, loadArgs = [] } = {}) {
  const [i, total] = entry.shard.split('/').map(Number);
  const { start, count } = shardRange(entry.runs, i, total);
  const requested = count * entry.parallel;
  const p = passed ?? requested;
  return {
    suite: entry.suite,
    kind: entry.kind,
    shard: entry.shard,
    runsTotal: entry.runs,
    startRun: start,
    requested,
    passed: p,
    failedRun,
    parallel: entry.parallel,
    parallelNote: null,
    loadArgs,
    durationMs: perRunMs * (p + (failedRun ? 1 : 0)),
    runDurationsMs: Array.from({ length: p }, () => perRunMs),
    copies: copies ?? [{ copy: 1, failedRun }],
    ok: failedRun === null,
  };
}

const rowOf = (md, name) => md.split('\n').find(l => l.startsWith(`| ${name} |`));

test('one row per suite; an unaffected suite says "not affected"; shards are totalled', () => {
  const sel = selectSuites({ suites: reg, changedFiles: ['alpha/x', 'beta/y'] });
  const results = sel.entries.map(e => result(e));
  const { markdown, ok } = renderSummary(sel, results);
  assert.equal(ok, true);
  assert.match(
    markdown,
    /\| suite \| affected\? \| runs requested \| runs passed \| first failing run \| duration \|/
  );
  assert.equal(
    rowOf(markdown, 'alpha'),
    '| alpha | yes (1 file) | 50 | 50/50 | — | 50s (1.0s/run, 2 shards) |'
  );
  assert.equal(
    rowOf(markdown, 'beta'),
    '| beta | yes (1 file) | 50 | 50/50 | — | 50s (1.0s/run) |'
  );
  assert.equal(rowOf(markdown, 'gamma'), '| gamma | not affected | — | — | — | — |');
});

test('a failing shard reports the lowest failing run and fails the summary', () => {
  const sel = selectSuites({ suites: reg, changedFiles: ['alpha/x'] });
  const [s1, s2] = sel.entries;
  const results = [result(s1), result(s2, { passed: 3, failedRun: 30 })];
  const { markdown, ok, problems } = renderSummary(sel, results);
  assert.equal(ok, false);
  assert.match(rowOf(markdown, 'alpha'), /\| 50 \| 28\/50 \| run 30 \|/);
  assert.deepEqual(problems, ['alpha: 28/50 passed, first failure run 30']);
});

test('a job that reported nothing fails the summary instead of vanishing', () => {
  const sel = selectSuites({ suites: reg, changedFiles: ['alpha/x'] });
  const { markdown, ok } = renderSummary(sel, [result(sel.entries[0])]);
  assert.equal(ok, false);
  assert.match(rowOf(markdown, 'alpha'), /25\/50 — no result from shard 2\/2/);
});

test('harness change: every suite 1/1, and the header says why', () => {
  const sel = selectSuites({ suites: reg, changedFiles: ['tools/test-repeat/lib.mjs'] });
  const { markdown, ok } = renderSummary(
    sel,
    sel.entries.map(e => result(e))
  );
  assert.equal(ok, true);
  assert.match(markdown, /The harness itself changed/);
  for (const id of ['alpha', 'beta', 'gamma'])
    assert.match(rowOf(markdown, id), /\| harness changed \| 1 \| 1\/1 \| — \|/);
});

test('a load pass gets its own row, counted in copies', () => {
  const sel = selectSuites({ suites: reg, changedFiles: ['beta/y'], labels: ['test-repeat:load'] });
  const load = sel.entries.find(e => e.kind === 'load');
  const results = [
    result(sel.entries.find(e => e.kind === 'repeat')),
    result(load, {
      passed: 7,
      failedRun: 1,
      copies: Array.from({ length: 8 }, (_, i) => ({ copy: i + 1, failedRun: i === 4 ? 1 : null })),
    }),
  ];
  const { markdown, ok } = renderSummary(sel, results);
  assert.equal(ok, false);
  assert.match(rowOf(markdown, 'beta (load x8)'), /\| 8 \| 7\/8 \| copy 5 \|/);
});

test("a load pass's loadArgs are named in its row, and only in its row", () => {
  const sel = selectSuites({ suites: reg, changedFiles: ['beta/y'], labels: ['test-repeat:load'] });
  const results = [
    result(sel.entries.find(e => e.kind === 'repeat')),
    result(
      sel.entries.find(e => e.kind === 'load'),
      { loadArgs: ['--maxWorkers=1'] }
    ),
  ];
  const { markdown, ok } = renderSummary(sel, results);
  assert.equal(ok, true);
  assert.match(rowOf(markdown, 'beta (load x8)'), /\(each copy: `--maxWorkers=1`\)/);
  assert.doesNotMatch(rowOf(markdown, 'beta'), /each copy/);
});

test("harness change: the harness's own tests run the full count, and the header says so", () => {
  const withSelf = [
    ...reg,
    { id: 'self', command: ['x'], paths: ['self/**'], needs: [], selfTest: true },
  ];
  const sel = selectSuites({ suites: withSelf, changedFiles: ['tools/test-repeat/lib.mjs'] });
  const { markdown, ok } = renderSummary(
    sel,
    sel.entries.map(e => result(e))
  );
  assert.equal(ok, true);
  assert.match(
    markdown,
    /so every suite runs once, except the harness's own tests \(self\), which run 50 times\./
  );
  assert.equal(
    rowOf(markdown, 'self'),
    '| self | harness changed (self-test) | 50 | 50/50 | — | 50s (1.0s/run) |'
  );
  assert.match(rowOf(markdown, 'beta'), /\| harness changed \| 1 \| 1\/1 \| — \|/);
});
