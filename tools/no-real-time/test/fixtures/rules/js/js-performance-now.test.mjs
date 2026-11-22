it('measures elapsed time', () => {
  const t0 = performance.now(); // expect: js-performance-now
  const [s] = process.hrtime(); // expect: js-performance-now
  const n = process.hrtime.bigint(); // expect: js-performance-now
  expect([t0, s, n]).toBeDefined();
});
