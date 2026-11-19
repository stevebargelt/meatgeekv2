import type { Container } from '@azure/cosmos';

import { FAKE_ACCOUNT_ENDPOINT } from './fake-devices-container.testing';
import { LATEST_READING_CANDIDATES } from './temperatures-repository';

/**
 * HAR-28 — an in-memory stand-in for the temperatures container, for unit tests
 * only (imported by *.spec.ts; nothing in the app imports it).
 *
 * It answers the one query the repository runs: documents in the requested
 * partition (`/deviceId`), newest `SystemProperties["iothub-enqueuedtime"]`
 * first, at most {@link LATEST_READING_CANDIDATES}. Stored documents carry Cosmos
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

function enqueuedTime(document: StoredDocument): string {
  const system = document['SystemProperties'] as Record<string, unknown> | undefined;
  const value = system?.['iothub-enqueuedtime'];
  return typeof value === 'string' ? value : '';
}

export class FakeTemperaturesContainer {
  readonly queries: FakeTemperaturesQuery[] = [];
  private readonly documents: StoredDocument[] = [];
  private failNextStatus: number | undefined;

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

  /** Makes the next query throw an SDK-shaped error whose text names the account. */
  failNext(statusCode = 503): void {
    this.failNextStatus = statusCode;
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
          if (this.failNextStatus !== undefined) {
            const statusCode = this.failNextStatus;
            this.failNextStatus = undefined;
            throw Object.assign(
              new Error(`Request to ${FAKE_ACCOUNT_ENDPOINT} failed with status ${statusCode}`),
              { code: statusCode, statusCode, requestCharge: TEMPERATURES_QUERY_CHARGE }
            );
          }
          const deviceId = spec.parameters.find(p => p.name === '@deviceId')?.value;
          const resources = this.documents
            .filter(d => d['deviceId'] === options['partitionKey'] && d['deviceId'] === deviceId)
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
