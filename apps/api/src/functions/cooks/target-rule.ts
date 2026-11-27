import type {
  TargetsPending,
  TargetTemperatures,
  TargetsReached,
  TemperatureChannel,
  TemperatureReading,
} from '@meatgeekv2/api-interfaces';

/**
 * The target rule (goal: MeatGeek iOS target alerts and the lock screen).
 *
 * A channel has REACHED its target when it reads at or above the target on two
 * readings in a row. One reading does not count, so a single spike never does.
 * Once reached, a channel stays reached while it hovers at its target or dips
 * a little below it. A probe that reads {@link PROBE_REARM_DROP_F} °F or more
 * below its target RE-ARMS: it is no longer reached and can be reached again,
 * with a new time (the probe was moved to another piece of meat, or pulled).
 * The grill never re-arms by falling: lifting the lid drops the chamber far
 * more than that.
 *
 * A target that is already met when the cook starts is reached under the same
 * rule. A channel with no reading (an unplugged probe) is not touched.
 *
 * State lives on the cook document, so it holds across batches, restarts and
 * Function App instances:
 * - `targetsReached` (in the contract): per channel, when it was reached;
 * - `targetsPending` (stored only, never returned): per channel, the timestamp
 *   of a first reading at or above the target, waiting for a second one.
 *
 * Time is always a reading's own timestamp (the device clock), never the time
 * it arrived. Readings are applied oldest first. A reading no newer than the
 * channel's pending or reached time is ignored: that is the event hub
 * delivering a reading again (a host retry or a replayed batch), and counting
 * it twice would make one reading look like two.
 *
 * This function reads the targets and the readings only: none of the
 * notification preference fields of a user or device.
 */

/** How far below its target a reached probe must read to re-arm, in °F. */
export const PROBE_REARM_DROP_F = 15;

export interface TargetState {
  readonly targetsReached: TargetsReached;
  readonly targetsPending: TargetsPending;
}

const CHANNELS: ReadonlyArray<{ channel: TemperatureChannel; field: keyof TemperatureReading }> = [
  { channel: 'grill', field: 'grillTemp' },
  { channel: 'probe1', field: 'probe1Temp' },
  { channel: 'probe2', field: 'probe2Temp' },
  { channel: 'probe3', field: 'probe3Temp' },
  { channel: 'probe4', field: 'probe4Temp' },
];

function isNewer(timestamp: string, than: string | undefined): boolean {
  return than === undefined || Date.parse(timestamp) > Date.parse(than);
}

/**
 * #240: the state after the targets change from `before` to `after`. A channel
 * whose target changed to a different value, was added or was cleared RE-ARMS:
 * it loses its reached mark and any reading pending under the old target, so a
 * new target already met is reached on the next two readings. A channel whose
 * target is saved with the value it has keeps its state. Returns the same
 * object when nothing changed.
 */
export function retarget(
  state: TargetState,
  before: TargetTemperatures | undefined,
  after: TargetTemperatures
): TargetState {
  const reached: TargetsReached = { ...state.targetsReached };
  const pending: TargetsPending = { ...state.targetsPending };
  let changed = false;
  for (const { channel } of CHANNELS) {
    if (before?.[channel] === after[channel]) {
      continue;
    }
    if (reached[channel] !== undefined || pending[channel] !== undefined) {
      delete reached[channel];
      delete pending[channel];
      changed = true;
    }
  }
  return changed ? { targetsReached: reached, targetsPending: pending } : state;
}

/**
 * The state after `readings`, or the same object when nothing changed (so the
 * caller can skip the write). Does not mutate its arguments.
 */
export function applyReadings(
  state: TargetState,
  targets: TargetTemperatures | undefined,
  readings: readonly TemperatureReading[]
): TargetState {
  const reached: TargetsReached = { ...state.targetsReached };
  const pending: TargetsPending = { ...state.targetsPending };
  let changed = false;

  const ordered = [...readings].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  for (const reading of ordered) {
    for (const { channel, field } of CHANNELS) {
      const target = targets?.[channel];
      const value = reading[field];
      if (typeof target !== 'number' || typeof value !== 'number') {
        continue;
      }
      const at = reading.timestamp;
      const reachedAt = reached[channel]?.reachedAt;

      if (reachedAt !== undefined) {
        if (!isNewer(at, reachedAt)) {
          continue;
        }
        if (channel !== 'grill' && value <= target - PROBE_REARM_DROP_F) {
          delete reached[channel];
          changed = true;
        }
        continue;
      }

      const pendingAt = pending[channel];
      if (!isNewer(at, pendingAt)) {
        continue;
      }
      if (value >= target) {
        if (pendingAt === undefined) {
          pending[channel] = at;
        } else {
          reached[channel] = { reachedAt: at };
          delete pending[channel];
        }
        changed = true;
      } else if (pendingAt !== undefined) {
        delete pending[channel];
        changed = true;
      }
    }
  }

  return changed ? { targetsReached: reached, targetsPending: pending } : state;
}
