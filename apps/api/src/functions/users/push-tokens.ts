import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import {
  principalFromRequest,
  unauthenticatedResponse,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import {
  getPushTokensRepository,
  PUSH_TOKEN_ID_PATTERN,
  PUSH_TOKEN_PATTERN,
  type PushTokensRepository,
} from '../../shared/cosmos/push-tokens-repository';
import { requestChargeHeaders } from '../../shared/cosmos/request-charge';
import {
  correlationIdOf,
  jsonResponse,
  readJsonBody,
  serverError,
  validationError,
} from '../devices/devices-http';

/**
 * #244 — the signed-in user's phones: the APNs device tokens their alerts go
 * to (spec #237, "Phone tokens").
 *
 *   - GET    /users/me/push-tokens            the registered tokens' ids and times;
 *   - POST   /users/me/push-tokens            registers `{ token }`: 201, or 200 if
 *                                             it was already registered;
 *   - DELETE /users/me/push-tokens/{tokenId}  removes one: 204, also when absent.
 *
 * A token is a delivery address. It travels only in a request body, is never
 * returned, never put in a URL and never logged; outside the store it is known
 * by its id, the SHA-256 of the token in hex. Identity is the Easy Auth
 * principal only.
 */

export type PushTokensPort = Pick<PushTokensRepository, 'listSummaries' | 'register' | 'remove'>;

export interface PushTokensHandlerDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getRepository(): PushTokensPort;
}

export const defaultPushTokensDeps: PushTokensHandlerDeps = {
  resolvePrincipal: principalFromRequest,
  getRepository: getPushTokensRepository,
};

export async function listPushTokensHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: PushTokensHandlerDeps = defaultPushTokensDeps
): Promise<HttpResponseInit> {
  context.log('Processing listPushTokens request');
  const correlationId = correlationIdOf(request, context);
  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }
  try {
    const { tokens, requestCharge } = await deps
      .getRepository()
      .listSummaries(principal.principal.userId);
    context.log(`listPushTokens count=${tokens.length} (requestCharge=${requestCharge} RU)`);
    return jsonResponse(200, { items: tokens }, correlationId, requestCharge);
  } catch (error) {
    return serverError(
      'listPushTokens',
      'Failed to list push tokens',
      error,
      correlationId,
      context
    );
  }
}

export async function registerPushTokenHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: PushTokensHandlerDeps = defaultPushTokensDeps
): Promise<HttpResponseInit> {
  context.log('Processing registerPushToken request');
  const correlationId = correlationIdOf(request, context);
  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const parsed = await readJsonBody(request);
  if (!parsed) {
    return validationError('The body must be JSON.', correlationId, context);
  }
  const body = parsed.body;
  if (body === null || typeof body !== 'object' || Array.isArray(body)) {
    return validationError('The body must be an object with a token.', correlationId, context);
  }
  const unknown = Object.keys(body).filter(key => key !== 'token');
  if (unknown.length > 0) {
    // Field names only: a caller's own key is never echoed.
    return validationError('The body may carry token only.', correlationId, context);
  }
  const token = (body as { token?: unknown }).token;
  if (typeof token !== 'string' || !PUSH_TOKEN_PATTERN.test(token)) {
    return validationError(
      'token must be an APNs device token: 64 to 200 hexadecimal characters.',
      correlationId,
      context
    );
  }

  try {
    const result = await deps.getRepository().register(principal.principal.userId, token);
    context.log(
      `registerPushToken ${result.created ? 'created' : 'refreshed'} (requestCharge=${result.requestCharge} RU)`
    );
    return jsonResponse(
      result.created ? 201 : 200,
      result.token,
      correlationId,
      result.requestCharge
    );
  } catch (error) {
    return serverError(
      'registerPushToken',
      'Failed to register the push token',
      error,
      correlationId,
      context
    );
  }
}

export async function deletePushTokenHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: PushTokensHandlerDeps = defaultPushTokensDeps
): Promise<HttpResponseInit> {
  context.log('Processing deletePushToken request');
  const correlationId = correlationIdOf(request, context);
  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }
  const tokenId = request.params?.['tokenId'];
  if (typeof tokenId !== 'string' || !PUSH_TOKEN_ID_PATTERN.test(tokenId)) {
    return validationError(
      'tokenId must be the SHA-256 of the token: 64 lowercase hexadecimal characters.',
      correlationId,
      context
    );
  }
  try {
    const result = await deps.getRepository().remove(principal.principal.userId, tokenId);
    context.log(
      `deletePushToken ${result.removed ? 'removed' : 'absent'} (requestCharge=${result.requestCharge} RU)`
    );
    return {
      status: 204,
      headers: {
        'X-Request-ID': correlationId,
        ...requestChargeHeaders(result.requestCharge),
      },
    };
  } catch (error) {
    return serverError(
      'deletePushToken',
      'Failed to delete the push token',
      error,
      correlationId,
      context
    );
  }
}
