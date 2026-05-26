import * as path from 'path';
import * as fs from 'fs';
import * as os from 'os';
import { execFileSync } from 'child_process';

import * as ts from 'typescript';

import { MOCK_COOKS, MOCK_DEVICES } from '../src/lib/mock-data/fixtures';

const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const SPEC_PATH = path.resolve(__dirname, '..', 'spec', 'openapi.yaml');

/**
 * Generate TS types from the OpenAPI spec via the openapi-typescript CLI.
 *
 * We shell out rather than calling openapi-typescript as a library because
 * v7 of openapi-typescript pulls in ESM-only dependencies that Jest's
 * default CJS transformer cannot load. The CLI is a separate process and
 * sidesteps the issue entirely.
 */
function generateTypes(specPath: string): string {
  const tmpOut = path.join(
    fs.mkdtempSync(path.join(os.tmpdir(), 'api-specs-roundtrip-')),
    'types.ts',
  );
  execFileSync(
    'npx',
    ['--no-install', 'openapi-typescript', specPath, '-o', tmpOut],
    {
      cwd: REPO_ROOT,
      stdio: ['ignore', 'ignore', 'pipe'],
      // Generation parses YAML, dereferences $refs, walks every schema.
      // 60s gives a generous floor for cold containers.
      timeout: 60_000,
    },
  );
  const out = fs.readFileSync(tmpOut, 'utf8');
  try {
    fs.rmSync(path.dirname(tmpOut), { recursive: true, force: true });
  } catch {
    /* ignore */
  }
  return out;
}

/**
 * Compile a virtual TS file that imports the generated types and assigns a
 * fixture to the matching type. Any divergence between the spec and the
 * fixture surfaces as a TS diagnostic.
 *
 * The check is compile-only: we don't execute the synthesized file.
 */
function compileCheck(checkSource: string): readonly ts.Diagnostic[] {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'api-specs-roundtrip-'));
  const checkPath = path.join(tmp, 'check.ts');
  fs.writeFileSync(checkPath, checkSource, 'utf8');

  const program = ts.createProgram({
    rootNames: [checkPath],
    options: {
      noEmit: true,
      strict: true,
      target: ts.ScriptTarget.ES2020,
      module: ts.ModuleKind.CommonJS,
      esModuleInterop: true,
      skipLibCheck: true,
      types: [],
    },
  });

  const diagnostics = [
    ...program.getSyntacticDiagnostics(),
    ...program.getSemanticDiagnostics(),
    ...program.getGlobalDiagnostics(),
  ];

  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {
    /* ignore */
  }

  return diagnostics;
}

function formatDiagnostics(diagnostics: readonly ts.Diagnostic[]): string {
  return ts.formatDiagnosticsWithColorAndContext(
    diagnostics as ts.Diagnostic[],
    {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (f) => f,
      getNewLine: () => '\n',
    },
  );
}

describe('round-trip — spec → openapi-typescript → fixture conformance', () => {
  jest.setTimeout(90_000);

  let generatedTypes = '';

  beforeAll(() => {
    generatedTypes = generateTypes(SPEC_PATH);
    expect(generatedTypes.length).toBeGreaterThan(0);
  });

  it('produces named schema types (smoke for codegen friendliness)', () => {
    // openapi-typescript emits a `components.schemas` interface keyed by schema name.
    // If the spec had only anonymous inline schemas, Go codegen via oapi-codegen would
    // produce map[string]interface{} blobs — surface that drift here.
    expect(generatedTypes).toMatch(/StartCookRequest/);
    expect(generatedTypes).toMatch(/\bCook\b/);
    expect(generatedTypes).toMatch(/Device/);
    expect(generatedTypes).toMatch(/export interface components/);
  });

  it('a StartCookRequest fixture compiles against the generated type', () => {
    const activeCook = MOCK_COOKS.find((c) => c.status === 'active');
    if (!activeCook) throw new Error('fixtures missing an active cook');

    const startRequest = {
      name: activeCook.name,
      deviceId: activeCook.deviceId,
      meatType: activeCook.meatType ?? 'brisket',
      weight: activeCook.weight,
      targetTemps: activeCook.targetTemps,
      notes: activeCook.notes,
    };

    const checkSource = `
${generatedTypes}

type Schemas = components['schemas'];
type StartCookRequest = Schemas['StartCookRequest'];

const fixture: StartCookRequest = ${JSON.stringify(startRequest, null, 2)};

export { fixture };
`;

    const diagnostics = compileCheck(checkSource);
    if (diagnostics.length > 0) {
      throw new Error(
        `StartCookRequest fixture failed to compile against generated TS:\n${formatDiagnostics(diagnostics)}`,
      );
    }
    expect(diagnostics).toHaveLength(0);
  });

  it('a Device fixture compiles against the generated Device type', () => {
    const device = MOCK_DEVICES[0];
    expect(device).toBeDefined();

    const checkSource = `
${generatedTypes}

type Schemas = components['schemas'];
type Device = Schemas['Device'];

const fixture: Device = ${JSON.stringify(device, null, 2)};

export { fixture };
`;

    const diagnostics = compileCheck(checkSource);
    if (diagnostics.length > 0) {
      throw new Error(
        `Device fixture failed to compile against generated TS:\n${formatDiagnostics(diagnostics)}`,
      );
    }
    expect(diagnostics).toHaveLength(0);
  });
});
