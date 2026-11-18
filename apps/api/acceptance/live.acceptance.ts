import { runAcceptance } from './lib/runner';

/**
 * HAR-11 — the entry point `npx nx run api:acceptance` runs. It is matched only
 * by ./jest.config.ts, never by the api unit-test config, so `nx test api`
 * cannot reach a live system. All behaviour lives in ./lib/runner; this file
 * only turns the run's result into a jest pass/fail (and so a process exit
 * code). Output goes straight to stdout, already redacted by the runner.
 */
test('live acceptance proofs pass against ACCEPTANCE_BASE_URL', async () => {
  const result = await runAcceptance({
    env: process.env,
    write: line => process.stdout.write(`${line}\n`),
  });
  if (result.exitCode !== 0) {
    throw new Error(`live acceptance failed:\n${result.failures.join('\n')}`);
  }
});
