import type { InvocationContext, RetryOptions } from '@azure/functions';
import type { TemperatureReading } from '@meatgeekv2/api-interfaces';
import { metrics, type Meter } from '@opentelemetry/api';

import type { ApnsClient } from '../../shared/apns/apns-client';
import { getSharedApnsClient } from '../../shared/apns/shared-client';
import {
  getCooksRepository,
  type CooksRepository,
  type StoredCookDocument,
} from '../../shared/cosmos/cooks-repository';
import { getDevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  getPushTokensRepository,
  type PushTokensRepository,
} from '../../shared/cosmos/push-tokens-repository';
import {
  readingsOfBatch,
  resolveOwners,
  type LiveReading,
} from '../signalr/broadcast-temperature';
import {
  dueAlerts,
  recordAlerted,
  sendAlerts,
  type AlertOutcome,
  type TemperatureUnit,
} from './target-alerts';
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
 * ALERTS (#244). After the rule, each channel the cook says is reached and
 * whose reach has not been alerted is sent to every phone the cook's owner
 * registered (./target-alerts.ts), and recorded on the cook as alerted once
 * every phone's push has a final answer. Due alerts are worked out from the
 * stored cook, not from what this batch changed, so a reach whose alert did
 * not go out is sent again by the retry or by the cook's next batch. A cook
 * that is not running (stopped before a late reading arrived) sends nothing.
 *
 * FAILURES. An owner read or a cook write that fails, or an alert Apple gave
 * no answer for (a network failure, a 5xx, a 429), makes the invocation
 * throw, after every other cook in the batch has been handled, so the host
 * retries the batch (the retry policy is on the registration in main.ts). The
 * rule ignores a reading it has already counted, so a retried batch does not
 * count a reading twice; an alert already recorded is not sent again. An
 * alert Apple refused for another reason is an answer: it is recorded and
 * not sent again. Missing APNs settings do not throw either, because a retry
 * cannot fix them and would hold up the rule for every cook on the partition:
 * nothing is sent or recorded, so the alert goes out (late-worded) with the
 * cook's next batch once the settings are in place. The one log line per
 * batch carries counts only: no ids and no push token.
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

/** Injection seam: production reads owners from the devices container, cooks
 *  from the cooks container, phones from the users container and sends to
 *  Apple; tests pass fakes, a fake APNs transport and a fake clock. */
export interface RecordTargetsReachedDeps {
  ownerOf(deviceId: string): Promise<string | undefined>;
  getRepository(): CooksRepository;
  /** The owner's registered phones (#244). */
  getPushTokens(): Pick<PushTokensRepository, 'listTokens' | 'remove'>;
  /** The APNs client. Throws when its settings are missing. */
  getApns(): Pick<ApnsClient, 'send'>;
  /** The unit the cook's device shows temperatures in. */
  temperatureUnitOf(userId: string, deviceId: string): Promise<TemperatureUnit>;
  /** When an alert is sent: the late-reading wording and the accept-lag metric. */
  now(): Date;
  readonly meter: Meter;
}

export const defaultRecordTargetsReachedDeps: RecordTargetsReachedDeps = {
  ownerOf: async deviceId => (await getDevicesRepository().getDeviceOwner(deviceId)).userId,
  getRepository: getCooksRepository,
  getPushTokens: getPushTokensRepository,
  getApns: getSharedApnsClient,
  temperatureUnitOf: async (userId, deviceId) => {
    const ownership = await getDevicesRepository().getDeviceOwnership(userId, deviceId);
    if (ownership.status !== 'owned') {
      throw new Error('device not owned');
    }
    return ownership.device.configuration?.temperatureUnit ?? 'fahrenheit';
  },
  now: () => new Date(),
  // Read at call time: see broadcast-temperature.ts.
  get meter() {
    return metrics.getMeter('meatgeek-api');
  },
};

interface CookReadings {
  readonly userId: string;
  readonly cookId: string;
  readonly deviceId: string;
  readonly readings: TemperatureReading[];
}

/** Thrown to make the host retry the batch. Carries no ids and no Cosmos text. */
export class TargetsNotRecordedError extends Error {
  constructor(
    readonly failedCooks: number,
    readonly failedLookups: number,
    readonly unansweredAlerts = 0
  ) {
    super(
      `recordTargetsReached failed for ${failedCooks} cook write(s), ${failedLookups} device lookup(s)` +
        ` and ${unansweredAlerts} unanswered alert(s); the batch will be retried`
    );
    this.name = 'TargetsNotRecordedError';
  }
}

/** What the alert step did for one cook. `unanswered` makes the batch retry. */
interface CookAlerts {
  readonly accepted: number;
  readonly unanswered: number;
  readonly refused: number;
  readonly deadTokens: number;
  /** Due alerts not sent because the APNs settings are missing. Not retried. */
  readonly unconfigured: number;
}

const NO_ALERTS: CookAlerts = {
  accepted: 0,
  unanswered: 0,
  refused: 0,
  deadTokens: 0,
  unconfigured: 0,
};

/**
 * Sends the cook's due alerts and records the ones every phone answered.
 * Never throws: a failure before Apple answered counts as unanswered.
 */
async function alertCook(
  group: CookReadings,
  cook: StoredCookDocument,
  repository: CooksRepository,
  deps: RecordTargetsReachedDeps
): Promise<CookAlerts> {
  const due = dueAlerts(cook);
  if (due.length === 0) {
    return NO_ALERTS;
  }
  let outcome: AlertOutcome;
  try {
    const store = deps.getPushTokens();
    const { tokens } = await store.listTokens(group.userId);
    let send: ApnsClient['send'] = async () => {
      throw new Error('no phone to send to');
    };
    let unit: TemperatureUnit = 'fahrenheit';
    if (tokens.length > 0) {
      let apns: Pick<ApnsClient, 'send'>;
      try {
        apns = deps.getApns();
      } catch {
        // The settings are missing: a retry cannot fix that. Left due.
        return { ...NO_ALERTS, unconfigured: due.length };
      }
      send = push => apns.send(push);
      unit = await deps.temperatureUnitOf(group.userId, group.deviceId);
    }
    outcome = await sendAlerts(cook, due, tokens, unit, {
      send,
      removeToken: async tokenId => {
        await store.remove(group.userId, tokenId);
      },
      now: () => deps.now(),
      meter: deps.meter,
    });
  } catch {
    return { ...NO_ALERTS, unanswered: due.length };
  }

  let unanswered = outcome.unanswered;
  if (outcome.done.length > 0) {
    try {
      await repository.updateActiveCook(group.userId, group.cookId, current => {
        const next = recordAlerted(current, outcome.done);
        return JSON.stringify(next) === JSON.stringify(current.targetsAlerted)
          ? undefined
          : { targetsAlerted: next };
      });
    } catch {
      // The alerts went out but are not recorded: the retry sends them again.
      unanswered += outcome.done.length;
    }
  }
  return {
    accepted: outcome.accepted,
    unanswered,
    refused: outcome.refused,
    deadTokens: outcome.deadTokens,
    unconfigured: 0,
  };
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
        const result = await repository.updateActiveCook(group.userId, group.cookId, cook => {
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
        // A cook on another device, or not running, sends nothing.
        const alerts =
          result.outcome !== 'notActive' && result.stored.deviceId === group.deviceId
            ? await alertCook(group, result.stored, repository, deps)
            : NO_ALERTS;
        return { outcome: result.outcome, alerts };
      } catch {
        return { outcome: 'failed' as const, alerts: NO_ALERTS };
      }
    })
  );

  const count = (outcome: string) => outcomes.filter(o => o.outcome === outcome).length;
  const sum = (field: keyof CookAlerts) => outcomes.reduce((total, o) => total + o.alerts[field], 0);
  const failedCooks = count('failed');
  const unanswered = sum('unanswered');
  context.log(
    `recordTargetsReached cooks=${cooks.size} updated=${count('updated')}` +
      ` notActive=${count('notActive')} failed=${failedCooks} untagged=${untagged}` +
      ` skipped=${skipped} unowned=${unowned} lookupFailed=${failedLookups}` +
      ` alertsAccepted=${sum('accepted')} alertsUnanswered=${unanswered}` +
      ` alertsRefused=${sum('refused')} deadTokens=${sum('deadTokens')}` +
      ` alertsUnconfigured=${sum('unconfigured')}`
  );
  if (failedCooks > 0 || failedLookups > 0 || unanswered > 0) {
    throw new TargetsNotRecordedError(failedCooks, failedLookups, unanswered);
  }
}
