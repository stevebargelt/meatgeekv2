// Fixture registry for the harness self-tests (--registry).
const suite = (id, ...args) => ({
  id,
  cwd: 'tools/test-repeat/test/fixtures',
  command: ['node', 'fixture-suite.mjs', ...args],
  paths: [`fixtures/${id}/**`],
  needs: [],
  timeoutSec: 120,
});

export const suites = [
  suite('fixture-pass', 'pass'),
  suite('fixture-fail-on-3', 'fail-on', '3'),
  suite('fixture-barrier', 'barrier'),
  {
    ...suite('fixture-load-args', 'refuse', '--load-only'),
    loadArgs: ['--load-only'],
    loadArgsReason: 'fixture reason',
  },
  {
    ...suite('fixture-prepare-fails', 'pass'),
    prepare: [['node', '-e', 'process.exit(4)']],
  },
];
