/**
 * HAR-27 (MG-81) — the users repository against a REAL Cosmos DB emulator.
 *
 * users.spec.ts runs on an in-memory fake. This tier runs the unmodified
 * UsersRepository (and the DevicesRepository it reads `devices` from) on the real
 * `@azure/cosmos` SDK against the emulator: create-not-upsert, point reads keyed
 * on `/id` = the principal's userId, If-Match on replace, real request charges,
 * and the system properties the mapping must strip.
 *
 * Run it with `npx nx run api:test-emulator` (jest.emulator.config.ts). It is
 * excluded from `nx test api`. An unreachable emulator FAILS every case; it never
 * skips. See cooks-repository.emulator.spec.ts and docs/development/ci-cd.md.
 *
 * The users container is created with the partition key and unique key read from
 * the Terraform module (`azurerm_cosmosdb_sql_container.users_shared`), so the
 * emulator container cannot drift from the deployed one. The devices container
 * is created from `devices_shared` the same way.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CosmosClient, type Container } from '@azure/cosmos';
import type { TokenCredential } from '@azure/core-auth';

import { CosmosAdapter } from './cosmos-adapter';
import {
  createEmulatorContainer,
  EMULATOR_TIER_DATABASE,
  emulatorTierDatabase,
} from './emulator-tier.testing';
import { DevicesRepository } from './devices-repository';
import { DEFAULT_USER_PREFERENCES, UsersRepository } from './users-repository';

const EMULATOR_ENDPOINT = process.env['COSMOS_EMULATOR_ENDPOINT'] ?? 'https://localhost:8081';

/** The Cosmos emulator's documented, public, fixed account key. Test tier only. */
const EMULATOR_KEY =
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const COSMOS_MODULE_MAIN_TF = path.join(REPO_ROOT, 'apps/infrastructure/modules/cosmos-db/main.tf');

interface TerraformContainer {
  readonly name: string;
  readonly partitionKeyPath: string;
  readonly uniqueKeyPaths: string[];
}

/** A container's name, partition key and unique key, from Terraform. */
function terraformContainer(resourceName: string): TerraformContainer {
  const source = fs.readFileSync(COSMOS_MODULE_MAIN_TF, 'utf8');
  const start = source.indexOf(`resource "azurerm_cosmosdb_sql_container" "${resourceName}"`);
  if (start === -1) {
    throw new Error(`${resourceName} container not found in ${COSMOS_MODULE_MAIN_TF}`);
  }
  const block = source.slice(start, source.indexOf('\n}', start));
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
  const partitionKeyPath = /^\s*partition_key_paths\s*=\s*\[\s*"([^"]+)"\s*\]/m.exec(block)?.[1];
  const uniqueBlock = /unique_key\s*\{\s*paths\s*=\s*\[([^\]]*)\]/m.exec(block)?.[1];
  const uniqueKeyPaths = [...(uniqueBlock ?? '').matchAll(/"([^"]+)"/g)].map(match => match[1]);
  if (!name || !partitionKeyPath || uniqueKeyPaths.length === 0) {
    throw new Error(`${resourceName} is missing name, a single partition_key_paths, or unique_key`);
  }
  return { name, partitionKeyPath, uniqueKeyPaths };
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

function systemKeys(value: object | undefined): string[] {
  return Object.keys(value ?? {}).filter(key => key.startsWith('_'));
}

function expectPositiveCharge(requestCharge: number): void {
  expect(Number.isFinite(requestCharge)).toBe(true);
  expect(requestCharge).toBeGreaterThan(0);
}

describe('HAR-27 users repository against the Cosmos emulator', () => {
  const databaseName = EMULATOR_TIER_DATABASE;
  const tfUsers = terraformContainer('users_shared');
  const tfDevices = terraformContainer('devices_shared');
  let client: CosmosClient;
  let container: Container;
  let devicesRepository: DevicesRepository;
  let repository: UsersRepository;

  beforeAll(async () => {
    client = new CosmosClient({
      endpoint: EMULATOR_ENDPOINT,
      key: EMULATOR_KEY,
      connectionPolicy: { enableEndpointDiscovery: false },
    });
    await probeEmulator(client);

    const database = await emulatorTierDatabase(client);
    for (const tf of [tfUsers, tfDevices]) {
      await createEmulatorContainer(database, {
        id: tf.name,
        partitionKey: { paths: [tf.partitionKeyPath] },
        uniqueKeyPolicy: { uniqueKeys: [{ paths: tf.uniqueKeyPaths }] },
      });
    }

    // Reach the containers through the production seam, as the Function host does.
    const adapter = new CosmosAdapter(
      {
        accountEndpoint: EMULATOR_ENDPOINT,
        databaseName,
        cooksContainerName: 'unused-by-this-tier',
        devicesContainerName: tfDevices.name,
        temperaturesContainerName: 'unused-by-this-tier',
        usersContainerName: tfUsers.name,
        recipesContainerName: 'unused-by-this-tier',
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
    container = adapter.getUsersContainer();
    devicesRepository = new DevicesRepository(adapter.getDevicesContainer());
    repository = new UsersRepository(container, devicesRepository);
  });

  afterAll(async () => {
    if (client) {
      client.dispose();
    }
  });

  it('creates the container with the Terraform partition key and unique key', async () => {
    expect(tfUsers.partitionKeyPath).toBe('/id');
    expect(tfUsers.uniqueKeyPaths).toEqual(['/email']);
    const { resource } = await container.read();
    expect(resource?.partitionKey?.paths).toEqual(['/id']);
    expect(resource?.uniqueKeyPolicy?.uniqueKeys).toEqual([{ paths: ['/email'] }]);
  });

  it('create → point read → update preserving createdAt, with devices and no system properties', async () => {
    const userId = newUserId();

    // nothing yet
    const missing = await repository.getUser(userId);
    expect(missing.outcome).toBe('notFound');
    expectPositiveCharge(missing.requestCharge);

    // a device the user owns, so `devices` is visibly filled from the owner query
    const deviceId = `emu-${randomUUID()}`;
    await devicesRepository.registerDevice({
      id: deviceId,
      userId,
      name: 'Emulator grill',
      model: 'MeatGeek V2',
      isActive: true,
      connectionStatus: 'unknown',
    });

    // create
    const created = await repository.putUser(userId, {
      name: 'Pit Master',
      email: 'pit@example.com',
      preferences: { temperatureUnit: 'celsius' },
    });
    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return;
    expect(created.user).toEqual({
      id: userId,
      name: 'Pit Master',
      email: 'pit@example.com',
      preferences: { ...DEFAULT_USER_PREFERENCES, temperatureUnit: 'celsius' },
      createdAt: expect.any(String),
      devices: [deviceId],
    });
    expect(systemKeys(created.user)).toEqual([]);
    expectPositiveCharge(created.requestCharge);

    // The stored document really does carry system properties, and no devices.
    const raw = await container.item(userId, userId).read<Record<string, unknown>>();
    expect(systemKeys(raw.resource)).toEqual(expect.arrayContaining(['_rid', '_etag', '_ts']));
    expect(raw.resource).not.toHaveProperty('devices');

    // point read
    const read = await repository.getUser(userId);
    expect(read.outcome).toBe('found');
    if (read.outcome !== 'found') return;
    expect(read.user).toEqual(created.user);
    expect(systemKeys(read.user)).toEqual([]);
    expectPositiveCharge(read.requestCharge);

    // update: createdAt kept, preferences deep-merged over the stored ones
    const updated = await repository.putUser(userId, {
      name: 'Renamed',
      email: 'renamed@example.com',
      preferences: { display: { theme: 'dark' } as never },
    });
    expect(updated.outcome).toBe('updated');
    if (updated.outcome !== 'updated') return;
    expect(updated.user.createdAt).toBe(created.user.createdAt);
    expect(updated.user.name).toBe('Renamed');
    expect(updated.user.preferences.temperatureUnit).toBe('celsius');
    expect(updated.user.preferences.display).toEqual({
      ...DEFAULT_USER_PREFERENCES.display,
      theme: 'dark',
    });
    expect(systemKeys(updated.user)).toEqual([]);
    expectPositiveCharge(updated.requestCharge);

    // read back
    const reread = await repository.getUser(userId);
    expect(reread.outcome === 'found' && reread.user.name).toBe('Renamed');
    expect(reread.outcome === 'found' && reread.user.createdAt).toBe(created.user.createdAt);
  });

  it('a different userId is a different partition: it reads nothing of another user', async () => {
    const owner = newUserId();
    await repository.putUser(owner, { name: 'Owner', email: 'owner@example.com' });

    const stranger = await repository.getUser(newUserId());
    expect(stranger.outcome).toBe('notFound');
    // The owner's document is not reachable under any other partition key.
    const crossPartition = await container.item(owner, newUserId()).read();
    expect(crossPartition.resource).toBeUndefined();
  });

  it('documents why email is not unique across users: the /email unique key is per partition', async () => {
    const email = `same-${randomUUID()}@example.com`;
    const first = await repository.putUser(newUserId(), { name: 'One', email });
    const second = await repository.putUser(newUserId(), { name: 'Two', email });
    expect([first.outcome, second.outcome]).toEqual(['created', 'created']);
  });

  it('a stale ETag is a concurrentUpdate under real If-Match', async () => {
    const userId = newUserId();
    await repository.putUser(userId, { name: 'Original', email: 'orig@example.com' });

    // A replace between the repository's read and its write.
    let interfered = false;
    const racing = new Proxy(container, {
      get(target, property, receiver) {
        if (property !== 'item') return Reflect.get(target, property, receiver);
        return (id: string, partitionKey: string) => {
          const item = target.item(id, partitionKey);
          return new Proxy(item, {
            get(itemTarget, itemProperty, itemReceiver) {
              if (itemProperty !== 'replace' || interfered) {
                const value = Reflect.get(itemTarget, itemProperty, itemReceiver);
                return typeof value === 'function' ? value.bind(itemTarget) : value;
              }
              return async (...args: Parameters<typeof item.replace>) => {
                interfered = true;
                const { resource } = await target.item(id, partitionKey).read();
                await target.item(id, partitionKey).replace({ ...resource, name: 'Racer' });
                return itemTarget.replace(...args);
              };
            },
          });
        };
      },
    });

    const result = await new UsersRepository(racing, devicesRepository).putUser(userId, {
      name: 'Loser',
      email: 'orig@example.com',
    });

    expect(interfered).toBe(true);
    expect(result.outcome).toBe('concurrentUpdate');
    expectPositiveCharge(result.requestCharge);
    const stored = await repository.getUser(userId);
    expect(stored.outcome === 'found' && stored.user.name).toBe('Racer');
  });
});
