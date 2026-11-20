#!/usr/bin/env node
// Runs the cosmos-export suites and REFUSES a vacuous pass.
//
// `node --test` exits 0 when it discovers nothing — a renamed, deleted or
// unreadable test file leaves the gate green while asserting nothing at all.
// That is the same fail-open shape as MG-42 finding F5 (a bash suite that
// truncated at 229/321 and still looked like a pass), and it is exactly the
// failure this tool exists to refuse in its own domain. So discovery and the
// executed test count are both floored here.
//
// Two tiers, selected by argument, because they need different CI homes:
//
//   (default)  every *.test.mjs EXCEPT *.sdk.test.mjs — node: built-ins and the
//              local fake only. Runs in validate-infrastructure, which installs
//              nothing and holds no credentials.
//   --sdk      *.sdk.test.mjs only — takes createRealClient's real
//              `import('@azure/cosmos')` / `import('@azure/identity')`, so it
//              needs a real node_modules and runs in lint-and-test after
//              `npm ci`.
//
// One wrapper rather than two: the anti-vacuity floors are the whole point of
// this file, and a second wrapper would be a second place for them to drift or
// be quietly omitted. Both tiers get the same discovery-and-count refusal, only
// the pattern and the floors differ.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SDK_SUFFIX = '.sdk.test.mjs';

// Floors are the honest current counts less a small margin, not aspirations:
// they exist to catch a suite that stops running, not to police growth.
const TIERS = {
  default: {
    label: 'dependency-free',
    match: name => name.endsWith('.test.mjs') && !name.endsWith(SDK_SUFFIX),
    minFiles: 2,
    minTests: 45,
  },
  sdk: {
    label: 'real-SDK',
    match: name => name.endsWith(SDK_SUFFIX),
    minFiles: 1,
    minTests: 2,
  },
};

// HAR-81: the exit code is SET, never forced with process.exit(). In CI the
// step's stdout is a pipe, and on a pipe process.stdout.write() is
// asynchronous: process.exit() ends the process without waiting for it, so
// everything past the ~64 KiB pipe buffer is dropped. This suite prints far
// more TAP than that, so a failing run used to exit 1 with its output cut
// mid-line and every `not ok` line lost (CI run 44791467254: the log stops at
// "ok 1 - emits a recor"). Returning from main() lets Node flush stdout and
// stderr before the process ends. A failure also ends with a summary on stderr
// that names how node --test ended and repeats its `not ok` lines.
process.exitCode = main();

function main() {
  const arg = process.argv[2];
  if (arg !== undefined && arg !== '--sdk') {
    console.error(`run-tests: unknown argument '${arg}' — expected no argument or --sdk`);
    return 1;
  }
  const tier = arg === '--sdk' ? TIERS.sdk : TIERS.default;

  const files = readdirSync(DIR).filter(tier.match).sort();

  if (files.length < tier.minFiles) {
    console.error(
      `run-tests[${tier.label}]: discovered ${files.length} test file(s) in ${DIR}, expected at least ${tier.minFiles} — refusing to report a pass`
    );
    return 1;
  }

  const result = spawnSync(
    process.execPath,
    ['--test', '--test-reporter=tap', ...files.map(name => path.join(DIR, name))],
    { encoding: 'utf8', maxBuffer: maxOutputBytes() }
  );
  process.stdout.write(result.stdout ?? '');
  process.stderr.write(result.stderr ?? '');

  if (result.error || result.status !== 0) {
    console.error(failureSummary(tier.label, result));
    return result.status ? result.status : 1;
  }

  const executed = Number(/^# tests (\d+)$/m.exec(result.stdout ?? '')?.[1]);
  if (!Number.isInteger(executed) || executed < tier.minTests) {
    console.error(
      `run-tests[${tier.label}]: ${files.length} file(s) reported ${executed} test(s), expected at least ${tier.minTests} — the suite did not run to completion`
    );
    return 1;
  }

  console.log(`run-tests[${tier.label}]: ${executed} test(s) across ${files.length} file(s) passed`);
  return 0;
}

/**
 * The child's output limit. spawnSync's default is 1 MiB; past it the child is
 * killed and the output cut, the same silent truncation as above. 64 MiB is far
 * beyond any suite here, and running into it is reported, not hidden.
 */
function maxOutputBytes() {
  return 64 * 1024 * 1024;
}

/** How node --test ended, plus its `not ok` lines, for the end of a failed run. */
function failureSummary(label, result) {
  const how = result.error
    ? `did not complete (${result.error.code ?? result.error.message})`
    : result.signal
      ? `was killed by ${result.signal}`
      : `exited ${result.status}`;
  const failed = (result.stdout ?? '')
    .split('\n')
    .filter(line => /^\s*not ok /.test(line))
    .map(line => `  ${line.trim()}`);
  const head = `run-tests[${label}]: node --test ${how}`;
  return failed.length === 0
    ? `${head}; it printed no 'not ok' line`
    : [`${head}; ${failed.length} 'not ok' line(s):`, ...failed].join('\n');
}
