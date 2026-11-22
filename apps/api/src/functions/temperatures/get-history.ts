import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { TemperatureHistoryResponse } from '@meatgeekv2/api-interfaces';

import { principalFromRequest, unauthenticatedResponse } from '../../shared/auth/principal';
import { DEVICE_ID_PATTERN, getDevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  getTemperaturesRepository,
  InvalidContinuationTokenError,
  type TemperatureHistoryFilter,
  type TemperaturesRepository,
} from '../../shared/cosmos/temperatures-repository';
import { boundedStartTime, claimedAtBound } from '../../shared/devices/readings-bound';
import {
  correlationIdOf,
  errorBody,
  jsonResponse,
  serverError,
  validationError,
} from '../devices/devices-http';
import type { TemperaturesHandlerDeps } from './get-current';

/**
 * HAR-35 (MG-79 part 2) — GET /temperatures/history: one page of the readings
 * IoT Hub routed into the `temperatures` container for a device the caller
 * owns, as a TemperatureHistoryResponse `{ readings, limit, hasMore,
 * continuationToken? }`.
 *
 *   - 401 without a usable Easy Auth principal (no Cosmos call);
 *   - 400 VALIDATION_ERROR for a bad query parameter, including any `offset`
 *     (no Cosmos call), or for a continuation token Cosmos refuses;
 *   - 404 DEVICE_NOT_FOUND for a device that does not exist OR belongs to someone
 *     else, with one body for both, as GET /temperatures/current does;
 *   - 200 with the page otherwise. An owned device with no readings is an empty
 *     page, not a 404.
 *
 * HAR-75: paged by continuation token, never offset. An offset page re-charges
 * every skipped document (at 8,600 readings in, it cost twice the first page)
 * and `total` needed a separate COUNT, so both are gone. Ownership is one point
 * read on the devices container, and the page is one single-partition query
 * with `maxItemCount = limit` and the SDK token (temperatures-repository.ts,
 * historyPageQuery). `hasMore` is true exactly when a `continuationToken` is
 * returned; send it back unchanged for the next page. The window
 * (`startTime` inclusive, `endTime` exclusive) and the ascending order are on
 * the hub-stamped `iothub-enqueuedtime`, never the device-supplied
 * `Body.timestamp`; each reading's `timestamp` still follows
 * toTemperatureReading.
 *
 * HAR-136: for a device with `claimedAt`, the effective `startTime` is the
 * later of the requested one and `claimedAt`, inside the query, so the caller
 * never sees a reading from before their claim and paging stays right. A
 * device without `claimedAt` is not bounded. Every response that reached Cosmos carries
 * `x-meatgeek-request-charge` = the sum of the calls it made.
 */

export const HISTORY_DEFAULT_LIMIT = 100;
export const HISTORY_MAX_LIMIT = 1000;
export const COOK_ID_MAX_LENGTH = 128;

/** The repository surface this handler uses. */
export type TemperatureHistoryRepositoryPort = Pick<TemperaturesRepository, 'getReadingsPage'>;

/** Injection seam: the shared temperatures seam, with the history queries. */
export interface TemperatureHistoryHandlerDeps
  extends Omit<TemperaturesHandlerDeps, 'getTemperaturesRepository'> {
  getTemperaturesRepository(): TemperatureHistoryRepositoryPort;
}

export const defaultTemperatureHistoryDeps: TemperatureHistoryHandlerDeps = {
  resolvePrincipal: principalFromRequest,
  getDevicesRepository,
  getTemperaturesRepository,
};

interface HistoryQuery {
  readonly filter: TemperatureHistoryFilter;
  readonly limit: number;
  readonly continuationToken?: string;
}

const INTEGER = /^-?\d+$/;

/** An optional integer query parameter in [min, max], or the message to 400 with. */
function integerParam(
  raw: string | null,
  name: string,
  fallback: number,
  min: number,
  max: number
): number | string {
  if (raw === null) {
    return fallback;
  }
  if (!INTEGER.test(raw)) {
    return `${name} must be an integer`;
  }
  const value = Number(raw);
  if (value < min || value > max) {
    return `${name} must be between ${min} and ${max}`;
  }
  return value;
}

/** An optional date query parameter, normalised to the stored form (UTC ISO with
 *  milliseconds), or the message to 400 with. */
function timeParam(raw: string | null, name: string): string | undefined | { error: string } {
  if (raw === null) {
    return undefined;
  }
  const parsed = new Date(raw);
  if (raw.length === 0 || Number.isNaN(parsed.getTime())) {
    return { error: `${name} must be an ISO-8601 date-time` };
  }
  return parsed.toISOString();
}

/** The validated query, or the message to 400 with. Reads only the query. */
function parseHistoryQuery(request: HttpRequest): HistoryQuery | string {
  // HAR-75: offset paging is gone. Refuse it by name rather than ignore it, so a
  // client still sending it learns why it is not getting the page it asked for.
  if (request.query.get('offset') !== null) {
    return 'offset is not supported: page with continuationToken';
  }

  const deviceId = request.query.get('deviceId') ?? '';
  if (!DEVICE_ID_PATTERN.test(deviceId)) {
    return 'deviceId is required: 1-128 characters of A-Z, a-z, 0-9, ".", "_", ":" or "-"';
  }

  const cookId = request.query.get('cookId');
  if (cookId !== null && (cookId.length === 0 || cookId.length > COOK_ID_MAX_LENGTH)) {
    return `cookId must be 1-${COOK_ID_MAX_LENGTH} characters`;
  }

  const startTime = timeParam(request.query.get('startTime'), 'startTime');
  if (typeof startTime === 'object') {
    return startTime.error;
  }
  const endTime = timeParam(request.query.get('endTime'), 'endTime');
  if (typeof endTime === 'object') {
    return endTime.error;
  }
  if (
    startTime !== undefined &&
    endTime !== undefined &&
    Date.parse(startTime) >= Date.parse(endTime)
  ) {
    return 'startTime must be before endTime';
  }

  const limit = integerParam(
    request.query.get('limit'),
    'limit',
    HISTORY_DEFAULT_LIMIT,
    1,
    HISTORY_MAX_LIMIT
  );
  if (typeof limit === 'string') {
    return limit;
  }
  const continuationToken = request.query.get('continuationToken');
  if (continuationToken !== null && continuationToken.length === 0) {
    return 'continuationToken must not be empty';
  }

  const filter: TemperatureHistoryFilter = {
    deviceId,
    ...(cookId !== null ? { cookId } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
    ...(endTime !== undefined ? { endTime } : {}),
  };
  return {
    filter,
    limit,
    ...(continuationToken !== null ? { continuationToken } : {}),
  };
}

export async function getTemperatureHistoryHandler(
  request: HttpRequest,
  context: InvocationContext,
  deps: TemperatureHistoryHandlerDeps = defaultTemperatureHistoryDeps
): Promise<HttpResponseInit> {
  context.log('Processing getTemperatureHistory request');
  const correlationId = correlationIdOf(request, context);

  const principal = deps.resolvePrincipal(request);
  if (!principal.authenticated) {
    return unauthenticatedResponse(principal.reason, correlationId);
  }

  const query = parseHistoryQuery(request);
  if (typeof query === 'string') {
    return validationError(query, correlationId, context);
  }
  const { filter, limit, continuationToken } = query;

  let spent: number | undefined;
  try {
    const devices = deps.getDevicesRepository();
    const temperatures = deps.getTemperaturesRepository();

    const ownership = await devices.getDeviceOwnership(principal.principal.userId, filter.deviceId);
    spent = ownership.requestCharge;
    if (ownership.status !== 'owned') {
      context.log(`getTemperatureHistory device ${ownership.status} (requestCharge=${spent} RU)`);
      return jsonResponse(
        404,
        errorBody('DEVICE_NOT_FOUND', 'Device not found', context),
        correlationId,
        spent
      );
    }

    // HAR-136: only readings from the caller's claim onward. The effective
    // startTime is the later of the requested one and `claimedAt`.
    const startTime = boundedStartTime(filter.startTime, claimedAtBound(ownership.device));
    const bounded: TemperatureHistoryFilter = {
      ...filter,
      ...(startTime !== undefined ? { startTime } : {}),
    };
    const page = await temperatures.getReadingsPage(bounded, { limit, continuationToken });
    spent += page.requestCharge;

    const body: TemperatureHistoryResponse = {
      readings: page.readings,
      limit,
      hasMore: page.continuationToken !== undefined,
    };
    if (page.continuationToken !== undefined) {
      body.continuationToken = page.continuationToken;
    }
    context.log(
      `getTemperatureHistory ${page.readings.length} reading(s), hasMore=${body.hasMore} ` +
        `(requestCharge=${spent} RU)`
    );
    return jsonResponse(200, body, correlationId, spent);
  } catch (error) {
    if (error instanceof InvalidContinuationTokenError) {
      // The token is the caller's input: a 400, not a failure of ours. Report
      // the RU the ownership read and the refused query spent.
      const charge = (spent ?? 0) + (error.requestCharge ?? 0);
      context.log(`getTemperatureHistory invalid continuationToken (requestCharge=${charge} RU)`);
      return jsonResponse(
        400,
        errorBody(
          'VALIDATION_ERROR',
          'continuationToken is not valid: send back the token from the previous page unchanged',
          context
        ),
        correlationId,
        charge
      );
    }
    return serverError(
      'getTemperatureHistory',
      'Failed to retrieve temperature history',
      error,
      correlationId,
      context,
      spent
    );
  }
}
