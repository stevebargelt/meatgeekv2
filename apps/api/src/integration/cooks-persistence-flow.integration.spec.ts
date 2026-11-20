/**
 * MG-59 integration coverage for the cooks persistence user flow.
 *
 * This composes the real Easy Auth parser, start/list/stop handlers, and the
 * real CooksRepository. The container below is a stateful implementation of
 * the Cosmos Container calls the repository makes, so the flow verifies the
 * production partition-key/query wiring without requiring an Azure account in
 * CI. It intentionally does not mock any handler, auth, or repository method.
 *
 * HAR-26: the device ownership check runs through the real DevicesRepository on
 * an in-memory devices container, seeded with devices the OWNER registered.
 */
import type { Container } from '@azure/cosmos';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { Cook } from '@meatgeekv2/api-interfaces';

import { getCookHandler } from '../functions/cooks/get-cook';
import { getCooksHandler } from '../functions/cooks/list-cooks';
import { startCookHandler } from '../functions/cooks/start-cook';
import { stopCookHandler } from '../functions/cooks/stop-cook';
import { signalROutput, type SignalROutputMessage } from '../functions/signalr/envelope';
import { principalFromRequest } from '../shared/auth/principal';
import { CooksRepository } from '../shared/cosmos/cooks-repository';
import { DevicesRepository } from '../shared/cosmos/devices-repository';
import { FakeDevicesContainer } from '../shared/cosmos/fake-devices-container.testing';
import { syncDeviceTwinWith } from '../shared/iothub/device-twin-sync';
import { FakeTwinHub } from '../shared/iothub/fake-device-twin.testing';

const OWNER = { tenantId: 'tenant-owner', objectId: 'owner-oid' };
const OTHER = { tenantId: 'tenant-other', objectId: 'other-oid' };

/** Devices the OWNER registered (HAR-26: a cook may only start on one of these). */
const OWNER_DEVICES = ['grill-1', 'grill-2', 'grill-7', 'grill-8', 'grill-9'];
/** A device registered to OTHER. */
const OTHER_DEVICE = 'grill-other';

function principalHeader(identity: typeof OWNER): string {
  return Buffer.from(
    JSON.stringify({
      claims: [
        { typ: 'tid', val: identity.tenantId },
        { typ: 'oid', val: identity.objectId },
      ],
    })
  ).toString('base64');
}

function request(options: {
  body?: unknown;
  query?: Record<string, string>;
  params?: Record<string, string>;
  identity?: typeof OWNER;
}): HttpRequest {
  const headers = new Map<string, string>();
  if (options.identity) {
    headers.set('x-ms-client-principal', principalHeader(options.identity));
  }
  const query = new Map(Object.entries(options.query ?? {}));
  return {
    json: async () => options.body,
    headers: { get: (name: string) => headers.get(name.toLowerCase()) ?? null },
    query: { get: (name: string) => query.get(name) ?? null },
    params: options.params ?? {},
  } as unknown as HttpRequest;
}

function context(invocationId: string): {
  context: InvocationContext;
  messages: () => SignalROutputMessage[];
} {
  const messages: SignalROutputMessage[] = [];
  return {
    context: {
      invocationId,
      log: jest.fn(),
      error: jest.fn(),
      extraOutputs: {
        set: (binding: unknown, value: SignalROutputMessage[]) => {
          if (binding === signalROutput) messages.push(...value);
        },
      },
    } as unknown as InvocationContext,
    messages: () => messages,
  };
}

/**
 * Cosmos stamps these system properties on every document it stores and returns
 * them on every read, query, create and replace. The fake does the same so the
 * flow proves they never reach a client (MG-85).
 */
let systemVersion = 0;
function withSystemProperties<T extends Cook>(cook: T): T {
  systemVersion += 1;
  return {
    ...cook,
    _rid: 'Zm9vAA==',
    _self: 'dbs/Zm9vAA==/colls/Zm9vAA==/docs/Zm9vAA==/',
    _etag: `"etag-${systemVersion}"`,
    _attachments: 'attachments/',
    _ts: 1_790_000_000 + systemVersion,
  };
}

/** Every key path in a JSON value whose final segment starts with `_`. */
function underscoreKeyPaths(value: unknown, path = '$'): string[] {
  if (Array.isArray(value)) {
    return value.flatMap((item, index) => underscoreKeyPaths(item, `${path}[${index}]`));
  }
  if (value !== null && typeof value === 'object') {
    return Object.entries(value).flatMap(([key, child]) => [
      ...(key.startsWith('_') ? [`${path}.${key}`] : []),
      ...underscoreKeyPaths(child, `${path}.${key}`),
    ]);
  }
  return [];
}

type StoredDocument = Cook | (Record<string, unknown> & { id: string; userId: string });

function cosmosError(statusCode: number): Error {
  return Object.assign(new Error(`fake cosmos ${statusCode}`), { statusCode });
}

/**
 * A stateful Cosmos Container contract for this test. It enforces what the real
 * container does and the repository relies on: `(partition, id)` uniqueness on
 * create, If-Match on replace, and an ALL-OR-NOTHING transactional batch that
 * reports a status per operation (the failing one its own, the rest 424).
 */
function containerContract() {
  const cooks = new Map<string, StoredDocument>();
  const queryCalls: Array<{ partitionKey?: unknown; userId?: unknown }> = [];
  const replaceBodies: unknown[] = [];
  const key = (id: string, userId: string) => `${userId}/${id}`;
  const etagOf = (doc: StoredDocument | undefined) =>
    (doc as { _etag?: string } | undefined)?._etag;

  /** Applies one batch operation to `docs`, or returns the status it fails with. */
  function apply(
    docs: Map<string, StoredDocument>,
    userId: string,
    operation: {
      operationType: string;
      id?: string;
      resourceBody?: StoredDocument;
      ifMatch?: string;
    }
  ): { statusCode: number; resourceBody?: StoredDocument } {
    const id = operation.id ?? operation.resourceBody!.id;
    const existing = docs.get(key(id, userId));
    switch (operation.operationType) {
      case 'Create': {
        if (existing) return { statusCode: 409 };
        const stored = withSystemProperties(operation.resourceBody as Cook);
        docs.set(key(id, userId), stored);
        return { statusCode: 201, resourceBody: { ...stored } };
      }
      case 'Replace': {
        if (!existing) return { statusCode: 404 };
        if (operation.ifMatch && operation.ifMatch !== etagOf(existing)) {
          return { statusCode: 412 };
        }
        replaceBodies.push({ ...operation.resourceBody });
        const stored = withSystemProperties(operation.resourceBody as Cook);
        docs.set(key(id, userId), stored);
        return { statusCode: 200, resourceBody: { ...stored } };
      }
      case 'Delete': {
        if (!existing) return { statusCode: 404 };
        docs.delete(key(id, userId));
        return { statusCode: 204 };
      }
      default:
        throw new Error(`unsupported batch operation ${operation.operationType}`);
    }
  }

  const container = {
    items: {
      batch: async (operations: Array<Parameters<typeof apply>[2]>, userId: string) => {
        // Work on a copy and commit only if every operation succeeds.
        const draft = new Map(cooks);
        const result: Array<{ statusCode: number; requestCharge: number; resourceBody?: unknown }> =
          [];
        for (const operation of operations) {
          const outcome = apply(draft, userId, operation);
          result.push({ ...outcome, requestCharge: 6 });
          if (outcome.statusCode >= 300) {
            const failed = result.length - 1;
            return {
              code: 207,
              result: operations.map((_, index) =>
                index === failed
                  ? { statusCode: outcome.statusCode, requestCharge: 1 }
                  : { statusCode: 424, requestCharge: 0 }
              ),
            };
          }
        }
        cooks.clear();
        draft.forEach((doc, docKey) => cooks.set(docKey, doc));
        return { code: 200, result };
      },
      query: <T extends Cook>(
        querySpec: { query: string; parameters?: Array<{ name: string; value: unknown }> },
        options: { partitionKey?: unknown }
      ) => {
        const userId = querySpec.parameters?.find(({ name }) => name === '@userId')?.value;
        queryCalls.push({ partitionKey: options.partitionKey, userId });
        const excludesLocks = querySpec.query.includes('NOT IS_DEFINED(c.docType)');
        const resources = [...cooks.values()]
          .filter(doc => doc.userId === userId && options.partitionKey === userId)
          .filter(doc => !excludesLocks || !('docType' in doc))
          .sort((a, b) => String(b.startTime).localeCompare(String(a.startTime)))
          .map(doc => ({ ...doc })) as T[];
        return {
          fetchNext: async () => ({
            resources,
            hasMoreResults: false,
            continuationToken: undefined,
            requestCharge: 3,
          }),
        };
      },
    },
    item: (id: string, userId: string) => ({
      read: async <T>() => {
        const stored = cooks.get(key(id, userId));
        const resource = stored && { ...stored };
        return {
          resource: resource as T | undefined,
          statusCode: resource ? 200 : 404,
          requestCharge: 1,
          etag: etagOf(stored),
        };
      },
      replace: async <T extends Cook>(
        cook: T,
        options?: { accessCondition?: { condition?: string } }
      ) => {
        const ifMatch = options?.accessCondition?.condition;
        const outcome = apply(cooks, userId, {
          operationType: 'Replace',
          id,
          resourceBody: cook,
          ifMatch,
        });
        if (outcome.statusCode >= 300) throw cosmosError(outcome.statusCode);
        return { resource: outcome.resourceBody as T, requestCharge: 4 };
      },
    }),
  };

  const devicesContainer = new FakeDevicesContainer();
  const seedDevice = (device: { id: string; userId: string; name: string }) =>
    devicesContainer.seed(device);
  for (const id of OWNER_DEVICES) {
    seedDevice({ id, userId: 'tenant-owner:owner-oid', name: id });
  }
  seedDevice({ id: OTHER_DEVICE, userId: 'tenant-other:other-oid', name: OTHER_DEVICE });
  const devices = new DevicesRepository(devicesContainer.asContainer());

  // HAR-66: every OWNER device has a twin; the sync runs for real against the
  // real repository and this in-memory hub.
  const repository = new CooksRepository(container as unknown as Container);
  const twins = new FakeTwinHub();
  for (const id of OWNER_DEVICES) {
    twins.addDevice(id);
  }

  return {
    repository,
    twins,
    syncDeviceTwin: (userId: string, deviceId: string, correlationId: string) =>
      syncDeviceTwinWith({ twin: twins, cooks: repository }, userId, deviceId, correlationId),
    getDeviceOwnership: (userId: string, deviceId: string) =>
      devices.getDeviceOwnership(userId, deviceId),
    reassignDevice: (id: string, userId: string) => seedDevice({ id, userId, name: id }),
    cooks,
    queryCalls,
    replaceBodies,
  };
}

describe('MG-59 cooks persistence flow', () => {
  it('HAR-75: a body that carries userId is 400 VALIDATION_ERROR naming it, and nothing is written', async () => {
    const store = containerContract();
    const startContext = context('start-request');
    const started = await startCookHandler(
      request({
        identity: OWNER,
        body: {
          id: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
          name: 'Sunday brisket',
          deviceId: 'grill-7',
          meatType: 'brisket',
          userId: 'user-1',
        },
      }),
      startContext.context,
      {
        resolvePrincipal: principalFromRequest,
        getRepository: () => store.repository,
        getDeviceOwnership: store.getDeviceOwnership,
        syncDeviceTwin: store.syncDeviceTwin,
      }
    );

    expect(started.status).toBe(400);
    expect(started.jsonBody).toMatchObject({
      error: 'VALIDATION_ERROR',
      message: 'userId is not a start-cook field',
    });
    const listed = await getCooksHandler(
      request({ identity: OWNER }),
      context('list-request').context,
      { getRepository: () => store.repository }
    );
    expect((listed.jsonBody as { cooks: Cook[] }).cooks).toEqual([]);
  });

  it('writes with the authenticated partition, reads it in a separate request, then stops and reads the final state', async () => {
    const store = containerContract();
    const startContext = context('start-request');
    const started = await startCookHandler(
      request({
        identity: OWNER,
        // No userId in the body: only Easy Auth sets it (a body that carries
        // one is refused; see the HAR-75 case below).
        body: {
          id: '0c1d2e3f-4a5b-4c6d-8e7f-9a0b1c2d3e4f',
          name: '  Sunday brisket  ',
          deviceId: 'grill-7',
          meatType: 'brisket',
        },
      }),
      startContext.context,
      {
        resolvePrincipal: principalFromRequest,
        getRepository: () => store.repository,
        getDeviceOwnership: store.getDeviceOwnership,
        syncDeviceTwin: store.syncDeviceTwin,
      }
    );

    expect(started.status).toBe(201);
    const created = started.jsonBody as Cook;
    expect(created).toMatchObject({
      userId: 'tenant-owner:owner-oid',
      name: 'Sunday brisket',
      status: 'active',
    });
    expect(store.cooks.get(`tenant-owner:owner-oid/${created.id}`)).toMatchObject(created);
    expect(JSON.stringify(created)).not.toContain('user-1');
    expect(startContext.messages()).toHaveLength(1);
    // HAR-66: the twin now names the cook, with the start's correlation id.
    expect(store.twins.desired('grill-7')).toEqual({
      activeCookId: created.id,
      correlationId: 'start-request',
    });

    const beforeStop = await getCooksHandler(
      request({ identity: OWNER, query: { userId: 'tenant-other:other-oid', limit: '20' } }),
      context('list-before-stop').context,
      { getRepository: () => store.repository }
    );
    expect(beforeStop.status).toBe(200);
    expect((beforeStop.jsonBody as { cooks: Cook[] }).cooks).toEqual([created]);

    const stopContext = context('stop-request');
    const stopped = await stopCookHandler(
      request({ identity: OWNER, params: { cookId: created.id } }),
      stopContext.context,
      {
        resolvePrincipal: principalFromRequest,
        getRepository: () => store.repository,
        getDeviceOwnership: store.getDeviceOwnership,
        syncDeviceTwin: store.syncDeviceTwin,
      }
    );
    expect(stopped.status).toBe(200);
    expect(stopped.jsonBody).toMatchObject({ id: created.id, status: 'completed' });
    expect((stopped.jsonBody as Cook).endTime).toEqual(expect.any(String));
    expect(stopContext.messages()).toHaveLength(1);
    // HAR-66: the stop cleared both desired properties.
    expect(store.twins.desired('grill-7')).toEqual({});

    const finalRead = await getCooksHandler(
      request({ identity: OWNER }),
      context('list-final').context,
      { getRepository: () => store.repository }
    );
    expect((finalRead.jsonBody as { cooks: Cook[] }).cooks).toEqual([stopped.jsonBody]);
    expect(store.queryCalls).toEqual([
      { partitionKey: 'tenant-owner:owner-oid', userId: 'tenant-owner:owner-oid' },
      { partitionKey: 'tenant-owner:owner-oid', userId: 'tenant-owner:owner-oid' },
    ]);
  });

  it("HAR-75: GET /cooks/{cookId} reads the owner's cook before and after the stop; another caller, an unknown id and the device lock are 404", async () => {
    const store = containerContract();
    const deps = {
      resolvePrincipal: principalFromRequest,
      getRepository: () => store.repository,
      getDeviceOwnership: store.getDeviceOwnership,
      syncDeviceTwin: store.syncDeviceTwin,
    };
    const started = await startCookHandler(
      request({
        identity: OWNER,
        body: {
          id: '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b',
          name: 'Pork butt',
          deviceId: 'grill-9',
          meatType: 'pork',
        },
      }),
      context('owner-start').context,
      deps
    );
    expect(started.status).toBe(201);
    const created = started.jsonBody as Cook;
    const getCook = (identity: typeof OWNER, cookId: string) =>
      getCookHandler(request({ identity, params: { cookId } }), context('get').context, {
        resolvePrincipal: principalFromRequest,
        getRepository: () => store.repository,
      });

    const active = await getCook(OWNER, created.id);
    expect(active.status).toBe(200);
    expect(active.jsonBody).toEqual(created);

    expect((await getCook(OTHER, created.id)).status).toBe(404);
    expect((await getCook(OWNER, '9f8e7d6c-5b4a-4392-8170-6f5e4d3c2b1a')).status).toBe(404);
    // The MG-84 lock exists in the owner's partition while the cook runs.
    expect([...store.cooks.keys()]).toContain('tenant-owner:owner-oid/active-device:grill-9');
    const lock = await getCook(OWNER, 'active-device:grill-9');
    expect(lock.status).toBe(404);
    expect(lock.jsonBody).toMatchObject({ error: 'NOT_FOUND' });

    const stopped = await stopCookHandler(
      request({ identity: OWNER, params: { cookId: created.id } }),
      context('owner-stop').context,
      deps
    );
    expect(stopped.status).toBe(200);
    const completed = await getCook(OWNER, created.id);
    expect(completed.status).toBe(200);
    expect(completed.jsonBody).toEqual(stopped.jsonBody);
    expect(completed.jsonBody).toMatchObject({ status: 'completed', endTime: expect.any(String) });
  });

  it('does not stop a cook addressed by an authenticated caller in another partition', async () => {
    const store = containerContract();
    const ownerStart = await startCookHandler(
      request({
        identity: OWNER,
        body: {
          id: '1d2e3f4a-5b6c-4d7e-8f9a-0b1c2d3e4f5a',
          name: 'Ribs',
          deviceId: 'grill-8',
          meatType: 'pork',
        },
      }),
      context('owner-start').context,
      {
        resolvePrincipal: principalFromRequest,
        getRepository: () => store.repository,
        getDeviceOwnership: store.getDeviceOwnership,
        syncDeviceTwin: store.syncDeviceTwin,
      }
    );
    const created = ownerStart.jsonBody as Cook;
    const intruderContext = context('other-stop');

    const response = await stopCookHandler(
      request({ identity: OTHER, params: { cookId: created.id } }),
      intruderContext.context,
      {
        resolvePrincipal: principalFromRequest,
        getRepository: () => store.repository,
        getDeviceOwnership: store.getDeviceOwnership,
        syncDeviceTwin: store.syncDeviceTwin,
      }
    );

    expect(response.status).toBe(404);
    expect(intruderContext.messages()).toEqual([]);
    // HAR-66: the refused stop did not touch the owner's twin.
    expect(store.twins.desired('grill-8')).toEqual({
      activeCookId: created.id,
      correlationId: 'owner-start',
    });
    expect(store.cooks.get(`tenant-owner:owner-oid/${created.id}`)).toMatchObject({
      status: 'active',
    });
  });

  it('MG-85: no Cosmos system property reaches any cooks response body or SignalR envelope', async () => {
    const store = containerContract();
    const startContext = context('start-request');
    const started = await startCookHandler(
      request({
        identity: OWNER,
        body: {
          id: '2e3f4a5b-6c7d-4e8f-9a0b-1c2d3e4f5a6b',
          name: 'Pork butt',
          deviceId: 'grill-9',
          meatType: 'pork',
        },
      }),
      startContext.context,
      {
        resolvePrincipal: principalFromRequest,
        getRepository: () => store.repository,
        getDeviceOwnership: store.getDeviceOwnership,
        syncDeviceTwin: store.syncDeviceTwin,
      }
    );
    const created = started.jsonBody as Cook;
    // The store really does carry the system properties the responses must not.
    expect(store.cooks.get(`tenant-owner:owner-oid/${created.id}`)).toHaveProperty('_rid');

    const listed = await getCooksHandler(request({ identity: OWNER }), context('list').context, {
      getRepository: () => store.repository,
    });
    const stopContext = context('stop-request');
    const stopped = await stopCookHandler(
      request({ identity: OWNER, params: { cookId: created.id } }),
      stopContext.context,
      {
        resolvePrincipal: principalFromRequest,
        getRepository: () => store.repository,
        getDeviceOwnership: store.getDeviceOwnership,
        syncDeviceTwin: store.syncDeviceTwin,
      }
    );
    const stoppedAgain = await stopCookHandler(
      request({ identity: OWNER, params: { cookId: created.id } }),
      context('stop-again').context,
      {
        resolvePrincipal: principalFromRequest,
        getRepository: () => store.repository,
        getDeviceOwnership: store.getDeviceOwnership,
        syncDeviceTwin: store.syncDeviceTwin,
      }
    );

    expect([started.status, listed.status, stopped.status, stoppedAgain.status]).toEqual([
      201, 200, 200, 200,
    ]);
    for (const body of [
      started.jsonBody,
      listed.jsonBody,
      stopped.jsonBody,
      stoppedAgain.jsonBody,
    ]) {
      expect(underscoreKeyPaths(body)).toEqual([]);
    }
    expect(underscoreKeyPaths(startContext.messages())).toEqual([]);
    expect(underscoreKeyPaths(stopContext.messages())).toEqual([]);

    // The list body is exactly the continuation-token contract: no total/offset.
    expect(Object.keys(listed.jsonBody as object).sort()).toEqual(['cooks', 'hasMore', 'limit']);

    // The stop still replaced the WHOLE stored document under its ETag; only the
    // response was projected.
    expect(store.replaceBodies).toHaveLength(1);
    expect(store.replaceBodies[0]).toHaveProperty('_rid');
  });
});

describe('MG-84 retry-safe start through the real repository', () => {
  const COOK_X = '3f4a5b6c-7d8e-4f9a-8b1c-2d3e4f5a6b7c';
  const COOK_Y = '4a5b6c7d-8e9f-4a0b-9c2d-3e4f5a6b7c8d';
  const OWNER_PARTITION = 'tenant-owner:owner-oid';
  const startDeps = (store: ReturnType<typeof containerContract>) => ({
    resolvePrincipal: principalFromRequest,
    getRepository: () => store.repository,
    getDeviceOwnership: store.getDeviceOwnership,
    syncDeviceTwin: store.syncDeviceTwin,
  });
  const body = (id: string, deviceId = 'grill-1') => ({
    id,
    name: 'Brisket',
    deviceId,
    meatType: 'brisket',
    targetTemps: { grill: 225, probe1: 203 },
  });
  const start = async (store: ReturnType<typeof containerContract>, startBody: unknown) => {
    const ctx = context(`start-${Math.random()}`);
    const response = await startCookHandler(
      request({ identity: OWNER, body: startBody }),
      ctx.context,
      startDeps(store)
    );
    return { response, messages: ctx.messages() };
  };
  const stop = (store: ReturnType<typeof containerContract>, cookId: string) =>
    stopCookHandler(
      request({ identity: OWNER, params: { cookId } }),
      context(`stop-${cookId}`).context,
      startDeps(store)
    );
  const storedCooks = (store: ReturnType<typeof containerContract>) =>
    [...store.cooks.values()].filter(doc => !('docType' in doc));

  it('a retry after success returns the original cook with 200 and no second COOK_STARTED', async () => {
    const store = containerContract();

    const first = await start(store, body(COOK_X));
    const retry = await start(store, body(COOK_X));

    expect(first.response.status).toBe(201);
    expect(first.messages).toHaveLength(1);
    expect(retry.response.status).toBe(200);
    expect(retry.response.jsonBody).toEqual(first.response.jsonBody);
    expect(retry.messages).toEqual([]);
    expect(storedCooks(store)).toHaveLength(1);
  });

  it('concurrent duplicate submits persist one cook and emit one COOK_STARTED', async () => {
    const store = containerContract();

    const results = await Promise.all([start(store, body(COOK_X)), start(store, body(COOK_X))]);

    expect(results.map(({ response }) => response.status).sort()).toEqual([200, 201]);
    expect(results.flatMap(({ messages }) => messages)).toHaveLength(1);
    expect(results[0].response.jsonBody).toEqual(results[1].response.jsonBody);
    expect(storedCooks(store)).toHaveLength(1);
  });

  it('distinct ids on different devices create distinct cooks, each announced once', async () => {
    const store = containerContract();

    const x = await start(store, body(COOK_X, 'grill-1'));
    const y = await start(store, body(COOK_Y, 'grill-2'));

    expect([x.response.status, y.response.status]).toEqual([201, 201]);
    expect([x.messages.length, y.messages.length]).toEqual([1, 1]);
    expect(
      storedCooks(store)
        .map(cook => cook.id)
        .sort()
    ).toEqual([COOK_X, COOK_Y].sort());
  });

  it('one active cook per device: 409 until the active cook is stopped, then the device is free', async () => {
    const store = containerContract();
    await start(store, body(COOK_X));

    const busy = await start(store, body(COOK_Y));
    expect(busy.response.status).toBe(409);
    expect(busy.response.jsonBody).toMatchObject({
      error: 'COOK_ALREADY_ACTIVE',
      activeCookId: COOK_X,
    });
    expect(busy.messages).toEqual([]);
    expect(storedCooks(store)).toHaveLength(1);

    expect((await stop(store, COOK_X)).status).toBe(200);
    // The stop released the lock in the same batch.
    expect(store.cooks.has(`${OWNER_PARTITION}/active-device:grill-1`)).toBe(false);

    const next = await start(store, body(COOK_Y));
    expect(next.response.status).toBe(201);
    expect(next.messages).toHaveLength(1);
  });

  it('a stale lock (its cook completed without releasing it) does not block a start', async () => {
    const store = containerContract();
    await start(store, body(COOK_X));
    // Simulate a lock left behind: complete the cook directly in the store.
    const cookKey = `${OWNER_PARTITION}/${COOK_X}`;
    store.cooks.set(cookKey, { ...(store.cooks.get(cookKey) as Cook), status: 'completed' });

    const next = await start(store, body(COOK_Y));

    expect(next.response.status).toBe(201);
    expect(store.cooks.get(`${OWNER_PARTITION}/active-device:grill-1`)).toMatchObject({
      cookId: COOK_Y,
    });
  });

  it('the same id with a different body is refused with 422 and writes nothing', async () => {
    const store = containerContract();
    await start(store, body(COOK_X));

    const reuse = await start(store, { ...body(COOK_X), name: 'Something else' });

    expect(reuse.response.status).toBe(422);
    expect(reuse.response.jsonBody).toMatchObject({ error: 'COOK_ID_REUSED' });
    expect(reuse.messages).toEqual([]);
    expect(storedCooks(store)).toHaveLength(1);
  });

  it('the list never returns lock documents, and no response carries lock or system fields', async () => {
    const store = containerContract();
    const x = await start(store, body(COOK_X, 'grill-1'));
    await start(store, body(COOK_Y, 'grill-2'));
    const replay = await start(store, body(COOK_X, 'grill-1'));
    const busy = await start(store, body('5b6c7d8e-9f0a-4b1c-8d3e-4f5a6b7c8d9e', 'grill-1'));
    // Two cooks and two locks are stored in the caller's partition.
    expect(store.cooks.size).toBe(4);

    const listed = await getCooksHandler(request({ identity: OWNER }), context('list').context, {
      getRepository: () => store.repository,
    });

    const cooks = (listed.jsonBody as { cooks: Cook[] }).cooks;
    expect(cooks.map(cook => cook.id).sort()).toEqual([COOK_X, COOK_Y].sort());
    for (const responseBody of [
      x.response.jsonBody,
      replay.response.jsonBody,
      busy.response.jsonBody,
      listed.jsonBody,
    ]) {
      expect(underscoreKeyPaths(responseBody)).toEqual([]);
      expect(JSON.stringify(responseBody)).not.toContain('docType');
    }
    expect(underscoreKeyPaths(x.messages)).toEqual([]);
    expect(JSON.stringify(x.messages)).not.toContain('docType');
  });
});

describe('HAR-26 device ownership through the real repositories', () => {
  const deps = (store: ReturnType<typeof containerContract>) => ({
    resolvePrincipal: principalFromRequest,
    getRepository: () => store.repository,
    getDeviceOwnership: store.getDeviceOwnership,
    syncDeviceTwin: store.syncDeviceTwin,
  });
  const startOn = (
    store: ReturnType<typeof containerContract>,
    deviceId: string,
    identity = OWNER
  ) => {
    const ctx = context(`start-${deviceId}`);
    return startCookHandler(
      request({
        identity,
        body: {
          id: '6c7d8e9f-0a1b-4c2d-9e3f-5a6b7c8d9e0f',
          name: 'Brisket',
          deviceId,
          meatType: 'brisket',
        },
      }),
      ctx.context,
      deps(store)
    ).then(response => ({ response, messages: ctx.messages() }));
  };

  it.each([
    ['registered to another user', OTHER_DEVICE],
    ['not registered', 'grill-unregistered'],
  ])(
    'a start on a device %s is 403 with no cook, no lock and no emit',
    async (_label, deviceId) => {
      const store = containerContract();

      const { response, messages } = await startOn(store, deviceId);

      expect(response.status).toBe(403);
      expect((response.jsonBody as { error: string }).error).toBe('DEVICE_NOT_OWNED');
      expect(store.cooks.size).toBe(0);
      expect(messages).toEqual([]);
    }
  );

  it('a cook whose device the caller no longer owns cannot be stopped', async () => {
    const store = containerContract();
    const { response } = await startOn(store, 'grill-1');
    const created = response.jsonBody as Cook;
    // The device is now someone else's (no transfer route exists; model it in
    // the store).
    store.reassignDevice('grill-1', 'tenant-other:other-oid');
    const ctx = context('stop-foreign');

    const stopped = await stopCookHandler(
      request({ identity: OWNER, params: { cookId: created.id } }),
      ctx.context,
      deps(store)
    );

    expect(stopped.status).toBe(403);
    expect(ctx.messages()).toEqual([]);
    expect(store.cooks.get(`tenant-owner:owner-oid/${created.id}`)).toMatchObject({
      status: 'active',
    });
  });
});
