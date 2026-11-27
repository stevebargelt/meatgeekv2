import type {
  DeviceConfiguration,
  TargetsAlerted,
  TemperatureChannel,
} from '@meatgeekv2/api-interfaces';
import { ValueType, type Meter } from '@opentelemetry/api';

import type { PushRequest, PushResult } from '../../shared/apns/apns-client';
import type { StoredCookDocument } from '../../shared/cosmos/cooks-repository';
import type { StoredPushToken } from '../../shared/cosmos/push-tokens-repository';

/**
 * #244 — the alert a reached target sends to each of the cook owner's phones
 * (spec #237, "The alert").
 *
 * WHEN. A channel is due when the cook says it is reached (`targetsReached`)
 * and its `reachedAt` is not the one recorded in `targetsAlerted`. Each reach
 * is its own alert: a probe that re-arms and is reached again has a new
 * `reachedAt` and is due again; the grill never re-arms by falling, so it
 * alerts once per target.
 *
 * RECORDED ONLY ON AN ANSWER. A channel is recorded as alerted only when
 * every phone's push got a final answer from Apple: accepted (200), the token
 * is dead (410, or 400 BadDeviceToken) and has been deleted, or refused for
 * another reason (the token is kept). A refusal is final because sending the
 * same push again is refused the same way, and would repeat the alert on the
 * phones that did accept it with every batch of the cook. A push with no
 * answer (a network failure, a 5xx, a 429) is not recorded, so the channel
 * stays due and is sent again: a rare duplicate on a phone that did accept,
 * never a missed alert.
 * A user with no phones has nothing to send, and the channel is recorded so a
 * phone registered later is not sent an old alert.
 *
 * TEXT. Title "Probe 1 reached 203 °F" or "Grill reached 225 °F", in the
 * device's unit, converted from °F as the app's live panel converts it. Body:
 * the cook's name. When the push is sent more than
 * {@link LATE_READING_MS} after the reach (a late reading, buffered while the
 * device was offline), the title ends with how long ago: "… 40 minutes ago".
 * A duration, never a clock time: the server has no trustworthy time zone.
 *
 * PAYLOAD. `interruption-level: time-sensitive`; `thread-id` is the cook id,
 * so one cook's alerts group together; `cookId` at the top level for the app
 * to open that cook. No token, no user id.
 *
 * METRIC. `meatgeek.alert.accept_lag_ms`: from the reach (`reachedAt`, the
 * device's clock) to Apple accepting the push. Aim: under 30 s in normal
 * running. A late reach is recorded with `late: true` so it does not hide the
 * normal case.
 *
 * Nothing here logs. The handler logs counts only; a token never leaves this
 * module except to the APNs client and the token store.
 */

/** The unit a device shows temperatures in. Readings and targets are in °F. */
export type TemperatureUnit = DeviceConfiguration['temperatureUnit'];

/** A reading this much older than the time its alert is sent is late. */
export const LATE_READING_MS = 2 * 60 * 1000;

/** The time from a reach to Apple accepting its alert. Source-fixed name. */
export const ALERT_ACCEPT_LAG_METRIC = 'meatgeek.alert.accept_lag_ms';

const CHANNEL_NAMES: Readonly<Record<TemperatureChannel, string>> = {
  grill: 'Grill',
  probe1: 'Probe 1',
  probe2: 'Probe 2',
  probe3: 'Probe 3',
  probe4: 'Probe 4',
};

const CHANNEL_ORDER: readonly TemperatureChannel[] = [
  'grill',
  'probe1',
  'probe2',
  'probe3',
  'probe4',
];

/**
 * A °F value in the device's unit, as the live panel shows it
 * (apps/web/src/live/format.ts `toDisplayUnit`, and the iOS `LiveText`):
 * converted, rounded half up to one decimal, never -0.
 */
export function toDisplayUnit(fahrenheit: number, unit: TemperatureUnit): number {
  const value = unit === 'celsius' ? ((fahrenheit - 32) * 5) / 9 : fahrenheit;
  const rounded = Math.round(value * 10) / 10;
  return Object.is(rounded, -0) ? 0 : rounded;
}

function unitSymbol(unit: TemperatureUnit): string {
  return unit === 'celsius' ? '°C' : '°F';
}

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? '' : 's'}`;
}

/** "40 minutes ago", "1 hour ago", "2 hours 5 minutes ago". Whole minutes, rounded down. */
export function agoText(ms: number): string {
  const minutes = Math.max(0, Math.floor(ms / 60_000));
  if (minutes < 60) {
    return `${plural(minutes, 'minute')} ago`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0
    ? `${plural(hours, 'hour')} ago`
    : `${plural(hours, 'hour')} ${plural(rest, 'minute')} ago`;
}

export interface AlertText {
  readonly title: string;
  readonly body: string;
}

export function alertText(input: {
  readonly channel: TemperatureChannel;
  readonly targetF: number;
  readonly unit: TemperatureUnit;
  readonly cookName: string;
  readonly reachedAt: string;
  readonly now: Date;
}): AlertText {
  const temperature = `${toDisplayUnit(input.targetF, input.unit)} ${unitSymbol(input.unit)}`;
  const age = input.now.getTime() - Date.parse(input.reachedAt);
  const late = age > LATE_READING_MS ? ` ${agoText(age)}` : '';
  return {
    title: `${CHANNEL_NAMES[input.channel]} reached ${temperature}${late}`,
    body: input.cookName,
  };
}

/** The APNs payload of one alert. */
export function alertPayload(cookId: string, text: AlertText): Record<string, unknown> {
  return {
    aps: {
      alert: { title: text.title, body: text.body },
      sound: 'default',
      'interruption-level': 'time-sensitive',
      'thread-id': cookId,
    },
    cookId,
  };
}

/** A due channel: reached, with a `reachedAt` not yet alerted. */
export interface DueAlert {
  readonly channel: TemperatureChannel;
  readonly reachedAt: string;
  readonly targetF: number;
}

/** The cook's channels that are reached and not yet alerted for that reach. */
export function dueAlerts(cook: StoredCookDocument): DueAlert[] {
  const due: DueAlert[] = [];
  for (const channel of CHANNEL_ORDER) {
    const reachedAt = cook.targetsReached?.[channel]?.reachedAt;
    const targetF = cook.targetTemps?.[channel];
    if (reachedAt === undefined || typeof targetF !== 'number') {
      continue;
    }
    if (cook.targetsAlerted?.[channel] !== reachedAt) {
      due.push({ channel, reachedAt, targetF });
    }
  }
  return due;
}

/** `alerted` with `done` recorded, keeping only channels still reached at that time. */
export function recordAlerted(
  cook: StoredCookDocument,
  done: readonly DueAlert[]
): TargetsAlerted | undefined {
  const next: TargetsAlerted = {};
  for (const channel of CHANNEL_ORDER) {
    const reachedAt = cook.targetsReached?.[channel]?.reachedAt;
    if (reachedAt === undefined) {
      continue;
    }
    if (done.some(d => d.channel === channel && d.reachedAt === reachedAt)) {
      next[channel] = reachedAt;
    } else if (cook.targetsAlerted?.[channel] === reachedAt) {
      next[channel] = reachedAt;
    }
  }
  return Object.keys(next).length > 0 ? next : undefined;
}

/** A token Apple will never deliver to again. */
export function isDeadToken(result: PushResult): boolean {
  return result.status === 410 || (result.status === 400 && result.reason === 'BadDeviceToken');
}

export interface AlertSenderDeps {
  send(push: PushRequest): Promise<PushResult>;
  /** Deletes a dead token. A failure here leaves the token for the next alert. */
  removeToken(tokenId: string): Promise<void>;
  now(): Date;
  readonly meter: Meter;
}

export interface AlertOutcome {
  /** The due alerts every phone answered: recorded as alerted. */
  readonly done: DueAlert[];
  readonly accepted: number;
  /** Pushes with no final answer: sent again with the next batch. */
  readonly unanswered: number;
  /** Pushes Apple refused for a reason other than a dead token: final, not sent again. */
  readonly refused: number;
  readonly deadTokens: number;
}

/** Sends each due alert to each phone. Never throws. */
export async function sendAlerts(
  cook: Pick<StoredCookDocument, 'id' | 'name'>,
  due: readonly DueAlert[],
  tokens: readonly StoredPushToken[],
  unit: TemperatureUnit,
  deps: AlertSenderDeps
): Promise<AlertOutcome> {
  let accepted = 0;
  let unanswered = 0;
  let refused = 0;
  const dead = new Set<string>();
  const done: DueAlert[] = [];
  const histogram = acceptLagHistogram(deps.meter);

  for (const alert of due) {
    const text = alertText({
      channel: alert.channel,
      targetF: alert.targetF,
      unit,
      cookName: cook.name,
      reachedAt: alert.reachedAt,
      now: deps.now(),
    });
    const payload = alertPayload(cook.id, text);
    let final = true;
    for (const token of tokens) {
      if (dead.has(token.id)) {
        continue;
      }
      let result: PushResult;
      try {
        result = await deps.send({
          deviceToken: token.token,
          pushType: 'alert',
          priority: 10,
          payload,
        });
      } catch {
        unanswered += 1;
        final = false;
        continue;
      }
      if (result.accepted) {
        accepted += 1;
        recordAcceptLag(histogram, alert.reachedAt, deps.now());
      } else if (isDeadToken(result)) {
        dead.add(token.id);
      } else if (result.status >= 500 || result.status === 429) {
        // Apple was unavailable: no answer, so it is sent again.
        unanswered += 1;
        final = false;
      } else {
        // Refused for another reason: an answer. Sending it again would be
        // refused again and repeat the alert on the phones that accepted it.
        refused += 1;
      }
    }
    if (final) {
      done.push(alert);
    }
  }

  for (const tokenId of dead) {
    try {
      await deps.removeToken(tokenId);
    } catch {
      // Left for the next alert to delete.
    }
  }
  return { done, accepted, unanswered, refused, deadTokens: dead.size };
}

interface Histogram {
  record(value: number, attributes?: Record<string, boolean>): void;
}

function acceptLagHistogram(meter: Meter): Histogram | undefined {
  try {
    return meter.createHistogram(ALERT_ACCEPT_LAG_METRIC, {
      description: 'Time from a target being reached (device clock) to APNs accepting its alert',
      unit: 'ms',
      valueType: ValueType.INT,
    });
  } catch {
    return undefined;
  }
}

function recordAcceptLag(
  histogram: Histogram | undefined,
  reachedAt: string,
  acceptedAt: Date
): void {
  try {
    const lag = Math.round(acceptedAt.getTime() - Date.parse(reachedAt));
    if (Number.isNaN(lag)) {
      return;
    }
    const value = Math.max(0, lag);
    histogram?.record(value, lag > LATE_READING_MS ? { late: true } : {});
  } catch {
    // Measurement only.
  }
}
