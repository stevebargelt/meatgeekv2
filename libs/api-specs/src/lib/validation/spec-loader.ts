import * as path from 'path';
import type { OpenAPIV3 } from 'openapi-types';

// swagger-parser publishes with `export =`; bypass esModuleInterop dependency by using
// a CommonJS-style require so this loader compiles cleanly under the workspace's
// strict tsconfig (esModuleInterop is not enabled in tsconfig.base.json).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SwaggerParser: typeof import('@apidevtools/swagger-parser') = require('@apidevtools/swagger-parser');

/**
 * Default location of the canonical OpenAPI spec, relative to this compiled file.
 * Layout: libs/api-specs/src/lib/validation/spec-loader.ts → ../../../spec/openapi.yaml.
 * Override with the OPENAPI_SPEC_PATH environment variable (useful in tests).
 */
export const DEFAULT_SPEC_PATH =
  process.env['OPENAPI_SPEC_PATH'] ??
  path.resolve(__dirname, '..', '..', '..', 'spec', 'openapi.yaml');

let cachedSpec: OpenAPIV3.Document | null = null;
let inFlight: Promise<OpenAPIV3.Document> | null = null;

/**
 * Load + dereference the spec at the given path. Does NOT touch the module cache —
 * callers wanting cached behavior should use {@link getDefaultSpec}.
 */
export async function loadSpec(
  specPath: string = DEFAULT_SPEC_PATH,
): Promise<OpenAPIV3.Document> {
  const api = await SwaggerParser.dereference(specPath);
  return api as OpenAPIV3.Document;
}

/**
 * Lazy, cached load of the default spec. Concurrent callers share the same in-flight
 * promise so dereference runs at most once.
 */
export async function getDefaultSpec(): Promise<OpenAPIV3.Document> {
  if (cachedSpec) return cachedSpec;
  if (inFlight) return inFlight;
  inFlight = loadSpec().then((spec) => {
    cachedSpec = spec;
    inFlight = null;
    return spec;
  });
  return inFlight;
}

/** Synchronous accessor — returns null until {@link getDefaultSpec} or {@link setCachedSpec} runs. */
export function getCachedSpec(): OpenAPIV3.Document | null {
  return cachedSpec;
}

/** Replace (or clear, with null) the cached spec. Tests use this to inject inline specs. */
export function setCachedSpec(spec: OpenAPIV3.Document | null): void {
  cachedSpec = spec;
  inFlight = null;
}
