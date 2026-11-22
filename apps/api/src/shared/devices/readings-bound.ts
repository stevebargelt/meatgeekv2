import type { Device } from '@meatgeekv2/api-interfaces';

/**
 * HAR-136 (goal HAR-130) — an owner sees a device's readings only from their
 * claim onward (learnings/decisions/har-130-device-provisioning-and-claim.md,
 * Decision 5). Readings from before `claimedAt`, while the device was unclaimed
 * or belonged to someone else, never reach them.
 *
 * Every route that returns readings bounds its query below by
 * {@link claimedAtBound}: GET /temperatures/current/{deviceId}, GET
 * /temperatures/history, and the rollup-backed GET /cooks/{cookId}/chart. The
 * bound is part of the query, never a filter on its results, so paging and
 * limits stay right.
 *
 * A device without `claimedAt` (registered through `POST /devices`) has no
 * bound.
 */

/** A stored `claimedAt` that does not parse. Data the API never writes; the
 *  route fails closed (a sanitized 500) rather than return unbounded readings. */
export class UnparseableClaimedAtError extends Error {
  constructor() {
    super('device_claimed_at_unparseable');
    this.name = 'UnparseableClaimedAtError';
  }
}

/**
 * The device's `claimedAt` in epoch ms, or `undefined` when it has none.
 * Throws {@link UnparseableClaimedAtError} when it is present but not a date.
 */
export function claimedAtBound(device: Pick<Device, 'claimedAt'>): number | undefined {
  if (device.claimedAt === undefined) {
    return undefined;
  }
  const ms = typeof device.claimedAt === 'string' ? Date.parse(device.claimedAt) : NaN;
  if (!Number.isFinite(ms)) {
    throw new UnparseableClaimedAtError();
  }
  return ms;
}

/**
 * The effective inclusive lower bound of a readings window, in the stored form
 * (`toISOString()`): the later of the requested one and the claim bound.
 * `undefined` only when neither is set.
 */
export function boundedStartTime(
  requested: string | undefined,
  bound: number | undefined
): string | undefined {
  if (bound === undefined) {
    return requested;
  }
  if (requested === undefined || Date.parse(requested) < bound) {
    return new Date(bound).toISOString();
  }
  return requested;
}
