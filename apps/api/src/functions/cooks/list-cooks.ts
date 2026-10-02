import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Cook, CookListResponse, ListCooksRequest } from '@meatgeekv2/api-interfaces';

import { principalFromRequest, unauthenticatedResponse } from '../../shared/auth/principal';
import {
  CooksRepository,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  getCooksRepository,
} from '../../shared/cosmos/cooks-repository';

/**
 * MG-59 — list a SINGLE authenticated user's persisted cooks.
 *
 * WHAT CHANGED FROM THE MOCK
 * This handler no longer fabricates an inline mock array, no longer re-declares
 * Cook/ListCooksRequest/CookListResponse locally (they come from
 * @meatgeekv2/api-interfaces), and no longer trusts a `userId` query param. The
 * ONLY partition axis is the authenticated Easy Auth principal (see
 * ../../shared/auth/principal): a caller-supplied `userId` is read solely to be
 * discarded, because honoring it would let any caller page another tenant's
 * cooks. Unauthenticated requests are rejected BEFORE any query is issued.
 *
 * PAGINATION — CONTINUATION TOKEN, NEVER OFFSET
 * The cooks container draws on a database-level 400 RU/s shared offer that the
 * IoT temperature-ingest path also spends against. Offset pagination re-charges
 * every skipped document against that shared pool on each page, so this route
 * uses the repository's single-partition, capped-page-size, continuation-token
 * model. The opaque `continuationToken` from a prior page is threaded straight
 * back to the repository; the client advances by echoing it, not by an offset.
 *
 * RESPONSE SHAPE
 * The wire body extends the api-interfaces {@link CookListResponse}. That
 * interface predates persistence and carries offset-era fields (`total`,
 * `offset`) that a single-partition continuation query cannot cheaply compute — a
 * true `total` would require a separate COUNT that charges the shared pool. So
 * `hasMore` + `continuationToken` are the AUTHORITATIVE pagination signals here;
 * `total` reports the current page's size and `offset` is a fixed 0 retained only
 * for wire compatibility. Reconciling that interface is out of scope for MG-59
 * (cooks-only; no api-interfaces edits).
 *
 * SANITIZED FAILURES
 * A dependency failure returns a fixed 500 shape with a request id and nothing
 * else; the raw error is NOT logged, because a Cosmos SDK error can carry the
 * account endpoint. The measured RU charge is logged as a bare number for the
 * shared-throughput budget, never alongside the principal's identity.
 */

/** The continuation-model body this route returns. Extends the api-interfaces
 *  contract (not a re-declaration of it) with the opaque next-page token. */
export interface PaginatedCookListResponse extends CookListResponse {
  /** Opaque token for the next page, or absent when the partition is drained.
   *  NEVER an offset. */
  continuationToken?: string;
}

/** The recognised pagination inputs. `limit` is the api-interfaces field; the
 *  continuation token is this route's cursor. A caller-supplied `userId` is
 *  deliberately NOT part of this shape — identity is never taken from the query. */
type ListCooksQuery = Pick<ListCooksRequest, 'limit'> & {
  continuationToken?: string;
};

/** Mirrors the repository's clamp so the reported `limit` matches the page the
 *  repository actually served. Kept local rather than exported from the
 *  repository to avoid widening that module's surface for a display value. */
function effectivePageSize(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested) || requested <= 0) {
    return DEFAULT_PAGE_SIZE;
  }
  return Math.min(Math.floor(requested), MAX_PAGE_SIZE);
}

/** Injectable dependencies — the repository is a seam so unit tests run against a
 *  fake with no Azure and no credentials. */
export interface ListCooksHandlerDeps {
  getRepository: () => CooksRepository;
}

const defaultDeps: ListCooksHandlerDeps = {
  getRepository: getCooksRepository,
};

export async function getCooksHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: ListCooksHandlerDeps = defaultDeps
): Promise<HttpResponseInit> {
  context.log('Processing getCooks request');

  // Identity FIRST: reject before any query is issued, so an unauthenticated
  // caller never spends a single RU of the shared pool.
  const auth = principalFromRequest(request);
  if (!auth.authenticated) {
    return unauthenticatedResponse(auth.reason, context.invocationId);
  }
  const userId = auth.principal.userId;

  // A caller MAY still send the legacy `userId` query param; it is read here only
  // to be discarded. The authenticated principal is the sole partition axis.
  void request.query.get('userId');

  const limitParam = request.query.get('limit');
  const query: ListCooksQuery = {
    limit: limitParam !== null ? Number(limitParam) : undefined,
    continuationToken: request.query.get('continuationToken') ?? undefined,
  };

  try {
    const repository = deps.getRepository();
    const page = await repository.listCooksByUser(userId, {
      maxItemCount: query.limit,
      continuationToken: query.continuationToken,
    });

    const cooks: Cook[] = page.cooks;

    // RU charge and page size are bare numbers — safe to log for the shared
    // 400 RU/s budget. The principal's identity is deliberately NOT logged.
    context.log(`getCooks completed: requestCharge=${page.requestCharge} returned=${cooks.length}`);

    const response: PaginatedCookListResponse = {
      cooks,
      // Offset-era fields the single-partition continuation model cannot cheaply
      // fill; see the module comment. hasMore + continuationToken are authoritative.
      total: cooks.length,
      offset: 0,
      limit: effectivePageSize(query.limit),
      hasMore: page.continuationToken !== undefined,
      continuationToken: page.continuationToken,
    };

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': context.invocationId,
      },
      jsonBody: response,
    };
  } catch {
    // The raw error is intentionally NOT logged or echoed: a Cosmos SDK error can
    // carry the account endpoint. Report a fixed shape keyed by the request id so
    // the failure is still traceable in platform logs without leaking config.
    context.error(`getCooks failed (requestId=${context.invocationId})`);

    return {
      status: 500,
      headers: { 'Content-Type': 'application/json' },
      jsonBody: {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve cooks',
        requestId: context.invocationId,
      },
    };
  }
}
