import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import {
  correlationIdOf,
  errorBody,
  jsonResponse,
  readJsonBody,
  serverError,
  validationError,
} from '../devices/devices-http';
import { validatePutUserProfile } from './user-requests';
import { defaultUsersDeps, type UsersHandlerDeps } from './users-http';

/**
 * HAR-27 (MG-81) — PUT /users/me: create or replace the caller's profile. The
 * document's id is the principal's userId; the body never names it.
 *
 *   - 201: created (`createdAt` = now; preferences over DEFAULT_USER_PREFERENCES);
 *   - 200: replaced (`createdAt` kept; preferences deep-merged over the stored ones);
 *   - 400 VALIDATION_ERROR: a bad body, including one carrying `id` or `userId`
 *     (no Cosmos call);
 *   - 409 CONCURRENT_UPDATE: the profile changed between the read and the write.
 */
export async function putUserProfileHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: UsersHandlerDeps = defaultUsersDeps
): Promise<HttpResponseInit> {
  context.log('Processing putUserProfile request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const parsed = await readJsonBody(request);
  if (!parsed) {
    return validationError('Request body must be valid JSON', correlationId, context);
  }
  const validated = validatePutUserProfile(parsed.body);
  if (!validated.ok) {
    return validationError(validated.message, correlationId, context);
  }

  try {
    const result = await deps.getRepository().putUser(principal.principal.userId, validated.value);
    context.log(`putUserProfile ${result.outcome} (requestCharge=${result.requestCharge} RU)`);
    switch (result.outcome) {
      case 'created':
        return jsonResponse(201, result.user, correlationId, result.requestCharge);
      case 'updated':
        return jsonResponse(200, result.user, correlationId, result.requestCharge);
      case 'concurrentUpdate':
        return jsonResponse(
          409,
          errorBody(
            'CONCURRENT_UPDATE',
            'The profile changed while this update was being applied. Read it again and retry.',
            context
          ),
          correlationId,
          result.requestCharge
        );
    }
  } catch (error) {
    return serverError(
      'putUserProfile',
      'Failed to save user profile',
      error,
      correlationId,
      context
    );
  }
}
