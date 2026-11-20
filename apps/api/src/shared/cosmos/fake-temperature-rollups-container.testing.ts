import type { Container, SqlParameter } from '@azure/cosmos';

/**
 * HAR-86 — an in-memory `temperature-rollups` container for unit tests: point
 * reads, `items.create` (409 when the id exists), `replace` with an `IfMatch`
 * access condition (412 when the etag moved), and the chart query evaluated in
 * JavaScript, one document per page so a test can see page charges summed.
 *
 * Every call is recorded in `calls`. `beforeWrite` runs before each create or
 * replace is applied, so a test can slip a concurrent writer in between a read
 * and its write.
 */

export const ROLLUP_READ_CHARGE = 1.5;
export const ROLLUP_WRITE_CHARGE = 9.25;
export const ROLLUP_PAGE_CHARGE = 2.75;

type Stored = Record<string, unknown> & { id: string; deviceId: string; _etag: string };

export type RollupCall =
  | { op: 'read'; id: string; partitionKey: unknown }
  | { op: 'create'; id: string }
  | { op: 'replace'; id: string; ifMatch?: string }
  | { op: 'query'; query: string; parameters: SqlParameter[]; partitionKey: unknown };

function cosmosError(code: number): Error {
  return Object.assign(new Error(`status ${code}`), { code, requestCharge: 1 });
}

export function fakeRollupsContainer() {
  const documents = new Map<string, Stored>();
  const calls: RollupCall[] = [];
  let etagCounter = 0;
  const hooks: { beforeWrite?: (op: 'create' | 'replace', id: string) => void } = {};
  const key = (partitionKey: unknown, id: string) => `${String(partitionKey)}/${id}`;
  const nextEtag = () => `"etag-${(etagCounter += 1)}"`;

  const container = {
    item: (id: string, partitionKey: unknown) => ({
      read: async () => {
        calls.push({ op: 'read', id, partitionKey });
        const resource = documents.get(key(partitionKey, id));
        return {
          resource: resource ? structuredClone(resource) : undefined,
          statusCode: resource ? 200 : 404,
          etag: resource?._etag,
          requestCharge: ROLLUP_READ_CHARGE,
        };
      },
      replace: async (
        body: Record<string, unknown>,
        options?: { accessCondition?: { type: string; condition: string } }
      ) => {
        calls.push({ op: 'replace', id, ifMatch: options?.accessCondition?.condition });
        hooks.beforeWrite?.('replace', id);
        const current = documents.get(key(partitionKey, id));
        if (!current) throw cosmosError(404);
        if (options?.accessCondition && options.accessCondition.condition !== current._etag) {
          throw cosmosError(412);
        }
        const stored = { ...structuredClone(body), _etag: nextEtag() } as Stored;
        documents.set(key(partitionKey, id), stored);
        return { resource: stored, statusCode: 200, requestCharge: ROLLUP_WRITE_CHARGE };
      },
    }),
    items: {
      create: async (body: Record<string, unknown>) => {
        const id = body['id'] as string;
        calls.push({ op: 'create', id });
        hooks.beforeWrite?.('create', id);
        const k = key(body['deviceId'], id);
        if (documents.has(k)) throw cosmosError(409);
        const stored = { ...structuredClone(body), _etag: nextEtag() } as Stored;
        documents.set(k, stored);
        return { resource: stored, statusCode: 201, requestCharge: ROLLUP_WRITE_CHARGE };
      },
      query: (
        spec: { query: string; parameters: SqlParameter[] },
        options: { partitionKey?: unknown }
      ) => {
        calls.push({
          op: 'query',
          query: spec.query,
          parameters: spec.parameters,
          partitionKey: options.partitionKey,
        });
        const param = (name: string) => spec.parameters.find(p => p.name === name)?.value;
        const deviceId = param('@deviceId');
        const from = param('@from') as string;
        const to = param('@to') as string | undefined;
        const matches = [...documents.values()].filter(
          doc =>
            doc.deviceId === deviceId &&
            (doc['hourStart'] as string) >= from &&
            (to === undefined || (doc['hourStart'] as string) < to)
        );
        // One document per page; an empty result is still one page.
        const pages = matches.length === 0 ? [[]] : matches.map(doc => [doc]);
        let next = 0;
        return {
          hasMoreResults: () => next < pages.length,
          fetchNext: async () => {
            const page = pages[next] ?? [];
            next += 1;
            return {
              resources: page.map(doc => ({
                deviceId: doc.deviceId,
                hourStart: doc['hourStart'],
                slots: structuredClone(doc['slots']),
              })),
              requestCharge: ROLLUP_PAGE_CHARGE,
              hasMoreResults: next < pages.length,
            };
          },
        };
      },
    },
  } as unknown as Container;

  return {
    container,
    calls,
    documents,
    /** The stored document, without the fake's etag. */
    get(deviceId: string, id: string): Record<string, unknown> | undefined {
      const stored = documents.get(key(deviceId, id));
      if (!stored) return undefined;
      const { _etag, ...rest } = stored;
      void _etag;
      return rest;
    },
    seed(document: { id: string; deviceId: string } & Record<string, unknown>) {
      documents.set(key(document.deviceId, document.id), {
        ...structuredClone(document),
        _etag: nextEtag(),
      });
    },
    beforeWrite(hook: (op: 'create' | 'replace', id: string) => void) {
      hooks.beforeWrite = hook;
    },
    writes(): RollupCall[] {
      return calls.filter(call => call.op === 'create' || call.op === 'replace');
    },
  };
}
