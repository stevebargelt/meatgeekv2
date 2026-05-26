import Ajv, { ErrorObject, ValidateFunction } from 'ajv';
import addFormats from 'ajv-formats';
import type { OpenAPIV3 } from 'openapi-types';

import { loadSpec, setCachedSpec } from './spec-loader';
import {
  HttpMethod,
  OpenApiDocument,
  ValidationError,
  ValidationResult,
} from './types';

const HTTP_METHODS: HttpMethod[] = [
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
];

interface ParamCompiled {
  name: string;
  in: 'query' | 'path' | 'header' | 'cookie';
  required: boolean;
  validate: ValidateFunction;
}

interface CompiledOperation {
  method: HttpMethod;
  pathTemplate: string;
  pathRegex: RegExp;
  paramNames: string[];
  requestBody?: ValidateFunction;
  requestBodyRequired: boolean;
  parameters: ParamCompiled[];
  /** statusCode (e.g. "200") → response body validator. May contain "default". */
  responses: Record<string, ValidateFunction>;
}

let bodyAjv: Ajv | null = null;
let paramAjv: Ajv | null = null;
let compiledOps: CompiledOperation[] = [];

/**
 * Compile the spec's operations into a flat lookup. Runs once at startup; all later
 * validateRequest / validateResponse calls are synchronous and pure over this state.
 */
export function initValidator(spec: OpenApiDocument): void {
  bodyAjv = makeAjv({ coerceTypes: false });
  paramAjv = makeAjv({ coerceTypes: true });

  compiledOps = compileOperations(spec, bodyAjv, paramAjv);
  setCachedSpec(spec);
}

/** Convenience wrapper: load the spec then initialize. */
export async function initValidatorFromSpec(specPath?: string): Promise<void> {
  const spec = await loadSpec(specPath);
  initValidator(spec);
}

/** Reset all state — primarily for tests. */
export function resetValidator(): void {
  bodyAjv = null;
  paramAjv = null;
  compiledOps = [];
  setCachedSpec(null);
}

export function isInitialized(): boolean {
  return bodyAjv !== null && paramAjv !== null;
}

/**
 * Validate an incoming request against the spec.
 *
 * `routePath` may be either the OpenAPI route template (`/cooks/{id}`) or a concrete
 * URL path (`/cooks/abc-123`); both forms resolve to the same operation.
 */
export function validateRequest(
  method: string,
  routePath: string,
  payload?: unknown,
  query?: Record<string, unknown> | URLSearchParams,
  params?: Record<string, unknown>,
): ValidationResult {
  ensureInitialized();
  const op = findOperation(method, routePath);
  if (!op) {
    return {
      valid: false,
      errors: [
        {
          path: '',
          message: `No operation defined for ${method.toUpperCase()} ${routePath}`,
          keyword: 'operation',
        },
      ],
    };
  }

  const errors: ValidationError[] = [];

  if (op.requestBody) {
    if (payload === undefined || payload === null) {
      if (op.requestBodyRequired) {
        errors.push({
          path: '/body',
          message: 'Request body is required',
          keyword: 'required',
        });
      }
    } else if (!op.requestBody(payload)) {
      errors.push(...formatAjvErrors(op.requestBody.errors ?? [], '/body'));
    }
  }

  const queryObj = normalizeQuery(query);
  const paramsObj =
    params ?? extractParamsFromConcretePath(op, routePath) ?? {};

  for (const p of op.parameters) {
    const source =
      p.in === 'query'
        ? queryObj
        : p.in === 'path'
          ? paramsObj
          : undefined;
    if (!source) continue;

    const raw = source[p.name];
    if (raw === undefined || raw === '') {
      if (p.required) {
        errors.push({
          path: `/${p.in}/${p.name}`,
          message: `Parameter '${p.name}' is required`,
          keyword: 'required',
        });
      }
      continue;
    }
    if (!p.validate(raw)) {
      errors.push(
        ...formatAjvErrors(p.validate.errors ?? [], `/${p.in}/${p.name}`),
      );
    }
  }

  return { valid: errors.length === 0, errors };
}

/**
 * Validate an outgoing response payload against the spec for the matched operation.
 * Useful in development to catch handler/spec drift; the mock server uses it.
 */
export function validateResponse(
  method: string,
  routePath: string,
  statusCode: number,
  payload: unknown,
): ValidationResult {
  ensureInitialized();
  const op = findOperation(method, routePath);
  if (!op) {
    return {
      valid: false,
      errors: [
        {
          path: '',
          message: `No operation defined for ${method.toUpperCase()} ${routePath}`,
          keyword: 'operation',
        },
      ],
    };
  }
  const validator =
    op.responses[String(statusCode)] ?? op.responses['default'];
  if (!validator) {
    return { valid: true, errors: [] };
  }
  if (!validator(payload)) {
    return {
      valid: false,
      errors: formatAjvErrors(validator.errors ?? [], '/body'),
    };
  }
  return { valid: true, errors: [] };
}

function makeAjv(opts: { coerceTypes: boolean }): Ajv {
  const ajv = new Ajv({
    allErrors: true,
    strict: false,
    useDefaults: false,
    coerceTypes: opts.coerceTypes,
  });
  addFormats(ajv);
  return ajv;
}

function compileOperations(
  spec: OpenApiDocument,
  bodyAjvIn: Ajv,
  paramAjvIn: Ajv,
): CompiledOperation[] {
  const out: CompiledOperation[] = [];
  const paths = spec.paths ?? {};
  for (const [pathTemplate, pathItem] of Object.entries(paths)) {
    if (!pathItem) continue;
    const pathLevelParams = (pathItem.parameters ??
      []) as OpenAPIV3.ParameterObject[];

    for (const method of HTTP_METHODS) {
      const op = (pathItem as Record<string, unknown>)[method] as
        | OpenAPIV3.OperationObject
        | undefined;
      if (!op) continue;

      const { regex, paramNames } = compilePathTemplate(pathTemplate);

      const opParams = (op.parameters ?? []) as OpenAPIV3.ParameterObject[];
      const mergedParams = mergeParams(pathLevelParams, opParams);
      const parameters = mergedParams.map<ParamCompiled>((p) => ({
        name: p.name,
        in: p.in as ParamCompiled['in'],
        required: Boolean(p.required),
        validate: paramAjvIn.compile(
          (p.schema as OpenAPIV3.SchemaObject) ?? { type: 'string' },
        ),
      }));

      let requestBody: ValidateFunction | undefined;
      let requestBodyRequired = false;
      if (op.requestBody && !('$ref' in op.requestBody)) {
        const rb = op.requestBody as OpenAPIV3.RequestBodyObject;
        requestBodyRequired = Boolean(rb.required);
        const jsonSchema = rb.content?.['application/json']?.schema as
          | OpenAPIV3.SchemaObject
          | undefined;
        if (jsonSchema) {
          requestBody = bodyAjvIn.compile(jsonSchema);
        }
      }

      const responses: Record<string, ValidateFunction> = {};
      for (const [code, resp] of Object.entries(op.responses ?? {})) {
        if (!resp || '$ref' in resp) continue;
        const r = resp as OpenAPIV3.ResponseObject;
        const schema = r.content?.['application/json']?.schema as
          | OpenAPIV3.SchemaObject
          | undefined;
        if (schema) {
          responses[code] = bodyAjvIn.compile(schema);
        }
      }

      out.push({
        method,
        pathTemplate,
        pathRegex: regex,
        paramNames,
        requestBody,
        requestBodyRequired,
        parameters,
        responses,
      });
    }
  }
  return out;
}

function compilePathTemplate(template: string): {
  regex: RegExp;
  paramNames: string[];
} {
  const paramNames: string[] = [];
  const pattern = template.replace(/\{([^}]+)\}/g, (_, name) => {
    paramNames.push(name);
    return '([^/]+)';
  });
  return { regex: new RegExp(`^${pattern}$`), paramNames };
}

function mergeParams(
  pathLevel: OpenAPIV3.ParameterObject[],
  opLevel: OpenAPIV3.ParameterObject[],
): OpenAPIV3.ParameterObject[] {
  const map = new Map<string, OpenAPIV3.ParameterObject>();
  for (const p of pathLevel) map.set(`${p.in}:${p.name}`, p);
  for (const p of opLevel) map.set(`${p.in}:${p.name}`, p);
  return Array.from(map.values());
}

function extractParamsFromConcretePath(
  op: CompiledOperation,
  routePath: string,
): Record<string, string> | null {
  if (op.pathTemplate === routePath) return null;
  const m = op.pathRegex.exec(routePath);
  if (!m) return null;
  const out: Record<string, string> = {};
  op.paramNames.forEach((name, i) => {
    out[name] = m[i + 1];
  });
  return out;
}

function findOperation(
  method: string,
  routePath: string,
): CompiledOperation | null {
  const m = method.toLowerCase() as HttpMethod;
  for (const op of compiledOps) {
    if (op.method === m && op.pathTemplate === routePath) return op;
  }
  for (const op of compiledOps) {
    if (op.method === m && op.pathRegex.test(routePath)) return op;
  }
  return null;
}

function ensureInitialized(): void {
  if (!isInitialized()) {
    throw new Error(
      'Validator not initialized. Call initValidator(spec) or initValidatorFromSpec() at app startup.',
    );
  }
}

function normalizeQuery(
  query: Record<string, unknown> | URLSearchParams | undefined,
): Record<string, unknown> {
  if (!query) return {};
  if (query instanceof URLSearchParams) {
    const out: Record<string, unknown> = {};
    query.forEach((v, k) => {
      out[k] = v;
    });
    return out;
  }
  return query;
}

function formatAjvErrors(
  errs: ErrorObject[],
  basePath: string,
): ValidationError[] {
  return errs.map((e) => {
    const instance = e.instancePath ?? '';
    return {
      path: `${basePath}${instance}`,
      message: e.message ?? 'Validation error',
      keyword: e.keyword,
      schemaPath: e.schemaPath,
      params: e.params as Record<string, unknown>,
    };
  });
}
