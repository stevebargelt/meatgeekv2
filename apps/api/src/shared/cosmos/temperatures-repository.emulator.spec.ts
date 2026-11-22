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
 * HAR-35 (MG-79 part 2) adds the history page query: the real engine evaluates
 * the predicate (hub identity, `IS_OBJECT(c.Body)`, strict `Body.cookId`), the
 * string window on `iothub-enqueuedtime` and the ascending ORDER BY. HAR-75
 * pages it by the SDK continuation token (no OFFSET, no COUNT), and a token
 * the engine refuses becomes InvalidContinuationTokenError.
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
import {
  closeEmulatorTier,
  createEmulatorContainer,
  EMULATOR_TIER_DATABASE,
  emulatorTierDatabase,
} from './emulator-tier.testing';
import { InvalidContinuationTokenError, TemperaturesRepository } from './temperatures-repository';

const EMULATOR_ENDPOINT = process.env['COSMOS_EMULATOR_ENDPOINT'] ?? 'https://localhost:8081';

/** The Cosmos emulator's documented, public, fixed account key. Test tier only. */
const EMULATOR_KEY =
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';

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

describe('HAR-28 temperatures repository against the Cosmos emulator', () => {
  const databaseName = EMULATOR_TIER_DATABASE;
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

    const database = await emulatorTierDatabase(client);
    await createEmulatorContainer(database, {
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
    container = adapter.getTemperaturesContainer();
    repository = new TemperaturesRepository(container);
  });

  afterAll(() => {
    closeEmulatorTier(client);
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

  describe('HAR-35 history (count and page)', () => {
    const deviceId = `emu-hist-${randomUUID()}`;
    const neighbour = `emu-hist-${randomUUID()}`;
    const at = (seconds: number) => new Date(Date.UTC(2026, 7, 14, 16, 0, seconds)).toISOString();

    beforeAll(async () => {
      const documents: RoutedDocument[] = [
        // Five valid readings, seeded out of order; 0, 20 and 40 carry cook-a.
        ...[30, 0, 40, 10, 20].map(seconds =>
          routed({
            partitionDeviceId: deviceId,
            enqueuedTime: at(seconds),
            body: {
              // A Body.deviceId naming another device is ignored.
              deviceId: seconds === 10 ? 'spoofed-device' : deviceId,
              timestamp: at(seconds),
              grillTemp: 200 + seconds,
              ...(seconds % 20 === 0 ? { cookId: 'cook-a' } : {}),
            },
          })
        ),
        // A cookId that only shares a prefix: not a match for cook-a.
        routed({
          partitionDeviceId: deviceId,
          enqueuedTime: at(25),
          body: { deviceId, timestamp: at(25), grillTemp: 225, cookId: 'cook-ab' },
        }),
        // Excluded: a foreign hub identity in this partition.
        routed({
          partitionDeviceId: deviceId,
          hubDeviceId: neighbour,
          enqueuedTime: at(15),
          body: { deviceId, timestamp: at(15), grillTemp: 999, cookId: 'cook-a' },
        }),
        // Excluded: a non-object Body.
        routed({
          partitionDeviceId: deviceId,
          enqueuedTime: at(35),
          body: 'eyJncmlsbFRlbXAiOjk5OX0=',
        }),
        // Another partition, inside every window: never read.
        ...[5, 12, 22].map(seconds =>
          routed({
            partitionDeviceId: neighbour,
            enqueuedTime: at(seconds),
            body: { deviceId: neighbour, timestamp: at(seconds), grillTemp: 300, cookId: 'cook-a' },
          })
        ),
      ];
      for (const document of documents) {
        await container.items.create(document);
      }
    });

    /** Every page of a filter, walked by continuation token. */
    async function history(
      filter: { cookId?: string; startTime?: string; endTime?: string },
      limit = 100
    ) {
      const full = { deviceId, ...filter };
      const pages: number[][] = [];
      let continuationToken: string | undefined;
      do {
        const page = await repository.getReadingsPage(full, { limit, continuationToken });
        expectPositiveCharge(page.requestCharge);
        for (const reading of page.readings) {
          expect(reading.deviceId).toBe(deviceId);
          expect(systemKeys(reading)).toEqual([]);
          for (const key of ['SystemProperties', 'Properties', 'iothub_name', 'id', 'Body']) {
            expect(reading).not.toHaveProperty(key);
          }
        }
        pages.push(page.readings.map(reading => reading.grillTemp as number));
        continuationToken = page.continuationToken;
      } while (continuationToken !== undefined);
      return { temps: pages.flat(), pages };
    }

    it('returns every valid reading oldest first, excluding foreign identities, non-object bodies and the other partition', async () => {
      expect((await history({})).temps).toEqual([200, 210, 220, 225, 230, 240]);
    });

    it('bounds the window on enqueued time: start inclusive, end exclusive', async () => {
      expect((await history({ startTime: at(10), endTime: at(30) })).temps).toEqual([
        210, 220, 225,
      ]);
      expect((await history({ startTime: at(30) })).temps).toEqual([230, 240]);
      expect((await history({ endTime: at(10) })).temps).toEqual([200]);
    });

    it('matches cookId strictly', async () => {
      expect((await history({ cookId: 'cook-a' })).temps).toEqual([200, 220, 240]);
      expect((await history({ cookId: 'cook-ab' })).temps).toEqual([225]);
      expect((await history({ cookId: 'cook' })).temps).toEqual([]);
      expect(
        (await history({ cookId: 'cook-a', startTime: at(10), endTime: at(40) })).temps
      ).toEqual([220]);
    });

    it('pages by continuation token, maxItemCount at a time', async () => {
      const { pages } = await history({}, 2);
      expect(pages.flat()).toEqual([200, 210, 220, 225, 230, 240]);
      expect(pages.every(page => page.length <= 2)).toBe(true);
    });

    it('refuses a garbled continuation token as InvalidContinuationTokenError', async () => {
      await expect(
        repository.getReadingsPage(
          { deviceId },
          { limit: 2, continuationToken: 'not-a-cosmos-continuation-token' }
        )
      ).rejects.toBeInstanceOf(InvalidContinuationTokenError);
    });

    it('never reads the other partition', async () => {
      const other = { deviceId: neighbour };
      const page = await repository.getReadingsPage(other, { limit: 100 });
      expect(page.readings.map(reading => reading.grillTemp)).toEqual([300, 300, 300]);
      expect(page.readings.every(reading => reading.deviceId === neighbour)).toBe(true);
    });

    it('is an empty page with a real charge for a device with no documents', async () => {
      const empty = { deviceId: `emu-hist-${randomUUID()}` };
      const page = await repository.getReadingsPage(empty, { limit: 100 });
      expect(page.readings).toEqual([]);
      expect(page.continuationToken).toBeUndefined();
      expectPositiveCharge(page.requestCharge);
    });
  });
});
