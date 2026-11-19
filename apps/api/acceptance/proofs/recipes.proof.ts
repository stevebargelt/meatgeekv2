import type { CreateRecipeRequest, Recipe } from '@meatgeekv2/api-interfaces';

import { expectErrorCode, expectNoSystemProperties } from '../lib/checks';
import type { AcceptanceApi, AcceptanceResponse } from '../lib/proof';
import { defineProofs } from '../lib/proof';

/**
 * HAR-36 (MG-82) — a recipe created through the deployed API is a real Cosmos
 * document owned by the authenticated caller, through its whole life:
 *
 *   1. POST creates it (201, server-generated id, owner = the caller);
 *   2. GET by id reads it back;
 *   3. the caller's list includes it;
 *   4. PATCH changes its description;
 *   5. GET by id shows the change;
 *   6. DELETE removes it (204);
 *   7. GET by id is then 404 RECIPE_NOT_FOUND.
 *
 * Every response is checked for Cosmos system properties, and every step
 * reaches Cosmos, so every response must report its request charge (the
 * runner's default), the 204 and the 404 included.
 *
 * The recipe's name is run-unique, and step 6 deletes it, so a green run leaves
 * nothing behind. If an earlier step fails, the runner skips the rest of the
 * group and that run's one recipe stays in the acceptance identity's partition.
 */

const MEAT_TYPES = ['beef', 'pork', 'chicken', 'fish', 'vegetarian', 'other'];

/** Fail unless `value` is shaped like an api-interfaces Recipe. */
function expectRecipe(api: AcceptanceApi, response: AcceptanceResponse, value: unknown): Recipe {
  api.check(response, value !== null && typeof value === 'object', 'body is not a JSON object');
  const recipe = value as Record<string, unknown>;
  for (const field of ['id', 'userId', 'name', 'createdAt', 'updatedAt']) {
    api.check(response, typeof recipe[field] === 'string', `recipe.${field} is not a string`);
  }
  api.check(
    response,
    MEAT_TYPES.includes(recipe['meatType'] as string),
    `recipe.meatType ${JSON.stringify(recipe['meatType'])} is not valid`
  );
  return recipe as unknown as Recipe;
}

export default defineProofs('recipes', () => {
  let created: Recipe | undefined;
  let sent: CreateRecipeRequest | undefined;

  const createdRecipe = (): Recipe => {
    if (!created) {
      throw new Error('no recipe was created by an earlier proof');
    }
    return created;
  };

  const getById = async (api: AcceptanceApi, id: string) => {
    const response = await api.request<Recipe>({
      method: 'GET',
      path: `/recipes/${encodeURIComponent(id)}`,
      route: '/recipes/{id}',
    });
    expectNoSystemProperties(api, response);
    return response;
  };

  const patchedDescription = (api: AcceptanceApi) => `Patched ${api.runId}`;

  return [
    {
      name: 'POST /recipes creates a recipe owned by the caller',
      async run(api: AcceptanceApi) {
        sent = {
          name: `Acceptance recipe ${api.runId}`,
          meatType: 'pork',
          description: 'Created by the live acceptance run',
          cookMethod: 'smoke',
          targetTemps: { grill: 225, probe1: 203 },
          estimatedDuration: 10,
          instructions: ['Rub', 'Smoke', 'Rest'],
          tags: ['acceptance'],
        };
        const response = await api.request({ method: 'POST', path: '/recipes', body: sent });
        api.expectStatus(response, 201);
        expectNoSystemProperties(api, response);
        const recipe = expectRecipe(api, response, response.body);
        api.check(response, recipe.name === sent.name, 'recipe.name is not the name sent');
        api.check(response, recipe.meatType === 'pork', 'recipe.meatType is not the value sent');
        api.check(
          response,
          /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(recipe.id),
          `recipe.id ${recipe.id} is not a server-generated UUID`
        );
        api.check(
          response,
          recipe.createdAt === recipe.updatedAt,
          'a new recipe has createdAt !== updatedAt'
        );
        created = recipe;
      },
    },
    {
      name: 'GET /recipes/{id} reads the recipe back',
      async run(api: AcceptanceApi) {
        const { id, name, userId } = createdRecipe();
        const response = await getById(api, id);
        api.expectStatus(response, 200);
        const recipe = expectRecipe(api, response, response.body);
        api.check(response, recipe.id === id, `recipe.id ${recipe.id} is not ${id}`);
        api.check(response, recipe.name === name, 'recipe.name does not match');
        api.check(response, recipe.userId === userId, 'recipe.userId is not the creating caller');
        api.check(
          response,
          JSON.stringify(recipe.instructions) === JSON.stringify(sent?.instructions),
          'recipe.instructions do not match'
        );
      },
    },
    {
      name: 'GET /recipes includes the recipe',
      async run(api: AcceptanceApi) {
        const { id, userId } = createdRecipe();
        const response = await api.request<{ recipes: unknown[] }>({
          method: 'GET',
          path: '/recipes',
        });
        api.expectStatus(response, 200);
        expectNoSystemProperties(api, response);
        api.check(response, Array.isArray(response.body?.recipes), 'body.recipes is not an array');
        const recipes = response.body.recipes.map(item => expectRecipe(api, response, item));
        api.check(
          response,
          recipes.some(recipe => recipe.id === id),
          `recipe ${id} is not in the list`
        );
        api.check(
          response,
          recipes.every(recipe => recipe.userId === userId),
          'the list holds a recipe owned by someone else'
        );
      },
    },
    {
      name: 'PATCH /recipes/{id} changes the description',
      async run(api: AcceptanceApi) {
        const { id, createdAt } = createdRecipe();
        const description = patchedDescription(api);
        const response = await api.request({
          method: 'PATCH',
          path: `/recipes/${encodeURIComponent(id)}`,
          route: '/recipes/{id}',
          body: { description },
        });
        api.expectStatus(response, 200);
        expectNoSystemProperties(api, response);
        const recipe = expectRecipe(api, response, response.body);
        api.check(
          response,
          recipe.description === description,
          `recipe.description is ${recipe.description}`
        );
        api.check(response, recipe.createdAt === createdAt, 'PATCH changed createdAt');
        api.check(response, recipe.updatedAt >= createdAt, 'PATCH did not move updatedAt forward');
      },
    },
    {
      name: 'GET /recipes/{id} reads the patched description back',
      async run(api: AcceptanceApi) {
        const { id, name } = createdRecipe();
        const response = await getById(api, id);
        api.expectStatus(response, 200);
        const recipe = expectRecipe(api, response, response.body);
        api.check(
          response,
          recipe.description === patchedDescription(api),
          `recipe.description is ${recipe.description}, not the patched value`
        );
        api.check(response, recipe.name === name, 'PATCH changed recipe.name');
      },
    },
    {
      name: 'DELETE /recipes/{id} deletes the recipe',
      async run(api: AcceptanceApi) {
        const { id } = createdRecipe();
        const response = await api.request({
          method: 'DELETE',
          path: `/recipes/${encodeURIComponent(id)}`,
          route: '/recipes/{id}',
        });
        api.expectStatus(response, 204);
      },
    },
    {
      name: 'GET /recipes/{id} is 404 RECIPE_NOT_FOUND after the delete',
      async run(api: AcceptanceApi) {
        const { id } = createdRecipe();
        const response = await getById(api, id);
        api.expectStatus(response, 404);
        expectErrorCode(api, response, 'RECIPE_NOT_FOUND');
      },
    },
  ];
});
