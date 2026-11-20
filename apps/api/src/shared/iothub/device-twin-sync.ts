import { getCooksRepository, type CooksRepository } from '../cosmos/cooks-repository';
import {
  DeviceTwinError,
  getDeviceTwinClient,
  type DesiredPatch,
  type DeviceTwin,
  type DeviceTwinPort,
} from './device-twin';

/**
 * HAR-66 (goal HAR-55) — bring a device twin's desired properties in line with
 * Cosmos. Start and stop call this after their Cosmos write; the twin is a
 * projection of the device's active cook, never of the request that triggered
 * the sync.
 *
 * TWIN CONTRACT (implemented on the device; do not change)
 *   desired.activeCookId   string, or absent
 *   desired.correlationId  string, or absent
 * Absent is sent as `null`, which IoT Hub turns into a deleted property.
 *
 * ONE ATTEMPT
 *   1. GET the twin and keep its etag.
 *   2. Read the device's active cook from Cosmos (the MG-84 lock, then its cook).
 *   3. Work out the target:
 *        - no active cook               -> { activeCookId: null, correlationId: null }
 *        - active cook already on twin  -> keep the twin's correlationId
 *        - otherwise                    -> { activeCookId: <id>, correlationId }
 *   4. If the twin already equals the target, stop.
 *   5. Otherwise PATCH with If-Match on the etag from step 1.
 *   6. Re-read the active cook. If it still matches what was written, stop.
 *
 * A 412 on step 5, or a changed cook on step 6, starts a new attempt, up to
 * {@link DEVICE_TWIN_SYNC_MAX_ATTEMPTS} in total.
 *
 * WHY THIS ORDER
 * Reading the twin before Cosmos means a PATCH that succeeds was based on a
 * Cosmos read made after the twin was last written. So a late, retried stop of
 * cook A after cook B started reads B and leaves B; a slow start that lost to a
 * stop reads "no active cook" and does not resurrect its cook.
 *
 * Step 6 closes the one gap that ordering leaves. A start can read "A active"
 * (step 2), then a stop completes A in Cosmos and its own sync finds the twin
 * still clear and writes nothing, so the twin etag never changes and the start's
 * PATCH of A succeeds. The re-read after the PATCH sees A completed and the next
 * attempt clears the twin. It costs two point reads after a PATCH, none when
 * the twin already matched.
 *
 * NO TWIN
 * A device with no IoT Hub identity has no twin (GET answers 404). There is
 * nothing to sync, so the result is `noTwin`, not a failure. Dev's registered
 * test devices are like this.
 */

/** Attempts (each a twin read, a Cosmos read and at most one PATCH) per sync. */
export const DEVICE_TWIN_SYNC_MAX_ATTEMPTS = 3;

/** The Cosmos read the sync needs. */
export type ActiveCookReader = Pick<CooksRepository, 'getActiveCookIdForDevice'>;

/** What a sync did. */
export type DeviceTwinSyncOutcome = 'patched' | 'unchanged' | 'noTwin';

export interface DeviceTwinSyncResult {
  readonly outcome: DeviceTwinSyncOutcome;
  /** RU of the Cosmos reads — a bare number, safe to log. */
  readonly requestCharge: number;
}

/**
 * A sync did not converge. `reason` is a fixed code, safe to log and to return:
 * a {@link DeviceTwinError} code (`iothub_<operation>_status_<n>` or
 * `iothub_<operation>_failed`; `iothub_patch_twin_status_412` when the last
 * attempt lost the etag race), `cosmos_active_cook_read_failed`, or
 * `device_twin_sync_contended` when the last attempt's PATCH landed but the
 * active cook changed under it.
 * `requestCharge` is the RU spent before the failure.
 */
export class DeviceTwinSyncError extends Error {
  constructor(
    readonly reason: string,
    readonly requestCharge: number
  ) {
    super(reason);
    this.name = 'DeviceTwinSyncError';
  }
}

/** The signature the start and stop handlers inject. */
export type SyncDeviceTwin = (
  userId: string,
  deviceId: string,
  correlationId: string
) => Promise<DeviceTwinSyncResult>;

export interface DeviceTwinSyncDeps {
  readonly twin: DeviceTwinPort;
  readonly cooks: ActiveCookReader;
}

/** The cook properties of the twin's current desired state. */
interface CookDesired {
  readonly activeCookId: string | null;
  readonly correlationId: string | null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' ? value : null;
}

function currentDesired(twin: DeviceTwin): CookDesired {
  return {
    activeCookId: stringOrNull(twin.desired['activeCookId']),
    correlationId: stringOrNull(twin.desired['correlationId']),
  };
}

/** Step 3: the desired state Cosmos calls for. */
export function targetDesired(
  current: CookDesired,
  activeCookId: string | undefined,
  correlationId: string
): CookDesired {
  if (activeCookId === undefined) {
    return { activeCookId: null, correlationId: null };
  }
  if (activeCookId === current.activeCookId) {
    return { activeCookId, correlationId: current.correlationId };
  }
  return { activeCookId, correlationId };
}

export async function syncDeviceTwinWith(
  deps: DeviceTwinSyncDeps,
  userId: string,
  deviceId: string,
  correlationId: string
): Promise<DeviceTwinSyncResult> {
  let requestCharge = 0;
  let patched = false;
  let lastFailure = 'device_twin_sync_contended';

  const readActiveCook = async (): Promise<string | undefined> => {
    let read: Awaited<ReturnType<ActiveCookReader['getActiveCookIdForDevice']>>;
    try {
      read = await deps.cooks.getActiveCookIdForDevice(userId, deviceId);
    } catch {
      // A Cosmos error's text can name the account; only a fixed code leaves.
      throw new DeviceTwinSyncError('cosmos_active_cook_read_failed', requestCharge);
    }
    requestCharge += read.requestCharge;
    return read.cookId;
  };

  const twinFailure = (error: unknown): DeviceTwinSyncError =>
    new DeviceTwinSyncError(
      error instanceof DeviceTwinError ? error.code : 'iothub_failure',
      requestCharge
    );

  for (let attempt = 1; attempt <= DEVICE_TWIN_SYNC_MAX_ATTEMPTS; attempt++) {
    let twin: DeviceTwin;
    try {
      twin = await deps.twin.getTwin(deviceId);
    } catch (error) {
      if (error instanceof DeviceTwinError && error.isNotFound) {
        return { outcome: 'noTwin', requestCharge };
      }
      throw twinFailure(error);
    }

    const activeCookId = await readActiveCook();
    const current = currentDesired(twin);
    const target = targetDesired(current, activeCookId, correlationId);
    if (
      current.activeCookId === target.activeCookId &&
      current.correlationId === target.correlationId
    ) {
      return { outcome: patched ? 'patched' : 'unchanged', requestCharge };
    }

    const patch: DesiredPatch = {
      activeCookId: target.activeCookId,
      correlationId: target.correlationId,
    };
    try {
      await deps.twin.patchDesired(deviceId, patch, twin.etag);
    } catch (error) {
      if (error instanceof DeviceTwinError && error.isPreconditionFailed) {
        lastFailure = error.code;
        continue;
      }
      if (error instanceof DeviceTwinError && error.isNotFound) {
        // The device was deleted between the read and the write.
        return { outcome: 'noTwin', requestCharge };
      }
      throw twinFailure(error);
    }
    patched = true;
    lastFailure = 'device_twin_sync_contended';

    if ((await readActiveCook()) === activeCookId) {
      return { outcome: 'patched', requestCharge };
    }
  }

  throw new DeviceTwinSyncError(lastFailure, requestCharge);
}

/**
 * The sync the deployed app uses: the shared twin client and the adapter-backed
 * cooks repository, both resolved at call time so importing a handler has no
 * side effect (the Cosmos adapter and the twin client are both lazy). A missing
 * hostname surfaces as `iothub_configuration_failed`.
 */
export const syncDeviceTwin: SyncDeviceTwin = async (userId, deviceId, correlationId) => {
  let deps: DeviceTwinSyncDeps;
  try {
    deps = { twin: getDeviceTwinClient(), cooks: getCooksRepository() };
  } catch (error) {
    throw new DeviceTwinSyncError(
      error instanceof DeviceTwinError ? error.code : 'device_twin_sync_unconfigured',
      0
    );
  }
  return syncDeviceTwinWith(deps, userId, deviceId, correlationId);
};
