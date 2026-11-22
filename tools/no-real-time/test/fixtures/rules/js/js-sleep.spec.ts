it('sleeps', async () => {
  await sleep(100); // expect: js-sleep
  sleep(5).then(check); // expect: js-sleep
  await clock.sleep(100); // an injected clock: not a hit
  await sleepUntilWoken(clock); // a different name: not a hit
});

function sleep(ms) {
  return clock.sleep(ms);
}

const fakeClock = {
  sleep(ms) {
    return Promise.resolve(ms);
  },
  async sleep2(ms) {
    return ms;
  },
};
