import type { InvocationContext } from '@azure/functions';

import { toTemperatureReading } from '../../shared/cosmos/temperatures-repository';
import { deviceGroup } from '../../shared/signalr/signalr-management';
import { signalROutput, SignalRGroupMessage, TEMPERATURE } from './envelope';

/**
 * HAR-60 — the live-reading producer.
 *
 * IoT Hub routes every device message to the `temperature-data` event hub
 * (`eventhub-realtime-route` in apps/infrastructure/modules/iot-hub/main.tf).
 * This Event Hub trigger reads it on the API's own consumer group
 * (`TEMPERATURE_BROADCAST_CONSUMER_GROUP`, "api-broadcast") and pushes each
 * reading to its device's SignalR group, `device-{deviceId}`. negotiate (HAR-57)
 * puts each user in the groups of the devices they own, so a reading reaches
 * only its device's owner.
 *
 * TRUST RULE (MG-73). The device is the hub-stamped
 * `iothub-connection-device-id` system property, never `Body.deviceId`. Each
 * event is shaped as the stored IoT Hub document and run through
 * {@link toTemperatureReading}, the same mapper GET /temperatures/current uses,
 * so the pushed reading is exactly what that endpoint would return.
 *
 * COALESCED PUSH (HAR-81). Each batch pushes only the newest reading of each
 * device, newest by the Event Hub enqueued time the message carries
 * (`enqueuedTimeUtc`); on a tie the later event in the batch wins. Every reading
 * is still stored (IoT Hub's own `cosmos-storage` route writes it; nothing here
 * stores anything), only the live push is coalesced. A real device sends every
 * 5 s, so a batch normally holds one reading per device and nothing changes for
 * it; a burst (the acceptance top-up sends thousands of readings in minutes)
 * costs one SignalR message per device per batch instead of one per reading,
 * which keeps the dev SignalR (Free_F1, 20,000 messages a day) inside its quota.
 * The `temperature` message itself is unchanged.
 *
 * BAD EVENTS. An event with no device id, or one the mapper rejects, is skipped
 * and counted. Nothing here throws on a bad event: a throw fails the whole batch,
 * and the host would replay it, good readings included. The one log line per
 * batch carries counts only — no device ids, no bodies: `sent` messages, the
 * good readings `coalesced` into a newer one of the same device, and `skipped`
 * bad events.
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

/** One batch element as a SignalR group message, or `null` to skip it. */
function toGroupMessage(
  body: unknown,
  systemProperties: unknown,
  enqueuedTimeUtc: unknown
): SignalRGroupMessage | null {
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
    target: TEMPERATURE,
    groupName: deviceGroup(deviceId),
    arguments: [{ ...reading, enqueuedTimeUtc: enqueued }],
  };
}

function arrayOrEmpty(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/**
 * The `cardinality: 'many'` handler: `events[i]` pairs with
 * `triggerMetadata.systemPropertiesArray[i]` and
 * `triggerMetadata.enqueuedTimeUtcArray[i]`. Sends one message per device in the
 * batch, carrying that device's newest reading.
 */
export async function broadcastTemperatureHandler(
  events: unknown,
  context: InvocationContext
): Promise<void> {
  const batch = arrayOrEmpty(events);
  const metadata = context.triggerMetadata ?? {};
  const systemPropertiesArray = arrayOrEmpty(metadata['systemPropertiesArray']);
  const enqueuedTimeUtcArray = arrayOrEmpty(metadata['enqueuedTimeUtcArray']);

  // The newest message per group (= per device), in first-seen order.
  const newest = new Map<string, { message: SignalRGroupMessage; enqueuedMs: number }>();
  let readings = 0;
  let skipped = 0;
  batch.forEach((body, index) => {
    let message: SignalRGroupMessage | null = null;
    try {
      message = toGroupMessage(body, systemPropertiesArray[index], enqueuedTimeUtcArray[index]);
    } catch {
      message = null;
    }
    if (!message) {
      skipped += 1;
      return;
    }
    readings += 1;
    // toGroupMessage only returns a message with a parseable ISO enqueuedTimeUtc.
    const enqueuedMs = Date.parse(message.arguments[0].enqueuedTimeUtc);
    const current = newest.get(message.groupName);
    if (!current || enqueuedMs >= current.enqueuedMs) {
      newest.set(message.groupName, { message, enqueuedMs });
    }
  });

  const messages = [...newest.values()].map(entry => entry.message);
  context.extraOutputs.set(signalROutput, messages);
  context.log(
    `broadcastTemperature sent=${messages.length} coalesced=${readings - messages.length} ` +
      `skipped=${skipped}`
  );
}
