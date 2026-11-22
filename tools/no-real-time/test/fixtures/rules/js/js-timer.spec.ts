// setTimeout(() => {}, 100) in a comment is not a hit.
it('waits on a real timer', async () => {
  await new Promise(r => setTimeout(r, 100)); // expect: js-timer
  const id = setInterval(() => poll(), 10); // expect: js-timer
  clearInterval(id);
  globalThis.setTimeout(done, 5); // expect: js-timer
  await fetch(url, { signal: AbortSignal.timeout(1000) }); // expect: js-timer
  // A timer written into a child's source is still code the test runs:
  const child = 'setTimeout(() => process.exit(0), 50);'; // expect: js-timer
  // An injected or fake timer source is not a hit:
  clock.setTimeout(done, 5);
  timers.setInterval(tick, 5);
  // A keep-alive runs nothing, so it cannot decide anything:
  setInterval(() => {}, 1 << 30);
  setInterval(() => undefined, 1000);
  const keepAlive = `setInterval(() => undefined, 1000);`;
});
