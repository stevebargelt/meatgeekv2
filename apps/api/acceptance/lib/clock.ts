/**
 * HAR-120 — the one clock every wait in the live suite goes through: the
 * proofs' poll intervals and caps, the SignalR waits and grace, `within`, the
 * 429 retry delays, the runner's per-request limit and its simdevice kill.
 *
 * Live, it is {@link realClock}: `Date.now`, `performance.now` and
 * `setTimeout`, so the intervals, caps and messages are exactly what
 * they were before the clock existed. The self-test installs a fake one with
 * {@link setClock}, so no wait in it depends on how fast the machine is: a
 * fake `sleep` ends when the in-process stub has answered, and a deadline fires
 * only when the fake time reaches it.
 *
 * Two kinds of wait, kept apart on purpose:
 *
 * - `sleep` — the code chose to pause (a poll interval, a retry delay, a
 *   grace window, the rest of a cap). Nothing races it except an `AbortSignal`.
 * - `after` — a deadline racing a real event (a child exiting, a
 *   response arriving, a `start()` settling). It must be cancelled when the
 *   event wins.
 */
export interface Clock {
  /** Epoch milliseconds, as `Date.now()`. */
  now(): number;
  /** A monotonic reading for measuring a duration, as `performance.now()`. */
  monotonic(): number;
  /** Resolve after `ms`, or as soon as `signal` aborts (without waiting the
   *  rest). Never rejects. */
  sleep(ms: number, signal?: AbortSignal): Promise<void>;
  /** Call `fire` after `ms`, unless the returned function is called first.
   *  (The runner's request limit is one of these, aborting the fetch, rather
   *  than `AbortSignal.timeout`, so it is on this clock and is cancelled once
   *  the response is in.) */
  after(ms: number, fire: () => void): () => void;
}

export const realClock: Clock = {
  now: () => Date.now(),
  monotonic: () => performance.now(),
  sleep: (ms, signal) =>
    new Promise<void>(resolve => {
      if (signal?.aborted) {
        resolve();
        return;
      }
      const done = () => {
        clearTimeout(timer);
        signal?.removeEventListener('abort', done);
        resolve();
      };
      const timer = setTimeout(done, ms);
      signal?.addEventListener('abort', done, { once: true });
    }),
  after: (ms, fire) => {
    const timer = setTimeout(fire, ms);
    return () => clearTimeout(timer);
  },
};

let current: Clock = realClock;

/** The clock in force: {@link realClock} unless a test installed another. */
export function clock(): Clock {
  return current;
}

/** Install `next` (the self-test's fake); returns a function restoring the
 *  previous clock. */
export function setClock(next: Clock): () => void {
  const previous = current;
  current = next;
  return () => {
    current = previous;
  };
}

/**
 * Wait until `wake` is called or `ms` pass, whichever is first. `arm` is given
 * the wake function to keep where the event handler can call it, and then
 * `undefined` once the wait is over. The `sleep` for the rest is cancelled
 * when the wake wins, so it never ends later on its own.
 */
export async function sleepUntilWoken(
  ms: number,
  arm: (wake: (() => void) | undefined) => void
): Promise<void> {
  const cancel = new AbortController();
  try {
    await new Promise<void>(resolve => {
      arm(resolve);
      void clock().sleep(ms, cancel.signal).then(resolve);
    });
  } finally {
    arm(undefined);
    cancel.abort();
  }
}
