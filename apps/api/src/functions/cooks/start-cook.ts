import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Cook } from '@meatgeekv2/api-interfaces';
import {
  buildCookEnvelope,
  COOK_STARTED,
  signalROutput,
  SignalROutputMessage,
} from '../signalr/envelope';
import {
  HeaderReader,
  PrincipalResult,
  principalFromRequest,
  unauthenticatedResponse,
} from '../../shared/auth/principal';
import type { CooksRepository } from '../../shared/cosmos/cooks-repository';
import { getDeviceOwnership, type DeviceOwnership } from '../../shared/cosmos/devices-repository';
import { chargeAfterError, requestChargeHeaders } from '../../shared/cosmos/request-charge';
import { syncDeviceTwin, type SyncDeviceTwin } from '../../shared/iothub/device-twin-sync';
import { correlationIdOf, readJsonBody } from '../devices/devices-http';
import { validateStartCook } from './cook-requests';
import { deviceNotOwnedBody } from './device-ownership';
import { deviceTwinUpdateFailedBody, runDeviceTwinStep } from './device-twin-step';

/**
 * MG-59 step 4 — start a cook by PERSISTING it through the shared Cosmos
 * adapter under managed identity, then emitting the SignalR COOK_STARTED
 * envelope.
 *
 * Two things this file no longer does, both required by the ticket:
 *   - it does NOT mint a mock Cook and return it; the cook is written to the
 *     cooks container (partition = the authenticated identity's userId) and the
 *     PERSISTED document is what the 201 returns; and
 *   - it does NOT hardcode `userId: 'user-1'`; the partition value is derived
 *     from the authenticated Easy Auth principal (see ../../shared/auth/principal).
 *
 * MG-84 makes the start retry-safe. The client supplies the cook `id` (a UUID,
 * reused on every retry), so:
 *   - 201: this call created the cook; COOK_STARTED is emitted once;
 *   - 200: the cook already exists with the same body (a retry or a concurrent
 *     duplicate); the stored cook is returned and NOTHING is emitted;
 *   - 422 COOK_ID_REUSED: the id exists with a different body;
 *   - 409 COOK_ALREADY_ACTIVE: another cook is active on this device for this
 *     user (one active cook per device), with its id in `activeCookId`.
 *
 * HAR-26 (MG-88, MG-83) checks the device first. A cook may only start on a
 * device the caller owns (a registered device whose `userId` is the caller's).
 * Ownership is one point read on the devices container, made before any write
 * or SignalR output. A device that belongs to someone else and a device that is
 * not registered both get the same 403 DEVICE_NOT_OWNED, so the answer does not
 * reveal whether another user owns the id. Since only the owner can start a
 * cook on a device, "one active cook per (user, device)" is in effect one active
 * cook per device.
 *
 * HAR-66 (goal HAR-55) syncs the device twin after the write: on 201 and on a
 * matching 200 replay (so a retry heals a failed sync), never on 409 or 422.
 * The twin's desired `activeCookId` / `correlationId` follow the device's active
 * cook in Cosmos (see shared/iothub/device-twin-sync). If the sync fails the
 * cook stays committed and the answer is 503 DEVICE_TWIN_UPDATE_FAILED; a
 * retry of the same request replays and syncs again. `cook_started` is still
 * emitted on creation even when the answer is 503, because the cook exists.
 *
 * HAR-75 validates the whole body (cook-requests.ts): a body that is not valid
 * JSON, is `null`, has an unknown key or breaks a field rule is 400
 * VALIDATION_ERROR naming the field, before any Cosmos call. Every response
 * carries `X-Request-ID`: the caller's when it sent one, else the invocation
 * id. That same value is the correlation id the twin and `cook_started` carry.
 * The body's `requestId` stays the invocation id.
 *
 * The `Cook` and `StartCookRequest` shapes are the canonical ones from
 * @meatgeekv2/api-interfaces — there is no local re-declaration here.
 */

/**
 * Transitional re-export of the canonical contract types. Forwarding them from
 * @meatgeekv2/api-interfaces (rather than re-declaring them) means this handler
 * introduces no second, drifting definition of the contract while a consumer
 * still reaches the type through this module — currently the cook-events
 * integration spec (apps/api/src/integration/cook-events.integration.spec.ts),
 * which imports `Cook` from here. Safe to delete once nothing imports Cook from
 * this module.
 */
export type { Cook, StartCookRequest } from '@meatgeekv2/api-interfaces';

/**
 * Injection seam. Production wires the real Easy Auth principal reader, the
 * adapter-backed cooks repository and the devices ownership read; unit tests
 * pass fakes so no Azure, no credentials, and no network are touched.
 * `getRepository` is only asked for the one method this handler uses (the start
 * batch), so a test double can be a bare object.
 */
export interface StartCookDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getRepository(): Pick<CooksRepository, 'startCook'>;
  /** HAR-26: who owns `deviceId` relative to `userId` (one point read). */
  getDeviceOwnership(userId: string, deviceId: string): Promise<DeviceOwnership>;
  /** HAR-66: bring the device twin in line with Cosmos after the write. */
  syncDeviceTwin: SyncDeviceTwin;
}

/**
 * Resolve the adapter-backed cooks repository at INVOCATION time rather than at
 * module load. Importing this handler (and therefore main.ts) then carries NO
 * side effect: the shared adapter's fail-loud config guard fires when the
 * repository is first USED on the cook path — matching the cosmos-health handler,
 * which likewise reaches Cosmos inside the invocation, not at module scope. The
 * adapter caches its client singleton, so after the first hit this is a bare
 * lookup. (MG-59 FIX 1: the adapter is LAZY — it reads no config and constructs
 * no client at its own module load, so an unconfigured app imports cleanly and
 * fails loud on the FIRST request that reaches Cosmos, surfacing on the cook path
 * as a sanitized 5xx and on the health route as an unhealthy 503. Nothing here
 * ever falls back to a default or serves a fixture.)
 */
function resolveCooksRepository(): Pick<CooksRepository, 'startCook'> {
  return (
    require('../../shared/cosmos/cooks-repository') as typeof import('../../shared/cosmos/cooks-repository')
  ).getCooksRepository();
}

const defaultDeps: StartCookDeps = {
  resolvePrincipal: principalFromRequest,
  getRepository: resolveCooksRepository,
  getDeviceOwnership,
  syncDeviceTwin,
};

/**
 * Read a numeric status off a thrown error WITHOUT reading any of its text, so a
 * Cosmos error's account/endpoint string never reaches a log line. Mirrors the
 * numeric-status-only discipline in cosmos-health / the cooks repository.
 */
function statusCodeOf(error: unknown): number | undefined {
  const reported = error as { code?: unknown; statusCode?: unknown } | null | undefined;
  for (const value of [reported?.statusCode, reported?.code]) {
    if (typeof value === 'number') {
      return value;
    }
  }
  return undefined;
}

/** JSON with object keys sorted, so two equal values compare equal whatever
 *  order their keys were written in. `undefined` members drop out, matching how
 *  an absent optional field is stored. */
function canonicalJson(value: unknown): string {
  return JSON.stringify(value, (_key, member: unknown) =>
    member !== null && typeof member === 'object' && !Array.isArray(member)
      ? Object.fromEntries(
          Object.entries(member as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
        )
      : member
  );
}

/** The request-derived fields of a cook: what a retry must repeat exactly. */
function startFields(cook: Cook): unknown {
  return {
    deviceId: cook.deviceId,
    name: cook.name,
    meatType: cook.meatType,
    weight: cook.weight,
    targetTemps: cook.targetTemps,
    notes: cook.notes,
  };
}

/** A JSON response. `X-Request-ID` is the caller's request id, else the
 *  invocation id (HAR-75); the RU charge header (HAR-11) is set when the
 *  request reached Cosmos. */
function jsonResponse(
  status: number,
  body: unknown,
  correlationId: string,
  requestCharge?: number
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

export async function startCookHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: StartCookDeps = defaultDeps
): Promise<HttpResponseInit> {
  context.log('Processing startCook request');
  // Correlation id propagates from the inbound request when present, else the
  // Functions invocation id. Every response's X-Request-ID, the twin and the
  // SignalR envelope all carry it.
  const correlationId = correlationIdOf(request, context);

  // RU spent by the Cosmos calls that completed, so a later failure still
  // reports them (HAR-11).
  let spent = 0;
  try {
    // Authenticate FIRST. An unauthenticated caller does no work: no body parse,
    // no write, no SignalR emit. The userId that partitions the cook comes ONLY
    // from the validated Easy Auth principal — never the body, never 'user-1'.
    const principalResult = deps.resolvePrincipal(request);
    if (!principalResult.authenticated) {
      return unauthenticatedResponse(principalResult.reason, correlationId);
    }
    const { userId } = principalResult.principal;

    // HAR-75: invalid JSON, `null`, an unknown key or a field that breaks its
    // rule is a 400 naming the field, before any Cosmos call.
    const parsed = await readJsonBody(request);
    const validated = parsed
      ? validateStartCook(parsed.body)
      : ({ ok: false, message: 'Request body must be valid JSON' } as const);
    if (!validated.ok) {
      return jsonResponse(
        400,
        { error: 'VALIDATION_ERROR', message: validated.message, requestId: context.invocationId },
        correlationId
      );
    }
    const body = validated.value;

    // HAR-26 (MG-88, MG-83): the caller must own the device. One point read on
    // the devices container, before any write and before any SignalR output.
    // Foreign and unknown devices share one 403 body.
    const ownership = await deps.getDeviceOwnership(userId, body.deviceId);
    spent += ownership.requestCharge;
    if (ownership.status !== 'owned') {
      context.log(`startCook refused: device not owned (requestCharge=${spent} RU)`);
      return jsonResponse(403, deviceNotOwnedBody(context.invocationId), correlationId, spent);
    }

    // The new cook. Its `userId` is the authenticated principal — this is BOTH
    // the ownership identity and the Cosmos partition value, so the document
    // lands in the caller's partition and nowhere else.
    const newCook: Cook = {
      id: body.id,
      userId,
      deviceId: body.deviceId,
      name: body.name,
      status: 'active',
      startTime: new Date().toISOString(),
      meatType: body.meatType,
      targetTemps: body.targetTemps,
      notes: body.notes,
    };
    if (body.weight !== undefined) {
      newCook.weight = body.weight;
    }

    // Persist BEFORE emitting. The durable write is the event of record; the
    // SignalR envelope is a post-commit side effect, so a write failure below
    // throws to the catch and NO envelope is ever set. The cook and its device
    // lock are written in one transactional batch (see CooksRepository.startCook).
    const result = await deps.getRepository().startCook(newCook);
    let requestCharge = spent + result.requestCharge;

    // RU charge is a bare number — safe to log for the shared-throughput budget.
    context.log(`startCook ${result.outcome} (requestCharge=${requestCharge} RU)`);

    // MG-84 D2: one active cook per device (per (user, device), and only the
    // owner can start one). Nothing was written.
    if (result.outcome === 'deviceBusy') {
      return jsonResponse(
        409,
        {
          error: 'COOK_ALREADY_ACTIVE',
          message: 'This device already has an active cook. Stop it before starting another.',
          requestId: context.invocationId,
          activeCookId: result.activeCookId,
        },
        correlationId,
        requestCharge
      );
    }

    // MG-84 D1: a cook with this id already exists. A retry of the same request
    // gets the original cook back (200) and emits NOTHING: COOK_STARTED was
    // already sent by the call that created it. The same id with a different
    // body is a client bug, not a retry, so it is refused rather than answered
    // with a cook the client did not ask for.
    if (result.outcome === 'replayed') {
      if (canonicalJson(startFields(result.cook)) !== canonicalJson(startFields(newCook))) {
        return jsonResponse(
          422,
          {
            error: 'COOK_ID_REUSED',
            message: 'A cook with this id already exists with a different request body.',
            requestId: context.invocationId,
          },
          correlationId,
          requestCharge
        );
      }
    }

    const storedCook = result.cook;

    // Emit AFTER the successful write, and only on creation. The message-level
    // `userId` scopes SignalR DELIVERY to the cook's owner: the authenticated
    // principal, whose ownership of the device was checked above (HAR-57,
    // MG-30). Never the deviceId; the Pi gets its cook from the device twin.
    if (result.outcome === 'created') {
      const message: SignalROutputMessage = {
        target: COOK_STARTED,
        userId,
        arguments: [buildCookEnvelope(COOK_STARTED, storedCook, correlationId)],
      };
      context.extraOutputs.set(signalROutput, [message]);
    }

    // HAR-66: the twin follows Cosmos. Runs on creation and on a matching
    // replay, so retrying a start whose sync failed heals the twin.
    const twin = await runDeviceTwinStep(
      deps.syncDeviceTwin,
      context,
      'startCook',
      userId,
      storedCook.deviceId,
      correlationId
    );
    requestCharge += twin.requestCharge;
    if (!twin.ok) {
      return jsonResponse(
        503,
        deviceTwinUpdateFailedBody(storedCook.id, twin.reason, context.invocationId),
        correlationId,
        requestCharge
      );
    }

    return jsonResponse(
      result.outcome === 'created' ? 201 : 200,
      storedCook,
      correlationId,
      requestCharge
    );
  } catch (error) {
    // Sanitized: a fixed message plus a numeric dependency status only. The raw
    // error (which can carry the Cosmos account endpoint) is never logged or
    // returned. No SignalR envelope was set on this path. The header carries the
    // RU of the calls that completed (the ownership read) plus any charge the
    // failing Cosmos error reported; with neither, it is omitted.
    const status = statusCodeOf(error);
    context.error(`Error in startCook (dependency status ${status ?? 'unknown'})`);

    return jsonResponse(
      500,
      {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to start cook',
        requestId: context.invocationId,
      },
      correlationId,
      chargeAfterError(spent, error)
    );
  }
}
