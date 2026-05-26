import type { Request, RequestHandler } from 'express';

import { ValidationResult } from './types';
import { validateRequest } from './validator';

/**
 * Apply the OpenAPI request verdict to an Express request and return the result. Pure —
 * does not mutate req/res. The adapter is a thin wrapper around the framework-agnostic
 * core in `./validator`.
 */
export function validateExpressRequest(req: Request): ValidationResult {
  return validateRequest(
    req.method,
    req.path,
    req.body,
    req.query as Record<string, unknown>,
    req.params,
  );
}

export interface OpenApiValidatorOptions {
  /**
   * If true, validation failures yield a 400 with a VALIDATION_ERROR envelope
   * matching the Functions handlers' shape. If false, errors are attached to
   * `res.locals.openapiValidation` and `next()` is called regardless. Defaults to true.
   */
  failOnError?: boolean;
}

/**
 * Express middleware factory. Place AFTER body parsing (e.g. `express.json()`) so
 * `req.body` is populated.
 */
export function openapiValidator(
  options: OpenApiValidatorOptions = {},
): RequestHandler {
  const failOnError = options.failOnError ?? true;
  return (req, res, next) => {
    const result = validateExpressRequest(req);
    res.locals['openapiValidation'] = result;
    if (!result.valid && failOnError) {
      res.status(400).json({
        error: 'VALIDATION_ERROR',
        message:
          result.errors.map((e) => `${e.path} ${e.message}`).join('; ') ||
          'Request failed OpenAPI validation',
        details: result.errors,
        requestId: (req.headers['x-request-id'] as string) ?? '',
      });
      return;
    }
    next();
  };
}
