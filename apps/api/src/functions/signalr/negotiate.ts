import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import {
  principalFromRequest,
  unauthenticatedResponse,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import {
  getSignalRManagementClient,
  SignalRUnavailableError,
  type SignalRManagementPort,
} from '../../shared/signalr/signalr-management';

/**
 * HAR-57 (MG-30) — POST /negotiate: a SignalR connection scoped to the caller.
 *
 *   1. The caller is the Easy Auth principal; without one, 401 and no SignalR
 *      call.
 *   2. A client access token is minted for the principal's userId
 *      (`"<tid>:<oid>"`). That is the only SignalR call.
 *
 * Every message a client receives is addressed to its SignalR user: cook events
 * to the cook's owner, live readings to the device's owner (HAR-81,
 * broadcast-temperature.ts). So negotiate reads no devices and manages no
 * groups. Before HAR-81 it re-added the caller to one `device-{id}` group per
 * owned device on every call, about 99 REST calls for the acceptance owner's 98
 * devices, and two negotiates in a row tripped the Free_F1 service's
 * throttling.
 *
 * The request carries no input: a `deviceId` query parameter, which earlier
 * versions bound the connection to, is ignored entirely.
 *
 *   - 200 `{ url, accessToken }`;
 *   - 401 UNAUTHENTICATED: no principal;
 *   - 503 SIGNALR_UNAVAILABLE: minting the token failed, SignalR is not
 *     configured, or SignalR was still throttling after its retries (see
 *     signalr-management.ts). `reason` (HAR-59) is the fixed code naming the
 *     failed operation and, when the service answered, its status, e.g.
 *     `signalr_generate_token_status_429`; any other error is `signalr_failure`.
 *     Neither the body nor the log carries the endpoint, a user id, a token or
 *     the underlying error text.
 */

/** Injection seam. Production wires Easy Auth and the managed-identity SignalR
 *  client; tests pass fakes. The getter runs inside the invocation, so a missing
 *  setting fails that request, not the import. */
export interface NegotiateDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getSignalR(): SignalRManagementPort;
}

export const defaultNegotiateDeps: NegotiateDeps = {
  resolvePrincipal: principalFromRequest,
  getSignalR: getSignalRManagementClient,
};

function response(status: number, body: unknown, correlationId: string): HttpResponseInit {
  return {
    status,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': correlationId },
    jsonBody: body,
  };
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

  try {
    const connection = await deps.getSignalR().generateClientToken(principal.principal.userId);
    context.log('negotiate ok');
    return response(
      200,
      { url: connection.url, accessToken: connection.accessToken },
      correlationId
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
      correlationId
    );
  }
}
