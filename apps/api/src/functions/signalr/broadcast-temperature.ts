import type { InvocationContext } from '@azure/functions';
import {
  context as otelContext,
  metrics,
  SpanKind,
  trace,
  ValueType,
  type Attributes,
  type Meter,
  type Tracer,
} from '@opentelemetry/api';

import { getDevicesRepository } from '../../shared/cosmos/devices-repository';
import { toTemperatureReading } from '../../shared/cosmos/temperatures-repository';
import {
  extractCorrelation,
  getStandardDimensions,
  remoteParentContext,
  type ApplicationProperties,
} from '../../shared/telemetry/correlation';
import {
  LiveTemperaturePayload,
  signalROutput,
  SignalRTemperatureMessage,
  TEMPERATURE,
} from './envelope';

/**
 * HAR-60 — the live-reading producer.
 *
 * IoT Hub routes every device message to the `temperature-data` event hub
 * (`eventhub-realtime-route` in apps/infrastructure/modules/iot-hub/main.tf).
 * This Event Hub trigger reads it on the API's own consumer group
 * (`TEMPERATURE_BROADCAST_CONSUMER_GROUP`, "api-broadcast") and pushes each
 * reading to its device's owner: the message's `userId` is the `userId` stored
 * on the device, so only that owner's connections receive it, the same way cook
 * events reach their owner.
 *
 * OWNER LOOKUP (HAR-81). Each distinct device in a batch costs one point read of
 * the devices container (partition key = device id), so a change of owner takes
 * effect at the next reading. Before HAR-81 the reading went to a
 * `device-{deviceId}` group, and negotiate added the caller to one group per
 * device it owned: one SignalR REST call per device on every negotiate. With 98
 * devices, two negotiates in a row sent about 200 calls in under 2 s, and the
 * Free_F1 service throttled the whole instance with 429s. Addressing the user
 * needs no group membership, so negotiate makes no REST call but the token.
 *
 * A device with no stored owner (not registered) is not pushed and is counted
 * as `unowned`. A failed owner read drops that device's readings from this
 * batch's push and is counted as `lookupFailed`; the readings are still stored
 * by the IoT Hub route, and the next batch reads the owner again.
 *
 * TRUST RULE (MG-73). The device is the hub-stamped
 * `iothub-connection-device-id` system property, never `Body.deviceId`. Each
 * event is shaped as the stored IoT Hub document and run through
 * {@link toTemperatureReading}, the same mapper GET /temperatures/current uses,
 * so the pushed reading is exactly what that endpoint would return.
 *
 * BAD EVENTS. An event with no device id, or one the mapper rejects, is skipped
 * and counted. Nothing here throws on a bad event: a throw fails the whole batch,
 * and the host would replay it, good readings included. The one log line per
 * batch carries counts only — no device ids, no bodies.
 *
 * LATENCY (HAR-150). For each reading pushed to an owner, two OpenTelemetry
 * histograms are recorded (see {@link recordReadingLatency}):
 * - `meatgeek.reading.push_lag_ms`: the push time minus the reading's own
 *   timestamp (the device clock, as {@link toTemperatureReading} maps it);
 * - `meatgeek.reading.hub_lag_ms`: the hub-stamped `iothub-enqueuedtime` minus
 *   the reading's timestamp.
 * Together they split device→hub time from hub→push time. Metrics are
 * pre-aggregated by the exporter and never sampled, unlike requests and traces.
 * They carry no device or user attribute; the only attribute is
 * `negative: true` on a reading stamped after the time it is compared with
 * (clock skew), recorded as 0.
 *
 * TRACES (#222). Each valid reading gets one CONSUMER span,
 * `broadcastTemperature reading`, whose parent is the message's `traceparent`
 * application property (set by data-pusher on its publish span), so the reading's
 * trace runs device-controller → data-pusher → IoT Hub → this Function under one
 * TraceId. The span carries the six standard dimensions; its correlation id is
 * the message's `correlation.id`, or the invocation id when absent. A missing or
 * malformed traceparent leaves the span in the invocation's own trace. Each reading in a batch keeps its
 * own trace. A failing tracer never fails the batch.
 */

/** The event hub IoT Hub's realtime route writes to. Terraform-owned name. */
export const TEMPERATURE_EVENT_HUB = 'temperature-data';

/** Hub-stamped system property names. Source-fixed text. */
const CONNECTION_DEVICE_ID = 'iothub-connection-device-id';
const IOTHUB_ENQUEUED_TIME = 'iothub-enqueuedtime';
/** The Event Hub's own enqueued time, as the host puts it in system properties. */
const EVENTHUB_ENQUEUED_TIME = 'EnqueuedTimeUtc';

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/**
 * The event body as the stored document's `Body`. Depending on the binding's
 * data type the host hands over a parsed object, a JSON string, or bytes. A
 * string or bytes that is not JSON is returned as-is (a string), which the
 * mapper rejects, the same as IoT Hub storing a non-JSON payload as base64.
 */
export function decodeBody(body: unknown): unknown {
  let text: string;
  if (typeof body === 'string') {
    text = body;
  } else if (body instanceof Uint8Array) {
    // Buffer is a Uint8Array.
    text = Buffer.from(body.buffer, body.byteOffset, body.byteLength).toString('utf8');
  } else if (body instanceof ArrayBuffer) {
    text = Buffer.from(body).toString('utf8');
  } else {
    return body;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** A Date, or a string that parses as one, as a normalized ISO string. */
function toIsoString(value: unknown): string | undefined {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? undefined : value.toISOString();
  }
  if (typeof value === 'string' && value.length > 0) {
    const parsed = new Date(value);
    return Number.isNaN(parsed.getTime()) ? undefined : parsed.toISOString();
  }
  return undefined;
}

/** The hub-stamped enqueued time as the stored document carries it (a string). */
function storedEnqueuedTime(value: unknown): unknown {
  return value instanceof Date ? toIsoString(value) : value;
}

/** A valid batch element: its device and the payload to push. */
export interface LiveReading {
  readonly deviceId: string;
  readonly payload: LiveTemperaturePayload;
  /** The hub-stamped `iothub-enqueuedtime`, when the event carries a valid one. */
  readonly iothubEnqueuedTime?: string;
  /** The message's application properties (`traceparent`, `correlation.id`). */
  readonly properties?: ApplicationProperties;
}

/** Application properties with byte values decoded as UTF-8 text. */
function decodeProperties(value: unknown): ApplicationProperties | undefined {
  if (!isJsonObject(value)) {
    return undefined;
  }
  const decoded: ApplicationProperties = {};
  for (const [key, raw] of Object.entries(value)) {
    decoded[key] =
      raw instanceof Uint8Array
        ? Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
        : raw;
  }
  return decoded;
}

/** One batch element as a live reading, or `null` to skip it. */
function toLiveReading(
  body: unknown,
  systemProperties: unknown,
  enqueuedTimeUtc: unknown,
  properties: unknown
): LiveReading | null {
  if (!isJsonObject(systemProperties)) {
    return null;
  }
  const deviceId = systemProperties[CONNECTION_DEVICE_ID];
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    return null;
  }
  const document = {
    SystemProperties: {
      [CONNECTION_DEVICE_ID]: deviceId,
      [IOTHUB_ENQUEUED_TIME]: storedEnqueuedTime(systemProperties[IOTHUB_ENQUEUED_TIME]),
    },
    Body: decodeBody(body),
  };
  const reading = toTemperatureReading(document, deviceId);
  if (!reading) {
    return null;
  }
  const enqueued =
    toIsoString(enqueuedTimeUtc) ??
    toIsoString(systemProperties[EVENTHUB_ENQUEUED_TIME]) ??
    toIsoString(systemProperties[IOTHUB_ENQUEUED_TIME]);
  if (enqueued === undefined) {
    return null;
  }
  return {
    deviceId,
    payload: { ...reading, enqueuedTimeUtc: enqueued },
    iothubEnqueuedTime: toIsoString(systemProperties[IOTHUB_ENQUEUED_TIME]),
    properties: decodeProperties(properties),
  };
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Push lag: push time minus the reading's timestamp. Source-fixed name. */
export const PUSH_LAG_METRIC = 'meatgeek.reading.push_lag_ms';
/** Hub lag: `iothub-enqueuedtime` minus the reading's timestamp. Source-fixed name. */
export const HUB_LAG_METRIC = 'meatgeek.reading.hub_lag_ms';

/** Injection seam: production reads owners from the devices container, the
 *  wall clock and the global meter; tests pass a fake lookup, a fixed clock and
 *  a recording meter. `ownerOf` is called once per distinct device in a batch. */
export interface BroadcastTemperatureDeps {
  ownerOf(deviceId: string): Promise<string | undefined>;
  /** The push time the lag is measured to. */
  now(): Date;
  readonly meter: Meter;
  /** Starts each reading's span in the device's trace (#222); the global
   *  tracer when absent. */
  readonly tracer?: Tracer;
}

export const defaultBroadcastTemperatureDeps: BroadcastTemperatureDeps = {
  ownerOf: async deviceId => (await getDevicesRepository().getDeviceOwner(deviceId)).userId,
  now: () => new Date(),
  // Read at call time, not at import: the metrics API has no proxy provider, so
  // a meter taken before useAzureMonitor registers the global one stays a no-op.
  get meter() {
    return metrics.getMeter('meatgeek-api');
  },
  get tracer() {
    return defaultTracer();
  },
};

/** The global tracer, read at call time like the meter. */
function defaultTracer(): Tracer {
  return trace.getTracer('meatgeek-api');
}

/** The span each reading gets in its device's trace. Source-fixed name. */
export const READING_SPAN = 'broadcastTemperature reading';

/** One CONSUMER span per reading, a child of its message's traceparent. Never
 *  throws: a failing tracer costs the span, not the push. */
function traceReadings(
  readings: readonly LiveReading[],
  invocationId: string,
  tracer: Tracer
): void {
  for (const reading of readings) {
    try {
      const { correlationId, traceparent } = extractCorrelation(reading.properties, invocationId);
      const parent = remoteParentContext(traceparent);
      const attributes = getStandardDimensions({
        deviceId: reading.deviceId,
        correlationId,
        cookId: reading.payload.cookId,
      });
      // No device parent: the span joins the invocation's own trace.
      const span = tracer.startSpan(
        READING_SPAN,
        { kind: SpanKind.CONSUMER, attributes: { ...attributes } },
        parent ?? otelContext.active()
      );
      span.end();
    } catch {
      // Tracing only; never fail the batch.
    }
  }
}

/** `later - earlier` in whole ms, clamped to 0 with `negative: true` when the
 *  reading is stamped after the time it is compared with. */
function lag(laterMs: number, earlierMs: number): { value: number; attributes: Attributes } {
  const diff = Math.round(laterMs - earlierMs);
  return diff < 0 ? { value: 0, attributes: { negative: true } } : { value: diff, attributes: {} };
}

/** Record both lags for the readings pushed to an owner. Never throws: a bad
 *  timestamp or a failing meter costs the measurement, not the push. */
function recordReadingLatency(
  readings: readonly LiveReading[],
  pushedAt: Date,
  meter: Meter
): void {
  try {
    const pushLag = meter.createHistogram(PUSH_LAG_METRIC, {
      description: 'Time from the reading timestamp (device clock) to its push to the owner',
      unit: 'ms',
      valueType: ValueType.INT,
    });
    const hubLag = meter.createHistogram(HUB_LAG_METRIC, {
      description: 'Time from the reading timestamp (device clock) to IoT Hub enqueuing it',
      unit: 'ms',
      valueType: ValueType.INT,
    });
    const pushedMs = pushedAt.getTime();
    for (const { payload, iothubEnqueuedTime } of readings) {
      const readingMs = Date.parse(payload.timestamp);
      if (Number.isNaN(readingMs)) {
        continue;
      }
      const push = lag(pushedMs, readingMs);
      pushLag.record(push.value, push.attributes);
      if (iothubEnqueuedTime !== undefined) {
        const hub = lag(Date.parse(iothubEnqueuedTime), readingMs);
        hubLag.record(hub.value, hub.attributes);
      }
    }
  } catch {
    // Measurement only; never fail the batch.
  }
}

/** Each distinct device's owner: a string, `undefined` (no owner), or `null`
 *  when the read failed. Reads run in parallel and never throw. */
export async function resolveOwners(
  deviceIds: Iterable<string>,
  deps: Pick<BroadcastTemperatureDeps, 'ownerOf'>
): Promise<Map<string, string | undefined | null>> {
  const ids = [...new Set(deviceIds)];
  const owners = await Promise.all(
    ids.map(async id => {
      try {
        return await deps.ownerOf(id);
      } catch {
        return null;
      }
    })
  );
  return new Map(ids.map((id, index) => [id, owners[index]]));
}

/**
 * A `cardinality: 'many'` batch from the temperature-data event hub as
 * readings, in batch order: `events[i]` pairs with
 * `triggerMetadata.systemPropertiesArray[i]` and
 * `triggerMetadata.enqueuedTimeUtcArray[i]`. A bad event is counted in
 * `skipped`, never thrown. Shared by every trigger on that event hub.
 */
export function readingsOfBatch(
  events: unknown,
  context: InvocationContext
): { readings: LiveReading[]; skipped: number } {
  const batch = arrayOrEmpty(events);
  const metadata = context.triggerMetadata ?? {};
  const systemPropertiesArray = arrayOrEmpty(metadata['systemPropertiesArray']);
  const enqueuedTimeUtcArray = arrayOrEmpty(metadata['enqueuedTimeUtcArray']);
  const propertiesArray = arrayOrEmpty(metadata['propertiesArray']);

  const readings: LiveReading[] = [];
  let skipped = 0;
  batch.forEach((body, index) => {
    let reading: LiveReading | null = null;
    try {
      reading = toLiveReading(
        body,
        systemPropertiesArray[index],
        enqueuedTimeUtcArray[index],
        propertiesArray[index]
      );
    } catch {
      reading = null;
    }
    if (reading) {
      readings.push(reading);
    } else {
      skipped += 1;
    }
  });
  return { readings, skipped };
}

/**
 * The `cardinality: 'many'` handler: `events[i]` pairs with
 * `triggerMetadata.systemPropertiesArray[i]` and
 * `triggerMetadata.enqueuedTimeUtcArray[i]`.
 */
export async function broadcastTemperatureHandler(
  events: unknown,
  context: InvocationContext,
  deps: BroadcastTemperatureDeps = defaultBroadcastTemperatureDeps
): Promise<void> {
  const { readings, skipped } = readingsOfBatch(events, context);
  traceReadings(readings, context.invocationId, deps.tracer ?? defaultTracer());

  const owners = await resolveOwners(
    readings.map(r => r.deviceId),
    deps
  );
  const messages: SignalRTemperatureMessage[] = [];
  const pushed: LiveReading[] = [];
  let unowned = 0;
  let lookupFailed = 0;
  for (const reading of readings) {
    const owner = owners.get(reading.deviceId);
    if (owner === null) {
      lookupFailed += 1;
    } else if (owner === undefined) {
      unowned += 1;
    } else {
      messages.push({ target: TEMPERATURE, userId: owner, arguments: [reading.payload] });
      pushed.push(reading);
    }
  }

  context.extraOutputs.set(signalROutput, messages);
  recordReadingLatency(pushed, deps.now(), deps.meter);
  context.log(
    `broadcastTemperature sent=${messages.length} skipped=${skipped}` +
      ` unowned=${unowned} lookupFailed=${lookupFailed}`
  );
}
