import { HubConnectionBuilder, LogLevel } from '@microsoft/signalr';
import type { components } from '@meatgeekv2/api-specs/types';

/** The hub messages, typed from the spec's `x-signalr` schemas. */
export type SignalRConnectionInfo = components['schemas']['SignalRConnectionInfo'];
export type TemperatureMessage = components['schemas']['TemperatureMessage'];
export type CookStartedMessage = components['schemas']['CookStartedMessage'];
export type CookStoppedMessage = components['schemas']['CookStoppedMessage'];

/** Each SignalR target the hub sends, and the type of its single argument. */
export interface HubMessages {
  temperature: TemperatureMessage;
  cook_started: CookStartedMessage;
  cook_stopped: CookStoppedMessage;
}

/**
 * One SignalR connection: the slice of `HubConnection` the live panel uses.
 * Tests implement this with a fake; the app uses `createSignalRHub`.
 */
export interface LiveHub {
  on<K extends keyof HubMessages>(target: K, handler: (message: HubMessages[K]) => void): void;
  /** Automatic reconnect has started. */
  onReconnecting(handler: () => void): void;
  /** Automatic reconnect succeeded. */
  onReconnected(handler: () => void): void;
  /** The connection closed for good: automatic reconnect gave up, or it was stopped. */
  onClose(handler: () => void): void;
  start(): Promise<void>;
  stop(): Promise<void>;
}

/** Builds a connection from what POST /negotiate returned. */
export type HubFactory = (info: SignalRConnectionInfo) => LiveHub;

/**
 * A real `HubConnection` to the URL negotiate returned. Its access token
 * factory returns the negotiate token; when that token expires (60 minutes)
 * automatic reconnect fails, the connection closes, and the caller negotiates
 * again for a new token and fresh device groups.
 */
export const createSignalRHub: HubFactory = ({ url, accessToken }) => {
  const connection = new HubConnectionBuilder()
    .withUrl(url, { accessTokenFactory: () => accessToken })
    .withAutomaticReconnect()
    .configureLogging(LogLevel.Warning)
    .build();
  return {
    on: (target, handler) => connection.on(target, handler),
    onReconnecting: handler => connection.onreconnecting(() => handler()),
    onReconnected: handler => connection.onreconnected(() => handler()),
    onClose: handler => connection.onclose(() => handler()),
    start: () => connection.start(),
    stop: () => connection.stop(),
  };
};
