// TypeScript definitions of a name a rule looks for are not calls.
class FakeClock {
  async sleep(ms: number, signal?: AbortSignal): Promise<void> {
    await this.settle(ms, signal);
  }
  setTimeout(fn: () => void, ms: number): number {
    return this.add(ms, fn);
  }
}

function sleep(ms: number): Promise<void> {
  return clock.sleep(ms);
}

const label = (n: number) => (n > 1 ? sleep(n) : { ok: true }); // expect: js-sleep
