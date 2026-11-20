import type { Container, ItemResponse, RequestOptions, SqlParameter } from '@azure/cosmos';
import type { TemperatureReading } from '@meatgeekv2/api-interfaces';

import { getCosmosAdapter } from './cosmos-adapter';

/**
 * HAR-86 — the cook chart's read model: per-device, per-hour bucket documents
 * in the `temperature-rollups` container (HAR-74, partitioned on `/deviceId`).
 *
 * WHO WRITES IT. Only the `rollupTemperatures` change-feed trigger
 * (functions/temperatures/rollup-temperatures.ts). It folds each change-feed
 * batch from `temperatures` in memory ({@link foldReadings}) and then does one
 * read-merge-replace per touched document ({@link TemperatureRollupsRepository.applyBucket}).
 *
 * WHO READS IT. `GET /cooks/{cookId}/chart`, with one single-partition query
 * ({@link TemperatureRollupsRepository.queryHours}).
 *
 * THE DOCUMENT.
 *
 *   {
 *     id: "<deviceId>:<yyyy-mm-ddThh>",      // UTC hour of the readings
 *     deviceId: "<deviceId>",                // the partition key
 *     hourStart: "2026-11-20T10:00:00.000Z", // ISO, UTC, millisecond form
 *     slots: {                               // keyed by minute "0".."59"
 *       "15": { grill: {n, min, max, sum}, probe1: {...}, ... },
 *     }
 *   }
 *
 * A channel a reading does not carry is not counted in that slot, so `n` can
 * differ per channel. `hourStart` is written by `toISOString()`, the same form
 * the chart query compares against, so the string comparison is a time one.
 *
 * AT-LEAST-ONCE. The change feed delivers each reading at least once: a batch
 * that was folded and written but not checkpointed (the host crashed between
 * the two) is delivered again, and its readings are folded a second time. That
 * double-counts `n` and `sum` for those readings, so their slot's average leans
 * towards them; `min` and `max` are unaffected. This is accepted: it needs a
 * crash in a narrow window, it skews one or a few minutes of one chart, and
 * exact-once would need a per-reading ledger costing a write per reading, which
 * is the cost this read model exists to avoid.
 */

/** The chart channels, in response order. */
export const ROLLUP_CHANNELS = ['grill', 'probe1', 'probe2', 'probe3', 'probe4'] as const;
export type RollupChannel = (typeof ROLLUP_CHANNELS)[number];

/** The reading field each channel is folded from. */
const CHANNEL_FIELD: Record<RollupChannel, keyof TemperatureReading> = {
  grill: 'grillTemp',
  probe1: 'probe1Temp',
  probe2: 'probe2Temp',
  probe3: 'probe3Temp',
  probe4: 'probe4Temp',
};

/** One channel of one minute slot. */
export interface ChannelStats {
  n: number;
  min: number;
  max: number;
  sum: number;
}

/** One minute: the channels that had at least one reading in it. */
export type MinuteSlot = Partial<Record<RollupChannel, ChannelStats>>;

/** The minute slots of an hour, keyed by minute `"0"`..`"59"`. */
export type HourSlots = Record<string, MinuteSlot>;

/** A rollup document as this app writes it. */
export interface TemperatureRollupDocument {
  id: string;
  deviceId: string;
  hourStart: string;
  slots: HourSlots;
}

const HOUR_MS = 3_600_000;
const MINUTE_MS = 60_000;

/** The start of the UTC hour containing `epochMs`. */
export function hourStartOf(epochMs: number): number {
  return Math.floor(epochMs / HOUR_MS) * HOUR_MS;
}

/**
 * The rollup document id: `<deviceId>:<yyyy-mm-ddThh>`, the UTC hour.
 *
 * The device id is `encodeURIComponent`-encoded, as the cooks repository does
 * for its lock ids: IoT Hub allows `#` and `?` in a device id, and Cosmos does
 * not allow `/`, `\`, `?` or `#` in a document id. A plain device id is
 * unchanged by the encoding.
 */
export function rollupDocumentId(deviceId: string, hourStartMs: number): string {
  return `${encodeURIComponent(deviceId)}:${new Date(hourStartMs).toISOString().slice(0, 13)}`;
}

function mergeStats(into: ChannelStats | undefined, add: ChannelStats): ChannelStats {
  if (!into) {
    return { ...add };
  }
  return {
    n: into.n + add.n,
    min: Math.min(into.min, add.min),
    max: Math.max(into.max, add.max),
    sum: into.sum + add.sum,
  };
}

/** Merges `add`'s slots into a copy of `into`'s. Neither argument is changed. */
export function mergeSlots(into: HourSlots, add: HourSlots): HourSlots {
  const merged: HourSlots = {};
  for (const [minute, slot] of Object.entries(into)) {
    merged[minute] = { ...slot };
  }
  for (const [minute, slot] of Object.entries(add)) {
    const target: MinuteSlot = merged[minute] ?? {};
    for (const channel of ROLLUP_CHANNELS) {
      const stats = slot[channel];
      if (stats) {
        target[channel] = mergeStats(target[channel], stats);
      }
    }
    merged[minute] = target;
  }
  return merged;
}

/**
 * The change to one rollup document that one batch makes: the batch's readings
 * for that device and hour, folded into minute slots.
 */
export interface RollupDelta {
  readonly id: string;
  readonly deviceId: string;
  readonly hourStart: string;
  readonly slots: HourSlots;
}

/**
 * Folds readings into one {@link RollupDelta} per (device, UTC hour), in
 * memory. The bucket is the reading's `timestamp` (as `toTemperatureReading`
 * chose it). A reading whose timestamp does not parse is skipped, and so is a
 * channel that is not a finite number.
 */
export function foldReadings(readings: readonly TemperatureReading[]): RollupDelta[] {
  const deltas = new Map<string, RollupDelta>();
  for (const reading of readings) {
    const epochMs = Date.parse(reading.timestamp);
    if (!Number.isFinite(epochMs)) {
      continue;
    }
    const hourMs = hourStartOf(epochMs);
    const id = rollupDocumentId(reading.deviceId, hourMs);
    let delta = deltas.get(id);
    if (!delta) {
      delta = {
        id,
        deviceId: reading.deviceId,
        hourStart: new Date(hourMs).toISOString(),
        slots: {},
      };
      deltas.set(id, delta);
    }
    const minute = String(Math.floor((epochMs - hourMs) / MINUTE_MS));
    const slot: MinuteSlot = delta.slots[minute] ?? {};
    let counted = false;
    for (const channel of ROLLUP_CHANNELS) {
      const value = reading[CHANNEL_FIELD[channel]];
      if (typeof value === 'number' && Number.isFinite(value)) {
        slot[channel] = mergeStats(slot[channel], { n: 1, min: value, max: value, sum: value });
        counted = true;
      }
    }
    if (counted) {
      delta.slots[minute] = slot;
    }
  }
  // A delta whose readings carried no temperature has nothing to write.
  return [...deltas.values()].filter(delta => Object.keys(delta.slots).length > 0);
}

/** How many read-merge-write rounds one bucket gets before the batch fails. */
export const ROLLUP_MAX_ATTEMPTS = 5;

/**
 * Thrown when a bucket could not be written within {@link ROLLUP_MAX_ATTEMPTS}
 * rounds (each lost to a concurrent writer: 412 on replace, 409 on create).
 * The trigger lets it propagate, so the change-feed lease is not checkpointed
 * and the batch is delivered again.
 */
export class RollupConflictError extends Error {
  constructor(
    readonly attempts: number,
    readonly requestCharge: number
  ) {
    super(`rollup bucket still conflicting after ${attempts} attempts`);
    this.name = 'RollupConflictError';
  }
}

/** The numeric status on a thrown Cosmos error, read without its text. */
function statusCodeOf(error: unknown): number | undefined {
  const reported = error as { code?: unknown; statusCode?: unknown } | null | undefined;
  for (const value of [reported?.statusCode, reported?.code]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

function chargeOf(source: unknown): number {
  const charge = (source as { requestCharge?: unknown } | null | undefined)?.requestCharge;
  return typeof charge === 'number' && Number.isFinite(charge) ? charge : 0;
}

function isHourSlots(value: unknown): value is HourSlots {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The window of hour documents the chart reads. */
export interface RollupHoursFilter {
  readonly deviceId: string;
  /** Inclusive lower bound on `hourStart` (ISO, `toISOString()` form). */
  readonly fromHourStart: string;
  /** Exclusive upper bound on `hourStart`; none for an active cook. */
  readonly toHourStart?: string;
}

/** The chart query: one device's partition, the indexed `hourStart` range. */
export function rollupHoursQuery(filter: RollupHoursFilter): {
  query: string;
  parameters: SqlParameter[];
} {
  const clauses = ['c.deviceId = @deviceId', 'c.hourStart >= @from'];
  const parameters: SqlParameter[] = [
    { name: '@deviceId', value: filter.deviceId },
    { name: '@from', value: filter.fromHourStart },
  ];
  if (filter.toHourStart !== undefined) {
    clauses.push('c.hourStart < @to');
    parameters.push({ name: '@to', value: filter.toHourStart });
  }
  return {
    query: `SELECT c.deviceId, c.hourStart, c.slots FROM c WHERE ${clauses.join(' AND ')}`,
    parameters,
  };
}

/** The rollup hours of a window, with the RU every query page cost. */
export interface RollupHours {
  readonly hours: Array<{ readonly hourStart: string; readonly slots: HourSlots }>;
  readonly requestCharge: number;
}

export class TemperatureRollupsRepository {
  /**
   * @param container the temperature-rollups container from the shared
   *   adapter. Injected so unit tests run against a fake.
   */
  constructor(private readonly container: Container) {}

  /**
   * Merges one delta into its document: read it, merge, and replace it with
   * `IfMatch` on the etag read (or create it when absent). A 412 (someone
   * replaced it since the read) or a 409 (someone created it since the read)
   * starts the round again from a fresh read. After
   * {@link ROLLUP_MAX_ATTEMPTS} rounds it throws {@link RollupConflictError};
   * any other failure propagates as it is.
   *
   * Returns the RU of every read and write it made.
   */
  async applyBucket(delta: RollupDelta): Promise<number> {
    let requestCharge = 0;
    for (let attempt = 1; attempt <= ROLLUP_MAX_ATTEMPTS; attempt += 1) {
      const read = await this.readDocument(delta);
      requestCharge += read.requestCharge;
      const existing = read.document;
      const slots = mergeSlots(
        existing && isHourSlots(existing.slots) ? existing.slots : {},
        delta.slots
      );
      const document: TemperatureRollupDocument = {
        id: delta.id,
        deviceId: delta.deviceId,
        hourStart: delta.hourStart,
        slots,
      };
      try {
        if (existing === undefined) {
          const created = await this.container.items.create(document);
          requestCharge += chargeOf(created);
        } else {
          const options: RequestOptions | undefined = read.etag
            ? { accessCondition: { type: 'IfMatch', condition: read.etag } }
            : undefined;
          const replaced = await this.container
            .item(delta.id, delta.deviceId)
            .replace(document, options);
          requestCharge += chargeOf(replaced);
        }
        return requestCharge;
      } catch (error) {
        requestCharge += chargeOf(error);
        const status = statusCodeOf(error);
        if (status !== 412 && status !== 409) {
          throw error;
        }
      }
    }
    throw new RollupConflictError(ROLLUP_MAX_ATTEMPTS, requestCharge);
  }

  /** Point read of a delta's document. Absent (a 404, returned or thrown)
   *  is `document: undefined`, not an error. */
  private async readDocument(delta: RollupDelta): Promise<{
    document: TemperatureRollupDocument | undefined;
    etag?: string;
    requestCharge: number;
  }> {
    try {
      const response: ItemResponse<TemperatureRollupDocument> = await this.container
        .item(delta.id, delta.deviceId)
        .read<TemperatureRollupDocument>();
      if (response.statusCode === 404 || response.resource === undefined) {
        return { document: undefined, requestCharge: chargeOf(response) };
      }
      return {
        document: response.resource,
        etag: response.etag,
        requestCharge: chargeOf(response),
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) {
        return { document: undefined, requestCharge: chargeOf(error) };
      }
      throw error;
    }
  }

  /**
   * The rollup hours of one device in a window: one single-partition query
   * ({@link rollupHoursQuery}, `partitionKey: deviceId`), every page drained,
   * the RU of every page summed. Only `hourStart` and `slots` are returned.
   */
  async queryHours(filter: RollupHoursFilter): Promise<RollupHours> {
    const iterator = this.container.items.query<{ hourStart?: unknown; slots?: unknown }>(
      rollupHoursQuery(filter),
      { partitionKey: filter.deviceId }
    );
    const hours: Array<{ hourStart: string; slots: HourSlots }> = [];
    let requestCharge = 0;
    // At least one page; then every page the SDK still holds.
    for (let first = true; first || iterator.hasMoreResults(); first = false) {
      const page = await iterator.fetchNext();
      requestCharge += chargeOf(page);
      for (const resource of page.resources ?? []) {
        if (typeof resource.hourStart === 'string' && isHourSlots(resource.slots)) {
          hours.push({ hourStart: resource.hourStart, slots: resource.slots });
        }
      }
    }
    return { hours, requestCharge };
  }
}

/** The repository wired to the shared adapter's temperature-rollups container. */
export function getTemperatureRollupsRepository(): TemperatureRollupsRepository {
  return new TemperatureRollupsRepository(getCosmosAdapter().getTemperatureRollupsContainer());
}
