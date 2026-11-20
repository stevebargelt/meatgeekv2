import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import { requestChargeHeaders } from '../../shared/cosmos/request-charge';
import { deviceNotOwnedBody } from '../cooks/device-ownership';
import {
  correlationIdOf,
  defaultDevicesDeps,
  errorBody,
  jsonResponse,
  serverError,
  type DevicesHandlerDeps,
} from './devices-http';

/**
 * HAR-85 — DELETE /devices/{id}: delete one of the caller's devices. One point
 * read for ownership, then one point delete (partition key = device id).
 *
 *   - 204: deleted (no body);
 *   - 403 DEVICE_NOT_OWNED: the device belongs to someone else; nothing is
 *     deleted;
 *   - 404 DEVICE_NOT_FOUND: no device has that id.
 *
 * Unlike GET and PATCH /devices/{id}, which answer 404 for both, a delete tells
 * a foreign device from an unknown one, as the cook routes' 403 does. Every
 * answer after the principal check carries `x-meatgeek-request-charge`.
 *
 * Only the device document goes. Its cooks stay in the owner's history, and its
 * readings expire on the temperatures container's TTL. A cook still active on
 * the device cannot be stopped (stop-cook checks the cook's device: 403) until
 * the owner registers the same id again.
 */
export async function deleteDeviceHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: DevicesHandlerDeps = defaultDevicesDeps
): Promise<HttpResponseInit> {
  context.log('Processing deleteDevice request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const deviceId = request.params['id'] ?? '';
  try {
    const result = await deps.getRepository().deleteDevice(principal.principal.userId, deviceId);
    context.log(`deleteDevice ${result.outcome} (requestCharge=${result.requestCharge} RU)`);
    switch (result.outcome) {
      case 'deleted':
        return {
          status: 204,
          headers: {
            'X-Request-ID': correlationId,
            ...requestChargeHeaders(result.requestCharge),
          },
        };
      case 'foreign':
        return jsonResponse(
          403,
          deviceNotOwnedBody(context.invocationId),
          correlationId,
          result.requestCharge
        );
      case 'notFound':
        return jsonResponse(
          404,
          errorBody('DEVICE_NOT_FOUND', 'Device not found', context),
          correlationId,
          result.requestCharge
        );
    }
  } catch (error) {
    return serverError('deleteDevice', 'Failed to delete device', error, correlationId, context);
  }
}
