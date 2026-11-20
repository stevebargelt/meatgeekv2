import type { Reporter, TestCase, TestResult, TestStep } from '@playwright/test/reporter';

/**
 * HAR-101: one `PASS <step>` or `FAIL <step>` line per proof step, and one for
 * the test, the way the API suite prints its proofs. The list reporter's
 * `printSteps` marks neither outcome when it is not writing to a terminal (as
 * in CI), so the run summary and the issue had nothing to quote.
 *
 * Only titles and durations are printed: never an error message (the list
 * reporter already prints the failure), so nothing from the environment.
 */
export function stepLine(title: string, failed: boolean, durationMs: number): string {
  return `${failed ? 'FAIL' : 'PASS'} ${title} (${(Math.max(0, durationMs) / 1000).toFixed(1)}s)`;
}

export default class StepReporter implements Reporter {
  onStepEnd(_test: TestCase, _result: TestResult, step: TestStep): void {
    // `test.step` only: not hooks, fixtures or expect calls.
    if (step.category !== 'test.step') return;
    console.log(stepLine(step.title, step.error !== undefined, step.duration));
  }

  onTestEnd(test: TestCase, result: TestResult): void {
    if (result.status === 'skipped') {
      console.log(`SKIP ${test.title}`);
      return;
    }
    console.log(stepLine(test.title, result.status !== test.expectedStatus, result.duration));
  }

  printsToStdio(): boolean {
    return true;
  }
}
