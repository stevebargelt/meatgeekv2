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
 *     first, at most {@link LATEST_READING_CANDIDATES}; HAR-136: bounded below
 *     by `@notBefore` when the query text carries it;
 *   - HAR-35's history query: the clauses of the history predicate that the
 *     query TEXT carries (hub identity, `IS_OBJECT(c.Body)`, `@cookId`, the
 *     `@startTime`/`@endTime` window), oldest first. HAR-75: read with
 *     `fetchNext`, `maxItemCount` documents a page, resumed from an opaque
 *     continuation token. A token the fake did not issue is refused as Cosmos
 *     refuses one: a 400 that reports {@link TEMPERATURES_QUERY_CHARGE}.
 *
 * Stored documents carry Cosmos
 * system properties, so tests can prove the mapping strips them. Every query
 * records its text, parameters and options, so tests can prove it is
 * single-partition.
 */

export const TEMPERATURES_QUERY_CHARGE = 3.25;

/** The prefix of the fake's continuation tokens: `<prefix><documents skipped>`. */
const TOKEN_PREFIX = 'fake-history-token:';

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
    query.includes('["iothub-enqueuedtime"] >= @notBefore') &&
    !(typeof enqueued === 'string' && enqueued >= String(parameter('@notBefore')))
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
  private failNextStatus: number | string | undefined;
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
   *  `skip` more queries succeed. A number is an HTTP status; a string is a
   *  connection-level failure as the SDK throws it (`RestError` with that
   *  string `code`, e.g. `'ECONNRESET'`, and no status). */
  failNext(statusCode: number | string = 503, skip = 0): void {
    this.failNextStatus = statusCode;
    this.failAfterQueries = skip;
  }

  asContainer(): Container {
    return this as unknown as Container;
  }

  /** Records the query, then throws the staged failure when one is due. */
  private record(query: FakeTemperaturesQuery): void {
    this.queries.push(query);
    if (this.failNextStatus !== undefined && this.failAfterQueries > 0) {
      this.failAfterQueries -= 1;
    } else if (this.failNextStatus !== undefined) {
      const statusCode = this.failNextStatus;
      this.failNextStatus = undefined;
      throw sdkError(statusCode);
    }
  }

  get items() {
    return {
      query: (
        spec: { query: string; parameters: Array<{ name: string; value: unknown }> },
        options: Record<string, unknown>
      ) => {
        const parameter = (name: string) => spec.parameters.find(p => p.name === name)?.value;
        const matching = () => {
          const deviceId = parameter('@deviceId');
          return this.documents.filter(
            d =>
              d['deviceId'] === options['partitionKey'] &&
              d['deviceId'] === deviceId &&
              matchesHistoryClauses(d, spec.query, parameter)
          );
        };
        return {
          /** The current-reading query. */
          fetchAll: async () => {
            this.record({ query: spec.query, parameters: spec.parameters, options });
            const resources = matching()
              .sort((a, b) => enqueuedTime(b).localeCompare(enqueuedTime(a)))
              .slice(0, LATEST_READING_CANDIDATES)
              .map(d => ({ ...d }));
            return { resources, requestCharge: TEMPERATURES_QUERY_CHARGE };
          },
          /** HAR-75: one page of the history query. */
          fetchNext: async () => {
            this.record({ query: spec.query, parameters: spec.parameters, options });
            if (!spec.query.endsWith(' ASC')) {
              throw new Error(`fake temperatures container: unexpected fetchNext query`);
            }
            const token = options['continuationToken'];
            let skip = 0;
            if (token !== undefined) {
              const parsed =
                typeof token === 'string' && token.startsWith(TOKEN_PREFIX)
                  ? Number(token.slice(TOKEN_PREFIX.length))
                  : NaN;
              if (!Number.isInteger(parsed) || parsed < 0) {
                throw sdkError(400);
              }
              skip = parsed;
            }
            const size = Number(options['maxItemCount']);
            const all = matching().sort((a, b) => enqueuedTime(a).localeCompare(enqueuedTime(b)));
            const resources = all.slice(skip, skip + size).map(d => ({ ...d }));
            const next = skip + resources.length;
            const hasMoreResults = next < all.length;
            return {
              resources,
              hasMoreResults,
              continuationToken: hasMoreResults ? `${TOKEN_PREFIX}${next}` : undefined,
              requestCharge: TEMPERATURES_QUERY_CHARGE,
            };
          },
        };
      },
    };
  }
}

/** An SDK-shaped error whose text names the account and that reports
 *  {@link TEMPERATURES_QUERY_CHARGE}. */
function sdkError(statusCode: number | string): Error {
  if (typeof statusCode === 'string') {
    return Object.assign(new Error(`connect ${statusCode} ${FAKE_ACCOUNT_ENDPOINT}`), {
      name: 'RestError',
      code: statusCode,
    });
  }
  return Object.assign(
    new Error(`Request to ${FAKE_ACCOUNT_ENDPOINT} failed with status ${statusCode}`),
    { code: statusCode, statusCode, requestCharge: TEMPERATURES_QUERY_CHARGE }
  );
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
