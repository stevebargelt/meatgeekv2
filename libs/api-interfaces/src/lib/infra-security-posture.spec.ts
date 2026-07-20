/**
 * Deterministic security-posture guard for the MeatGeek V2 Terraform stack
 * (MG-24 S1/S2). Host-runnable, NO credentials and NO live apply: it reads the
 * committed Terraform sources as text and asserts the secrets-out-of-state and
 * HTTP-posture invariants that must hold BEFORE the first greenfield apply.
 *
 * Like prod-deploy-split.spec.ts next door, this is a *repo-tooling* invariant
 * that lives in api-interfaces so it runs on every CI push (the lint-and-test
 * matrix), complementing apps/infrastructure/scripts/tf-static-checks.sh which
 * runs in the separate validate-infrastructure job.
 *
 * S1 (no plaintext runtime secrets in state):
 *   - No secret OUTPUTS (connection strings / primary|access keys) in any
 *     module or root outputs.tf.
 *   - The Function App uses a managed identity + identity-based host storage,
 *     and its app_settings carry NON-SECRET endpoints (no *_CONNECTION_STRING /
 *     account access key) for Cosmos / IoT(EventHub) / SignalR.
 *   - The Function App identity is granted narrowly-scoped data-plane RBAC.
 *   - The Functions storage account name is subscription-derived (globally
 *     unique) so a greenfield apply cannot collide.
 * S2 (Function App HTTP posture):
 *   - No wildcard CORS anywhere; allowed origins are environment-specific.
 *   - App Service Authentication is default-DENY (require_authentication=true,
 *     unauthenticated_action rejects rather than AllowAnonymous) on ALL paths —
 *     no anonymous carve-out for business (e.g. startCook) OR health. There is
 *     no HTTP health function and no excluded_paths bypass; health, if needed,
 *     is a platform mechanism, not an unauthenticated app path (MG-24 S2).
 */
import * as fs from 'fs';
import * as path from 'path';

const REPO_ROOT = path.resolve(__dirname, '../../../../');
const INFRA = path.join(REPO_ROOT, 'apps', 'infrastructure');

function read(rel: string): string {
  return fs.readFileSync(path.join(INFRA, rel), 'utf8');
}

/** All outputs.tf files under the infra tree (root + modules), excluding vendored dirs. */
function outputsFiles(): string[] {
  const found: string[] = [];
  const skip = new Set(['.terraform', 'node_modules', '.nx']);
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!skip.has(entry.name)) walk(path.join(dir, entry.name));
      } else if (entry.name === 'outputs.tf') {
        found.push(path.join(dir, entry.name));
      }
    }
  };
  walk(INFRA);
  return found;
}

/** Strip `#` comment lines so prose documenting removed items doesn't self-match. */
function stripComments(tf: string): string {
  return tf
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');
}

describe('MG-24 S1: no plaintext runtime secrets in Terraform state', () => {
  it('no secret OUTPUTS (connection strings / keys) in any outputs.tf', () => {
    const secretPattern =
      /primary_key|secondary_key|primary_access_key|secondary_access_key|primary_connection_string|secondary_connection_string|shared_access_policy|AccountKey=|SharedAccessKey=/;
    const offenders: string[] = [];
    for (const file of outputsFiles()) {
      const live = stripComments(fs.readFileSync(file, 'utf8'));
      if (secretPattern.test(live)) offenders.push(path.relative(INFRA, file));
    }
    expect(offenders).toEqual([]);
  });

  it('root outputs.tf drops the former secret aggregate outputs', () => {
    const live = stripComments(read('outputs.tf'));
    expect(live).not.toMatch(/output\s+"[^"]*connection_string"/);
    expect(live).not.toMatch(/environment_config/);
    expect(live).not.toMatch(/device_configuration/);
  });

  describe('Function App (modules/functions/main.tf)', () => {
    const tf = read('modules/functions/main.tf');
    const live = stripComments(tf);

    it('has a system-assigned managed identity', () => {
      expect(live).toMatch(/identity\s*\{/);
      expect(live).toMatch(/type\s*=\s*"SystemAssigned"/);
    });

    it('uses identity-based host storage (no account key in state)', () => {
      expect(live).toMatch(/storage_uses_managed_identity\s*=\s*true/);
      expect(live).not.toMatch(/storage_account_access_key/);
    });

    it('app_settings carry NON-SECRET identity endpoints, not connection strings', () => {
      // Identity-based endpoint settings present.
      expect(live).toMatch(/COSMOSDB__accountEndpoint/);
      expect(live).toMatch(/__fullyQualifiedNamespace/);
      expect(live).toMatch(/AzureSignalRConnectionString__serviceUri/);
      // No plaintext connection-string app settings for the identity services.
      expect(live).not.toMatch(/COSMOSDB_CONNECTION_STRING/);
      expect(live).not.toMatch(/IOTHUB_CONNECTION_STRING/);
      expect(live).not.toMatch(/SIGNALR_CONNECTION_STRING/);
    });

    it('grants the identity narrowly-scoped storage data roles', () => {
      expect(live).toMatch(/azurerm_role_assignment"\s+"functions_storage_blob"/);
      expect(live).toMatch(/Storage Blob Data Owner/);
      expect(live).toMatch(/Storage Queue Data Contributor/);
    });
  });

  it('root grants the Function App identity Cosmos / EventHub / SignalR data roles', () => {
    const live = stripComments(read('main.tf'));
    expect(live).toMatch(/azurerm_cosmosdb_sql_role_assignment"\s+"functions_cosmos"/);
    expect(live).toMatch(/Azure Event Hubs Data Receiver/);
    expect(live).toMatch(/SignalR Service Owner/);
    // All target the Function App's own managed identity principal.
    expect(live).toMatch(/module\.azure_functions\.identity_principal_id/);
  });

  it('IoT Hub Event Hubs routing endpoint is identity-based (no SAS in state)', () => {
    // The custom Event Hubs routing endpoint must authenticate with the IoT
    // Hub's managed identity, not a SAS connection string — otherwise a key /
    // connection string is materialized into Terraform state. The former
    // azurerm_eventhub_authorization_rule ("iothub-sender") must be gone.
    const live = stripComments(read('modules/iot-hub/main.tf'));
    expect(live).toMatch(/authentication_type\s*=\s*"identityBased"/);
    expect(live).not.toMatch(/connection_string\s*=/);
    expect(live).not.toMatch(/azurerm_eventhub_authorization_rule/);
    // The IoT Hub identity is granted the send data-plane role instead.
    expect(live).toMatch(/Azure Event Hubs Data Sender/);
  });

  it('Functions storage account name is subscription-derived (globally unique)', () => {
    const live = stripComments(read('main.tf'));
    const line = live.split('\n').find(l => /functions_storage_account_name\s*=/.test(l)) ?? '';
    expect(line).toMatch(/sha1\(/);
    expect(line).toMatch(/subscription_id/);
  });
});

describe('MG-24 S2: Function App HTTP posture', () => {
  it('no wildcard CORS anywhere in the Terraform sources', () => {
    // Scan every .tf for allowed_origins = [ ... "*" ... ].
    const skip = new Set(['.terraform', 'node_modules', '.nx']);
    const offenders: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(path.join(dir, entry.name));
        } else if (entry.name.endsWith('.tf')) {
          const live = stripComments(fs.readFileSync(path.join(dir, entry.name), 'utf8'));
          if (/allowed_origins\s*=\s*\[[^\]]*"\*"/.test(live)) {
            offenders.push(path.relative(INFRA, path.join(dir, entry.name)));
          }
        }
      }
    };
    walk(INFRA);
    expect(offenders).toEqual([]);
  });

  it('allowed CORS origins are environment-specific (dev !== prod, none wildcard)', () => {
    const dev = read('environments/dev.tfvars');
    const prod = read('environments/prod.tfvars');
    const grab = (tfvars: string, key: string): string => {
      const m = tfvars.match(new RegExp(`${key}\\s*=\\s*(\\[[^\\]]*\\])`));
      return m ? m[1] : '';
    };
    const devOrigins = grab(dev, 'functions_cors_allowed_origins');
    const prodOrigins = grab(prod, 'functions_cors_allowed_origins');
    expect(devOrigins).not.toBe('');
    expect(prodOrigins).not.toBe('');
    expect(devOrigins).not.toEqual(prodOrigins); // genuinely per-environment
    expect(devOrigins).not.toContain('"*"');
    expect(prodOrigins).not.toContain('"*"');
  });

  it('App Service Authentication is default-DENY (require auth, reject anonymous)', () => {
    const live = stripComments(read('modules/functions/main.tf'));
    expect(live).toMatch(/auth_settings_v2\s*\{/);
    expect(live).toMatch(/require_authentication\s*=\s*true/);
    // Unauthenticated requests are rejected (401/403), never allowed through.
    expect(live).toMatch(/unauthenticated_action\s*=\s*"Return(401|403)"/);
    expect(live).not.toMatch(/unauthenticated_action\s*=\s*"AllowAnonymous"/);
  });

  it('auth is required on ALL paths — no anonymous carve-out (business OR health)', () => {
    // Easy Auth enforces auth for every path; there is no HTTP health function
    // and no anonymous exception. Assert the Terraform carves out nothing: no
    // per-path bypass (excluded_paths), and no anonymous "health"/"ready"/"live"
    // route hole. Dropping the anonymous-health exception is the S2 default-deny
    // resolution — health, if ever needed, is a platform mechanism, not an
    // unauthenticated app path.
    const live = stripComments(read('modules/functions/main.tf'));
    expect(live).not.toMatch(/excluded_paths/);
    expect(live).not.toMatch(/require_authentication\s*=\s*false/);
    expect(live).not.toMatch(/anonymous/i);
    expect(live).not.toMatch(/\/health\b/);
  });
});
