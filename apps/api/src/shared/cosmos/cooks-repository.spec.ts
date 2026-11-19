/**
 * MG-59 — the cooks data-access repository, tested with NO Azure and NO
 * credentials. The container is a fake that records exactly how it was
 * addressed, so these tests hold the throughput- and tenancy-critical
 * properties: every operation is single-partition on `/userId`, no
 * cross-partition scan is ever issued, pagination is continuation-token (never
 * offset), the stop transition mutates the correctly-addressed document, and the
 * RU charge is read from the response for measurement.
 *
 * The repository's factory (getCooksRepository) imports the shared adapter,
 * whose module-load config guard throws without env. So, exactly as the adapter
 * spec does, valid env is arranged BEFORE the module is required; the tests then
 * inject a fake container into the CooksRepository class and never touch Azure.
 */
import type { Container } from '@azure/cosmos';
import type { Cook } from '@meatgeekv2/api-interfaces';

import type { ListCooksOptions } from './cooks-repository';

const VALID_ENV = {
  COSMOSDB__accountEndpoint: 'https://mgv2-secret-account.documents.azure.com/',
  COSMOSDB_DATABASE_NAME: 'meatgeek-v2-dev-db',
  COSMOSDB_COOKS_CONTAINER_NAME: 'cooks',
};

function loadModule(): typeof import('./cooks-repository') {
  jest.resetModules();
  for (const [key, value] of Object.entries(VALID_ENV)) {
    process.env[key] = value;
  }
  return require('./cooks-repository') as typeof import('./cooks-repository');
}

const USER_A = 'principal-oid-aaaa';
const USER_B = 'principal-oid-bbbb';

function sampleCook(overrides: Partial<Cook> = {}): Cook {
  return {
    id: 'cook-1',
    userId: USER_A,
    deviceId: 'meatgeek3',
    name: 'Weekend Brisket',
    status: 'active',
    startTime: '2026-08-24T06:00:00Z',
    meatType: 'brisket',
    ...overrides,
  };
}

/**
 * A fake cooks container that records every address it was handed and lets a
 * test stage what a read/create/replace/query returns. It faithfully models the
 * shapes the repository reads: ItemResponse-ish `{ resource, statusCode,
 * requestCharge }` and FeedResponse-ish `{ resources, hasMoreResults,
 * continuationToken, requestCharge }`.
 */
function fakeContainer() {
  const calls = {
    itemAddresses: [] as Array<{ id: string; partitionKey: unknown }>,
    reads: 0,
    replaces: [] as Cook[],
    replaceOptions: [] as unknown[],
    creates: [] as Cook[],
    batches: [] as Array<{ operations: Array<Record<string, unknown>>; partitionKey: unknown }>,
    queries: [] as Array<{
      spec: unknown;
      options: {
        partitionKey?: unknown;
        maxItemCount?: number;
        continuationToken?: string;
        offset?: unknown;
      };
    }>,
    readAll: 0,
  };

  const staged = {
    readResponse: undefined as
      | { resource?: Cook; statusCode?: number; requestCharge?: number; etag?: string }
      | undefined,
    // A sequence of reads, consumed one per read() call. When non-empty it takes
    // precedence over readResponse — used to model a document that CHANGES between
    // a stop's read and its optimistic-concurrency retry.
    readResponses: [] as Array<{
      resource?: Cook;
      statusCode?: number;
      requestCharge?: number;
      etag?: string;
    }>,
    readError: undefined as unknown,
    createResponse: undefined as { resource?: Cook; requestCharge?: number } | undefined,
    replaceResponse: undefined as { resource?: Cook; requestCharge?: number } | undefined,
    // A sequence of errors, consumed one per replace() call; a truthy entry is
    // thrown (used to model a 412 Precondition Failed from a lost If-Match race).
    replaceErrors: [] as unknown[],
    // MG-84 device locks, keyed by lock id. Reads of an `active-device:` id are
    // answered from here (404 when absent) and never consume readResponses.
    locks: new Map<string, { resource: Record<string, unknown>; etag?: string }>(),
    // A sequence of per-operation batch results, consumed one per batch() call.
    // When empty, every operation succeeds and echoes its body.
    batchResults: [] as Array<Array<{ statusCode: number; requestCharge?: number }>>,
    queryResponse: {
      resources: [] as Cook[],
      hasMoreResults: false,
      continuationToken: undefined as string | undefined,
      requestCharge: 0,
    },
  };

  const item = (id: string, partitionKey: unknown) => {
    calls.itemAddresses.push({ id, partitionKey });
    return {
      read: async <T>() => {
        calls.reads += 1;
        if (staged.readError) throw staged.readError;
        if (id.startsWith('active-device:')) {
          const lock = staged.locks.get(id);
          return {
            resource: lock?.resource as T | undefined,
            statusCode: lock ? 200 : 404,
            etag: lock?.etag,
            requestCharge: 1,
          };
        }
        const r =
          staged.readResponses.length > 0
            ? staged.readResponses.shift()!
            : (staged.readResponse ?? { resource: undefined, statusCode: 404, requestCharge: 1 });
        return {
          resource: r.resource as T | undefined,
          statusCode: r.statusCode ?? (r.resource ? 200 : 404),
          etag: r.etag,
          requestCharge: r.requestCharge ?? 1,
        };
      },
      replace: async <T>(body: Cook, options?: unknown) => {
        calls.replaces.push(body);
        calls.replaceOptions.push(options);
        if (staged.replaceErrors.length > 0) {
          const err = staged.replaceErrors.shift();
          if (err) throw err;
        }
        const r = staged.replaceResponse ?? { resource: body, requestCharge: 5 };
        return { resource: (r.resource ?? body) as T, requestCharge: r.requestCharge ?? 5 };
      },
    };
  };

  const items = {
    create: async <T>(body: Cook) => {
      calls.creates.push(body);
      const r = staged.createResponse ?? { resource: body, requestCharge: 7 };
      return { resource: (r.resource ?? body) as T, requestCharge: r.requestCharge ?? 7 };
    },
    batch: async (operations: Array<Record<string, unknown>>, partitionKey: unknown) => {
      calls.batches.push({ operations, partitionKey });
      const staged_ = staged.batchResults.shift();
      const result = operations.map((operation, index) => {
        const statusCode =
          staged_?.[index]?.statusCode ?? (operation['operationType'] === 'Create' ? 201 : 200);
        const ok = statusCode >= 200 && statusCode <= 299;
        return {
          statusCode,
          requestCharge: staged_?.[index]?.requestCharge ?? (ok ? 6 : 1),
          resourceBody: ok ? operation['resourceBody'] : undefined,
        };
      });
      const failed = result.some(({ statusCode }) => statusCode < 200 || statusCode > 299);
      return { code: failed ? 207 : 200, result };
    },
    query: <T>(spec: unknown, options: (typeof calls.queries)[number]['options']) => {
      calls.queries.push({ spec, options });
      return {
        fetchNext: async () => ({
          resources: staged.queryResponse.resources as T[],
          hasMoreResults: staged.queryResponse.hasMoreResults,
          continuationToken: staged.queryResponse.continuationToken,
          requestCharge: staged.queryResponse.requestCharge,
        }),
        // Present so a test can prove the repository NEVER calls it.
        fetchAll: async () => {
          calls.readAll += 1;
          return { resources: [], requestCharge: 0 };
        },
      };
    },
    // Present so a test can prove the repository NEVER reads the whole container.
    readAll: () => {
      calls.readAll += 1;
      return { fetchAll: async () => ({ resources: [], requestCharge: 0 }) };
    },
  };

  const container = { item, items } as unknown as Container;
  return { container, calls, staged };
}

describe('MG-59 cooks repository', () => {
  const savedEnv = { ...process.env };
  let mod: typeof import('./cooks-repository');

  beforeAll(() => {
    mod = loadModule();
  });

  afterAll(() => {
    process.env = { ...savedEnv };
    jest.resetModules();
  });

  describe('MG-84 startCook — cook and device lock in one transactional batch', () => {
    const COOK_ID = '6f1c2b8e-3d4a-4f6b-9c7d-0e1f2a3b4c5d';
    const LOCK_ID = 'active-device:meatgeek3';
    const newCook = () => sampleCook({ id: COOK_ID });
    const lockFor = (cookId: string) => ({
      id: LOCK_ID,
      userId: USER_A,
      docType: 'activeDeviceLock',
      deviceId: 'meatgeek3',
      cookId,
    });

    it('creates the cook and the device lock in one batch in the caller partition', async () => {
      const { container, calls } = fakeContainer();
      const repo = new mod.CooksRepository(container);

      const result = await repo.startCook(newCook());

      expect(calls.batches).toHaveLength(1);
      expect(calls.batches[0].partitionKey).toBe(USER_A);
      expect(calls.batches[0].operations).toEqual([
        { operationType: 'Create', resourceBody: newCook() },
        { operationType: 'Create', resourceBody: lockFor(COOK_ID) },
      ]);
      expect(result).toEqual({ outcome: 'created', cook: newCook(), requestCharge: 12 });
      expect(mod.activeDeviceLockId('meatgeek3')).toBe(LOCK_ID);
      // Characters Cosmos forbids in an id are encoded.
      expect(mod.activeDeviceLockId('rack/1?#\\')).toBe('active-device:rack%2F1%3F%23%5C');
      // No single-document create bypasses the lock.
      expect(calls.creates).toHaveLength(0);
      expect(calls.readAll).toBe(0);
    });

    it('a 409 on the cook (retry or concurrent duplicate) is a replay of the stored cook — no second batch', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.batchResults = [[{ statusCode: 409 }, { statusCode: 424 }]];
      staged.readResponse = { resource: newCook(), statusCode: 200, requestCharge: 1 };
      const repo = new mod.CooksRepository(container);

      const result = await repo.startCook(newCook());

      expect(result.outcome).toBe('replayed');
      expect(result.outcome === 'replayed' && result.cook).toEqual(newCook());
      expect(calls.batches).toHaveLength(1);
      expect(calls.itemAddresses).toEqual([{ id: COOK_ID, partitionKey: USER_A }]);
    });

    it('a device held by a non-terminal cook is busy — reports the holder and writes nothing more', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.batchResults = [[{ statusCode: 424 }, { statusCode: 409 }]];
      staged.locks.set(LOCK_ID, { resource: lockFor('cook-0'), etag: 'lock-v1' });
      staged.readResponse = {
        resource: sampleCook({ id: 'cook-0', status: 'paused' }),
        statusCode: 200,
      };
      const repo = new mod.CooksRepository(container);

      const result = await repo.startCook(newCook());

      expect(result).toEqual({ outcome: 'deviceBusy', activeCookId: 'cook-0', requestCharge: 4 });
      expect(calls.batches).toHaveLength(1);
    });

    it.each([
      ['completed', { resource: sampleCook({ id: 'cook-0', status: 'completed' }) }],
      ['cancelled', { resource: sampleCook({ id: 'cook-0', status: 'cancelled' }) }],
      ['missing', { resource: undefined, statusCode: 404 }],
    ])(
      'a stale lock (holder %s) is taken over under If-Match on the lock version read',
      async (_label, holderRead) => {
        const { container, calls, staged } = fakeContainer();
        staged.batchResults = [[{ statusCode: 424 }, { statusCode: 409 }]];
        staged.locks.set(LOCK_ID, { resource: lockFor('cook-0'), etag: 'lock-v1' });
        staged.readResponse = holderRead;
        const repo = new mod.CooksRepository(container);

        const result = await repo.startCook(newCook());

        expect(result.outcome).toBe('created');
        expect(calls.batches).toHaveLength(2);
        expect(calls.batches[1].operations[1]).toEqual({
          operationType: 'Replace',
          id: LOCK_ID,
          resourceBody: lockFor(COOK_ID),
          ifMatch: 'lock-v1',
        });
      }
    );

    it('a lock that vanished between the batch and the read is created on the next batch', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.batchResults = [[{ statusCode: 424 }, { statusCode: 409 }]];
      const repo = new mod.CooksRepository(container);

      const result = await repo.startCook(newCook());

      expect(result.outcome).toBe('created');
      expect(calls.batches).toHaveLength(2);
      expect(calls.batches[1].operations[1]).toEqual({
        operationType: 'Create',
        resourceBody: lockFor(COOK_ID),
      });
    });

    it('a lock that keeps changing under us is bounded and propagates the status', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.batchResults = Array.from({ length: mod.START_COOK_MAX_ATTEMPTS }, () => [
        { statusCode: 424 },
        { statusCode: 412 },
      ]);
      staged.locks.set(LOCK_ID, { resource: lockFor('cook-0'), etag: 'lock-v1' });
      staged.readResponse = { resource: undefined, statusCode: 404 };
      const repo = new mod.CooksRepository(container);

      await expect(repo.startCook(newCook())).rejects.toMatchObject({ statusCode: 412 });
      expect(calls.batches).toHaveLength(mod.START_COOK_MAX_ATTEMPTS);
    });

    it('any other batch failure propagates without a retry (the handler sanitises it)', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.batchResults = [[{ statusCode: 429 }, { statusCode: 424 }]];
      const repo = new mod.CooksRepository(container);

      await expect(repo.startCook(newCook())).rejects.toMatchObject({ statusCode: 429 });
      expect(calls.batches).toHaveLength(1);
    });
  });

  describe('getCook — single-partition point read', () => {
    it('addresses the document by (id, userId) — no cross-partition scan', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.readResponse = { resource: sampleCook(), statusCode: 200, requestCharge: 1.0 };
      const repo = new mod.CooksRepository(container);

      const result = await repo.getCook(USER_A, 'cook-1');

      expect(calls.itemAddresses).toEqual([{ id: 'cook-1', partitionKey: USER_A }]);
      expect(calls.reads).toBe(1);
      expect(calls.readAll).toBe(0);
      expect(result.cook?.id).toBe('cook-1');
      expect(result.requestCharge).toBe(1.0);
    });

    it('a 404 (absent in the partition) is a miss, not a throw', async () => {
      const { container, staged } = fakeContainer();
      staged.readResponse = { resource: undefined, statusCode: 404, requestCharge: 1 };
      const repo = new mod.CooksRepository(container);

      const result = await repo.getCook(USER_A, 'missing');

      expect(result.cook).toBeUndefined();
    });

    it('a 404 raised as an error is also a miss, not a throw', async () => {
      const { container, staged } = fakeContainer();
      staged.readError = { code: 404, message: 'Not Found' };
      const repo = new mod.CooksRepository(container);

      const result = await repo.getCook(USER_A, 'missing');
      expect(result.cook).toBeUndefined();
    });

    it('a wrong-partition read cannot reach another user document — addressing uses the passed userId only', async () => {
      const { container, calls, staged } = fakeContainer();
      // The container is asked for USER_B's partition; it holds nothing there.
      staged.readResponse = { resource: undefined, statusCode: 404, requestCharge: 1 };
      const repo = new mod.CooksRepository(container);

      const result = await repo.getCook(USER_B, 'cook-1');

      expect(calls.itemAddresses).toEqual([{ id: 'cook-1', partitionKey: USER_B }]);
      expect(result.cook).toBeUndefined();
    });

    it('a non-404 Cosmos error propagates (handler sanitises it)', async () => {
      const { container, staged } = fakeContainer();
      staged.readError = { code: 503, message: 'Service Unavailable' };
      const repo = new mod.CooksRepository(container);

      await expect(repo.getCook(USER_A, 'cook-1')).rejects.toBeDefined();
    });
  });

  describe('stopCook — read-then-update on the correctly-addressed document', () => {
    it('transitions status to completed, sets endTime, and replaces the (id, userId) document', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.readResponse = { resource: sampleCook(), statusCode: 200, requestCharge: 1.1 };
      staged.replaceResponse = { requestCharge: 5.4 };
      const repo = new mod.CooksRepository(container);

      const result = await repo.stopCook(USER_A, 'cook-1', '2026-08-24T20:00:00Z');

      // The read, the device-lock read (MG-84) and the replace all addressed the
      // same single partition.
      expect(calls.itemAddresses).toEqual([
        { id: 'cook-1', partitionKey: USER_A },
        { id: 'active-device:meatgeek3', partitionKey: USER_A },
        { id: 'cook-1', partitionKey: USER_A },
      ]);
      expect(calls.replaces).toHaveLength(1);
      expect(calls.replaces[0].status).toBe('completed');
      expect(calls.replaces[0].endTime).toBe('2026-08-24T20:00:00Z');
      expect(calls.replaces[0].userId).toBe(USER_A);
      expect(result.cook?.status).toBe('completed');
      expect(result.transitioned).toBe(true);
      // RU sums read + lock read + write.
      expect(result.requestCharge).toBeCloseTo(7.5);
    });

    it('a cook absent in the caller partition is a 404 miss — no write is issued', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.readResponse = { resource: undefined, statusCode: 404, requestCharge: 1 };
      const repo = new mod.CooksRepository(container);

      const result = await repo.stopCook(USER_A, 'missing', '2026-08-24T20:00:00Z');

      expect(result.cook).toBeUndefined();
      expect(result.transitioned).toBe(false);
      expect(calls.replaces).toHaveLength(0);
    });

    it('an already-completed cook (a retried stop) is returned as-is with transitioned=false — no write', async () => {
      const { container, calls, staged } = fakeContainer();
      const firstEndTime = '2026-08-24T20:00:00Z';
      staged.readResponse = {
        resource: sampleCook({ status: 'completed', endTime: firstEndTime }),
        statusCode: 200,
        requestCharge: 1,
        etag: 'etag-v2',
      };
      const repo = new mod.CooksRepository(container);

      const result = await repo.stopCook(USER_A, 'cook-1', '2026-08-24T21:00:00Z');

      expect(calls.replaces).toHaveLength(0);
      expect(result.cook?.endTime).toBe(firstEndTime);
      expect(result.transitioned).toBe(false);
    });

    it('writes with an If-Match on the ETag it read (optimistic concurrency)', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.readResponse = {
        resource: sampleCook(),
        statusCode: 200,
        requestCharge: 1.1,
        etag: 'etag-v1',
      };
      staged.replaceResponse = { requestCharge: 5.4 };
      const repo = new mod.CooksRepository(container);

      await repo.stopCook(USER_A, 'cook-1', '2026-08-24T20:00:00Z');

      // The conditional write pins the version read, so a concurrent writer that
      // changed the document since is rejected rather than silently overwritten.
      expect(calls.replaceOptions).toHaveLength(1);
      expect(calls.replaceOptions[0]).toEqual({
        accessCondition: { type: 'IfMatch', condition: 'etag-v1' },
      });
    });

    it('a concurrent stop (412 on the conditional write) re-reads and returns the winner’s final state without a lost update', async () => {
      const { container, calls, staged } = fakeContainer();
      // Attempt 1 reads the active cook; the conditional replace loses the race
      // (412). Attempt 2 re-reads and finds the document already completed by the
      // winner — stamped with the WINNER's endTime, not ours.
      const winnerEndTime = '2026-08-24T20:00:00Z';
      staged.readResponses = [
        { resource: sampleCook(), statusCode: 200, requestCharge: 1.1, etag: 'etag-v1' },
        {
          resource: sampleCook({ status: 'completed', endTime: winnerEndTime }),
          statusCode: 200,
          requestCharge: 1.2,
          etag: 'etag-v2',
        },
      ];
      staged.replaceErrors = [Object.assign(new Error('Precondition Failed'), { statusCode: 412 })];
      const repo = new mod.CooksRepository(container);

      const result = await repo.stopCook(USER_A, 'cook-1', '2026-08-24T21:59:59Z');

      // Exactly one replace was attempted (the one that lost); the retry short-
      // circuited on the already-completed guard rather than clobbering endTime.
      expect(calls.replaces).toHaveLength(1);
      expect(result.cook?.status).toBe('completed');
      // No lost update: our later endTime did NOT overwrite the winner's.
      expect(result.cook?.endTime).toBe(winnerEndTime);
      // The loser performed no transition, so it must not announce one.
      expect(result.transitioned).toBe(false);
      // RU sums both reads and the one lock read (the failed write threw before
      // charging; the second attempt stopped at the completed guard).
      expect(result.requestCharge).toBeCloseTo(3.3);
    });

    it('sustained write contention (repeated 412) is bounded and propagates for the handler to sanitise', async () => {
      const { container, calls, staged } = fakeContainer();
      // Every read returns the active cook; every conditional write loses. The
      // loop must give up after STOP_COOK_MAX_ATTEMPTS rather than spin forever.
      staged.readResponse = {
        resource: sampleCook(),
        statusCode: 200,
        requestCharge: 1,
        etag: 'etag-v1',
      };
      staged.replaceErrors = Array.from({ length: mod.STOP_COOK_MAX_ATTEMPTS }, () =>
        Object.assign(new Error('Precondition Failed'), { statusCode: 412 })
      );
      const repo = new mod.CooksRepository(container);

      await expect(repo.stopCook(USER_A, 'cook-1', '2026-08-24T20:00:00Z')).rejects.toBeDefined();
      expect(calls.replaces).toHaveLength(mod.STOP_COOK_MAX_ATTEMPTS);
    });
  });

  describe('MG-84 stopCook — releases the device lock with the stop', () => {
    const LOCK_ID = 'active-device:meatgeek3';
    const lockFor = (cookId: string) => ({
      id: LOCK_ID,
      userId: USER_A,
      docType: 'activeDeviceLock',
      deviceId: 'meatgeek3',
      cookId,
    });

    it('a cook holding its lock is stopped and the lock deleted in one batch, under If-Match', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.readResponse = { resource: sampleCook(), statusCode: 200, etag: 'etag-v1' };
      staged.locks.set(LOCK_ID, { resource: lockFor('cook-1'), etag: 'lock-v1' });
      const repo = new mod.CooksRepository(container);

      const result = await repo.stopCook(USER_A, 'cook-1', '2026-08-24T20:00:00Z');

      expect(calls.replaces).toHaveLength(0);
      expect(calls.batches).toEqual([
        {
          partitionKey: USER_A,
          operations: [
            {
              operationType: 'Replace',
              id: 'cook-1',
              resourceBody: sampleCook({ status: 'completed', endTime: '2026-08-24T20:00:00Z' }),
              ifMatch: 'etag-v1',
            },
            { operationType: 'Delete', id: LOCK_ID },
          ],
        },
      ]);
      expect(result.transitioned).toBe(true);
      expect(result.cook).toEqual(
        sampleCook({ status: 'completed', endTime: '2026-08-24T20:00:00Z' })
      );
    });

    it('a lock held by a different cook is left alone (plain conditional replace)', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.readResponse = { resource: sampleCook(), statusCode: 200, etag: 'etag-v1' };
      staged.locks.set(LOCK_ID, { resource: lockFor('cook-other'), etag: 'lock-v1' });
      const repo = new mod.CooksRepository(container);

      const result = await repo.stopCook(USER_A, 'cook-1', '2026-08-24T20:00:00Z');

      expect(calls.batches).toHaveLength(0);
      expect(calls.replaces).toHaveLength(1);
      expect(result.transitioned).toBe(true);
    });

    it('a concurrent stop (412 in the batch) re-reads and returns the winner without a second transition', async () => {
      const { container, calls, staged } = fakeContainer();
      const winnerEndTime = '2026-08-24T20:00:00Z';
      staged.readResponses = [
        { resource: sampleCook(), statusCode: 200, etag: 'etag-v1' },
        {
          resource: sampleCook({ status: 'completed', endTime: winnerEndTime }),
          statusCode: 200,
          etag: 'etag-v2',
        },
      ];
      staged.locks.set(LOCK_ID, { resource: lockFor('cook-1'), etag: 'lock-v1' });
      staged.batchResults = [[{ statusCode: 412 }, { statusCode: 424 }]];
      const repo = new mod.CooksRepository(container);

      const result = await repo.stopCook(USER_A, 'cook-1', '2026-08-24T21:00:00Z');

      expect(calls.batches).toHaveLength(1);
      expect(result.transitioned).toBe(false);
      expect(result.cook?.endTime).toBe(winnerEndTime);
    });

    it('a non-retryable batch failure propagates for the handler to sanitise', async () => {
      const { container, staged } = fakeContainer();
      staged.readResponse = { resource: sampleCook(), statusCode: 200, etag: 'etag-v1' };
      staged.locks.set(LOCK_ID, { resource: lockFor('cook-1'), etag: 'lock-v1' });
      staged.batchResults = [[{ statusCode: 429 }, { statusCode: 424 }]];
      const repo = new mod.CooksRepository(container);

      await expect(repo.stopCook(USER_A, 'cook-1', '2026-08-24T20:00:00Z')).rejects.toMatchObject({
        statusCode: 429,
      });
    });
  });

  describe('listCooksByUser — single-partition query, continuation-token pagination', () => {
    it('queries a single partition keyed on the userId, with a bounded page size', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.queryResponse = {
        resources: [sampleCook()],
        hasMoreResults: true,
        continuationToken: 'ct-next',
        requestCharge: 2.71,
      };
      const repo = new mod.CooksRepository(container);

      const page = await repo.listCooksByUser(USER_A, { maxItemCount: 25 });

      expect(calls.queries).toHaveLength(1);
      const { spec, options } = calls.queries[0];
      // Single-partition: partitionKey pins the query to the user's partition.
      expect(options.partitionKey).toBe(USER_A);
      expect(options.maxItemCount).toBe(25);
      // The predicate also carries the userId parameter — never a raw filter.
      expect((spec as { parameters: Array<{ name: string; value: unknown }> }).parameters).toEqual([
        { name: '@userId', value: USER_A },
      ]);
      // MG-84: device lock documents share the partition and are never listed.
      expect((spec as { query: string }).query).toContain('NOT IS_DEFINED(c.docType)');
      // Continuation token, not an offset, drives the next page.
      expect(page.continuationToken).toBe('ct-next');
      expect(options).not.toHaveProperty('offset');
      expect(page.requestCharge).toBe(2.71);
      // No ReadAll / cross-partition fan-out.
      expect(calls.readAll).toBe(0);
    });

    it('clamps an unbounded/huge page size to the shared-pool cap', async () => {
      const { container, calls } = fakeContainer();
      const repo = new mod.CooksRepository(container);

      await repo.listCooksByUser(USER_A, { maxItemCount: 100000 });

      expect(calls.queries[0].options.maxItemCount).toBe(mod.MAX_PAGE_SIZE);
    });

    it('defaults the page size when none is supplied', async () => {
      const { container, calls } = fakeContainer();
      const repo = new mod.CooksRepository(container);

      await repo.listCooksByUser(USER_A);

      expect(calls.queries[0].options.maxItemCount).toBe(mod.DEFAULT_PAGE_SIZE);
    });

    it('passes the caller continuation token through unchanged', async () => {
      const { container, calls } = fakeContainer();
      const repo = new mod.CooksRepository(container);

      await repo.listCooksByUser(USER_A, { continuationToken: 'ct-prev' });

      expect(calls.queries[0].options.continuationToken).toBe('ct-prev');
    });

    it('omits the continuation token when the partition is fully drained', async () => {
      const { container, staged } = fakeContainer();
      staged.queryResponse = {
        resources: [sampleCook()],
        hasMoreResults: false,
        continuationToken: 'ignored-when-drained',
        requestCharge: 2.0,
      };
      const repo = new mod.CooksRepository(container);

      const page = await repo.listCooksByUser(USER_A);
      expect(page.continuationToken).toBeUndefined();
    });

    it('the query is scoped by userId alone — a second user gets a different partition, never a widened scan', async () => {
      const { container, calls } = fakeContainer();
      const repo = new mod.CooksRepository(container);

      await repo.listCooksByUser(USER_B);

      expect(calls.queries[0].options.partitionKey).toBe(USER_B);
      expect(calls.readAll).toBe(0);
    });

    describe('MG-87 — deviceId / status filters', () => {
      type Spec = { query: string; parameters: Array<{ name: string; value: unknown }> };

      async function specFor(options: ListCooksOptions) {
        const { container, calls } = fakeContainer();
        await new mod.CooksRepository(container).listCooksByUser(USER_A, options);
        expect(calls.queries[0].options.partitionKey).toBe(USER_A);
        return calls.queries[0].spec as Spec;
      }

      it('adds no filter predicate when neither is given', async () => {
        const spec = await specFor({});
        expect(spec.query).toBe(
          'SELECT * FROM c WHERE c.userId = @userId AND NOT IS_DEFINED(c.docType) ' +
            'ORDER BY c.startTime DESC'
        );
      });

      it('binds both filters as parameters, ANDed, keeping the lock exclusion and order', async () => {
        const hostile = "x' OR 1=1 --";
        const spec = await specFor({ deviceId: hostile, status: 'active' });
        expect(spec.query).toBe(
          'SELECT * FROM c WHERE c.userId = @userId AND NOT IS_DEFINED(c.docType) ' +
            'AND c.deviceId = @deviceId AND c.status = @status ORDER BY c.startTime DESC'
        );
        // Caller input reaches Cosmos only as a parameter value, never as SQL.
        expect(spec.query).not.toContain(hostile);
        expect(spec.parameters).toEqual([
          { name: '@userId', value: USER_A },
          { name: '@deviceId', value: hostile },
          { name: '@status', value: 'active' },
        ]);
      });

      it('binds deviceId alone', async () => {
        const spec = await specFor({ deviceId: 'grill-1' });
        expect(spec.query).toContain('AND c.deviceId = @deviceId ORDER BY');
        expect(spec.query).not.toContain('@status');
        expect(spec.parameters).toContainEqual({ name: '@deviceId', value: 'grill-1' });
      });

      it('binds status alone', async () => {
        const spec = await specFor({ status: 'completed' });
        expect(spec.query).toContain('AND c.status = @status ORDER BY');
        expect(spec.query).not.toContain('@deviceId');
        expect(spec.parameters).toContainEqual({ name: '@status', value: 'completed' });
      });
    });
  });

  describe('MG-85 — every returned cook is projected to the api-interfaces Cook shape', () => {
    /** The document as Cosmos returns it: contract fields plus system properties
     *  (and, for a migrated document, a field the contract does not model). */
    function storedCook(overrides: Partial<Cook> = {}): Cook {
      return {
        ...sampleCook(overrides),
        _rid: 'Zm9vAA==',
        _self: 'dbs/Zm9vAA==/colls/Zm9vAA==/docs/Zm9vAA==/',
        _etag: '"00000000-0000-0000-0000-000000000000"',
        _attachments: 'attachments/',
        _ts: 1790000000,
        legacyField: 'not in the contract',
      } as unknown as Cook;
    }

    it('toCook keeps every Cook field and drops everything else', () => {
      const full: Cook = {
        ...sampleCook(),
        endTime: '2026-08-24T18:00:00Z',
        weight: 14,
        targetTemps: { grill: 250, probe1: 203 },
        actualDuration: 12,
        maxTemps: { grill: 270 },
        notes: 'wrapped at 165',
        photos: ['p1.jpg'],
        rating: 5,
        isPublic: false,
      };
      const stored = { ...storedCook(), ...full } as Cook;

      expect(mod.toCook(stored)).toEqual(full);
      // Absent optional fields stay absent — no undefined keys are introduced.
      expect(Object.keys(mod.toCook(sampleCook()))).toEqual(Object.keys(sampleCook()));
    });

    it('startCook returns the projected cook, created or replayed', async () => {
      const { container, staged } = fakeContainer();
      staged.batchResults = [
        [{ statusCode: 201 }, { statusCode: 201 }],
        [{ statusCode: 409 }, { statusCode: 424 }],
      ];
      staged.readResponse = { resource: storedCook(), statusCode: 200, requestCharge: 1 };
      const repo = new mod.CooksRepository(container);

      const created = await repo.startCook(storedCook());
      const replayed = await repo.startCook(storedCook());

      expect(created.outcome === 'created' && created.cook).toEqual(sampleCook());
      expect(replayed.outcome === 'replayed' && replayed.cook).toEqual(sampleCook());
    });

    it('getCook returns the projected cook', async () => {
      const { container, staged } = fakeContainer();
      staged.readResponse = { resource: storedCook(), statusCode: 200, requestCharge: 1 };
      const repo = new mod.CooksRepository(container);

      expect((await repo.getCook(USER_A, 'cook-1')).cook).toEqual(sampleCook());
    });

    it('stopCook replaces the whole stored document but returns the projected cook', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.readResponse = {
        resource: storedCook(),
        statusCode: 200,
        requestCharge: 1,
        etag: '"v1"',
      };
      staged.replaceResponse = {
        resource: storedCook({ status: 'completed', endTime: '2026-08-24T18:00:00Z' }),
        requestCharge: 5,
      };
      const repo = new mod.CooksRepository(container);

      const result = await repo.stopCook(USER_A, 'cook-1', '2026-08-24T18:00:00Z');

      expect(result.cook).toEqual(
        sampleCook({ status: 'completed', endTime: '2026-08-24T18:00:00Z' })
      );
      // The write is not narrowed: a stored field the contract does not model
      // survives the replace.
      expect(calls.replaces[0]).toHaveProperty('legacyField', 'not in the contract');
    });

    it('stopCook on an already-completed cook returns the projected cook', async () => {
      const { container, staged } = fakeContainer();
      staged.readResponse = {
        resource: storedCook({ status: 'completed', endTime: '2026-08-24T18:00:00Z' }),
        statusCode: 200,
        requestCharge: 1,
      };
      const repo = new mod.CooksRepository(container);

      const result = await repo.stopCook(USER_A, 'cook-1', '2026-08-24T19:00:00Z');

      expect(result.transitioned).toBe(false);
      expect(result.cook).toEqual(
        sampleCook({ status: 'completed', endTime: '2026-08-24T18:00:00Z' })
      );
    });

    it('listCooksByUser returns projected cooks', async () => {
      const { container, staged } = fakeContainer();
      staged.queryResponse = {
        resources: [storedCook(), storedCook({ id: 'cook-2' })],
        hasMoreResults: false,
        continuationToken: undefined,
        requestCharge: 3,
      };
      const repo = new mod.CooksRepository(container);

      const page = await repo.listCooksByUser(USER_A);

      expect(page.cooks).toEqual([sampleCook(), sampleCook({ id: 'cook-2' })]);
    });
  });

  describe('sanitization', () => {
    it('the source leaks no account host, key vocabulary, or identity header', () => {
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const fs = require('fs');
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      const path = require('path');
      const source = fs.readFileSync(path.join(__dirname, 'cooks-repository.ts'), 'utf8');
      expect(source).not.toContain('documents.azure.com');
      expect(source).not.toContain('masterKey');
      expect(source).not.toContain('connectionString');
      expect(source).not.toContain('X-IDENTITY-HEADER');
    });
  });
});
