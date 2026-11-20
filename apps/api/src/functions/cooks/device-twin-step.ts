import type { InvocationContext } from '@azure/functions';

import { DeviceTwinSyncError, type SyncDeviceTwin } from '../../shared/iothub/device-twin-sync';
import { requestChargeOfError } from '../../shared/cosmos/request-charge';

/**
 * HAR-66 — the device twin step start and stop share. It runs after the Cosmos
 * write, so the twin follows the stored state. A failure never undoes the
 * write: the handler answers 503 DEVICE_TWIN_UPDATE_FAILED, and a retry of the
 * same request converges (start replays, stop finds the cook completed, and
 * both sync again).
 */

export type DeviceTwinStep =
  | { readonly ok: true; readonly requestCharge: number }
  | { readonly ok: false; readonly reason: string; readonly requestCharge: number };

export async function runDeviceTwinStep(
  sync: SyncDeviceTwin,
  context: InvocationContext,
  handler: 'startCook' | 'stopCook',
  userId: string,
  deviceId: string,
  correlationId: string
): Promise<DeviceTwinStep> {
  try {
    const result = await sync(userId, deviceId, correlationId);
    context.log(`${handler} device twin ${result.outcome}`);
    return { ok: true, requestCharge: result.requestCharge };
  } catch (error) {
    // Only a fixed code is read from the error, never its text.
    const reason = error instanceof DeviceTwinSyncError ? error.reason : 'device_twin_sync_failed';
    context.error(`${handler} device twin update failed: ${reason}`);
    return { ok: false, reason, requestCharge: requestChargeOfError(error) ?? 0 };
  }
}

/** The 503 body. `reason` is the fixed code from {@link DeviceTwinSyncError}. */
export function deviceTwinUpdateFailedBody(cookId: string, reason: string, requestId: string) {
  return {
    error: 'DEVICE_TWIN_UPDATE_FAILED',
    message: 'The cook was saved, but the device twin was not updated. Retry the same request.',
    cookId,
    reason,
    requestId,
  };
}
