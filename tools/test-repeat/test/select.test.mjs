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

// Every suite runs once on a harness change, except the harness's own tests,
// which run the full 50: [id, runs] for the whole registry.
const onHarnessChange = () => suites.map(s => [s.id, s.id === 'test-repeat-harness' ? 50 : 1]);

test('a change under tools/test-repeat/ selects every suite at 1 run, its own tests at 50', () => {
  const sel = selectSuites({ suites, changedFiles: ['tools/test-repeat/lib.mjs'] });
  assert.equal(sel.harnessChanged, true);
  assert.equal(selected(sel).length, suites.length);
  assert.deepEqual(
    sel.suites.map(s => [s.id, s.runs]),
    onHarnessChange()
  );
  for (const s of sel.suites)
    assert.equal(
      s.reason,
      s.id === 'test-repeat-harness' ? 'harness changed (self-test)' : 'harness changed'
    );
  // One run cannot be sharded: one job per suite (the self-test suite has no
  // shards either).
  assert.equal(sel.entries.length, suites.length);
  assert.deepEqual(
    sel.entries.filter(e => e.runs === 50).map(e => e.key),
    ['test-repeat-harness']
  );
});

test('the self-test suite is selected by a harness change and by nothing else', () => {
  const self = suites.filter(s => s.selfTest);
  assert.deepEqual(
    self.map(s => s.id),
    ['test-repeat-harness']
  );
  const sel = selectSuites({ suites, changedFiles: ['apps/data-pusher/main.go'] });
  assert.equal(sel.suites.find(s => s.id === 'test-repeat-harness').selected, false);
});

test('a change to the workflow counts as a harness change', () => {
  const sel = selectSuites({ suites, changedFiles: ['.github/workflows/test-repeat.yml'] });
  assert.equal(sel.harnessChanged, true);
  assert.ok(sel.suites.every(s => s.selected));
  assert.deepEqual(
    sel.suites.map(s => [s.id, s.runs]),
    onHarnessChange()
  );
});

test('a harness change wins over an app change: every suite once', () => {
  const sel = selectSuites({
    suites,
    changedFiles: ['tools/test-repeat/suites.mjs', 'apps/data-pusher/main.go'],
  });
  assert.ok(sel.suites.every(s => s.selected));
  assert.deepEqual(
    sel.suites.map(s => [s.id, s.runs]),
    onHarnessChange()
  );
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
  const capped = [
    { id: 'capped', paths: ['capped/**'], needs: [], command: ['true'], maxParallel: 2 },
  ];
  const sel = selectSuites({
    suites: capped,
    changedFiles: ['capped/x'],
    labels: ['test-repeat:load'],
  });
  const load = sel.entries.find(e => e.key === 'capped--load');
  assert.equal(load.parallel, 2);
});

test('playwright-web-e2e runs its load pass as 8 copies, each on its own port (HAR-121)', () => {
  const sel = selectSuites({
    suites,
    changedFiles: ['apps/web-e2e/src/main-path.spec.ts'],
    labels: ['test-repeat:load'],
  });
  const load = sel.entries.find(e => e.key === 'playwright-web-e2e--load');
  assert.equal(load.parallel, 8);
  const pw = suites.find(s => s.id === 'playwright-web-e2e');
  assert.equal(pw.maxParallel, undefined);
  const ports = Array.from({ length: 8 }, (_, i) => pw.copyEnv(i + 1).WEB_E2E_PORT);
  assert.deepEqual(ports, ['4301', '4302', '4303', '4304', '4305', '4306', '4307', '4308']);
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
