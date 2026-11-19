import { runAcceptance } from './lib/runner';

/**
 * HAR-11 — the entry point `npx nx run api:acceptance` runs. It is matched only
 * by ./jest.config.ts, never by the api unit-test config, so `nx test api`
 * cannot reach a live system. All behaviour lives in ./lib/runner; this file
 * only turns the run's result into a jest pass/fail (and so a process exit
 * code). Output goes straight to stdout, already redacted by the runner.
 */
/**
 * The whole suite is this one test. Cold starts on the deployed Function App
 * take tens of seconds, and a run that tops up the simulated device's volume
 * (telemetry-volume.proof.ts) sends ~8,700 readings (~7–8 min) and then waits
 * up to 15 min for them to be readable. Kept under the acceptance job's 40 min
 * timeout (app-deploy-dev.yml) so jest, not the job kill, reports an overrun.
 * It is passed here, not as `testTimeout` in jest.config.ts, where jest
 * rejects it as an unknown option (HAR-46).
 */
const SUITE_TIMEOUT_MS = 35 * 60 * 1000;

test(
  'live acceptance proofs pass against ACCEPTANCE_BASE_URL',
  async () => {
    const result = await runAcceptance({
      env: process.env,
      write: line => process.stdout.write(`${line}\n`),
    });
    if (result.exitCode !== 0) {
      throw new Error(`live acceptance failed:\n${result.failures.join('\n')}`);
    }
  },
  SUITE_TIMEOUT_MS
);
