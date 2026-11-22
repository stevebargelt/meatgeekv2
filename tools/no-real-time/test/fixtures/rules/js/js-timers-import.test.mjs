import { setTimeout as delay } from 'node:timers/promises'; // expect: js-timers-import
const { setImmediate } = require('timers'); // expect: js-timers-import

it('waits on an aliased timer', async () => {
  await delay(100);
  const t = await import('node:timers/promises'); // expect: js-timers-import
  await new Promise(r => setImmediate(r)); // a turn of the event loop is not a clock
});
