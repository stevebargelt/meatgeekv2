import type {
  Application,
  Express,
  Request,
  RequestHandler,
  Response,
} from 'express';

import {
  getCachedSpec,
  getDefaultSpec,
  initValidator,
  isInitialized,
  validateRequest,
} from '../validation';
import { mountSwaggerUi } from '../swagger-ui';
import { registerCookRoutes } from './handlers/cooks';
import { registerTemperatureRoutes } from './handlers/temperatures';
import { registerDeviceRoutes } from './handlers/devices';
import { registerHealthRoute } from './handlers/health';

// express's typings publish via `export =`. The workspace tsconfig disables
// esModuleInterop, so we require it directly to avoid an `import express`
// type-vs-runtime mismatch — same pattern as spec-loader.ts.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const express: typeof import('express') = require('express');

export interface BuildAppOptions {
  /**
   * When true, the OpenAPI validator middleware rejects malformed requests
   * with a 400 VALIDATION_ERROR envelope. When false, errors are attached to
   * `res.locals.openapiValidation` and the handler runs anyway. Defaults true.
   */
  failOnValidationError?: boolean;
  /**
   * Override the Swagger UI mount path. Defaults to `/docs`.
   */
  swaggerUiPath?: string;
}

/**
 * Build the Express app from an already-loaded (dereferenced) OpenAPI spec.
 * Pure: no filesystem access, no async work, no `process.env` reads. Used by
 * tests that want to inject a tailored spec via supertest.
 */
export function buildAppFromSpec(
  spec: NonNullable<ReturnType<typeof getCachedSpec>>,
  options: BuildAppOptions = {},
): Express {
  if (!isInitialized() || getCachedSpec() !== spec) {
    initValidator(spec);
  }

  const app: Express = express();

  // Swagger UI is mounted BEFORE body parsing + validation so the
  // documentation surface is unaffected by JSON-body errors or the validator
  // rejecting `/docs` as an unknown OpenAPI route.
  mountSwaggerUi(app, spec, { path: options.swaggerUiPath ?? '/docs' });

  // Health is similarly off-spec — register it before validation.
  registerHealthRoute(app);

  app.use(express.json());

  // Inline OpenAPI request middleware. We do NOT use the shipped
  // `openapiValidator` express-adapter because it forwards `req.params` to the
  // core — but middleware runs BEFORE Express route-matching populates params,
  // so the validator would mistakenly see no path params. By passing
  // `undefined` for params we let the core extract them from the concrete
  // path itself (validator.ts: extractParamsFromConcretePath).
  const failOnError = options.failOnValidationError ?? true;
  const requestValidator: RequestHandler = (req, res, next) => {
    const result = validateRequest(
      req.method,
      req.path,
      req.body,
      req.query as Record<string, unknown>,
      undefined,
    );
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
  app.use(requestValidator);

  registerCookRoutes(app);
  registerTemperatureRoutes(app);
  registerDeviceRoutes(app);

  // Unmatched routes fall through to a 404 with the same error envelope shape
  // used by the Functions handlers.
  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: 'NOT_FOUND',
      message: `No route matches ${req.method} ${req.path}`,
      requestId: (req.headers['x-request-id'] as string) ?? '',
    });
  });

  return app;
}

/**
 * Build the Express app using the on-disk default spec (libs/api-specs/spec/
 * openapi.yaml). Awaits dereferencing and validator-init before returning a
 * fully wired app. Callers — including `start.ts` and supertest cases — must
 * await this to ensure the spec is loaded before serving traffic.
 */
export async function buildApp(options: BuildAppOptions = {}): Promise<Application> {
  const spec = await getDefaultSpec();
  return buildAppFromSpec(spec, options);
}
