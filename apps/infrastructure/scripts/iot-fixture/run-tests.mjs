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
// minTests carries a margin below the honest count so that consolidating a
// couple of cases does not turn this red for a reason that has nothing to do
// with the suite failing to run. Counts measured at the time of writing, after
// the per-run-ownership redesign integrated (see the re-measure note below for
// the breakdown and why it moved): dependency-free 406 tests across 4 files
// (container-definition 34, evidence 81, fixture-core 141, send-fixture 150);
// real-SDK 40 across 1 file.
//
// That margin is FOUR cases on the dependency-free tier and ONE on the much
// smaller real-SDK tier — a small fixed number, not the ~7% earlier revisions
// of this file used — and the reason is measured rather than stylistic. An
// earlier evidence-write cycle's three fixes added 22 executed cases (the tier
// stood at 387 before them: container-definition 34, evidence 70,
// fixture-core 137, send-fixture 146). A 7% margin on 409 is 29 — wide enough
// for all three fixes to be reverted with this gate still reporting a pass,
// which is the precise failure this file exists to refuse, committed in the
// file that refuses it. A percentage margin also widens as the suite grows, so
// it gets worse exactly as there is more to lose.
//
// The cost is that consolidating five or more cases turns this red. That is
// the intended prompt to re-measure and raise the floor deliberately, not a
// false alarm: a red here says "the count moved, come and say why", which is
// cheap. The failure in the other direction is a whole review cycle's worth of
// fail-closed assertions silently ceasing to run.
//
// The floor is RAISED when the suite grows and is never lowered to accommodate
// a rename: a floor below the honest count is a floor that lets a whole
// describe() block stop running unnoticed. A floor left BEHIND a grown suite is
// the same failure more quietly — the margin widens until an entire block can
// disappear inside it — so raising it is maintenance of the gate, not
// tightening of it.
//
// This floor was RE-MEASURED (down, deliberately) when the evidence destination
// was redesigned to PER-RUN OWNERSHIP. The prior design let two operators point
// --evidence-out at one FILE and tried to coordinate their writes on it — a
// shared-writer problem whose repairs kept producing new defects, and finally a
// credential leak on a refusal path. The operator's directive removed the
// problem instead of solving it again: --evidence-out is now a DIRECTORY, the
// file name is DERIVED from the run's unique id (so two runs cannot name the same
// file), and the destination is RESERVED before the send. There is no shared-file
// coordination and no `--overwrite`, so the whole class of shared-writer /
// exclusive-publication / superseded-record concurrency tests that pinned the old
// model is GONE — legitimately, because the code it tested is gone. Lowering the
// floor here is a re-measure of a genuinely smaller honest count, not a margin
// widened to hide a dropped block: the concurrency behaviour it protected does
// not exist to be silently reverted. The per-run tests that replaced it (a
// reservation before the send, a stat error that is never an absence, two runs
// owning two independent files, and the FIX-1 adversarial credential-in-path
// scrub — a credential-shaped DIRECTORY component and a credential-shaped
// FILENAME component, each on the success line AND the failure line) are what
// this count now keeps alive. Routing EVERY path-bearing operator line through
// the scrubber, not just the failure lines, is the FIX-1 regression class, and
// the cases that pin it (in send-fixture's "a credential-shaped evidence path
// never reaches operator output" block) are among what carried send-fixture's
// honest count up as step 6 rebuilt. This floor is RE-MEASURED against the
// integrated tree, not an estimate: the earlier note here read send-fixture at
// 147, which was a pre-rebuild projection; the real rebuilt suite reports 150.
// Honest default-tier count, measured on the integrated tree: 406
// (fixture-core 141, container-definition 34, evidence 81, send-fixture 150).
//
// The raise before that came when the evidence-write integrity cycle landed
// three fixes to the writer MG-53 and MG-54 consume mechanically. Each one is a
// case where the tool destroyed or misfiled a record while reporting success,
// and each still has cases this floor has to keep alive:
//
//   - a STAT ERROR IS NOT AN ABSENCE. The no-overwrite guard read any stat
//     failure as "nothing there" and wrote straight over an earlier run's
//     record. That is the MG-66 error-becomes-absence conflation reproduced
//     inside the tool built to refuse it, except here it also loses the data
//     and exits 0. Only ENOENT is an absence now; every other stat failure
//     refuses before writing.
//   - the atomic-write TEMP PATH IS PER RUN, NOT PER DESTINATION. Two runs
//     sharing --evidence-out interleaved on one `.partial` and one run's file
//     could end up holding the OTHER run's record, both exiting 0 — a wrong
//     record under the right name, which is worse than a missing one because
//     nothing downstream can detect it. The partial is named for the run id.
//   - `--overwrite` DOES NOT MEAN --destroy-anything. It bypassed the
//     concurrent-`.partial` safeguard and so could destroy a run that was
//     still writing. The flag replaces the operator's OWN earlier record; a
//     foreign partial is refused with the flag exactly as without it.
//
// The floors before THAT raise (360 / 35) would have passed a tree with all
// three of those reverted — and so would a 7%-margin floor of 380, which is
// why the margin was tightened above at the same time as the count was raised.
//
// The raise before that came when a further review cycle landed four fixes,
// each of which this floor also has to keep alive:
//
//   - the single exit funnel no longer defaulting to EXIT.OK. Exit 0 now
//     requires a confirmation that both carries EXIT.OK and says confirmed;
//     a state the code did not anticipate exits nonzero. That is the ticket's
//     central invariant, and it was previously inverted at the funnel's last
//     line by a `?? EXIT.OK` — a fail-OPEN default in the one function whose
//     entire contract is that exit 0 means one thing.
//   - the evidence destination being validated BEFORE the first live send, so
//     an unusable --evidence-out refuses at usage class while nothing live has
//     happened, rather than after three synthetic documents are already in the
//     container. The after-the-fact recording path stays as the backstop, so
//     both the preflight cases and the write-path cases have to keep running.
//   - a document carrying NO partition key field being its own recorded state
//     rather than an empty observed-values list. "Landed under a different
//     key" and "landed under no key" are different facts, the second is the
//     architect's predicted failure mode for this route, and collapsing them
//     would make the outcome text state something factually false.
//   - the retraction of the claim that anomalous ids implement the runbook's
//     unknown-document stop condition; that condition is the operator's
//     unfiltered enumeration.
//
// Every one of those is a regression that would read as normal behaviour in
// prose and is visible only as executed cases — which is exactly why the count
// floor, not just the file floor, is the thing that has to move. The floors
// before THAT raise (314 / 25) would likewise have passed a tree with all four
// fixes reverted: the failure mode a floor left behind a grown suite produces
// is that the margin widens until whole blocks fit inside it.
const TIERS = {
  default: {
    label: 'dependency-free',
    match: name => name.endsWith('.test.mjs') && !name.endsWith(SDK_SUFFIX),
    minFiles: 4,
    minTests: 402,
  },
  sdk: {
    label: 'real-SDK',
    match: name => name.endsWith(SDK_SUFFIX),
    minFiles: 1,
    minTests: 39,
  },
};

// Every argument is checked, not just the first. A wrapper whose entire job is
// refusing to ignore a missing suite must not itself ignore an argument it did
// not understand: `--sdk --bogus` silently running the SDK tier, or `--sdk`
// typo'd twice quietly selecting one tier, is the same green-by-absence shape
// this file exists to refuse — the operator believes they ran something they
// did not. An unrecognised or surplus argument is a usage failure.
const args = process.argv.slice(2);
const unknown = args.filter(value => value !== '--sdk');
if (unknown.length > 0 || args.length > 1) {
  const offender = unknown[0] ?? args[1];
  console.error(
    `run-tests: unknown argument '${offender}' — expected no argument or exactly --sdk`
  );
  process.exit(1);
}
const tier = args[0] === '--sdk' ? TIERS.sdk : TIERS.default;

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
