import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import {
  correlationIdOf,
  defaultDevicesDeps,
  jsonResponse,
  serverError,
  type DevicesHandlerDeps,
} from './devices-http';
import { formatConnectionCounts, withConnections } from './device-connection';

/**
 * HAR-20 (MG-80) — GET /devices: the authenticated caller's devices, read from
 * the devices container. `200 { devices: Device[] }`.
 *
 * The owner is the principal's `userId`. A `userId` query parameter or an
 * `x-user-id` header is ignored: neither can widen or redirect the list.
 *
 * HAR-143: each device carries `connection`, read from its IoT Hub twin (at
 * most 8 twin GETs at once). A twin that cannot be read makes that device
 * `unknown`; it never fails the list. The log line carries counts only.
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
    const connected = await withConnections(devices, () => deps.getDeviceTwin());
    context.log(`getDevices connections ${formatConnectionCounts(connected.counts)}`);
    return jsonResponse(200, { devices: connected.devices }, correlationId, requestCharge);
  } catch (error) {
    return serverError('getDevices', 'Failed to retrieve devices', error, correlationId, context);
  }
}
