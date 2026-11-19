/**
 * HAR-28 (MG-79 part 1) — the temperatures repository against a REAL Cosmos DB
 * emulator.
 *
 * temperatures-repository.spec.ts runs on an in-memory fake. This tier runs the
 * unmodified TemperaturesRepository on the real `@azure/cosmos` SDK, so the real
 * query engine evaluates the single-partition `TOP 10 … ORDER BY
 * c.SystemProperties["iothub-enqueuedtime"] DESC`, reports a real request charge,
 * and returns documents with the system properties the mapping must strip.
 *
 * Run it with `npx nx run api:test-emulator` (jest.emulator.config.ts). It is
 * excluded from `nx test api`. An unreachable emulator FAILS every case; it never
 * skips. See cooks-repository.emulator.spec.ts and docs/development/ci-cd.md for
 * the engine choice and certificate handling.
 *
 * The container's name and partition key are read from the Terraform module
 * (`azurerm_cosmosdb_sql_container.temperatures_shared`). The seeded documents
 * are IoT-Hub-shaped, modelled on
 * docs/infrastructure/evidence/mg73-observed-routed-document.json, with the
 * top-level `deviceId` the routing endpoint now stamps.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CosmosClient, type Container } from '@azure/cosmos';
import type { TokenCredential } from '@azure/core-auth';

import { CosmosAdapter } from './cosmos-adapter';
import { TemperaturesRepository } from './temperatures-repository';

const EMULATOR_ENDPOINT = process.env['COSMOS_EMULATOR_ENDPOINT'] ?? 'https://localhost:8081';

/** The Cosmos emulator's documented, public, fixed account key. Test tier only. */
const EMULATOR_KEY =
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';

const PROBE_TIMEOUT_MS = 15_000;

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const COSMOS_MODULE_MAIN_TF = path.join(REPO_ROOT, 'apps/infrastructure/modules/cosmos-db/main.tf');
const EVIDENCE_DOCUMENT = path.join(
  REPO_ROOT,
  'docs/infrastructure/evidence/mg73-observed-routed-document.json'
);

/** The temperatures container's name and partition key, from Terraform. */
function terraformTemperaturesContainer(): { name: string; partitionKeyPath: string } {
  const source = fs.readFileSync(COSMOS_MODULE_MAIN_TF, 'utf8');
  const start = source.indexOf('resource "azurerm_cosmosdb_sql_container" "temperatures_shared"');
  if (start === -1) {
    throw new Error(`temperatures_shared container not found in ${COSMOS_MODULE_MAIN_TF}`);
  }
  const block = source.slice(start, source.indexOf('\n}', start));
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
  const partitionKeyPath = /^\s*partition_key_paths\s*=\s*\[\s*"([^"]+)"\s*\]/m.exec(block)?.[1];
  if (!name || !partitionKeyPath) {
    throw new Error('temperatures_shared is missing name or a single partition_key_paths');
  }
  return { name, partitionKeyPath };
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

async function probeEmulator(client: CosmosClient): Promise<void> {
  let timer: NodeJS.Timeout | undefined;
  try {
    await Promise.race([
      client.getDatabaseAccount(),
      new Promise((_, reject) => {
        timer = setTimeout(
          () => reject(new Error(`no response within ${PROBE_TIMEOUT_MS}ms`)),
          PROBE_TIMEOUT_MS
        );
      }),
    ]);
  } catch (error) {
    throw new Error(
      `Cosmos emulator unreachable at ${EMULATOR_ENDPOINT} (${describeError(error)}). ` +
        'Start one and trust its certificate as described in docs/development/ci-cd.md ' +
        '(Cosmos emulator tier). This tier fails rather than skips.'
    );
  } finally {
    clearTimeout(timer);
  }
}

type RoutedDocument = Record<string, unknown> & {
  Body: unknown;
  SystemProperties: Record<string, unknown>;
};

/** The MG-73 evidence envelope, minus its `_comment` and `_ts`. */
function evidenceEnvelope(): RoutedDocument {
  const raw = JSON.parse(fs.readFileSync(EVIDENCE_DOCUMENT, 'utf8')) as Record<string, unknown>;
  return Object.fromEntries(
    Object.entries(raw).filter(([key]) => !key.startsWith('_'))
  ) as RoutedDocument;
}

/**
 * A routed document for `partitionDeviceId`: the evidence envelope with a fresh
 * `id`, the top-level partition `deviceId`, the hub-authenticated id, enqueued
 * time and body replaced.
 */
function routed(options: {
  partitionDeviceId: string;
  enqueuedTime: string;
  body: unknown;
  hubDeviceId?: string;
}): RoutedDocument {
  const envelope = evidenceEnvelope();
  return {
    ...envelope,
    id: randomUUID(),
    deviceId: options.partitionDeviceId,
    Body: options.body,
    SystemProperties: {
      ...envelope.SystemProperties,
      'message-id': randomUUID(),
      'iothub-connection-device-id': options.hubDeviceId ?? options.partitionDeviceId,
      'iothub-enqueuedtime': options.enqueuedTime,
    },
  };
}

function systemKeys(value: object | undefined): string[] {
  return Object.keys(value ?? {}).filter(key => key.startsWith('_'));
}

function expectPositiveCharge(requestCharge: number): void {
  expect(Number.isFinite(requestCharge)).toBe(true);
  expect(requestCharge).toBeGreaterThan(0);
}

jest.setTimeout(60_000);

describe('HAR-28 temperatures repository against the Cosmos emulator', () => {
  const databaseName = `har28-${randomUUID()}`;
  const tfContainer = terraformTemperaturesContainer();
  let client: CosmosClient;
  let container: Container;
  let repository: TemperaturesRepository;

  beforeAll(async () => {
    client = new CosmosClient({
      endpoint: EMULATOR_ENDPOINT,
      key: EMULATOR_KEY,
      connectionPolicy: { enableEndpointDiscovery: false },
    });
    await probeEmulator(client);

    const { database } = await client.databases.createIfNotExists({ id: databaseName });
    await database.containers.createIfNotExists({
      id: tfContainer.name,
      partitionKey: { paths: [tfContainer.partitionKeyPath] },
    });

    // Reach the container through the production seam, as the Function host does.
    const adapter = new CosmosAdapter(
      {
        accountEndpoint: EMULATOR_ENDPOINT,
        databaseName,
        cooksContainerName: 'unused-by-this-tier',
        devicesContainerName: 'unused-by-this-tier',
        temperaturesContainerName: tfContainer.name,
      },
      {
        credentialFactory: () => unusedCredential,
        clientFactory: ({ endpoint }) => {
          expect(endpoint).toBe(EMULATOR_ENDPOINT);
          return client;
        },
      }
    );
    container = adapter.getTemperaturesContainer();
    repository = new TemperaturesRepository(container);
  });

  afterAll(async () => {
    if (client) {
      await client
        .database(databaseName)
        .delete()
        .catch(() => undefined);
      client.dispose();
    }
  });

  it('creates the container with the Terraform partition key', async () => {
    expect(tfContainer.partitionKeyPath).toBe('/deviceId');
    const { resource } = await container.read();
    expect(resource?.partitionKey?.paths).toEqual(['/deviceId']);
  });

  it('returns the newest valid reading, by hub identity, skipping documents that do not map', async () => {
    const deviceId = `emu-temp-${randomUUID()}`;
    const neighbour = `emu-temp-${randomUUID()}`;

    const documents: RoutedDocument[] = [
      // Older readings.
      routed({
        partitionDeviceId: deviceId,
        enqueuedTime: '2026-08-14T16:00:00.120Z',
        body: { deviceId, timestamp: '2026-08-14T16:00:00.000Z', grillTemp: 210 },
      }),
      // Two readings within the same second; the later one is the newest valid.
      routed({
        partitionDeviceId: deviceId,
        enqueuedTime: '2026-08-14T16:00:10.100Z',
        body: { deviceId, timestamp: '2026-08-14T16:00:10.050Z', grillTemp: 220 },
      }),
      routed({
        partitionDeviceId: deviceId,
        enqueuedTime: '2026-08-14T16:00:10.900Z',
        // Body.deviceId names a different device: the reading must still report
        // the hub-authenticated id.
        body: {
          deviceId: 'spoofed-device',
          timestamp: '2026-08-14T16:00:10.850Z',
          cookId: 'cook-emu',
          grillTemp: 225.5,
          probe1Temp: 160.25,
          probe2Temp: 'n/a',
        },
      }),
      // Newer, but its hub identity is another device: skipped.
      routed({
        partitionDeviceId: deviceId,
        hubDeviceId: neighbour,
        enqueuedTime: '2026-08-14T16:00:20.000Z',
        body: { deviceId, timestamp: '2026-08-14T16:00:20.000Z', grillTemp: 999 },
      }),
      // Newest, but its body is not a JSON object: skipped.
      routed({
        partitionDeviceId: deviceId,
        enqueuedTime: '2026-08-14T16:00:30.000Z',
        body: 'eyJncmlsbFRlbXAiOjk5OX0=',
      }),
      // Another partition, newer than everything: never read.
      routed({
        partitionDeviceId: neighbour,
        enqueuedTime: '2026-08-14T17:00:00.000Z',
        body: { deviceId: neighbour, timestamp: '2026-08-14T17:00:00.000Z', grillTemp: 300 },
      }),
    ];
    for (const document of documents) {
      await container.items.create(document);
    }

    // The stored documents really do carry system properties: the mapping is
    // what removes them.
    const raw = await container.items
      .query<Record<string, unknown>>(
        {
          query: 'SELECT * FROM c WHERE c.deviceId = @deviceId',
          parameters: [{ name: '@deviceId', value: deviceId }],
        },
        { partitionKey: deviceId }
      )
      .fetchAll();
    expect(raw.resources).toHaveLength(5);
    for (const document of raw.resources) {
      expect(systemKeys(document)).toEqual(expect.arrayContaining(['_rid', '_etag', '_ts']));
    }

    const latest = await repository.getLatestReading(deviceId);

    expect(latest.status).toBe('found');
    if (latest.status !== 'found') return;
    expect(latest.reading).toEqual({
      deviceId,
      timestamp: '2026-08-14T16:00:10.850Z',
      cookId: 'cook-emu',
      grillTemp: 225.5,
      probe1Temp: 160.25,
    });
    expect(systemKeys(latest.reading)).toEqual([]);
    for (const key of ['SystemProperties', 'Properties', 'iothub_name', 'id', 'Body']) {
      expect(latest.reading).not.toHaveProperty(key);
    }
    expectPositiveCharge(latest.requestCharge);

    const other = await repository.getLatestReading(neighbour);
    expect(other.status === 'found' && other.reading.grillTemp).toBe(300);
  });

  it('is none, with a real request charge, for a device with no documents or none that map', async () => {
    const empty = await repository.getLatestReading(`emu-temp-${randomUUID()}`);
    expect(empty.status).toBe('none');
    expectPositiveCharge(empty.requestCharge);

    const deviceId = `emu-temp-${randomUUID()}`;
    await container.items.create(
      routed({
        partitionDeviceId: deviceId,
        enqueuedTime: '2026-08-14T16:00:00.000Z',
        body: 'not-json',
      })
    );
    const junk = await repository.getLatestReading(deviceId);
    expect(junk.status).toBe('none');
    expectPositiveCharge(junk.requestCharge);
  });
});
