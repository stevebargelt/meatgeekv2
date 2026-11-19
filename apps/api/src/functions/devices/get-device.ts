import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import {
  correlationIdOf,
  defaultDevicesDeps,
  deviceNotFound,
  jsonResponse,
  serverError,
  type DevicesHandlerDeps,
} from './devices-http';

/**
 * HAR-20 (MG-80) — GET /devices/{id}: one device the caller owns, as a bare
 * Device. One point read (partition key = device id). A device that does not
 * exist and one owned by someone else both answer 404, so the response does not
 * reveal that a foreign device exists.
 */
export async function getDeviceHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: DevicesHandlerDeps = defaultDevicesDeps
): Promise<HttpResponseInit> {
  context.log('Processing getDevice request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const deviceId = request.params['id'] ?? '';
  try {
    const ownership = await deps
      .getRepository()
      .getDeviceOwnership(principal.principal.userId, deviceId);
    context.log(`getDevice ${ownership.status} (requestCharge=${ownership.requestCharge} RU)`);
    if (ownership.status !== 'owned') {
      return deviceNotFound(correlationId, context, ownership.requestCharge);
    }
    return jsonResponse(200, ownership.device, correlationId, ownership.requestCharge);
  } catch (error) {
    return serverError('getDevice', 'Failed to retrieve device', error, correlationId, context);
  }
}
