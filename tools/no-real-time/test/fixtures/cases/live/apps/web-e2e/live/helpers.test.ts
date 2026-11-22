// Non-live: a Jest test beside the live proof, in scope.
it('waits', async () => {
  await new Promise(r => setTimeout(r, 100)); // expect: js-timer
});
