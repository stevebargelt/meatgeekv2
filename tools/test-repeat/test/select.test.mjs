// Affected selection, shard arithmetic and globs, against the real registry.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { suites } from '../suites.mjs';
import { globToRegExp, matchesAny, selectSuites, shardRange, parseShard } from '../lib.mjs';

const selected = sel => sel.suites.filter(s => s.selected);

test('a change under apps/data-pusher/ selects go-data-pusher at 50 runs and nothing else', () => {
  const sel = selectSuites({ suites, changedFiles: ['apps/data-pusher/internal/queue/queue.go'] });
  assert.deepEqual(
    selected(sel).map(s => [s.id, s.runs]),
    [['go-data-pusher', 50]]
  );
  assert.deepEqual(
    sel.entries.map(e => [e.key, e.runs, e.shard, e.go, e.goModFile]),
    [['go-data-pusher', 50, '1/1', true, 'apps/data-pusher/go.mod']]
  );
  assert.equal(sel.harnessChanged, false);
});

test('a change under tools/test-repeat/ selects every suite at 1 run', () => {
  const sel = selectSuites({ suites, changedFiles: ['tools/test-repeat/lib.mjs'] });
  assert.equal(sel.harnessChanged, true);
  assert.equal(selected(sel).length, suites.length);
  for (const s of sel.suites)
    assert.deepEqual([s.id, s.runs, s.reason], [s.id, 1, 'harness changed']);
  // One run cannot be sharded: one job per suite.
  assert.equal(sel.entries.length, suites.length);
});

test('a change to the workflow counts as a harness change', () => {
  const sel = selectSuites({ suites, changedFiles: ['.github/workflows/test-repeat.yml'] });
  assert.equal(sel.harnessChanged, true);
  assert.ok(sel.suites.every(s => s.selected && s.runs === 1));
});

test('a harness change wins over an app change: every suite once', () => {
  const sel = selectSuites({
    suites,
    changedFiles: ['tools/test-repeat/suites.mjs', 'apps/data-pusher/main.go'],
  });
  assert.ok(sel.suites.every(s => s.selected && s.runs === 1));
});

test('label test-repeat:all selects every suite at 50 runs, sharded', () => {
  const sel = selectSuites({
    suites,
    changedFiles: ['tools/test-repeat/lib.mjs'],
    labels: ['test-repeat:all'],
  });
  assert.ok(sel.suites.every(s => s.selected && s.runs === 50));
  const api = sel.entries.filter(e => e.suite === 'api');
  assert.equal(api.length, suites.find(s => s.id === 'api').shards);
  assert.ok(api.length > 1);
  // The shards cover runs 1..50 exactly once.
  const covered = api.flatMap(e => {
    const [i, total] = e.shard.split('/').map(Number);
    const { start, count } = shardRange(e.runs, i, total);
    return Array.from({ length: count }, (_, k) => start + k);
  });
  assert.deepEqual(
    covered,
    Array.from({ length: 50 }, (_, k) => k + 1)
  );
});

test('label test-repeat:load adds one --parallel 8 pass per selected suite', () => {
  const sel = selectSuites({
    suites,
    changedFiles: ['apps/device-controller/main.go'],
    labels: ['test-repeat:load', 'unrelated'],
  });
  assert.deepEqual(
    sel.entries.map(e => [e.key, e.kind, e.runs, e.parallel]),
    [
      ['go-device-controller', 'repeat', 50, 1],
      ['go-device-controller--load', 'load', 1, 8],
    ]
  );
});

test('the load pass respects a suite maxParallel', () => {
  const sel = selectSuites({
    suites,
    changedFiles: ['apps/web-e2e/src/main-path.spec.ts'],
    labels: ['test-repeat:load'],
  });
  const load = sel.entries.find(e => e.key === 'playwright-web-e2e--load');
  assert.equal(load.parallel, 1);
});

test('nothing changed that any suite cares about: nothing selected, every suite still listed', () => {
  const sel = selectSuites({ suites, changedFiles: ['README.md'] });
  assert.equal(sel.entries.length, 0);
  assert.equal(sel.suites.length, suites.length);
  assert.ok(sel.suites.every(s => s.reason === 'not affected'));
});

test('the emulator suite is flagged for its own job', () => {
  const sel = selectSuites({
    suites,
    changedFiles: ['apps/api/src/shared/cosmos/cooks-repository.ts'],
  });
  const emu = sel.entries.filter(e => e.emulator).map(e => e.suite);
  assert.deepEqual(emu, ['api-emulator']);
  assert.ok(sel.entries.some(e => e.suite === 'api' && !e.emulator));
});

test('shardRange splits N runs into contiguous blocks that cover 1..N once', () => {
  for (const runs of [1, 2, 7, 49, 50, 51]) {
    for (const total of [1, 2, 3, 4, 7]) {
      const seen = [];
      for (let i = 1; i <= total; i++) {
        const { start, count } = shardRange(runs, i, total);
        for (let k = 0; k < count; k++) seen.push(start + k);
      }
      assert.deepEqual(
        seen,
        Array.from({ length: runs }, (_, k) => k + 1),
        `runs=${runs} shards=${total}`
      );
    }
  }
  assert.deepEqual(shardRange(50, 1, 4), { start: 1, count: 13 });
  assert.deepEqual(shardRange(50, 4, 4), { start: 39, count: 12 });
});

test('parseShard rejects nonsense', () => {
  assert.deepEqual(parseShard('2/3'), { index: 2, total: 3 });
  for (const bad of ['0/3', '4/3', '1/0', 'x', '1-2']) assert.throws(() => parseShard(bad));
});

test('globs: ** crosses directories, * does not', () => {
  assert.ok(globToRegExp('apps/data-pusher/**').test('apps/data-pusher/a/b/c.go'));
  assert.ok(globToRegExp('apps/data-pusher/**').test('apps/data-pusher/go.mod'));
  assert.ok(!globToRegExp('apps/data-pusher/**').test('apps/data-pusher-x/go.mod'));
  assert.ok(globToRegExp('apps/*/go.mod').test('apps/x/go.mod'));
  assert.ok(!globToRegExp('apps/*/go.mod').test('apps/x/y/go.mod'));
  assert.ok(globToRegExp('**/*.md').test('README.md'));
  assert.ok(globToRegExp('**/*.md').test('a/b/README.md'));
  assert.ok(globToRegExp('package.json').test('package.json'));
  assert.ok(!globToRegExp('package.json').test('apps/api/package.json'));
  assert.ok(!globToRegExp('a.b').test('axb'), 'dots are literal');
  assert.ok(matchesAny('libs/utils/src/x.ts', ['nope/**', 'libs/**']));
});
