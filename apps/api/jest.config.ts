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
};
