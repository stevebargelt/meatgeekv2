import type { Application, Handler } from 'express';
import type { OpenAPIV3 } from 'openapi-types';

// swagger-ui-express publishes as CommonJS with no default export; require it
// directly so the loader compiles cleanly under the workspace tsconfig
// (esModuleInterop is intentionally disabled — see spec-loader.ts).
// eslint-disable-next-line @typescript-eslint/no-var-requires
const swaggerUi: {
  serve: Handler[];
  setup: (
    swaggerDoc: OpenAPIV3.Document,
    opts?: unknown,
    options?: unknown,
    customCss?: string,
    customfavIcon?: string,
    swaggerUrl?: string,
    customSiteTitle?: string,
  ) => Handler;
} = require('swagger-ui-express');

export interface MountSwaggerUiOptions {
  /** URL path where the UI is mounted. Defaults to `/docs`. */
  path?: string;
  /** Browser-tab title. Defaults to `MeatGeek V2 API — Swagger UI`. */
  title?: string;
}

/**
 * Mount Swagger UI for the supplied (dereferenced) OpenAPI document on an
 * existing Express application. Extracted from the mock-server so other dev
 * tooling (e.g. an auxiliary docs server) can reuse it without dragging the
 * mock route handlers along.
 */
export function mountSwaggerUi(
  app: Application,
  spec: OpenAPIV3.Document,
  options: MountSwaggerUiOptions = {},
): void {
  const mountPath = options.path ?? '/docs';
  const title = options.title ?? 'MeatGeek V2 API — Swagger UI';
  app.use(mountPath, swaggerUi.serve, swaggerUi.setup(
    spec,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    title,
  ));
}
