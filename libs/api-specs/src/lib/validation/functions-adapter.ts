import type {
  HttpHandler,
  HttpRequest,
  HttpResponseInit,
} from '@azure/functions';

import { ValidationResult } from './types';
import { validateRequest } from './validator';

/**
 * Apply the OpenAPI request verdict to an Azure Functions HttpRequest and return the
 * result. Reads the body via `request.clone().text()` so the downstream handler can
 * still consume the original stream. Pure relative to the input — the framework
 * adapters are thin wrappers around the same core validator.
 */
export async function validateFunctionsRequest(
  request: HttpRequest,
): Promise<ValidationResult> {
  const url = new URL(request.url);
  let path = url.pathname;
  // Azure Functions default-routes everything under `/api`. Strip that prefix so the
  // path lines up with OpenAPI route templates declared without a server-base.
  if (path.startsWith('/api/')) {
    path = path.substring(4);
  } else if (path === '/api') {
    path = '/';
  }

  const query: Record<string, string> = {};
  request.query.forEach((value, key) => {
    query[key] = value;
  });

  let body: unknown = undefined;
  try {
    const text = await request.clone().text();
    if (text && text.length > 0) {
      body = JSON.parse(text);
    }
  } catch {
    // Body unreadable or non-JSON; validator will report missing-body if required.
  }

  return validateRequest(request.method, path, body, query, request.params);
}

/**
 * Wrap an Azure Functions v4 HTTP handler with OpenAPI request validation. Returns a
 * new handler whose return type is `HttpHandler`. On validation failure the wrapper
 * short-circuits with a 400 VALIDATION_ERROR envelope matching the existing handler
 * convention; on success the wrapped handler runs unchanged.
 */
export function withOpenApiValidation(handler: HttpHandler): HttpHandler {
  return async (request, context) => {
    const result = await validateFunctionsRequest(request);
    if (!result.valid) {
      const response: HttpResponseInit = {
        status: 400,
        jsonBody: {
          error: 'VALIDATION_ERROR',
          message:
            result.errors.map((e) => `${e.path} ${e.message}`).join('; ') ||
            'Request failed OpenAPI validation',
          details: result.errors,
          requestId: context.invocationId,
        },
      };
      return response;
    }
    return handler(request, context);
  };
}
