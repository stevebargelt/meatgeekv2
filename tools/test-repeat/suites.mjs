// HAR-107 — the suite registry for tools/test-repeat.
//
// One entry per NON-LIVE test suite in the repository. Each entry says:
//
//   id        the name used on the command line, in the CI matrix and in the
//             job summary.
//   cwd       directory the command runs in, relative to the repository root.
//   command   argv for ONE run. Every command calls the test runner directly
//             (jest, go test, playwright, node, bash), never through Nx, so no
//             run can be an Nx cache hit. Go gets -count=1 so no run can be a
//             go test cache hit either.
//   prepare   argv lists run ONCE before the repeat loop (generated types, a
//             web build, terraform init). Preparation is not what is repeated.
//   paths     globs (repo-relative) whose change makes the suite "affected".
//             `**` crosses directories, `*` does not. Err on the side of
//             selecting: a missed dependency means a flaky suite escapes its
//             50 runs.
//   needs     what the CI job has to provide: npm (node_modules), go,
//             terraform, chromium, cosmos-emulator.
//   shards    split N runs across this many CI jobs (default 1).
//   maxParallel  cap for --parallel, with maxParallelReason saying why.
//   env       extra environment for every run.
//   timeoutSec   hard limit for ONE run; a run that exceeds it is killed and
//             counted as failed. It is a hang guard for the harness, not a
//             test timeout: it is set far above a normal run.
//
// Deliberately absent: `api:acceptance` (apps/api/acceptance/jest.config.ts)
// and `web-e2e:e2e-live` (playwright.live.config.ts). Both hit the live cloud,
// which goal HAR-106 puts out of scope. registry.test.mjs pins that every other
// jest config and every apps/infrastructure/scripts/fixtures/run-*.sh is here.

// Root files every Jest/ts-jest suite depends on.
const JS_ROOT = [
  'package.json',
  'package-lock.json',
  'jest.preset.js',
  'tsconfig.base.json',
  'nx.json',
];

const jest = (config, ...extra) => [
  'node',
  'node_modules/jest/bin/jest.js',
  '-c',
  config,
  '--ci',
  ...extra,
];

// The fixture harnesses under apps/infrastructure/scripts/fixtures. Each is a
// self-contained bash script; ci.yml runs all but run-flex-secret-gate in
// validate-infrastructure; run-flex-secret-gate runs inside the api-interfaces
// Jest suite, which shells out to it.
const FIXTURE_RUNNERS = [
  'run-assert-live-shared-throughput-fixtures.sh',
  'run-collect-live-shared-throughput-fixtures.sh',
  'run-cross-module-propagation-fixtures.sh',
  'run-destroy-guard-fixtures.sh',
  'run-flex-secret-gate-fixtures.sh',
  'run-iothub-cosmos-partition-key-fixtures.sh',
  'run-live-host-storage-fixtures.sh',
];

const fixtureId = file => 'fixtures-' + file.replace(/^run-/, '').replace(/-fixtures\.sh$/, '');

/** @type {import('./lib.mjs').Suite[]} */
export const suites = [
  // --- Go -----------------------------------------------------------------
  {
    id: 'go-data-pusher',
    cwd: 'apps/data-pusher',
    command: ['go', 'test', '-race', '-count=1', './...'],
    paths: ['apps/data-pusher/**'],
    needs: ['go'],
    goModFile: 'apps/data-pusher/go.mod',
    timeoutSec: 600,
  },
  {
    id: 'go-device-controller',
    cwd: 'apps/device-controller',
    command: ['go', 'test', '-race', '-count=1', '-tags', 'testserver', './...'],
    paths: ['apps/device-controller/**'],
    needs: ['go'],
    goModFile: 'apps/device-controller/go.mod',
    timeoutSec: 600,
  },

  // --- Jest ---------------------------------------------------------------
  {
    id: 'api',
    command: jest('apps/api/jest.config.ts'),
    // api imports api-interfaces and the api-specs spec, and one test reads
    // the cosmos-db Terraform module.
    paths: ['apps/api/**', 'libs/**', 'apps/infrastructure/modules/cosmos-db/**', ...JS_ROOT],
    needs: ['npm'],
    // 68.4 s a run on the first CI run (1019 tests; about 80 s locally), so
    // 50 serial runs would take about an hour. 3 shards: 17 runs, about 19
    // minutes a job.
    shards: 3,
    timeoutSec: 1200,
  },
  {
    id: 'api-emulator',
    command: jest('apps/api/jest.emulator.config.ts', '--runInBand'),
    paths: ['apps/api/**', 'libs/**', ...JS_ROOT],
    needs: ['npm', 'cosmos-emulator'],
    env: { COSMOS_EMULATOR_ENDPOINT: 'https://localhost:8081' },
    timeoutSec: 1200,
  },
  {
    id: 'web',
    command: jest('apps/web/jest.config.ts'),
    // apps/web/project.json test.dependsOn: the generated OpenAPI types.
    prepare: [['npx', 'nx', 'run', 'api-specs:generate-types']],
    paths: ['apps/web/**', 'libs/api-specs/**', 'libs/api-interfaces/**', ...JS_ROOT],
    needs: ['npm'],
    timeoutSec: 1200,
  },
  {
    id: 'web-e2e',
    command: jest('apps/web-e2e/jest.config.ts'),
    paths: ['apps/web-e2e/**', 'libs/api-specs/**', ...JS_ROOT],
    needs: ['npm'],
    timeoutSec: 600,
  },
  {
    id: 'api-interfaces',
    command: jest('libs/api-interfaces/jest.config.ts'),
    // Besides its own source, this suite reads the workflows, the Terraform
    // tree, the bootstrap script and package.json files.
    paths: [
      'libs/api-interfaces/**',
      '.github/workflows/**',
      'apps/infrastructure/**',
      'apps/api/package.json',
      ...JS_ROOT,
    ],
    needs: ['npm'],
    // 44.4 s a run on the first CI run (about 56 s locally). 2 shards: 25
    // runs, about 19 minutes a job.
    shards: 2,
    timeoutSec: 1200,
  },
  {
    id: 'api-specs',
    command: jest('libs/api-specs/jest.config.ts'),
    paths: ['libs/api-specs/**', ...JS_ROOT],
    needs: ['npm'],
    timeoutSec: 600,
  },
  {
    id: 'data-models',
    command: jest('libs/data-models/jest.config.ts'),
    paths: ['libs/data-models/**', 'libs/api-interfaces/**', 'libs/utils/**', ...JS_ROOT],
    needs: ['npm'],
    timeoutSec: 600,
  },
  {
    id: 'utils',
    command: jest('libs/utils/jest.config.ts'),
    paths: ['libs/utils/**', ...JS_ROOT],
    needs: ['npm'],
    timeoutSec: 600,
  },

  // --- Node (node --test, through each tool's floored wrapper) -------------
  {
    id: 'iot-fixture',
    command: ['node', 'apps/infrastructure/scripts/iot-fixture/run-tests.mjs'],
    paths: ['apps/infrastructure/scripts/iot-fixture/**'],
    needs: [],
    timeoutSec: 600,
  },
  {
    id: 'iot-fixture-sdk',
    command: ['node', 'apps/infrastructure/scripts/iot-fixture/run-tests.mjs', '--sdk'],
    paths: ['apps/infrastructure/scripts/iot-fixture/**', 'package.json', 'package-lock.json'],
    needs: ['npm'],
    timeoutSec: 600,
  },
  {
    id: 'cosmos-export',
    command: ['node', 'apps/infrastructure/scripts/cosmos-export/run-tests.mjs'],
    paths: ['apps/infrastructure/scripts/cosmos-export/**'],
    needs: [],
    timeoutSec: 600,
  },
  {
    id: 'cosmos-export-sdk',
    command: ['node', 'apps/infrastructure/scripts/cosmos-export/run-tests.mjs', '--sdk'],
    paths: ['apps/infrastructure/scripts/cosmos-export/**', 'package.json', 'package-lock.json'],
    needs: ['npm'],
    timeoutSec: 600,
  },

  // --- Shell --------------------------------------------------------------
  // Exactly as ci.yml's validate-infrastructure runs them: through
  // assert-suite-completion.sh, with stdin closed (the harness always closes
  // stdin). bootstrap.test.sh pipes emitted HCL through `terraform fmt -`.
  {
    id: 'bootstrap',
    command: [
      'bash',
      'apps/infrastructure/bootstrap/assert-suite-completion.sh',
      'bootstrap.test.sh',
    ],
    paths: ['apps/infrastructure/**', '.github/workflows/**'],
    needs: ['terraform'],
    timeoutSec: 600,
  },
  {
    id: 'bootstrap-oidc-subject',
    command: [
      'bash',
      'apps/infrastructure/bootstrap/assert-suite-completion.sh',
      'bootstrap.oidc-subject.integration.test.sh',
    ],
    paths: ['apps/infrastructure/**', '.github/workflows/**'],
    needs: ['terraform'],
    timeoutSec: 600,
  },
  ...FIXTURE_RUNNERS.map(file => ({
    id: fixtureId(file),
    command: ['bash', `apps/infrastructure/scripts/fixtures/${file}`],
    // The cross-module and partition-key harnesses copy and mutate the whole
    // Terraform tree, so any infrastructure change can move them.
    paths: ['apps/infrastructure/**'],
    needs: [],
    timeoutSec: 600,
  })),

  // --- Terraform ----------------------------------------------------------
  {
    id: 'terraform-tests',
    command: ['bash', 'tools/test-repeat/terraform-tests.sh', 'test'],
    prepare: [['bash', 'tools/test-repeat/terraform-tests.sh', 'init']],
    paths: ['apps/infrastructure/**'],
    needs: ['terraform'],
    // 70.7 s on the first CI run (that run included the providers' first
    // start). 3 shards: 17 runs, about 20 minutes a job at that rate.
    shards: 3,
    // Same disarming of ambient Azure auth as validate-infrastructure.
    env: {
      ARM_USE_OIDC: 'false',
      ARM_USE_CLI: 'false',
      ARM_USE_MSI: 'false',
      ARM_USE_AKS_WORKLOAD_IDENTITY: 'false',
    },
    timeoutSec: 900,
  },

  // --- Browser ------------------------------------------------------------
  {
    id: 'playwright-web-e2e',
    command: [
      'node',
      'node_modules/@playwright/test/cli.js',
      'test',
      '-c',
      'apps/web-e2e/playwright.config.ts',
    ],
    // `nx e2e web-e2e` dependsOn web:build; the build is preparation, the
    // browser test is what repeats.
    prepare: [['npx', 'nx', 'build', 'web']],
    paths: [
      'apps/web/**',
      'apps/web-e2e/**',
      'libs/api-specs/**',
      'libs/api-interfaces/**',
      ...JS_ROOT,
    ],
    needs: ['npm', 'chromium'],
    // playwright.config.ts serves the build on a fixed port (4300,
    // --strictPort), so a second concurrent copy cannot start its server.
    maxParallel: 1,
    maxParallelReason: 'apps/web-e2e/playwright.config.ts serves on fixed port 4300',
    timeoutSec: 900,
  },
];

export default suites;
