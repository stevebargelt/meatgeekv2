import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import {
  correlationIdOf,
  jsonResponse,
  serverError,
  validationError,
} from '../devices/devices-http';
import { validateRecipeId } from './recipe-requests';
import { defaultRecipesDeps, recipeNotFound, type RecipesHandlerDeps } from './recipes-http';

/**
 * HAR-36 (MG-82) — GET /recipes/{id}: one of the caller's recipes, as a bare
 * Recipe. One point read `item(id, userId)`. Another user's recipe is in
 * another partition, so it is a plain 404 RECIPE_NOT_FOUND.
 *
 *   - 200: the Recipe;
 *   - 400 VALIDATION_ERROR: the id is not a UUID (no Cosmos call);
 *   - 404 RECIPE_NOT_FOUND.
 */
export async function getRecipeHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: RecipesHandlerDeps = defaultRecipesDeps
): Promise<HttpResponseInit> {
  context.log('Processing getRecipe request');
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
    const result = await deps.getRepository().getRecipe(principal.principal.userId, recipeId.value);
    context.log(`getRecipe ${result.outcome} (requestCharge=${result.requestCharge} RU)`);
    if (result.outcome === 'notFound') {
      return recipeNotFound(correlationId, context, result.requestCharge);
    }
    return jsonResponse(200, result.recipe, correlationId, result.requestCharge);
  } catch (error) {
    return serverError('getRecipe', 'Failed to retrieve recipe', error, correlationId, context);
  }
}
