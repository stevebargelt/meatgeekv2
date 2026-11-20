/**
 * HAR-75 — GET /cooks/{cookId}, with NO Azure and NO credentials.
 *
 * The handler runs over the REAL CooksRepository on a minimal in-memory
 * container that answers point reads by (id, partition key) and stamps Cosmos
 * system properties, and reads real base64 X-MS-CLIENT-PRINCIPAL headers
 * through the real principal.ts.
 */
import type { Container } from '@azure/cosmos';
import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Cook } from '@meatgeekv2/api-interfaces';

import { principalFromRequest } from '../../shared/auth/principal';
import {
  ACTIVE_DEVICE_LOCK_DOC_TYPE,
  CooksRepository,
  activeDeviceLockId,
} from '../../shared/cosmos/cooks-repository';
import { REQUEST_CHARGE_HEADER } from '../../shared/cosmos/request-charge';
import { getCookHandler, type GetCookDeps } from './get-cook';

const TID = 'tid-bbbb-2222';
const OID = 'oid-aaaa-1111';
const USER_ID = `${TID}:${OID}`;
const OTHER_OID = 'oid-zzzz-9999';
const COOK_ID = '3f4a5b6c-7d8e-4f9a-8b1c-2d3e4f5a6b7c';
const READ_CHARGE = 1.24;
const ACCOUNT = 'https://mgv2-secret-account.documents.azure.com/';

function encodedPrincipal(oid: string, tid = TID): string {
  const payload = {
    claims: [
      { typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier', val: oid },
      { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: tid },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function request(options: {
  cookId?: string;
  principal?: string | null;
  requestId?: string;
}): HttpRequest {
  const headers = new Map<string, string>();
  const principal = options.principal === undefined ? encodedPrincipal(OID) : options.principal;
  if (principal !== null) headers.set('x-ms-client-principal', principal);
  if (options.requestId !== undefined) headers.set('x-request-id', options.requestId);
  return {
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: new URLSearchParams(),
    params: options.cookId === undefined ? {} : { cookId: options.cookId },
  } as unknown as HttpRequest;
}

function context() {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx = {
    invocationId: 'inv-77',
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
  } as unknown as InvocationContext;
  return { ctx, logs, errors };
}

function cook(overrides: Partial<Cook> = {}): Cook {
  return {
    id: COOK_ID,
    userId: USER_ID,
    deviceId: 'grill-1',
    name: 'Weekend Brisket',
    status: 'active',
    startTime: '2026-11-20T06:00:00.000Z',
    meatType: 'brisket',
    targetTemps: { grill: 250, probe1: 203 },
    ...overrides,
  };
}

/** A cooks container holding documents by (partition key, id). Reads of an
 *  absent document answer 404 with a charge, as the v4 SDK does. */
function store() {
  const documents = new Map<string, Record<string, unknown>>();
  const reads: Array<{ id: string; partitionKey: unknown }> = [];
  let failure: unknown;
  const container = {
    item: (id: string, partitionKey: unknown) => ({
      read: async () => {
        reads.push({ id, partitionKey });
        if (failure) throw failure;
        const resource = documents.get(`${String(partitionKey)}/${id}`);
        return {
          resource,
          statusCode: resource ? 200 : 404,
          etag: resource ? '"etag-1"' : undefined,
          requestCharge: READ_CHARGE,
        };
      },
    }),
  } as unknown as Container;
  const getRepository = jest.fn(() => new CooksRepository(container));
  return {
    reads,
    getRepository,
    deps: { resolvePrincipal: principalFromRequest, getRepository } satisfies GetCookDeps,
    seed(document: object) {
      const { id, userId } = document as { id: string; userId: string };
      documents.set(`${userId}/${id}`, {
        ...document,
        _rid: 'rid-1',
        _self: 'dbs/x/colls/cooks/docs/1',
        _etag: '"etag-1"',
        _attachments: 'attachments/',
        _ts: 1700000000,
      });
    },
    failWith(error: unknown) {
      failure = error;
    },
  };
}

function header(response: HttpResponseInit, name: string): string | undefined {
  return (response.headers as Record<string, string> | undefined)?.[name];
}

describe('GET /cooks/{cookId}', () => {
  it("200: the owner's cook, projected to Cook, one point read in the caller's partition", async () => {
    const fixture = store();
    fixture.seed({ ...cook(), legacyField: 'not in the contract' });

    const response = await getCookHandler(
      request({ cookId: COOK_ID }),
      context().ctx,
      fixture.deps
    );

    expect(response.status).toBe(200);
    expect(response.jsonBody).toEqual(cook());
    expect(fixture.reads).toEqual([{ id: COOK_ID, partitionKey: USER_ID }]);
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
    expect(header(response, 'X-Request-ID')).toBe('inv-77');
  });

  it("echoes the caller's X-Request-ID on 200, 400, 401, 404 and 500", async () => {
    const found = store();
    found.seed(cook());
    const failing = store();
    failing.failWith(Object.assign(new Error(`Request to ${ACCOUNT} failed`), { code: 503 }));
    const cases: Array<[number, HttpRequest, GetCookDeps]> = [
      [200, request({ cookId: COOK_ID, requestId: 'req-1' }), found.deps],
      [400, request({ cookId: 'x'.repeat(129), requestId: 'req-1' }), found.deps],
      [401, request({ cookId: COOK_ID, principal: null, requestId: 'req-1' }), found.deps],
      [404, request({ cookId: 'missing', requestId: 'req-1' }), found.deps],
      [500, request({ cookId: COOK_ID, requestId: 'req-1' }), failing.deps],
    ];

    for (const [status, req, deps] of cases) {
      const response = await getCookHandler(req, context().ctx, deps);
      expect({ status: response.status, id: header(response, 'X-Request-ID') }).toEqual({
        status,
        id: 'req-1',
      });
    }
  });

  it('404 NOT_FOUND for an absent cook, with the read charge', async () => {
    const fixture = store();

    const response = await getCookHandler(
      request({ cookId: COOK_ID }),
      context().ctx,
      fixture.deps
    );

    expect(response.status).toBe(404);
    expect(response.jsonBody).toEqual({
      error: 'NOT_FOUND',
      message: 'Cook not found',
      requestId: 'inv-77',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBe(String(READ_CHARGE));
  });

  it("404 for another user's cook, byte-identical to an absent one, without reading their partition", async () => {
    const fixture = store();
    fixture.seed(cook());

    const foreign = await getCookHandler(
      request({ cookId: COOK_ID, principal: encodedPrincipal(OTHER_OID) }),
      context().ctx,
      fixture.deps
    );
    const absent = await getCookHandler(
      request({ cookId: 'missing', principal: encodedPrincipal(OTHER_OID) }),
      context().ctx,
      fixture.deps
    );

    expect(foreign.status).toBe(404);
    expect(JSON.stringify(foreign.jsonBody)).toBe(JSON.stringify(absent.jsonBody));
    expect(fixture.reads[0]).toEqual({ id: COOK_ID, partitionKey: `${TID}:${OTHER_OID}` });
  });

  it('404 for the device lock document (active-device:<deviceId>), which is not a cook', async () => {
    const fixture = store();
    const lockId = activeDeviceLockId('grill-1');
    fixture.seed({
      id: lockId,
      userId: USER_ID,
      docType: ACTIVE_DEVICE_LOCK_DOC_TYPE,
      deviceId: 'grill-1',
      cookId: COOK_ID,
    });

    const response = await getCookHandler(request({ cookId: lockId }), context().ctx, fixture.deps);

    expect(response.status).toBe(404);
    expect(response.jsonBody).toMatchObject({ error: 'NOT_FOUND' });
    expect(JSON.stringify(response.jsonBody)).not.toContain('grill-1');
    expect(fixture.reads).toEqual([{ id: lockId, partitionKey: USER_ID }]);
  });

  it.each([
    ['missing', undefined],
    ['empty', ''],
    ['129 characters', 'c'.repeat(129)],
  ])('400 VALIDATION_ERROR when cookId is %s, with no Cosmos call', async (_name, cookId) => {
    const fixture = store();

    const response = await getCookHandler(request({ cookId }), context().ctx, fixture.deps);

    expect(response.status).toBe(400);
    expect(response.jsonBody).toEqual({
      error: 'VALIDATION_ERROR',
      message: 'cookId must be 1-128 characters',
      requestId: 'inv-77',
    });
    expect(header(response, REQUEST_CHARGE_HEADER)).toBeUndefined();
    expect(fixture.getRepository).not.toHaveBeenCalled();
    expect(fixture.reads).toEqual([]);
  });

  it('accepts a cookId of exactly 128 characters (legacy ids are opaque)', async () => {
    const fixture = store();
    const longId = 'c'.repeat(128);
    fixture.seed(cook({ id: longId }));

    const response = await getCookHandler(request({ cookId: longId }), context().ctx, fixture.deps);

    expect(response.status).toBe(200);
  });

  it('401 without a principal, before any read', async () => {
    const fixture = store();

    const response = await getCookHandler(
      request({ cookId: COOK_ID, principal: null }),
      context().ctx,
      fixture.deps
    );

    expect(response.status).toBe(401);
    expect(response.jsonBody).toMatchObject({
      error: 'UNAUTHENTICATED',
      reason: 'principal_header_missing',
    });
    expect(fixture.getRepository).not.toHaveBeenCalled();
  });

  it('500 with fixed text when the read fails, leaking no endpoint or claim', async () => {
    const fixture = store();
    fixture.failWith(
      Object.assign(new Error(`Request to ${ACCOUNT} failed`), { code: 503, statusCode: 503 })
    );
    const { ctx, errors, logs } = context();

    const response = await getCookHandler(request({ cookId: COOK_ID }), ctx, fixture.deps);

    expect(response.status).toBe(500);
    expect(response.jsonBody).toEqual({
      error: 'INTERNAL_SERVER_ERROR',
      message: 'Failed to retrieve cook',
      requestId: 'inv-77',
    });
    expect(errors.join('\n')).toContain('cosmos_status_503');
    const everything = [JSON.stringify(response), ...errors, ...logs].join('\n');
    for (const secret of [ACCOUNT, 'documents.azure.com', OID, TID]) {
      expect(everything).not.toContain(secret);
    }
  });
});
