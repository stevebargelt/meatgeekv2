// The rules, against the fixtures under fixtures/rules/. A fixture marks each
// line it expects a hit on with a trailing `expect: <rule id>` comment; every
// other line, including the near misses beside each violation, must have none.
// These tests read files and call the scanner: no clock, no child process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  fakeClockOf,
  globToRegExp,
  inScope,
  languageOf,
  lexJs,
  lexSh,
  RULES,
  scanText,
  walkFiles,
} from '../lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const RULES_ROOT = path.join(HERE, 'fixtures/rules');
const FILES = walkFiles(RULES_ROOT);
const read = f => readFileSync(path.join(RULES_ROOT, f), 'utf8');

/** `${line}:${rule}` for every `expect:` marker in a fixture. */
function expected(text) {
  const want = new Set();
  text.split('\n').forEach((l, k) => {
    const m = /expect:\s*([\w-]+(?:[ ,]+[\w-]+)*)/.exec(l);
    if (m) for (const rule of m[1].split(/[ ,]+/)) want.add(`${k + 1}:${rule}`);
  });
  return want;
}

test('the rules fixtures exist and are all in scope', () => {
  assert.ok(FILES.length >= 40, `found ${FILES.length} fixture files`);
  for (const f of FILES) assert.ok(inScope(f), `${f} is not in the guard's scope`);
});

for (const f of FILES) {
  test(`fixture ${f}: a hit on exactly the marked lines, with the marked rule ids`, () => {
    const text = read(f);
    const got = scanText(f, text).hits.map(h => `${h.line}:${h.rule}`);
    assert.deepEqual([...new Set(got)].sort(), [...expected(text)].sort());
  });
}

test('every rule has a violating fixture in each language it applies to', () => {
  const covered = new Set();
  for (const f of FILES)
    for (const key of expected(read(f))) covered.add(`${key.split(':')[1]}:${languageOf(f)}`);
  for (const rule of RULES)
    for (const lang of rule.langs) {
      // The Playwright rules apply under apps/web-e2e/src, where the specs are TS.
      if (rule.paths && lang === 'js') continue;
      assert.ok(covered.has(`${rule.id}:${lang}`), `no ${lang} fixture fails ${rule.id}`);
    }
});

test('each language has a clean fixture that passes', () => {
  for (const [lang, file] of [
    ['go', 'go/clean_test.go'],
    ['ts', 'js/clean.spec.ts'],
    ['js', 'js/clean.test.mjs'],
    ['sh', 'sh/clean.test.sh'],
    ['ts', 'apps/web-e2e/src/clean.spec.ts'],
  ]) {
    assert.equal(languageOf(file), lang);
    assert.deepEqual(scanText(file, read(file)).hits, [], file);
  }
});

test('a Jest file that installs fake timers may call the timers and the Date they fake', () => {
  for (const f of ['js/fake-timers.spec.ts', 'js/fake-timers.test.mjs']) {
    const text = read(f);
    const { hits, fakeClock } = scanText(f, text);
    assert.equal(fakeClock, 'fake timers', f);
    assert.match(text, /\bsetTimeout\(fired, 1000\)/);
    assert.deepEqual(
      hits.map(h => h.rule),
      ['js-performance-now', 'js-sleep'],
      `${f}: only the rules fake timers do not cover`
    );
    // Without the install line the same calls are hits.
    const unfaked = text.replace(/jest\.useFakeTimers\([^\n]*\)\)/, 'undefined)');
    const rules = new Set(scanText(f, unfaked).hits.map(h => h.rule));
    for (const r of ['js-timer', 'js-date-now', 'js-new-date'])
      assert.ok(rules.has(r), `${f}: ${r}`);
  }
});

test('a Go file that uses synctest may sleep and read time; Eventually and fixed ports stay hits', () => {
  const f = 'go/synctest_test.go';
  const text = read(f);
  const { hits, fakeClock } = scanText(f, text);
  assert.equal(fakeClock, 'synctest');
  assert.deepEqual(
    hits.map(h => h.rule),
    ['go-eventually', 'go-fixed-port']
  );
  assert.equal(fakeClockOf('go', read('go/go-sleep_test.go')), null);
});

test('rule ids are unique and stable in form, and each says what it found and how to fix it', () => {
  const ids = RULES.map(r => r.id);
  assert.equal(new Set(ids).size, ids.length);
  for (const r of RULES) {
    assert.match(r.id, /^(go|js|pw|sh)-[a-z0-9-]+$/, r.id);
    assert.ok(r.found && r.fix, r.id);
    assert.ok(!r.fix.includes('\n'), `${r.id}: the fix is one line`);
  }
});

test('the JS lexer blanks comments and masks strings without moving any offset', () => {
  const src = readFileSync(path.join(HERE, 'fixtures/lexer/js-sample.txt'), 'utf8');
  const { code, masked } = lexJs(src);
  assert.equal(code.length, src.length);
  assert.equal(masked.length, src.length);
  assert.deepEqual(
    code.split('\n').map(l => l.length),
    src.split('\n').map(l => l.length)
  );
  assert.doesNotMatch(code, /setTimeout|Date\.now/);
  assert.match(code, /'x \/\/ y'/, 'a string keeps its text in the code view');
  assert.doesNotMatch(masked, /x \/\/ y/, 'and loses it in the masked view');
  assert.match(masked, /\bf\(/, 'code inside ${} is still code');
  assert.match(code.split('\n')[4], /next\(\);/, 'an apostrophe in JSX text ends at its line');
});

test('the shell lexer strips comments, not a # inside quotes or ${#var}', () => {
  const src = readFileSync(path.join(HERE, 'fixtures/lexer/sh-sample.txt'), 'utf8');
  const { code } = lexSh(src);
  assert.doesNotMatch(code, /sleep/);
  assert.match(code, /"a # b"/);
  assert.match(code, /'c # d'/);
  assert.match(code, /\$\{#arr\[@\]\}/);
});

test('globs: ** crosses directories, * does not', () => {
  assert.ok(globToRegExp('**/*_test.go').test('apps/x/y_test.go'));
  assert.ok(globToRegExp('**/*_test.go').test('y_test.go'));
  assert.ok(globToRegExp('apps/web-e2e/live/*.test.ts').test('apps/web-e2e/live/a.test.ts'));
  assert.ok(!globToRegExp('apps/web-e2e/live/*.test.ts').test('apps/web-e2e/live/x/a.test.ts'));
  assert.ok(
    globToRegExp('tools/no-real-time/test/fixtures/**').test(
      'tools/no-real-time/test/fixtures/a/b.go'
    )
  );
});
