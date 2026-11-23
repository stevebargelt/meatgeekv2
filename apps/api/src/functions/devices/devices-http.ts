import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import {
  principalFromRequest,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import { CosmosConfigError } from '../../shared/cosmos/cosmos-adapter';
import {
  getDevicesRepository,
  type DevicesRepository,
} from '../../shared/cosmos/devices-repository';
import { chargeAfterError, requestChargeHeaders } from '../../shared/cosmos/request-charge';
import { getDeviceTwinClient, type DeviceTwinPort } from '../../shared/iothub/device-twin';

/**
 * HAR-20 (MG-80) — what the devices handlers share: their injection seam
 * and their response shapes.
 *
 * Identity comes only from the Easy Auth principal. No handler reads a `userId`
 * query parameter, an `x-user-id` header, or a body field for it.
 *
 * Every response that reached Cosmos carries `x-meatgeek-request-charge`. A
 * failure becomes a 500 with fixed text; the log line carries a fixed code or a
 * numeric status, never Cosmos error text, a name from configuration, or claims.
 */

/** The repository surface the handlers use. */
export type DevicesRepositoryPort = Pick<
  DevicesRepository,
  'listDevicesByOwner' | 'getDeviceOwnership' | 'updateDevice' | 'deleteDevice'
>;

/** Injection seam. Production wires Easy Auth and the adapter-backed
 *  repository; tests pass fakes. The getters run inside the invocation, so a
 *  missing setting fails that request (as a sanitized 500), not the module
 *  import. */
export interface DevicesHandlerDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getRepository(): DevicesRepositoryPort;
  /** The IoT Hub twin client: the GETs read each device's connection from
   *  it (HAR-143), DELETE releases the device through it (HAR-136). */
  getDeviceTwin(): DeviceTwinPort;
}

export const defaultDevicesDeps: DevicesHandlerDeps = {
  resolvePrincipal: principalFromRequest,
  getRepository: getDevicesRepository,
  getDeviceTwin: getDeviceTwinClient,
};

/** The request id echoed in `X-Request-ID`: the caller's, else the invocation id. */
export function correlationIdOf(request: HttpRequest, context: InvocationContext): string {
  return request.headers.get('X-Request-ID') ?? context.invocationId;
}

/** A JSON response. `requestCharge` is set when the request reached Cosmos. */
export function jsonResponse(
  status: number,
  body: unknown,
  correlationId: string,
  requestCharge?: number
): HttpResponseInit {
  return {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': correlationId,
      ...requestChargeHeaders(requestCharge),
    },
    jsonBody: body,
  };
}

export function errorBody(error: string, message: string, context: InvocationContext) {
  return { error, message, requestId: context.invocationId };
}

/** 400 before any Cosmos call: no request-charge header. */
export function validationError(
  message: string,
  correlationId: string,
  context: InvocationContext
): HttpResponseInit {
  return jsonResponse(400, errorBody('VALIDATION_ERROR', message, context), correlationId);
}

/** 404 for a device that is unknown OR owned by someone else; the two are
 *  indistinguishable on purpose. */
export function deviceNotFound(
  correlationId: string,
  context: InvocationContext,
  requestCharge: number
): HttpResponseInit {
  return jsonResponse(
    404,
    errorBody('NOT_FOUND', 'Device not found', context),
    correlationId,
    requestCharge
  );
}

/** Fixed 409 text for a taken id or name; it never says which. */
export function deviceConflict(
  correlationId: string,
  context: InvocationContext,
  requestCharge: number
): HttpResponseInit {
  return jsonResponse(
    409,
    errorBody('DEVICE_CONFLICT', 'A device with this id or name already exists.', context),
    correlationId,
    requestCharge
  );
}

/** A code safe to log for a failure: the config failure code, or a numeric
 *  status. Never the error's text. */
function failureCode(error: unknown): string {
  if (error instanceof CosmosConfigError) {
    return error.code;
  }
  const reported = error as { statusCode?: unknown; code?: unknown } | null | undefined;
  for (const value of [reported?.statusCode, reported?.code]) {
    if (typeof value === 'number') {
      return `cosmos_status_${value}`;
    }
  }
  return 'cosmos_failure';
}

/**
 * The sanitized 500. Carries `chargeAfterError(spent, error)`: the RU of
 * earlier Cosmos calls in the same request plus whatever the failed operation
 * reported, and no header when neither is known.
 */
export function serverError(
  operation: string,
  message: string,
  error: unknown,
  correlationId: string,
  context: InvocationContext,
  spent = 0
): HttpResponseInit {
  context.error(`${operation} failed: ${failureCode(error)}`);
  return jsonResponse(
    500,
    errorBody('INTERNAL_SERVER_ERROR', message, context),
    correlationId,
    chargeAfterError(spent, error)
  );
}

/** Reads a JSON body. A malformed body is `undefined` (the caller answers 400). */
export async function readJsonBody(request: HttpRequest): Promise<{ body: unknown } | undefined> {
  try {
    return { body: await request.json() };
  } catch {
    return undefined;
  }
}
