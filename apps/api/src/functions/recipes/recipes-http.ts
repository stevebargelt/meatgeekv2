import type { HttpResponseInit, InvocationContext } from '@azure/functions';

import {
  principalFromRequest,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import {
  getRecipesRepository,
  type RecipesRepository,
} from '../../shared/cosmos/recipes-repository';
import { errorBody, jsonResponse } from '../devices/devices-http';

/**
 * HAR-36 (MG-82) — the injection seam the five recipes handlers share, and the
 * one response only they give. The other response helpers (JSON envelope,
 * validation 400, sanitized 500, request-charge header) are the devices ones,
 * so every Cosmos-backed route answers the same way.
 *
 * Identity comes only from the Easy Auth principal. No handler reads a `userId`
 * query parameter, an `x-user-id` header, or a body field for it.
 */

/** The repository surface the handlers use. */
export type RecipesRepositoryPort = Pick<
  RecipesRepository,
  'listRecipes' | 'createRecipe' | 'getRecipe' | 'updateRecipe' | 'deleteRecipe'
>;

/** Production wires Easy Auth and the adapter-backed repository; tests pass
 *  fakes. `getRepository` runs inside the invocation, so a missing setting fails
 *  that request (as a sanitized 500), not the module import. */
export interface RecipesHandlerDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getRepository(): RecipesRepositoryPort;
}

export const defaultRecipesDeps: RecipesHandlerDeps = {
  resolvePrincipal: principalFromRequest,
  getRepository: getRecipesRepository,
};

/** 404 RECIPE_NOT_FOUND: no such recipe in the caller's partition. Another
 *  user's recipe is in another partition, so it answers exactly the same. */
export function recipeNotFound(
  correlationId: string,
  context: InvocationContext,
  requestCharge: number
): HttpResponseInit {
  return jsonResponse(
    404,
    errorBody('RECIPE_NOT_FOUND', 'Recipe not found', context),
    correlationId,
    requestCharge
  );
}
