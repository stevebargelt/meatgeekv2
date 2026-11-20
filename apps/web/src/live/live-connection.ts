import type {
  CookStoppedMessage,
  HubFactory,
  LiveHub,
  SignalRConnectionInfo,
  TemperatureMessage,
} from './hub';

/**
 * - `connecting`: the first negotiate and start are in flight.
 * - `connected`: the hub is connected.
 * - `reconnecting`: automatic reconnect is running, or the connection closed
 *   and the next negotiate is waiting for its backoff.
 * - `signed-out`: negotiate answered 401; nothing more is tried.
 */
export type ConnectionStatus = 'connecting' | 'connected' | 'reconnecting' | 'signed-out';

export type NegotiateResult =
  | { ok: true; info: SignalRConnectionInfo }
  | { ok: false; status?: number };

export interface LiveConnectionOptions {
  /** POST /negotiate. A thrown error is treated like a failed status. */
  negotiate: () => Promise<NegotiateResult>;
  createHub: HubFactory;
  onStatus: (status: ConnectionStatus) => void;
  /** After every successful start and every automatic reconnect. */
  onConnected: () => void;
  onTemperature: (message: TemperatureMessage) => void;
  onCookStopped: (message: CookStoppedMessage) => void;
}

/** Waits before each new negotiate after a failure or a close; the last repeats forever. */
export const RETRY_DELAYS_MS = [2_000, 5_000, 10_000, 30_000] as const;

/**
 * Keeps one hub connection open until the returned function is called.
 *
 * The hub's own automatic reconnect handles short drops. When it gives up and
 * the connection closes, or when negotiate or start fails (a 429, a 503, a
 * network error), this negotiates again for a fresh token and starts a new
 * connection after 2, 5, 10, then every 30 s. A 401
 * from negotiate stops it: only signing in again can fix that.
 */
export function openLiveConnection(options: LiveConnectionOptions): () => void {
  let stopped = false;
  let hub: LiveHub | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let failures = 0;

  function retryLater() {
    if (stopped) return;
    const delay = RETRY_DELAYS_MS[Math.min(failures, RETRY_DELAYS_MS.length - 1)];
    failures += 1;
    options.onStatus('reconnecting');
    timer = setTimeout(() => {
      timer = undefined;
      void connect();
    }, delay);
  }

  async function connect() {
    let result: NegotiateResult;
    try {
      result = await options.negotiate();
    } catch {
      result = { ok: false };
    }
    if (stopped) return;
    if (!result.ok) {
      if (result.status === 401) {
        options.onStatus('signed-out');
        return;
      }
      retryLater();
      return;
    }

    const current = options.createHub(result.info);
    hub = current;
    // Callbacks from a connection that was replaced or stopped are ignored.
    const isCurrent = () => !stopped && hub === current;
    const dropAndRetry = () => {
      if (!isCurrent()) return;
      hub = undefined;
      retryLater();
    };

    current.on('temperature', message => {
      if (isCurrent()) options.onTemperature(message);
    });
    current.on('cook_stopped', message => {
      if (isCurrent()) options.onCookStopped(message);
    });
    current.onReconnecting(() => {
      if (isCurrent()) options.onStatus('reconnecting');
    });
    current.onReconnected(() => {
      if (!isCurrent()) return;
      options.onStatus('connected');
      options.onConnected();
    });
    current.onClose(dropAndRetry);

    try {
      await current.start();
    } catch {
      dropAndRetry();
      return;
    }
    if (!isCurrent()) return;
    failures = 0;
    options.onStatus('connected');
    options.onConnected();
  }

  options.onStatus('connecting');
  void connect();

  return () => {
    if (stopped) return;
    stopped = true;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    const last = hub;
    hub = undefined;
    last?.stop().catch(() => undefined);
  };
}
