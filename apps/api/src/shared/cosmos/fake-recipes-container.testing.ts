import type { Container } from '@azure/cosmos';

/**
 * HAR-36 — an in-memory stand-in for the recipes container, for unit tests only
 * (imported by *.spec.ts; nothing in the app imports it).
 *
 * It models the Cosmos behaviour the recipes repository relies on: documents
 * partitioned on `/userId`, so a point operation finds a document only under its
 * own id AND its own partition key; system properties (`_rid`, `_self`, `_etag`,
 * `_attachments`, `_ts`) stamped on every stored document; 404 on a missing
 * point read, replace or delete; 409 on `create` of an existing id in the same
 * partition; 412 on a replace whose If-Match ETag is stale; and a query that
 * sees only the partition named in its options. Every operation reports a
 * request charge.
 *
 * `failNext` makes the next matching operation throw an error shaped like an
 * SDK ErrorResponse, its text carrying the account endpoint so tests can prove
 * the text never escapes.
 */

export const FAKE_ACCOUNT_ENDPOINT = 'https://mgv2-secret-account.documents.azure.com/';

export type FakeRecipeOperation = 'read' | 'create' | 'replace' | 'delete' | 'query';

export interface FakeRecipeCall {
  readonly operation: FakeRecipeOperation;
  readonly id?: string;
  readonly partitionKey?: unknown;
  readonly query?: string;
  readonly parameters?: ReadonlyArray<{ name: string; value: unknown }>;
  readonly ifMatch?: string;
}

export const READ_CHARGE = 1;
export const WRITE_CHARGE = 6.5;
export const DELETE_CHARGE = 5.25;
export const QUERY_CHARGE = 2.75;

type StoredDocument = Record<string, unknown> & { id: string; userId: string };

function cosmosError(statusCode: number, requestCharge: number): Error {
  return Object.assign(
    new Error(`Request to ${FAKE_ACCOUNT_ENDPOINT} failed with status ${statusCode}`),
    { code: statusCode, statusCode, requestCharge }
  );
}

function keyOf(partitionKey: unknown, id: string): string {
  return `${String(partitionKey)}|${id}`;
}

export class FakeRecipesContainer {
  readonly calls: FakeRecipeCall[] = [];
  private readonly documents = new Map<string, StoredDocument>();
  private etagCounter = 0;
  private failures: Array<{ operation: FakeRecipeOperation; statusCode: number }> = [];
  /** Runs after a read and before the next replace (to simulate a concurrent writer). */
  beforeReplace?: (id: string, partitionKey: unknown) => void;

  /** Seeds a document as if it had been written earlier. */
  seed<T extends { id: string; userId: string }>(document: T): void {
    this.documents.set(
      keyOf(document.userId, document.id),
      this.stamp(document as unknown as StoredDocument)
    );
  }

  /** The raw stored document, system properties included. */
  stored(userId: string, id: string): StoredDocument | undefined {
    return this.documents.get(keyOf(userId, id));
  }

  /** Changes a stored document behind the repository's back (new ETag). */
  touch(userId: string, id: string): void {
    const current = this.documents.get(keyOf(userId, id));
    if (current) {
      this.documents.set(keyOf(userId, id), this.stamp(current));
    }
  }

  /** Removes a stored document behind the repository's back. */
  remove(userId: string, id: string): void {
    this.documents.delete(keyOf(userId, id));
  }

  failNext(operation: FakeRecipeOperation, statusCode = 503): void {
    this.failures.push({ operation, statusCode });
  }

  asContainer(): Container {
    return this as unknown as Container;
  }

  private takeFailure(operation: FakeRecipeOperation, charge: number): void {
    const index = this.failures.findIndex(failure => failure.operation === operation);
    if (index !== -1) {
      const [failure] = this.failures.splice(index, 1);
      throw cosmosError(failure.statusCode, charge);
    }
  }

  private stamp(document: StoredDocument): StoredDocument {
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
    const key = keyOf(partitionKey, id);
    return {
      read: async () => {
        this.calls.push({ operation: 'read', id, partitionKey });
        this.takeFailure('read', READ_CHARGE);
        const document = this.documents.get(key);
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
        body: StoredDocument,
        options?: { accessCondition?: { type: string; condition: string } }
      ) => {
        this.beforeReplace?.(id, partitionKey);
        const ifMatch = options?.accessCondition?.condition;
        this.calls.push({ operation: 'replace', id, partitionKey, ifMatch });
        this.takeFailure('replace', WRITE_CHARGE);
        const current = this.documents.get(key);
        if (!current) {
          throw cosmosError(404, WRITE_CHARGE);
        }
        if (ifMatch !== undefined && ifMatch !== current['_etag']) {
          throw cosmosError(412, WRITE_CHARGE);
        }
        const stored = this.stamp(body);
        this.documents.set(key, stored);
        return { statusCode: 200, resource: { ...stored }, requestCharge: WRITE_CHARGE };
      },
      delete: async () => {
        this.calls.push({ operation: 'delete', id, partitionKey });
        this.takeFailure('delete', DELETE_CHARGE);
        if (!this.documents.delete(key)) {
          throw cosmosError(404, DELETE_CHARGE);
        }
        return { statusCode: 204, resource: undefined, requestCharge: DELETE_CHARGE };
      },
    };
  }

  readonly items = {
    create: async (body: StoredDocument) => {
      this.calls.push({ operation: 'create', id: body.id, partitionKey: body.userId });
      this.takeFailure('create', WRITE_CHARGE);
      const key = keyOf(body.userId, body.id);
      if (this.documents.has(key)) {
        throw cosmosError(409, WRITE_CHARGE);
      }
      const stored = this.stamp(body);
      this.documents.set(key, stored);
      return { statusCode: 201, resource: { ...stored }, requestCharge: WRITE_CHARGE };
    },
    query: (
      spec: { query: string; parameters?: Array<{ name: string; value: unknown }> },
      queryOptions: { partitionKey?: unknown } = {}
    ) => ({
      fetchAll: async () => {
        this.calls.push({
          operation: 'query',
          query: spec.query,
          parameters: spec.parameters,
          partitionKey: queryOptions.partitionKey,
        });
        this.takeFailure('query', QUERY_CHARGE);
        const parameter = (name: string) =>
          spec.parameters?.find(candidate => candidate.name === name)?.value;
        const userId = parameter('@userId');
        const meatType = parameter('@meatType');
        // A query scoped to a partition sees only that partition.
        const resources = [...this.documents.values()]
          .filter(
            document =>
              queryOptions.partitionKey === undefined ||
              document.userId === queryOptions.partitionKey
          )
          .filter(document => document.userId === userId)
          .filter(document => meatType === undefined || document['meatType'] === meatType)
          .sort((a, b) => String(b['updatedAt']).localeCompare(String(a['updatedAt'])))
          .map(document => ({ ...document }));
        return { resources, requestCharge: QUERY_CHARGE };
      },
    }),
  };
}
