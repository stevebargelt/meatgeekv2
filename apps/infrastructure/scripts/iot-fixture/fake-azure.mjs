// Stand-ins for the two pieces of Azure this fixture tool touches: the Cosmos
// reader it confirms the arrival with, and the `az` CLI child process it sends
// the device message through (MG-67).
//
// The whole product of this tool is its FAILURE paths — an auth failure that
// must not read as an absence, a bounded wait that must not read as a success, a
// partial read-back that must not read as either. None of those can be produced
// on demand against a live hub, and the build container holds no Azure
// credential at all, so the fake is what makes them testable.
//
// This is a deliberate sibling of cosmos-export/fake-cosmos.mjs, not a reuse of
// it: that fake models a `SELECT VALUE COUNT(1)` count query, which is the exact
// shape this tool may NOT use (a count delta is not a correlation), and it
// belongs to MG-66's live surface. Nothing here imports from that directory.
//
// Every mutating method the real Cosmos client exposes is present here and
// throws, so a future edit that reaches for one fails a test instead of writing
// to the dev database. This tool is a READER.

export class FakeAzureError extends Error {
  constructor(message, { statusCode, code, name } = {}) {
    super(message);
    this.name = name ?? 'ErrorResponse';
    if (statusCode !== undefined) this.statusCode = statusCode;
    if (code !== undefined) this.code = code;
  }
}

export const authError = () => new FakeAzureError('Unauthorized', { statusCode: 401 });

// Verbatim what the dev account returns to a principal holding only
// control-plane RBAC. The account runs local_authentication_enabled = false, so
// this is the shape an operator hits before the temporary data-plane role
// assignment propagates — the single most likely failure of the live run, and
// the one that absolutely must not be reported as "the route did not deliver".
export const forbiddenError = () =>
  new FakeAzureError(
    'Request blocked by Auth meatgeek : Request is blocked because principal does not have required RBAC permissions to perform action',
    { statusCode: 403 }
  );

export const transportError = () =>
  new FakeAzureError('socket hang up', { code: 'ECONNRESET', name: 'RestError' });

export const throttleError = () =>
  new FakeAzureError('Request rate is large. More Request Units may be needed', {
    statusCode: 429,
    code: 429,
  });

// What DefaultAzureCredential raises when every credential in the chain fails —
// no az login, no managed identity, no service principal in the environment.
export const credentialUnavailableError = () =>
  new FakeAzureError('DefaultAzureCredential failed to retrieve a token from the included', {
    name: 'AggregateAuthenticationError',
  });

function mutationGuard(name) {
  return () => {
    throw new Error(`read-only violation: ${name} was called`);
  };
}

// Documents with no marker knowledge on purpose: the synthetic marker contract
// belongs to fixture-core, and a fake that minted valid marked documents by
// default would make the marker-violation path impossible to see.
export function docs(prefix, count, extra = {}) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${i}`,
    ...extra,
  }));
}

function scriptedOutcomes({ script = [], fallback = { docs: [] } } = {}) {
  let index = 0;
  return () => {
    const outcome = index < script.length ? script[index] : fallback;
    index += 1;
    return outcome ?? { docs: [] };
  };
}

// The reader seam the confirmation read-back is injected with.
//
// One method, shaped after `container.items.query({query, parameters}, options)`
// so the adapter over the real client is a thin translation: `partitionKey`
// present means the query is scoped to that partition, `partitionKey` absent
// means a cross-partition sweep. The distinction is load-bearing — "delivered
// under an unexpected partition" and "not delivered" are different outcomes with
// different exit codes.
//
// `script` is per CALL, not per query text: outcomes are consumed in invocation
// order, which is how "two empty polls then the documents arrive" and "a 403 on
// the first poll and NO further poll" are both expressible. `calls` records every
// invocation so a test can assert the polling actually stopped.
//
// spec: { script: [{ docs } | { error }], fallback: { docs } | { error } }
export function fakeReader(spec = {}) {
  const calls = [];
  const next = scriptedOutcomes(spec);
  return {
    calls,
    async queryDocuments(request = {}) {
      calls.push({
        query: request.query,
        parameters: request.parameters ? [...request.parameters] : undefined,
        partitionKey: request.partitionKey,
      });
      const outcome = next();
      if (outcome.error) throw outcome.error;
      return outcome.docs ?? [];
    },
    // Present and throwing: the reader seam is read-only by construction, and a
    // future edit that grows a write here fails a test rather than a review.
    createDocument: mutationGuard('reader.createDocument'),
    upsertDocument: mutationGuard('reader.upsertDocument'),
    replaceDocument: mutationGuard('reader.replaceDocument'),
    patchDocument: mutationGuard('reader.patchDocument'),
    deleteDocument: mutationGuard('reader.deleteDocument'),
    bulk: mutationGuard('reader.bulk'),
  };
}

// A stand-in for the slice of @azure/cosmos the CLI edge adapts into a reader.
// Its query delegates to the same scripted outcome format fakeReader uses, so
// the core's tests and the edge's tests share one script vocabulary.
//
// spec: { <database>: { <container>: { script, fallback } } }
export function fakeCosmosClient(spec = {}, { listError } = {}) {
  const calls = [];
  const readers = new Map();
  return {
    calls,
    databases: {
      readAll: () => ({
        fetchAll: async () => {
          if (listError) throw listError;
          return { resources: Object.keys(spec).map(id => ({ id })) };
        },
      }),
      create: mutationGuard('databases.create'),
      createIfNotExists: mutationGuard('databases.createIfNotExists'),
    },
    database(databaseId) {
      const containers = spec[databaseId];
      if (!containers) throw new FakeAzureError('NotFound', { statusCode: 404 });
      return {
        containers: {
          readAll: () => ({
            fetchAll: async () => ({ resources: Object.keys(containers).map(id => ({ id })) }),
          }),
          create: mutationGuard('containers.create'),
          createIfNotExists: mutationGuard('containers.createIfNotExists'),
        },
        delete: mutationGuard('database.delete'),
        container(containerId) {
          const containerSpec = containers[containerId];
          if (!containerSpec) throw new FakeAzureError('NotFound', { statusCode: 404 });
          const key = `${databaseId}/${containerId}`;
          if (!readers.has(key)) readers.set(key, scriptedOutcomes(containerSpec));
          const next = readers.get(key);
          return {
            items: {
              query: (querySpec, options = {}) => ({
                fetchAll: async () => {
                  calls.push({
                    database: databaseId,
                    container: containerId,
                    query: querySpec?.query ?? querySpec,
                    parameters: querySpec?.parameters,
                    partitionKey: options.partitionKey,
                  });
                  const outcome = next();
                  if (outcome.error) throw outcome.error;
                  return { resources: outcome.docs ?? [] };
                },
              }),
              create: mutationGuard('items.create'),
              upsert: mutationGuard('items.upsert'),
              bulk: mutationGuard('items.bulk'),
              batch: mutationGuard('items.batch'),
            },
            item: mutationGuard('container.item'),
            delete: mutationGuard('container.delete'),
            replace: mutationGuard('container.replace'),
          };
        },
      };
    },
  };
}

// Stand-ins for the two modules the real client construction imports, so what
// the auth wiring hands to CosmosClient can be asserted without the SDK and
// without a network.
export function fakeCosmosModule(constructed) {
  return {
    CosmosClient: class CosmosClient {
      constructor(options) {
        constructed.push(options);
        this.options = options;
      }
    },
  };
}

export function fakeIdentityModule({ throwOnConstruct } = {}) {
  return {
    DefaultAzureCredential: class DefaultAzureCredential {
      constructor() {
        if (throwOnConstruct) throw throwOnConstruct;
        this.credentialKind = 'DefaultAzureCredential';
      }
    },
  };
}

// A stand-in for spawning `az iot device send-d2c-message`, so the send path is
// testable with no az binary, no hub and no network.
//
// It records the FULL argv of every invocation, because the invocation shape is
// part of this ticket's contract and not just an implementation detail: az
// persists invocations under ~/.azure and prints request signatures under
// verbosity, so "no credential in the argv, no --debug, no --verbose" is
// something the tests must be able to assert directly.
//
// Returns { code, stdout, stderr }. The returned function carries `.calls`.
// spec: { script: [{ code, stdout, stderr } | { error }], fallback }
export function fakeAzSpawn({ script = [], fallback = { code: 0 } } = {}) {
  const calls = [];
  const spawn = async (command, argv = [], options = {}) => {
    calls.push({ command, argv: [...argv], options });
    const outcome = (calls.length <= script.length ? script[calls.length - 1] : fallback) ?? {};
    if (outcome.error) throw outcome.error;
    return {
      code: outcome.code ?? 0,
      stdout: outcome.stdout ?? '',
      stderr: outcome.stderr ?? '',
    };
  };
  spawn.calls = calls;
  return spawn;
}
