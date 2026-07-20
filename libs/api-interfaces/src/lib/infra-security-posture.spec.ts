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
 *   - No secret OUTPUTS (connection strings / primary|access keys /
 *     instrumentation keys) in any module or root outputs.tf, for ANY service
 *     INCLUDING App Insights.
 *   - The Function App uses a managed identity + identity-based host storage,
 *     and its app_settings carry NON-SECRET endpoints (no *_CONNECTION_STRING /
 *     account access key) for Cosmos / IoT(EventHub) / SignalR.
 *   - The Function App identity is granted narrowly-scoped data-plane RBAC.
 *   - The Functions storage account name is subscription-derived (globally
 *     unique) so a greenfield apply cannot collide.
 *
 * OPERATOR-ACCEPTED RESIDUAL (MG-24, operator decision): azurerm_application_insights
 * stays Terraform-managed, so the resource's OWN computed connection_string /
 * instrumentation_key are inherently in state (true of any TF-managed resource).
 * That is accepted as low-risk (telemetry write-only; the Function App
 * authenticates ingestion via AAD, so the key is unused for auth; state access
 * restricted). main.tf:94-95 extracts ONLY the non-secret IngestionEndpoint into
 * a local, and only that endpoint reaches app_settings. The allowance is narrow:
 * these specs STILL fail on a real secret VALUE (a connection string / key)
 * reaching an app_settings map OR an output, for ANY service App Insights
 * included — see the "operator-accepted residual" describe block below.
 * S2 (Function App HTTP posture):
 *   - No wildcard CORS anywhere; allowed origins are environment-specific.
 *   - App Service Authentication is default-DENY (require_authentication=true,
 *     unauthenticated_action rejects rather than AllowAnonymous) on ALL paths —
 *     no anonymous carve-out for business (e.g. startCook) OR health. There is
 *     no HTTP health function and no excluded_paths bypass; health, if needed,
 *     is a platform mechanism, not an unauthenticated app path (MG-24 S2).
 */
import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as os from 'os';
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
  it('no secret OUTPUTS (connection strings / keys / instrumentation keys) in any outputs.tf', () => {
    // Mirrors the tf-static-checks.sh check-7 pattern. A bare `connection_string`
    // and `access_key` are matched (not only the primary/secondary variants) so
    // an App Insights `.connection_string` — which embeds the InstrumentationKey —
    // or an `instrumentation_key` emitted as an OUTPUT is caught like any other
    // service's secret. No App Insights exemption.
    const secretPattern =
      /connection_string|primary_key|secondary_key|access_key|shared_access_policy|instrumentation_key|InstrumentationKey=|AccountKey=|SharedAccessKey=/;
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

    it('Application Insights ingestion is AAD identity-based — no ingestion key in app_settings', () => {
      // Host authenticates telemetry with an AAD token, not an ingestion key.
      expect(live).toMatch(/APPLICATIONINSIGHTS_AUTHENTICATION_STRING"\s*=\s*"Authorization=AAD"/);
      // The connection-string setting carries ONLY the non-secret ingestion
      // endpoint — never an instrumentation/ingestion key or a secret
      // connection-string attribute reference.
      expect(live).toMatch(/APPLICATIONINSIGHTS_CONNECTION_STRING"\s*=\s*"IngestionEndpoint=/);
      expect(live).not.toMatch(/InstrumentationKey=/);
      expect(live).not.toMatch(/instrumentation_key/i);
      // No secret Terraform attribute / var is copied into app_settings.
      expect(live).not.toMatch(/\.connection_string/);
      expect(live).not.toMatch(/var\.application_insights_connection_string/);
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

  it('root grants the Function App identity Monitoring Metrics Publisher on App Insights (AAD ingestion)', () => {
    const live = stripComments(read('main.tf'));
    expect(live).toMatch(/azurerm_role_assignment"\s+"functions_appinsights_publisher"/);
    expect(live).toMatch(/Monitoring Metrics Publisher/);
    // Scoped to the App Insights resource, targeting the Function App identity.
    expect(live).toMatch(/scope\s*=\s*azurerm_application_insights\.main\.id/);
    // The App Insights connection string (with its ingestion key) is NOT passed
    // into the Functions module — only the non-secret ingestion endpoint is.
    expect(live).not.toMatch(/application_insights_connection_string\s*=/);
    expect(live).toMatch(/application_insights_ingestion_endpoint\s*=/);
  });

  it('root main.tf extracts ONLY the non-secret IngestionEndpoint from the AI connection string (main.tf:94-95)', () => {
    // The accepted-residual extraction pattern: a regex pulls JUST the
    // IngestionEndpoint substring out of the App Insights resource's own
    // connection_string, wrapped in nonsensitive(), into a local. The
    // instrumentation/ingestion key is never propagated — only the endpoint
    // reaches the Functions module (and thence app_settings).
    const live = stripComments(read('main.tf'));
    expect(live).toMatch(/appinsights_ingestion_endpoint\s*=\s*nonsensitive\(/);
    expect(live).toMatch(
      /regex\("IngestionEndpoint=\(\[\^;\]\+\)", azurerm_application_insights\.main\.connection_string\)/
    );
    // Only the endpoint local is handed to the Functions module — never the raw
    // connection string or the instrumentation key.
    expect(live).toMatch(
      /application_insights_ingestion_endpoint\s*=\s*local\.appinsights_ingestion_endpoint/
    );
    expect(live).not.toMatch(/application_insights_connection_string\s*=/);
    expect(live).not.toMatch(/application_insights_instrumentation_key\s*=/);
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

describe('MG-24 S1: the static gate documents the operator-accepted App Insights residual precisely', () => {
  const gate = read('scripts/tf-static-checks.sh');

  it('documents the operator-accepted residual (auditable, non-widening)', () => {
    // The gate carries an explicit, auditable note: the App Insights resource
    // stays TF-managed, so its own computed connection_string / instrumentation_key
    // are inherently in state (an accepted low-risk residual), and main.tf:94-95
    // extracts ONLY the non-secret IngestionEndpoint. The note must state the
    // allowance is narrow and does NOT exempt app_settings / outputs.
    expect(gate).toMatch(/OPERATOR-ACCEPTED RESIDUAL/);
    expect(gate).toMatch(/IngestionEndpoint/);
    expect(gate).toMatch(/inherently stores its own computed attributes in state/);
    // It is explicitly NOT a blanket App Insights exemption.
    expect(gate).toMatch(/NOT a blanket App Insights exemption/);
  });

  it('the secret-output scan catches an App Insights connection string / instrumentation key', () => {
    // Check-7 pattern includes a bare `connection_string` (so an App Insights
    // `.connection_string` output — which embeds the InstrumentationKey — is
    // caught, not only the primary/secondary variants) plus the ingestion-key
    // markers.
    expect(gate).toMatch(/connection_string\|primary_key/);
    expect(gate).toMatch(/instrumentation_key/);
    expect(gate).toMatch(/InstrumentationKey=/);
  });

  it('the Function App app_settings scan catches any ingestion key / connection-string value', () => {
    // Value-targeted: a secret Terraform attribute/var reference or a literal
    // ingestion-key marker in app_settings must be flagged (App Insights too).
    expect(gate).toMatch(/\\\.connection_string/);
    expect(gate).toMatch(/\\\.instrumentation_key/);
    expect(gate).toMatch(/InstrumentationKey=/);
  });
});

describe('MG-24 S1: the static gate behaves — accepts the residual, catches real leaks', () => {
  const GATE = path.join(INFRA, 'scripts', 'tf-static-checks.sh');

  // Copy the committed infra to a scratch dir (skipping heavy/vendored trees) so
  // a planted leak can be injected without mutating the repo.
  function copyInfra(dst: string): void {
    fs.cpSync(INFRA, dst, {
      recursive: true,
      filter: (src: string) => {
        const base = path.basename(src);
        return base !== '.terraform' && base !== '.nx' && base !== 'node_modules';
      },
    });
  }

  function runGate(infraDir: string): { code: number; out: string } {
    try {
      const out = execFileSync('bash', [GATE, infraDir], { encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('PASSES on the committed infra — the endpoint-extraction residual does not trip it', () => {
    const { code } = runGate(INFRA);
    expect(code).toBe(0);
  });

  it('FAILS when a real AI connection string is planted into the Function App app_settings', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg24-gate-appsettings-'));
    try {
      const dst = path.join(tmp, 'infrastructure');
      copyInfra(dst);
      const funcMain = path.join(dst, 'modules', 'functions', 'main.tf');
      const src = fs.readFileSync(funcMain, 'utf8');
      const anchor = '"APPLICATIONINSIGHTS_SAMPLING_PERCENTAGE"   = "50"';
      // Plant a real leak: the AI resource's SECRET connection string (which
      // embeds the instrumentation key) assigned straight into app_settings.
      const leaked = src.replace(
        anchor,
        `${anchor}\n    "APPLICATIONINSIGHTS_CONNECTION_STRING_LEAK" = azurerm_application_insights.main.connection_string`
      );
      expect(leaked).not.toEqual(src); // the anchor existed
      fs.writeFileSync(funcMain, leaked);
      const { code, out } = runGate(dst);
      expect(code).not.toBe(0);
      expect(out).toMatch(/connection-string \/ ingestion-key \/ access-key setting still present/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FAILS when a real AI connection string is emitted as a Terraform output', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg24-gate-output-'));
    try {
      const dst = path.join(tmp, 'infrastructure');
      copyInfra(dst);
      const outputs = path.join(dst, 'outputs.tf');
      fs.appendFileSync(
        outputs,
        '\noutput "appinsights_connection_string" {\n  value     = azurerm_application_insights.main.connection_string\n  sensitive = true\n}\n'
      );
      const { code, out } = runGate(dst);
      expect(code).not.toBe(0);
      expect(out).toMatch(/no secret outputs/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });
});
