import type { Container } from '@azure/cosmos';

/**
 * HAR-20 — an in-memory stand-in for the devices container, for unit tests only
 * (imported by *.spec.ts; nothing in the app imports it).
 *
 * It models the Cosmos behaviour the devices repository relies on: documents
 * keyed by `id` in partition `/id`, system properties (`_rid`, `_self`, `_etag`,
 * `_attachments`, `_ts`) stamped on every stored document, 404 on a missing
 * point read, 409 on `create` of an existing id, 412 on a replace whose
 * If-Match ETag is stale, and 404 on a delete of a missing id. Every operation
 * reports a request charge.
 *
 * `failNext` makes the next matching operation throw an error shaped like an
 * SDK ErrorResponse, its text carrying the account endpoint so tests can prove
 * the text never escapes.
 */

export const FAKE_ACCOUNT_ENDPOINT = 'https://mgv2-secret-account.documents.azure.com/';

export type FakeOperation = 'read' | 'create' | 'replace' | 'query' | 'delete';

export interface FakeCall {
  readonly operation: FakeOperation;
  readonly id?: string;
  readonly partitionKey?: unknown;
  readonly query?: string;
  readonly parameters?: ReadonlyArray<{ name: string; value: unknown }>;
  readonly queryOptions?: Record<string, unknown>;
  readonly ifMatch?: string;
}

export const READ_CHARGE = 1;
export const WRITE_CHARGE = 6.5;
export const QUERY_CHARGE = 2.75;
export const DELETE_CHARGE = 5.33;

type StoredDocument = Record<string, unknown> & { id: string };

function cosmosError(statusCode: number, requestCharge: number): Error {
  return Object.assign(
    new Error(`Request to ${FAKE_ACCOUNT_ENDPOINT} failed with status ${statusCode}`),
    { code: statusCode, statusCode, requestCharge }
  );
}

export class FakeDevicesContainer {
  readonly calls: FakeCall[] = [];
  private readonly documents = new Map<string, StoredDocument>();
  private etagCounter = 0;
  private failures: Array<{ operation: FakeOperation; statusCode: number }> = [];
  /** Runs after a read and before the next replace (to simulate a concurrent writer). */
  beforeReplace?: (id: string) => void;
  /** Runs after a read and before the next delete (to simulate a concurrent delete). */
  beforeDelete?: (id: string) => void;
  /** HAR-130: runs before each create (to simulate a concurrent writer of the same id). */
  beforeCreate?: (id: string) => void;

  /** Seeds a document as if it had been written earlier. */
  seed(document: { id: string } & object): void {
    this.documents.set(
      document.id,
      this.stamp(document as Record<string, unknown> & { id: string })
    );
  }

  /** The raw stored document, system properties included. */
  stored(id: string): StoredDocument | undefined {
    return this.documents.get(id);
  }

  /** Changes a stored document behind the repository's back (new ETag). */
  touch(id: string): void {
    const current = this.documents.get(id);
    if (current) {
      this.documents.set(id, this.stamp(current));
    }
  }

  /** Deletes a stored document behind the repository's back. */
  remove(id: string): void {
    this.documents.delete(id);
  }

  failNext(operation: FakeOperation, statusCode = 503): void {
    this.failures.push({ operation, statusCode });
  }

  asContainer(): Container {
    return this as unknown as Container;
  }

  private takeFailure(operation: FakeOperation, charge: number): void {
    const index = this.failures.findIndex(failure => failure.operation === operation);
    if (index !== -1) {
      const [failure] = this.failures.splice(index, 1);
      throw cosmosError(failure.statusCode, charge);
    }
  }

  private stamp(document: Record<string, unknown> & { id: string }): StoredDocument {
    this.etagCounter += 1;
    const clean = Object.fromEntries(
      Object.entries(document).filter(([key]) => !key.startsWith('_'))
    ) as StoredDocument;
    return {
      ...clean,
      _rid: `rid-${this.etagCounter}`,
      _self: `dbs/x/colls/y/docs/${this.etagCounter}`,
      _etag: `"etag-${this.etagCounter}"`,
      _attachments: 'attachments/',
      _ts: 1700000000 + this.etagCounter,
    };
  }

  item(id: string, partitionKey: unknown) {
    return {
      read: async () => {
        this.calls.push({ operation: 'read', id, partitionKey });
        this.takeFailure('read', READ_CHARGE);
        const document = partitionKey === id ? this.documents.get(id) : undefined;
        if (!document) {
          return { statusCode: 404, resource: undefined, requestCharge: READ_CHARGE };
        }
        return {
          statusCode: 200,
          resource: { ...document },
          etag: document['_etag'] as string,
          requestCharge: READ_CHARGE,
        };
      },
      replace: async (
        body: Record<string, unknown> & { id: string },
        options?: { accessCondition?: { type: string; condition: string } }
      ) => {
        this.beforeReplace?.(id);
        const ifMatch = options?.accessCondition?.condition;
        this.calls.push({ operation: 'replace', id, partitionKey, ifMatch });
        this.takeFailure('replace', WRITE_CHARGE);
        const current = this.documents.get(id);
        if (!current || partitionKey !== id) {
          throw cosmosError(404, WRITE_CHARGE);
        }
        if (ifMatch !== undefined && ifMatch !== current['_etag']) {
          throw cosmosError(412, WRITE_CHARGE);
        }
        const stored = this.stamp(body);
        this.documents.set(id, stored);
        return { statusCode: 200, resource: { ...stored }, requestCharge: WRITE_CHARGE };
      },
      delete: async () => {
        this.beforeDelete?.(id);
        this.calls.push({ operation: 'delete', id, partitionKey });
        this.takeFailure('delete', DELETE_CHARGE);
        if (partitionKey !== id || !this.documents.delete(id)) {
          throw cosmosError(404, DELETE_CHARGE);
        }
        return { statusCode: 204, resource: undefined, requestCharge: DELETE_CHARGE };
      },
    };
  }

  readonly items = {
    create: async (body: Record<string, unknown> & { id: string }) => {
      this.beforeCreate?.(body.id);
      this.calls.push({ operation: 'create', id: body.id, partitionKey: body.id });
      this.takeFailure('create', WRITE_CHARGE);
      if (this.documents.has(body.id)) {
        throw cosmosError(409, WRITE_CHARGE);
      }
      const stored = this.stamp(body);
      this.documents.set(body.id, stored);
      return { statusCode: 201, resource: { ...stored }, requestCharge: WRITE_CHARGE };
    },
    query: (
      spec: { query: string; parameters?: Array<{ name: string; value: unknown }> },
      queryOptions: Record<string, unknown> = {}
    ) => ({
      fetchAll: async () => {
        this.calls.push({
          operation: 'query',
          query: spec.query,
          parameters: spec.parameters,
          queryOptions,
        });
        this.takeFailure('query', QUERY_CHARGE);
        const userId = spec.parameters?.find(parameter => parameter.name === '@userId')?.value;
        const resources = [...this.documents.values()]
          .filter(document => document['userId'] === userId)
          .map(document => ({ ...document }));
        return { resources, requestCharge: QUERY_CHARGE };
      },
    }),
  };
}
