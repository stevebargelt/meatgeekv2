// Fixture registry for the harness self-tests (--registry).
//
// No fixture has a per-run hang guard (timeoutSec): no clock may decide a
// fixture run. Each one ends on its own, or, for fixture-barrier, once every
// copy has started; a harness that broke that would hang the self-tests, and
// the one hang guard is the test-repeat-harness suite's timeoutSec (HAR-119).
const suite = (id, ...args) => ({
  id,
  cwd: 'tools/test-repeat/test/fixtures',
  command: ['node', 'fixture-suite.mjs', ...args],
  paths: [`fixtures/${id}/**`],
  needs: [],
});

// The caller-environment fixtures: a run sees the allowlist (PATH), the suite's
// env, its own TMPDIR, and a caller variable only when passEnv lists it.
const LEAK = 'TF_DESTROY_GUARD_EXPECTED_DESTROYS';

export const suites = [
  suite('fixture-pass', 'pass'),
  suite('fixture-fail-on-3', 'fail-on', '3'),
  suite('fixture-fail-first', 'fail-on', '1'),
  { ...suite('fixture-barrier', 'barrier'), passEnv: ['BARRIER_DIR', 'BARRIER_COUNT'] },
  {
    ...suite('fixture-load-args', 'refuse', '--load-only'),
    loadArgs: ['--load-only'],
    loadArgsReason: 'fixture reason',
  },
  {
    ...suite('fixture-prepare-fails', 'pass'),
    prepare: [['node', '-e', 'process.exit(4)']],
  },
  {
    ...suite(
      'fixture-env-dropped',
      'expect-env',
      `-${LEAK}`,
      'FIXTURE_FROM_SUITE=yes',
      'PATH',
      'TMPDIR'
    ),
    env: { FIXTURE_FROM_SUITE: 'yes' },
    // The prepare step gets the same filtered environment.
    prepare: [['node', '-e', `process.exit(process.env.${LEAK} === undefined ? 0 : 5)`]],
  },
  {
    ...suite('fixture-env-passed', 'expect-env', `${LEAK}=x`),
    passEnv: [LEAK],
    prepare: [['node', '-e', `process.exit(process.env.${LEAK} === 'x' ? 0 : 5)`]],
  },
];
