/* eslint-disable */
export default {
  displayName: 'api',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  // HAR-12: the emulator tier needs a running Cosmos emulator and has its own
  // target (`nx run api:test-emulator`, jest.emulator.config.ts). Keep it out of
  // the default run so `nx test api` stays green without one.
  testPathIgnorePatterns: ['/node_modules/', '\\.emulator\\.spec\\.ts$'],
  coverageDirectory: '../../coverage/apps/api',
  // HAR-111: the suite's one hang guard. Jest's 5 s default failed deterministic
  // work (contract.spec's OpenAPI dereference in beforeAll) on CPU starvation
  // alone in test-repeat's 8-copy load row; 30 s matches apps/web. No spec sets
  // its own timeout, and nothing waits on it: it only bounds a hang.
  testTimeout: 30_000,
};
