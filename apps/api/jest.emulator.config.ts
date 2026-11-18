/* eslint-disable */
/**
 * HAR-12 — the Cosmos EMULATOR test tier (`npx nx run api:test-emulator`).
 *
 * Runs ONLY `*.emulator.spec.ts` files, against a real Cosmos DB emulator. The
 * default `nx test api` config (jest.config.ts) ignores the same pattern, so a
 * developer without an emulator still gets a green unit run.
 *
 * Unreachable emulator = FAIL, never skip: each emulator spec probes the endpoint
 * in `beforeAll` and throws, which fails every case in the file. `passWithNoTests`
 * is deliberately absent, so a rename that leaves this config matching nothing
 * fails too instead of reporting an empty green.
 */
export default {
  displayName: 'api-emulator',
  preset: '../../jest.preset.js',
  testEnvironment: 'node',
  transform: {
    '^.+\\.[tj]s$': ['ts-jest', { tsconfig: '<rootDir>/tsconfig.spec.json' }],
  },
  moduleFileExtensions: ['ts', 'js', 'html'],
  testMatch: ['<rootDir>/src/**/*.emulator.spec.ts'],
};
