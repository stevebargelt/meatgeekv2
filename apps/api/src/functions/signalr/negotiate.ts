import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import {
  principalFromRequest,
  unauthenticatedResponse,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import { CosmosConfigError } from '../../shared/cosmos/cosmos-adapter';
import {
  getDevicesRepository,
  type DevicesRepository,
} from '../../shared/cosmos/devices-repository';
import { chargeAfterError, requestChargeHeaders } from '../../shared/cosmos/request-charge';
import {
  deviceGroup,
  getSignalRManagementClient,
  SignalRUnavailableError,
  type SignalRManagementPort,
} from '../../shared/signalr/signalr-management';

/**
 * HAR-57 (MG-30) — POST /negotiate: a SignalR connection scoped to the caller.
 *
 *   1. The caller is the Easy Auth principal; without one, 401 and no SignalR
 *      call.
 *   2. The caller's devices are read from the devices container.
 *   3. The caller's SignalR user is removed from every group, then added to
 *      `device-{id}` for each device they own, and nothing else. A device that
 *      changed hands since the last negotiate drops out here. The adds run at
 *      most {@link GROUP_ADD_CONCURRENCY} at a time (HAR-80), so a caller with
 *      many devices does not burst SignalR into throttling; each SignalR call
 *      also retries a `429`/`503` answer itself (see signalr-management.ts).
 *   4. A client access token is minted for the principal's userId
 *      (`"<tid>:<oid>"`), so cook events sent to that user reach the caller.
 *
 * The request carries no input: a `deviceId` query parameter, which earlier
 * versions bound the connection to, is ignored entirely.
 *
 *   - 200 `{ url, accessToken }`, with the Cosmos request charge;
 *   - 401 UNAUTHENTICATED: no principal;
 *   - 500 INTERNAL_SERVER_ERROR: the devices read failed;
 *   - 503 SIGNALR_UNAVAILABLE: a SignalR REST call failed or SignalR is not
 *     configured, or SignalR was still throttling after its retries. The
 *     first failed add fails negotiate. `reason` (HAR-59) is the fixed code naming the failed
 *     operation and, when the service answered, its status, e.g.
 *     `signalr_add_user_to_group_status_404`; any other error is
 *     `signalr_failure`. Neither the body nor the log carries the endpoint, a
 *     user id, a group, a token or the underlying error text.
 */

/** The most `addUserToGroup` calls negotiate has in flight at once. */
export const GROUP_ADD_CONCURRENCY = 4;

/**
 * Runs `task` over `items` with at most `limit` in flight. Rejects with the
 * first failure; once one has failed, no new task starts.
 */
async function forEachBounded<T>(
  items: readonly T[],
  limit: number,
  task: (item: T) => Promise<void>
): Promise<void> {
  let next = 0;
  let failed = false;
  const worker = async (): Promise<void> => {
    while (!failed && next < items.length) {
      const item = items[next++];
      try {
        await task(item);
      } catch (error) {
        failed = true;
        throw error;
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

/** Injection seam. Production wires Easy Auth, the devices repository and the
 *  managed-identity SignalR client; tests pass fakes. Both getters run inside
 *  the invocation, so a missing setting fails that request, not the import. */
export interface NegotiateDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getRepository(): Pick<DevicesRepository, 'listDevicesByOwner'>;
  getSignalR(): SignalRManagementPort;
}

export const defaultNegotiateDeps: NegotiateDeps = {
  resolvePrincipal: principalFromRequest,
  getRepository: getDevicesRepository,
  getSignalR: getSignalRManagementClient,
};

function response(
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

/** A code safe to log for a failed devices read. Never the error's text. */
function cosmosFailureCode(error: unknown): string {
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

export async function negotiateHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: NegotiateDeps = defaultNegotiateDeps
): Promise<HttpResponseInit> {
  context.log('Processing SignalR negotiate request');
  const correlationId = request.headers.get('X-Request-ID') ?? context.invocationId;

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }
  const { userId } = principal.principal;

  let deviceIds: string[];
  let requestCharge: number;
  try {
    const owned = await deps.getRepository().listDevicesByOwner(userId);
    deviceIds = owned.devices.map(device => device.id);
    requestCharge = owned.requestCharge;
  } catch (error) {
    context.error(`negotiate failed: ${cosmosFailureCode(error)}`);
    return response(
      500,
      {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to negotiate a SignalR connection',
        requestId: context.invocationId,
      },
      correlationId,
      chargeAfterError(0, error)
    );
  }

  try {
    const signalR = deps.getSignalR();
    await signalR.removeUserFromAllGroups(userId);
    await forEachBounded(deviceIds, GROUP_ADD_CONCURRENCY, id =>
      signalR.addUserToGroup(deviceGroup(id), userId)
    );
    const connection = await signalR.generateClientToken(userId);
    context.log(
      `negotiate ok: ${deviceIds.length} device group(s) (requestCharge=${requestCharge} RU)`
    );
    return response(
      200,
      { url: connection.url, accessToken: connection.accessToken },
      correlationId,
      requestCharge
    );
  } catch (error) {
    // Only the code is read from the error: it is fixed text built from the
    // operation name and a numeric status (SignalRUnavailableError).
    const reason = error instanceof SignalRUnavailableError ? error.code : 'signalr_failure';
    context.error(`negotiate failed: ${reason}`);
    return response(
      503,
      {
        error: 'SIGNALR_UNAVAILABLE',
        message: 'Real-time updates are unavailable. Try again later.',
        reason,
        requestId: context.invocationId,
      },
      correlationId,
      requestCharge
    );
  }
}
