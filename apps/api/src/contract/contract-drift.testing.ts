/**
 * HAR-72 — the comparisons behind the OpenAPI drift check (contract.spec.ts).
 *
 * Pure functions over plain data, so the spec can run them on the real inputs
 * (main.ts's registrations, the dereferenced spec) and on altered copies, which
 * proves the check fails when a route or an operation goes missing.
 */
import type { OpenAPIV3 } from 'openapi-types';

/** What `app.http(name, options)` was given, as far as routing goes. */
export interface HttpRegistrationLike {
  methods?: readonly string[];
  route?: string;
}

/** One HTTP operation: a method and a path, plus where it came from. */
export interface Operation {
  method: string;
  path: string;
  /** The function name (main.ts) or the operationId (spec), for messages. */
  source: string;
}

export interface RouteDrift {
  /** Registered in main.ts, absent from the spec. */
  missingFromSpec: Operation[];
  /** Described by the spec, not registered in main.ts. */
  missingFromApi: Operation[];
}

const HTTP_METHODS = ['get', 'put', 'post', 'delete', 'options', 'head', 'patch', 'trace'] as const;

/**
 * A path with a leading slash and every parameter reduced to `{}`, so
 * `cooks/{cookId}/stop` and `/cooks/{id}/stop` compare equal: a parameter's
 * name is not part of the route, its position is. An Azure Functions route
 * constraint or optional marker (`{id:int}`, `{id?}`) is a parameter too.
 */
export function normalisePath(path: string): string {
  const withSlash = path.startsWith('/') ? path : `/${path}`;
  return withSlash.replace(/\{[^}]*\}/g, '{}');
}

function key(operation: Operation): string {
  return `${operation.method.toUpperCase()} ${normalisePath(operation.path)}`;
}

/**
 * The operations main.ts registers. A registration with no `methods` accepts
 * every method in Azure Functions; it is reported as `ANY`, which no spec
 * operation matches, so the drift check names it. A registration with no
 * `route` is served at its function name.
 */
export function registeredOperations(
  registrations: ReadonlyMap<string, HttpRegistrationLike>
): Operation[] {
  const operations: Operation[] = [];
  for (const [name, registration] of registrations) {
    const path = `/${registration.route ?? name}`;
    const methods = registration.methods?.length ? registration.methods : ['ANY'];
    for (const method of methods) {
      operations.push({ method: method.toUpperCase(), path, source: name });
    }
  }
  return operations;
}

/** Every operation the spec describes. */
export function specOperations(document: OpenAPIV3.Document): Operation[] {
  const operations: Operation[] = [];
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item?.[method];
      if (operation) {
        operations.push({
          method: method.toUpperCase(),
          path,
          source: operation.operationId ?? '(no operationId)',
        });
      }
    }
  }
  return operations;
}

/** The two sets' differences, compared on (METHOD, normalised path). */
export function compareRoutes(api: readonly Operation[], spec: readonly Operation[]): RouteDrift {
  const apiKeys = new Set(api.map(key));
  const specKeys = new Set(spec.map(key));
  return {
    missingFromSpec: api.filter(operation => !specKeys.has(key(operation))),
    missingFromApi: spec.filter(operation => !apiKeys.has(key(operation))),
  };
}

function label(operation: Operation): string {
  return `${operation.method} ${operation.path} (${operation.source})`;
}

/** The failure message: every route the spec lacks and every operation the
 *  API lacks, one per line. Empty when there is no drift. */
export function formatRouteDrift(drift: RouteDrift): string {
  if (drift.missingFromSpec.length === 0 && drift.missingFromApi.length === 0) {
    return '';
  }
  const lines = ['libs/api-specs/spec/openapi.yaml and apps/api/src/main.ts disagree.'];
  if (drift.missingFromSpec.length > 0) {
    lines.push('Routes main.ts registers that the spec does not describe:');
    lines.push(...drift.missingFromSpec.map(operation => `  - ${label(operation)}`));
  }
  if (drift.missingFromApi.length > 0) {
    lines.push('Operations the spec describes that main.ts does not register:');
    lines.push(...drift.missingFromApi.map(operation => `  - ${label(operation)}`));
  }
  return lines.join('\n');
}

/**
 * Operations that do not require the bearer scheme or do not declare a 401.
 * Security is the operation's own `security`, else the document's. A
 * requirement list with an empty object (`- {}`) makes auth optional, so it
 * does not count as requiring the scheme.
 */
export function operationsMissingAuth(
  document: OpenAPIV3.Document,
  schemeName = 'bearerAuth'
): string[] {
  const problems: string[] = [];
  const scheme = document.components?.securitySchemes?.[schemeName] as
    | OpenAPIV3.SecuritySchemeObject
    | undefined;
  if (!scheme || scheme.type !== 'http' || scheme.scheme?.toLowerCase() !== 'bearer') {
    problems.push(`components.securitySchemes.${schemeName} is not an http bearer scheme`);
  }
  for (const [path, item] of Object.entries(document.paths ?? {})) {
    for (const method of HTTP_METHODS) {
      const operation = item?.[method];
      if (!operation) continue;
      const where = `${method.toUpperCase()} ${path}`;
      const security = operation.security ?? document.security ?? [];
      const optional = security.some(requirement => Object.keys(requirement).length === 0);
      const requiresBearer = security.some(requirement => schemeName in requirement);
      if (!requiresBearer || optional) {
        problems.push(`${where}: does not require ${schemeName}`);
      }
      if (!operation.responses?.['401']) {
        problems.push(`${where}: declares no 401 response`);
      }
    }
  }
  return problems;
}
