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
import { validateRecipeId, validateUpdateRecipe } from './recipe-requests';
import { defaultRecipesDeps, recipeNotFound, type RecipesHandlerDeps } from './recipes-http';

/**
 * HAR-36 (MG-82) — PATCH /recipes/{id}: change one of the caller's recipes.
 * Each field sent replaces the stored value whole; `updatedAt` is bumped. The
 * write is a replace conditioned on the ETag of the read (If-Match).
 *
 *   - 200: the updated Recipe;
 *   - 400 VALIDATION_ERROR: a bad body or a non-UUID id (no Cosmos call);
 *   - 404 RECIPE_NOT_FOUND;
 *   - 409 CONCURRENT_UPDATE: the recipe changed between the read and the write.
 */
export async function updateRecipeHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: RecipesHandlerDeps = defaultRecipesDeps
): Promise<HttpResponseInit> {
  context.log('Processing updateRecipe request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const recipeId = validateRecipeId(request.params['id']);
  if (!recipeId.ok) {
    return validationError(recipeId.message, correlationId, context);
  }
  const parsed = await readJsonBody(request);
  if (!parsed) {
    return validationError('Request body must be valid JSON', correlationId, context);
  }
  const validated = validateUpdateRecipe(parsed.body);
  if (!validated.ok) {
    return validationError(validated.message, correlationId, context);
  }

  try {
    const result = await deps
      .getRepository()
      .updateRecipe(principal.principal.userId, recipeId.value, validated.value);
    context.log(`updateRecipe ${result.outcome} (requestCharge=${result.requestCharge} RU)`);
    switch (result.outcome) {
      case 'updated':
        return jsonResponse(200, result.recipe, correlationId, result.requestCharge);
      case 'notFound':
        return recipeNotFound(correlationId, context, result.requestCharge);
      case 'concurrentUpdate':
        return jsonResponse(
          409,
          errorBody(
            'CONCURRENT_UPDATE',
            'The recipe changed while this update was being applied. Read it again and retry.',
            context
          ),
          correlationId,
          result.requestCharge
        );
    }
  } catch (error) {
    return serverError('updateRecipe', 'Failed to update recipe', error, correlationId, context);
  }
}
