import type { TestCase, TestResult, TestStep } from '@playwright/test/reporter';
import StepReporter, { stepLine } from './step-reporter';

describe('stepLine', () => {
  it('marks a passed step PASS with its duration in seconds', () => {
    expect(stepLine('1. wait for the build', false, 12_345)).toBe(
      'PASS 1. wait for the build (12.3s)'
    );
  });

  it('marks a failed step FAIL', () => {
    expect(stepLine('2. sign in on the real Microsoft pages', true, 30_000)).toBe(
      'FAIL 2. sign in on the real Microsoft pages (30.0s)'
    );
  });

  it('never prints a negative duration', () => {
    expect(stepLine('x', false, -1)).toBe('PASS x (0.0s)');
  });
});

describe('StepReporter', () => {
  const test = { title: 'live: the proof', expectedStatus: 'passed' } as TestCase;
  const result = {} as TestResult;
  let lines: string[];
  let spy: jest.SpyInstance;

  beforeEach(() => {
    lines = [];
    spy = jest.spyOn(console, 'log').mockImplementation((line: string) => {
      lines.push(line);
    });
  });
  afterEach(() => spy.mockRestore());

  const step = (overrides: Partial<TestStep>) =>
    ({ title: 's', category: 'test.step', duration: 1_000, ...overrides }) as TestStep;

  it('prints one line per test.step, and nothing for hooks, fixtures or expects', () => {
    const reporter = new StepReporter();
    reporter.onStepEnd(test, result, step({ title: '1. wait for the build' }));
    reporter.onStepEnd(test, result, step({ title: 'Before Hooks', category: 'hook' }));
    reporter.onStepEnd(test, result, step({ title: 'page', category: 'fixture' }));
    reporter.onStepEnd(test, result, step({ title: 'toHaveText', category: 'expect' }));
    reporter.onStepEnd(
      test,
      result,
      step({ title: '2. sign in', error: { message: 'secret-looking text' } })
    );
    expect(lines).toEqual(['PASS 1. wait for the build (1.0s)', 'FAIL 2. sign in (1.0s)']);
  });

  it('prints the test outcome, and SKIP for a skipped test', () => {
    const reporter = new StepReporter();
    reporter.onTestEnd(test, { status: 'passed', duration: 2_000 } as TestResult);
    reporter.onTestEnd(test, { status: 'timedOut', duration: 3_000 } as TestResult);
    reporter.onTestEnd(test, { status: 'skipped', duration: 0 } as TestResult);
    expect(lines).toEqual([
      'PASS live: the proof (2.0s)',
      'FAIL live: the proof (3.0s)',
      'SKIP live: the proof',
    ]);
  });
});
