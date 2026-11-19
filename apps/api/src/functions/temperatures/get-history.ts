import type { HttpRequest, HttpResponseInit, InvocationContext } from '@azure/functions';
import type { TemperatureHistoryResponse } from '@meatgeekv2/api-interfaces';

import { principalFromRequest, unauthenticatedResponse } from '../../shared/auth/principal';
import { DEVICE_ID_PATTERN, getDevicesRepository } from '../../shared/cosmos/devices-repository';
import {
  getTemperaturesRepository,
  type TemperatureHistoryFilter,
  type TemperaturesRepository,
} from '../../shared/cosmos/temperatures-repository';
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
 * owns, as a TemperatureHistoryResponse `{ readings, total, offset, limit,
 * hasMore }`.
 *
 *   - 401 without a usable Easy Auth principal (no Cosmos call);
 *   - 400 VALIDATION_ERROR for a bad query parameter (no Cosmos call);
 *   - 404 DEVICE_NOT_FOUND for a device that does not exist OR belongs to someone
 *     else, with one body for both, as GET /temperatures/current does;
 *   - 200 with the page otherwise. An owned device with no readings is an empty
 *     page, not a 404.
 *
 * Ownership is one point read on the devices container; `total` and the page
 * are two single-partition queries on the temperatures container over the same
 * predicate (temperatures-repository.ts, historyPredicate). The window
 * (`startTime` inclusive, `endTime` exclusive) and the ascending order are on
 * the hub-stamped `iothub-enqueuedtime`, never the device-supplied
 * `Body.timestamp`; each reading's `timestamp` still follows
 * toTemperatureReading. Every response that reached Cosmos carries
 * `x-meatgeek-request-charge` = the sum of the calls it made.
 */

export const HISTORY_DEFAULT_LIMIT = 100;
export const HISTORY_MAX_LIMIT = 5000;
export const COOK_ID_MAX_LENGTH = 128;

/** The repository surface this handler uses. */
export type TemperatureHistoryRepositoryPort = Pick<
  TemperaturesRepository,
  'countReadings' | 'getReadingsPage'
>;

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
  readonly offset: number;
  readonly limit: number;
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
    return max === Number.MAX_SAFE_INTEGER
      ? `${name} must be at least ${min}`
      : `${name} must be between ${min} and ${max}`;
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
  const offset = integerParam(request.query.get('offset'), 'offset', 0, 0, Number.MAX_SAFE_INTEGER);
  if (typeof offset === 'string') {
    return offset;
  }

  const filter: TemperatureHistoryFilter = {
    deviceId,
    ...(cookId !== null ? { cookId } : {}),
    ...(startTime !== undefined ? { startTime } : {}),
    ...(endTime !== undefined ? { endTime } : {}),
  };
  return { filter, offset, limit };
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
  const { filter, offset, limit } = query;

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

    const count = await temperatures.countReadings(filter);
    spent += count.requestCharge;
    const page = await temperatures.getReadingsPage(filter, offset, limit);
    spent += page.requestCharge;

    const body: TemperatureHistoryResponse = {
      readings: page.readings,
      total: count.total,
      offset,
      limit,
      hasMore: offset + limit < count.total,
    };
    context.log(
      `getTemperatureHistory ${page.readings.length} of ${count.total} (requestCharge=${spent} RU)`
    );
    return jsonResponse(200, body, correlationId, spent);
  } catch (error) {
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
