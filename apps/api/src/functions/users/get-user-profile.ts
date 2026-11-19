import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import { correlationIdOf, errorBody, jsonResponse, serverError } from '../devices/devices-http';
import { defaultUsersDeps, type UsersHandlerDeps } from './users-http';

/**
 * HAR-27 (MG-81) — GET /users/me: the authenticated caller's profile, one point
 * read in the users container (partition key = the principal's userId), with
 * `devices` filled from the devices owner query.
 *
 *   - 200: the User;
 *   - 404 USER_NOT_FOUND: the caller has no profile yet (PUT /users/me makes one).
 *
 * A `userId` query parameter or an `x-user-id` header is ignored.
 */
export async function getUserProfileHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: UsersHandlerDeps = defaultUsersDeps
): Promise<HttpResponseInit> {
  context.log('Processing getUserProfile request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  try {
    const result = await deps.getRepository().getUser(principal.principal.userId);
    context.log(`getUserProfile ${result.outcome} (requestCharge=${result.requestCharge} RU)`);
    if (result.outcome === 'notFound') {
      return jsonResponse(
        404,
        errorBody(
          'USER_NOT_FOUND',
          'The caller has no profile yet. Create one with PUT /users/me.',
          context
        ),
        correlationId,
        result.requestCharge
      );
    }
    return jsonResponse(200, result.user, correlationId, result.requestCharge);
  } catch (error) {
    return serverError(
      'getUserProfile',
      'Failed to retrieve user profile',
      error,
      correlationId,
      context
    );
  }
}
