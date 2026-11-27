import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { TargetTemperatures } from '@meatgeekv2/api-interfaces';

import {
  principalFromRequest,
  unauthenticatedResponse,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import {
  getCooksRepository,
  type CooksRepository,
  type StoredCookDocument,
} from '../../shared/cosmos/cooks-repository';
import { getDeviceOwnership, type DeviceOwnership } from '../../shared/cosmos/devices-repository';
import { chargeAfterError } from '../../shared/cosmos/request-charge';
import {
  correlationIdOf,
  errorBody,
  jsonResponse,
  readJsonBody,
  validationError,
} from '../devices/devices-http';
import { validateCookTargets } from './cook-requests';
import { deviceNotOwnedBody } from './device-ownership';
import { retarget } from './target-rule';

/**
 * #240 — PUT /cooks/{cookId}/targets: set, change and clear the targets of one
 * of the caller's RUNNING cooks.
 *
 * The body's `targetTemps` is the cook's whole set of targets after the save,
 * with the limits POST /cooks applies (grill and probes 1 to 4, each 0 to
 * 1000 °F). A channel left out is cleared. Saves are not merged, so the last
 * save wins.
 *
 * A channel whose target changes, is added or is cleared re-arms: its reached
 * mark and any reading pending under the old target go (see
 * ./target-rule.ts `retarget`). A target already met is then reached under the
 * ordinary rule, on the next two readings. Saving the value a channel already
 * has changes nothing for it; saving every target unchanged writes nothing.
 *
 * Order of checks, as stop-cook: 400 on the body before any Cosmos call; the
 * cook is point-read in the caller's partition (404 when absent, including
 * another user's cook); a cook that is not running is 409 COOK_NOT_ACTIVE; its
 * device must be the caller's (403 DEVICE_NOT_OWNED). The write is a
 * read-then-replace with If-Match (CooksRepository.updateActiveCook), so it
 * cannot undo a concurrent stop or a write of the target rule: on a 412 it
 * reads the cook again and re-arms against the new version. A cook stopped in
 * between is 409.
 *
 * No SignalR message and no device twin change: the device does not know the
 * targets. An open cook screen picks the change up with its next read of the
 * cook (the iOS live screen reads it again after each pushed reading).
 */

export const COOK_NOT_ACTIVE = 'COOK_NOT_ACTIVE';

export type UpdateCookTargetsRepository = Pick<CooksRepository, 'getCook' | 'updateActiveCook'>;

export interface UpdateCookTargetsDeps {
  resolvePrincipal: (request: HeaderReader) => PrincipalResult;
  getRepository: () => UpdateCookTargetsRepository;
  getDeviceOwnership: (userId: string, deviceId: string) => Promise<DeviceOwnership>;
}

const defaultDeps: UpdateCookTargetsDeps = {
  resolvePrincipal: principalFromRequest,
  getRepository: getCooksRepository,
  getDeviceOwnership,
};

function nonEmpty<T extends object>(map: T): T | undefined {
  return Object.keys(map).length > 0 ? map : undefined;
}

/** The fields to write for `targets`, or `undefined` when nothing changes. */
function targetChange(
  cook: StoredCookDocument,
  targets: TargetTemperatures
): Partial<StoredCookDocument> | undefined {
  const before = {
    targetsReached: cook.targetsReached ?? {},
    targetsPending: cook.targetsPending ?? {},
  };
  const after = retarget(before, cook.targetTemps, targets);
  const sameTargets =
    JSON.stringify(Object.entries(cook.targetTemps ?? {}).sort()) ===
    JSON.stringify(Object.entries(targets).sort());
  if (sameTargets && after === before) {
    return undefined;
  }
  return {
    targetTemps: nonEmpty(targets),
    targetsReached: nonEmpty(after.targetsReached),
    targetsPending: nonEmpty(after.targetsPending),
  };
}

export async function updateCookTargetsHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: UpdateCookTargetsDeps = defaultDeps
): Promise<HttpResponseInit> {
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }
  const { userId } = principal.principal;

  const cookId = request.params['cookId'];
  if (!cookId || cookId.trim().length === 0) {
    return validationError('Missing required path parameter: cookId', correlationId, context);
  }

  const parsed = await readJsonBody(request);
  const validated = parsed
    ? validateCookTargets(parsed.body)
    : ({ ok: false, message: 'Request body must be valid JSON' } as const);
  if (!validated.ok) {
    return validationError(validated.message, correlationId, context);
  }
  const targets = validated.value;

  const notActive = (spent: number) =>
    jsonResponse(
      409,
      errorBody(COOK_NOT_ACTIVE, 'Targets can be changed only on a running cook', context),
      correlationId,
      spent
    );

  let spent = 0;
  try {
    const repository = deps.getRepository();
    const existing = await repository.getCook(userId, cookId);
    spent += existing.requestCharge;
    if (!existing.cook) {
      return jsonResponse(404, errorBody('NOT_FOUND', 'Cook not found', context), correlationId, spent);
    }
    if (existing.cook.status !== 'active') {
      return notActive(spent);
    }

    const ownership = await deps.getDeviceOwnership(userId, existing.cook.deviceId);
    spent += ownership.requestCharge;
    if (ownership.status !== 'owned') {
      return jsonResponse(403, deviceNotOwnedBody(context.invocationId), correlationId, spent);
    }

    const result = await repository.updateActiveCook(userId, cookId, cook =>
      targetChange(cook, targets)
    );
    spent += result.requestCharge;
    context.log(`updateCookTargets outcome=${result.outcome} requestCharge=${spent}`);
    if (result.outcome === 'notActive') {
      return notActive(spent);
    }
    return jsonResponse(200, result.cook, correlationId, spent);
  } catch (error) {
    context.error('updateCookTargets failed: cosmos_update_failed');
    return jsonResponse(
      500,
      errorBody('INTERNAL_SERVER_ERROR', 'Failed to change the targets', context),
      correlationId,
      chargeAfterError(spent, error)
    );
  }
}
