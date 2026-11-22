import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import { getCooksRepository, type CooksRepository } from '../../shared/cosmos/cooks-repository';
import { requestChargeHeaders } from '../../shared/cosmos/request-charge';
import {
  DeviceTwinError,
  getDeviceTwinClient,
  type DeviceTwin,
  type DeviceTwinPort,
} from '../../shared/iothub/device-twin';
import { deviceNotOwnedBody } from '../cooks/device-ownership';
import { deviceClaimTwinFailedBody, deviceTwinFailureReason } from '../cooks/device-twin-step';
import {
  correlationIdOf,
  defaultDevicesDeps,
  errorBody,
  jsonResponse,
  serverError,
  type DevicesHandlerDeps,
} from './devices-http';

/**
 * HAR-136 (goal HAR-130) — DELETE /devices/{id} releases one of the caller's
 * devices, so it can be claimed again, but only with a fresh claim code
 * (learnings/decisions/har-130-device-provisioning-and-claim.md, Decision 3).
 *
 *  1. Authenticate, then one point read for ownership: 404 DEVICE_NOT_FOUND
 *     for an unknown id, 403 DEVICE_NOT_OWNED for someone else's device.
 *  2. 409 COOK_ACTIVE when the caller has an active cook on the device. The
 *     MG-84 lock `active-device:<deviceId>` in the caller's partition is one
 *     point read; only when a lock exists is the cook it names read too, so a
 *     stale lock (its cook completed) does not block the release. No query.
 *     Nothing is changed.
 *  3. Read the twin and patch desired `claimGeneration` to its value + 1
 *     (absent = "0", so the first release writes "1") and `claimClaimantHash:
 *     null`, under `If-Match` on the etag read. `claimConsumedCodeHash` is kept,
 *     so the old code stays consumed. A 412 re-reads once and retries. A twin
 *     that does not exist (IoT Hub 404: a device registered through
 *     `POST /devices` with no hub identity) skips this step. Any other twin
 *     failure is 503 DEVICE_TWIN_UPDATE_FAILED and the document is NOT deleted,
 *     so a retry is safe.
 *  4. Delete the device document → 204.
 *
 * The device sees the generation bump and mints a new code (HAR-134). The old
 * code can never be accepted again: desired `claimConsumedCodeHash` still is
 * its hash, and its reported generation no longer matches the desired one.
 *
 * Every answer after the principal check carries `x-meatgeek-request-charge`:
 * the sum of every Cosmos call the request made. Only the device document goes.
 * Its cooks stay in the owner's history, and its readings expire on the
 * temperatures container's TTL.
 */

/** The fixed 409 text. */
export const COOK_ACTIVE_MESSAGE = 'Stop the active cook before releasing this device';

/** Twin reads per release: the first, and one more after a 412 on the patch. */
export const RELEASE_TWIN_MAX_READS = 2;

/** Injection seam: the devices seam plus the cook lock and the device twin.
 *  Tests pass fake containers and a fake twin hub. */
export interface DeleteDeviceDeps extends DevicesHandlerDeps {
  getCooksRepository(): Pick<CooksRepository, 'getActiveCookIdForDevice'>;
  getDeviceTwin(): DeviceTwinPort;
}

export const defaultDeleteDeviceDeps: DeleteDeviceDeps = {
  ...defaultDevicesDeps,
  getCooksRepository,
  getDeviceTwin: getDeviceTwinClient,
};

/**
 * The desired `claimGeneration` after a release: the current one + 1. Absent
 * counts as "0", as the claim route reads it, so the first release writes "1".
 * A value that is not a decimal string of at most 15 digits (data the API never
 * writes) also becomes "1", which still differs from it.
 */
export function nextClaimGeneration(desired: Readonly<Record<string, unknown>>): string {
  const current = desired['claimGeneration'];
  if (typeof current === 'string' && /^\d{1,15}$/.test(current)) {
    return String(Number(current) + 1);
  }
  return '1';
}

type ReleaseTwinStep =
  | { readonly ok: true; readonly outcome: 'patched' | 'no_twin' }
  | { readonly ok: false; readonly reason: string };

/** Step 3: bump the generation and clear the claimant, under `If-Match`. */
async function releaseTwin(twins: DeviceTwinPort, deviceId: string): Promise<ReleaseTwinStep> {
  for (let read = 1; read <= RELEASE_TWIN_MAX_READS; read++) {
    let twin: DeviceTwin;
    try {
      twin = await twins.getTwin(deviceId);
    } catch (error) {
      if (error instanceof DeviceTwinError && error.isNotFound) {
        return { ok: true, outcome: 'no_twin' };
      }
      return { ok: false, reason: deviceTwinFailureReason(error) };
    }

    try {
      await twins.patchDesired(
        deviceId,
        { claimGeneration: nextClaimGeneration(twin.desired), claimClaimantHash: null },
        twin.etag
      );
      return { ok: true, outcome: 'patched' };
    } catch (error) {
      if (
        error instanceof DeviceTwinError &&
        error.isPreconditionFailed &&
        read < RELEASE_TWIN_MAX_READS
      ) {
        continue;
      }
      if (error instanceof DeviceTwinError && error.isNotFound) {
        // The hub identity was deleted between the read and the patch.
        return { ok: true, outcome: 'no_twin' };
      }
      return { ok: false, reason: deviceTwinFailureReason(error) };
    }
  }
  // Unreachable: the last read either returns or fails above.
  return { ok: false, reason: 'iothub_patch_twin_status_412' };
}

export async function deleteDeviceHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: DeleteDeviceDeps = defaultDeleteDeviceDeps
): Promise<HttpResponseInit> {
  context.log('Processing deleteDevice request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }
  const userId = principal.principal.userId;

  const deviceId = request.params['id'] ?? '';
  let spent = 0;
  try {
    const devices = deps.getRepository();

    // 1. Ownership.
    const ownership = await devices.getDeviceOwnership(userId, deviceId);
    spent += ownership.requestCharge;
    if (ownership.status === 'foreign') {
      context.log(`deleteDevice foreign (requestCharge=${spent} RU)`);
      return jsonResponse(403, deviceNotOwnedBody(context.invocationId), correlationId, spent);
    }
    if (ownership.status === 'unknown') {
      context.log(`deleteDevice notFound (requestCharge=${spent} RU)`);
      return jsonResponse(
        404,
        errorBody('DEVICE_NOT_FOUND', 'Device not found', context),
        correlationId,
        spent
      );
    }

    // 2. No release while a cook is active.
    const active = await deps.getCooksRepository().getActiveCookIdForDevice(userId, deviceId);
    spent += active.requestCharge;
    if (active.cookId !== undefined) {
      context.log(`deleteDevice cook_active (requestCharge=${spent} RU)`);
      return jsonResponse(
        409,
        errorBody('COOK_ACTIVE', COOK_ACTIVE_MESSAGE, context),
        correlationId,
        spent
      );
    }

    // 3. The twin: a fresh claim code is needed from here on.
    let twinStep: ReleaseTwinStep;
    try {
      twinStep = await releaseTwin(deps.getDeviceTwin(), deviceId);
    } catch (error) {
      // getDeviceTwin throws DeviceTwinError('configuration') when the hub
      // hostname setting is missing.
      twinStep = { ok: false, reason: deviceTwinFailureReason(error) };
    }
    if (!twinStep.ok) {
      context.error(`deleteDevice device twin failed: ${twinStep.reason}`);
      return jsonResponse(
        503,
        deviceClaimTwinFailedBody(twinStep.reason, context.invocationId),
        correlationId,
        spent
      );
    }
    context.log(`deleteDevice device twin ${twinStep.outcome}`);

    // 4. The document.
    const result = await devices.deleteDevice(userId, deviceId);
    spent += result.requestCharge;
    context.log(`deleteDevice ${result.outcome} (requestCharge=${spent} RU)`);
    switch (result.outcome) {
      case 'deleted':
        return {
          status: 204,
          headers: { 'X-Request-ID': correlationId, ...requestChargeHeaders(spent) },
        };
      case 'foreign':
        return jsonResponse(403, deviceNotOwnedBody(context.invocationId), correlationId, spent);
      case 'notFound':
        return jsonResponse(
          404,
          errorBody('DEVICE_NOT_FOUND', 'Device not found', context),
          correlationId,
          spent
        );
    }
  } catch (error) {
    return serverError(
      'deleteDevice',
      'Failed to delete device',
      error,
      correlationId,
      context,
      spent
    );
  }
}
