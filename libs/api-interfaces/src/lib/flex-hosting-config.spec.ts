/**
 * Cross-file CONFIG-invariant guard for the MG-24 Flex Consumption hosting
 * revision (2026-07-23) — verify phase, test-engineer.
 *
 * The Terraform plan-level test
 * (apps/infrastructure/modules/functions/tests/flex_hosting_behavior.tftest.hcl)
 * proves the MODULE renders the right Flex plan. This spec proves the invariants
 * that live ACROSS files a single module plan cannot see:
 *
 *   - the API runtime floor + the CI/deploy runner Node version are BOTH 24
 *     (they must match the Flex runtime_version = "24"; a drift back to 20 builds
 *     the app on the wrong Node than it runs on);
 *   - dev/prod tfvars agree the whole stack is West US 2 (the only Flex-supported
 *     region of the two candidates), differ ONLY as scale-to-zero (dev) vs
 *     always-ready (prod), and both declare the Flex scale knobs;
 *   - the Flex-deprecated app settings are pruned from the environment configs;
 *   - the inherited Y1/EP1 service-plan-SKU input is gone and the module plan is
 *     the Flex FC1 plan (the single-model replacement);
 *   - the Cosmos DATABASE NAME reaches the Function App from the same Terraform
 *     value that creates the database, and no consumer restates it (MG-51).
 *
 * Like its siblings (infra-security-posture / ci-toolchain-pin / prod-deploy-split)
 * this is a *repo-tooling* invariant. It lives in api-interfaces because that leaf
 * lib is already wired into the CI `lint-and-test` matrix, so the guard runs on
 * every push — not only when someone remembers to run it locally. It reads the
 * committed sources as text/YAML: NO Azure, NO credentials, NO apply.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

const REPO_ROOT = path.resolve(__dirname, '../../../../');

function readRepo(rel: string): string {
  return fs.readFileSync(path.join(REPO_ROOT, rel), 'utf8');
}

/** Grab a scalar tfvars assignment value (RHS text) for `key = <value>`. */
function tfvar(tfvars: string, key: string): string | undefined {
  const m = tfvars.match(new RegExp(`^\\s*${key}\\s*=\\s*(.+?)\\s*(?:#.*)?$`, 'm'));
  return m ? m[1].trim() : undefined;
}

interface CiStep {
  uses?: string;
  with?: Record<string, unknown>;
}
interface CiWorkflow {
  env?: Record<string, unknown>;
  jobs?: Record<string, { steps?: CiStep[] }>;
}

const WORKFLOWS = ['.github/workflows/ci.yml', '.github/workflows/app-deploy-prod.yml'];

describe('MG-24 Flex: Node 24 runtime floor is consistent (API + CI/deploy runners)', () => {
  it('apps/api/package.json requires Node >= 24 (matches Flex runtime_version="24")', () => {
    const pkg = JSON.parse(readRepo('apps/api/package.json')) as {
      engines?: Record<string, string>;
    };
    expect(pkg.engines?.['node']).toBeDefined();
    // Floor must be 24+; a >=20 (or ^18/^20) floor lets the build run on an older
    // Node than the Flex host executes, the exact drift this bump fixes.
    expect(pkg.engines?.['node']).toMatch(/(>=|\^)\s*2[4-9]/);
    expect(pkg.engines?.['node']).not.toMatch(/\b(18|20|22)\b/);
  });

  it.each(WORKFLOWS)('%s sets NODE_VERSION to 24 and every setup-node uses the env var', rel => {
    const wf = yaml.load(readRepo(rel)) as CiWorkflow;
    // The workflow-level env pins Node 24 as a single source of truth.
    expect(String(wf.env?.['NODE_VERSION'])).toBe('24');
    // No setup-node step hardcodes a stale literal version — each references the
    // env var, so the single NODE_VERSION bump governs the whole workflow.
    const steps = Object.values(wf.jobs ?? {}).flatMap(j => j.steps ?? []);
    const setupNode = steps.filter(s => (s.uses ?? '').startsWith('actions/setup-node'));
    expect(setupNode.length).toBeGreaterThan(0);
    for (const s of setupNode) {
      expect(String(s.with?.['node-version'])).toBe('${{ env.NODE_VERSION }}');
    }
  });

  it('no workflow pins a stale Node 20 literal anywhere', () => {
    for (const rel of WORKFLOWS) {
      const raw = readRepo(rel);
      expect(raw).not.toMatch(/node-version:\s*['"]?20['"]?/);
      expect(raw).not.toMatch(/NODE_VERSION:\s*['"]?20['"]?/);
    }
  });
});

describe('MG-24 Flex: dev/prod region + scale parity', () => {
  const dev = readRepo('apps/infrastructure/environments/dev.tfvars');
  const prod = readRepo('apps/infrastructure/environments/prod.tfvars');

  it('both environments are pinned to West US 2 (a Flex-supported region)', () => {
    expect(tfvar(dev, 'location')).toBe('"West US 2"');
    expect(tfvar(prod, 'location')).toBe('"West US 2"');
  });

  it('dev is scale-to-zero (always_ready = 0); prod keeps a warm baseline (always_ready >= 1)', () => {
    const devAlways = Number(tfvar(dev, 'always_ready'));
    const prodAlways = Number(tfvar(prod, 'always_ready'));
    expect(devAlways).toBe(0); // ~$0 idle, inside the $50 RG budget
    expect(prodAlways).toBeGreaterThanOrEqual(1); // no cold starts on prod traffic
  });

  it('both environments declare the Flex scale knobs (memory tier + horizontal ceiling)', () => {
    for (const env of [dev, prod]) {
      const mem = Number(tfvar(env, 'instance_memory_in_mb'));
      const max = Number(tfvar(env, 'maximum_instance_count'));
      // Memory must be a Flex-supported tier; ceiling must be a sane 1..1000 bound.
      expect([512, 2048, 4096]).toContain(mem);
      expect(max).toBeGreaterThanOrEqual(1);
      expect(max).toBeLessThanOrEqual(1000);
    }
  });
});

describe('MG-24 Flex: deprecated settings + legacy plan SKU are gone', () => {
  const DEPRECATED = [
    'WEBSITE_NODE_DEFAULT_VERSION',
    'WEBSITE_CONTENTAZUREFILECONNECTIONSTRING',
    'WEBSITE_CONTENTSHARE',
    'WEBSITE_RUN_FROM_PACKAGE',
    'WEBSITE_TIME_ZONE',
  ];

  it('no Flex-deprecated WEBSITE_* setting appears in the environment tfvars', () => {
    for (const rel of [
      'apps/infrastructure/environments/dev.tfvars',
      'apps/infrastructure/environments/prod.tfvars',
    ]) {
      const raw = readRepo(rel);
      for (const key of DEPRECATED) {
        expect(raw).not.toContain(key);
      }
    }
  });

  it('the module app_settings set none of the Flex-deprecated WEBSITE_* keys', () => {
    // Strip comment lines so the prose documenting WHY they are pruned does not
    // self-match (the module block explains the pruning in a comment).
    const live = readRepo('apps/infrastructure/modules/functions/main.tf')
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n');
    for (const key of DEPRECATED) {
      expect(live).not.toContain(`"${key}"`);
    }
  });

  it('the inherited Y1/EP1 service-plan-SKU input is removed (no functions_app_service_plan_sku var or tfvars key)', () => {
    // The single Flex model replaces the per-env Y1/EP1 SKU input entirely.
    const stripComments = (tf: string) =>
      tf
        .split('\n')
        .filter(l => !/^\s*#/.test(l))
        .join('\n');
    const rootVars = stripComments(readRepo('apps/infrastructure/variables.tf'));
    expect(rootVars).not.toMatch(/variable\s+"functions_app_service_plan_sku"/);
    for (const rel of [
      'apps/infrastructure/environments/dev.tfvars',
      'apps/infrastructure/environments/prod.tfvars',
    ]) {
      expect(stripComments(readRepo(rel))).not.toMatch(/functions_app_service_plan_sku\s*=/);
    }
  });

  it('the module plan resource is the Flex FC1 plan, not a Y1/EP1 SKU', () => {
    const live = readRepo('apps/infrastructure/modules/functions/main.tf')
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n');
    // The single service_plan resource carries sku_name = "FC1".
    expect(live).toMatch(/sku_name\s*=\s*"FC1"/);
    // No Y1 (Consumption) or EP1/EP2/EP3 (Elastic Premium) SKU survives in code.
    expect(live).not.toMatch(/sku_name\s*=\s*"(Y1|EP[123])"/);
    // And the app is the Flex resource type (the linux_function_app is gone).
    expect(live).toMatch(/resource\s+"azurerm_function_app_flex_consumption"/);
    expect(live).not.toMatch(/resource\s+"azurerm_linux_function_app"/);
  });
});

/**
 * MG-51 — the Cosmos database name is ONE value with several consumers.
 *
 * Terraform creates the database as `${resource_prefix}-db`. The IoT Hub path
 * has always been handed that name through module wiring; the Functions path was
 * handed only the account endpoint, so the API guessed — and guessed a database
 * that has never existed, silently, while an IoT-path health check stayed green.
 * The asymmetry is the defect, and the fix is only durable if it stays a single
 * source: MG-53 changes this value during a migration cutover by editing
 * modules/cosmos-db/main.tf, and every consumer must move with it for free.
 *
 * This is exactly a cross-file invariant — the module plan proves the setting
 * renders, but only the root can show both consumers read the same output, and
 * only the app tree can show nothing restates the literal.
 */
describe('MG-51: the Cosmos database name reaches every consumer from one Terraform source', () => {
  const stripComments = (tf: string) =>
    tf
      .split('\n')
      .filter(l => !/^\s*#/.test(l))
      .join('\n');

  it('the database is still created from resource_prefix (the value everything else derives from)', () => {
    const cosmos = stripComments(readRepo('apps/infrastructure/modules/cosmos-db/main.tf'));
    expect(cosmos).toMatch(
      /resource\s+"azurerm_cosmosdb_sql_database"\s+"meatgeek"\s*\{[\s\S]*?name\s*=\s*"\$\{var\.resource_prefix\}-db"/
    );
    // Published so consumers can read it rather than rebuild it.
    const outputs = stripComments(readRepo('apps/infrastructure/modules/cosmos-db/outputs.tf'));
    expect(outputs).toMatch(
      /output\s+"database_name"\s*\{[\s\S]*?value\s*=\s*azurerm_cosmosdb_sql_database\.meatgeek\.name/
    );
  });

  it('the root wires that output to BOTH the IoT Hub and the Functions module', () => {
    const root = stripComments(readRepo('apps/infrastructure/main.tf'));
    const wirings =
      root.match(/cosmos_database_name\s*=\s*module\.cosmos_db\.database_name/g) ?? [];
    // One for iot_hub, one for azure_functions. The Functions half is what MG-51
    // added; a future consumer must join them, not spell the name again.
    expect(wirings.length).toBe(2);
    // No consumer may be handed a literal instead of the module output.
    expect(root).not.toMatch(/cosmos_database_name\s*=\s*"/);
  });

  it('the Functions module publishes it as the app setting the API reads', () => {
    const live = stripComments(readRepo('apps/infrastructure/modules/functions/main.tf'));
    expect(live).toMatch(/"COSMOSDB_DATABASE_NAME"\s*=\s*var\.cosmos_database_name/);
    // The account endpoint alone was the defect — both must be present.
    expect(live).toMatch(/"COSMOSDB__accountEndpoint"\s*=\s*var\.cosmos_account_endpoint/);
    // The module input carries no default: an unwired caller must fail at plan
    // time rather than deploy an app pointed at nothing.
    const vars = stripComments(readRepo('apps/infrastructure/modules/functions/variables.tf'));
    expect(vars).toMatch(/variable\s+"cosmos_database_name"\s*\{[\s\S]*?\n\}/);
    const block = vars.match(/variable\s+"cosmos_database_name"\s*\{[\s\S]*?\n\}/)?.[0] ?? '';
    expect(block).not.toMatch(/^\s*default\s*=/m);
  });

  it('no Terraform source or app config hardcodes a database name', () => {
    // The current name (meatgeek-v2-dev-db) may appear ONLY in module test
    // fixtures, which must pin a concrete value to assert against. Anywhere in
    // the shipped configuration it is a second source of truth that survives the
    // MG-53 cutover as a stale literal.
    for (const rel of [
      'apps/infrastructure/main.tf',
      'apps/infrastructure/modules/functions/main.tf',
      'apps/infrastructure/modules/iot-hub/main.tf',
      'apps/infrastructure/environments/dev.tfvars',
      'apps/infrastructure/environments/prod.tfvars',
    ]) {
      expect(stripComments(readRepo(rel))).not.toMatch(/meatgeek(-v2)?(-dev|-prod)?-db/);
    }
    // And the app-side fallback that produced the defect is gone, not relocated:
    // the databaseName assignment resolves the setting and nothing else. (The
    // block comment above it names the removed default, so comments are stripped
    // here too.)
    const devEnv = readRepo('apps/api/src/environments/environment.development.ts').replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    );
    expect(devEnv).toMatch(
      /databaseName:\s*requiredFromInfrastructure\('COSMOSDB_DATABASE_NAME'\),/
    );
    expect(devEnv).not.toMatch(/databaseName:[^\n]*\|\|/);
  });

  it('keeps database-name literals out of every deployable Terraform config and the dev Function App environment', () => {
    // Fixtures are intentionally excluded: their concrete values exercise
    // Terraform's plan assertions. This scan covers only configuration that can
    // ship to an environment, where a literal would become a second source of
    // truth on the next Cosmos database migration.
    const infrastructureRoot = path.join(REPO_ROOT, 'apps/infrastructure');
    const terraformConfigs: string[] = [];
    const collect = (directory: string) => {
      for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
        const absolute = path.join(directory, entry.name);
        if (entry.isDirectory()) {
          collect(absolute);
        } else if (
          entry.isFile() &&
          (entry.name.endsWith('.tf') || entry.name.endsWith('.tfvars'))
        ) {
          terraformConfigs.push(absolute);
        }
      }
    };
    collect(infrastructureRoot);

    // A concrete provisioned database follows the resource-prefix + "-db"
    // convention. Match only executable text, so explanatory comments may name
    // the historical outage without becoming false positives.
    const databaseLiteral = /["']meatgeek(?:-v2)?-(?:dev|prod)-db["']/;
    for (const config of terraformConfigs) {
      expect(stripComments(fs.readFileSync(config, 'utf8'))).not.toMatch(databaseLiteral);
    }

    const devEnvironment = readRepo('apps/api/src/environments/environment.development.ts').replace(
      /\/\*[\s\S]*?\*\//g,
      ''
    );
    expect(devEnvironment).not.toMatch(databaseLiteral);
    expect(devEnvironment).not.toMatch(/databaseName:[^\n]*(?:\|\||\?\?)/);
  });
});
