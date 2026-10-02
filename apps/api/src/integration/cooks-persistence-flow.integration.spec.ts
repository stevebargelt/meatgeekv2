/**
 * MG-59 integration coverage for the cooks persistence user flow.
 *
 * This composes the real Easy Auth parser, start/list/stop handlers, and the
 * real CooksRepository. The container below is a stateful implementation of
 * the Cosmos Container calls the repository makes, so the flow verifies the
 * production partition-key/query wiring without requiring an Azure account in
 * CI. It intentionally does not mock any handler, auth, or repository method.
 */
import type { Container } from '@azure/cosmos';
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { Cook } from '@meatgeekv2/api-interfaces';

import { getCooksHandler } from '../functions/cooks/list-cooks';
import { startCookHandler } from '../functions/cooks/start-cook';
import { stopCookHandler } from '../functions/cooks/stop-cook';
import { signalROutput, type SignalROutputMessage } from '../functions/signalr/envelope';
import { principalFromRequest } from '../shared/auth/principal';
import { CooksRepository } from '../shared/cosmos/cooks-repository';

const OWNER = { tenantId: 'tenant-owner', objectId: 'owner-oid' };
const OTHER = { tenantId: 'tenant-other', objectId: 'other-oid' };

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

/** A stateful, single-partition Cosmos Container contract for this test. */
function containerContract() {
  const cooks = new Map<string, Cook>();
  const queryCalls: Array<{ partitionKey?: unknown; userId?: unknown }> = [];
  const key = (id: string, userId: string) => `${userId}/${id}`;

  const container = {
    items: {
      create: async <T extends Cook>(cook: T) => {
        cooks.set(key(cook.id, cook.userId), { ...cook });
        return { resource: { ...cook }, requestCharge: 5 };
      },
      query: <T extends Cook>(
        querySpec: { parameters?: Array<{ name: string; value: unknown }> },
        options: { partitionKey?: unknown }
      ) => {
        const userId = querySpec.parameters?.find(({ name }) => name === '@userId')?.value;
        queryCalls.push({ partitionKey: options.partitionKey, userId });
        const resources = [...cooks.values()]
          .filter(cook => cook.userId === userId && options.partitionKey === userId)
          .sort((a, b) => b.startTime.localeCompare(a.startTime)) as T[];
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
      read: async <T extends Cook>() => {
        const resource = cooks.get(key(id, userId)) as T | undefined;
        return { resource, statusCode: resource ? 200 : 404, requestCharge: 1, etag: 'etag-1' };
      },
      replace: async <T extends Cook>(cook: T) => {
        cooks.set(key(id, userId), { ...cook });
        return { resource: { ...cook }, requestCharge: 4 };
      },
    }),
  };

  return { repository: new CooksRepository(container as unknown as Container), cooks, queryCalls };
}

describe('MG-59 cooks persistence flow', () => {
  it('writes with the authenticated partition, reads it in a separate request, then stops and reads the final state', async () => {
    const store = containerContract();
    const startContext = context('start-request');
    const started = await startCookHandler(
      request({
        identity: OWNER,
        // userId is deliberately malicious/legacy input: only Easy Auth may set it.
        body: {
          name: '  Sunday brisket  ',
          deviceId: 'grill-7',
          meatType: 'brisket',
          userId: 'user-1',
        },
      }),
      startContext.context,
      { resolvePrincipal: principalFromRequest, getRepository: () => store.repository }
    );

    expect(started.status).toBe(201);
    const created = started.jsonBody as Cook;
    expect(created).toMatchObject({
      userId: 'tenant-owner:owner-oid',
      name: 'Sunday brisket',
      status: 'active',
    });
    expect(store.cooks.get(`tenant-owner:owner-oid/${created.id}`)).toMatchObject(created);
    expect(startContext.messages()).toHaveLength(1);

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
      { resolvePrincipal: principalFromRequest, getRepository: () => store.repository }
    );
    expect(stopped.status).toBe(200);
    expect(stopped.jsonBody).toMatchObject({ id: created.id, status: 'completed' });
    expect((stopped.jsonBody as Cook).endTime).toEqual(expect.any(String));
    expect(stopContext.messages()).toHaveLength(1);

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

  it('does not stop a cook addressed by an authenticated caller in another partition', async () => {
    const store = containerContract();
    const ownerStart = await startCookHandler(
      request({ identity: OWNER, body: { name: 'Ribs', deviceId: 'grill-8', meatType: 'pork' } }),
      context('owner-start').context,
      { resolvePrincipal: principalFromRequest, getRepository: () => store.repository }
    );
    const created = ownerStart.jsonBody as Cook;
    const intruderContext = context('other-stop');

    const response = await stopCookHandler(
      request({ identity: OTHER, params: { cookId: created.id } }),
      intruderContext.context,
      { resolvePrincipal: principalFromRequest, getRepository: () => store.repository }
    );

    expect(response.status).toBe(404);
    expect(intruderContext.messages()).toEqual([]);
    expect(store.cooks.get(`tenant-owner:owner-oid/${created.id}`)).toMatchObject({
      status: 'active',
    });
  });
});
