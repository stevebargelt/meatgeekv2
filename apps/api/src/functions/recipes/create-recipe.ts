import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';

import { unauthenticatedResponse } from '../../shared/auth/principal';
import {
  correlationIdOf,
  jsonResponse,
  readJsonBody,
  serverError,
  validationError,
} from '../devices/devices-http';
import { validateCreateRecipe } from './recipe-requests';
import { defaultRecipesDeps, type RecipesHandlerDeps } from './recipes-http';

/**
 * HAR-36 (MG-82) — POST /recipes: create a recipe owned by the caller.
 *
 * The server sets `id` (a new UUID), `userId` (the principal) and
 * `createdAt`/`updatedAt`; a body carrying any of them is a 400. Because the id
 * is server-generated there is no idempotent replay: every successful POST
 * creates a new recipe.
 *
 *   - 201: the stored Recipe;
 *   - 400 VALIDATION_ERROR: a bad body (no Cosmos call).
 */
export async function createRecipeHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: RecipesHandlerDeps = defaultRecipesDeps
): Promise<HttpResponseInit> {
  context.log('Processing createRecipe request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const parsed = await readJsonBody(request);
  if (!parsed) {
    return validationError('Request body must be valid JSON', correlationId, context);
  }
  const validated = validateCreateRecipe(parsed.body);
  if (!validated.ok) {
    return validationError(validated.message, correlationId, context);
  }

  try {
    const { recipe, requestCharge } = await deps
      .getRepository()
      .createRecipe(principal.principal.userId, validated.value);
    context.log(`createRecipe created (requestCharge=${requestCharge} RU)`);
    return jsonResponse(201, recipe, correlationId, requestCharge);
  } catch (error) {
    return serverError('createRecipe', 'Failed to create recipe', error, correlationId, context);
  }
}
