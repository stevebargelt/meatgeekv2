// A stand-in for @azure/cosmos, shaped exactly like the slice of the real
// client the exporter uses. The subscription this tool targets is disabled and
// the account is about to be deleted, so the failure paths — 429 with retries
// exhausted, a transport error mid-pagination, a count that does not reconcile
// — can only be exercised against a fake. They are the part that matters, so
// the fake is what makes them testable.
//
// Every mutating method the real client exposes is present here and throws, so
// a future edit that reaches for one fails a test rather than touching V1 data.

export class FakeCosmosError extends Error {
  constructor(message, { statusCode, code, name } = {}) {
    super(message);
    this.name = name ?? 'ErrorResponse';
    if (statusCode !== undefined) this.statusCode = statusCode;
    if (code !== undefined) this.code = code;
  }
}

export const throttleError = () =>
  new FakeCosmosError('Request rate is large. More Request Units may be needed', {
    statusCode: 429,
    code: 429,
  });

export const transportError = () =>
  new FakeCosmosError('socket hang up', { code: 'ECONNRESET', name: 'RestError' });

export const authError = () => new FakeCosmosError('Unauthorized', { statusCode: 401 });

// What an account with disableLocalAuth: true returns to a principal holding
// only control-plane RBAC (subscription Owner and nothing else).
export const forbiddenError = () =>
  new FakeCosmosError(
    'Request blocked by Auth meatgeek : Request is blocked because principal does not have required RBAC permissions to perform action',
    { statusCode: 403 }
  );

// What DefaultAzureCredential raises when every credential in the chain fails
// — no az login, no managed identity, no service principal in the environment.
export const credentialUnavailableError = () =>
  new FakeCosmosError('DefaultAzureCredential failed to retrieve a token from the included', {
    name: 'AggregateAuthenticationError',
  });

// Stand-ins for the two modules createRealClient imports, so what the auth
// wiring hands to CosmosClient can be asserted without the SDK or a network.
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

export function docs(prefix, count, from = 0) {
  return Array.from({ length: count }, (_, i) => ({
    id: `${prefix}-${from + i}`,
    // Marker used by tests asserting no document content reaches the logs.
    notes: `SECRET-PAYLOAD-${prefix}-${from + i}`,
  }));
}

function mutationGuard(name) {
  return () => {
    throw new Error(`read-only violation: ${name} was called`);
  };
}

async function* pageIterator(spec) {
  const pages = spec.pages ?? [];
  for (let i = 0; i < pages.length; i += 1) {
    if (spec.throwAfterPages === i) throw spec.error;
    yield { resources: pages[i] };
  }
  if (spec.throwAfterPages === pages.length) throw spec.error;
}

// spec: { <database>: { <container>: { count, pages, throwAfterPages?, error?, countError? } } }
export function fakeClient(spec, { listError } = {}) {
  return {
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
      if (!containers) throw new FakeCosmosError('NotFound', { statusCode: 404 });
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
          if (!containerSpec) throw new FakeCosmosError('NotFound', { statusCode: 404 });
          return {
            items: {
              query: () => ({
                fetchAll: async () => {
                  if (containerSpec.countError) throw containerSpec.countError;
                  return { resources: [containerSpec.count] };
                },
              }),
              readAll: () => ({ getAsyncIterator: () => pageIterator(containerSpec) }),
              create: mutationGuard('items.create'),
              upsert: mutationGuard('items.upsert'),
              bulk: mutationGuard('items.bulk'),
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
