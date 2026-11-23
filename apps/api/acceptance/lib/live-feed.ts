import { clock, sleepUntilWoken } from './clock';

/**
 * HAR-142 (goal HAR-130) — the messages one SignalR client has received, and
 * the two waits a proof makes on them, both on the injected clock
 * (./clock):
 *
 *   - {@link MessageFeed.waitFor}: a message that must arrive, within a cap;
 *   - {@link MessageFeed.quietFor}: a window in which a message must NOT
 *     arrive. It returns as soon as one does, so a leak fails at once rather
 *     than at the window's end.
 *
 * The connection's handlers call {@link MessageFeed.push} and
 * {@link MessageFeed.close}; either wakes a wait at once.
 */
export class MessageFeed<T> {
  readonly received: T[] = [];
  private closedReason: string | undefined;
  private wake: (() => void) | undefined;

  /** Why the connection closed, once it has. */
  get closedBy(): string | undefined {
    return this.closedReason;
  }

  push(message: T): void {
    this.received.push(message);
    this.wake?.();
  }

  /** The first close is kept. */
  close(reason: string): void {
    if (this.closedReason === undefined) {
      this.closedReason = reason;
    }
    this.wake?.();
  }

  /**
   * The first message (received before the call or during it) that `match`
   * accepts, waiting up to `capMs`. `undefined` when the cap passes or the
   * connection closes first.
   */
  async waitFor(match: (message: T) => boolean, capMs: number): Promise<T | undefined> {
    const deadline = clock().now() + capMs;
    let found = this.received.find(match);
    while (found === undefined && this.closedReason === undefined && clock().now() < deadline) {
      await this.sleep(deadline - clock().now());
      found = this.received.find(match);
    }
    return found;
  }

  /**
   * Wait `ms`, and return every message (received before the call or during
   * it) that `match` accepts: empty when the window passed with none. Returns
   * early, with what it has, once one arrives or the connection closes; the
   * caller tells the cases apart with {@link closedBy}.
   */
  async quietFor(match: (message: T) => boolean, ms: number): Promise<T[]> {
    const deadline = clock().now() + ms;
    let found = this.received.filter(match);
    while (found.length === 0 && this.closedReason === undefined && clock().now() < deadline) {
      await this.sleep(deadline - clock().now());
      found = this.received.filter(match);
    }
    return found;
  }

  private sleep(ms: number): Promise<void> {
    return sleepUntilWoken(ms, next => {
      this.wake = next;
    });
  }
}
