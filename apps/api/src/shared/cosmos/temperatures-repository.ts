import type { Container } from '@azure/cosmos';
import type { TemperatureReading } from '@meatgeekv2/api-interfaces';

import { getCosmosAdapter } from './cosmos-adapter';

/**
 * HAR-28 (MG-79 part 1) — reads telemetry from the `temperatures` container.
 *
 * WHO WRITES IT. Nothing in this app. IoT Hub's `cosmos-storage` routing endpoint
 * (apps/infrastructure/modules/iot-hub/main.tf) writes every device message
 * straight into the container. The container is partitioned on `/deviceId`, and
 * the endpoint stamps that top-level `deviceId` from the authenticated device id
 * (`partition_key_template = "{deviceid}"`).
 *
 * WHAT IS STORED. The IoT Hub envelope, not a TemperatureReading (a real one is
 * in docs/infrastructure/evidence/mg73-observed-routed-document.json):
 *
 *   { id, deviceId, iothub_name, Body, Properties, SystemProperties, _rid, _ts, ... }
 *
 * `Body` is the device payload in the data-pusher wire shape
 * (apps/data-pusher/internal/wire/types.go). `SystemProperties` is stamped by the
 * hub, and holds the authenticated `iothub-connection-device-id` and the
 * `iothub-enqueuedtime`.
 *
 * TRUST RULE (MG-73). A reading's device is `SystemProperties
 * ["iothub-connection-device-id"]`, never `Body.deviceId`: `Body` is whatever the
 * device chose to send. {@link toTemperatureReading} is the one place a stored
 * document becomes a reading, and it applies that rule.
 */

/** Hub-stamped system property names. Source-fixed text. */
const CONNECTION_DEVICE_ID = 'iothub-connection-device-id';
const ENQUEUED_TIME = 'iothub-enqueuedtime';

/** The temperature fields copied from `Body` when they are finite numbers. */
const TEMPERATURE_FIELDS = [
  'grillTemp',
  'probe1Temp',
  'probe2Temp',
  'probe3Temp',
  'probe4Temp',
] as const satisfies readonly (keyof TemperatureReading)[];

/**
 * How many of the newest documents the current-reading query looks at. The
 * newest document that maps wins; unmappable ones (another device's identity in
 * this partition, a non-JSON body) are skipped. Ten bounds the RU when the head
 * of the partition is junk.
 */
export const LATEST_READING_CANDIDATES = 10;

/** The newest-first query over one device's partition. */
export const LATEST_READING_QUERY =
  `SELECT TOP ${LATEST_READING_CANDIDATES} * FROM c WHERE c.deviceId = @deviceId ` +
  `ORDER BY c.SystemProperties["${ENQUEUED_TIME}"] DESC`;

type JsonObject = Record<string, unknown>;

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function isDateString(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0 && !Number.isNaN(Date.parse(value));
}

/**
 * Projects one stored IoT Hub document onto a {@link TemperatureReading}, or
 * `null` when it cannot be one for `partitionDeviceId`:
 *
 *   - `null` if `SystemProperties["iothub-connection-device-id"]` is missing or
 *     differs from `partitionDeviceId`, if `Body` is not a JSON object (IoT Hub
 *     stores a non-JSON payload as a base64 string), or if no timestamp can be
 *     found (see below);
 *   - `deviceId` is the `SystemProperties` id. `Body.deviceId` is ignored;
 *   - `timestamp` is `Body.timestamp` when it is a string that parses as a date,
 *     else `SystemProperties["iothub-enqueuedtime"]` (which must parse too);
 *   - `cookId` is `Body.cookId` when it is a non-empty string;
 *   - `grillTemp`, `probe1Temp`…`probe4Temp` are copied when finite numbers and
 *     omitted otherwise.
 *
 * Nothing else is copied: no `_` key, no `SystemProperties`, `Properties`,
 * `iothub_name`, `id`, or unmodelled `Body` field.
 */
export function toTemperatureReading(
  document: unknown,
  partitionDeviceId: string
): TemperatureReading | null {
  if (!isJsonObject(document)) {
    return null;
  }
  const system = document['SystemProperties'];
  if (!isJsonObject(system)) {
    return null;
  }
  const deviceId = system[CONNECTION_DEVICE_ID];
  if (typeof deviceId !== 'string' || deviceId.length === 0 || deviceId !== partitionDeviceId) {
    return null;
  }
  const body = document['Body'];
  if (!isJsonObject(body)) {
    return null;
  }

  const timestamp = isDateString(body['timestamp'])
    ? body['timestamp']
    : isDateString(system[ENQUEUED_TIME])
      ? system[ENQUEUED_TIME]
      : undefined;
  if (timestamp === undefined) {
    return null;
  }

  const reading: TemperatureReading = { deviceId, timestamp };
  const cookId = body['cookId'];
  if (typeof cookId === 'string' && cookId.length > 0) {
    reading.cookId = cookId;
  }
  for (const field of TEMPERATURE_FIELDS) {
    const value = body[field];
    if (typeof value === 'number' && Number.isFinite(value)) {
      reading[field] = value;
    }
  }
  return reading;
}

/** The newest reading for a device, with the RU the query cost. */
export type LatestReading =
  | {
      readonly status: 'found';
      readonly reading: TemperatureReading;
      readonly requestCharge: number;
    }
  | { readonly status: 'none'; readonly requestCharge: number };

export class TemperaturesRepository {
  /**
   * @param container the temperatures container from the shared adapter
   *   (`adapter.getTemperaturesContainer()`). Injected so unit tests run against
   *   a fake with no Azure and no credentials.
   */
  constructor(private readonly container: Container) {}

  /**
   * The newest document in `deviceId`'s partition that maps to a reading. One
   * single-partition query ({@link LATEST_READING_QUERY}, `partitionKey:
   * deviceId`), newest `iothub-enqueuedtime` first; never cross-partition.
   *
   * Callers must have checked that the caller owns `deviceId` first.
   */
  async getLatestReading(deviceId: string): Promise<LatestReading> {
    const response = await this.container.items
      .query<JsonObject>(
        {
          query: LATEST_READING_QUERY,
          parameters: [{ name: '@deviceId', value: deviceId }],
        },
        { partitionKey: deviceId, maxItemCount: LATEST_READING_CANDIDATES }
      )
      .fetchAll();
    const requestCharge = response.requestCharge;
    for (const document of response.resources) {
      const reading = toTemperatureReading(document, deviceId);
      if (reading) {
        return { status: 'found', reading, requestCharge };
      }
    }
    return { status: 'none', requestCharge };
  }
}

/** The repository wired to the shared adapter's temperatures container. */
export function getTemperaturesRepository(): TemperaturesRepository {
  return new TemperaturesRepository(getCosmosAdapter().getTemperaturesContainer());
}
