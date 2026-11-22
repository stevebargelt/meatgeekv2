// A file that installs fake timers may call what they fake: setTimeout,
// setInterval, Date.now() and new Date() read the fake clock. The allowance is
// per file; the rules fake timers do not cover still apply.
beforeEach(() => jest.useFakeTimers({ now: new Date('2026-11-20T15:00:00.000Z') }));
afterEach(() => jest.useRealTimers());

it('advances the fake clock', () => {
  const fired = jest.fn();
  setTimeout(fired, 1000);
  const started = Date.now();
  jest.advanceTimersByTime(1000);
  expect(fired).toHaveBeenCalled();
  expect(new Date().getTime() - started).toBe(1000);
  const t0 = performance.now(); // expect: js-performance-now
  await sleep(10); // expect: js-sleep
  expect(t0).toBeDefined();
});
