#!/usr/bin/env node
// Runs the cosmos-export suites and REFUSES a vacuous pass.
//
// `node --test` exits 0 when it discovers nothing — a renamed, deleted or
// unreadable test file leaves the gate green while asserting nothing at all.
// That is the same fail-open shape as MG-42 finding F5 (a bash suite that
// truncated at 229/321 and still looked like a pass), and it is exactly the
// failure this tool exists to refuse in its own domain. So discovery and the
// executed test count are both floored here.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const MIN_TEST_FILES = 2;
const MIN_TESTS = 45;

const files = readdirSync(DIR)
  .filter(name => name.endsWith('.test.mjs'))
  .sort();

if (files.length < MIN_TEST_FILES) {
  console.error(
    `run-tests: discovered ${files.length} test file(s) in ${DIR}, expected at least ${MIN_TEST_FILES} — refusing to report a pass`
  );
  process.exit(1);
}

const result = spawnSync(
  process.execPath,
  ['--test', '--test-reporter=tap', ...files.map(name => path.join(DIR, name))],
  { encoding: 'utf8' }
);
process.stdout.write(result.stdout ?? '');
process.stderr.write(result.stderr ?? '');

if (result.status !== 0) {
  process.exit(result.status ?? 1);
}

const executed = Number(/^# tests (\d+)$/m.exec(result.stdout ?? '')?.[1]);
if (!Number.isInteger(executed) || executed < MIN_TESTS) {
  console.error(
    `run-tests: ${files.length} file(s) reported ${executed} test(s), expected at least ${MIN_TESTS} — the suite did not run to completion`
  );
  process.exit(1);
}

console.log(`run-tests: ${executed} test(s) across ${files.length} file(s) passed`);
