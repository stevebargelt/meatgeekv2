import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import { validateUpdateDevice } from './device-requests';
import {
  correlationIdOf,
  defaultDevicesDeps,
  deviceConflict,
  deviceNotFound,
  errorBody,
  jsonResponse,
  readJsonBody,
  serverError,
  validationError,
  type DevicesHandlerDeps,
} from './devices-http';

/**
 * HAR-20 (MG-80) — PATCH /devices/{id}: change a device the caller owns.
 * `configuration` merges field by field over the stored one. The write is a
 * replace conditioned on the ETag of the read (If-Match).
 *
 *   - 200: the updated Device;
 *   - 400 VALIDATION_ERROR: a bad body (no Cosmos call);
 *   - 404: unknown, or owned by someone else (indistinguishable);
 *   - 409 DEVICE_CONFLICT: the caller already has another device with that name;
 *   - 409 CONCURRENT_UPDATE: the device changed between the read and the write.
 */
export async function updateDeviceHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: DevicesHandlerDeps = defaultDevicesDeps
): Promise<HttpResponseInit> {
  context.log('Processing updateDevice request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const parsed = await readJsonBody(request);
  if (!parsed) {
    return validationError('Request body must be valid JSON', correlationId, context);
  }
  const validated = validateUpdateDevice(parsed.body);
  if (!validated.ok) {
    return validationError(validated.message, correlationId, context);
  }

  const deviceId = request.params['id'] ?? '';
  try {
    const result = await deps
      .getRepository()
      .updateDevice(principal.principal.userId, deviceId, validated.value);
    context.log(`updateDevice ${result.outcome} (requestCharge=${result.requestCharge} RU)`);
    switch (result.outcome) {
      case 'updated':
        return jsonResponse(200, result.device, correlationId, result.requestCharge);
      case 'notFound':
        return deviceNotFound(correlationId, context, result.requestCharge);
      case 'nameConflict':
        return deviceConflict(correlationId, context, result.requestCharge);
      case 'concurrentUpdate':
        return jsonResponse(
          409,
          errorBody(
            'CONCURRENT_UPDATE',
            'The device changed while this update was being applied. Read it again and retry.',
            context
          ),
          correlationId,
          result.requestCharge
        );
    }
  } catch (error) {
    return serverError('updateDevice', 'Failed to update device', error, correlationId, context);
  }
}
