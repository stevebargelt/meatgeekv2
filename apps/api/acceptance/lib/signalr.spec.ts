import { HttpError } from '@microsoft/signalr';

import { ProofFailure } from './proof';
import { isThrottled, START_RETRY, startWithRetry } from './signalr';

/**
 * HAR-81 — the SignalR proofs' connect helper retries a 429 from the service up
 * to 3 more times (1 s, 2 s, 4 s) and fails at once on anything else. Driven
 * with a stubbed connection and a recorded wait, so nothing sleeps.
 */

/** The error the real client throws when the service's negotiate answers 429. */
const throttled = () =>
  new Error(
    "Failed to complete negotiation with the server: Error: Too many requests.: Status code '429'"
  );

/** A connection whose `start()` plays `outcomes` in order: an Error rejects,
 *  `'ok'` resolves. */
function stubConnection(outcomes: Array<Error | 'ok'>) {
  let calls = 0;
  return {
    get calls() {
      return calls;
    },
    start: () => {
      const outcome = outcomes[calls];
      calls += 1;
      if (outcome === undefined) {
        throw new Error(`start() called ${calls} times, more than the test planned`);
      }
      return outcome === 'ok' ? Promise.resolve() : Promise.reject(outcome);
    },
  };
}

function recordedWait() {
  const waits: number[] = [];
  return { waits, wait: async (ms: number) => void waits.push(ms) };
}

describe('startWithRetry (HAR-81)', () => {
  it('waits 1 s, 2 s and 4 s: three retries, four attempts in all', () => {
    expect(START_RETRY.delaysMs).toEqual([1_000, 2_000, 4_000]);
  });

  it('connects when a 429 is followed by success, after one 1 s wait', async () => {
    const connection = stubConnection([throttled(), 'ok']);
    const { waits, wait } = recordedWait();

    await expect(startWithRetry(connection, 'start()', [], wait)).resolves.toBe(2);
    expect(connection.calls).toBe(2);
    expect(waits).toEqual([1_000]);
  });

  it('connects on the fourth attempt after three 429s', async () => {
    const connection = stubConnection([throttled(), throttled(), throttled(), 'ok']);
    const { waits, wait } = recordedWait();

    await expect(startWithRetry(connection, 'start()', [], wait)).resolves.toBe(4);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it('fails with the 429 text after four 429s', async () => {
    const connection = stubConnection([throttled(), throttled(), throttled(), throttled()]);
    const { waits, wait } = recordedWait();

    const failure = startWithRetry(connection, 'owner start()', [], wait);
    await expect(failure).rejects.toBeInstanceOf(ProofFailure);
    await expect(failure).rejects.toThrow(
      "owner start() failed (after 4 attempts): Error: Failed to complete negotiation with the server: Error: Too many requests.: Status code '429'"
    );
    expect(connection.calls).toBe(4);
    expect(waits).toEqual([1_000, 2_000, 4_000]);
  });

  it('fails a non-429 error after one attempt, without waiting', async () => {
    const connection = stubConnection([
      new Error(
        "Failed to complete negotiation with the server: Error: Unauthorized: Status code '401'"
      ),
    ]);
    const { waits, wait } = recordedWait();

    await expect(startWithRetry(connection, 'start()', [], wait)).rejects.toThrow(
      "start() failed: Error: Failed to complete negotiation with the server: Error: Unauthorized: Status code '401'"
    );
    expect(connection.calls).toBe(1);
    expect(waits).toEqual([]);
  });

  it('fails a non-429 error that follows a 429 at once', async () => {
    const connection = stubConnection([throttled(), new Error('WebSocket failed to connect')]);
    const { waits, wait } = recordedWait();

    await expect(startWithRetry(connection, 'start()', [], wait)).rejects.toThrow(
      'start() failed (after 2 attempts): Error: WebSocket failed to connect'
    );
    expect(waits).toEqual([1_000]);
  });

  it('masks the url and the token in the failure line', async () => {
    const token = 'secret-token-81';
    const connection = stubConnection([
      new Error(`Failed to reach https://acct.service.signalr.net/client/?hub=h with ${token}`),
    ]);

    const failure = startWithRetry(connection, 'start()', [token], recordedWait().wait);
    await expect(failure).rejects.toThrow('start() failed: Error: Failed to reach <url> with ***');
  });
});

describe('isThrottled (HAR-81)', () => {
  it('is true for an HttpError with status 429 and for the negotiate message', () => {
    expect(isThrottled(new HttpError('Too many requests.', 429))).toBe(true);
    expect(isThrottled(throttled())).toBe(true);
  });

  it('is false for any other status or error', () => {
    expect(isThrottled(new HttpError('Unauthorized', 401))).toBe(false);
    expect(isThrottled(new Error("Status code '503'"))).toBe(false);
    expect(isThrottled(new Error('Too many requests'))).toBe(false);
    expect(isThrottled('429')).toBe(false);
    expect(isThrottled(undefined)).toBe(false);
  });
});
