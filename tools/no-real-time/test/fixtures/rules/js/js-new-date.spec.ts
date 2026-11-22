it('reads the wall clock through Date', () => {
  const now = new Date(); // expect: js-new-date
  const iso = new Date ().toISOString(); // expect: js-new-date
  const text = Date(); // expect: js-new-date
  const fixed = new Date('2026-11-20T15:00:00.000Z'); // an argument: not a hit
  const later = new Date(fixed.getTime() + 1000); // not a hit
  expect([now, iso, text, later]).toBeDefined();
});
