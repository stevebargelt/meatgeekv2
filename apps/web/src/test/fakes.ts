import type { AccountInfo } from '@azure/msal-browser';
import type { ApiClient, Cook, Device } from '../api/client';
import type { AppConfig } from '../config/config';
import type {
  HubFactory,
  HubMessages,
  LiveHub,
  SignalRConnectionInfo,
  TemperatureMessage,
} from '../live/hub';

export const TEST_CONFIG: AppConfig = {
  apiBaseUrl: 'https://api.example.test/api',
  tenantId: '7466b411-ac2e-49a0-b5d5-b1e866d26bac',
  clientId: '11111111-2222-3333-4444-555555555555',
  apiScope: 'api://348570b2-44e5-41a6-ad15-2a7032366130/access_as_user',
};

export const TEST_ACCOUNT = {
  homeAccountId: 'oid.tid',
  environment: 'login.microsoftonline.com',
  tenantId: TEST_CONFIG.tenantId,
  username: 'pitmaster@example.com',
  localAccountId: 'oid',
  name: 'Pat Pitmaster',
} as AccountInfo;

/** The slice of PublicClientApplication the app calls, as jest mocks. */
export function createFakeMsal(account: AccountInfo | null = TEST_ACCOUNT) {
  return {
    initialize: jest.fn().mockResolvedValue(undefined),
    getActiveAccount: jest.fn(() => account),
    getAllAccounts: jest.fn(() => (account ? [account] : [])),
    setActiveAccount: jest.fn(),
    addEventCallback: jest.fn(),
    loginRedirect: jest.fn().mockResolvedValue(undefined),
    logoutRedirect: jest.fn().mockResolvedValue(undefined),
    acquireTokenSilent: jest.fn().mockResolvedValue({ accessToken: 'token-from-silent' }),
    acquireTokenRedirect: jest.fn().mockResolvedValue(undefined),
  };
}

export type FakeMsal = ReturnType<typeof createFakeMsal>;

export function jsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

/** The API's flat error body, `{error, message, requestId}`, with `status`. */
export function errorResponse(
  status: number,
  error: string,
  message: string,
  requestId = `req-${status}`
): Response {
  return jsonResponse(status, { error, message, requestId });
}

/** A claim code of the shape a device shows (the spec's example, not a real device's). */
export const TEST_CLAIM_CODE = '7K3M-9QXR-2HTV';

export interface RecordedRequest {
  method: string;
  url: string;
  headers: Headers;
  body: unknown;
}

/**
 * Installs a fake global fetch. `respond` decides each answer; every request
 * the app sends is recorded with its parsed JSON body.
 */
export function installFetch(respond: (req: RecordedRequest) => Response | Promise<Response>) {
  const requests: RecordedRequest[] = [];
  const fetchMock = jest.fn(async (input: Request) => {
    const text = await input.clone().text();
    const recorded: RecordedRequest = {
      method: input.method,
      url: input.url,
      headers: input.headers,
      body: text === '' ? undefined : JSON.parse(text),
    };
    requests.push(recorded);
    return respond(recorded);
  });
  globalThis.fetch = fetchMock as unknown as typeof fetch;
  return { requests, fetchMock };
}

export const BRISKET_BOX: Device = {
  id: 'meatgeek3',
  userId: 'tid:oid',
  name: 'Brisket Box',
  model: 'MeatGeek V1',
  location: 'Backyard',
  isActive: true,
  connectionStatus: 'online',
};

export const OFFSET: Device = {
  ...BRISKET_BOX,
  id: 'offset-1',
  name: 'Offset',
  location: undefined,
};

/** A cook as the API returns it; override any field. */
export function makeCook(overrides: Partial<Cook> = {}): Cook {
  return {
    id: '0b6f1d2e-6a51-4c3e-9f6e-8a1d2c3b4a5f',
    userId: 'tid:oid',
    deviceId: BRISKET_BOX.id,
    name: 'Saturday brisket',
    meatType: 'brisket',
    status: 'active',
    startTime: '2026-11-20T14:00:00.000Z',
    ...overrides,
  };
}

/**
 * Wraps `client` so the promise of every GET it sends is kept, by the path
 * template it was called with (`'/devices/{id}'`).
 *
 * Awaiting one of those promises inside `act` waits until the component has
 * applied that answer: the component awaited (or `.then`-ed) the same promise
 * when it sent the request, before the test did, so its continuation (and the
 * state it sets) runs first. That is a wait on an event, not on time.
 */
export function trackGets(client: ApiClient) {
  const sent: { path: string; answer: Promise<unknown> }[] = [];
  const get = client.GET as (path: string, init?: unknown) => Promise<unknown>;
  const GET = ((path: string, init?: unknown) => {
    const answer = get(path, init);
    sent.push({ path, answer });
    return answer;
  }) as ApiClient['GET'];
  return {
    client: { ...client, GET } as ApiClient,
    /** The answers to each GET of `path` so far, in the order they were sent. */
    gets: (path: string) => sent.filter(s => s.path === path).map(s => s.answer),
  };
}

/** The path and query of a recorded request, relative to the API base URL. */
export function apiPath(req: RecordedRequest): string {
  const url = new URL(req.url);
  return url.pathname.replace(new URL(TEST_CONFIG.apiBaseUrl).pathname, '') + url.search;
}

/**
 * A fake SignalR connection. `emit`, `reconnecting`, `reconnected` and `close`
 * play what the service would do; `start` resolves unless `failStart` is set.
 */
export class FakeHub implements LiveHub {
  private handlers: { [K in keyof HubMessages]?: ((message: HubMessages[K]) => void)[] } = {};
  private reconnectingHandlers: (() => void)[] = [];
  private reconnectedHandlers: (() => void)[] = [];
  private closeHandlers: (() => void)[] = [];
  failStart = false;
  readonly start = jest.fn(async () => {
    if (this.failStart) throw new Error('start failed');
  });
  readonly stop = jest.fn(async () => undefined);

  constructor(readonly info: SignalRConnectionInfo) {}

  on<K extends keyof HubMessages>(target: K, handler: (message: HubMessages[K]) => void): void {
    const list = (this.handlers[target] ?? []) as ((message: HubMessages[K]) => void)[];
    list.push(handler);
    (this.handlers as Record<string, unknown>)[target] = list;
  }
  onReconnecting(handler: () => void) {
    this.reconnectingHandlers.push(handler);
  }
  onReconnected(handler: () => void) {
    this.reconnectedHandlers.push(handler);
  }
  onClose(handler: () => void) {
    this.closeHandlers.push(handler);
  }

  emit<K extends keyof HubMessages>(target: K, message: HubMessages[K]) {
    for (const handler of (this.handlers[target] ?? []) as ((m: HubMessages[K]) => void)[]) {
      handler(message);
    }
  }
  reconnecting() {
    this.reconnectingHandlers.forEach(handler => handler());
  }
  reconnected() {
    this.reconnectedHandlers.forEach(handler => handler());
  }
  close() {
    this.closeHandlers.forEach(handler => handler());
  }
}

/** A hub factory that records every connection it builds. */
export function createFakeHubs() {
  const hubs: FakeHub[] = [];
  const createHub: HubFactory = jest.fn((info: SignalRConnectionInfo) => {
    const hub = new FakeHub(info);
    hubs.push(hub);
    return hub;
  });
  return {
    hubs,
    createHub,
    latest(): FakeHub {
      const hub = hubs[hubs.length - 1];
      if (!hub) throw new Error('No hub connection was built.');
      return hub;
    },
  };
}

export type FakeHubs = ReturnType<typeof createFakeHubs>;

/** A `temperature` message, as the hub sends it; override any field. */
export function makeTemperature(overrides: Partial<TemperatureMessage> = {}): TemperatureMessage {
  return {
    deviceId: BRISKET_BOX.id,
    timestamp: '2026-11-20T15:00:00.000Z',
    enqueuedTimeUtc: '2026-11-20T15:00:00.500Z',
    grillTemp: 225,
    probe1Temp: 150,
    ...overrides,
  };
}

/**
 * jsdom has no layout and no ResizeObserver, so recharts' ResponsiveContainer
 * would measure 0 × 0 and draw nothing. This one reports `width` × `height`
 * for every observed element. Returns a function that restores the original.
 */
export function installResizeObserver(width = 800, height = 320): () => void {
  const original = globalThis.ResizeObserver;
  class FakeResizeObserver {
    constructor(private readonly callback: ResizeObserverCallback) {}
    observe(target: Element) {
      this.callback(
        [{ target, contentRect: { width, height } } as unknown as ResizeObserverEntry],
        this as unknown as ResizeObserver
      );
    }
    unobserve() {
      // nothing to release
    }
    disconnect() {
      // nothing to release
    }
  }
  globalThis.ResizeObserver = FakeResizeObserver as unknown as typeof ResizeObserver;
  return () => {
    globalThis.ResizeObserver = original;
  };
}
