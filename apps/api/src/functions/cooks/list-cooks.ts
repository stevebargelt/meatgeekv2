import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type {
  Cook,
  CookListResponse,
  CookStatus,
  ListCooksRequest,
} from '@meatgeekv2/api-interfaces';

import { principalFromRequest, unauthenticatedResponse } from '../../shared/auth/principal';
import {
  CooksRepository,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  getCooksRepository,
} from '../../shared/cosmos/cooks-repository';
import { requestChargeHeaders, requestChargeOfError } from '../../shared/cosmos/request-charge';
import { correlationIdOf } from '../devices/devices-http';

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
 * FILTERS (MG-87)
 * `deviceId` and `status` narrow the caller's own cooks and combine with AND.
 * The data-pusher's reconcile asks for `deviceId=<id>&status=active` and treats
 * the first cook as authoritative, so the filters must be honoured, not ignored.
 * Both are validated before any query: `status` must be a CookStatus and
 * `deviceId` a non-empty opaque string of at most
 * {@link MAX_DEVICE_ID_LENGTH} characters. Anything else is a 400 that spends
 * no RU. Neither filter can widen the query beyond the caller's partition.
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
 * The wire body is exactly the api-interfaces {@link CookListResponse}:
 * `cooks`, `limit`, `hasMore` and — when `hasMore` — the opaque
 * `continuationToken`. There is no `total` (an exact count would need a separate
 * COUNT that charges the shared pool) and no `offset` (MG-85). Each cook is
 * already projected to the Cook contract by the repository, so no Cosmos system
 * property (`_rid`, `_self`, `_etag`, ...) reaches the body.
 *
 * REQUEST ID (HAR-75)
 * Every response, the 400s, 401 and 500 included, carries `X-Request-ID`: the
 * caller's when it sent one, else the invocation id. The body's `requestId`
 * stays the invocation id.
 *
 * SANITIZED FAILURES
 * A dependency failure returns a fixed 500 shape with a request id and nothing
 * else; the raw error is NOT logged, because a Cosmos SDK error can carry the
 * account endpoint. The measured RU charge is logged as a bare number for the
 * shared-throughput budget, never alongside the principal's identity.
 */

/** The recognised query inputs. A caller-supplied `userId` is deliberately NOT
 *  part of this shape — identity is never taken from the query. */
type ListCooksQuery = Pick<ListCooksRequest, 'limit' | 'continuationToken' | 'deviceId' | 'status'>;

/** Longest `deviceId` filter accepted. Device ids are opaque; this only bounds
 *  what a caller can make the query carry. */
export const MAX_DEVICE_ID_LENGTH = 128;

/** Every CookStatus. A Record so the compiler fails if the union gains or loses
 *  a member and this list is not updated with it. */
const COOK_STATUSES: Record<CookStatus, true> = {
  planning: true,
  active: true,
  paused: true,
  completed: true,
  cancelled: true,
};

function isCookStatus(value: string): value is CookStatus {
  return Object.prototype.hasOwnProperty.call(COOK_STATUSES, value);
}

function validationError(
  message: string,
  correlationId: string,
  context: InvocationContext
): HttpResponseInit {
  return {
    status: 400,
    headers: { 'Content-Type': 'application/json', 'X-Request-ID': correlationId },
    jsonBody: { error: 'VALIDATION_ERROR', message, requestId: context.invocationId },
  };
}

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
  const correlationId = correlationIdOf(request, context);

  // Identity FIRST: reject before any query is issued, so an unauthenticated
  // caller never spends a single RU of the shared pool.
  const auth = principalFromRequest(request);
  if (!auth.authenticated) {
    return unauthenticatedResponse(auth.reason, correlationId);
  }
  const userId = auth.principal.userId;

  // A caller MAY still send the legacy `userId` query param; it is read here only
  // to be discarded. The authenticated principal is the sole partition axis.
  void request.query.get('userId');

  // MG-87 filters, validated before any query so a bad one spends no RU.
  const statusParam = request.query.get('status');
  if (statusParam !== null && !isCookStatus(statusParam)) {
    return validationError(
      `status must be one of: ${Object.keys(COOK_STATUSES).join(', ')}`,
      correlationId,
      context
    );
  }
  const deviceIdParam = request.query.get('deviceId');
  if (
    deviceIdParam !== null &&
    (deviceIdParam.length === 0 || deviceIdParam.length > MAX_DEVICE_ID_LENGTH)
  ) {
    return validationError(
      `deviceId must be 1 to ${MAX_DEVICE_ID_LENGTH} characters`,
      correlationId,
      context
    );
  }

  const limitParam = request.query.get('limit');
  const filters: ListCooksQuery = {
    limit: limitParam !== null ? Number(limitParam) : undefined,
    continuationToken: request.query.get('continuationToken') ?? undefined,
    deviceId: deviceIdParam ?? undefined,
    status: statusParam ?? undefined,
  };

  try {
    const repository = deps.getRepository();
    const page = await repository.listCooksByUser(userId, {
      maxItemCount: filters.limit,
      continuationToken: filters.continuationToken,
      deviceId: filters.deviceId,
      status: filters.status,
    });

    const cooks: Cook[] = page.cooks;

    // RU charge and page size are bare numbers — safe to log for the shared
    // 400 RU/s budget. The principal's identity is deliberately NOT logged.
    context.log(`getCooks completed: requestCharge=${page.requestCharge} returned=${cooks.length}`);

    const response: CookListResponse = {
      cooks,
      limit: effectivePageSize(filters.limit),
      hasMore: page.continuationToken !== undefined,
    };
    if (page.continuationToken !== undefined) {
      response.continuationToken = page.continuationToken;
    }

    return {
      status: 200,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': correlationId,
        ...requestChargeHeaders(page.requestCharge),
      },
      jsonBody: response,
    };
  } catch (error) {
    // The raw error is intentionally NOT logged or echoed: a Cosmos SDK error can
    // carry the account endpoint. Report a fixed shape keyed by the request id so
    // the failure is still traceable in platform logs without leaking config.
    // Only the error's numeric RU charge, when Cosmos reported one, is read.
    context.error(`getCooks failed (requestId=${context.invocationId})`);

    return {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        'X-Request-ID': correlationId,
        ...requestChargeHeaders(requestChargeOfError(error)),
      },
      jsonBody: {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to retrieve cooks',
        requestId: context.invocationId,
      },
    };
  }
}
