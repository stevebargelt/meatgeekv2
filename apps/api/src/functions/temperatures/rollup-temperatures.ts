import type { InvocationContext } from '@azure/functions';
import type { TemperatureReading } from '@meatgeekv2/api-interfaces';

import { CosmosConfigError } from '../../shared/cosmos/cosmos-adapter';
import {
  foldReadings,
  getTemperatureRollupsRepository,
  RollupConflictError,
  type TemperatureRollupsRepository,
} from '../../shared/cosmos/temperature-rollups-repository';
import { toTemperatureReading } from '../../shared/cosmos/temperatures-repository';

/**
 * HAR-86 — the cook chart's writer: a Cosmos DB change-feed trigger on the
 * `temperatures` container that folds every stored reading into the
 * per-device, per-hour documents in `temperature-rollups`.
 *
 * REGISTRATION (main.ts). Identity-based connection `COSMOSDB`
 * (`COSMOSDB__accountEndpoint`; the app identity holds Cosmos DB Built-in Data
 * Contributor at account scope). The lease container is the Terraform-made
 * `leases` (HAR-74) and `createLeaseContainerIfNotExists` is false: data-plane
 * RBAC cannot create containers. `startFromBeginning` rolls up the readings
 * already stored the first time the lease is created. The batch size, poll
 * delay and {@link ROLLUP_WRITE_RU_PER_SECOND} pacing are explained at
 * {@link ROLLUP_TRIGGER_SETTINGS}.
 *
 * TRUST RULE (MG-73). Each changed document goes through
 * {@link toTemperatureReading} with its own top-level `deviceId` (the partition
 * key IoT Hub's routing endpoint stamps from the authenticated device): the
 * device is the hub identity, and the time is `Body.timestamp`, else the
 * enqueued time. A document that does not map is skipped and counted.
 *
 * ONE WRITE PER DOCUMENT, NOT PER READING. The whole batch is folded in memory
 * ({@link foldReadings}) and each touched hour document gets one
 * read-merge-replace with `IfMatch` (retried from a fresh read on a 412 or a
 * 409, a bounded number of times).
 *
 * FAILURE. Anything that fails a bucket (a Cosmos error, or
 * {@link RollupConflictError} once the retries are spent) is logged as a fixed
 * code and THROWN. With the Cosmos DB extension 4.x an unhandled exception
 * leaves the lease un-checkpointed, so the change feed delivers the batch again.
 * Buckets written before the failure are then folded twice; see the
 * at-least-once note in temperature-rollups-repository.ts.
 *
 * The one log line per batch carries counts and RU only, no device ids.
 */

/**
 * The trigger settings main.ts registers, kept here so their reasons sit next
 * to the code they pace.
 *
 *   - `maxItemsPerInvocation: 100`. A change-feed page of 100 readings costs
 *     about 5 RU to read (the history walk measured about 47 RU per 1,000), and
 *     100 readings from one device at 5 s each span about 8 minutes, so a
 *     backfill batch touches one or two hour documents. Small batches keep each
 *     burst small; the per-document writes, not the batch size, are what cost.
 *   - `feedPollDelay: 30000`. Once the feed is drained the processor polls every
 *     30 s instead of the default 5 s. A device reporting every 5 s then lands
 *     about 6 readings per document write rather than 1: one read-merge-replace
 *     per device per 30 s (about 0.5 RU/s per device) rather than per 5 s. The
 *     chart can lag by up to 30 s; the web app appends pushed live readings.
 *   - Pacing. `feedPollDelay` does not apply while there is a backlog: during
 *     the first deploy's backfill the processor reads the next page as soon as
 *     the handler returns. So the handler paces itself: it does not return
 *     before its writes' RU, at {@link ROLLUP_WRITE_RU_PER_SECOND}, have
 *     elapsed. That caps backfill writes at a quarter of the shared 400 RU/s
 *     offer. The change-feed reads and lease checkpoints are not visible to the
 *     handler; at about 5 RU and one small lease write per batch they are small
 *     next to the hour-document writes.
 */
export const ROLLUP_TRIGGER_SETTINGS = {
  maxItemsPerInvocation: 100,
  feedPollDelay: 30_000,
} as const;

/** The RU per second of document writes the trigger allows itself. */
export const ROLLUP_WRITE_RU_PER_SECOND = 100;

/** Injection seam. Production wires the adapter-backed repository and the real
 *  clock; tests pass fakes. */
export interface RollupTemperaturesDeps {
  getRepository(): Pick<TemperatureRollupsRepository, 'applyBucket'>;
  now(): number;
  sleep(ms: number): Promise<void>;
}

const defaultDeps: RollupTemperaturesDeps = {
  getRepository: getTemperatureRollupsRepository,
  now: () => Date.now(),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
};

/** A code safe to log for a failure: never the error's text. */
function failureCode(error: unknown): string {
  if (error instanceof CosmosConfigError) {
    return error.code;
  }
  if (error instanceof RollupConflictError) {
    return 'rollup_conflict_retries_exhausted';
  }
  const reported = error as { statusCode?: unknown; code?: unknown } | null | undefined;
  for (const value of [reported?.statusCode, reported?.code]) {
    if (typeof value === 'number') {
      return `cosmos_status_${value}`;
    }
  }
  return 'cosmos_failure';
}

/** Maps a changed document to a reading, or `null` when it is not one. */
function readingOf(document: unknown): TemperatureReading | null {
  const deviceId = (document as { deviceId?: unknown } | null | undefined)?.deviceId;
  if (typeof deviceId !== 'string' || deviceId.length === 0) {
    return null;
  }
  return toTemperatureReading(document, deviceId);
}

export async function rollupTemperaturesHandler(
  documents: unknown[],
  context: InvocationContext,
  deps: RollupTemperaturesDeps = defaultDeps
): Promise<void> {
  const started = deps.now();
  const changed = Array.isArray(documents) ? documents : [];
  const readings: TemperatureReading[] = [];
  for (const document of changed) {
    const reading = readingOf(document);
    if (reading) {
      readings.push(reading);
    }
  }
  const skipped = changed.length - readings.length;
  const deltas = foldReadings(readings);

  let requestCharge = 0;
  if (deltas.length > 0) {
    try {
      const repository = deps.getRepository();
      for (const delta of deltas) {
        requestCharge += await repository.applyBucket(delta);
      }
    } catch (error) {
      context.error(
        `rollupTemperatures failed: ${failureCode(error)} documents=${changed.length} ` +
          `buckets=${deltas.length} requestCharge=${requestCharge}`
      );
      throw error;
    }
  }

  context.log(
    `rollupTemperatures documents=${changed.length} readings=${readings.length} ` +
      `skipped=${skipped} buckets=${deltas.length} requestCharge=${requestCharge}`
  );

  const budgetMs = (requestCharge / ROLLUP_WRITE_RU_PER_SECOND) * 1000;
  const waitMs = budgetMs - (deps.now() - started);
  if (waitMs > 0) {
    await deps.sleep(waitMs);
  }
}
