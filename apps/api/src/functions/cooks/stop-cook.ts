import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Cook } from '@meatgeekv2/api-interfaces';

import {
  buildCookEnvelope,
  COOK_STOPPED,
  signalROutput,
  SignalROutputMessage,
} from '../signalr/envelope';
import {
  principalFromRequest,
  unauthenticatedResponse,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import { CooksRepository, getCooksRepository } from '../../shared/cosmos/cooks-repository';
import { getDeviceOwnership, type DeviceOwnership } from '../../shared/cosmos/devices-repository';
import { chargeAfterError, requestChargeHeaders } from '../../shared/cosmos/request-charge';
import { deviceNotOwnedBody } from './device-ownership';

/**
 * MG-59 — stop a cook by durably completing the REAL persisted document.
 *
 * This handler no longer mints a synthetic placeholder cook (the old mock stamped
 * `name: `Cook ${id}``, `startTime: endTime`, `meatType: 'unknown'` and a
 * hardcoded `user-1` tenant). It now read-then-updates the actual cook the caller
 * started: it derives the partition `userId` from the authenticated Easy Auth
 * principal, point-reads `(userId, cookId)` in that single partition, transitions
 * it to `completed` with a real `endTime`, and returns the persisted final state.
 * The SignalR COOK_STOPPED envelope is emitted ONLY after that write succeeds, and
 * its delivery scope (userId = the cook's deviceId) stays a distinct axis from the
 * persisted identity userId.
 *
 * HAR-26 (MG-83, MG-88): the cook's device must belong to the caller. The
 * deviceId is only known from the stored cook, so the handler first point-reads
 * `(userId, cookId)` in the caller's partition (404 when absent), then point-reads
 * the device's ownership. A device registered to someone else, or not registered
 * at all, gets 403 DEVICE_NOT_OWNED with no write and no SignalR output. Only
 * then does the stop run. The RU header sums every read and write.
 *
 * Sanitization (MG-51 discipline): a dependency error can carry the account host,
 * the database/container name, or token fragments. None of it reaches a response
 * body or a log line — failures collapse to a fixed error class and the RU charge
 * surfaced for measurement is a bare number.
 */

/**
 * The repository surface stop-cook depends on. Injected behind {@link StopCookDeps}
 * so unit tests exercise the read-then-update path against a fake with no Azure and
 * no credentials.
 */
export type StopCookRepository = Pick<CooksRepository, 'getCook' | 'stopCook'>;

/**
 * The seams stop-cook resolves the request through: the authenticated principal,
 * the cooks repository and the devices ownership read. Defaulted to the real
 * implementations; a test injects fakes so neither Easy Auth nor Cosmos is
 * touched.
 */
export interface StopCookDeps {
  resolvePrincipal: (request: HeaderReader) => PrincipalResult;
  getRepository: () => StopCookRepository;
  /** HAR-26: who owns `deviceId` relative to `userId` (one point read). */
  getDeviceOwnership: (userId: string, deviceId: string) => Promise<DeviceOwnership>;
}

const defaultDeps: StopCookDeps = {
  resolvePrincipal: principalFromRequest,
  getRepository: getCooksRepository,
  getDeviceOwnership,
};

function jsonResponse(
  status: number,
  body: unknown,
  correlationId: string,
  requestCharge: number | undefined
): HttpResponseInit {
  return {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': correlationId,
      ...requestChargeHeaders(requestCharge),
    },
    jsonBody: body,
  };
}

export async function stopCookHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: StopCookDeps = defaultDeps
): Promise<HttpResponseInit> {
  context.log('Processing stopCook request');

  // Correlation id propagates from the inbound request when present, else the
  // Functions invocation id (matches start-cook).
  const correlationId = request.headers.get('X-Request-ID') ?? context.invocationId;

  // The cooks partition value comes SOLELY from the authenticated Easy Auth
  // principal — never from the body, the query string, or a fabricated tenant.
  // An unauthenticated request is rejected before any read or write; the response
  // carries a fixed reason code only, never identity material.
  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }
  const { userId } = principal.principal;

  const cookId = request.params['cookId'];
  if (!cookId || cookId.trim().length === 0) {
    // Defensive: the route binds `{cookId}`, so this is unreachable in the
    // deployed app, but an empty id must never be addressed against Cosmos.
    return {
      status: 400,
      headers: { 'Content-Type': 'application/json', 'X-Request-ID': correlationId },
      jsonBody: {
        error: 'VALIDATION_ERROR',
        message: 'Missing required path parameter: cookId',
        requestId: context.invocationId,
      },
    };
  }

  let spent = 0;
  let stopped: Cook | undefined;
  let transitioned = false;
  try {
    // HAR-26: the deviceId is only known from the stored cook. Point-read it in
    // the caller's partition first. A cook owned by a different principal lives
    // in a different partition and is invisible here, so a miss also refuses any
    // cross-tenant addressing attempt.
    const repository = deps.getRepository();
    const existing = await repository.getCook(userId, cookId);
    spent += existing.requestCharge;
    if (!existing.cook) {
      return jsonResponse(
        404,
        { error: 'NOT_FOUND', message: 'Cook not found', requestId: context.invocationId },
        correlationId,
        spent
      );
    }

    // HAR-26 (MG-83): the cook's device must still be the caller's. One point
    // read on the devices container, before any write or SignalR output.
    const ownership = await deps.getDeviceOwnership(userId, existing.cook.deviceId);
    spent += ownership.requestCharge;
    if (ownership.status !== 'owned') {
      context.log(`stopCook refused: device not owned (requestCharge=${spent} RU)`);
      return jsonResponse(403, deviceNotOwnedBody(context.invocationId), correlationId, spent);
    }

    // Read-then-update within the caller's partition. The repository point-reads
    // (userId, cookId) and only replaces the correctly-addressed document when it
    // exists — a miss returns `cook: undefined` WITHOUT writing.
    const endTime = new Date().toISOString();
    const result = await repository.stopCook(userId, cookId, endTime);
    spent += result.requestCharge;
    stopped = result.cook;
    transitioned = result.transitioned;
    // RU charge is a bare number — safe to log against the shared 400 RU/s budget.
    context.log(`stopCook request charge: ${spent}`);
  } catch (error) {
    // A Cosmos/credential error can carry the account host, database, container,
    // or token fragments; it is swallowed and replaced with a fixed class so
    // nothing leaks. No SignalR message is emitted on failure. Only RU numbers
    // are surfaced: what the completed reads spent plus the error's own charge.
    context.error('stopCook failed: cosmos_stop_failed');
    return jsonResponse(
      500,
      {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to stop cook',
        requestId: context.invocationId,
      },
      correlationId,
      chargeAfterError(spent, error)
    );
  }

  // The cook vanished between the read above and the stop (cooks are never
  // deleted, so this is defensive) → 404, NO SignalR emit.
  if (!stopped) {
    return jsonResponse(
      404,
      { error: 'NOT_FOUND', message: 'Cook not found', requestId: context.invocationId },
      correlationId,
      spent
    );
  }

  context.log(`Stopped cook: ${stopped.id}`);

  // Emit COOK_STOPPED ONLY when THIS call's durable update performed the
  // transition (emit-after-write). An already-completed cook — a retried stop
  // whose first response was lost, or a concurrent stop that lost the race — is
  // still returned 200 idempotently, but is not re-announced: no new write, no
  // new event. Delivery is scoped to the device's SignalR user group (userId =
  // deviceId) — a DIFFERENT axis from the persisted identity userId, which stays
  // the authenticated principal. deviceId and the payload (MG-31: name,
  // startTime, ...) come from the persisted cook, not the caller.
  if (transitioned) {
    const message: SignalROutputMessage = {
      target: COOK_STOPPED,
      userId: stopped.deviceId,
      arguments: [buildCookEnvelope(COOK_STOPPED, stopped, correlationId)],
    };
    context.extraOutputs.set(signalROutput, [message]);
  }

  return jsonResponse(200, stopped, correlationId, spent);
}
