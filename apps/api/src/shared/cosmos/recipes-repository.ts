import { randomUUID } from 'crypto';

import type { Container, ItemResponse, RequestOptions, SqlParameter } from '@azure/cosmos';
import type { CreateRecipeRequest, Recipe, RecipeMeatType } from '@meatgeekv2/api-interfaces';

import { getCosmosAdapter } from './cosmos-adapter';

/**
 * HAR-36 (MG-82) — the recipes data-access layer, built on the ONE shared Cosmos
 * adapter.
 *
 * PARTITIONING. The deployed recipes container is partitioned on `/userId`
 * (apps/infrastructure/modules/cosmos-db/main.tf,
 * `azurerm_cosmosdb_sql_container.recipes_shared`), and a recipe's `userId` is
 * the authenticated principal, `"<tid>:<oid>"`. So every operation here is
 * scoped to the caller's own logical partition:
 *
 *   - get, replace and delete are POINT operations `item(id, userId)`;
 *   - the list is ONE single-partition query (`partitionKey: userId`).
 *
 * Another user's recipe lives in another partition, so it is simply not found:
 * there is no ownership check that could leak its existence.
 *
 * PRIVATE. Recipes are private to their owner. The container's composite indexes
 * on `isPublic` and `rating` are for a later sharing feature; nothing here reads
 * or writes those fields.
 *
 * Nothing here puts an account, database, container, credential, or identity
 * value into a thrown message or a log line. The RU charge it surfaces is a bare
 * number.
 */

/** A recipe id: a UUID, as the server generates. Anything else never reaches Cosmos. */
export const RECIPE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * The ONE place a stored recipes document becomes an api-interfaces
 * {@link Recipe}. An ALLOW-list, checked against `keyof Recipe` at compile time
 * in both directions, so Cosmos system properties (`_rid`, `_self`, `_etag`,
 * `_attachments`, `_ts`) and any unmodelled stored field never reach a caller.
 */
const RECIPE_FIELDS = [
  'id',
  'userId',
  'name',
  'description',
  'meatType',
  'cookMethod',
  'targetTemps',
  'estimatedDuration',
  'instructions',
  'tags',
  'createdAt',
  'updatedAt',
] as const satisfies readonly (keyof Recipe)[];

type UnmappedRecipeField = Exclude<keyof Recipe, (typeof RECIPE_FIELDS)[number]>;
/** Compile-time guard: fails if the Recipe contract gains a field not listed above. */
const recipeFieldsAreExhaustive: [UnmappedRecipeField] extends [never] ? true : never = true;
void recipeFieldsAreExhaustive;

/** A recipes document as Cosmos returns it: the Recipe fields plus system
 *  properties the static type cannot see. Never returned without {@link toRecipe}. */
type StoredRecipe = Recipe;

/** Projects a stored document onto the Recipe shape. Absent fields stay absent. */
export function toRecipe(document: StoredRecipe): Recipe {
  const source = document as unknown as Record<string, unknown>;
  const recipe: Record<string, unknown> = {};
  for (const field of RECIPE_FIELDS) {
    if (source[field] !== undefined) {
      recipe[field] = source[field];
    }
  }
  return recipe as unknown as Recipe;
}

/** The caller-supplied content of a recipe, after validation. */
export type RecipeContent = CreateRecipeRequest;

/** The fields PATCH may change, after validation. Each one present replaces the
 *  stored value whole (`targetTemps` included). */
export type RecipeUpdate = Partial<RecipeContent>;

/** Optional list filter. */
export interface RecipeListFilter {
  readonly meatType?: RecipeMeatType;
}

export interface RecipeList {
  readonly recipes: Recipe[];
  readonly requestCharge: number;
}

export interface CreatedRecipe {
  readonly recipe: Recipe;
  readonly requestCharge: number;
}

export type GetRecipeResult =
  | { readonly outcome: 'found'; readonly recipe: Recipe; readonly requestCharge: number }
  | { readonly outcome: 'notFound'; readonly requestCharge: number };

export type UpdateRecipeResult =
  | { readonly outcome: 'updated'; readonly recipe: Recipe; readonly requestCharge: number }
  | { readonly outcome: 'notFound'; readonly requestCharge: number }
  | { readonly outcome: 'concurrentUpdate'; readonly requestCharge: number };

export type DeleteRecipeResult =
  | { readonly outcome: 'deleted'; readonly requestCharge: number }
  | { readonly outcome: 'notFound'; readonly requestCharge: number };

/** Page size for the list query's internal paging (all pages are read). */
const LIST_PAGE_SIZE = 100;

/** The numeric status a Cosmos error carries. Nothing from its text is read. */
function statusCodeOf(error: unknown): number | undefined {
  const reported = error as { code?: unknown; statusCode?: unknown } | null | undefined;
  for (const value of [reported?.statusCode, reported?.code]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

/** The RU a thrown Cosmos error reported, or 0. */
function chargeOf(error: unknown): number {
  const charge = (error as { requestCharge?: unknown } | null | undefined)?.requestCharge;
  return typeof charge === 'number' && Number.isFinite(charge) ? charge : 0;
}

/**
 * A failed recipes operation, re-thrown with the RU spent by the whole operation
 * (the reads before it included) and the numeric status. It carries no Cosmos
 * error text.
 */
export class RecipesStoreError extends Error {
  constructor(
    readonly statusCode: number | undefined,
    readonly requestCharge: number
  ) {
    super('recipes store operation failed');
    this.name = 'RecipesStoreError';
  }
}

/** Clock and id seams, so tests can pin timestamps and ids. */
export interface RecipesRepositorySeams {
  readonly now: () => Date;
  readonly newId: () => string;
}

const DEFAULT_SEAMS: RecipesRepositorySeams = {
  now: () => new Date(),
  newId: () => randomUUID(),
};

/** Newest `updatedAt` first; `id` breaks ties so the order is total. */
function newestFirst(a: Recipe, b: Recipe): number {
  return b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id);
}

export class RecipesRepository {
  /**
   * @param container the recipes container from the shared adapter
   *   (`adapter.getRecipesContainer()`). Injected so unit tests run against a
   *   fake with no Azure and no credentials.
   */
  constructor(
    private readonly container: Container,
    private readonly seams: RecipesRepositorySeams = DEFAULT_SEAMS
  ) {}

  /**
   * Point-reads the raw stored document (system properties included) with its
   * ETag, in the caller's partition. A 404 is a miss, not a throw. An id that is
   * not a UUID is a miss without a read.
   */
  private async readDocument(
    userId: string,
    recipeId: string
  ): Promise<{ document: StoredRecipe | undefined; etag?: string; requestCharge: number }> {
    if (!RECIPE_ID_PATTERN.test(recipeId)) {
      return { document: undefined, requestCharge: 0 };
    }
    try {
      const response: ItemResponse<StoredRecipe> = await this.container
        .item(recipeId, userId)
        .read<StoredRecipe>();
      // The partition is the owner, so this always holds; checked anyway so a
      // stray document can never be served to the wrong caller.
      if (
        response.statusCode === 404 ||
        response.resource === undefined ||
        response.resource.userId !== userId
      ) {
        return { document: undefined, requestCharge: response.requestCharge };
      }
      return {
        document: response.resource,
        etag: response.etag,
        requestCharge: response.requestCharge,
      };
    } catch (error) {
      if (statusCodeOf(error) === 404) {
        return { document: undefined, requestCharge: chargeOf(error) };
      }
      throw new RecipesStoreError(statusCodeOf(error), chargeOf(error));
    }
  }

  /**
   * The caller's recipes, newest `updatedAt` first, optionally only one
   * `meatType`. One query, scoped to the caller's partition.
   */
  async listRecipes(userId: string, filter: RecipeListFilter = {}): Promise<RecipeList> {
    const parameters: SqlParameter[] = [{ name: '@userId', value: userId }];
    let query = 'SELECT * FROM c WHERE c.userId = @userId';
    if (filter.meatType !== undefined) {
      query += ' AND c.meatType = @meatType';
      parameters.push({ name: '@meatType', value: filter.meatType });
    }
    query += ' ORDER BY c.updatedAt DESC';

    try {
      const response = await this.container.items
        .query<StoredRecipe>(
          { query, parameters },
          { partitionKey: userId, maxItemCount: LIST_PAGE_SIZE }
        )
        .fetchAll();
      const recipes = response.resources.map(toRecipe).sort(newestFirst);
      return { recipes, requestCharge: response.requestCharge };
    } catch (error) {
      throw new RecipesStoreError(statusCodeOf(error), chargeOf(error));
    }
  }

  /**
   * Creates a recipe owned by `userId` with a new UUID and `createdAt` =
   * `updatedAt` = now. Cosmos `create`, never upsert.
   */
  async createRecipe(userId: string, content: RecipeContent): Promise<CreatedRecipe> {
    const now = this.seams.now().toISOString();
    const document: StoredRecipe = {
      ...content,
      id: this.seams.newId(),
      userId,
      createdAt: now,
      updatedAt: now,
    };
    try {
      const response = await this.container.items.create<StoredRecipe>(document);
      return {
        recipe: toRecipe(response.resource ?? document),
        requestCharge: response.requestCharge,
      };
    } catch (error) {
      throw new RecipesStoreError(statusCodeOf(error), chargeOf(error));
    }
  }

  /** One of the caller's recipes: a point read in the caller's partition. */
  async getRecipe(userId: string, recipeId: string): Promise<GetRecipeResult> {
    const { document, requestCharge } = await this.readDocument(userId, recipeId);
    if (!document) {
      return { outcome: 'notFound', requestCharge };
    }
    return { outcome: 'found', recipe: toRecipe(document), requestCharge };
  }

  /**
   * Applies `update` to one of the caller's recipes: point read, then a replace
   * conditioned on the ETag just read, with `updatedAt` = now. A 412 (someone
   * wrote in between) is `concurrentUpdate`; it is not retried. A 404 on the
   * replace (deleted in between) is `notFound`.
   */
  async updateRecipe(
    userId: string,
    recipeId: string,
    update: RecipeUpdate
  ): Promise<UpdateRecipeResult> {
    const existing = await this.readDocument(userId, recipeId);
    const stored = existing.document;
    if (!stored) {
      return { outcome: 'notFound', requestCharge: existing.requestCharge };
    }

    // Replace the WHOLE stored document so unmodelled stored fields survive; only
    // the value returned is projected to Recipe. id, userId and createdAt never
    // change.
    const next: StoredRecipe = {
      ...stored,
      ...update,
      id: stored.id,
      userId: stored.userId,
      createdAt: stored.createdAt,
      updatedAt: this.seams.now().toISOString(),
    };
    const options: RequestOptions | undefined = existing.etag
      ? { accessCondition: { type: 'IfMatch', condition: existing.etag } }
      : undefined;
    try {
      const response = await this.container
        .item(recipeId, userId)
        .replace<StoredRecipe>(next, options);
      return {
        outcome: 'updated',
        recipe: toRecipe(response.resource ?? next),
        requestCharge: existing.requestCharge + response.requestCharge,
      };
    } catch (error) {
      const status = statusCodeOf(error);
      const requestCharge = existing.requestCharge + chargeOf(error);
      if (status === 412) {
        return { outcome: 'concurrentUpdate', requestCharge };
      }
      if (status === 404) {
        return { outcome: 'notFound', requestCharge };
      }
      throw new RecipesStoreError(status, requestCharge);
    }
  }

  /** Deletes one of the caller's recipes: a point delete in the caller's partition. */
  async deleteRecipe(userId: string, recipeId: string): Promise<DeleteRecipeResult> {
    if (!RECIPE_ID_PATTERN.test(recipeId)) {
      return { outcome: 'notFound', requestCharge: 0 };
    }
    try {
      const response = await this.container.item(recipeId, userId).delete();
      return { outcome: 'deleted', requestCharge: response.requestCharge };
    } catch (error) {
      const status = statusCodeOf(error);
      if (status === 404) {
        return { outcome: 'notFound', requestCharge: chargeOf(error) };
      }
      throw new RecipesStoreError(status, chargeOf(error));
    }
  }
}

/** The repository wired to the shared adapter's recipes container. */
export function getRecipesRepository(): RecipesRepository {
  return new RecipesRepository(getCosmosAdapter().getRecipesContainer());
}
