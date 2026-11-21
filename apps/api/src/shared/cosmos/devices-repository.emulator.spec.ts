/**
 * HAR-20 (MG-80) — the devices repository against a REAL Cosmos DB emulator.
 *
 * devices-repository.spec.ts runs on an in-memory fake. This tier runs the
 * unmodified DevicesRepository on the real `@azure/cosmos` SDK against the
 * emulator, so Cosmos' own behaviour is exercised before merge: create-not-upsert
 * 409 on a taken id, point reads keyed on `/id`, the cross-partition owner query,
 * If-Match on replace, real request charges, and the system properties the
 * mapping must strip.
 *
 * Run it with `npx nx run api:test-emulator` (jest.emulator.config.ts). It is
 * excluded from `nx test api`. An unreachable emulator FAILS every case; it never
 * skips. See cooks-repository.emulator.spec.ts and docs/development/ci-cd.md for
 * the engine choice and certificate handling.
 *
 * The container is created with the partition key and unique key read from the
 * Terraform module (`azurerm_cosmosdb_sql_container.devices_shared`), so the
 * emulator container cannot drift from the deployed one.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CosmosClient, type Container } from '@azure/cosmos';
import type { TokenCredential } from '@azure/core-auth';
import type { Device } from '@meatgeekv2/api-interfaces';

import { CosmosAdapter } from './cosmos-adapter';
import {
  deleteEmulatorContainers,
  EMULATOR_TIER_DATABASE,
  emulatorContainerId,
  emulatorTierDatabase,
} from './emulator-tier.testing';
import { DevicesRepository } from './devices-repository';

const EMULATOR_ENDPOINT = process.env['COSMOS_EMULATOR_ENDPOINT'] ?? 'https://localhost:8081';

/** The Cosmos emulator's documented, public, fixed account key. Test tier only. */
const EMULATOR_KEY =
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const COSMOS_MODULE_MAIN_TF = path.join(REPO_ROOT, 'apps/infrastructure/modules/cosmos-db/main.tf');

interface TerraformDevicesContainer {
  readonly name: string;
  readonly partitionKeyPath: string;
  readonly uniqueKeyPaths: string[];
}

/** The devices container's name, partition key and unique key, from Terraform. */
function terraformDevicesContainer(): TerraformDevicesContainer {
  const source = fs.readFileSync(COSMOS_MODULE_MAIN_TF, 'utf8');
  const start = source.indexOf('resource "azurerm_cosmosdb_sql_container" "devices_shared"');
  if (start === -1) {
    throw new Error(`devices_shared container not found in ${COSMOS_MODULE_MAIN_TF}`);
  }
  const block = source.slice(start, source.indexOf('\n}', start));
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
  const partitionKeyPath = /^\s*partition_key_paths\s*=\s*\[\s*"([^"]+)"\s*\]/m.exec(block)?.[1];
  const uniqueBlock = /unique_key\s*\{\s*paths\s*=\s*\[([^\]]*)\]/m.exec(block)?.[1];
  const uniqueKeyPaths = [...(uniqueBlock ?? '').matchAll(/"([^"]+)"/g)].map(match => match[1]);
  if (!name || !partitionKeyPath || uniqueKeyPaths.length === 0) {
    throw new Error('devices_shared is missing name, a single partition_key_paths, or unique_key');
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

function newDevice(userId: string, overrides: Partial<Device> = {}): Device {
  return {
    id: `emu-${randomUUID()}`,
    userId,
    name: `Emulator grill ${randomUUID().slice(0, 8)}`,
    model: 'MeatGeek V2',
    isActive: true,
    connectionStatus: 'unknown',
    ...overrides,
  };
}

function systemKeys(value: object | undefined): string[] {
  return Object.keys(value ?? {}).filter(key => key.startsWith('_'));
}

function expectPositiveCharge(requestCharge: number): void {
  expect(Number.isFinite(requestCharge)).toBe(true);
  expect(requestCharge).toBeGreaterThan(0);
}

describe('HAR-20 devices repository against the Cosmos emulator', () => {
  const databaseName = EMULATOR_TIER_DATABASE;
  const tfContainer = terraformDevicesContainer();
  let client: CosmosClient;
  let container: Container;
  let repository: DevicesRepository;

  beforeAll(async () => {
    client = new CosmosClient({
      endpoint: EMULATOR_ENDPOINT,
      key: EMULATOR_KEY,
      connectionPolicy: { enableEndpointDiscovery: false },
    });
    await probeEmulator(client);

    const database = await emulatorTierDatabase(client);
    await database.containers.createIfNotExists({
      id: emulatorContainerId(tfContainer.name),
      partitionKey: { paths: [tfContainer.partitionKeyPath] },
      uniqueKeyPolicy: { uniqueKeys: [{ paths: tfContainer.uniqueKeyPaths }] },
    });

    // Reach the container through the production seam, as the Function host does.
    const adapter = new CosmosAdapter(
      {
        accountEndpoint: EMULATOR_ENDPOINT,
        databaseName,
        cooksContainerName: 'unused-by-this-tier',
        devicesContainerName: emulatorContainerId(tfContainer.name),
        temperaturesContainerName: 'unused-by-this-tier',
        usersContainerName: 'unused-by-this-tier',
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
    container = adapter.getDevicesContainer();
    repository = new DevicesRepository(container);
  });

  afterAll(async () => {
    if (client) {
      await deleteEmulatorContainers(client, [tfContainer.name]);
      client.dispose();
    }
  });

  it('creates the container with the Terraform partition key and unique key', async () => {
    expect(tfContainer.partitionKeyPath).toBe('/id');
    expect(tfContainer.uniqueKeyPaths).toEqual(['/userId', '/name']);
    const { resource } = await container.read();
    expect(resource?.partitionKey?.paths).toEqual(['/id']);
    expect(resource?.uniqueKeyPolicy?.uniqueKeys).toEqual([{ paths: ['/userId', '/name'] }]);
  });

  it('create → point read → list by owner → patch → read back, with no system properties', async () => {
    const userId = `user-${randomUUID()}`;
    const device = newDevice(userId, { location: 'Deck' });

    // create
    const created = await repository.registerDevice(device);
    expect(created.outcome).toBe('created');
    if (created.outcome !== 'created') return;
    expect(created.device).toEqual(device);
    expect(systemKeys(created.device)).toEqual([]);
    expectPositiveCharge(created.requestCharge);

    // The stored document really does carry system properties: the mapping is
    // what removes them.
    const raw = await container.item(device.id, device.id).read<Record<string, unknown>>();
    expect(systemKeys(raw.resource)).toEqual(expect.arrayContaining(['_rid', '_etag', '_ts']));

    // point read
    const ownership = await repository.getDeviceOwnership(userId, device.id);
    expect(ownership.status).toBe('owned');
    if (ownership.status !== 'owned') return;
    expect(ownership.device).toEqual(device);
    expect(systemKeys(ownership.device)).toEqual([]);
    expectPositiveCharge(ownership.requestCharge);

    // list by owner (cross-partition), with a second device and a stranger's
    const second = newDevice(userId);
    expect((await repository.registerDevice(second)).outcome).toBe('created');
    expect((await repository.registerDevice(newDevice(`user-${randomUUID()}`))).outcome).toBe(
      'created'
    );
    const listed = await repository.listDevicesByOwner(userId);
    expect(listed.devices.map(d => d.id).sort()).toEqual([device.id, second.id].sort());
    expect(listed.devices.flatMap(systemKeys)).toEqual([]);
    expectPositiveCharge(listed.requestCharge);

    // patch
    const updated = await repository.updateDevice(userId, device.id, {
      location: 'Garage',
      configuration: { pollingInterval: 15, alertSettings: { highTempThreshold: 275 } },
    });
    expect(updated.outcome).toBe('updated');
    if (updated.outcome !== 'updated') return;
    expect(updated.device.location).toBe('Garage');
    expect(updated.device.configuration).toEqual({
      temperatureUnit: 'fahrenheit',
      pollingInterval: 15,
      alertSettings: {
        highTempThreshold: 275,
        lowTempThreshold: 0,
        enableSounds: false,
        enablePushNotifications: false,
      },
    });
    expect(systemKeys(updated.device)).toEqual([]);
    expectPositiveCharge(updated.requestCharge);

    // read back
    const reread = await repository.getDeviceOwnership(userId, device.id);
    expect(reread.status === 'owned' && reread.device.location).toBe('Garage');
  });

  it('a duplicate id is a conflict, whoever owns it, and leaves the stored device alone', async () => {
    const owner = `user-${randomUUID()}`;
    const device = newDevice(owner);
    expect((await repository.registerDevice(device)).outcome).toBe('created');

    const sameOwner = await repository.registerDevice({ ...device, name: 'Another name' });
    const stranger = await repository.registerDevice({
      ...device,
      userId: `user-${randomUUID()}`,
      name: 'Hijack',
    });

    for (const result of [sameOwner, stranger]) {
      expect(result.outcome).toBe('conflict');
      expectPositiveCharge(result.requestCharge);
    }
    const stored = await repository.getDeviceOwnership(owner, device.id);
    expect(stored.status === 'owned' && stored.device.name).toBe(device.name);
  });

  it('a duplicate name for the same owner is a conflict; the same name for another owner is not', async () => {
    const owner = `user-${randomUUID()}`;
    const first = newDevice(owner, { name: 'Smoker' });
    expect((await repository.registerDevice(first)).outcome).toBe('created');

    const clash = await repository.registerDevice(newDevice(owner, { name: 'Smoker' }));
    expect(clash.outcome).toBe('conflict');

    const elsewhere = await repository.registerDevice(
      newDevice(`user-${randomUUID()}`, { name: 'Smoker' })
    );
    expect(elsewhere.outcome).toBe('created');

    const second = newDevice(owner, { name: 'Kettle' });
    expect((await repository.registerDevice(second)).outcome).toBe('created');
    const rename = await repository.updateDevice(owner, second.id, { name: 'Smoker' });
    expect(rename.outcome).toBe('nameConflict');
  });

  it('documents why names are checked in code: the (userId, name) unique key is per partition', async () => {
    // Every device is its own `/id` partition, and Cosmos enforces unique keys
    // within a logical partition only. Two raw creates with the same
    // (userId, name) and different ids both succeed.
    const owner = `user-${randomUUID()}`;
    const a = newDevice(owner, { name: 'Twin' });
    const b = newDevice(owner, { name: 'Twin' });
    await container.items.create(a);
    await expect(container.items.create(b)).resolves.toMatchObject({ statusCode: 201 });
  });

  it('ownership is foreign for another user and unknown for a missing id', async () => {
    const owner = `user-${randomUUID()}`;
    const device = newDevice(owner);
    await repository.registerDevice(device);

    const foreign = await repository.getDeviceOwnership(`user-${randomUUID()}`, device.id);
    expect(foreign.status).toBe('foreign');
    const unknown = await repository.getDeviceOwnership(owner, `emu-${randomUUID()}`);
    expect(unknown.status).toBe('unknown');
    expectPositiveCharge(unknown.requestCharge);

    const hijack = await repository.updateDevice(`user-${randomUUID()}`, device.id, {
      location: 'Not yours',
    });
    expect(hijack.outcome).toBe('notFound');
  });

  it('a stale ETag is a concurrentUpdate under real If-Match', async () => {
    const owner = `user-${randomUUID()}`;
    const device = newDevice(owner);
    await repository.registerDevice(device);

    // A replace between the repository's read and its write: wrap the container so
    // the first replace call is preceded by a concurrent write.
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
                await target.item(id, partitionKey).replace({ ...device, location: 'Racer' });
                return itemTarget.replace(...args);
              };
            },
          });
        };
      },
    });

    const result = await new DevicesRepository(racing).updateDevice(owner, device.id, {
      location: 'Loser',
    });

    expect(interfered).toBe(true);
    expect(result.outcome).toBe('concurrentUpdate');
    const stored = await repository.getDeviceOwnership(owner, device.id);
    expect(stored.status === 'owned' && stored.device.location).toBe('Racer');
  });
});
