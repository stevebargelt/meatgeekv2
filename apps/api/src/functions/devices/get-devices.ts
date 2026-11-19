import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import {
  correlationIdOf,
  defaultDevicesDeps,
  jsonResponse,
  serverError,
  type DevicesHandlerDeps,
} from './devices-http';

/**
 * HAR-20 (MG-80) — GET /devices: the authenticated caller's devices, read from
 * the devices container. `200 { devices: Device[] }`.
 *
 * The owner is the principal's `userId`. A `userId` query parameter or an
 * `x-user-id` header is ignored: neither can widen or redirect the list.
 */
export async function getDevicesHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: DevicesHandlerDeps = defaultDevicesDeps
): Promise<HttpResponseInit> {
  context.log('Processing getDevices request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  try {
    const { devices, requestCharge } = await deps
      .getRepository()
      .listDevicesByOwner(principal.principal.userId);
    context.log(`getDevices returned ${devices.length} (requestCharge=${requestCharge} RU)`);
    return jsonResponse(200, { devices }, correlationId, requestCharge);
  } catch (error) {
    return serverError('getDevices', 'Failed to retrieve devices', error, correlationId, context);
  }
}
