/**
 * Deterministic security-posture guard for the MeatGeek V2 Terraform stack
 * (MG-24 S1/S2, corrective round). Host-runnable, NO credentials and NO live
 * apply: it reads the committed Terraform sources as text and asserts the
 * secrets-out-of-state, global-uniqueness and HTTP-posture invariants that must
 * hold BEFORE the first greenfield apply.
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
 *   - Every globally-scoped name (Functions storage account, Function App, IoT
 *     Hub, Event Hubs namespace, SignalR) is subscription-derived-unique so a
 *     greenfield apply cannot collide.
 *
 * OPERATOR-ACCEPTED RESIDUAL — CORRECTED COUPLED INVARIANT (MG-24 item 2):
 *   azurerm_application_insights stays Terraform-managed, so the resource's OWN
 *   computed connection_string / instrumentation_key are inherently in state
 *   (true of any TF-managed resource). Microsoft requires the FULL connection
 *   string (InstrumentationKey included, as the destination-resource identifier)
 *   as APPLICATIONINSIGHTS_CONNECTION_STRING even under Entra-only ingestion, so
 *   that full string DOES reach the Function App app_settings. This is accepted
 *   as low-risk ONLY because the ikey CANNOT authenticate ingestion: the AI
 *   resource sets `local_authentication_enabled = false`, forcing AAD-only
 *   ingestion (the host publishes via Monitoring Metrics Publisher +
 *   Authorization=AAD). The allowance is a COUPLED invariant — the full string is
 *   safe ONLY while local auth stays disabled. These specs FAIL if the full AI
 *   conn string is wired WITHOUT local_authentication_enabled=false, and still
 *   FAIL on any OTHER service's secret VALUE (a connection string / key) reaching
 *   an app_settings map OR an output. See the "operator-accepted residual"
 *   describe blocks below and the MG-24 ADR.
 * S2 (Function App HTTP posture):
 *   - No wildcard CORS anywhere; allowed origins are environment-specific.
 *   - App Service Authentication is FAIL-CLOSED / default-DENY: the module
 *     refuses to plan (lifecycle precondition) unless an Entra identity provider
 *     is configured, and once configured it is bearer-token VALIDATION only
 *     (require_authentication=true, Return401, token store disabled, NO client
 *     secret). No anonymous carve-out for business (e.g. startCook) OR health.
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
    // service's secret. No App Insights exemption for OUTPUTS: the corrected
    // coupled-invariant allowance is scoped to the Function App app_settings ONLY,
    // never to a Terraform output.
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

    it('uses identity-based Flex deployment storage (no account key in state)', () => {
      // MG-24 Flex revision: the hosting model moved from azurerm_linux_function_app
      // (whose `storage_uses_managed_identity = true` no longer exists) to
      // azurerm_function_app_flex_consumption. MI-authenticated deployment storage is
      // now expressed by the pair below, against a blobContainer on a storage account
      // that KEEPS shared-key access disabled — so no account key can leak into state.
      expect(live).toMatch(/storage_authentication_type\s*=\s*"SystemAssignedIdentity"/);
      expect(live).toMatch(/storage_container_type\s*=\s*"blobContainer"/);
      expect(live).not.toMatch(/storage_account_access_key/);
      // No raw deployment-storage key: under MI auth `storage_access_key` must be absent.
      expect(live).not.toMatch(/storage_access_key\s*=/);
    });

    it('creates the storage account via azapi (control plane) with shared key disabled', () => {
      // MG-24 azapi fix (403'd twice on live Azure): the functions storage account
      // is NOT an azurerm_storage_account — that resource performs its OWN shared-key
      // storage DATA-PLANE reads, which 403 on a shared-key-disabled account with
      // storage_use_azuread unset. It is created via azapi over the ARM CONTROL PLANE
      // (Microsoft.Storage/storageAccounts), so NO terraform principal performs a
      // storage data-plane op at apply. The shared-key-disabled invariant therefore
      // lives in the azapi body (allowSharedKeyAccess=false), not the former azurerm
      // shared_access_key_enabled attribute.
      expect(live).toMatch(/resource\s+"azapi_resource"\s+"functions_storage"/);
      expect(live).toMatch(/"Microsoft\.Storage\/storageAccounts@/);
      expect(live).toMatch(/allowSharedKeyAccess\s*=\s*false/);
      expect(live).toMatch(/kind\s*=\s*"StorageV2"/);
      expect(live).toMatch(/minimumTlsVersion\s*=\s*"TLS1_2"/);
      // The account is no longer an azurerm_storage_account resource at all.
      expect(live).not.toMatch(/resource\s+"azurerm_storage_account"/);
    });

    it('deployment container, MI role scopes and the Flex endpoint all reference the azapi account (MG-24 item 3)', () => {
      // MG-24 azapi fix: everything that pointed at the former
      // azurerm_storage_account must now point at the azapi_resource. This is what
      // proves the conversion is WIRED, not just that a lone azapi account exists.
      //
      // The deployment package container is created via azapi as a CHILD of the
      // azapi account (parent_id = "<account>.id/blobServices/default"), never via a
      // storage DATA-PLANE azurerm_storage_container.
      expect(live).toMatch(/resource\s+"azapi_resource"\s+"deployment_container"/);
      expect(live).toMatch(
        /parent_id\s*=\s*"\$\{azapi_resource\.functions_storage\.id\}\/blobServices\/default"/
      );
      expect(live).not.toMatch(/resource\s+"azurerm_storage_container"/);
      // The Function App managed-identity Blob + Queue data grants scope to the
      // azapi account id (least privilege, the account this apply creates).
      expect(live).toMatch(
        /azurerm_role_assignment"\s+"functions_storage_blob"[\s\S]*?scope\s*=\s*azapi_resource\.functions_storage\.id/
      );
      expect(live).toMatch(
        /azurerm_role_assignment"\s+"functions_storage_queue"[\s\S]*?scope\s*=\s*azapi_resource\.functions_storage\.id/
      );
      // The app-deploy principal grant scopes to the azapi deployment CONTAINER id
      // (container-scoped write for OneDeploy), not the whole account.
      expect(live).toMatch(
        /azurerm_role_assignment"\s+"deploy_principal_deployment_container"[\s\S]*?scope\s*=\s*azapi_resource\.deployment_container\.id/
      );
      // The Flex deployment endpoint is composed from the deterministic account-name
      // local — the control-plane azapi account exposes NO azurerm
      // primary_blob_endpoint attribute to interpolate, so a plain SAS-free URL is built.
      expect(live).toMatch(
        /storage_container_endpoint\s*=\s*"https:\/\/\$\{local\.functions_storage_account_name\}\.blob\.core\.windows\.net\/\$\{local\.deployment_container_name\}"/
      );
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

    it('does NOT set FUNCTIONS_WORKER_RUNTIME (or other Flex-forbidden classic settings) — runtime is runtime_name/runtime_version', () => {
      // MG-24 apply defect: a Flex Consumption site REJECTS FUNCTIONS_WORKER_RUNTIME
      // as an app setting (400 BadRequest ExtendedCode 51021). The worker runtime is
      // declared via the resource's runtime_name/runtime_version fields, not a
      // classic-Functions app setting. Guard the leftover cannot creep back.
      expect(live).not.toMatch(/FUNCTIONS_WORKER_RUNTIME/);
      expect(live).not.toMatch(/FUNCTIONS_EXTENSION_VERSION/);
      expect(live).not.toMatch(/AzureWebJobsStorage/);
      // The runtime is declared the Flex-native way.
      expect(live).toMatch(/runtime_name\s*=\s*"node"/);
      expect(live).toMatch(/runtime_version\s*=\s*"24"/);
    });

    it('App Insights ingestion is AAD identity-based — full conn string via the native site_config field, no hardcoded ikey', () => {
      // Host authenticates telemetry with an AAD token, not an ingestion key.
      expect(live).toMatch(/APPLICATIONINSIGHTS_AUTHENTICATION_STRING"\s*=\s*"Authorization=AAD"/);
      // MG-24 item 2 + second-plan no-op fix: the FULL TF-managed connection
      // string (InstrumentationKey included — Microsoft's required
      // destination-resource identifier) is wired via the Flex resource's NATIVE
      // site_config.application_insights_connection_string field, NOT an
      // app_setting. The Flex provider reflects the conn string into that native
      // field, so binding it as an app_setting produced a perpetual second-plan
      // diff; the native field is what makes the app plan as a no-op. It is safe
      // ONLY because local_authentication_enabled=false on the AI resource
      // (asserted below) and is enforced on this site_config field by the
      // tf-plan-secret-inspection gate.
      expect(live).toMatch(
        /application_insights_connection_string\s*=\s*var\.application_insights_connection_string/
      );
      // It must NOT be duplicated back into app_settings (the exact drift removed).
      expect(live).not.toMatch(/"APPLICATIONINSIGHTS_CONNECTION_STRING"\s*=/);
      // The value flows from the module VAR — never a hardcoded literal
      // InstrumentationKey= / ikey nor any OTHER service's secret attribute.
      expect(live).not.toMatch(/InstrumentationKey=/);
      expect(live).not.toMatch(/\.instrumentation_key/i);
      // No secret Terraform attribute of ANOTHER service is copied into a sink
      // (only the accepted AI conn-string var is permitted).
      expect(live).not.toMatch(/\.connection_string/);
      expect(live).not.toMatch(/COSMOSDB__accountKey|AccountKey=|SharedAccessKey=/);
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
    // MG-24 item 2 CORRECTION: the FULL AI connection string IS passed into the
    // Functions module now (the endpoint-only local was removed) — safe because
    // local auth is disabled (asserted below). The former endpoint-only
    // interface must be gone.
    expect(live).toMatch(/application_insights_connection_string\s*=/);
    expect(live).not.toMatch(/application_insights_ingestion_endpoint\s*=/);
  });

  it('root passes the FULL AI connection string COUPLED to local_authentication_enabled=false (MG-24 item 2)', () => {
    // The corrected accepted-residual model: the full TF-managed connection
    // string (InstrumentationKey included) is materialized nonsensitive() into a
    // local and handed to the Functions module — and that is safe ONLY because
    // the AI resource forces AAD-only ingestion via local_authentication_enabled.
    // The two facts are asserted together so the coupling cannot silently break.
    const live = stripComments(read('main.tf'));
    // (a) the full connection string local (no endpoint-substring regex extraction).
    expect(live).toMatch(
      /appinsights_connection_string\s*=\s*nonsensitive\(\s*azurerm_application_insights\.main\.connection_string\s*\)/
    );
    // The endpoint-only extraction shape must NOT return (regex IngestionEndpoint=…).
    expect(live).not.toMatch(/regex\("IngestionEndpoint=/);
    // (b) local auth disabled on the AI resource — the safety basis.
    expect(live).toMatch(/local_authentication_enabled\s*=\s*false/);
    // (c) the local flows into the module (not the raw attribute, not the ikey).
    expect(live).toMatch(
      /application_insights_connection_string\s*=\s*local\.appinsights_connection_string/
    );
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

describe('MG-24 item 9: every globally-scoped name is subscription-derived-unique', () => {
  it('root computes a subscription-derived global_name_suffix and threads it to all global modules', () => {
    const live = stripComments(read('main.tf'));
    // Deterministic subscription-derived suffix (no wall-clock / random).
    expect(live).toMatch(/global_name_suffix\s*=\s*substr\(\s*sha1\(/);
    expect(live).toMatch(/global_name_suffix\s*=\s*substr\(\s*sha1\([^)]*subscription_id/);
    // Threaded as `global_suffix` into iot_hub, azure_functions and signalr —
    // one passthrough per globally-scoped module (>= 3).
    const passthroughs = (live.match(/global_suffix\s*=\s*local\.global_name_suffix/g) ?? [])
      .length;
    expect(passthroughs).toBeGreaterThanOrEqual(3);
  });

  it('Function App name carries the global_suffix', () => {
    const live = stripComments(read('modules/functions/main.tf'));
    expect(live).toMatch(/name\s*=\s*"\$\{var\.resource_prefix\}-func-\$\{var\.global_suffix\}"/);
  });

  it('IoT Hub and Event Hubs namespace names carry the global_suffix', () => {
    const live = stripComments(read('modules/iot-hub/main.tf'));
    expect(live).toMatch(/name\s*=\s*"\$\{var\.resource_prefix\}-iothub-\$\{var\.global_suffix\}"/);
    expect(live).toMatch(
      /name\s*=\s*"\$\{var\.resource_prefix\}-eventhub-ns-\$\{var\.global_suffix\}"/
    );
    // The module declares the global_suffix input.
    const vars = stripComments(read('modules/iot-hub/variables.tf'));
    expect(vars).toMatch(/variable\s+"global_suffix"/);
  });

  it('SignalR service name carries the global_suffix', () => {
    const live = stripComments(read('modules/signalr/main.tf'));
    expect(live).toMatch(
      /name\s*=\s*"\$\{var\.resource_prefix\}-signalr-\$\{var\.global_suffix\}"/
    );
    const vars = stripComments(read('modules/signalr/variables.tf'));
    expect(vars).toMatch(/variable\s+"global_suffix"/);
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
    expect(live).toMatch(/auth_settings_v2/);
    expect(live).toMatch(/require_authentication\s*=\s*true/);
    // Unauthenticated requests are rejected (401/403), never allowed through.
    expect(live).toMatch(/unauthenticated_action\s*=\s*"Return(401|403)"/);
    expect(live).not.toMatch(/unauthenticated_action\s*=\s*"AllowAnonymous"/);
  });

  it('Easy Auth is FAIL-CLOSED when unconfigured (plan precondition refuses an anonymous app)', () => {
    // MG-24 item 3: an unconfigured Function App must not ship anonymous. The
    // auth_settings_v2 block is present ONLY when the Entra API registration is
    // configured (for_each gated on the client id), and a lifecycle precondition
    // REFUSES the plan when it is empty — so default-deny is enforced at plan
    // time rather than by an anonymous fallthrough.
    const live = stripComments(read('modules/functions/main.tf'));
    // Provider block is conditionally present on the configured client id.
    expect(live).toMatch(
      /for_each\s*=\s*var\.auth_active_directory_client_id\s*==\s*""\s*\?\s*\[\]\s*:\s*\[1\]/
    );
    // Fail-closed precondition: empty client id => plan refused.
    expect(live).toMatch(/precondition\s*\{/);
    expect(live).toMatch(/condition\s*=\s*var\.auth_active_directory_client_id\s*!=\s*""/);
  });

  it('Easy Auth is bearer-token VALIDATION only — token store disabled, NO client secret', () => {
    // MG-24 item 3: this is API/bearer-token validation, not an interactive
    // sign-in flow. No token-at-rest (token_store_enabled=false) and no client
    // secret anywhere (no secret materialized into state).
    const live = stripComments(read('modules/functions/main.tf'));
    expect(live).toMatch(/token_store_enabled\s*=\s*false/);
    expect(live).not.toMatch(/client_secret/);
    expect(live).toMatch(/allowed_applications\s*=/);
  });

  it('allowed_applications validates the CALLING client, NOT the API registration (MG-24 item 1 corrective)', () => {
    // allowed_applications checks the token's appid/azp — the CALLING client —
    // so it must be bound to the smoke-test client allowlist var, never to the
    // API registration's own client id. Binding [var.auth_active_directory_client_id]
    // (the API, which is the callee) is the exact bug this corrects.
    const funcLive = stripComments(read('modules/functions/main.tf'));
    expect(funcLive).toMatch(/allowed_applications\s*=\s*var\.auth_allowed_client_app_ids/);
    expect(funcLive).not.toMatch(
      /allowed_applications\s*=\s*\[\s*var\.auth_active_directory_client_id\s*\]/
    );
    // client_id + allowed_audiences still carry the API registration / App ID URI.
    expect(funcLive).toMatch(/client_id\s*=\s*var\.auth_active_directory_client_id/);
    expect(funcLive).toMatch(/allowed_audiences\s*=\s*var\.auth_allowed_audiences/);
    // The module declares the calling-client allowlist var, defaulted to the
    // Azure CLI public client (the caller for the operator token flow).
    const funcVars = stripComments(read('modules/functions/variables.tf'));
    expect(funcVars).toMatch(/variable\s+"auth_allowed_client_app_ids"/);
    expect(funcVars).toMatch(/04b07795-8ddb-461a-bbee-02f9e1bf7b46/);
    // Root threads it through and dev.tfvars wires the calling client id(s).
    const rootLive = stripComments(read('main.tf'));
    expect(rootLive).toMatch(
      /auth_allowed_client_app_ids\s*=\s*var\.functions_auth_allowed_client_app_ids/
    );
    const devTfvars = read('environments/dev.tfvars');
    expect(devTfvars).toMatch(/functions_auth_allowed_client_app_ids\s*=/);
    expect(devTfvars).toMatch(/04b07795-8ddb-461a-bbee-02f9e1bf7b46/);
  });

  it('auth is required on ALL paths — no anonymous carve-out (business OR health)', () => {
    // Easy Auth enforces auth for every path; there is no HTTP health function
    // and no anonymous exception. Assert the Terraform carves out nothing: no
    // per-path bypass (excluded_paths), no anonymous "health"/"ready"/"live"
    // route hole, and no require_authentication=false. Dropping the
    // anonymous-health exception is the S2 default-deny resolution — health, if
    // ever needed, is a platform mechanism, not an unauthenticated app path.
    //
    // NOTE: the fail-closed error_message legitimately uses the word "anonymous"
    // to describe what it PREVENTS, so a naive /anonymous/i scan would be a false
    // positive here; we instead assert the concrete carve-out shapes are absent.
    const live = stripComments(read('modules/functions/main.tf'));
    expect(live).not.toMatch(/excluded_paths/);
    expect(live).not.toMatch(/require_authentication\s*=\s*false/);
    expect(live).not.toMatch(/unauthenticated_action\s*=\s*"AllowAnonymous"/);
    expect(live).not.toMatch(/"\/health"|path\s*=\s*"\/health/);
  });
});

describe('MG-24 S1: the static gate documents the operator-accepted App Insights residual (corrected coupling)', () => {
  const gate = read('scripts/tf-static-checks.sh');

  it('documents the coupled-invariant residual (auditable, non-widening)', () => {
    // The gate carries an explicit, auditable note: the App Insights resource
    // stays TF-managed, so its own computed connection_string / instrumentation_key
    // are inherently in state (an accepted low-risk residual). The corrected model
    // allows the FULL conn string in app_settings ONLY when
    // local_authentication_enabled=false (the coupled invariant), and the runtime
    // guarantee is the fail-closed plan/state inspection.
    expect(gate).toMatch(/OPERATOR-ACCEPTED RESIDUAL/);
    expect(gate).toMatch(/local_authentication_enabled/);
    expect(gate).toMatch(/coupled[- ]invariant/i);
    expect(gate).toMatch(/tf-plan-secret-inspection\.sh/);
    // It is explicitly NOT a blanket App Insights exemption — the allowance is
    // narrow / coupled / non-widening. Assert the SUBSTANCE via stable keywords
    // rather than one exact sentence: the prose wraps across comment lines and
    // gets reworded (an exact-phrase match is brittle and was the CI break).
    expect(gate).toMatch(/blanket/);
    expect(gate).toMatch(/App Insights/);
    expect(gate).toMatch(/non-widening|does NOT widen|narrow|coupled|only/i);
  });

  it('the secret-output scan catches an App Insights connection string / instrumentation key', () => {
    // Check-7 pattern includes a bare `connection_string` (so an App Insights
    // `.connection_string` output — which embeds the InstrumentationKey — is
    // caught, not only the primary/secondary variants) plus the ingestion-key
    // markers. OUTPUTS get NO App Insights exemption (the coupled allowance is
    // app_settings-only).
    expect(gate).toMatch(/connection_string\|primary_key/);
    expect(gate).toMatch(/instrumentation_key/);
    expect(gate).toMatch(/InstrumentationKey=/);
  });

  it('the Function App app_settings scan enforces the coupled invariant (full AI conn string only when local auth disabled)', () => {
    // Value-targeted: a secret Terraform attribute/var reference or a literal
    // ingestion-key marker in app_settings is flagged, EXCEPT the accepted AI
    // conn-string var — and even that is a VIOLATION when
    // local_authentication_enabled is not set to false on the AI resource.
    expect(gate).toMatch(/\\\.connection_string/);
    expect(gate).toMatch(/\\\.instrumentation_key/);
    expect(gate).toMatch(/InstrumentationKey=/);
    // The cross-field conditional: full conn string WITHOUT local auth disabled fails.
    expect(gate).toMatch(/local_authentication_enabled/);
    expect(gate).toMatch(/coupled-invariant violation/);
  });

  it('the secret-output scan is HONESTLY labeled best-effort AND catches obfuscated index refs', () => {
    // The gate must NOT overclaim. It calls the output scan a best-effort guard
    // and names the RED bypass vector — a resource reference indexed with a
    // dynamically-assembled key (format/join/lookup/element/coalesce/try).
    expect(gate).toMatch(/BEST-EFFORT/);
    // Honest limitation prose: a lexical grep cannot evaluate/resolve Terraform
    // expressions. Match the SUBSTANCE (a resilient keyword pair) rather than one
    // exact sentence that could be reworded.
    expect(gate).toMatch(/cannot (evaluate|resolve)/i);
    expect(gate).toMatch(/Terraform expression/i);
    // The strengthened INDIRECT pattern is present (dynamic-index branch).
    expect(gate).toMatch(/INDIRECT_SECRET_RE=/);
    expect(gate).toMatch(/format\|join\|lookup\|element\|coalesce\|try/);
    // Any *_access_key spelling is covered directly (not just primary/secondary).
    expect(gate).toMatch(/\[A-Za-z0-9_\]\*_access_key/);
  });

  it('the app_settings scan ALSO catches obfuscated index refs', () => {
    // The same INDIRECT index detection is applied to Function App app_settings.
    expect(gate).toMatch(/APPSETTING_SECRET_RE=/);
    expect(gate).toMatch(/format\|join\|lookup\|element\|coalesce\|try/);
  });

  it('names the plan/state inspection as the AUTHORITATIVE guarantee (not the grep)', () => {
    // The honest claim: the lexical scan is best-effort; `terraform show -json`
    // + the fail-closed inspection script is what actually guarantees no
    // sensitive VALUE materializes.
    expect(gate).toMatch(/AUTHORITATIVE/);
    expect(gate).toMatch(/terraform show -json/);
  });

  it('check 12 requires the README to document the fail-closed pre-apply inspection', () => {
    // The gate enforces that the runbook keeps pointing at the authoritative
    // gate: check 12 fails if the README stops documenting the fail-closed
    // tf-plan-secret-inspection.sh as a REQUIRED pre-apply step.
    expect(gate).toMatch(/README=/);
    expect(gate).toMatch(/tf-plan-secret-inspection\.sh/);
    expect(gate).toMatch(/required pre-apply gate \(README\)/i);
  });
});

describe('MG-24 S1: the README wires the fail-closed plan/state inspection as a required pre-apply gate', () => {
  const readme = read('README.md');

  it('documents the best-effort static guard vs the authoritative inspection split', () => {
    expect(readme).toMatch(/best-effort/i);
    expect(readme).toMatch(/AUTHORITATIVE/);
    // The authoritative command pipes the real plan JSON into the fail-closed
    // inspection script (which EXITS NONZERO on any prohibited value) — NOT the
    // old always-green `grep ... || echo` one-liner.
    expect(readme).toMatch(/terraform show -json/);
    expect(readme).toMatch(/tf-plan-secret-inspection\.sh/);
  });

  it('marks the plan/state inspection REQUIRED before the first apply', () => {
    expect(readme).toMatch(
      /REQUIRED pre-apply|required before the first apply|required pre-apply/i
    );
  });

  it('documents the corrected App Insights (local-auth-disabled) coupling', () => {
    // The README's security note must reflect the corrected model: the full conn
    // string is present but the ikey cannot authenticate under local auth disabled.
    expect(readme).toMatch(/local_authentication_enabled/);
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

  it('PASSES on the committed infra — the coupled AI conn-string residual does not trip it', () => {
    const { code } = runGate(INFRA);
    expect(code).toBe(0);
  });

  it('FAILS when the FULL AI conn string is wired but local auth is re-enabled (local_authentication_enabled flipped to true)', () => {
    // The coupled invariant, exercised: the same full-conn-string app_setting
    // that is ACCEPTED while local auth is disabled becomes a VIOLATION the
    // moment the AAD-only lock is removed (the ikey could then authenticate).
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg24-gate-coupling-'));
    try {
      const dst = path.join(tmp, 'infrastructure');
      copyInfra(dst);
      const rootMain = path.join(dst, 'main.tf');
      const src = fs.readFileSync(rootMain, 'utf8');
      // Break the coupling: re-enable local auth (flip the AAD-only lock OFF)
      // while the full conn string remains in the Function App app_settings.
      // Anchor to the real assignment line (`^\s*local_authentication_enabled`) —
      // a bare token replace would hit the prose COMMENT occurrence first and
      // leave the code untouched.
      const unlocked = src.replace(
        /^(\s*)local_authentication_enabled\s*=\s*false/m,
        '$1local_authentication_enabled = true'
      );
      expect(unlocked).not.toEqual(src); // the flag existed
      expect(unlocked).toMatch(/^\s*local_authentication_enabled\s*=\s*true/m); // code line flipped
      fs.writeFileSync(rootMain, unlocked);
      const { code, out } = runGate(dst);
      expect(code).not.toBe(0);
      expect(out).toMatch(/coupled-invariant violation|WITHOUT local_authentication_enabled/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FAILS when a real AI connection string ATTRIBUTE is planted into the Function App app_settings', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg24-gate-appsettings-'));
    try {
      const dst = path.join(tmp, 'infrastructure');
      copyInfra(dst);
      const funcMain = path.join(dst, 'modules', 'functions', 'main.tf');
      const src = fs.readFileSync(funcMain, 'utf8');
      const anchor = '"APPLICATIONINSIGHTS_SAMPLING_PERCENTAGE"   = "50"';
      // Plant a real leak: the AI resource's SECRET connection string ATTRIBUTE
      // (which embeds the instrumentation key) assigned straight into app_settings.
      // This is NOT the accepted module var, so even with local auth disabled it
      // is a `.connection_string` attribute leak and must be flagged.
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

  it('FAILS on the RED obfuscated-index output — the literal token never appears', () => {
    // The exact bypass RED used against the old literal-token scan: the secret
    // attribute is reached by INDEXING the resource with a format()-assembled
    // key, so the string `connection_string` is absent from the source yet the
    // value IS the App Insights connection string. The strengthened INDIRECT
    // pattern must catch it.
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg24-gate-obfuscated-'));
    try {
      const dst = path.join(tmp, 'infrastructure');
      copyInfra(dst);
      const outputs = path.join(dst, 'outputs.tf');
      const planted =
        '\noutput "ai_obfuscated" {\n  value     = azurerm_application_insights.main[format("%s_%s","connection","string")]\n  sensitive = true\n}\n';
      // Guard the premise: the obfuscated form does NOT contain the literal token
      // the old grep looked for, so a token-only scan would have passed.
      expect(planted).not.toContain('connection_string');
      fs.appendFileSync(outputs, planted);
      const { code, out } = runGate(dst);
      expect(code).not.toBe(0);
      expect(out).toMatch(/no secret outputs/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('FAILS on a string-literal-index output that spells a secret fragment', () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mg24-gate-strindex-'));
    try {
      const dst = path.join(tmp, 'infrastructure');
      copyInfra(dst);
      const outputs = path.join(dst, 'outputs.tf');
      fs.appendFileSync(
        outputs,
        '\noutput "ai_str_index" {\n  value     = azurerm_application_insights.main["primary_key"]\n  sensitive = true\n}\n'
      );
      const { code, out } = runGate(dst);
      expect(code).not.toBe(0);
      expect(out).toMatch(/no secret outputs/);
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  it('STILL PASSES the committed non-secret outputs that use numeric index / string endpoints', () => {
    // Regression guard: the strengthened INDIRECT pattern must NOT flag legit
    // `.identity[0].principal_id` numeric indexing or endpoint string
    // interpolations. The committed tree already exercises both, so a clean run
    // proves no false positive was introduced.
    const { code } = runGate(INFRA);
    expect(code).toBe(0);
  });
});

describe('MG-24 S1: the fail-closed plan/state inspection walks real VALUES (tf-plan-secret-inspection.sh)', () => {
  const INSPECT = path.join(INFRA, 'scripts', 'tf-plan-secret-inspection.sh');
  const IKEY = '11111111-1111-1111-1111-111111111111';
  const FOREIGN_IKEY = '99999999-9999-9999-9999-999999999999';

  function runInspect(arg: string): { code: number; out: string } {
    return runInspectWith('bash', arg);
  }

  // Run the gate under an explicit shell so the SAME plan can be exercised under
  // dash (`/bin/sh`) as well as bash — the MG-24 portability regression.
  function runInspectWith(shell: string, arg: string): { code: number; out: string } {
    try {
      const out = execFileSync(shell, [INSPECT, arg], { encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  function writePlan(obj: unknown): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg24-inspect-'));
    const file = path.join(dir, 'plan.json');
    fs.writeFileSync(file, JSON.stringify(obj));
    return file;
  }

  /** A structurally valid `terraform show -json` plan carrying an AI resource + a Function App. */
  function planWith(connString: string, opts?: { localAuthDisabled?: boolean }): unknown {
    return {
      format_version: '1.2',
      terraform_version: '1.9.0',
      planned_values: {
        root_module: {
          resources: [
            {
              address: 'azurerm_application_insights.main',
              type: 'azurerm_application_insights',
              name: 'main',
              values: {
                // Inverted attribute: local auth DISABLED (the safe default) is
                // `local_authentication_enabled: false` — azurerm v5 rename.
                local_authentication_enabled: !(opts?.localAuthDisabled ?? true),
                instrumentation_key: IKEY,
              },
            },
            {
              // MG-24 Flex revision: the app is now azurerm_function_app_flex_consumption.
              // The inspection's app_settings sink walk matches it via the
              // `function_app` type substring, so the accepted-residual / foreign-ikey
              // behaviour is exercised on the real shipped resource shape.
              address: 'module.functions.azurerm_function_app_flex_consumption.main',
              type: 'azurerm_function_app_flex_consumption',
              name: 'main',
              values: {
                app_settings: { APPLICATIONINSIGHTS_CONNECTION_STRING: connString },
              },
            },
          ],
        },
      },
    };
  }

  // Finding 1 (HIGH): FAIL-CLOSED on empty / malformed / wrong-shape valid JSON.
  it.each([
    ['empty object {}', '{}'],
    ['empty array []', '[]'],
    ['wrong-shape object', '{"foo":"bar"}'],
  ])('FAILS CLOSED (nonzero) on %s — no vacuous PASS', (_label, json) => {
    const file = writePlan(JSON.parse(json));
    const { code, out } = runInspect(file);
    expect(code).not.toBe(0);
    expect(out).toMatch(/cannot inspect: unrecognized\/empty terraform JSON/);
  });

  it('FAILS CLOSED (nonzero) on a missing input file', () => {
    const { code, out } = runInspect(path.join(os.tmpdir(), 'mg24-nope-does-not-exist.json'));
    expect(code).not.toBe(0);
    expect(out).toMatch(/input not found/);
  });

  it('PASSES a real plan with the accepted-AI residual (managed ikey, local_authentication_enabled=false)', () => {
    const connString = `InstrumentationKey=${IKEY};IngestionEndpoint=https://x.in.applicationinsights.azure.com/`;
    const { code, out } = runInspect(writePlan(planWith(connString)));
    expect(code).toBe(0);
    expect(out).toMatch(/accepted App Insights residual/);
  });

  it('FAILS on a planted credential in resource_changes[].change.after', () => {
    const plan = {
      format_version: '1.2',
      resource_changes: [
        {
          type: 'azurerm_function_app_flex_consumption',
          address: 'azurerm_function_app_flex_consumption.main',
          change: {
            after: {
              app_settings: { COSMOSDB: 'AccountEndpoint=https://x/;AccountKey=SECRETKEY==' },
            },
          },
        },
      ],
    };
    const { code, out } = runInspect(writePlan(plan));
    expect(code).not.toBe(0);
    expect(out).toMatch(/prohibited credential VALUE/);
  });

  it('FAILS on a credential planted in an output', () => {
    const plan = {
      format_version: '1.2',
      planned_values: { root_module: { resources: [] } },
      output_changes: { leak: { after: 'AccountKey=abc123==;EndpointSuffix=core.windows.net' } },
    };
    const { code, out } = runInspect(writePlan(plan));
    expect(code).not.toBe(0);
    expect(out).toMatch(/prohibited credential VALUE/);
  });

  // Finding 2 (MEDIUM): the AI exception is BOUND to the managed resource's ikey.
  it('FAILS on a lookalike full AI connection string carrying a FOREIGN ikey (not a managed-resource ikey)', () => {
    // Same accepted shape (InstrumentationKey=…;IngestionEndpoint=…) and local
    // auth disabled — but the embedded ikey is NOT one of the plan's own
    // azurerm_application_insights instrumentation_key values. That is a foreign
    // connection string, not the accepted residual, and must be a VIOLATION.
    const foreign = `InstrumentationKey=${FOREIGN_IKEY};IngestionEndpoint=https://evil.example.com/`;
    const { code, out } = runInspect(writePlan(planWith(foreign)));
    expect(code).not.toBe(0);
    expect(out).toMatch(/is NOT one of the plan\/state's managed azurerm_application_insights/);
  });

  // MG-24 corrective: PORTABLE-SHELL regression. The gate previously used
  // bash-4-only `${1,,}` in ikey_is_managed; on macOS's default bash 3.2 (and
  // silently under dash) that raised `bad substitution`, broke the managed-ikey
  // comparison, and let a FOREIGN/lookalike connection string slip through as
  // accepted — a FAIL-OPEN AI-binding check on any host without bash 4+. The
  // gate is now strict POSIX sh; these guard that it neither uses the offending
  // constructs NOR regresses when run under dash (`/bin/sh`).
  describe('runs identically under dash (`sh`) — no bash-4-only / bash-only constructs', () => {
    const src = fs.readFileSync(INSPECT, 'utf8');
    // Scan CODE only: the header comment legitimately NAMES the forbidden
    // constructs (`${v,,}`, `<<<`, …) while documenting why they were removed, so
    // a raw scan would false-positive on the prose. Drop `#`-comment lines first.
    const code = src
      .split('\n')
      .filter(line => !/^\s*#/.test(line))
      .join('\n');

    it('source is free of bash-4-only / non-portable constructs', () => {
      // No ${v,,} / ${v^^} case modification (bash 4+ -> "bad substitution" on 3.2).
      expect(code).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/);
      expect(code).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^\}/);
      // No here-strings (<<<) and no process substitution (< <( ... )) — neither
      // is available under dash.
      expect(code).not.toMatch(/<<</);
      expect(code).not.toMatch(/<\s*<\(/);
      // No associative arrays.
      expect(code).not.toMatch(/declare\s+-A/);
      // Sanity: the case-insensitive lowercasing helper the fix relies on IS present.
      expect(src).toMatch(/tr '\[:upper:\]' '\[:lower:\]'/);
    });

    it('parses cleanly under dash (`sh -n`) — no syntax errors', () => {
      // `sh -n <script>` exits 0 on valid POSIX syntax without executing it.
      let code = 0;
      let out = '';
      try {
        out = execFileSync('sh', ['-n', INSPECT], { encoding: 'utf8' });
      } catch (e) {
        const err = e as { status?: number; stderr?: string };
        code = err.status ?? 1;
        out = err.stderr ?? '';
      }
      expect(code).toBe(0);
      expect(out).not.toMatch(/bad substitution|syntax error/i);
    });

    it('under `sh` (dash): fails closed on empty {} and a foreign-ikey lookalike, accepts the managed residual', () => {
      // Empty object -> fail-closed, no vacuous PASS.
      const empty = runInspectWith('sh', writePlan({}));
      expect(empty.code).not.toBe(0);
      expect(empty.out).not.toMatch(/bad substitution/i);

      // Managed residual -> PASS (0). This is the exact case the old bad-sub bug
      // could not reach correctly on a non-bash-4 shell.
      const okConn = `InstrumentationKey=${IKEY};IngestionEndpoint=https://x.in.applicationinsights.azure.com/`;
      const accepted = runInspectWith('sh', writePlan(planWith(okConn)));
      expect(accepted.code).toBe(0);
      expect(accepted.out).toMatch(/accepted App Insights residual/);
      expect(accepted.out).not.toMatch(/bad substitution/i);

      // Foreign/lookalike ikey -> VIOLATION (nonzero), NOT fail-open.
      const foreignConn = `InstrumentationKey=${FOREIGN_IKEY};IngestionEndpoint=https://evil.example.com/`;
      const foreignRun = runInspectWith('sh', writePlan(planWith(foreignConn)));
      expect(foreignRun.code).not.toBe(0);
      expect(foreignRun.out).toMatch(
        /is NOT one of the plan\/state's managed azurerm_application_insights/
      );
      expect(foreignRun.out).not.toMatch(/bad substitution/i);
    });
  });
});

describe('MG-24 azapi storage fix: the fail-closed gate accepts a shared-key-DISABLED azapi account and rejects a re-enabled one (item 4)', () => {
  // The Functions host storage account is now an azapi_resource
  // (Microsoft.Storage/storageAccounts) created over the ARM control plane, so the
  // shared-key-disabled invariant lives in the azapi body's
  // properties.allowSharedKeyAccess — NOT the former azurerm
  // shared_access_key_enabled attribute. These specs make that gate behaviour
  // durable in CI (nx test api-interfaces): the committed run-flex-secret-gate
  // fixtures are otherwise only exercised by a shell harness CI does not invoke.
  const INSPECT = path.join(INFRA, 'scripts', 'tf-plan-secret-inspection.sh');
  const FIXTURES = path.join(INFRA, 'scripts', 'fixtures');
  const RUNNER = path.join(FIXTURES, 'run-flex-secret-gate-fixtures.sh');
  const fixture = (name: string): string => path.join(FIXTURES, name);

  function run(shell: string, args: string[]): { code: number; out: string } {
    try {
      const out = execFileSync(shell, args, { encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('EXITS 0 on the azapi-account-accepted fixture (body.properties.allowSharedKeyAccess=false)', () => {
    const { code, out } = run('bash', [INSPECT, fixture('flex-plan-accepted.json')]);
    expect(code).toBe(0);
    // The azapi Microsoft.Storage/storageAccounts account is POSITIVELY accepted
    // (not merely un-flagged) because its body disables shared key.
    expect(out).toMatch(/accepted azapi storage account/);
    expect(out).toMatch(/allowSharedKeyAccess=false/);
    expect(out).toMatch(/PASS — no prohibited credential VALUE/);
  });

  it('FAILS CLOSED (nonzero) on an allowSharedKeyAccess=true azapi account fixture', () => {
    const { code, out } = run('bash', [INSPECT, fixture('flex-plan-reenabled-shared-key.json')]);
    expect(code).not.toBe(0);
    expect(out).toMatch(
      /azapi Microsoft\.Storage\/storageAccounts body does NOT set allowSharedKeyAccess=false/
    );
    expect(out).toMatch(/DO NOT APPLY/);
  });

  it('the two fixtures encode the MUTATION under test — false (accepted) vs true (rejected) — so the assertion is non-vacuous', () => {
    // The accepted and re-enabled fixtures carry the SAME azapi
    // Microsoft.Storage/storageAccounts resource; the load-bearing difference is the
    // one boolean the gate keys on. Proving both the false and the true body reach
    // opposite verdicts is the mutation-check that the accept path is not always-green.
    const accepted = fs.readFileSync(fixture('flex-plan-accepted.json'), 'utf8');
    const reenabled = fs.readFileSync(fixture('flex-plan-reenabled-shared-key.json'), 'utf8');
    expect(accepted).toMatch(/"type":\s*"Microsoft\.Storage\/storageAccounts@/);
    expect(reenabled).toMatch(/"type":\s*"Microsoft\.Storage\/storageAccounts@/);
    expect(accepted).toMatch(/"allowSharedKeyAccess":\s*false/);
    expect(reenabled).toMatch(/"allowSharedKeyAccess":\s*true/);
  });

  it('the re-enabled azapi account also fails closed under dash (`sh`) — no bad-substitution fail-open', () => {
    const { code, out } = run('sh', [INSPECT, fixture('flex-plan-reenabled-shared-key.json')]);
    expect(code).not.toBe(0);
    expect(out).not.toMatch(/bad substitution/i);
    expect(out).toMatch(
      /azapi Microsoft\.Storage\/storageAccounts body does NOT set allowSharedKeyAccess=false/
    );
  });

  it('the committed fixture runner drives every flex/azapi gate case green (bash + sh)', () => {
    const { code, out } = run('bash', [RUNNER]);
    expect(code).toBe(0);
    expect(out).toMatch(/all fixtures behaved as expected/);
    // The two azapi-account cases are present in the run.
    expect(out).toMatch(/flex-plan-accepted\.json: exit 0 as expected/);
    expect(out).toMatch(/flex-plan-reenabled-shared-key\.json: nonzero \(\d+\) as expected/);
    // The new site_config AI-residual cases are present too (positive + negatives).
    expect(out).toMatch(
      /flex-plan-siteconfig-localauth-enabled\.json: nonzero \(\d+\) as expected/
    );
    expect(out).toMatch(/flex-plan-siteconfig-noncred\.json: nonzero \(\d+\) as expected/);
  });
});

describe('MG-24 second-plan no-op: the gate accepts the App Insights conn string in the Flex site_config (native field) under the same coupling', () => {
  // MG-24 item 1 moved the App Insights connection string from a Function App
  // app_setting to the Flex resource's NATIVE
  // site_config.application_insights_connection_string field (so the app plans as
  // a no-op — the Flex provider reflects the conn string into that native field).
  // The fail-closed gate (item 4) now accepts the AI conn string in site_config
  // under the SAME coupled invariant it uses for app_settings — and still hard-
  // fails a foreign ikey, a non-AI credential, or local auth ENABLED.
  const INSPECT = path.join(INFRA, 'scripts', 'tf-plan-secret-inspection.sh');
  const FIXTURES = path.join(INFRA, 'scripts', 'fixtures');
  const fixture = (name: string): string => path.join(FIXTURES, name);

  function run(shell: string, args: string[]): { code: number; out: string } {
    try {
      const out = execFileSync(shell, args, { encoding: 'utf8' });
      return { code: 0, out };
    } catch (e) {
      const err = e as { status?: number; stdout?: string; stderr?: string };
      return { code: err.status ?? 1, out: `${err.stdout ?? ''}${err.stderr ?? ''}` };
    }
  }

  it('ACCEPTS (exit 0) the managed AI conn string in site_config under local-auth-disabled', () => {
    const { code, out } = run('bash', [INSPECT, fixture('flex-plan-accepted.json')]);
    expect(code).toBe(0);
    // Positively accepted (not merely un-flagged), and specifically on the
    // site_config path — the app_settings sink no longer carries the conn string.
    expect(out).toMatch(/accepted App Insights residual/);
    expect(out).toMatch(/site_config/);
    expect(out).toMatch(/PASS — no prohibited credential VALUE/);
  });

  it('the accepted fixture is the real post-apply shape: AI conn string in site_config, NOT app_settings', () => {
    const doc = fs.readFileSync(fixture('flex-plan-accepted.json'), 'utf8');
    const flex = JSON.parse(doc).planned_values.root_module.child_modules[0].resources.find(
      (r: { type: string }) => r.type === 'azurerm_function_app_flex_consumption'
    );
    expect(flex.values.site_config[0].application_insights_connection_string).toMatch(
      /InstrumentationKey=.*IngestionEndpoint=/
    );
    expect(Object.keys(flex.values.app_settings)).not.toContain(
      'APPLICATIONINSIGHTS_CONNECTION_STRING'
    );
  });

  it('FAILS CLOSED on the managed AI conn string in site_config when local auth is ENABLED (coupled invariant)', () => {
    const { code, out } = run('bash', [
      INSPECT,
      fixture('flex-plan-siteconfig-localauth-enabled.json'),
    ]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/in site_config WITHOUT local_authentication_enabled=false/);
  });

  it('FAILS CLOSED on a NON-AI connection string (AccountKey) planted in site_config', () => {
    const { code, out } = run('bash', [INSPECT, fixture('flex-plan-siteconfig-noncred.json')]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/prohibited credential VALUE/);
  });

  it('FAILS CLOSED on a FOREIGN-ikey lookalike AI conn string in site_config', () => {
    const { code, out } = run('bash', [INSPECT, fixture('flex-plan-siteconfig-key.json')]);
    expect(code).not.toBe(0);
    expect(out).toMatch(/is NOT one of the plan\/state's managed azurerm_application_insights/);
  });

  it('all four site_config cases behave identically under dash (`sh`) — no fail-open', () => {
    expect(run('sh', [INSPECT, fixture('flex-plan-accepted.json')]).code).toBe(0);
    expect(
      run('sh', [INSPECT, fixture('flex-plan-siteconfig-localauth-enabled.json')]).code
    ).not.toBe(0);
    expect(run('sh', [INSPECT, fixture('flex-plan-siteconfig-noncred.json')]).code).not.toBe(0);
    const foreign = run('sh', [INSPECT, fixture('flex-plan-siteconfig-key.json')]);
    expect(foreign.code).not.toBe(0);
    expect(foreign.out).not.toMatch(/bad substitution/i);
  });
});

describe('MG-24 second-plan no-op: Cosmos indexing + budget window are reconciled to Azure canonical form', () => {
  it('no Cosmos container declares the /"_etag"/? excluded_path (Azure returns none — it forced a perpetual diff)', () => {
    const cosmos = stripComments(read('modules/cosmos-db/main.tf'));
    // The _etag system exclusion is not persisted by Azure, so declaring it made
    // every plan re-add it. It must be absent from the config now.
    expect(cosmos).not.toMatch(/excluded_path/);
    expect(cosmos).not.toMatch(/_etag/);
  });

  it('Cosmos diag setting uses concrete metric categories Requests+SLI (Azure expands AllMetrics, forcing a perpetual diff)', () => {
    const mon = stripComments(read('modules/monitoring/main.tf'));
    // Isolate the cosmos_db diagnostic-setting resource block so this assertion
    // does not pick up the AllMetrics blocks on the other (cleanly round-tripping)
    // diag settings (signalr/iot_hub/function_app).
    const block = mon.match(
      /resource\s+"azurerm_monitor_diagnostic_setting"\s+"cosmos_db"\s*\{[\s\S]*?\n\}/
    )?.[0];
    expect(block).toBeDefined();
    // Azure expands AllMetrics for a Cosmos account into Requests + SLI and reports
    // those back, so ["AllMetrics"] never matches and updates in-place every plan.
    expect(block).toMatch(/enabled_metric\s*\{\s*category\s*=\s*"Requests"\s*\}/);
    expect(block).toMatch(/enabled_metric\s*\{\s*category\s*=\s*"SLI"\s*\}/);
    // NEGATIVE — the AllMetrics pseudo-category (the cause of the drift) is gone.
    expect(block).not.toMatch(/enabled_metric\s*\{\s*category\s*=\s*"AllMetrics"\s*\}/);
  });

  it('both consumption budgets set an EXPLICIT end_date (Azure defaults it, forcing a replace when omitted)', () => {
    const mon = stripComments(read('modules/monitoring/main.tf'));
    // A time_period that omits end_date lets Azure default it to start+10y and
    // then a replace (delete+create) fires every plan. Assert an explicit end_date.
    const endDates = (mon.match(/end_date\s*=/g) ?? []).length;
    expect(endDates).toBeGreaterThanOrEqual(2); // RG budget + subscription budget
    // The end_date is derived deterministically from the persisted time_static
    // anchor (+10y), NOT wall-clock — no timestamp() drift may reappear.
    expect(mon).toMatch(/budget_end_date\s*=/);
    expect(mon).not.toMatch(/timestamp\(/);
  });
});
