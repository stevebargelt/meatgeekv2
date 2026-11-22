/**
 * HAR-124 — the emulator tier's readiness wait, on a fake database (no emulator).
 *
 * `createEmulatorContainer` and `emulatorTierDatabase` return only once a read of
 * what they created succeeds. They loop on the emulator's 404/1013 "create in
 * progress" answer and on nothing else. Every verdict here waits on the helper's
 * own promise; nothing depends on real time.
 */
import type { ContainerRequest, CosmosClient, Database } from '@azure/cosmos';

import {
  awaitReadable,
  closeEmulatorTier,
  createEmulatorContainer,
  EMULATOR_TIER_DATABASE,
  emulatorTierDatabase,
  isCreateInProgress,
} from './emulator-tier.testing';

/** The shape `@azure/cosmos` throws: `code` is the HTTP status. */
function cosmosError(code: number, substatus?: number, message = `status ${code}`): Error {
  return Object.assign(
    new Error(message),
    substatus === undefined ? { code } : { code, substatus }
  );
}

const createInProgress = () =>
  cosmosError(404, 1013, 'Collection is not yet available for read. Please retry in some time.');

/** Answers each read with the next scripted outcome; the last one repeats. */
function scriptedRead(outcomes: ReadonlyArray<Error | 'ok'>) {
  let calls = 0;
  const read = jest.fn(async () => {
    const outcome = outcomes[Math.min(calls, outcomes.length - 1)];
    calls += 1;
    if (outcome !== 'ok') {
      throw outcome;
    }
    return { resource: {} };
  });
  return read;
}

function fakeDatabase(options: { createError?: Error; read: ReturnType<typeof scriptedRead> }): {
  database: Database;
  createIfNotExists: jest.Mock;
  container: jest.Mock;
} {
  const createIfNotExists = jest.fn(async (request: ContainerRequest) => {
    if (options.createError) {
      throw options.createError;
    }
    return { container: { id: request.id } };
  });
  const container = jest.fn((id: string) => ({ id, read: options.read }));
  const database = {
    id: EMULATOR_TIER_DATABASE,
    containers: { createIfNotExists },
    container,
  } as unknown as Database;
  return { database, createIfNotExists, container };
}

const request: ContainerRequest = { id: 'devices', partitionKey: { paths: ['/id'] } };

describe('HAR-124 emulator tier readiness wait', () => {
  it('matches only 404 with sub-status 1013', () => {
    expect(isCreateInProgress(createInProgress())).toBe(true);
    expect(isCreateInProgress({ statusCode: 404, substatus: '1013' })).toBe(true);
    expect(isCreateInProgress(cosmosError(404))).toBe(false);
    expect(isCreateInProgress(cosmosError(404, 1002))).toBe(false);
    expect(isCreateInProgress(cosmosError(503, 1013))).toBe(false);
    // The message alone is not the signal.
    expect(isCreateInProgress(new Error('Collection is not yet available for read.'))).toBe(false);
    expect(isCreateInProgress(undefined)).toBe(false);
  });

  it.each([
    ['created by this copy', undefined],
    ['created by another copy (409)', cosmosError(409)],
  ])(
    'waits through N "not yet available" answers and then returns: %s',
    async (_case, createError) => {
      const n = 5;
      const read = scriptedRead([...Array.from({ length: n }, createInProgress), 'ok']);
      const { database, createIfNotExists, container } = fakeDatabase({ createError, read });

      await expect(createEmulatorContainer(database, request)).resolves.toBeUndefined();

      expect(createIfNotExists).toHaveBeenCalledWith(request);
      expect(container).toHaveBeenCalledWith('devices');
      expect(read).toHaveBeenCalledTimes(n + 1);
    }
  );

  it('returns after one read when the container is readable at once', async () => {
    const read = scriptedRead(['ok']);
    const { database } = fakeDatabase({ read });
    await createEmulatorContainer(database, request);
    expect(read).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['404 with no sub-status', cosmosError(404)],
    ['503 high demand', cosmosError(503, undefined, 'high demand in this region')],
    ['a network error', Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' })],
  ])('fails at once, naming the container, on any other error: %s', async (_case, error) => {
    const read = scriptedRead([createInProgress(), error, 'ok']);
    const { database } = fakeDatabase({ read });

    const failure = createEmulatorContainer(database, request);

    await expect(failure).rejects.toThrow(
      `container devices in database ${EMULATOR_TIER_DATABASE} did not become readable`
    );
    await expect(failure).rejects.toThrow(error.message);
    expect(read).toHaveBeenCalledTimes(2);
  });

  it('fails at once on a create error other than 409, without reading', async () => {
    const read = scriptedRead(['ok']);
    const { database } = fakeDatabase({ createError: cosmosError(400), read });
    await expect(createEmulatorContainer(database, request)).rejects.toThrow('status 400');
    expect(read).not.toHaveBeenCalled();
  });

  it('waits for the database too, after its own create or a 409', async () => {
    const read = scriptedRead([createInProgress(), createInProgress(), 'ok']);
    const conflicting = {
      databases: {
        createIfNotExists: jest.fn(async () => {
          throw cosmosError(409);
        }),
      },
      database: jest.fn((id: string) => ({ id, read })),
      dispose: jest.fn(),
    };

    const database = await emulatorTierDatabase(conflicting as unknown as CosmosClient);

    expect(database.id).toBe(EMULATOR_TIER_DATABASE);
    expect(conflicting.database).toHaveBeenCalledWith(EMULATOR_TIER_DATABASE);
    expect(read).toHaveBeenCalledTimes(3);
  });

  it('closeEmulatorTier names the container a still-running wait is waiting for, and stops it', async () => {
    // Never readable: the wait would run until Jest's testTimeout.
    const read = scriptedRead([createInProgress()]);
    const { database } = fakeDatabase({ read });
    const client = { dispose: jest.fn() } as unknown as CosmosClient;

    const waiting = createEmulatorContainer(database, request);
    // Let the wait take some "not yet available" answers: it is now in its loop.
    while (read.mock.calls.length < 3) {
      await new Promise(resolve => setImmediate(resolve));
    }

    expect(() => closeEmulatorTier(client)).toThrow(
      `still waiting for container devices in database ${EMULATOR_TIER_DATABASE}`
    );
    expect(client.dispose).toHaveBeenCalledTimes(1);
    // The abandoned wait ends instead of polling a disposed client forever.
    await expect(waiting).resolves.toBeUndefined();
    const readsAtStop = read.mock.calls.length;
    await new Promise(resolve => setImmediate(resolve));
    expect(read).toHaveBeenCalledTimes(readsAtStop);
  });

  it('closeEmulatorTier disposes and passes when no wait is running', async () => {
    await awaitReadable('container ready', scriptedRead(['ok']));
    const client = { dispose: jest.fn() } as unknown as CosmosClient;
    expect(() => closeEmulatorTier(client)).not.toThrow();
    expect(() => closeEmulatorTier(undefined)).not.toThrow();
    expect(client.dispose).toHaveBeenCalledTimes(1);
  });
});
