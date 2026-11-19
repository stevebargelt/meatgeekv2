import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Device } from '@meatgeekv2/api-interfaces';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import { mergeDeviceConfiguration } from '../../shared/cosmos/devices-repository';
import { deviceGroup, SignalRUnavailableError } from '../../shared/signalr/signalr-management';
import { validateRegisterDevice } from './device-requests';
import {
  correlationIdOf,
  defaultDevicesDeps,
  deviceConflict,
  jsonResponse,
  readJsonBody,
  serverError,
  validationError,
  type DevicesHandlerDeps,
} from './devices-http';

/**
 * HAR-20 (MG-80) — POST /devices: register a device to the caller.
 *
 * The document is created with Cosmos `create` (never upsert) with the
 * principal as owner, `isActive: true` and `connectionStatus: 'unknown'`. A
 * supplied `configuration` is completed from DEFAULT_DEVICE_CONFIGURATION.
 *
 *   - 201: the stored Device;
 *   - 400 VALIDATION_ERROR: a bad body (no Cosmos call);
 *   - 409 DEVICE_CONFLICT: the id exists (whoever owns it) or the caller already
 *     has a device with that name. Fixed text; it does not say which.
 *
 * HAR-57 (MG-30): after a successful create, the owner's SignalR user joins the
 * `device-{id}` group so connections they already hold get the new device's
 * readings. A failure there is logged as a fixed code and the 201 stands: the
 * next negotiate resets the owner's groups from the devices container anyway.
 */
export async function registerDeviceHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: DevicesHandlerDeps = defaultDevicesDeps
): Promise<HttpResponseInit> {
  context.log('Processing registerDevice request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const parsed = await readJsonBody(request);
  if (!parsed) {
    return validationError('Request body must be valid JSON', correlationId, context);
  }
  const validated = validateRegisterDevice(parsed.body);
  if (!validated.ok) {
    return validationError(validated.message, correlationId, context);
  }
  const { deviceId, name, model, location, configuration } = validated.value;

  const device: Device = {
    id: deviceId,
    userId: principal.principal.userId,
    name,
    model,
    ...(location !== undefined ? { location } : {}),
    isActive: true,
    connectionStatus: 'unknown',
    ...(configuration !== undefined
      ? { configuration: mergeDeviceConfiguration(undefined, configuration) }
      : {}),
  };

  try {
    const result = await deps.getRepository().registerDevice(device);
    context.log(`registerDevice ${result.outcome} (requestCharge=${result.requestCharge} RU)`);
    if (result.outcome === 'conflict') {
      return deviceConflict(correlationId, context, result.requestCharge);
    }
    await joinDeviceGroup(deps, result.device.id, device.userId, context);
    return jsonResponse(201, result.device, correlationId, result.requestCharge);
  } catch (error) {
    return serverError(
      'registerDevice',
      'Failed to register device',
      error,
      correlationId,
      context
    );
  }
}

/** Adds the owner to the device's SignalR group. Never throws: a failure is a
 *  sanitized warning, since the next negotiate restores membership. */
async function joinDeviceGroup(
  deps: DevicesHandlerDeps,
  deviceId: string,
  userId: string,
  context: InvocationContext
): Promise<void> {
  try {
    await deps.getSignalR().addUserToGroup(deviceGroup(deviceId), userId);
  } catch (error) {
    const code = error instanceof SignalRUnavailableError ? error.code : 'signalr_failure';
    context.warn(`registerDevice: device group join failed: ${code}`);
  }
}
