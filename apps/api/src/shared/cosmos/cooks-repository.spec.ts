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

  describe('createCook — write addressed by the /userId partition', () => {
    it('creates the document (partition value = the cook userId) and returns the RU charge', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.createResponse = { resource: sampleCook(), requestCharge: 6.29 };
      const repo = new mod.CooksRepository(container);

      const result = await repo.createCook(sampleCook());

      expect(calls.creates).toHaveLength(1);
      expect(calls.creates[0].userId).toBe(USER_A);
      expect(result.cook?.userId).toBe(USER_A);
      expect(result.requestCharge).toBe(6.29);
      // No cross-partition read path was touched.
      expect(calls.readAll).toBe(0);
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

      // Both the read and the replace addressed the same single partition.
      expect(calls.itemAddresses).toEqual([
        { id: 'cook-1', partitionKey: USER_A },
        { id: 'cook-1', partitionKey: USER_A },
      ]);
      expect(calls.replaces).toHaveLength(1);
      expect(calls.replaces[0].status).toBe('completed');
      expect(calls.replaces[0].endTime).toBe('2026-08-24T20:00:00Z');
      expect(calls.replaces[0].userId).toBe(USER_A);
      expect(result.cook?.status).toBe('completed');
      // RU sums read + write.
      expect(result.requestCharge).toBeCloseTo(6.5);
    });

    it('a cook absent in the caller partition is a 404 miss — no write is issued', async () => {
      const { container, calls, staged } = fakeContainer();
      staged.readResponse = { resource: undefined, statusCode: 404, requestCharge: 1 };
      const repo = new mod.CooksRepository(container);

      const result = await repo.stopCook(USER_A, 'missing', '2026-08-24T20:00:00Z');

      expect(result.cook).toBeUndefined();
      expect(calls.replaces).toHaveLength(0);
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
      // RU sums both reads (the failed write threw before charging).
      expect(result.requestCharge).toBeCloseTo(2.3);
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
