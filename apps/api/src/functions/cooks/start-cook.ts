import { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { Cook, StartCookRequest } from '@meatgeekv2/api-interfaces';
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
import { requestChargeHeaders, requestChargeOfError } from '../../shared/cosmos/request-charge';

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
 * Injection seam. Production wires the real Easy Auth principal reader and the
 * adapter-backed cooks repository; unit tests pass fakes so no Azure, no
 * credentials, and no network are touched. `getRepository` is only asked for the
 * one method this handler uses (the start batch), so a test double can be a bare
 * object.
 */
export interface StartCookDeps {
  resolvePrincipal(request: HeaderReader): PrincipalResult;
  getRepository(): Pick<CooksRepository, 'startCook'>;
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

/**
 * MG-84: the cook id is supplied by the client — generated once per start intent
 * and reused on every retry — and must be a UUID. The UUID shape also keeps
 * client ids out of the server's own document ids (`active-device:<deviceId>`).
 */
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

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

/** A JSON response for a request that reached Cosmos: it carries the RU charge
 *  header (HAR-11) alongside the request id. */
function jsonResponse(
  status: number,
  body: unknown,
  invocationId: string,
  requestCharge: number
): HttpResponseInit {
  return {
    status,
    headers: {
      'Content-Type': 'application/json',
      'X-Request-ID': invocationId,
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

  try {
    // Authenticate FIRST. An unauthenticated caller does no work: no body parse,
    // no write, no SignalR emit. The userId that partitions the cook comes ONLY
    // from the validated Easy Auth principal — never the body, never 'user-1'.
    const principalResult = deps.resolvePrincipal(request);
    if (!principalResult.authenticated) {
      return unauthenticatedResponse(principalResult.reason, context.invocationId);
    }
    const { userId } = principalResult.principal;

    // Parse request body
    const body = (await request.json()) as StartCookRequest;

    // Validate required fields. name must be non-empty after trimming so a
    // whitespace-only name never mints a Cook.
    if (!body.name || body.name.trim().length === 0 || !body.deviceId || !body.meatType) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          error: 'VALIDATION_ERROR',
          message: 'Missing required fields: name (non-empty), deviceId, meatType',
          requestId: context.invocationId,
        },
      };
    }

    // MG-84: the client-supplied id is the idempotency key. No server-minted
    // fallback: a request without one could not be retried safely.
    if (typeof body.id !== 'string' || !UUID_PATTERN.test(body.id)) {
      return {
        status: 400,
        headers: { 'Content-Type': 'application/json' },
        jsonBody: {
          error: 'VALIDATION_ERROR',
          message: 'id is required and must be a UUID generated by the client',
          requestId: context.invocationId,
        },
      };
    }

    // The new cook. Its `userId` is the authenticated principal — this is BOTH
    // the ownership identity and the Cosmos partition value, so the document
    // lands in the caller's partition and nowhere else.
    const newCook: Cook = {
      id: body.id,
      userId,
      deviceId: body.deviceId,
      name: body.name.trim(),
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
    const { requestCharge } = result;

    // RU charge is a bare number — safe to log for the shared-throughput budget.
    context.log(`startCook ${result.outcome} (requestCharge=${requestCharge} RU)`);

    // MG-84 D2: one active cook per (user, device). Nothing was written.
    if (result.outcome === 'deviceBusy') {
      return jsonResponse(
        409,
        {
          error: 'COOK_ALREADY_ACTIVE',
          message: 'This device already has an active cook. Stop it before starting another.',
          requestId: context.invocationId,
          activeCookId: result.activeCookId,
        },
        context.invocationId,
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
          context.invocationId,
          requestCharge
        );
      }
      return jsonResponse(200, result.cook, context.invocationId, requestCharge);
    }

    const storedCook = result.cook;

    // Emit AFTER the successful write. Correlation id propagates from the inbound
    // request when present, else the Functions invocation id. NOTE the two
    // distinct userId axes: the message-level `userId` scopes SignalR DELIVERY to
    // the device's user group (=deviceId), which is deliberately NOT the
    // persisted identity userId above.
    const correlationId = request.headers.get('X-Request-ID') ?? context.invocationId;
    const message: SignalROutputMessage = {
      target: COOK_STARTED,
      userId: body.deviceId,
      arguments: [buildCookEnvelope(COOK_STARTED, storedCook, correlationId)],
    };
    context.extraOutputs.set(signalROutput, [message]);

    return jsonResponse(201, storedCook, context.invocationId, requestCharge);
  } catch (error) {
    // Sanitized: a fixed message plus a numeric dependency status only. The raw
    // error (which can carry the Cosmos account endpoint) is never logged or
    // returned. No SignalR envelope was set on this path. A Cosmos error that
    // reports the failed operation's RU charge has it surfaced in the header;
    // anything else (no Cosmos call made, or no charge reported) omits it.
    const status = statusCodeOf(error);
    context.error(`Error in startCook (dependency status ${status ?? 'unknown'})`);

    return {
      status: 500,
      headers: {
        'Content-Type': 'application/json',
        ...requestChargeHeaders(requestChargeOfError(error)),
      },
      jsonBody: {
        error: 'INTERNAL_SERVER_ERROR',
        message: 'Failed to start cook',
        requestId: context.invocationId,
      },
    };
  }
}
