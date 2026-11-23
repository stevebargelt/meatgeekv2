import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Device } from '@meatgeekv2/api-interfaces';
import { trace, type Span, type Tracer } from '@opentelemetry/api';

import {
  principalFromRequest,
  unauthenticatedResponse,
  type HeaderReader,
  type PrincipalResult,
} from '../../shared/auth/principal';
import {
  getDevicesRepository,
  mergeDeviceConfiguration,
  type DevicesRepository,
} from '../../shared/cosmos/devices-repository';
import { claimantHash, claimCodeHash, hashMatches } from '../../shared/devices/claim-code';
import {
  DeviceTwinError,
  getDeviceTwinClient,
  type DeviceTwin,
  type DeviceTwinPort,
} from '../../shared/iothub/device-twin';
import { deviceClaimTwinFailedBody, deviceTwinFailureReason } from '../cooks/device-twin-step';
import { validateClaimDevice } from './device-requests';
import {
  correlationIdOf,
  deviceConflict,
  errorBody,
  jsonResponse,
  readJsonBody,
  serverError,
  validationError,
} from './devices-http';

/**
 * HAR-130 — POST /devices/claim: a signed-in user claims a device, proving they
 * hold it with the claim code the device itself published
 * (learnings/decisions/har-130-device-provisioning-and-claim.md).
 *
 * The device keeps the code and reports only its hash in its twin's REPORTED
 * properties, which nothing but the device's own credential can write. So a
 * hash that matches what the caller typed proves the code came from the device.
 *
 *  1. Authenticate and validate (400 before any twin or Cosmos call).
 *  2. Read the twin. No twin (IoT Hub 404): refused.
 *  3. Refused unless reported `claimCodeHash` is the hash of the typed code
 *     (constant-time), reported `claimGeneration` equals desired
 *     `claimGeneration` (absent = "0"), and `claimExpiresAt` is later than the
 *     injected clock's now.
 *  4. If desired `claimConsumedCodeHash` already is that hash, carry on only
 *     when desired `claimClaimantHash` is the caller's (a retry after a partial
 *     failure). Otherwise refused.
 *  5. Otherwise patch desired `{ claimConsumedCodeHash, claimClaimantHash }`
 *     under `If-Match` with the etag from step 2. That conditional patch is what
 *     makes a code single-use when two claimants race. A 412 re-reads once and
 *     decides again from step 3.
 *  6. Create the device document (the register shape plus `claimedAt`). If the
 *     id exists: the caller's → 200 with it; anyone else's → refused.
 *
 * Answers: 201 the stored Device; 200 a retry by the same caller; 400
 * VALIDATION_ERROR; 401 (no principal); 403 CLAIM_REFUSED; 409
 * DEVICE_CONFLICT (the caller already has a device with that name); 503
 * DEVICE_TWIN_UPDATE_FAILED (a twin read or write failed); 500 (Cosmos).
 *
 * Every refusal is the same 403 body, with no request-charge header even when
 * Cosmos was reached, so the answer gives no hint which check failed. The log
 * line and the span carry a fixed refusal code for operators.
 *
 * The claim code, its hash and the claimant hash never reach a log line, an
 * error body or a span attribute.
 */

/** The single fixed refusal message. */
export const CLAIM_REFUSED_MESSAGE = 'Device could not be claimed with that code';

/** Twin reads per request: the first, and one more after a 412 on the patch. */
export const CLAIM_TWIN_MAX_READS = 2;

/** Why a claim was refused. Logged and traced; never returned. */
export type ClaimRefusal =
  | 'no_twin'
  | 'no_code'
  | 'wrong_code'
  | 'generation_mismatch'
  | 'expired'
  | 'consumed'
  | 'owned_by_other';

/** Injection seam. Tests pass a fake twin hub, a fake container, a fixed clock
 *  and a recording tracer. */
export interface ClaimDeviceDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getRepository(): Pick<DevicesRepository, 'claimDevice'>;
  getDeviceTwin(): DeviceTwinPort;
  /** The time a claim code's expiry is checked against, and `claimedAt`. */
  now(): Date;
  readonly tracer: Tracer;
}

export const defaultClaimDeviceDeps: ClaimDeviceDeps = {
  resolvePrincipal: principalFromRequest,
  getRepository: getDevicesRepository,
  getDeviceTwin: getDeviceTwinClient,
  now: () => new Date(),
  tracer: trace.getTracer('meatgeek-api'),
};

type Decision =
  | { readonly kind: 'refuse'; readonly reason: ClaimRefusal }
  | { readonly kind: 'patch' }
  | { readonly kind: 'alreadyConsumedByCaller' };

/** Steps 3 and 4: what the twin says about this code and this caller. */
function decide(twin: DeviceTwin, codeHash: string, mine: string, now: Date): Decision {
  const { reported, desired } = twin;
  if (typeof reported['claimCodeHash'] !== 'string') {
    return { kind: 'refuse', reason: 'no_code' };
  }
  if (!hashMatches(reported['claimCodeHash'], codeHash)) {
    return { kind: 'refuse', reason: 'wrong_code' };
  }
  const desiredGeneration =
    typeof desired['claimGeneration'] === 'string' ? desired['claimGeneration'] : '0';
  if (reported['claimGeneration'] !== desiredGeneration) {
    return { kind: 'refuse', reason: 'generation_mismatch' };
  }
  const expiresAt =
    typeof reported['claimExpiresAt'] === 'string' ? Date.parse(reported['claimExpiresAt']) : NaN;
  if (!Number.isFinite(expiresAt) || expiresAt <= now.getTime()) {
    return { kind: 'refuse', reason: 'expired' };
  }
  if (hashMatches(desired['claimConsumedCodeHash'], codeHash)) {
    return hashMatches(desired['claimClaimantHash'], mine)
      ? { kind: 'alreadyConsumedByCaller' }
      : { kind: 'refuse', reason: 'consumed' };
  }
  return { kind: 'patch' };
}

/** Steps 2 to 5. `ok` once the code is consumed by this caller. */
type TwinStep =
  | { readonly ok: true }
  | { readonly ok: false; readonly refusal: ClaimRefusal }
  | { readonly ok: false; readonly twinFailure: string };

async function consumeCode(
  twins: DeviceTwinPort,
  deviceId: string,
  codeHash: string,
  mine: string,
  now: Date
): Promise<TwinStep> {
  for (let read = 1; read <= CLAIM_TWIN_MAX_READS; read++) {
    let twin: DeviceTwin;
    try {
      twin = await twins.getTwin(deviceId);
    } catch (error) {
      if (error instanceof DeviceTwinError && error.isNotFound) {
        return { ok: false, refusal: 'no_twin' };
      }
      return { ok: false, twinFailure: deviceTwinFailureReason(error) };
    }

    const decision = decide(twin, codeHash, mine, now);
    if (decision.kind === 'refuse') {
      return { ok: false, refusal: decision.reason };
    }
    if (decision.kind === 'alreadyConsumedByCaller') {
      return { ok: true };
    }

    try {
      await twins.patchDesired(
        deviceId,
        { claimConsumedCodeHash: codeHash, claimClaimantHash: mine },
        twin.etag
      );
      return { ok: true };
    } catch (error) {
      if (error instanceof DeviceTwinError && error.isPreconditionFailed) {
        if (read < CLAIM_TWIN_MAX_READS) {
          continue;
        }
      } else if (error instanceof DeviceTwinError && error.isNotFound) {
        return { ok: false, refusal: 'no_twin' };
      }
      return { ok: false, twinFailure: deviceTwinFailureReason(error) };
    }
  }
  // Unreachable: the last read either returns or fails above.
  return { ok: false, twinFailure: 'iothub_patch_twin_status_412' };
}

export async function claimDeviceHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: ClaimDeviceDeps = defaultClaimDeviceDeps
): Promise<HttpResponseInit> {
  const span = deps.tracer.startSpan('claimDevice');
  try {
    return await claimDevice(request, context, deps, span);
  } finally {
    span.end();
  }
}

async function claimDevice(
  request: HttpRequest,
  context: InvocationContext,
  deps: ClaimDeviceDeps,
  span: Span
): Promise<HttpResponseInit> {
  context.log('Processing claimDevice request');
  const correlationId = correlationIdOf(request, context);
  const outcome = (value: string) => span.setAttribute('meatgeek.claim.outcome', value);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    outcome('unauthenticated');
    return unauthenticatedResponse(principal.reason, correlationId);
  }
  const userId = principal.principal.userId;

  const parsed = await readJsonBody(request);
  if (!parsed) {
    outcome('invalid');
    return validationError('Request body must be valid JSON', correlationId, context);
  }
  const validated = validateClaimDevice(parsed.body);
  if (!validated.ok) {
    outcome('invalid');
    return validationError(validated.message, correlationId, context);
  }
  const { deviceId, claimCode, name, model, location, configuration } = validated.value;
  span.setAttribute('device.id', deviceId);

  const refused = (reason: ClaimRefusal): HttpResponseInit => {
    outcome('refused');
    span.setAttribute('meatgeek.claim.refusal', reason);
    context.log(`claimDevice refused: ${reason}`);
    return jsonResponse(
      403,
      errorBody('CLAIM_REFUSED', CLAIM_REFUSED_MESSAGE, context),
      correlationId
    );
  };

  const now = deps.now();
  const codeHash = claimCodeHash(deviceId, claimCode);
  const mine = claimantHash(userId);

  let twinStep: TwinStep;
  try {
    twinStep = await consumeCode(deps.getDeviceTwin(), deviceId, codeHash, mine, now);
  } catch (error) {
    // getDeviceTwin throws DeviceTwinError('configuration') when the hub
    // hostname setting is missing.
    twinStep = { ok: false, twinFailure: deviceTwinFailureReason(error) };
  }
  if (!twinStep.ok) {
    if ('refusal' in twinStep) {
      return refused(twinStep.refusal);
    }
    outcome('twin_failed');
    context.error(`claimDevice device twin failed: ${twinStep.twinFailure}`);
    return jsonResponse(
      503,
      deviceClaimTwinFailedBody(twinStep.twinFailure, context.invocationId),
      correlationId
    );
  }

  const device: Device = {
    id: deviceId,
    userId,
    name,
    model,
    ...(location !== undefined ? { location } : {}),
    isActive: true,
    ...(configuration !== undefined
      ? { configuration: mergeDeviceConfiguration(undefined, configuration) }
      : {}),
    claimedAt: now.toISOString(),
  };

  try {
    const result = await deps.getRepository().claimDevice(device);
    context.log(`claimDevice ${result.outcome} (requestCharge=${result.requestCharge} RU)`);
    switch (result.outcome) {
      case 'created':
        outcome('created');
        return jsonResponse(201, result.device, correlationId, result.requestCharge);
      case 'ownedByCaller':
        outcome('retried');
        return jsonResponse(200, result.device, correlationId, result.requestCharge);
      case 'nameConflict':
        outcome('name_conflict');
        return deviceConflict(correlationId, context, result.requestCharge);
      case 'foreign':
        return refused('owned_by_other');
    }
  } catch (error) {
    outcome('store_failed');
    return serverError('claimDevice', 'Failed to claim device', error, correlationId, context);
  }
}
