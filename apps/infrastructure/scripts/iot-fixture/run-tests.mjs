#!/usr/bin/env node
// MG-67 — runs the iot-fixture suites and REFUSES a vacuous pass.
//
// `node --test` exits 0 when it discovers nothing. A renamed, deleted or
// unreadable test file therefore leaves the CI step GREEN while asserting
// nothing at all — and what this suite asserts is the fail-closed contract of a
// tool whose whole purpose is refusing to call an unconfirmed send a success.
// A green-by-absence gate over a fail-closed tool is the same shape as the bug
// the tool exists to prevent, one level up. So discovery and the executed test
// count are BOTH floored here, and a run that clears neither is reported as a
// failure rather than a pass.
//
// This is a SIBLING of apps/infrastructure/scripts/cosmos-export/run-tests.mjs,
// deliberately not an edit to it and not a shared base: that file is MG-66
// scope, its floors are its own honest counts, and coupling the two would mean
// a change to either tool's suite size touching the other tool's gate. Two
// small wrappers with the same contract beat one shared abstraction here.
//
// Two tiers, selected by argument, because they need different CI homes:
//
//   (default)  every *.test.mjs EXCEPT *.sdk.test.mjs — node: built-ins and the
//              local fake-azure.mjs only, every client injected. Runs in
//              validate-infrastructure, which installs nothing and holds no
//              credential; this tier must not weaken that, so it resolves no
//              Azure package and reaches no network.
//   --sdk      *.sdk.test.mjs only — takes send-fixture.mjs's real
//              `import('@azure/cosmos')` / `import('@azure/identity')`, so it
//              needs a real node_modules and runs in lint-and-test after
//              `npm ci`. Still offline: a credential is constructed, never
//              used, and no client method is called.
//
// One wrapper rather than two: the anti-vacuity floors are the whole point of
// this file, and a second wrapper would be a second place for them to drift or
// be quietly omitted. Both tiers get the same discovery-and-count refusal; only
// the pattern and the floors differ.

import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const DIR = path.dirname(fileURLToPath(import.meta.url));
const SDK_SUFFIX = '.sdk.test.mjs';

// Floors are the honest current counts, not aspirations: they exist to catch a
// suite that STOPS running, not to police growth.
//
// minFiles is the exact number of files each tier has today, because losing one
// is precisely the failure being guarded against — a floor one below the truth
// would let a deleted or renamed file pass discovery and only maybe trip the
// count floor, with a message that names the wrong problem.
//
// minTests carries a small margin (roughly 7%) below the honest count, so
// tightening or consolidating a handful of cases does not turn this red for a
// reason that has nothing to do with the suite failing to run. Counts at the
// time of writing: dependency-free 236 tests across 4 files; real-SDK 13 tests
// across 1 file.
const TIERS = {
  default: {
    label: 'dependency-free',
    match: name => name.endsWith('.test.mjs') && !name.endsWith(SDK_SUFFIX),
    minFiles: 4,
    minTests: 220,
  },
  sdk: {
    label: 'real-SDK',
    match: name => name.endsWith(SDK_SUFFIX),
    minFiles: 1,
    minTests: 12,
  },
};

const arg = process.argv[2];
if (arg !== undefined && arg !== '--sdk') {
  console.error(`run-tests: unknown argument '${arg}' — expected no argument or --sdk`);
  process.exit(1);
}
const tier = arg === '--sdk' ? TIERS.sdk : TIERS.default;

const files = readdirSync(DIR).filter(tier.match).sort();

if (files.length < tier.minFiles) {
  console.error(
    `run-tests[${tier.label}]: discovered ${files.length} test file(s) in ${DIR}, expected at least ${tier.minFiles} — refusing to report a pass`
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
if (!Number.isInteger(executed) || executed < tier.minTests) {
  console.error(
    `run-tests[${tier.label}]: ${files.length} file(s) reported ${executed} test(s), expected at least ${tier.minTests} — the suite did not run to completion`
  );
  process.exit(1);
}

console.log(`run-tests[${tier.label}]: ${executed} test(s) across ${files.length} file(s) passed`);
