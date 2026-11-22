#!/usr/bin/env node
// HAR-127 — runs the guard's own tests (test/*.test.mjs) and refuses a vacuous
// pass, like tools/test-repeat/run-tests.mjs: `node --test` exits 0 when it
// finds nothing, so the files are listed here and both the file count and the
// executed test count are floored.
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'test');
// Honest counts at the time of writing: 2 files, 63 tests (HAR-127). Raise
// them when the suite grows; never lower them to get a rename through.
const MIN_FILES = 2;
const MIN_TESTS = 63;

const files = readdirSync(DIR)
  .filter(f => f.endsWith('.test.mjs'))
  .sort()
  .map(f => path.join(DIR, f));
if (files.length < MIN_FILES) {
  console.error(
    `no-real-time self-tests: found ${files.length} test files, expected at least ${MIN_FILES}`
  );
  process.exit(1);
}

const r = spawnSync(process.execPath, ['--test', '--test-reporter=spec', ...files], {
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'inherit'],
});
process.stdout.write(r.stdout);
if (r.status !== 0) process.exit(r.status ?? 1);

const tests = Number(/^ℹ tests (\d+)$/m.exec(r.stdout)?.[1] ?? NaN);
const pass = Number(/^ℹ pass (\d+)$/m.exec(r.stdout)?.[1] ?? NaN);
if (!(tests >= MIN_TESTS) || pass !== tests) {
  console.error(
    `no-real-time self-tests: ran ${tests} tests (${pass} passed), expected at least ${MIN_TESTS}, all passing`
  );
  process.exit(1);
}
console.log(`no-real-time self-tests: ${files.length} files, ${tests} tests, all passed`);
