/**
 * HAR-36 (MG-82) — the recipes repository against a REAL Cosmos DB emulator.
 *
 * recipes.spec.ts and recipes-repository.spec.ts run on an in-memory fake. This
 * tier runs the unmodified RecipesRepository on the real `@azure/cosmos` SDK
 * against the emulator: create-not-upsert, point reads, replaces and deletes
 * keyed on `/userId`, a single-partition list query with ORDER BY and a
 * meatType filter, If-Match on replace, real request charges, and the system
 * properties the mapping must strip.
 *
 * Run it with `npx nx run api:test-emulator` (jest.emulator.config.ts). It is
 * excluded from `nx test api`. An unreachable emulator FAILS every case; it never
 * skips. See cooks-repository.emulator.spec.ts and docs/development/ci-cd.md.
 *
 * The recipes container is created with the partition key and indexing policy's
 * composite indexes read from the Terraform module
 * (`azurerm_cosmosdb_sql_container.recipes_shared`), so the emulator container
 * cannot drift from the deployed one.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CosmosClient, type CompositePath, type Container } from '@azure/cosmos';
import type { TokenCredential } from '@azure/core-auth';
import type { Recipe } from '@meatgeekv2/api-interfaces';

import { CosmosAdapter } from './cosmos-adapter';
import {
  closeEmulatorTier,
  createEmulatorContainer,
  EMULATOR_TIER_DATABASE,
  emulatorTierDatabase,
} from './emulator-tier.testing';
import { RecipesRepository } from './recipes-repository';

const EMULATOR_ENDPOINT = process.env['COSMOS_EMULATOR_ENDPOINT'] ?? 'https://localhost:8081';

/** The Cosmos emulator's documented, public, fixed account key. Test tier only. */
const EMULATOR_KEY =
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const COSMOS_MODULE_MAIN_TF = path.join(REPO_ROOT, 'apps/infrastructure/modules/cosmos-db/main.tf');

interface TerraformContainer {
  readonly name: string;
  readonly partitionKeyPath: string;
  readonly compositeIndexes: CompositePath[][];
}

/** The recipes container's name, partition key and composite indexes, from Terraform. */
function terraformContainer(resourceName: string): TerraformContainer {
  const source = fs.readFileSync(COSMOS_MODULE_MAIN_TF, 'utf8');
  const start = source.indexOf(`resource "azurerm_cosmosdb_sql_container" "${resourceName}"`);
  if (start === -1) {
    throw new Error(`${resourceName} container not found in ${COSMOS_MODULE_MAIN_TF}`);
  }
  const block = source.slice(start, source.indexOf('\n}', start));
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
  const partitionKeyPath = /^\s*partition_key_paths\s*=\s*\[\s*"([^"]+)"\s*\]/m.exec(block)?.[1];
  if (!name || !partitionKeyPath) {
    throw new Error(`${resourceName} is missing name or a single partition_key_paths`);
  }
  const compositeIndexes = block
    .split(/composite_index\s*\{/)
    .slice(1)
    .map(chunk =>
      [...chunk.matchAll(/path\s*=\s*"([^"]+)"\s*order\s*=\s*"(ascending|descending)"/g)].map(
        match => ({ path: match[1], order: match[2] as CompositePath['order'] })
      )
    );
  return { name, partitionKeyPath, compositeIndexes };
}

const unusedCredential: TokenCredential = {
  getToken: async () => {
    throw new Error('the emulator tier authenticates with the emulator key, not a token');
  },
};

function describeError(error: unknown): string {
  const { name, message, code } = error as { name?: string; message?: string; code?: unknown };
  return [name, code, message].filter(part => part !== undefined && part !== '').join(': ');
}

/**
 * Readiness: await the emulator's own answer to a database-account read. There
 * is no deadline of its own, so a slow but healthy emulator passes; the only
 * hang guard is `testTimeout` in jest.emulator.config.ts.
 */
async function probeEmulator(client: CosmosClient): Promise<void> {
  try {
    await client.getDatabaseAccount();
  } catch (error) {
    throw new Error(
      `Cosmos emulator unreachable at ${EMULATOR_ENDPOINT} (${describeError(error)}). ` +
        'Start one and trust its certificate as described in docs/development/ci-cd.md ' +
        '(Cosmos emulator tier). This tier fails rather than skips.'
    );
  }
}

/** A principal-shaped userId, `"<tid>:<oid>"`, unique per case. */
function newUserId(): string {
  return `${randomUUID()}:${randomUUID()}`;
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

function expectPositiveCharge(requestCharge: number): void {
  expect(Number.isFinite(requestCharge)).toBe(true);
  expect(requestCharge).toBeGreaterThan(0);
}

/** A repository whose clock advances one second per stamp, so updatedAt order is certain. */
function steppedRepository(container: Container): RecipesRepository {
  let tick = Date.parse('2026-11-18T12:00:00.000Z');
  return new RecipesRepository(container, {
    now: () => new Date((tick += 1000)),
    newId: () => randomUUID(),
  });
}

describe('HAR-36 recipes repository against the Cosmos emulator', () => {
  const databaseName = EMULATOR_TIER_DATABASE;
  const tfRecipes = terraformContainer('recipes_shared');
  let client: CosmosClient;
  let container: Container;
  let repository: RecipesRepository;

  beforeAll(async () => {
    client = new CosmosClient({
      endpoint: EMULATOR_ENDPOINT,
      key: EMULATOR_KEY,
      connectionPolicy: { enableEndpointDiscovery: false },
    });
    await probeEmulator(client);

    const database = await emulatorTierDatabase(client);
    await createEmulatorContainer(database, {
      id: tfRecipes.name,
      partitionKey: { paths: [tfRecipes.partitionKeyPath] },
      indexingPolicy: {
        indexingMode: 'consistent',
        includedPaths: [{ path: '/*' }],
        compositeIndexes: tfRecipes.compositeIndexes,
      },
    });

    // Reach the container through the production seam, as the Function host does.
    const adapter = new CosmosAdapter(
      {
        accountEndpoint: EMULATOR_ENDPOINT,
        databaseName,
        cooksContainerName: 'unused-by-this-tier',
        devicesContainerName: 'unused-by-this-tier',
        temperaturesContainerName: 'unused-by-this-tier',
        usersContainerName: 'unused-by-this-tier',
        recipesContainerName: tfRecipes.name,
        temperatureRollupsContainerName: 'unused-by-this-tier',
      },
      {
        credentialFactory: () => unusedCredential,
        clientFactory: ({ endpoint }) => {
          expect(endpoint).toBe(EMULATOR_ENDPOINT);
          return client;
        },
      }
    );
    container = adapter.getRecipesContainer();
    repository = steppedRepository(container);
  });

  afterAll(() => {
    closeEmulatorTier(client);
  });

  it('creates the container with the Terraform partition key (/userId)', async () => {
    expect(tfRecipes.partitionKeyPath).toBe('/userId');
    expect(tfRecipes.compositeIndexes.length).toBeGreaterThan(0);
    const { resource } = await container.read();
    expect(resource?.partitionKey?.paths).toEqual(['/userId']);
  });

  it('create → list (filtered and ordered) → get → patch → delete → get is not found', async () => {
    const userId = newUserId();

    // create three, so the list has an order to check and a filter to apply
    const brisket = await repository.createRecipe(userId, {
      name: 'Brisket',
      meatType: 'beef',
      cookMethod: 'smoke',
      targetTemps: { grill: 225, probe1: 203 },
      estimatedDuration: 12,
      instructions: ['Trim', 'Rub', 'Smoke'],
      tags: ['bbq'],
    });
    const ribs = await repository.createRecipe(userId, { name: 'Ribs', meatType: 'pork' });
    const shoulder = await repository.createRecipe(userId, { name: 'Shoulder', meatType: 'pork' });
    for (const created of [brisket, ribs, shoulder]) {
      expectPositiveCharge(created.requestCharge);
      expect(underscoreKeys(created.recipe)).toEqual([]);
      expect(created.recipe.userId).toBe(userId);
      expect(created.recipe.createdAt).toBe(created.recipe.updatedAt);
    }
    expect(brisket.recipe).toMatchObject({
      name: 'Brisket',
      targetTemps: { grill: 225, probe1: 203 },
      instructions: ['Trim', 'Rub', 'Smoke'],
    });

    // The stored document really does carry system properties.
    const raw = await container.item(brisket.recipe.id, userId).read<Record<string, unknown>>();
    expect(underscoreKeys(raw.resource)).toEqual(
      expect.arrayContaining(['._rid', '._etag', '._ts'])
    );

    // list: newest updatedAt first
    const all = await repository.listRecipes(userId);
    expect(all.recipes.map(r => r.name)).toEqual(['Shoulder', 'Ribs', 'Brisket']);
    expect(underscoreKeys(all.recipes)).toEqual([]);
    expectPositiveCharge(all.requestCharge);

    // list: meatType filter, still newest first
    const pork = await repository.listRecipes(userId, { meatType: 'pork' });
    expect(pork.recipes.map(r => r.name)).toEqual(['Shoulder', 'Ribs']);
    const fish = await repository.listRecipes(userId, { meatType: 'fish' });
    expect(fish.recipes).toEqual([]);

    // get
    const read = await repository.getRecipe(userId, brisket.recipe.id);
    expect(read).toEqual({
      outcome: 'found',
      recipe: brisket.recipe,
      requestCharge: expect.any(Number),
    });
    expectPositiveCharge(read.requestCharge);
    expect(read.outcome === 'found' && underscoreKeys(read.recipe)).toEqual([]);

    // patch: description changes, updatedAt moves, createdAt stays, and the
    // patched recipe becomes the newest
    const patched = await repository.updateRecipe(userId, brisket.recipe.id, {
      description: 'Low and slow',
    });
    expect(patched.outcome).toBe('updated');
    if (patched.outcome !== 'updated') return;
    expect(patched.recipe).toEqual({
      ...brisket.recipe,
      description: 'Low and slow',
      updatedAt: expect.any(String),
    });
    expect(patched.recipe.updatedAt > brisket.recipe.updatedAt).toBe(true);
    expect(underscoreKeys(patched.recipe)).toEqual([]);
    expectPositiveCharge(patched.requestCharge);
    const reordered = await repository.listRecipes(userId);
    expect(reordered.recipes.map(r => r.name)).toEqual(['Brisket', 'Shoulder', 'Ribs']);

    // delete, then get is not found and the list no longer has it
    const deleted = await repository.deleteRecipe(userId, brisket.recipe.id);
    expect(deleted.outcome).toBe('deleted');
    expectPositiveCharge(deleted.requestCharge);
    const gone = await repository.getRecipe(userId, brisket.recipe.id);
    expect(gone.outcome).toBe('notFound');
    expectPositiveCharge(gone.requestCharge);
    const again = await repository.deleteRecipe(userId, brisket.recipe.id);
    expect(again.outcome).toBe('notFound');
    const after = await repository.listRecipes(userId);
    expect(after.recipes.map(r => r.name)).toEqual(['Shoulder', 'Ribs']);
  });

  it('a second user never sees, reads, patches or deletes the first user’s recipes', async () => {
    const owner = newUserId();
    const stranger = newUserId();
    const mine = await repository.createRecipe(owner, { name: 'Mine', meatType: 'chicken' });
    await repository.createRecipe(stranger, { name: 'Theirs', meatType: 'chicken' });

    const ownerList = await repository.listRecipes(owner);
    expect(ownerList.recipes.map(r => r.name)).toEqual(['Mine']);
    const strangerList = await repository.listRecipes(stranger, { meatType: 'chicken' });
    expect(strangerList.recipes.map(r => r.name)).toEqual(['Theirs']);

    expect((await repository.getRecipe(stranger, mine.recipe.id)).outcome).toBe('notFound');
    expect(
      (await repository.updateRecipe(stranger, mine.recipe.id, { name: 'Hijacked' })).outcome
    ).toBe('notFound');
    expect((await repository.deleteRecipe(stranger, mine.recipe.id)).outcome).toBe('notFound');

    const stillMine = await repository.getRecipe(owner, mine.recipe.id);
    expect(stillMine.outcome === 'found' && stillMine.recipe).toEqual(mine.recipe);
  });

  it('a stale ETag is CONCURRENT_UPDATE (concurrentUpdate) under real If-Match', async () => {
    const userId = newUserId();
    const created = await repository.createRecipe(userId, { name: 'Original', meatType: 'other' });
    const id = created.recipe.id;

    // A replace between the repository's read and its write.
    let interfered = false;
    const racing = new Proxy(container, {
      get(target, property, receiver) {
        if (property !== 'item') return Reflect.get(target, property, receiver);
        return (itemId: string, partitionKey: string) => {
          const item = target.item(itemId, partitionKey);
          return new Proxy(item, {
            get(itemTarget, itemProperty, itemReceiver) {
              if (itemProperty !== 'replace' || interfered) {
                const value = Reflect.get(itemTarget, itemProperty, itemReceiver);
                return typeof value === 'function' ? value.bind(itemTarget) : value;
              }
              return async (...args: Parameters<typeof item.replace>) => {
                interfered = true;
                const { resource } = await target.item(itemId, partitionKey).read<Recipe>();
                await target
                  .item(itemId, partitionKey)
                  .replace({ ...(resource as Recipe), name: 'Racer' });
                return itemTarget.replace(...args);
              };
            },
          });
        };
      },
    });

    const result = await steppedRepository(racing).updateRecipe(userId, id, { name: 'Loser' });

    expect(interfered).toBe(true);
    expect(result.outcome).toBe('concurrentUpdate');
    expectPositiveCharge(result.requestCharge);
    const stored = await repository.getRecipe(userId, id);
    expect(stored.outcome === 'found' && stored.recipe.name).toBe('Racer');
  });
});
