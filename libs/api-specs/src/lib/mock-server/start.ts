// Register tsconfig path aliases (e.g. `@meatgeekv2/utils` → libs/utils/src)
// before any module that needs them is required. The mock-data simulator
// imports through these aliases, so without this register the ts-node entry
// fails with MODULE_NOT_FOUND. This deliberately keeps the project.json
// `serve` target as a plain `ts-node ... start.ts` invocation per the
// README's documented contract.
//
// The workspace does not have a root `tsconfig.json` — only `tsconfig.base.json`
// — so we register the alias map explicitly rather than relying on
// tsconfig-paths' filename autodetection.
import * as path from 'path';
// eslint-disable-next-line @typescript-eslint/no-require-imports
const tsconfigPaths = require('tsconfig-paths');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const baseTsconfig = require(path.resolve(process.cwd(), 'tsconfig.base.json'));
tsconfigPaths.register({
  baseUrl: path.resolve(process.cwd()),
  paths: baseTsconfig.compilerOptions?.paths ?? {},
});

import { buildApp } from './server';

/**
 * Entry point invoked by the project.json `serve` target:
 *   ts-node libs/api-specs/src/lib/mock-server/start.ts
 *
 * Reads PORT (default 4010), builds the Express app from the on-disk spec, and
 * listens. The deliberate ts-node-via-run-commands shape is documented in the
 * lib README as a deviation from the @nx/js:tsc library convention so that
 * `nx serve api-specs` satisfies the acceptance criterion of a browsable
 * Swagger UI at a local URL.
 */
async function main(): Promise<void> {
  const port = Number(process.env['PORT'] ?? 4010);
  const app = await buildApp();
  app.listen(port, () => {
    // eslint-disable-next-line no-console
    console.log(`[meatgeekv2-mock-api] listening on http://localhost:${port}`);
    // eslint-disable-next-line no-console
    console.log(`[meatgeekv2-mock-api] Swagger UI: http://localhost:${port}/docs`);
  });
}

main().catch((err) => {
  // eslint-disable-next-line no-console
  console.error('[meatgeekv2-mock-api] failed to start', err);
  process.exit(1);
});
