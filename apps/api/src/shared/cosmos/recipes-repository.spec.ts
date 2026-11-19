/**
 * HAR-36 (MG-82) — the recipes repository against an in-memory container, no
 * Azure and no credentials. The real-Cosmos behaviour is exercised by
 * recipes-repository.emulator.spec.ts.
 */
import type { Recipe } from '@meatgeekv2/api-interfaces';

import {
  DELETE_CHARGE,
  FakeRecipesContainer,
  QUERY_CHARGE,
  READ_CHARGE,
  WRITE_CHARGE,
} from './fake-recipes-container.testing';
import { RecipesRepository, RecipesStoreError, toRecipe } from './recipes-repository';

const OWNER = 'tid-1:oid-owner';
const STRANGER = 'tid-1:oid-stranger';
const RECIPE_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-11-01T10:00:00.000Z';
const NOW = '2026-11-18T12:00:00.000Z';

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: RECIPE_ID,
    userId: OWNER,
    name: 'Texas brisket',
    meatType: 'beef',
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

function setup() {
  const fake = new FakeRecipesContainer();
  const repository = new RecipesRepository(fake.asContainer(), {
    now: () => new Date(NOW),
    newId: () => NEW_ID,
  });
  return { fake, repository };
}

function systemKeys(value: object | undefined): string[] {
  return Object.keys(value ?? {}).filter(key => key.startsWith('_'));
}

async function caught(promise: Promise<unknown>): Promise<RecipesStoreError> {
  try {
    await promise;
  } catch (error) {
    return error as RecipesStoreError;
  }
  throw new Error('expected a rejection');
}

describe('toRecipe', () => {
  it('keeps only Recipe fields and drops Cosmos system properties and unmodelled fields', () => {
    const full = recipe({
      description: 'Low and slow',
      cookMethod: 'smoke',
      targetTemps: { grill: 225, probe1: 203 },
      estimatedDuration: 12,
      instructions: ['Trim', 'Rub', 'Smoke'],
      tags: ['bbq'],
    });
    const stored = {
      ...full,
      _rid: 'r',
      _self: 's',
      _etag: '"e"',
      _attachments: 'a',
      _ts: 1,
      isPublic: true,
      rating: 5,
    };
    expect(toRecipe(stored as unknown as Recipe)).toEqual(full);
  });
});

describe('RecipesRepository.createRecipe', () => {
  it('writes a new document in the owner partition with a server id and timestamps', async () => {
    const { fake, repository } = setup();

    const created = await repository.createRecipe(OWNER, {
      name: 'Pulled pork',
      meatType: 'pork',
      tags: ['party'],
    });

    expect(created.recipe).toEqual({
      id: NEW_ID,
      userId: OWNER,
      name: 'Pulled pork',
      meatType: 'pork',
      tags: ['party'],
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(systemKeys(created.recipe)).toEqual([]);
    expect(created.requestCharge).toBe(WRITE_CHARGE);
    expect(fake.calls).toEqual([{ operation: 'create', id: NEW_ID, partitionKey: OWNER }]);
    expect(fake.stored(OWNER, NEW_ID)).toMatchObject({ userId: OWNER, name: 'Pulled pork' });
  });

  it('generates a fresh UUID per recipe by default', async () => {
    const fake = new FakeRecipesContainer();
    const repository = new RecipesRepository(fake.asContainer());

    const first = await repository.createRecipe(OWNER, { name: 'A', meatType: 'fish' });
    const second = await repository.createRecipe(OWNER, { name: 'B', meatType: 'fish' });

    expect(first.recipe.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(second.recipe.id).not.toBe(first.recipe.id);
  });

  it('throws a RecipesStoreError with the status and RU, no Cosmos text, when create fails', async () => {
    const { fake, repository } = setup();
    fake.failNext('create', 503);

    const error = await caught(repository.createRecipe(OWNER, { name: 'X', meatType: 'other' }));

    expect(error).toBeInstanceOf(RecipesStoreError);
    expect(error.statusCode).toBe(503);
    expect(error.requestCharge).toBe(WRITE_CHARGE);
    expect(error.message).not.toContain('documents.azure.com');
  });
});

describe('RecipesRepository.listRecipes', () => {
  it('runs ONE single-partition query for the caller, newest updatedAt first', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe({ id: 'a', name: 'Old', updatedAt: '2026-01-01T00:00:00.000Z' }));
    fake.seed(recipe({ id: 'b', name: 'New', updatedAt: '2026-06-01T00:00:00.000Z' }));
    fake.seed(recipe({ id: 'c', userId: STRANGER, name: 'Not mine' }));

    const list = await repository.listRecipes(OWNER);

    expect(list.recipes.map(r => r.name)).toEqual(['New', 'Old']);
    expect(list.requestCharge).toBe(QUERY_CHARGE);
    expect(fake.calls).toHaveLength(1);
    expect(fake.calls[0]).toMatchObject({
      operation: 'query',
      partitionKey: OWNER,
      parameters: [{ name: '@userId', value: OWNER }],
    });
    expect(fake.calls[0].query).toMatch(/ORDER BY c\.updatedAt DESC/);
    for (const listed of list.recipes) {
      expect(systemKeys(listed)).toEqual([]);
    }
  });

  it('narrows to one meatType with a query parameter', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe({ id: 'a', meatType: 'beef' }));
    fake.seed(recipe({ id: 'b', meatType: 'pork' }));

    const list = await repository.listRecipes(OWNER, { meatType: 'pork' });

    expect(list.recipes.map(r => r.id)).toEqual(['b']);
    expect(fake.calls[0].query).toMatch(/c\.meatType = @meatType/);
    expect(fake.calls[0].parameters).toEqual([
      { name: '@userId', value: OWNER },
      { name: '@meatType', value: 'pork' },
    ]);
  });

  it('breaks updatedAt ties by id so the order is total', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe({ id: 'z' }));
    fake.seed(recipe({ id: 'm' }));

    const list = await repository.listRecipes(OWNER);

    expect(list.recipes.map(r => r.id)).toEqual(['m', 'z']);
  });

  it('throws a RecipesStoreError carrying the query RU when the query fails', async () => {
    const { fake, repository } = setup();
    fake.failNext('query', 429);

    const error = await caught(repository.listRecipes(OWNER));

    expect(error).toBeInstanceOf(RecipesStoreError);
    expect(error.statusCode).toBe(429);
    expect(error.requestCharge).toBe(QUERY_CHARGE);
  });
});

describe('RecipesRepository.getRecipe', () => {
  it('point-reads in the caller partition and maps the document', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe());

    const result = await repository.getRecipe(OWNER, RECIPE_ID);

    expect(result).toEqual({ outcome: 'found', recipe: recipe(), requestCharge: READ_CHARGE });
    expect(fake.calls).toEqual([{ operation: 'read', id: RECIPE_ID, partitionKey: OWNER }]);
  });

  it('wrong partition: user B asking for user A’s id reads only B’s partition and finds nothing', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe());

    const result = await repository.getRecipe(STRANGER, RECIPE_ID);

    expect(result).toEqual({ outcome: 'notFound', requestCharge: READ_CHARGE });
    expect(fake.calls).toEqual([{ operation: 'read', id: RECIPE_ID, partitionKey: STRANGER }]);
  });

  it('a non-UUID id is not found with no Cosmos call', async () => {
    const { fake, repository } = setup();

    expect(await repository.getRecipe(OWNER, 'not-a-uuid')).toEqual({
      outcome: 'notFound',
      requestCharge: 0,
    });
    expect(fake.calls).toEqual([]);
  });

  it('throws a RecipesStoreError with the read RU when the read fails', async () => {
    const { fake, repository } = setup();
    fake.failNext('read', 500);

    const error = await caught(repository.getRecipe(OWNER, RECIPE_ID));

    expect(error).toBeInstanceOf(RecipesStoreError);
    expect(error.statusCode).toBe(500);
    expect(error.requestCharge).toBe(READ_CHARGE);
  });
});

describe('RecipesRepository.updateRecipe', () => {
  it('replaces the sent fields, keeps id/userId/createdAt, bumps updatedAt, under If-Match', async () => {
    const { fake, repository } = setup();
    fake.seed({ ...recipe({ targetTemps: { grill: 250, probe1: 195 } }), legacy: 'kept' });
    const etag = fake.stored(OWNER, RECIPE_ID)?.['_etag'];

    const result = await repository.updateRecipe(OWNER, RECIPE_ID, {
      description: 'Now with a description',
      targetTemps: { grill: 225 },
    });

    expect(result).toEqual({
      outcome: 'updated',
      recipe: recipe({
        description: 'Now with a description',
        targetTemps: { grill: 225 },
        updatedAt: NOW,
      }),
      requestCharge: READ_CHARGE + WRITE_CHARGE,
    });
    expect(fake.calls.map(call => [call.operation, call.partitionKey])).toEqual([
      ['read', OWNER],
      ['replace', OWNER],
    ]);
    expect(fake.calls[1].ifMatch).toBe(etag);
    // Unmodelled stored fields survive the replace but are never returned.
    expect(fake.stored(OWNER, RECIPE_ID)?.['legacy']).toBe('kept');
    expect(result.outcome === 'updated' && systemKeys(result.recipe)).toEqual([]);
  });

  it('wrong partition: user B cannot change user A’s recipe', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe());

    const result = await repository.updateRecipe(STRANGER, RECIPE_ID, { name: 'Hijacked' });

    expect(result).toEqual({ outcome: 'notFound', requestCharge: READ_CHARGE });
    expect(fake.calls).toEqual([{ operation: 'read', id: RECIPE_ID, partitionKey: STRANGER }]);
    expect(fake.stored(OWNER, RECIPE_ID)?.['name']).toBe('Texas brisket');
  });

  it('is concurrentUpdate, with both charges, when the ETag went stale (412)', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe());
    fake.beforeReplace = () => fake.touch(OWNER, RECIPE_ID);

    const result = await repository.updateRecipe(OWNER, RECIPE_ID, { name: 'Late' });

    expect(result).toEqual({
      outcome: 'concurrentUpdate',
      requestCharge: READ_CHARGE + WRITE_CHARGE,
    });
  });

  it('is notFound when the recipe is deleted between the read and the replace', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe());
    fake.beforeReplace = () => fake.remove(OWNER, RECIPE_ID);

    const result = await repository.updateRecipe(OWNER, RECIPE_ID, { name: 'Gone' });

    expect(result).toEqual({ outcome: 'notFound', requestCharge: READ_CHARGE + WRITE_CHARGE });
  });

  it('throws a RecipesStoreError with the read and replace RU when the replace fails', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe());
    fake.failNext('replace', 503);

    const error = await caught(repository.updateRecipe(OWNER, RECIPE_ID, { name: 'X' }));

    expect(error).toBeInstanceOf(RecipesStoreError);
    expect(error.statusCode).toBe(503);
    expect(error.requestCharge).toBe(READ_CHARGE + WRITE_CHARGE);
  });
});

describe('RecipesRepository.deleteRecipe', () => {
  it('point-deletes in the caller partition', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe());

    const result = await repository.deleteRecipe(OWNER, RECIPE_ID);

    expect(result).toEqual({ outcome: 'deleted', requestCharge: DELETE_CHARGE });
    expect(fake.calls).toEqual([{ operation: 'delete', id: RECIPE_ID, partitionKey: OWNER }]);
    expect(fake.stored(OWNER, RECIPE_ID)).toBeUndefined();
  });

  it('wrong partition: user B cannot delete user A’s recipe', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe());

    const result = await repository.deleteRecipe(STRANGER, RECIPE_ID);

    expect(result).toEqual({ outcome: 'notFound', requestCharge: DELETE_CHARGE });
    expect(fake.calls).toEqual([{ operation: 'delete', id: RECIPE_ID, partitionKey: STRANGER }]);
    expect(fake.stored(OWNER, RECIPE_ID)).toBeDefined();
  });

  it('a non-UUID id is not found with no Cosmos call', async () => {
    const { fake, repository } = setup();

    expect(await repository.deleteRecipe(OWNER, '../etc')).toEqual({
      outcome: 'notFound',
      requestCharge: 0,
    });
    expect(fake.calls).toEqual([]);
  });

  it('throws a RecipesStoreError with the delete RU when the delete fails', async () => {
    const { fake, repository } = setup();
    fake.seed(recipe());
    fake.failNext('delete', 503);

    const error = await caught(repository.deleteRecipe(OWNER, RECIPE_ID));

    expect(error).toBeInstanceOf(RecipesStoreError);
    expect(error.statusCode).toBe(503);
    expect(error.requestCharge).toBe(DELETE_CHARGE);
  });
});
