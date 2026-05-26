import type { OpenAPIV3 } from 'openapi-types';

export type HttpMethod =
  | 'get'
  | 'post'
  | 'put'
  | 'patch'
  | 'delete'
  | 'head'
  | 'options';

export interface ValidationError {
  /** Where the failure was located (JSON pointer or "/body" / "/query/<name>" / "/path/<name>"). */
  path: string;
  /** Human-readable diagnostic. */
  message: string;
  /** Ajv keyword that triggered the failure (e.g. "required", "additionalProperties"). */
  keyword?: string;
  /** Raw schema path from Ajv, when available. */
  schemaPath?: string;
  /** Ajv params block, useful for clients that want to introspect (e.g. missing field name). */
  params?: Record<string, unknown>;
}

export interface ValidationResult {
  valid: boolean;
  errors: ValidationError[];
}

/** OpenAPI v3 document type re-export so callers don't need to depend on openapi-types directly. */
export type OpenApiDocument = OpenAPIV3.Document;
