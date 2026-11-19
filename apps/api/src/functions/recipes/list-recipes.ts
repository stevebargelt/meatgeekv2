import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import {
  correlationIdOf,
  jsonResponse,
  serverError,
  validationError,
} from '../devices/devices-http';
import { validateMeatTypeFilter } from './recipe-requests';
import { defaultRecipesDeps, type RecipesHandlerDeps } from './recipes-http';

/**
 * HAR-36 (MG-82) — GET /recipes: the caller's recipes, newest `updatedAt`
 * first. `200 { recipes: Recipe[] }`.
 *
 * One single-partition query (partition key = the principal's userId). An
 * optional `meatType` query parameter narrows the list; an unknown value is a
 * 400 with no Cosmos call. A `userId` query parameter or `x-user-id` header is
 * ignored.
 */
export async function listRecipesHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: RecipesHandlerDeps = defaultRecipesDeps
): Promise<HttpResponseInit> {
  context.log('Processing listRecipes request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const meatType = validateMeatTypeFilter(request.query.get('meatType'));
  if (!meatType.ok) {
    return validationError(meatType.message, correlationId, context);
  }

  try {
    const { recipes, requestCharge } = await deps
      .getRepository()
      .listRecipes(principal.principal.userId, { meatType: meatType.value });
    context.log(`listRecipes returned ${recipes.length} (requestCharge=${requestCharge} RU)`);
    return jsonResponse(200, { recipes }, correlationId, requestCharge);
  } catch (error) {
    return serverError('listRecipes', 'Failed to retrieve recipes', error, correlationId, context);
  }
}
