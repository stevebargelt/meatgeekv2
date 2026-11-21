/**
 * HAR-86 — the rollup fold and the chart query against a REAL Cosmos DB
 * emulator.
 *
 * temperature-rollups-repository.spec.ts, rollup-temperatures.spec.ts and
 * get-cook-chart.spec.ts run on an in-memory fake. This tier runs the
 * unmodified code on the real `@azure/cosmos` SDK and query engine:
 *
 *   - the rollupTemperatures handler folds IoT-Hub-shaped documents and the
 *     real engine creates and then `IfMatch`-replaces the hour documents;
 *   - two writers racing on one hour document both land: the loser gets a
 *     real 412 (or 409 on create) and retries from a fresh read;
 *   - the chart query (`c.deviceId = @deviceId AND c.hourStart >= @from [AND
 *     c.hourStart < @to]`) runs under the container's Terraform indexing policy,
 *     which indexes ONLY /deviceId/? and /hourStart/?, and the chart is built
 *     from what it returns.
 *
 * Run it with `npx nx run api:test-emulator` (jest.emulator.config.ts). It is
 * excluded from `nx test api`. An unreachable emulator FAILS every case; it never
 * skips. See cooks-repository.emulator.spec.ts and docs/development/ci-cd.md for
 * the engine choice and certificate handling.
 *
 * The container's name, partition key and indexing paths are read from the
 * Terraform module (`azurerm_cosmosdb_sql_container.temperature_rollups_shared`).
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CosmosClient, type Container } from '@azure/cosmos';
import type { TokenCredential } from '@azure/core-auth';
import type { InvocationContext } from '@azure/functions';
import type { Cook } from '@meatgeekv2/api-interfaces';

import { buildCookChart, chartWindowOf } from '../../functions/cooks/get-cook-chart';
import { rollupTemperaturesHandler } from '../../functions/temperatures/rollup-temperatures';
import { CosmosAdapter } from './cosmos-adapter';
import {
  deleteEmulatorContainers,
  EMULATOR_TIER_DATABASE,
  emulatorContainerId,
  emulatorTierDatabase,
} from './emulator-tier.testing';
import {
  foldReadings,
  rollupDocumentId,
  TemperatureRollupsRepository,
} from './temperature-rollups-repository';

const EMULATOR_ENDPOINT = process.env['COSMOS_EMULATOR_ENDPOINT'] ?? 'https://localhost:8081';

/** The Cosmos emulator's documented, public, fixed account key. Test tier only. */
const EMULATOR_KEY =
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const COSMOS_MODULE_MAIN_TF = path.join(REPO_ROOT, 'apps/infrastructure/modules/cosmos-db/main.tf');

/** The rollups container's name, partition key and indexing paths, from Terraform. */
function terraformRollupsContainer(): {
  name: string;
  partitionKeyPath: string;
  includedPaths: string[];
  excludedPaths: string[];
} {
  const source = fs.readFileSync(COSMOS_MODULE_MAIN_TF, 'utf8');
  const start = source.indexOf(
    'resource "azurerm_cosmosdb_sql_container" "temperature_rollups_shared"'
  );
  if (start === -1) {
    throw new Error(`temperature_rollups_shared container not found in ${COSMOS_MODULE_MAIN_TF}`);
  }
  const block = source.slice(start, source.indexOf('\n}', start));
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
  const partitionKeyPath = /^\s*partition_key_paths\s*=\s*\[\s*"([^"]+)"\s*\]/m.exec(block)?.[1];
  const paths = (kind: string) =>
    [...block.matchAll(new RegExp(`${kind}\\s*\\{\\s*path\\s*=\\s*"([^"]+)"`, 'g'))].map(
      match => match[1]
    );
  if (!name || !partitionKeyPath) {
    throw new Error('temperature_rollups_shared is missing name or a single partition_key_paths');
  }
  return {
    name,
    partitionKeyPath,
    includedPaths: paths('included_path'),
    excludedPaths: paths('excluded_path'),
  };
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

/** A stored `temperatures` document as the change feed delivers it. */
function changed(deviceId: string, body: Record<string, unknown>) {
  return {
    id: randomUUID(),
    deviceId,
    Body: body,
    Properties: {},
    SystemProperties: {
      'iothub-connection-device-id': deviceId,
      'iothub-enqueuedtime': '2026-11-20T00:00:00.000Z',
    },
    _rid: 'rid',
    _ts: 1,
  };
}

function context(): InvocationContext {
  return {
    invocationId: 'emu',
    log: () => undefined,
    error: () => undefined,
  } as unknown as InvocationContext;
}

describe('HAR-86 temperature rollups against the Cosmos emulator', () => {
  const databaseName = EMULATOR_TIER_DATABASE;
  const tfContainer = terraformRollupsContainer();
  let client: CosmosClient;
  let container: Container;
  let repository: TemperatureRollupsRepository;
  const deps = () => ({
    getRepository: () => repository,
    now: () => 0,
    sleep: async () => undefined,
  });

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
      indexingPolicy: {
        indexingMode: 'consistent',
        includedPaths: tfContainer.includedPaths.map(p => ({ path: p })),
        excludedPaths: tfContainer.excludedPaths.map(p => ({ path: p })),
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
        recipesContainerName: 'unused-by-this-tier',
        temperatureRollupsContainerName: emulatorContainerId(tfContainer.name),
      },
      {
        credentialFactory: () => unusedCredential,
        clientFactory: ({ endpoint }) => {
          expect(endpoint).toBe(EMULATOR_ENDPOINT);
          return client;
        },
      }
    );
    container = adapter.getTemperatureRollupsContainer();
    repository = new TemperatureRollupsRepository(container);
  });

  afterAll(async () => {
    if (client) {
      await deleteEmulatorContainers(client, [tfContainer.name]);
      client.dispose();
    }
  });

  it('creates the container with the Terraform partition key and indexing paths', async () => {
    expect(tfContainer).toMatchObject({
      name: 'temperature-rollups',
      partitionKeyPath: '/deviceId',
    });
    expect(tfContainer.includedPaths.sort()).toEqual(['/deviceId/?', '/hourStart/?']);
    expect(tfContainer.excludedPaths).toEqual(['/*']);
    const { resource } = await container.read();
    expect(resource?.partitionKey?.paths).toEqual(['/deviceId']);
  });

  it('folds a batch into hour documents, then merges the next batch with IfMatch', async () => {
    const deviceId = `emu-roll-${randomUUID()}`;

    await rollupTemperaturesHandler(
      [
        changed(deviceId, {
          timestamp: '2026-11-20T10:15:05.000Z',
          grillTemp: 225,
          probe1Temp: 150,
        }),
        changed(deviceId, { timestamp: '2026-11-20T10:15:25.000Z', grillTemp: 231.5 }),
        changed(deviceId, { timestamp: '2026-11-20T10:59:59.000Z', grillTemp: 228 }),
        changed(deviceId, { timestamp: '2026-11-20T11:00:00.000Z', grillTemp: 229 }),
        changed(deviceId, 'not-json' as unknown as Record<string, unknown>),
      ],
      context(),
      deps()
    );
    await rollupTemperaturesHandler(
      [
        changed(deviceId, {
          timestamp: '2026-11-20T10:15:45.000Z',
          grillTemp: 220,
          probe1Temp: 155,
        }),
      ],
      context(),
      deps()
    );

    const tenId = rollupDocumentId(deviceId, Date.parse('2026-11-20T10:00:00.000Z'));
    const { resource: ten } = await container.item(tenId, deviceId).read();
    expect(ten).toMatchObject({
      id: tenId,
      deviceId,
      hourStart: '2026-11-20T10:00:00.000Z',
      slots: {
        '15': {
          grill: { n: 3, min: 220, max: 231.5, sum: 676.5 },
          probe1: { n: 2, min: 150, max: 155, sum: 305 },
        },
        '59': { grill: { n: 1, min: 228, max: 228, sum: 228 } },
      },
    });
    const elevenId = rollupDocumentId(deviceId, Date.parse('2026-11-20T11:00:00.000Z'));
    const { resource: eleven } = await container.item(elevenId, deviceId).read();
    expect(eleven?.slots).toEqual({ '0': { grill: { n: 1, min: 229, max: 229, sum: 229 } } });
  });

  it('two writers racing on one hour document both land (real 412/409 and retry)', async () => {
    const deviceId = `emu-race-${randomUUID()}`;
    const deltas = (temp: number) =>
      foldReadings([{ deviceId, timestamp: '2026-11-20T10:01:00.000Z', grillTemp: temp }]);

    await Promise.all([200, 210, 220, 230].map(temp => repository.applyBucket(deltas(temp)[0])));

    const id = rollupDocumentId(deviceId, Date.parse('2026-11-20T10:00:00.000Z'));
    const { resource } = await container.item(id, deviceId).read();
    expect(resource?.slots).toEqual({ '1': { grill: { n: 4, min: 200, max: 230, sum: 860 } } });
  });

  it('the chart query returns the window under the narrowed indexing policy, and the chart builds', async () => {
    const deviceId = `emu-chart-${randomUUID()}`;
    const neighbour = `emu-chart-${randomUUID()}`;
    const readings = [
      { deviceId, timestamp: '2026-11-20T05:59:00.000Z', grillTemp: 1 }, // hour before the window
      { deviceId, timestamp: '2026-11-20T06:15:10.000Z', grillTemp: 225 },
      { deviceId, timestamp: '2026-11-20T06:16:10.000Z', grillTemp: 227 },
      { deviceId, timestamp: '2026-11-20T07:29:59.000Z', grillTemp: 230 },
      { deviceId, timestamp: '2026-11-20T07:31:00.000Z', grillTemp: 999 }, // after endTime
      { deviceId, timestamp: '2026-11-20T09:00:00.000Z', grillTemp: 999 }, // after endTime
      { deviceId: neighbour, timestamp: '2026-11-20T06:20:00.000Z', grillTemp: 999 },
    ];
    for (const delta of foldReadings(readings)) {
      await repository.applyBucket(delta);
    }

    const completed = await repository.queryHours({
      deviceId,
      fromHourStart: '2026-11-20T06:00:00.000Z',
      toHourStart: '2026-11-20T07:30:00.000Z',
    });
    expect(completed.hours.map(h => h.hourStart).sort()).toEqual([
      '2026-11-20T06:00:00.000Z',
      '2026-11-20T07:00:00.000Z',
    ]);
    expect(completed.requestCharge).toBeGreaterThan(0);

    const active = await repository.queryHours({
      deviceId,
      fromHourStart: '2026-11-20T06:00:00.000Z',
    });
    expect(active.hours.map(h => h.hourStart).sort()).toEqual([
      '2026-11-20T06:00:00.000Z',
      '2026-11-20T07:00:00.000Z',
      '2026-11-20T09:00:00.000Z',
    ]);

    const cook: Cook = {
      id: 'cook-emu',
      userId: 'u',
      deviceId,
      name: 'emu',
      status: 'completed',
      startTime: '2026-11-20T06:15:30.000Z',
      endTime: '2026-11-20T07:30:00.000Z',
    };
    const window = chartWindowOf(cook);
    if (!window) throw new Error('cook window did not parse');
    const chart = buildCookChart(cook, window, completed.hours, Date.parse('2026-11-21T00:00:00Z'));
    expect(chart).toEqual({
      cookId: 'cook-emu',
      deviceId,
      startTime: cook.startTime,
      endTime: cook.endTime,
      bucketSeconds: 60,
      points: [
        { t: '2026-11-20T06:15:00.000Z', grill: { min: 225, max: 225, avg: 225 } },
        { t: '2026-11-20T06:16:00.000Z', grill: { min: 227, max: 227, avg: 227 } },
        { t: '2026-11-20T07:29:00.000Z', grill: { min: 230, max: 230, avg: 230 } },
      ],
    });
  });
});
