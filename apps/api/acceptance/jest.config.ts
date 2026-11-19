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
  // The suite's time limit is the third argument of the one test() in
  // live.acceptance.ts (HAR-46): jest rejects `testTimeout` as a project-config
  // key ("Unknown option") and ignores it.
  coverageDirectory: '../../../coverage/apps/api-acceptance',
};
