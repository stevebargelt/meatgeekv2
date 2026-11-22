// A clean test: it awaits the event, polls a condition with no deadline of its
// own, and reads time only from a fake clock it advances. Nothing here is a hit.
import { once } from 'node:events';

it('waits on the event', async () => {
  const child = spawn(process.execPath, ['child.mjs']);
  const [code] = await once(child, 'exit');
  expect(code).toBe(0);
  await new Promise(resolve => setImmediate(resolve));
  const clock = new FakeClock(Date.parse('2026-11-20T15:00:00.000Z'));
  clock.advance(30_000);
  expect(clock.now()).toBe(Date.UTC(2026, 10, 20, 15, 0, 30));
  const url = 'https://example.test//double-slash'; // `//` in a string is not a comment
  const re = /\/\/ setTimeout\(/; // nor in a regular expression
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  expect([url, re]).toBeDefined();
});
