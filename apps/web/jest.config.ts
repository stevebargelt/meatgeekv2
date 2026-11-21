/* eslint-disable */
export default {
  displayName: 'web',
  preset: '../../jest.preset.js',
  testEnvironment: '<rootDir>/jest.environment.cjs',
  // A hang guard, not a pass/fail deadline: tests wait on events and fake
  // clocks, never on time (src/test/setup.ts sets RTL's guard just under this).
  testTimeout: 30_000,
  setupFilesAfterEnv: ['<rootDir>/src/test/setup.ts'],
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: '../../coverage/apps/web',
};
