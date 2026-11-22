// The acceptance probe (HAR-127): a new spec under apps/web that sleeps.
it('sleeps for a tenth of a second', async () => {
  await new Promise(r => setTimeout(r, 100));
});
