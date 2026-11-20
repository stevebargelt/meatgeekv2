/* eslint-disable */
// Unit tests for the live browser proof's pure helpers (live/*.test.ts).
// The Playwright specs (src/*.spec.ts, live/*.live.ts) are not jest's.
export default {
  displayName: 'web-e2e',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  testMatch: ['<rootDir>/live/**/*.test.ts'],
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  // otplib's CommonJS build requires @scure/base and @noble/hashes, which
  // ship only ES modules; compile those two to CommonJS as well.
  transformIgnorePatterns: ['/node_modules/(?!(@scure/base|@noble/hashes)/)'],
  moduleFileExtensions: ['ts', 'js'],
  coverageDirectory: '../../coverage/apps/web-e2e',
};
