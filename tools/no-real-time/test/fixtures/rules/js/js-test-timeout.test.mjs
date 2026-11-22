jest.setTimeout(90_000); // expect: js-test-timeout

describe('per-test deadlines', () => {
  it('has its own timeout', async () => { // expect: js-test-timeout
    await work();
  }, 10_000);
  beforeAll(async () => setUp(), 30000); // expect: js-test-timeout
  test('node:test options', { timeout: 500 }, async () => {}); // expect: js-test-timeout
  it.only('with a modifier', () => {}, 1000); // expect: js-test-timeout
  // No deadline of its own: not a hit.
  it('waits on the runner hang guard', async () => {
    await work(1000);
  });
  test('a name with a number', () => expect(add(1, 2)).toBe(3));
  it('has a skip option', { skip: true }, () => {});
});
