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
  // Cold starts on the deployed Function App can take tens of seconds.
  testTimeout: 10 * 60 * 1000,
  coverageDirectory: '../../../coverage/apps/api-acceptance',
};
