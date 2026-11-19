/**
 * HAR-36 (MG-82) — the five recipes handlers, with NO Azure and NO credentials.
 *
 * Each handler runs over the REAL RecipesRepository on an in-memory container
 * that partitions on `/userId` and stamps Cosmos system properties on every
 * document, so the no-underscore-keys and wrong-partition assertions test the
 * actual mapping and partition keys. Principals are real base64
 * X-MS-CLIENT-PRINCIPAL headers read by the real principal.ts.
 */
import * as fs from 'fs';
import * as path from 'path';

import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Recipe } from '@meatgeekv2/api-interfaces';

import { principalFromRequest } from '../../shared/auth/principal';
import { CosmosConfigError } from '../../shared/cosmos/cosmos-adapter';
import {
  DELETE_CHARGE,
  FAKE_ACCOUNT_ENDPOINT,
  FakeRecipesContainer,
  QUERY_CHARGE,
  READ_CHARGE,
  WRITE_CHARGE,
} from '../../shared/cosmos/fake-recipes-container.testing';
import { RecipesRepository } from '../../shared/cosmos/recipes-repository';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import { createRecipeHandler } from './create-recipe';
import { deleteRecipeHandler } from './delete-recipe';
import { getRecipeHandler } from './get-recipe';
import { listRecipesHandler } from './list-recipes';
import type { RecipesHandlerDeps } from './recipes-http';
import { updateRecipeHandler } from './update-recipe';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const OTHER_OID = 'oid-zzzz-9999';
const USER_ID = `${TID}:${OID}`;
const OTHER_USER_ID = `${TID}:${OTHER_OID}`;
const RECIPE_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '22222222-2222-4222-8222-222222222222';
const CREATED_AT = '2026-11-01T10:00:00.000Z';
const NOW = '2026-11-18T12:00:00.000Z';

function encodedPrincipal(oid: string, tid = TID): string {
  const payload = {
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
      { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: tid },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

interface RequestOptions {
  principal?: string | null;
  params?: Record<string, string>;
  query?: Record<string, string>;
  headers?: Record<string, string>;
  body?: unknown;
  rawBody?: string;
}

function request(options: RequestOptions = {}): HttpRequest {
  const headers = new Map<string, string>(
    Object.entries(options.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v])
  );
  const principal = options.principal === undefined ? encodedPrincipal(OID) : options.principal;
  if (principal !== null) {
    headers.set('x-ms-client-principal', principal);
  }
  const query = new Map(Object.entries(options.query ?? {}));
  return {
    json: async () => {
      if (options.rawBody !== undefined) {
        return JSON.parse(options.rawBody);
      }
      return options.body;
    },
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: { get: (k: string) => query.get(k) ?? null },
    params: options.params ?? {},
  } as unknown as HttpRequest;
}

function context() {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx = {
    invocationId: 'inv-36',
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
  } as unknown as InvocationContext;
  return { ctx, logs, errors };
}

function setup() {
  const fake = new FakeRecipesContainer();
  const getRepository = jest.fn(
    () =>
      new RecipesRepository(fake.asContainer(), {
        now: () => new Date(NOW),
        newId: () => NEW_ID,
      })
  );
  const deps: RecipesHandlerDeps = { resolvePrincipal: principalFromRequest, getRepository };
  return { fake, deps, getRepository };
}

function recipe(overrides: Partial<Recipe> = {}): Recipe {
  return {
    id: RECIPE_ID,
    userId: USER_ID,
    name: 'Texas brisket',
    description: 'Low and slow',
    meatType: 'beef',
    cookMethod: 'smoke',
    targetTemps: { grill: 225, probe1: 203 },
    estimatedDuration: 12,
    instructions: ['Trim', 'Rub', 'Smoke'],
    tags: ['bbq'],
    createdAt: CREATED_AT,
    updatedAt: CREATED_AT,
    ...overrides,
  };
}

/** Every key, at any depth, that starts with `_`. */
function underscoreKeys(value: unknown, at = ''): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, i) => underscoreKeys(item, `${at}[${i}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, member]) => [
      ...(key.startsWith('_') ? [`${at}.${key}`] : []),
      ...underscoreKeys(member, `${at}.${key}`),
    ]);
  }
  return [];
}

function header(response: HttpResponseInit, name: string): string | undefined {
  return (response.headers as Record<string, string> | undefined)?.[name];
}

type Handler = (
  request: HttpRequest,
  context: InvocationContext,
  deps: RecipesHandlerDeps
) => Promise<HttpResponseInit>;

/** One valid, successful-path request per route, for the shared cases below. */
const ROUTES: Array<{
  name: string;
  handler: Handler;
  request: () => RequestOptions;
  status: number;
}> = [
  { name: 'GET /recipes', handler: listRecipesHandler, request: () => ({}), status: 200 },
  {
    name: 'POST /recipes',
    handler: createRecipeHandler,
    request: () => ({ body: { name: 'Pulled pork', meatType: 'pork' } }),
    status: 201,
  },
  {
    name: 'GET /recipes/{id}',
    handler: getRecipeHandler,
    request: () => ({ params: { id: RECIPE_ID } }),
    status: 200,
  },
  {
    name: 'PATCH /recipes/{id}',
    handler: updateRecipeHandler,
    request: () => ({ params: { id: RECIPE_ID }, body: { description: 'Changed' } }),
    status: 200,
  },
  {
    name: 'DELETE /recipes/{id}',
    handler: deleteRecipeHandler,
    request: () => ({ params: { id: RECIPE_ID } }),
    status: 204,
  },
];

describe('HAR-36 recipes routes — shared contract', () => {
  describe.each(ROUTES)('$name', ({ handler, request: valid, status }) => {
    it('answers 401 without a principal and never reaches the repository', async () => {
      const { fake, deps, getRepository } = setup();
      const { ctx } = context();

      const response = await handler(request({ ...valid(), principal: null }), ctx, deps);

      expect(response.status).toBe(401);
      expect(response.jsonBody).toMatchObject({
        error: 'UNAUTHENTICATED',
        reason: 'principal_header_missing',
      });
      expect(getRepository).not.toHaveBeenCalled();
      expect(fake.calls).toEqual([]);
      expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
    });

    it('answers 401 for an unparseable principal and never reaches the repository', async () => {
      const { fake, deps, getRepository } = setup();
      const { ctx } = context();

      const response = await handler(request({ ...valid(), principal: '%%%' }), ctx, deps);

      expect(response.status).toBe(401);
      expect(getRepository).not.toHaveBeenCalled();
      expect(fake.calls).toEqual([]);
    });

    it('answers a sanitized 500 when the recipes container setting is missing (CosmosConfigError)', async () => {
      const { deps } = setup();
      deps.getRepository = () => {
        throw new CosmosConfigError('COSMOSDB_RECIPES_CONTAINER_NAME');
      };
      const { ctx, errors } = context();

      const response = await handler(request(valid()), ctx, deps);

      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        error: 'INTERNAL_SERVER_ERROR',
        message: expect.stringMatching(/^Failed to /),
        requestId: 'inv-36',
      });
      expect(JSON.stringify(response.jsonBody)).not.toContain('COSMOSDB');
      expect(errors.join('\n')).toContain('cosmos_recipes_container_not_configured');
      expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
    });

    it('answers a sanitized 500 with the RU on a Cosmos failure, leaking no endpoint or claim', async () => {
      const { fake, deps } = setup();
      fake.seed(recipe());
      for (const operation of ['read', 'query', 'create', 'replace', 'delete'] as const) {
        fake.failNext(operation, 503);
      }
      const { ctx, errors, logs } = context();

      const response = await handler(request(valid()), ctx, deps);

      expect(response.status).toBe(500);
      expect(response.jsonBody).toEqual({
        error: 'INTERNAL_SERVER_ERROR',
        message: expect.stringMatching(/^Failed to /),
        requestId: 'inv-36',
      });
      expect(Number(header(response, REQUEST_CHARGE_HEADER))).toBeGreaterThan(0);
      const everything = [JSON.stringify(response), ...errors, ...logs].join('\n');
      for (const secret of [FAKE_ACCOUNT_ENDPOINT, 'documents.azure.com', OID, TID]) {
        expect(everything).not.toContain(secret);
      }
      expect(errors.join('\n')).toContain('cosmos_status_503');
    });

    it('succeeds with no key starting with `_` and carries the request-charge header', async () => {
      const { fake, deps } = setup();
      fake.seed(recipe());
      const { ctx } = context();

      const response = await handler(request(valid()), ctx, deps);

      expect(response.status).toBe(status);
      expect(underscoreKeys(response.jsonBody)).toEqual([]);
      expect(Number(header(response, REQUEST_CHARGE_HEADER))).toBeGreaterThan(0);
    });

    it('wrong partition: every Cosmos call uses the caller principal as the partition key', async () => {
      const { fake, deps } = setup();
      fake.seed(recipe());
      fake.seed(recipe({ userId: OTHER_USER_ID }));
      const { ctx } = context();

      await handler(request({ ...valid(), principal: encodedPrincipal(OTHER_OID) }), ctx, deps);

      expect(fake.calls.length).toBeGreaterThan(0);
      for (const call of fake.calls) {
        expect(call.partitionKey).toBe(OTHER_USER_ID);
      }
      // ...and the first user's recipe is untouched.
      expect(fake.stored(USER_ID, RECIPE_ID)).toMatchObject({
        name: 'Texas brisket',
        description: 'Low and slow',
      });
    });
  });

  describe.each(ROUTES.filter(route => route.name.includes('{id}')))(
    '$name',
    ({ handler, request: valid }) => {
      it('answers 400 VALIDATION_ERROR for a non-UUID id with no Cosmos call', async () => {
        const { fake, deps, getRepository } = setup();
        const { ctx } = context();

        const response = await handler(
          request({ ...valid(), params: { id: 'not-a-uuid' } }),
          ctx,
          deps
        );

        expect(response.status).toBe(400);
        expect(response.jsonBody).toMatchObject({
          error: 'VALIDATION_ERROR',
          message: 'id must be a UUID',
        });
        expect(getRepository).not.toHaveBeenCalled();
        expect(fake.calls).toEqual([]);
        expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
      });

      it('answers 404 RECIPE_NOT_FOUND, with the RU, for an unknown recipe', async () => {
        const { deps } = setup();
        const { ctx } = context();

        const response = await handler(request(valid()), ctx, deps);

        expect(response.status).toBe(404);
        expect(response.jsonBody).toEqual({
          error: 'RECIPE_NOT_FOUND',
          message: 'Recipe not found',
          requestId: 'inv-36',
        });
        expect(Number(header(response, REQUEST_CHARGE_HEADER))).toBeGreaterThan(0);
      });

      it('answers the same 404 for another user’s recipe (no existence leak)', async () => {
        const { fake, deps } = setup();
        fake.seed(recipe({ userId: OTHER_USER_ID }));
        const { ctx } = context();

        const response = await handler(request(valid()), ctx, deps);

        expect(response.status).toBe(404);
        expect((response.jsonBody as { error: string }).error).toBe('RECIPE_NOT_FOUND');
        expect(fake.stored(OTHER_USER_ID, RECIPE_ID)).toMatchObject({ name: 'Texas brisket' });
      });
    }
  );
});

describe('GET /recipes', () => {
  it('returns 200 { recipes } for the caller only, newest updatedAt first', async () => {
    const { fake, deps } = setup();
    fake.seed(recipe({ id: 'a', name: 'Older', updatedAt: '2026-01-01T00:00:00.000Z' }));
    fake.seed(recipe({ id: 'b', name: 'Newer', updatedAt: '2026-06-01T00:00:00.000Z' }));
    fake.seed(recipe({ id: 'c', userId: OTHER_USER_ID, name: 'Not mine' }));
    const { ctx } = context();

    const response = await listRecipesHandler(request(), ctx, deps);

    expect(response.status).toBe(200);
    const { recipes } = response.jsonBody as { recipes: Recipe[] };
    expect(recipes.map(r => r.name)).toEqual(['Newer', 'Older']);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(QUERY_CHARGE));
    expect(fake.calls).toHaveLength(1);
  });

  it('filters by meatType', async () => {
    const { fake, deps } = setup();
    fake.seed(recipe({ id: 'a', meatType: 'beef' }));
    fake.seed(recipe({ id: 'b', meatType: 'chicken' }));
    const { ctx } = context();

    const response = await listRecipesHandler(
      request({ query: { meatType: 'chicken' } }),
      ctx,
      deps
    );

    expect((response.jsonBody as { recipes: Recipe[] }).recipes.map(r => r.id)).toEqual(['b']);
  });

  it.each(['lamb', '', 'BEEF'])(
    'answers 400 VALIDATION_ERROR for meatType=%j with no Cosmos call',
    async meatType => {
      const { fake, deps, getRepository } = setup();
      const { ctx } = context();

      const response = await listRecipesHandler(request({ query: { meatType } }), ctx, deps);

      expect(response.status).toBe(400);
      expect((response.jsonBody as { error: string }).error).toBe('VALIDATION_ERROR');
      expect(getRepository).not.toHaveBeenCalled();
      expect(fake.calls).toEqual([]);
    }
  );

  it('takes identity only from the principal: ?userId= and x-user-id for another user are ignored', async () => {
    const { fake, deps } = setup();
    fake.seed(recipe({ userId: OTHER_USER_ID }));
    const { ctx } = context();

    const response = await listRecipesHandler(
      request({ query: { userId: OTHER_USER_ID }, headers: { 'x-user-id': OTHER_USER_ID } }),
      ctx,
      deps
    );

    expect((response.jsonBody as { recipes: Recipe[] }).recipes).toEqual([]);
    expect(fake.calls[0].partitionKey).toBe(USER_ID);
  });

  it('returns an empty list for a caller with no recipes', async () => {
    const { deps } = setup();
    const { ctx } = context();

    const response = await listRecipesHandler(request(), ctx, deps);

    expect(response.jsonBody).toEqual({ recipes: [] });
  });
});

describe('POST /recipes', () => {
  it('creates the recipe for the principal and returns 201 with the Recipe', async () => {
    const { fake, deps } = setup();
    const { ctx } = context();
    const body = {
      name: '  Smoked salmon  ',
      meatType: 'fish',
      description: 'Cold smoke',
      cookMethod: 'smoke',
      targetTemps: { grill: 175.5, probe1: 140 },
      estimatedDuration: 2.5,
      instructions: [' Brine ', 'Dry', 'Smoke'],
      tags: ['seafood'],
    };

    const response = await createRecipeHandler(request({ body }), ctx, deps);

    expect(response.status).toBe(201);
    expect(response.jsonBody).toEqual({
      ...body,
      name: 'Smoked salmon',
      instructions: ['Brine', 'Dry', 'Smoke'],
      id: NEW_ID,
      userId: USER_ID,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(WRITE_CHARGE));
    expect(fake.calls).toEqual([{ operation: 'create', id: NEW_ID, partitionKey: USER_ID }]);
  });

  it('accepts the two required fields alone', async () => {
    const { deps } = setup();
    const { ctx } = context();

    const response = await createRecipeHandler(
      request({ body: { name: 'Wings', meatType: 'chicken' } }),
      ctx,
      deps
    );

    expect(response.status).toBe(201);
    expect(Object.keys(response.jsonBody as object).sort()).toEqual([
      'createdAt',
      'id',
      'meatType',
      'name',
      'updatedAt',
      'userId',
    ]);
  });

  it.each([
    ['missing name', { meatType: 'beef' }, 'name is required'],
    ['blank name', { name: '   ', meatType: 'beef' }, 'name must be 1-200 non-blank characters'],
    ['a 201-character name', { name: 'x'.repeat(201), meatType: 'beef' }, 'name must be 1-200'],
    ['missing meatType', { name: 'Ribs' }, 'meatType is required'],
    ['bad meatType', { name: 'Ribs', meatType: 'lamb' }, 'meatType must be one of'],
    [
      'bad cookMethod',
      { name: 'Ribs', meatType: 'pork', cookMethod: 'fry' },
      'cookMethod must be one of',
    ],
    [
      'an unknown field',
      { name: 'Ribs', meatType: 'pork', rating: 5 },
      'rating is not a recipe field',
    ],
    [
      'isPublic',
      { name: 'Ribs', meatType: 'pork', isPublic: true },
      'isPublic is not a recipe field',
    ],
    ['a body id', { id: RECIPE_ID, name: 'Ribs', meatType: 'pork' }, 'id must not be sent'],
    [
      'a body userId',
      { userId: OTHER_USER_ID, name: 'Ribs', meatType: 'pork' },
      'userId must not be sent',
    ],
    [
      'a body createdAt',
      { createdAt: NOW, name: 'Ribs', meatType: 'pork' },
      'createdAt must not be sent',
    ],
    [
      'a body updatedAt',
      { updatedAt: NOW, name: 'Ribs', meatType: 'pork' },
      'updatedAt must not be sent',
    ],
    [
      'a 2001-character description',
      { name: 'R', meatType: 'pork', description: 'x'.repeat(2001) },
      'description must be at most 2000',
    ],
    [
      'a zero estimatedDuration',
      { name: 'R', meatType: 'pork', estimatedDuration: 0 },
      'estimatedDuration must be',
    ],
    [
      'a string estimatedDuration',
      { name: 'R', meatType: 'pork', estimatedDuration: '3' },
      'estimatedDuration must be',
    ],
    [
      'instructions not an array',
      { name: 'R', meatType: 'pork', instructions: 'Smoke it' },
      'instructions must be an array',
    ],
    [
      'a blank instruction',
      { name: 'R', meatType: 'pork', instructions: ['ok', ' '] },
      'each of instructions',
    ],
    [
      'too many tags',
      { name: 'R', meatType: 'pork', tags: Array.from({ length: 21 }, (_, i) => `t${i}`) },
      'tags must be an array of at most 20',
    ],
    [
      'an unknown probe',
      { name: 'R', meatType: 'pork', targetTemps: { probe5: 200 } },
      'targetTemps.probe5 is not a probe',
    ],
    [
      'an out-of-range target',
      { name: 'R', meatType: 'pork', targetTemps: { grill: 1001 } },
      'targetTemps.grill must be a number',
    ],
    ['an array body', [], 'Request body must be a JSON object'],
  ])('answers 400 VALIDATION_ERROR for %s with no Cosmos call', async (_case, body, message) => {
    const { fake, deps, getRepository } = setup();
    const { ctx } = context();

    const response = await createRecipeHandler(request({ body }), ctx, deps);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toMatchObject({ error: 'VALIDATION_ERROR' });
    expect((response.jsonBody as { message: string }).message).toContain(message);
    expect(getRepository).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
  });

  it('answers 400 for malformed JSON with no Cosmos call', async () => {
    const { fake, deps } = setup();
    const { ctx } = context();

    const response = await createRecipeHandler(request({ rawBody: '{nope' }), ctx, deps);

    expect(response.status).toBe(400);
    expect(fake.calls).toEqual([]);
  });
});

describe('GET /recipes/{id}', () => {
  it('returns 200 with the caller’s Recipe from one point read', async () => {
    const { fake, deps } = setup();
    fake.seed(recipe());
    const { ctx } = context();

    const response = await getRecipeHandler(request({ params: { id: RECIPE_ID } }), ctx, deps);

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(recipe());
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(fake.calls).toEqual([{ operation: 'read', id: RECIPE_ID, partitionKey: USER_ID }]);
  });
});

describe('PATCH /recipes/{id}', () => {
  it('replaces the sent fields, bumps updatedAt, and returns 200 with the Recipe', async () => {
    const { fake, deps } = setup();
    fake.seed(recipe());
    const { ctx } = context();

    const response = await updateRecipeHandler(
      request({
        params: { id: RECIPE_ID },
        body: { description: 'Hotter and faster', targetTemps: { grill: 275 }, tags: [] },
      }),
      ctx,
      deps
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(
      recipe({
        description: 'Hotter and faster',
        targetTemps: { grill: 275 },
        tags: [],
        updatedAt: NOW,
      })
    );
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE + WRITE_CHARGE));
    expect(underscoreKeys(response.jsonBody)).toEqual([]);
  });

  it('answers 409 CONCURRENT_UPDATE, with the RU, on a 412', async () => {
    const { fake, deps } = setup();
    fake.seed(recipe());
    fake.beforeReplace = () => fake.touch(USER_ID, RECIPE_ID);
    const { ctx } = context();

    const response = await updateRecipeHandler(
      request({ params: { id: RECIPE_ID }, body: { name: 'Late' } }),
      ctx,
      deps
    );

    expect(response.status).toBe(409);
    expect(response.jsonBody).toMatchObject({ error: 'CONCURRENT_UPDATE', requestId: 'inv-36' });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE + WRITE_CHARGE));
  });

  it.each([
    ['an empty patch', {}, 'Send at least one of'],
    ['a bad meatType', { meatType: 'lamb' }, 'meatType must be one of'],
    ['an unknown field', { cookCount: 3 }, 'cookCount is not a recipe field'],
    ['a body userId', { userId: OTHER_USER_ID }, 'userId must not be sent'],
    ['a blank name', { name: '' }, 'name must be 1-200'],
    ['a null field', { description: null }, 'description must be a string'],
  ])('answers 400 VALIDATION_ERROR for %s with no Cosmos call', async (_case, body, message) => {
    const { fake, deps, getRepository } = setup();
    fake.seed(recipe());
    const { ctx } = context();

    const response = await updateRecipeHandler(
      request({ params: { id: RECIPE_ID }, body }),
      ctx,
      deps
    );

    expect(response.status).toBe(400);
    expect((response.jsonBody as { message: string }).message).toContain(message);
    expect(getRepository).not.toHaveBeenCalled();
    expect(fake.calls).toEqual([]);
  });
});

describe('DELETE /recipes/{id}', () => {
  it('answers 204 with no body and the delete RU, and the recipe is gone', async () => {
    const { fake, deps } = setup();
    fake.seed(recipe());
    const { ctx } = context();

    const response = await deleteRecipeHandler(request({ params: { id: RECIPE_ID } }), ctx, deps);

    expect(response.status).toBe(204);
    expect(response.jsonBody).toBeUndefined();
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(DELETE_CHARGE));
    expect(fake.stored(USER_ID, RECIPE_ID)).toBeUndefined();
  });
});

describe('source guards', () => {
  const DIR = __dirname;
  const sources = fs
    .readdirSync(DIR)
    .filter(file => file.endsWith('.ts') && !file.endsWith('.spec.ts'))
    .map(file => fs.readFileSync(path.join(DIR, file), 'utf8'));

  it('reads no identity from the query string or an x-user-id header', () => {
    for (const source of sources) {
      expect(source).not.toMatch(/query\.get\(\s*['"]userId['"]/);
      expect(source).not.toMatch(/headers\.get\(\s*['"]x-user-id/i);
    }
  });

  it('uses the Recipe contract from @meatgeekv2/api-interfaces with no local re-declaration', () => {
    for (const source of sources) {
      expect(source).not.toMatch(/\binterface\s+Recipe\b/);
    }
  });
});
