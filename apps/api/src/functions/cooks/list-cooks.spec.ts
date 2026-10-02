/**
 * MG-59 — list-cooks handler tests, run with NO Azure and NO credentials.
 *
 * list-cooks.ts transitively imports the shared Cosmos adapter, but the adapter
 * is LAZY: importing the handler constructs no client, resolves no config, and
 * throws nothing — the fail-loud config guard fires only on the first accessor
 * call inside a live invocation. So merely requiring the module is safe with no
 * env set. These tests still stage valid env values (they double as the account
 * host the sanitization-leak case asserts never escapes), but that env is no
 * longer load-bearing for import. The handler is driven with an INJECTED fake
 * repository so no real client, credential, or query is ever constructed. The
 * fake records every call, which lets these tests hold the tenancy- and
 * throughput-critical properties: the list is scoped to the authenticated
 * principal (a query-string userId can never widen it), unauthenticated requests
 * issue no query, pagination is continuation-token (never offset), failures are
 * sanitized, and the RU charge is logged as a bare number.
 */
import type { HttpRequest, InvocationContext } from '@azure/functions';
import type { Cook } from '@meatgeekv2/api-interfaces';

import type {
  CookPage,
  CooksRepository,
  ListCooksOptions,
} from '../../shared/cosmos/cooks-repository';
import type { ListCooksHandlerDeps } from './list-cooks';

const VALID_ENV = {
  COSMOSDB__accountEndpoint: 'https://mgv2-secret-account.documents.azure.com/',
  COSMOSDB_DATABASE_NAME: 'meatgeek-v2-dev-db',
  COSMOSDB_COOKS_CONTAINER_NAME: 'cooks',
};

function loadModule(): typeof import('./list-cooks') {
  jest.resetModules();
  for (const [key, value] of Object.entries(VALID_ENV)) {
    process.env[key] = value;
  }
  return require('./list-cooks') as typeof import('./list-cooks');
}

const OID = 'oid-aaaa-1111';
const TID = 'tid-bbbb-2222';
/** What principal.ts derives as the partition userId: "<tenantId>:<objectId>". */
const EXPECTED_USER_ID = `${TID}:${OID}`;

/** A valid base64 X-MS-CLIENT-PRINCIPAL for the (OID, TID) above. */
function encodedPrincipal(oid = OID, tid = TID): string {
  const payload = {
    claims: [
      {
        typ: 'http://schemas.microsoft.com/identity/claims/objectidentifier',
        val: oid,
      },
      { typ: 'http://schemas.microsoft.com/identity/claims/tenantid', val: tid },
    ],
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

function sampleCook(overrides: Partial<Cook> = {}): Cook {
  return {
    id: 'cook-1',
    userId: EXPECTED_USER_ID,
    deviceId: 'meatgeek3',
    name: 'Weekend Brisket',
    status: 'completed',
    startTime: '2026-08-24T06:00:00Z',
    endTime: '2026-08-24T20:00:00Z',
    meatType: 'brisket',
    ...overrides,
  };
}

interface RecordedCall {
  userId: string;
  options: ListCooksOptions;
}

/**
 * A fake repository that records how listCooksByUser was addressed and returns a
 * staged page (or throws a staged error). Only the one method the handler calls
 * is implemented; cast to CooksRepository at the injection seam.
 */
function fakeRepository(page: CookPage | Error) {
  const calls: RecordedCall[] = [];
  const repository = {
    async listCooksByUser(userId: string, options: ListCooksOptions = {}): Promise<CookPage> {
      calls.push({ userId, options });
      if (page instanceof Error) {
        throw page;
      }
      return page;
    },
  } as unknown as CooksRepository;
  return { repository, calls };
}

function deps(page: CookPage | Error): {
  deps: ListCooksHandlerDeps;
  calls: RecordedCall[];
} {
  const { repository, calls } = fakeRepository(page);
  return { deps: { getRepository: () => repository }, calls };
}

function mockRequest(options: {
  principalHeader?: string;
  query?: Record<string, string>;
}): HttpRequest {
  const headers = new Map<string, string>();
  if (options.principalHeader !== undefined) {
    headers.set('x-ms-client-principal', options.principalHeader);
  }
  const query = new Map<string, string>(Object.entries(options.query ?? {}));
  return {
    json: async () => ({}),
    headers: { get: (k: string) => headers.get(k.toLowerCase()) ?? null },
    query: { get: (k: string) => query.get(k) ?? null },
    params: {},
  } as unknown as HttpRequest;
}

interface CapturedContext {
  ctx: InvocationContext;
  logs: () => string[];
  errors: () => string[];
}

function mockContext(): CapturedContext {
  const logs: string[] = [];
  const errors: string[] = [];
  const ctx = {
    invocationId: 'inv-42',
    log: (...args: unknown[]) => logs.push(args.map(String).join(' ')),
    error: (...args: unknown[]) => errors.push(args.map(String).join(' ')),
  } as unknown as InvocationContext;
  return { ctx, logs: () => logs, errors: () => errors };
}

function pageOf(cooks: Cook[], extra: Partial<CookPage> = {}): CookPage {
  return { cooks, requestCharge: 2.5, ...extra };
}

describe('getCooksHandler', () => {
  it('scopes the query to the authenticated principal and ignores a query-string userId', async () => {
    const { getCooksHandler } = loadModule();
    const { deps: d, calls } = deps(pageOf([sampleCook()]));
    const { ctx } = mockContext();

    const res = await getCooksHandler(
      mockRequest({
        principalHeader: encodedPrincipal(),
        query: { userId: 'someone-elses-tenant' },
      }),
      ctx,
      d
    );

    expect(res.status).toBe(200);
    // The repository was addressed on the AUTHENTICATED userId, not the query one.
    expect(calls).toHaveLength(1);
    expect(calls[0].userId).toBe(EXPECTED_USER_ID);
    expect(calls[0].userId).not.toBe('someone-elses-tenant');

    const body = res.jsonBody as { cooks: Cook[] };
    expect(body.cooks).toHaveLength(1);
    expect(body.cooks[0].userId).toBe(EXPECTED_USER_ID);
  });

  it('never persists or returns a fabricated user-1 tenant', async () => {
    const { getCooksHandler } = loadModule();
    const { deps: d, calls } = deps(pageOf([sampleCook()]));
    const { ctx } = mockContext();

    await getCooksHandler(
      mockRequest({ principalHeader: encodedPrincipal(), query: { userId: 'user-1' } }),
      ctx,
      d
    );

    expect(calls[0].userId).toBe(EXPECTED_USER_ID);
    expect(calls[0].userId).not.toBe('user-1');
  });

  it('rejects an unauthenticated request with 401 and issues no query', async () => {
    const { getCooksHandler } = loadModule();
    const { deps: d, calls } = deps(pageOf([sampleCook()]));
    const { ctx } = mockContext();

    const res = await getCooksHandler(mockRequest({ query: { limit: '10' } }), ctx, d);

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
    expect((res.jsonBody as { error: string }).error).toBe('UNAUTHENTICATED');
  });

  it('rejects an unparseable principal header with 401 and no query', async () => {
    const { getCooksHandler } = loadModule();
    const { deps: d, calls } = deps(pageOf([sampleCook()]));
    const { ctx } = mockContext();

    const res = await getCooksHandler(
      mockRequest({ principalHeader: 'not-valid-base64-json!!!' }),
      ctx,
      d
    );

    expect(res.status).toBe(401);
    expect(calls).toHaveLength(0);
  });

  it('threads a continuation token and bounded page size, never an offset', async () => {
    const { getCooksHandler } = loadModule();
    const { deps: d, calls } = deps(pageOf([sampleCook()], { continuationToken: 'ct-next' }));
    const { ctx } = mockContext();

    const res = await getCooksHandler(
      mockRequest({
        principalHeader: encodedPrincipal(),
        query: { limit: '500', continuationToken: 'ct-prev' },
      }),
      ctx,
      d
    );

    // The prior page's token is threaded straight back; no offset is ever passed.
    expect(calls[0].options.continuationToken).toBe('ct-prev');
    expect(calls[0].options).not.toHaveProperty('offset');

    const body = res.jsonBody as {
      continuationToken?: string;
      hasMore: boolean;
      limit: number;
      offset: number;
    };
    // The next-page token is surfaced; page size is clamped to the repository cap.
    expect(body.continuationToken).toBe('ct-next');
    expect(body.hasMore).toBe(true);
    expect(body.limit).toBe(100);
    expect(body.offset).toBe(0);
  });

  it('reports a bounded default page size and no continuation token on the last page', async () => {
    const { getCooksHandler } = loadModule();
    const { deps: d, calls } = deps(pageOf([sampleCook()]));
    const { ctx } = mockContext();

    const res = await getCooksHandler(mockRequest({ principalHeader: encodedPrincipal() }), ctx, d);

    // No limit supplied -> the api-interfaces default page size is reported.
    expect(calls[0].options.maxItemCount).toBeUndefined();
    const body = res.jsonBody as { hasMore: boolean; limit: number; continuationToken?: string };
    expect(body.limit).toBe(20);
    expect(body.hasMore).toBe(false);
    expect(body.continuationToken).toBeUndefined();
  });

  it('returns a sanitized 500 on a Cosmos failure, leaking no account detail', async () => {
    const { getCooksHandler } = loadModule();
    // A Cosmos SDK error can carry the account endpoint; assert it never escapes.
    const leaky = new Error('GET https://mgv2-secret-account.documents.azure.com/ failed');
    const { deps: d } = deps(leaky);
    const { ctx, errors } = mockContext();

    const res = await getCooksHandler(mockRequest({ principalHeader: encodedPrincipal() }), ctx, d);

    expect(res.status).toBe(500);
    const serialized = JSON.stringify(res.jsonBody);
    expect(serialized).not.toContain('secret-account');
    expect(serialized).not.toContain('documents.azure.com');
    expect((res.jsonBody as { requestId: string }).requestId).toBe('inv-42');
    // The raw (leaky) error text is not echoed into the error log either.
    expect(errors().join(' ')).not.toContain('documents.azure.com');
  });

  it('logs the measured RU charge as a bare number and never the identity', async () => {
    const { getCooksHandler } = loadModule();
    const { deps: d } = deps(pageOf([sampleCook()], { requestCharge: 3.14 }));
    const { ctx, logs } = mockContext();

    await getCooksHandler(mockRequest({ principalHeader: encodedPrincipal() }), ctx, d);

    const allLogs = logs().join(' ');
    expect(allLogs).toContain('3.14');
    // The RU log must not carry the principal's identity onto the log sink.
    expect(allLogs).not.toContain(EXPECTED_USER_ID);
    expect(allLogs).not.toContain(OID);
  });

  it('imports the cook contracts from @meatgeekv2/api-interfaces with no local re-declaration', () => {
    // Mechanical guard: the de-mocked handler must not re-declare the shared
    // contracts, and must not carry the retired user-1 tenant or a mock array.
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const fs = require('fs') as typeof import('fs');
    // eslint-disable-next-line @typescript-eslint/no-var-requires
    const path = require('path') as typeof import('path');
    const source = fs.readFileSync(path.join(__dirname, 'list-cooks.ts'), 'utf8');

    expect(source).toContain("from '@meatgeekv2/api-interfaces'");
    expect(source).not.toMatch(/interface\s+Cook\s*\{/);
    expect(source).not.toMatch(/interface\s+ListCooksRequest\b/);
    expect(source).not.toMatch(/interface\s+CookListResponse\b/);
    expect(source).not.toContain('user-1');
    expect(source).not.toContain('mockCooks');
  });
});
