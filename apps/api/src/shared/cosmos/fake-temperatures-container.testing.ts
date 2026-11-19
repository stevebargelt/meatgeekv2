import type { Container } from '@azure/cosmos';

import { FAKE_ACCOUNT_ENDPOINT } from './fake-devices-container.testing';
import { LATEST_READING_CANDIDATES } from './temperatures-repository';

/**
 * HAR-28 — an in-memory stand-in for the temperatures container, for unit tests
 * only (imported by *.spec.ts; nothing in the app imports it).
 *
 * It answers the queries the repository runs. Every query sees only the
 * requested partition (`/deviceId`) and the `@deviceId` it names:
 *
 *   - the current-reading query: newest `SystemProperties["iothub-enqueuedtime"]`
 *     first, at most {@link LATEST_READING_CANDIDATES};
 *   - HAR-35's history queries: the clauses of the history predicate that the
 *     query TEXT carries (hub identity, `IS_OBJECT(c.Body)`, `@cookId`, the
 *     `@startTime`/`@endTime` window), then `COUNT(1)` or oldest-first
 *     `OFFSET @offset LIMIT @limit`.
 *
 * Stored documents carry Cosmos
 * system properties, so tests can prove the mapping strips them. Every query
 * records its text, parameters and options, so tests can prove it is
 * single-partition.
 */

export const TEMPERATURES_QUERY_CHARGE = 3.25;

export interface FakeTemperaturesQuery {
  readonly query: string;
  readonly parameters: ReadonlyArray<{ name: string; value: unknown }>;
  readonly options: Record<string, unknown>;
}

type StoredDocument = Record<string, unknown>;

function systemProperty(document: StoredDocument, name: string): unknown {
  const system = document['SystemProperties'] as Record<string, unknown> | undefined;
  return system?.[name];
}

function enqueuedTime(document: StoredDocument): string {
  const value = systemProperty(document, 'iothub-enqueuedtime');
  return typeof value === 'string' ? value : '';
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** The history predicate's clauses, applied only when the query text has them. */
function matchesHistoryClauses(
  document: StoredDocument,
  query: string,
  parameter: (name: string) => unknown
): boolean {
  const deviceId = parameter('@deviceId');
  if (
    query.includes('c.SystemProperties["iothub-connection-device-id"] = @deviceId') &&
    systemProperty(document, 'iothub-connection-device-id') !== deviceId
  ) {
    return false;
  }
  const body = document['Body'];
  if (query.includes('IS_OBJECT(c.Body)') && !isObject(body)) {
    return false;
  }
  if (
    query.includes('c.Body.cookId = @cookId') &&
    (!isObject(body) || body['cookId'] !== parameter('@cookId'))
  ) {
    return false;
  }
  const enqueued = systemProperty(document, 'iothub-enqueuedtime');
  if (
    query.includes('["iothub-enqueuedtime"] >= @startTime') &&
    !(typeof enqueued === 'string' && enqueued >= String(parameter('@startTime')))
  ) {
    return false;
  }
  if (
    query.includes('["iothub-enqueuedtime"] < @endTime') &&
    !(typeof enqueued === 'string' && enqueued < String(parameter('@endTime')))
  ) {
    return false;
  }
  return true;
}

export class FakeTemperaturesContainer {
  readonly queries: FakeTemperaturesQuery[] = [];
  private readonly documents: StoredDocument[] = [];
  private failNextStatus: number | undefined;
  private failAfterQueries = 0;

  /** Seeds a document as IoT Hub would have routed it, system properties added. */
  seed(document: StoredDocument): void {
    const n = this.documents.length + 1;
    this.documents.push({
      ...document,
      _rid: `rid-${n}`,
      _self: `dbs/x/colls/t/docs/${n}`,
      _etag: `"etag-${n}"`,
      _attachments: 'attachments/',
      _ts: 1700000000 + n,
    });
  }

  /** Makes a query throw an SDK-shaped error whose text names the account (and
   *  reports {@link TEMPERATURES_QUERY_CHARGE}): the next one, or the one after
   *  `skip` more queries succeed. */
  failNext(statusCode = 503, skip = 0): void {
    this.failNextStatus = statusCode;
    this.failAfterQueries = skip;
  }

  asContainer(): Container {
    return this as unknown as Container;
  }

  get items() {
    return {
      query: (
        spec: { query: string; parameters: Array<{ name: string; value: unknown }> },
        options: Record<string, unknown>
      ) => ({
        fetchAll: async () => {
          this.queries.push({ query: spec.query, parameters: spec.parameters, options });
          if (this.failNextStatus !== undefined && this.failAfterQueries > 0) {
            this.failAfterQueries -= 1;
          } else if (this.failNextStatus !== undefined) {
            const statusCode = this.failNextStatus;
            this.failNextStatus = undefined;
            throw Object.assign(
              new Error(`Request to ${FAKE_ACCOUNT_ENDPOINT} failed with status ${statusCode}`),
              { code: statusCode, statusCode, requestCharge: TEMPERATURES_QUERY_CHARGE }
            );
          }
          const parameter = (name: string) => spec.parameters.find(p => p.name === name)?.value;
          const deviceId = parameter('@deviceId');
          const matching = this.documents.filter(
            d =>
              d['deviceId'] === options['partitionKey'] &&
              d['deviceId'] === deviceId &&
              matchesHistoryClauses(d, spec.query, parameter)
          );
          if (spec.query.startsWith('SELECT VALUE COUNT(1) ')) {
            return { resources: [matching.length], requestCharge: TEMPERATURES_QUERY_CHARGE };
          }
          if (spec.query.endsWith(' ASC OFFSET @offset LIMIT @limit')) {
            const offset = Number(parameter('@offset'));
            const limit = Number(parameter('@limit'));
            const resources = matching
              .sort((a, b) => enqueuedTime(a).localeCompare(enqueuedTime(b)))
              .slice(offset, offset + limit)
              .map(d => ({ ...d }));
            return { resources, requestCharge: TEMPERATURES_QUERY_CHARGE };
          }
          const resources = matching
            .sort((a, b) => enqueuedTime(b).localeCompare(enqueuedTime(a)))
            .slice(0, LATEST_READING_CANDIDATES)
            .map(d => ({ ...d }));
          return { resources, requestCharge: TEMPERATURES_QUERY_CHARGE };
        },
      }),
    };
  }
}

/**
 * A document shaped like the one IoT Hub routes (modelled on
 * docs/infrastructure/evidence/mg73-observed-routed-document.json), with the
 * top-level partition `deviceId` the endpoint now stamps.
 */
export function routedDocument(options: {
  deviceId: string;
  enqueuedTime: string;
  body?: unknown;
  systemDeviceId?: string | null;
  id?: string;
}): StoredDocument {
  const systemDeviceId =
    options.systemDeviceId === undefined ? options.deviceId : options.systemDeviceId;
  return {
    id: options.id ?? `doc-${options.deviceId}-${options.enqueuedTime}`,
    deviceId: options.deviceId,
    iothub_name: 'meatgeek-v2-dev-iothub-test',
    Body:
      options.body === undefined
        ? { deviceId: options.deviceId, timestamp: options.enqueuedTime, grillTemp: 225 }
        : options.body,
    Properties: {},
    SystemProperties: {
      'message-id': `msg-${options.enqueuedTime}`,
      ...(systemDeviceId === null ? {} : { 'iothub-connection-device-id': systemDeviceId }),
      'iothub-connection-auth-method': '{"scope":"device","type":"sas","issuer":"iothub"}',
      'iothub-content-type': 'application/json',
      'iothub-content-encoding': 'utf-8',
      'iothub-enqueuedtime': options.enqueuedTime,
      'iothub-message-source': 'Telemetry',
    },
  };
}
