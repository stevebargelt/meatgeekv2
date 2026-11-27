import type { InvocationContext, RetryOptions } from '@azure/functions';
import type { TemperatureReading } from '@meatgeekv2/api-interfaces';

import { getCooksRepository, type CooksRepository } from '../../shared/cosmos/cooks-repository';
import { getDevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  readingsOfBatch,
  resolveOwners,
  type LiveReading,
} from '../signalr/broadcast-temperature';
import { applyReadings, nonEmpty, type TargetState } from './target-rule';

/**
 * The target rule on the reading stream: records on each running cook which
 * channels have reached their target, and when (see ./target-rule.ts).
 *
 * WHERE IT RUNS. Its own Event Hub trigger on the temperature-data event hub,
 * on its own consumer group (`TARGETS_CONSUMER_GROUP`, "api-targets"), beside
 * broadcastTemperature on "api-broadcast". The two are separate invocations
 * with separate checkpoints, so this function can never delay or drop a live
 * push: the push's output binding is flushed when broadcastTemperature
 * returns, and that handler never waits on this one. A failure here costs the
 * reached state of that batch, never a reading.
 *
 * WHICH COOK. A reading counts for the cook the device tagged it with
 * (`cookId`), read from the device owner's partition. The cook must be on the
 * reading's device and running: a reading that arrives after its cook was
 * stopped changes nothing. An untagged reading is not attributed to any cook.
 *
 * FAILURES. An owner read or a cook write that fails makes the invocation
 * throw, after every other cook in the batch has been handled, so the host
 * retries the batch (the retry policy is on the registration in main.ts). The
 * rule ignores a reading it has already counted, so a retried batch does not
 * count a reading twice. The one log line per batch carries counts only.
 */

/**
 * The host's retry of a batch that threw: up to 8 more runs, 5 s apart at
 * first and at most a minute apart. While it retries, that event hub
 * partition waits on this consumer group only; the push on `api-broadcast`
 * carries on. When the retries run out the batch is checkpointed and lost to
 * the rule, and the next readings reach the target again.
 */
export const TARGETS_RETRY: RetryOptions = {
  strategy: 'exponentialBackoff',
  maxRetryCount: 8,
  minimumInterval: { seconds: 5 },
  maximumInterval: { minutes: 1 },
};

/** Injection seam: production reads owners from the devices container and
 *  cooks from the cooks container; tests pass fakes. */
export interface RecordTargetsReachedDeps {
  ownerOf(deviceId: string): Promise<string | undefined>;
  getRepository(): CooksRepository;
}

export const defaultRecordTargetsReachedDeps: RecordTargetsReachedDeps = {
  ownerOf: async deviceId => (await getDevicesRepository().getDeviceOwner(deviceId)).userId,
  getRepository: getCooksRepository,
};

interface CookReadings {
  readonly userId: string;
  readonly cookId: string;
  readonly deviceId: string;
  readonly readings: TemperatureReading[];
}

/** Thrown to make the host retry the batch. Carries no ids and no Cosmos text. */
export class TargetsNotRecordedError extends Error {
  constructor(readonly failedCooks: number, readonly failedLookups: number) {
    super(
      `recordTargetsReached failed for ${failedCooks} cook write(s) and ${failedLookups} device lookup(s); the batch will be retried`
    );
    this.name = 'TargetsNotRecordedError';
  }
}

export async function recordTargetsReachedHandler(
  events: unknown,
  context: InvocationContext,
  deps: RecordTargetsReachedDeps = defaultRecordTargetsReachedDeps
): Promise<void> {
  const { readings, skipped } = readingsOfBatch(events, context);
  const tagged = readings.filter(
    (r): r is LiveReading & { payload: { cookId: string } } => r.payload.cookId !== undefined
  );
  const untagged = readings.length - tagged.length;

  const owners = await resolveOwners(
    tagged.map(r => r.deviceId),
    deps
  );
  const cooks = new Map<string, CookReadings>();
  let unowned = 0;
  let failedLookups = 0;
  for (const { deviceId, payload } of tagged) {
    const userId = owners.get(deviceId);
    if (userId === null) {
      failedLookups += 1;
      continue;
    }
    if (userId === undefined) {
      unowned += 1;
      continue;
    }
    const { cookId } = payload;
    const key = JSON.stringify([userId, cookId, deviceId]);
    const group = cooks.get(key) ?? { userId, cookId, deviceId, readings: [] };
    group.readings.push(payload);
    cooks.set(key, group);
  }

  const repository = deps.getRepository();
  const outcomes = await Promise.all(
    [...cooks.values()].map(async group => {
      try {
        const { outcome } = await repository.updateActiveCook(group.userId, group.cookId, cook => {
          if (cook.deviceId !== group.deviceId) {
            return undefined;
          }
          const before: TargetState = {
            targetsReached: cook.targetsReached ?? {},
            targetsPending: cook.targetsPending ?? {},
            targetsSeen: cook.targetsSeen,
          };
          const after = applyReadings(before, cook.targetTemps, group.readings);
          if (after === before) {
            return undefined;
          }
          // An empty map is stored as absent: a cook with nothing reached
          // carries no `targetsReached` at all.
          return {
            targetsReached: nonEmpty(after.targetsReached),
            targetsPending: nonEmpty(after.targetsPending),
            targetsSeen: nonEmpty(after.targetsSeen),
          };
        });
        return outcome;
      } catch {
        return 'failed' as const;
      }
    })
  );

  const count = (outcome: string) => outcomes.filter(o => o === outcome).length;
  const failedCooks = count('failed');
  context.log(
    `recordTargetsReached cooks=${cooks.size} updated=${count('updated')}` +
      ` notActive=${count('notActive')} failed=${failedCooks} untagged=${untagged}` +
      ` skipped=${skipped} unowned=${unowned} lookupFailed=${failedLookups}`
  );
  if (failedCooks > 0 || failedLookups > 0) {
    throw new TargetsNotRecordedError(failedCooks, failedLookups);
  }
}
