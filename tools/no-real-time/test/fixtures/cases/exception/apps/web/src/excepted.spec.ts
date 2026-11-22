// One hit, which exceptions.json accepts with a reason.
it('keeps a child alive for a signal', () => {
  const id = setInterval(check, 10);
  clearInterval(id);
});
