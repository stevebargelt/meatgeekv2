import type { Clock } from './lib/clock';
import { setClock } from './lib/clock';
import { MessageFeed } from './lib/live-feed';

/**
 * HAR-142 — ./lib/live-feed's two waits on a fake clock. Nothing here waits on
 * real time: a sleep ends only when the test advances the clock past it, or
 * when its signal aborts (a push or a close woke the wait). A test that needs
 * the wait to be parked first awaits {@link ManualClock.sleeps}, which
 * resolves once the code under test has called `sleep` that many times.
 */

interface Sleeper {
  readonly until: number;
  readonly resolve: () => void;
}

class ManualClock implements Clock {
  time = 1_000_000;
  /** Every `sleep` asked for, in ms, in order. */
  readonly slept: number[] = [];
  private sleepers: Sleeper[] = [];
  private onSleep: Array<() => void> = [];

  now(): number {
    return this.time;
  }

  monotonic(): number {
    return this.time;
  }

  sleep(ms: number, signal?: AbortSignal): Promise<void> {
    this.slept.push(ms);
    return new Promise(resolve => {
      const sleeper: Sleeper = {
        until: this.time + ms,
        resolve: () => {
          this.sleepers = this.sleepers.filter(s => s !== sleeper);
          resolve();
        },
      };
      if (signal?.aborted) {
        resolve();
        return;
      }
      signal?.addEventListener('abort', () => sleeper.resolve(), { once: true });
      this.sleepers.push(sleeper);
      this.onSleep.splice(0).forEach(wake => wake());
    });
  }

  after(): () => void {
    throw new Error('live-feed uses no deadline timers');
  }

  /** Resolves once `sleep` has been called `n` times in all. */
  sleeps(n: number): Promise<void> {
    if (this.slept.length >= n) return Promise.resolve();
    return new Promise(resolve => {
      const check = () => {
        if (this.slept.length >= n) resolve();
        else this.onSleep.push(check);
      };
      this.onSleep.push(check);
    });
  }

  /** Move the time on by `ms` and end every sleep that is due. */
  advance(ms: number): void {
    this.time += ms;
    for (const sleeper of [...this.sleepers]) {
      if (sleeper.until <= this.time) sleeper.resolve();
    }
  }

  pending(): number {
    return this.sleepers.length;
  }
}

let fake: ManualClock;
let restore: () => void;

beforeEach(() => {
  fake = new ManualClock();
  restore = setClock(fake);
});

afterEach(() => restore());

const is = (n: number) => (m: number) => m === n;

describe('MessageFeed.waitFor', () => {
  it('returns a message received before the call at once, without sleeping', async () => {
    const feed = new MessageFeed<number>();
    feed.push(7);
    await expect(feed.waitFor(is(7), 90_000)).resolves.toBe(7);
    expect(fake.slept).toEqual([]);
  });

  it('wakes when the matching message arrives, with no time passing', async () => {
    const feed = new MessageFeed<number>();
    const waiting = feed.waitFor(is(7), 90_000);
    await fake.sleeps(1);
    feed.push(7);
    await expect(waiting).resolves.toBe(7);
    expect(fake.time).toBe(1_000_000);
    expect(fake.pending()).toBe(0);
  });

  it('keeps waiting through messages that do not match, for the rest of the cap', async () => {
    const feed = new MessageFeed<number>();
    const waiting = feed.waitFor(is(7), 90_000);
    await fake.sleeps(1);
    fake.advance(30_000);
    feed.push(1);
    await fake.sleeps(2);
    expect(fake.slept).toEqual([90_000, 60_000]);
    feed.push(7);
    await expect(waiting).resolves.toBe(7);
  });

  it('gives up with undefined when the cap passes, exactly at the cap', async () => {
    const feed = new MessageFeed<number>();
    const waiting = feed.waitFor(is(7), 90_000);
    await fake.sleeps(1);
    fake.advance(89_999);
    expect(fake.pending()).toBe(1);
    fake.advance(1);
    await expect(waiting).resolves.toBeUndefined();
    expect(fake.slept).toEqual([90_000]);
  });

  it('gives up with undefined at once when the connection closes, keeping the first reason', async () => {
    const feed = new MessageFeed<number>();
    const waiting = feed.waitFor(is(7), 90_000);
    await fake.sleeps(1);
    feed.close('closed without an error');
    feed.close('a later reason');
    await expect(waiting).resolves.toBeUndefined();
    expect(feed.closedBy).toBe('closed without an error');
    expect(fake.time).toBe(1_000_000);
  });
});

describe('MessageFeed.quietFor', () => {
  it('returns nothing after the whole window when no matching message arrives', async () => {
    const feed = new MessageFeed<number>();
    feed.push(1);
    const quiet = feed.quietFor(is(7), 15_000);
    await fake.sleeps(1);
    feed.push(2);
    await fake.sleeps(2);
    fake.advance(15_000);
    await expect(quiet).resolves.toEqual([]);
    expect(fake.time).toBe(1_015_000);
    expect(feed.closedBy).toBeUndefined();
  });

  it('returns a match received before the call at once, without sleeping', async () => {
    const feed = new MessageFeed<number>();
    feed.push(7);
    await expect(feed.quietFor(is(7), 15_000)).resolves.toEqual([7]);
    expect(fake.slept).toEqual([]);
  });

  it('returns as soon as a matching message arrives, before the window ends', async () => {
    const feed = new MessageFeed<number>();
    const quiet = feed.quietFor(is(7), 15_000);
    await fake.sleeps(1);
    fake.advance(5_000);
    feed.push(7);
    await expect(quiet).resolves.toEqual([7]);
    expect(fake.time).toBe(1_005_000);
    expect(fake.pending()).toBe(0);
  });

  it('returns early with closedBy set when the connection closes in the window', async () => {
    const feed = new MessageFeed<number>();
    const quiet = feed.quietFor(is(7), 15_000);
    await fake.sleeps(1);
    feed.close('WebSocket closed');
    await expect(quiet).resolves.toEqual([]);
    expect(feed.closedBy).toBe('WebSocket closed');
    expect(fake.time).toBe(1_000_000);
  });
});
