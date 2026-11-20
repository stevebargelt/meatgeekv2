/* eslint-disable */
export default {
  displayName: 'web',
  preset: '../../jest.preset.js',
  testEnvironment: '<rootDir>/jest.environment.cjs',
  transform: {
    '^.+\\.[tj]sx?$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'tsx', 'js', 'jsx'],
  coverageDirectory: '../../coverage/apps/web',
};
