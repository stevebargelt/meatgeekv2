import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import { requestChargeHeaders } from '../../shared/cosmos/request-charge';
import { correlationIdOf, serverError, validationError } from '../devices/devices-http';
import { validateRecipeId } from './recipe-requests';
import { defaultRecipesDeps, recipeNotFound, type RecipesHandlerDeps } from './recipes-http';

/**
 * HAR-36 (MG-82) — DELETE /recipes/{id}: delete one of the caller's recipes.
 * One point delete in the caller's partition.
 *
 *   - 204: deleted (no body);
 *   - 400 VALIDATION_ERROR: the id is not a UUID (no Cosmos call);
 *   - 404 RECIPE_NOT_FOUND.
 */
export async function deleteRecipeHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: RecipesHandlerDeps = defaultRecipesDeps
): Promise<HttpResponseInit> {
  context.log('Processing deleteRecipe request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const recipeId = validateRecipeId(request.params['id']);
  if (!recipeId.ok) {
    return validationError(recipeId.message, correlationId, context);
  }

  try {
    const result = await deps
      .getRepository()
      .deleteRecipe(principal.principal.userId, recipeId.value);
    context.log(`deleteRecipe ${result.outcome} (requestCharge=${result.requestCharge} RU)`);
    if (result.outcome === 'notFound') {
      return recipeNotFound(correlationId, context, result.requestCharge);
    }
    return {
      status: 204,
      headers: {
        'X-Request-ID': correlationId,
        ...requestChargeHeaders(result.requestCharge),
      },
    };
  } catch (error) {
    return serverError('deleteRecipe', 'Failed to delete recipe', error, correlationId, context);
  }
}
