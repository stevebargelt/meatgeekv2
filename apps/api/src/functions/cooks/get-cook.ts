import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import {
  principalFromRequest,
  unauthenticatedResponse,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import { getCooksRepository, type CooksRepository } from '../../shared/cosmos/cooks-repository';
import {
  correlationIdOf,
  errorBody,
  jsonResponse,
  serverError,
  validationError,
} from '../devices/devices-http';

/**
 * HAR-75 — GET /cooks/{cookId}: one of the caller's cooks, as a bare Cook.
 *
 * One point read of `(userId, cookId)` in the cooks container, which is
 * partitioned on `/userId`. A cook owned by someone else lives in their
 * partition and is invisible here, so "absent" and "another user's" are the
 * same 404 NOT_FOUND by construction: no device-ownership read is needed and
 * the answer does not reveal that a foreign cook exists. The MG-84 device lock
 * (`active-device:<deviceId>`) shares the partition but is not a cook; the
 * repository treats it as a miss, so it is 404 too.
 *
 *   - 401 without a usable Easy Auth principal (no Cosmos call);
 *   - 400 VALIDATION_ERROR when `cookId` is not 1-128 characters (no Cosmos
 *     call);
 *   - 404 NOT_FOUND as above, with the read's RU charge;
 *   - 200 with the Cook, projected through the allow-listed `toCook`, so no
 *     Cosmos system property reaches the body.
 *
 * Every response carries `X-Request-ID` (the caller's, else the invocation id),
 * and every response that reached Cosmos carries `x-meatgeek-request-charge`.
 */

export const COOK_ID_MAX_LENGTH = 128;

/** Injection seam. Production wires Easy Auth and the adapter-backed
 *  repository; tests pass fakes. */
export interface GetCookDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getRepository(): Pick<CooksRepository, 'getCook'>;
}

const defaultDeps: GetCookDeps = {
  resolvePrincipal: principalFromRequest,
  getRepository: getCooksRepository,
};

export async function getCookHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: GetCookDeps = defaultDeps
): Promise<HttpResponseInit> {
  context.log('Processing getCook request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const cookId = request.params['cookId'] ?? '';
  if (cookId.length === 0 || cookId.length > COOK_ID_MAX_LENGTH) {
    return validationError(
      `cookId must be 1-${COOK_ID_MAX_LENGTH} characters`,
      correlationId,
      context
    );
  }

  try {
    const { cook, requestCharge } = await deps
      .getRepository()
      .getCook(principal.principal.userId, cookId);
    context.log(`getCook ${cook ? 'found' : 'not found'} (requestCharge=${requestCharge} RU)`);
    if (!cook) {
      return jsonResponse(
        404,
        errorBody('NOT_FOUND', 'Cook not found', context),
        correlationId,
        requestCharge
      );
    }
    return jsonResponse(200, cook, correlationId, requestCharge);
  } catch (error) {
    return serverError('getCook', 'Failed to retrieve cook', error, correlationId, context);
  }
}
