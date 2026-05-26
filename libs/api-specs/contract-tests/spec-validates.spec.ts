import * as path from 'path';
import * as fs from 'fs';

import type { OpenAPIV3 } from 'openapi-types';

// swagger-parser ships with `export =`; require it CommonJS-style to avoid the
// esModuleInterop dependency the workspace's tsconfig.base.json does not enable.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const SwaggerParser: typeof import('@apidevtools/swagger-parser') = require('@apidevtools/swagger-parser');

const SPEC_PATH = path.resolve(
  __dirname,
  '..',
  'spec',
  'openapi.yaml',
);

describe('OpenAPI spec — structural validation', () => {
  it('spec/openapi.yaml exists on disk', () => {
    expect(fs.existsSync(SPEC_PATH)).toBe(true);
  });

  it('parses + validates against OpenAPI 3.0 (swagger-parser validate)', async () => {
    // validate() runs both syntactic (YAML) and semantic (OpenAPI 3.x rules) checks.
    const api = (await SwaggerParser.validate(SPEC_PATH)) as OpenAPIV3.Document;
    expect(api.openapi).toMatch(/^3\./);
    expect(api.info).toBeDefined();
    expect(api.info.title).toBeTruthy();
    expect(api.paths).toBeDefined();
  });

  it('dereferences all $refs cleanly (no dangling pointers)', async () => {
    const api = (await SwaggerParser.dereference(SPEC_PATH)) as OpenAPIV3.Document;
    // After dereference, no $ref strings should remain anywhere in the doc.
    const serialized = JSON.stringify(api);
    expect(serialized).not.toContain('"$ref"');
  });

  it('declares at least one path operation', async () => {
    const api = (await SwaggerParser.dereference(SPEC_PATH)) as OpenAPIV3.Document;
    const paths = api.paths ?? {};
    const pathCount = Object.keys(paths).length;
    expect(pathCount).toBeGreaterThan(0);
  });

  it('lists currently-implemented routes that match apps/api/src/main.ts', async () => {
    const api = (await SwaggerParser.dereference(SPEC_PATH)) as OpenAPIV3.Document;
    const paths = api.paths ?? {};
    // These four routes are wired to live handlers per Step #2's acceptance.
    // Drift here means the spec no longer reflects the running Functions app.
    expect(paths['/cooks']).toBeDefined();
    expect(paths['/cooks']?.get).toBeDefined();
    expect(paths['/cooks']?.post).toBeDefined();
    expect(paths['/temperatures/current/{deviceId}']).toBeDefined();
    expect(paths['/temperatures/current/{deviceId}']?.get).toBeDefined();
    expect(paths['/devices']).toBeDefined();
    expect(paths['/devices']?.get).toBeDefined();
  });

  it('every operation has a unique operationId (codegen-friendly)', async () => {
    const api = (await SwaggerParser.dereference(SPEC_PATH)) as OpenAPIV3.Document;
    const paths = api.paths ?? {};
    const seen = new Map<string, string>();
    const methods = ['get', 'post', 'put', 'patch', 'delete'] as const;
    for (const [pathKey, pathItem] of Object.entries(paths)) {
      if (!pathItem) continue;
      const item = pathItem as Record<string, unknown>;
      for (const m of methods) {
        const op = item[m] as OpenAPIV3.OperationObject | undefined;
        if (!op || !op.operationId) continue;
        const where = `${m.toUpperCase()} ${pathKey}`;
        if (seen.has(op.operationId)) {
          throw new Error(
            `Duplicate operationId '${op.operationId}': ${seen.get(op.operationId)} and ${where}`,
          );
        }
        seen.set(op.operationId, where);
      }
    }
    // It's fine for some operations to lack an operationId during early drafts;
    // we only assert uniqueness when present. If/when ticket #4 needs full Go
    // codegen, tighten this to "every operation MUST have an operationId."
    expect(seen.size).toBeGreaterThan(0);
  });

  it('every SignalR payload schema declares a required correlation.id field', async () => {
    const api = (await SwaggerParser.dereference(SPEC_PATH)) as OpenAPIV3.Document;
    const schemas = (api.components?.schemas ?? {}) as Record<
      string,
      OpenAPIV3.SchemaObject
    >;
    // Step #2 fans out SignalR payloads under names like TemperatureUpdateMessage,
    // CookStartedMessage, DeviceOnlineMessage, etc. — match on the *Message suffix.
    // Exclude the SignalRMessage union (the discriminated wrapper).
    const signalrSchemas = Object.entries(schemas).filter(
      ([name]) => /Message$/.test(name) && name !== 'SignalRMessage',
    );
    if (signalrSchemas.length === 0) {
      // Spec authoring drift — fail loud rather than passing vacuously.
      throw new Error(
        'expected at least one SignalR *Message schema in components.schemas',
      );
    }
    for (const [name, schema] of signalrSchemas) {
      // Concrete messages use allOf [SignalREnvelopeBase, { ... }] — flatten by
      // collecting required + properties across the allOf chain.
      const { required, properties } = flattenAllOf(schema);
      expect(required).toContain('correlation');
      const correlation = properties['correlation'] as
        | OpenAPIV3.SchemaObject
        | undefined;
      expect(correlation).toBeDefined();
      const corrRequired = (correlation?.required ?? []) as string[];
      if (!corrRequired.includes('id')) {
        throw new Error(
          `SignalR schema '${name}' has correlation but correlation.id is not required`,
        );
      }
    }
  });
});

function flattenAllOf(schema: OpenAPIV3.SchemaObject): {
  required: string[];
  properties: Record<string, OpenAPIV3.SchemaObject>;
} {
  const required = new Set<string>(schema.required ?? []);
  const properties: Record<string, OpenAPIV3.SchemaObject> = {
    ...((schema.properties ?? {}) as Record<string, OpenAPIV3.SchemaObject>),
  };
  for (const sub of (schema.allOf ?? []) as OpenAPIV3.SchemaObject[]) {
    const flat = flattenAllOf(sub);
    flat.required.forEach((r) => required.add(r));
    Object.assign(properties, flat.properties);
  }
  return { required: Array.from(required), properties };
}
