import type { TargetTemperatures } from './cook';

/**
 * HAR-36 (MG-82) — a recipe, private to its owner. Stored in the `recipes`
 * container, partitioned on `/userId`.
 */

/** The kinds of meat a recipe is for. */
export type RecipeMeatType = 'beef' | 'pork' | 'chicken' | 'fish' | 'vegetarian' | 'other';

/** How a recipe cooks. */
export type RecipeCookMethod = 'smoke' | 'grill' | 'roast' | 'braise';

export interface Recipe {
  /** Server-generated UUID. */
  id: string;
  /** Owner: the authenticated principal, `"<tid>:<oid>"`. Never taken from a body. */
  userId: string;
  /** 1–200 characters. */
  name: string;
  /** At most 2000 characters. */
  description?: string;
  meatType: RecipeMeatType;
  cookMethod?: RecipeCookMethod;
  targetTemps?: TargetTemperatures;
  /** Hours, greater than 0. */
  estimatedDuration?: number;
  instructions?: string[];
  tags?: string[];
  /** ISO-8601, server-stamped on create. */
  createdAt: string;
  /** ISO-8601, server-stamped on create and on every update. */
  updatedAt: string;
}

/** Body for POST /recipes. Unknown fields are rejected. */
export interface CreateRecipeRequest {
  name: string;
  meatType: RecipeMeatType;
  description?: string;
  cookMethod?: RecipeCookMethod;
  targetTemps?: TargetTemperatures;
  estimatedDuration?: number;
  instructions?: string[];
  tags?: string[];
}

/** Body for PATCH /recipes/{id}: any of the create fields, at least one. */
export type UpdateRecipeRequest = Partial<CreateRecipeRequest>;

/** Response for GET /recipes. */
export interface RecipeListResponse {
  recipes: Recipe[];
}
