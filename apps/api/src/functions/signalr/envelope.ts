import { output } from '@azure/functions';
import type { TemperatureReading } from '@meatgeekv2/api-interfaces';
import { randomUUID } from 'crypto';

// SignalR hub + connection-string setting. Kept in one place so negotiate's
// management client (shared/signalr), the cook output binding, and the local
// emulator config all agree on the same names.
export const HUB_NAME = 'temperatureHub';
export const SIGNALR_CONNECTION_SETTING = 'AzureSignalRConnectionString';

// Cook-lifecycle event discriminators.
//
// These strings are the wire contract with the Go data-pusher consumer. They
// MUST match, byte-for-byte, the EventType constants in
// apps/data-pusher/internal/signalr/events.go (EventTypeCookStarted /
// EventTypeCookStopped) and the SignalRMessageType enum in
// libs/api-specs/spec/components/schemas/signalr-payloads.yaml. Changing them
// here silently breaks the consumer's dispatcher.
export const COOK_STARTED = 'cook_started';
export const COOK_STOPPED = 'cook_stopped';

export type CookEventType = typeof COOK_STARTED | typeof COOK_STOPPED;

// Minimal shape buildCookEnvelope needs to stamp the envelope-level ids. The
// full payload the producer hands in is preserved via the generic parameter so
// callers keep their concrete Cook type on `payload`.
export interface CookRef {
  id: string;
  deviceId: string;
  userId: string;
}

export interface CorrelationContext {
  id: string;
}

// Mirrors SignalREnvelopeBase in signalr-payloads.yaml (the fields the producer
// stamps). `payload` carries the concrete cook the caller passed in.
export interface CookEventEnvelope<T extends CookRef = CookRef> {
  type: CookEventType;
  timestamp: string;
  messageId: string;
  deviceId: string;
  userId: string;
  // Optional — see buildCookEnvelope. The envelope-level cookId is the
  // "currently-active cook id": present on cook_started, OMITTED on
  // cook_stopped. The Go consumer's wire type is `CookID *string
  // json:"cookId,omitempty"` and it asserts nil on cook_stopped, so the key
  // must be absent (not undefined-serialized) in that case.
  cookId?: string;
  correlation: CorrelationContext;
  payload: T;
}

// Shape of a single message written to the SignalR output binding. `userId`
// scopes delivery to that SignalR user: for cook events, the cook's owner, the
// authenticated principal (see DEC-4 in main.ts).
export interface SignalROutputMessage<T extends CookRef = CookRef> {
  target: CookEventType;
  userId: string;
  arguments: [CookEventEnvelope<T>];
}

// HAR-60: the SignalR target a live reading is pushed on. Clients subscribe with
// `connection.on('temperature', …)`.
export const TEMPERATURE = 'temperature';

// A live reading as pushed: exactly what GET /temperatures/current would return
// for the same message (toTemperatureReading), plus the Event Hub enqueued time
// so a client can measure delivery delay.
export interface LiveTemperaturePayload extends TemperatureReading {
  enqueuedTimeUtc: string;
}

// Shape of a single group-scoped message written to the SignalR output binding
// by broadcastTemperature. `groupName` is always `device-{deviceId}` (see
// deviceGroup in shared/signalr): negotiate puts each user in the groups of the
// devices they own, so a reading reaches exactly the device's owner(s).
export interface SignalRGroupMessage {
  target: typeof TEMPERATURE;
  groupName: string;
  arguments: [LiveTemperaturePayload];
}

// Build a cook-lifecycle envelope. The envelope-level cookId is the
// "currently-active cook id": it equals the payload cook's id on cook_started
// and is OMITTED entirely on cook_stopped (there is no active cook after a
// stop; the stopped cook stays identifiable via payload.id). The key is left
// off — not set to undefined — so JSON.stringify drops it, matching the Go
// consumer's `json:"cookId,omitempty"` wire type, which expects nil on
// cook_stopped. correlation.id is the propagated request/trace id.
export function buildCookEnvelope<T extends CookRef>(
  type: CookEventType,
  cook: T,
  correlationId: string
): CookEventEnvelope<T> {
  return {
    type,
    timestamp: new Date().toISOString(),
    messageId: randomUUID(),
    deviceId: cook.deviceId,
    userId: cook.userId,
    ...(type === COOK_STOPPED ? {} : { cookId: cook.id }),
    correlation: { id: correlationId },
    payload: cook,
  };
}

// Shared SignalR output binding, registered on every SignalR producer in main.ts:
// the cook-lifecycle producers (startCook, stopCook) and broadcastTemperature. It lives here — not in main.ts — so the
// handlers can reference the exact same FunctionOutput object they emit through
// without importing the app entrypoint (which would create an import cycle and
// pull app.http registrations into unit tests). The Functions runtime matches
// context.extraOutputs.set() to a binding by object identity, so the reference
// must be shared.
export const signalROutput = output.generic({
  type: 'signalR',
  name: 'signalRMessages',
  hubName: HUB_NAME,
  connectionStringSetting: SIGNALR_CONNECTION_SETTING,
});
