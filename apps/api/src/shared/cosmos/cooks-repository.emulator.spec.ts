/**
 * HAR-12 — the cooks repository against a REAL Cosmos DB emulator.
 *
 * cooks-repository.spec.ts and cooks-persistence-flow.integration.spec.ts run
 * against hand-written fakes, so they prove the repository's wiring but not
 * Cosmos' own behaviour: `(partition, id)` uniqueness on create, all-or-nothing
 * transactional batches, If-Match on replace, single-partition ORDER BY queries
 * with continuation-token paging, and a real `requestCharge`. This tier runs the
 * unmodified CooksRepository on the real `@azure/cosmos` SDK against the
 * emulator, so those behaviours are exercised before merge.
 *
 * Run it with `npx nx run api:test-emulator` (jest.emulator.config.ts). It is
 * excluded from `nx test api`. When the emulator is unreachable the `beforeAll`
 * probe throws and every case FAILS — it never skips.
 *
 * Engine: the classic Linux emulator (`azure-cosmos-emulator:latest`), not the
 * lighter `vnext-preview` image. vnext was tried first and is missing two things
 * this repository relies on: it ignores the page size on a single-partition
 * `ORDER BY` query (one page, no continuation token), and it reports
 * `requestCharge: 0` for every operation inside a transactional batch. The
 * classic engine pages and charges like the service. See
 * docs/development/ci-cd.md.
 *
 * Credentials: the emulator's well-known key is a PUBLIC constant shipped in
 * every emulator image and in the SDK's own docs. It lives here, in a spec file,
 * and nowhere in apps/api/src non-test code. The client reaches the repository
 * through the production seam — CosmosAdapter's `clientFactory` — so the
 * deployed managed-identity path (`productionSeams`) is untouched and unused.
 */
import { randomUUID } from 'crypto';
import * as fs from 'fs';
import * as path from 'path';

import { CosmosClient, type Container } from '@azure/cosmos';
import type { TokenCredential } from '@azure/core-auth';
import type { Cook } from '@meatgeekv2/api-interfaces';

import { CosmosAdapter } from './cosmos-adapter';
import {
  ACTIVE_DEVICE_LOCK_DOC_TYPE,
  CooksRepository,
  activeDeviceLockId,
} from './cooks-repository';

/** The classic emulator serves HTTPS with its own certificate: trust it with
 *  NODE_EXTRA_CA_CERTS (see docs/development/ci-cd.md), never by disabling TLS. */
const EMULATOR_ENDPOINT = process.env['COSMOS_EMULATOR_ENDPOINT'] ?? 'https://localhost:8081';

/** The Cosmos emulator's documented, public, fixed account key. Test tier only. */
const EMULATOR_KEY =
  'C2y6yDjf5/R+ob0N8A7Cgv30VRDJIWEHLM+4QDU5DE2nQ9nDuVTqobD4b8mGGyPMbIZnqyMsEcaGQy67XIw/Jw==';

/** Bound on the reachability probe, so a dead endpoint fails fast and clearly. */
const PROBE_TIMEOUT_MS = 15_000;

const REPO_ROOT = path.resolve(__dirname, '../../../../..');
const COSMOS_MODULE_MAIN_TF = path.join(REPO_ROOT, 'apps/infrastructure/modules/cosmos-db/main.tf');

/**
 * The cooks container's partition key path, read from the Terraform module that
 * declares the deployed container (`azurerm_cosmosdb_sql_container.cooks_shared`)
 * rather than restated here, so the emulator container cannot drift from it.
 */
function terraformCooksContainer(): { name: string; partitionKeyPath: string } {
  const source = fs.readFileSync(COSMOS_MODULE_MAIN_TF, 'utf8');
  const start = source.indexOf('resource "azurerm_cosmosdb_sql_container" "cooks_shared"');
  if (start === -1) {
    throw new Error(`cooks_shared container not found in ${COSMOS_MODULE_MAIN_TF}`);
  }
  const block = source.slice(start, source.indexOf('\n}', start));
  const name = /^\s*name\s*=\s*"([^"]+)"/m.exec(block)?.[1];
  const paths = /^\s*partition_key_paths\s*=\s*\[\s*"([^"]+)"\s*\]/m.exec(block)?.[1];
  if (!name || !paths) {
    throw new Error('cooks_shared container is missing name or a single partition_key_paths');
  }
  return { name, partitionKeyPath: paths };
}

/** A credential that must never be asked for a token: the emulator uses its key. */
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

function newCook(userId: string, overrides: Partial<Cook> = {}): Cook {
  return {
    id: randomUUID(),
    userId,
    deviceId: `grill-${randomUUID().slice(0, 8)}`,
    name: 'Emulator brisket',
    status: 'active',
    startTime: new Date().toISOString(),
    meatType: 'brisket',
    ...overrides,
  };
}

/** Every top-level key that starts with `_` (a Cosmos system property). */
function systemKeys(cook: Cook | undefined): string[] {
  return Object.keys(cook ?? {}).filter(key => key.startsWith('_'));
}

function expectPositiveCharge(requestCharge: number): void {
  expect(typeof requestCharge).toBe('number');
  expect(Number.isFinite(requestCharge)).toBe(true);
  expect(requestCharge).toBeGreaterThan(0);
}

/** Every document (cooks AND device locks) stored in one user's partition. */
async function partitionDocuments(
  container: Container,
  userId: string
): Promise<Array<{ id: string; docType?: string }>> {
  const { resources } = await container.items
    .query<{ id: string; docType?: string }>(
      {
        query: 'SELECT c.id, c.docType FROM c WHERE c.userId = @userId',
        parameters: [{ name: '@userId', value: userId }],
      },
      { partitionKey: userId }
    )
    .fetchAll();
  return resources;
}

// Real network round-trips; the emulator is slower than a fake.
jest.setTimeout(60_000);

describe('HAR-12 cooks repository against the Cosmos emulator', () => {
  const databaseName = `har12-${randomUUID()}`;
  const tfContainer = terraformCooksContainer();
  let client: CosmosClient;
  let container: Container;
  let repository: CooksRepository;

  beforeAll(async () => {
    client = new CosmosClient({
      endpoint: EMULATOR_ENDPOINT,
      key: EMULATOR_KEY,
      // The emulator advertises its own internal address; stay on the one we dialled.
      connectionPolicy: { enableEndpointDiscovery: false },
    });
    await probeEmulator(client);

    const { database } = await client.databases.createIfNotExists({ id: databaseName });
    await database.containers.createIfNotExists({
      id: tfContainer.name,
      partitionKey: { paths: [tfContainer.partitionKeyPath] },
    });

    // Reach the container through the production seam, exactly as the Function
    // host does — only the factories differ.
    const adapter = new CosmosAdapter(
      {
        accountEndpoint: EMULATOR_ENDPOINT,
        databaseName,
        cooksContainerName: tfContainer.name,
      },
      {
        credentialFactory: () => unusedCredential,
        clientFactory: ({ endpoint }) => {
          expect(endpoint).toBe(EMULATOR_ENDPOINT);
          return client;
        },
      }
    );
    container = adapter.getCooksContainer();
    repository = new CooksRepository(container);
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

  it('creates the throwaway container with the Terraform-declared partition key', async () => {
    expect(tfContainer.partitionKeyPath).toBe('/userId');
    const { resource } = await container.read();
    expect(resource?.partitionKey?.paths).toEqual([tfContainer.partitionKeyPath]);
  });

  it('starts a cook and reads it back from its partition', async () => {
    const userId = `user-${randomUUID()}`;
    const cook = newCook(userId);

    const started = await repository.startCook(cook);
    expect(started.outcome).toBe('created');
    expectPositiveCharge(started.requestCharge);
    if (started.outcome !== 'created') return;
    expect(started.cook).toEqual(cook);
    expect(systemKeys(started.cook)).toEqual([]);

    const read = await repository.getCook(userId, cook.id);
    expectPositiveCharge(read.requestCharge);
    expect(read.cook).toEqual(cook);
    expect(systemKeys(read.cook)).toEqual([]);

    // The device lock was committed in the same batch, in the same partition.
    const docs = await partitionDocuments(container, userId);
    expect(docs).toEqual(
      expect.arrayContaining([
        { id: cook.id },
        { id: activeDeviceLockId(cook.deviceId), docType: ACTIVE_DEVICE_LOCK_DOC_TYPE },
      ])
    );
    expect(docs).toHaveLength(2);

    // A point-read addressed to another partition is a miss, not a fan-out hit.
    const elsewhere = await repository.getCook(`user-${randomUUID()}`, cook.id);
    expect(elsewhere.cook).toBeUndefined();
  });

  it('MG-84: a retried start with the same id does not create a second cook', async () => {
    const userId = `user-${randomUUID()}`;
    const cook = newCook(userId);

    const first = await repository.startCook(cook);
    const retry = await repository.startCook(cook);
    expect(first.outcome).toBe('created');
    expect(retry.outcome).toBe('replayed');
    expectPositiveCharge(retry.requestCharge);
    if (retry.outcome !== 'replayed') return;
    expect(retry.cook).toEqual(cook);

    // Concurrent duplicates collapse the same way: Cosmos' (partition, id)
    // uniqueness lets exactly one create win.
    const concurrent = newCook(userId);
    const outcomes = await Promise.all([
      repository.startCook(concurrent),
      repository.startCook(concurrent),
      repository.startCook(concurrent),
    ]);
    expect(outcomes.map(o => o.outcome).sort()).toEqual(['created', 'replayed', 'replayed']);
    outcomes.forEach(o => expectPositiveCharge(o.requestCharge));

    const cookIds = (await partitionDocuments(container, userId))
      .filter(doc => doc.docType === undefined)
      .map(doc => doc.id)
      .sort();
    expect(cookIds).toEqual([cook.id, concurrent.id].sort());
  });

  it('MG-84: a second cook on a busy device is refused until the first is stopped', async () => {
    const userId = `user-${randomUUID()}`;
    const holder = newCook(userId, { deviceId: 'grill-shared' });
    const contender = newCook(userId, { deviceId: 'grill-shared' });

    expect((await repository.startCook(holder)).outcome).toBe('created');

    const busy = await repository.startCook(contender);
    expect(busy).toMatchObject({ outcome: 'deviceBusy', activeCookId: holder.id });
    expectPositiveCharge(busy.requestCharge);
    // The refused batch rolled back: no contender cook was written.
    expect((await repository.getCook(userId, contender.id)).cook).toBeUndefined();

    await repository.stopCook(userId, holder.id, new Date().toISOString());
    const afterStop = await repository.startCook(contender);
    expect(afterStop.outcome).toBe('created');
  });

  it('stops a cook and reads it back stopped, idempotently', async () => {
    const userId = `user-${randomUUID()}`;
    const cook = newCook(userId);
    await repository.startCook(cook);
    const endTime = new Date(Date.now() + 60_000).toISOString();

    const stopped = await repository.stopCook(userId, cook.id, endTime);
    expect(stopped.transitioned).toBe(true);
    expectPositiveCharge(stopped.requestCharge);
    expect(stopped.cook).toEqual({ ...cook, status: 'completed', endTime });
    expect(systemKeys(stopped.cook)).toEqual([]);

    const read = await repository.getCook(userId, cook.id);
    expectPositiveCharge(read.requestCharge);
    expect(read.cook).toEqual({ ...cook, status: 'completed', endTime });

    // The stop released the device lock in the same batch.
    const docs = await partitionDocuments(container, userId);
    expect(docs).toEqual([{ id: cook.id }]);

    // A repeated stop returns the persisted final state and writes nothing.
    const again = await repository.stopCook(userId, cook.id, new Date().toISOString());
    expect(again.transitioned).toBe(false);
    expect(again.cook).toEqual({ ...cook, status: 'completed', endTime });
    expectPositiveCharge(again.requestCharge);

    // Stopping a cook that is not in the caller's partition is a miss.
    const miss = await repository.stopCook(`user-${randomUUID()}`, cook.id, endTime);
    expect(miss).toMatchObject({ cook: undefined, transitioned: false });
  });

  it('concurrent stops converge on one endTime under real If-Match', async () => {
    const userId = `user-${randomUUID()}`;
    const cook = newCook(userId);
    await repository.startCook(cook);
    const endTimes = [1, 2, 3].map(minutes =>
      new Date(Date.now() + minutes * 60_000).toISOString()
    );

    const results = await Promise.all(
      endTimes.map(endTime => repository.stopCook(userId, cook.id, endTime))
    );

    expect(results.filter(result => result.transitioned)).toHaveLength(1);
    const winner = results.find(result => result.transitioned)!.cook!.endTime;
    for (const result of results) {
      expect(result.cook).toMatchObject({ status: 'completed', endTime: winner });
    }
    expect((await repository.getCook(userId, cook.id)).cook?.endTime).toBe(winner);
  });

  it("lists only that user's cooks, newest first, paged by continuation token", async () => {
    const userId = `user-${randomUUID()}`;
    const otherUserId = `user-${randomUUID()}`;
    const base = Date.parse('2026-01-01T00:00:00.000Z');
    const cooks = [0, 1, 2, 3, 4].map(hour =>
      newCook(userId, { startTime: new Date(base + hour * 3_600_000).toISOString() })
    );
    for (const cook of cooks) {
      await repository.startCook(cook);
    }
    // Another user's cooks, and a lock doc in this user's partition (every
    // started cook holds one), must not appear.
    await repository.startCook(newCook(otherUserId));
    await repository.startCook(newCook(otherUserId));

    const pages: Array<{ ids: string[]; continuationToken?: string }> = [];
    let continuationToken: string | undefined;
    do {
      const page = await repository.listCooksByUser(userId, { maxItemCount: 2, continuationToken });
      expectPositiveCharge(page.requestCharge);
      for (const cook of page.cooks) {
        expect(cook.userId).toBe(userId);
        expect(systemKeys(cook)).toEqual([]);
      }
      pages.push({
        ids: page.cooks.map(cook => cook.id),
        continuationToken: page.continuationToken,
      });
      continuationToken = page.continuationToken;
    } while (continuationToken && pages.length < 10);

    expect(pages.map(page => page.ids.length)).toEqual([2, 2, 1]);
    expect(pages[pages.length - 1].continuationToken).toBeUndefined();
    const newestFirst = [...cooks].reverse().map(cook => cook.id);
    expect(pages.flatMap(page => page.ids)).toEqual(newestFirst);

    const other = await repository.listCooksByUser(otherUserId);
    expect(other.cooks).toHaveLength(2);
    expect(other.cooks.every(cook => cook.userId === otherUserId)).toBe(true);
    expectPositiveCharge(other.requestCharge);
  });
  it('MG-87: filters by deviceId and status, never returning a lock document', async () => {
    const userId = `user-${randomUUID()}`;
    const deviceX = `grill-x-${randomUUID().slice(0, 8)}`;
    const deviceY = `grill-y-${randomUUID().slice(0, 8)}`;
    const base = Date.parse('2026-02-01T00:00:00.000Z');
    const at = (hour: number) => new Date(base + hour * 3_600_000).toISOString();

    // Device X: two completed cooks, then one active (which holds X's lock).
    const xDoneOld = newCook(userId, { deviceId: deviceX, startTime: at(0) });
    const xDoneNew = newCook(userId, { deviceId: deviceX, startTime: at(1) });
    const xActive = newCook(userId, { deviceId: deviceX, startTime: at(4) });
    // Device Y: one completed cook, then one active (which holds Y's lock).
    const yDone = newCook(userId, { deviceId: deviceY, startTime: at(2) });
    const yActive = newCook(userId, { deviceId: deviceY, startTime: at(3) });

    for (const cook of [xDoneOld, xDoneNew, yDone]) {
      expect((await repository.startCook(cook)).outcome).toBe('created');
      await repository.stopCook(userId, cook.id, new Date().toISOString());
    }
    for (const cook of [xActive, yActive]) {
      expect((await repository.startCook(cook)).outcome).toBe('created');
    }
    // Another caller's active cook on device X must never appear.
    await repository.startCook(newCook(`user-${randomUUID()}`, { deviceId: deviceX }));

    // The partition really does hold both active-device lock documents.
    const locks = (await partitionDocuments(container, userId)).filter(
      doc => doc.docType === ACTIVE_DEVICE_LOCK_DOC_TYPE
    );
    expect(locks.map(doc => doc.id).sort()).toEqual(
      [activeDeviceLockId(deviceX), activeDeviceLockId(deviceY)].sort()
    );
    const lockIds = new Set(locks.map(doc => doc.id));

    /** Every id the filtered list returns, across all pages, newest first. */
    async function listIds(filters: { deviceId?: string; status?: Cook['status'] }) {
      const ids: string[] = [];
      let continuationToken: string | undefined;
      let pages = 0;
      do {
        const page = await repository.listCooksByUser(userId, {
          ...filters,
          maxItemCount: 2,
          continuationToken,
        });
        expectPositiveCharge(page.requestCharge);
        for (const cook of page.cooks) {
          expect(cook.userId).toBe(userId);
          expect(lockIds.has(cook.id)).toBe(false);
          expect((cook as unknown as { docType?: string }).docType).toBeUndefined();
          if (filters.deviceId !== undefined) expect(cook.deviceId).toBe(filters.deviceId);
          if (filters.status !== undefined) expect(cook.status).toBe(filters.status);
        }
        ids.push(...page.cooks.map(cook => cook.id));
        continuationToken = page.continuationToken;
        pages += 1;
      } while (continuationToken && pages < 10);
      return ids;
    }

    // The data-pusher's reconcile query: only X's active cook.
    expect(await listIds({ deviceId: deviceX, status: 'active' })).toEqual([xActive.id]);
    // Each single filter returns exactly the matching cooks, newest first.
    expect(await listIds({ deviceId: deviceX })).toEqual([xActive.id, xDoneNew.id, xDoneOld.id]);
    expect(await listIds({ deviceId: deviceY })).toEqual([yActive.id, yDone.id]);
    expect(await listIds({ status: 'active' })).toEqual([xActive.id, yActive.id]);
    expect(await listIds({ status: 'completed' })).toEqual([yDone.id, xDoneNew.id, xDoneOld.id]);
    // No filter: all five cooks and still no lock document.
    expect(await listIds({})).toEqual([xActive.id, yActive.id, yDone.id, xDoneNew.id, xDoneOld.id]);
    // Filters that match nothing return an empty page, not an error.
    expect(await listIds({ deviceId: deviceY, status: 'paused' })).toEqual([]);
    expect(await listIds({ deviceId: `grill-${randomUUID()}` })).toEqual([]);
  });
});
