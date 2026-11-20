import type { Page, Route, WebSocketRoute } from '@playwright/test';
import type { components } from '@meatgeekv2/api-specs/types';
import { fulfillJson, fulfillPreflight } from './http';

type Schemas = components['schemas'];

/** Each hub target and the type of its one argument, as the spec's `x-signalr` declares. */
export interface HubMessages {
  temperature: Schemas['TemperatureMessage'];
  cook_started: Schemas['CookStartedMessage'];
  cook_stopped: Schemas['CookStoppedMessage'];
}

/** SignalR's JSON protocol ends every message with the ASCII record separator. */
const RS = '\u001e';
const MessageType = { Invocation: 1, Ping: 6, Close: 7 } as const;

const HUB_ORIGIN = 'https://hub.test';
const HUB_PATH = '/client/';

/**
 * The Azure SignalR client endpoint, faked at the network edge. The app's real
 * `@microsoft/signalr` client:
 *
 * 1. POSTs `https://hub.test/client/negotiate?...`, answered with a negotiate
 *    response offering WebSockets only;
 * 2. opens `wss://hub.test/client/?hub=...&id=...`, answered by
 *    `page.routeWebSocket` speaking the JSON hub protocol: `{}` to the
 *    handshake, a ping for each ping, and invocations when the test pushes.
 */
export class FakeSignalRHub {
  /** What the API's POST /negotiate returns: where the client connects. */
  readonly connectionInfo = {
    url: `${HUB_ORIGIN}${HUB_PATH}?hub=temperatureHub`,
    accessToken: 'fake',
  };
  readonly negotiateRequests: URL[] = [];
  /** The handshakes received, in order, e.g. `{"protocol":"json","version":1}`. */
  readonly handshakes: unknown[] = [];
  readonly unexpected: string[] = [];
  private readonly ready = new Set<WebSocketRoute>();
  private connections = 0;

  async install(page: Page): Promise<void> {
    await page.route(`${HUB_ORIGIN}${HUB_PATH}negotiate**`, route => this.negotiate(route));
    await page.routeWebSocket(`wss://hub.test/**`, ws => this.accept(ws));
  }

  /** Connections that completed the handshake and have not closed. */
  get connectedCount(): number {
    return this.ready.size;
  }

  /** Sends one invocation of `target` to every connected client. */
  push<K extends keyof HubMessages>(target: K, message: HubMessages[K]): void {
    if (this.ready.size === 0) {
      throw new Error(`No SignalR client is connected to receive "${target}".`);
    }
    const frame = JSON.stringify({
      type: MessageType.Invocation,
      target,
      arguments: [message],
    });
    for (const ws of this.ready) ws.send(frame + RS);
  }

  private async negotiate(route: Route): Promise<void> {
    const request = route.request();
    if (request.method() === 'OPTIONS') return fulfillPreflight(route);
    const url = new URL(request.url());
    this.negotiateRequests.push(url);
    if (request.method() !== 'POST' || request.headers()['authorization'] !== 'Bearer fake') {
      this.unexpected.push(`negotiate: ${request.method()} without the negotiate token`);
      return fulfillJson(route, 401, {});
    }
    this.connections += 1;
    const token = `e2e-connection-${this.connections}`;
    return fulfillJson(route, 200, {
      negotiateVersion: 1,
      connectionId: token,
      connectionToken: token,
      availableTransports: [{ transport: 'WebSockets', transferFormats: ['Text', 'Binary'] }],
    });
  }

  private accept(ws: WebSocketRoute): void {
    const url = new URL(ws.url());
    if (url.pathname !== HUB_PATH || !url.searchParams.get('id')) {
      this.unexpected.push(`websocket: ${ws.url()}`);
      void ws.close({ code: 1008, reason: 'Unexpected hub URL' });
      return;
    }
    ws.onClose(() => this.ready.delete(ws));
    ws.onMessage(data => {
      const text = typeof data === 'string' ? data : data.toString('utf8');
      for (const record of text.split(RS)) {
        if (record !== '') this.receive(ws, record);
      }
    });
  }

  private receive(ws: WebSocketRoute, record: string): void {
    const message = JSON.parse(record) as { type?: number; protocol?: string };
    if (!this.ready.has(ws)) {
      this.handshakes.push(message);
      if (message.protocol !== 'json') {
        ws.send(JSON.stringify({ error: `Unsupported protocol ${message.protocol}` }) + RS);
        this.unexpected.push(`handshake: ${record}`);
        return;
      }
      ws.send('{}' + RS);
      this.ready.add(ws);
      return;
    }
    switch (message.type) {
      case MessageType.Ping:
        // Any message from the server resets the client's 30 s server timeout.
        ws.send(JSON.stringify({ type: MessageType.Ping }) + RS);
        return;
      case MessageType.Close:
        this.ready.delete(ws);
        return;
      default:
        this.unexpected.push(`hub message: ${record}`);
    }
  }
}
