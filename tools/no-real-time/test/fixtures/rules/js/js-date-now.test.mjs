it('reads the wall clock', () => {
  const started = Date.now(); // expect: js-date-now
  expect(Date.now() - started).toBeLessThan(100); // expect: js-date-now
  const now = clock.now(); // an injected clock: not a hit
  expect(now).toBe(started);
});
