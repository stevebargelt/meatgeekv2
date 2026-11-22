import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import {
  principalFromRequest,
  unauthenticatedResponse,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import {
  DEVICE_ID_PATTERN,
  getDevicesRepository,
  type DevicesRepository,
} from '../../shared/cosmos/devices-repository';
import {
  getTemperaturesRepository,
  type TemperaturesRepository,
} from '../../shared/cosmos/temperatures-repository';
import { boundedStartTime, claimedAtBound } from '../../shared/devices/readings-bound';
import {
  correlationIdOf,
  errorBody,
  jsonResponse,
  serverError,
  validationError,
} from '../devices/devices-http';

/**
 * HAR-28 (MG-79 part 1) — GET /temperatures/current/{deviceId}: the newest
 * reading IoT Hub routed into the `temperatures` container for a device the
 * caller owns, as a bare TemperatureReading.
 *
 *   - 401 without a usable Easy Auth principal (no Cosmos call);
 *   - 400 VALIDATION_ERROR for an id that cannot be a device id (no Cosmos call);
 *   - 404 DEVICE_NOT_FOUND for a device that does not exist OR belongs to someone
 *     else, with one body for both, as GET /devices/{id} does;
 *   - 404 NO_READINGS for an owned device with no mappable document;
 *   - 200 with the reading otherwise.
 *
 * Ownership is one point read on the devices container; the reading is one
 * single-partition query on the temperatures container. Every response that
 * reached Cosmos carries `x-meatgeek-request-charge` = the sum of both.
 *
 * HAR-136: a device with `claimedAt` (claimed through POST /devices/claim)
 * shows only a reading enqueued at or after it; none there is the same 404
 * NO_READINGS as no reading at all. The bound is in the query
 * (shared/devices/readings-bound.ts). A device without `claimedAt` is not
 * bounded.
 *
 * The reading's device id is the hub-authenticated
 * `SystemProperties["iothub-connection-device-id"]`, never the device-supplied
 * `Body.deviceId` (the MG-73 trust rule, applied in toTemperatureReading).
 */

/** Injection seam. Production wires Easy Auth and the adapter-backed
 *  repositories; tests pass fakes. The repositories are built inside the
 *  invocation, so a missing setting fails that request (as a sanitized 500), not
 *  the module import. */
export interface TemperaturesHandlerDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getDevicesRepository(): Pick<DevicesRepository, 'getDeviceOwnership'>;
  getTemperaturesRepository(): Pick<TemperaturesRepository, 'getLatestReading'>;
}

export const defaultTemperaturesDeps: TemperaturesHandlerDeps = {
  resolvePrincipal: principalFromRequest,
  getDevicesRepository,
  getTemperaturesRepository,
};

export async function getCurrentTemperaturesHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: TemperaturesHandlerDeps = defaultTemperaturesDeps
): Promise<HttpResponseInit> {
  context.log('Processing getCurrentTemperatures request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const deviceId = request.params['deviceId'] ?? '';
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return validationError(
      'deviceId must be 1-128 characters of A-Z, a-z, 0-9, ".", "_", ":" or "-"',
      correlationId,
      context
    );
  }

  let spent: number | undefined;
  try {
    const devices = deps.getDevicesRepository();
    const temperatures = deps.getTemperaturesRepository();

    const ownership = await devices.getDeviceOwnership(principal.principal.userId, deviceId);
    spent = ownership.requestCharge;
    if (ownership.status !== 'owned') {
      context.log(`getCurrentTemperatures device ${ownership.status} (requestCharge=${spent} RU)`);
      return jsonResponse(
        404,
        errorBody('DEVICE_NOT_FOUND', 'Device not found', context),
        correlationId,
        spent
      );
    }

    // HAR-136: only readings from the caller's claim onward.
    const notBefore = boundedStartTime(undefined, claimedAtBound(ownership.device));
    const latest = await temperatures.getLatestReading(
      deviceId,
      notBefore !== undefined ? { notBefore } : {}
    );
    spent += latest.requestCharge;
    context.log(`getCurrentTemperatures ${latest.status} (requestCharge=${spent} RU)`);
    if (latest.status === 'none') {
      return jsonResponse(
        404,
        errorBody('NO_READINGS', 'The device has no temperature readings', context),
        correlationId,
        spent
      );
    }
    return jsonResponse(200, latest.reading, correlationId, spent);
  } catch (error) {
    return serverError(
      'getCurrentTemperatures',
      'Failed to retrieve current temperatures',
      error,
      correlationId,
      context,
      spent
    );
  }
}
