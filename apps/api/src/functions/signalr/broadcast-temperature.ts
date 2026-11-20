import type { InvocationContext } from '@azure/functions';

import { getDevicesRepository } from '../../shared/cosmos/devices-repository';
import { toTemperatureReading } from '../../shared/cosmos/temperatures-repository';
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
interface LiveReading {
  readonly deviceId: string;
  readonly payload: LiveTemperaturePayload;
}

/** One batch element as a live reading, or `null` to skip it. */
function toLiveReading(
  body: unknown,
  systemProperties: unknown,
  enqueuedTimeUtc: unknown
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
  return { deviceId, payload: { ...reading, enqueuedTimeUtc: enqueued } };
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** Injection seam: production reads owners from the devices container; tests
 *  pass a fake. Called once per distinct device in a batch. */
export interface BroadcastTemperatureDeps {
  ownerOf(deviceId: string): Promise<string | undefined>;
}

export const defaultBroadcastTemperatureDeps: BroadcastTemperatureDeps = {
  ownerOf: async deviceId => (await getDevicesRepository().getDeviceOwner(deviceId)).userId,
};

/** Each distinct device's owner: a string, `undefined` (no owner), or `null`
 *  when the read failed. Reads run in parallel and never throw. */
async function resolveOwners(
  deviceIds: Iterable<string>,
  deps: BroadcastTemperatureDeps
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
 * The `cardinality: 'many'` handler: `events[i]` pairs with
 * `triggerMetadata.systemPropertiesArray[i]` and
 * `triggerMetadata.enqueuedTimeUtcArray[i]`.
 */
export async function broadcastTemperatureHandler(
  events: unknown,
  context: InvocationContext,
  deps: BroadcastTemperatureDeps = defaultBroadcastTemperatureDeps
): Promise<void> {
  const batch = arrayOrEmpty(events);
  const metadata = context.triggerMetadata ?? {};
  const systemPropertiesArray = arrayOrEmpty(metadata['systemPropertiesArray']);
  const enqueuedTimeUtcArray = arrayOrEmpty(metadata['enqueuedTimeUtcArray']);

  const readings: LiveReading[] = [];
  let skipped = 0;
  batch.forEach((body, index) => {
    let reading: LiveReading | null = null;
    try {
      reading = toLiveReading(body, systemPropertiesArray[index], enqueuedTimeUtcArray[index]);
    } catch {
      reading = null;
    }
    if (reading) {
      readings.push(reading);
    } else {
      skipped += 1;
    }
  });

  const owners = await resolveOwners(
    readings.map(r => r.deviceId),
    deps
  );
  const messages: SignalRTemperatureMessage[] = [];
  let unowned = 0;
  let lookupFailed = 0;
  for (const { deviceId, payload } of readings) {
    const owner = owners.get(deviceId);
    if (owner === null) {
      lookupFailed += 1;
    } else if (owner === undefined) {
      unowned += 1;
    } else {
      messages.push({ target: TEMPERATURE, userId: owner, arguments: [payload] });
    }
  }

  context.extraOutputs.set(signalROutput, messages);
  context.log(
    `broadcastTemperature sent=${messages.length} skipped=${skipped}` +
      ` unowned=${unowned} lookupFailed=${lookupFailed}`
  );
}
