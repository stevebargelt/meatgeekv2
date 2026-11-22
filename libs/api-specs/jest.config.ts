/* eslint-disable */
export default {
  displayName: 'api-specs',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  coverageDirectory: '../../coverage/libs/api-specs',
  // The hang guard for every test and hook here (HAR-118, HAR-127): the
  // round-trip spec's beforeAll runs the openapi-typescript CLI, which can take
  // tens of seconds on a busy runner. It is set once, here, not per test, so
  // no test carries its own deadline (tools/no-real-time, js-test-timeout).
  testTimeout: 90_000,
  testMatch: [
    '<rootDir>/src/**/*.spec.ts',
    '<rootDir>/src/**/*.test.ts',
    '<rootDir>/contract-tests/**/*.spec.ts',
    '<rootDir>/contract-tests/**/*.test.ts',
  ],
};
