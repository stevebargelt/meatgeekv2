/* eslint-disable */
/**
 * HAR-11 — jest config for the LIVE acceptance run (`npx nx run api:acceptance`).
 * It matches only live.acceptance.ts. The api unit tests use ../jest.config.ts,
 * whose spec/test pattern never matches that file, so `nx test api` does not
 * call a deployed system. The self-test in this folder (*.spec.ts) runs under
 * `nx test api` against an in-process stub, not here.
 */
export default {
  displayName: 'api-acceptance',
  preset: '../../../jest.preset.js',
  testEnvironment: 'node',
  rootDir: '.',
  testMatch: ['<rootDir>/live.acceptance.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.json' }],
  },
  moduleFileExtensions: ['ts', 'js'],
  // The whole suite is one jest test. Cold starts on the deployed Function App
  // take tens of seconds, and a run that tops up the simulated device's volume
  // (telemetry-volume.proof.ts, HAR-45) sends ~8,700 readings and then waits up
  // to 15 min for them to be readable. Kept under the acceptance job's 40 min
  // timeout (app-deploy-dev.yml) so jest, not the job kill, reports an overrun.
  testTimeout: 35 * 60 * 1000,
  coverageDirectory: '../../../coverage/apps/api-acceptance',
};
