it('gives a wait its own deadline', async () => {
  await waitFor(() => expect(screen.getByText('Ready')).toBeVisible(), { timeout: 2000 }); // expect: js-wait-timeout
  await screen.findByRole('button', { name: 'Start' }, { timeout: 500 }); // expect: js-wait-timeout
  await findAllByText( // expect: js-wait-timeout
    container,
    'row',
    {},
    { timeout: 100 }
  );
  // Bounded only by the runner's hang guard: not a hit.
  await waitFor(() => expect(screen.getByText('Ready')).toBeVisible());
  await screen.findByText('timeout: 5 seconds');
});
