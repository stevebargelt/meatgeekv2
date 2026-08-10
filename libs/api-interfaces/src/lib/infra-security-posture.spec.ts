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
import { execFileSync, spawnSync } from 'child_process';
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
      // The runtime is declared the Flex-native way.
      expect(live).toMatch(/runtime_name\s*=\s*"node"/);
      expect(live).toMatch(/runtime_version\s*=\s*"24"/);
    });

    it('wires HOST storage identity-based via the account-name form — no connection string, no service-URI variant (MG-58)', () => {
      // MG-58: this assertion used to be a blanket `not.toMatch(/AzureWebJobsStorage/)`
      // sitting alongside the Flex-forbidden classic settings above, on the false
      // premise that Flex configures the host's own storage for us. It does not.
      // Only DEPLOYMENT storage is configured by the flex resource's storage_*
      // arguments; HOST storage is a separate authentication surface on the same
      // account, and with no setting at all the host reported
      // azure.functions.webjobs.storage Unhealthy / AuthenticationFailed every ~30s.
      // The guard is NARROWED, not deleted: what must hold is a pair.
      //
      // POSITIVE — the identity-based account-name form is present and carries the
      // account NAME (not a credential), sourced from the module local rather than
      // a literal.
      expect(live).toMatch(
        /"AzureWebJobsStorage__accountName"\s*=\s*local\.functions_storage_account_name/
      );
      // NEGATIVE — the credential-carrying connection-string form stays forbidden.
      // `AzureWebJobsStorage` must appear ONLY as the `__accountName` key: a bare
      // assignment, or an `AzureWebJobsStorage = "..."`/`"AzureWebJobsStorage" = `
      // setting, would carry an account key or SAS into app_settings and state.
      expect(live).not.toMatch(/"?AzureWebJobsStorage"?\s*=/);
      // NEGATIVE — no service-URI variant. The account-name and service-URI forms
      // are ALTERNATIVES: the service-URI form is for sovereign clouds / custom or
      // private endpoints, and this account is on standard Azure DNS with no
      // private endpoint and no VNet integration anywhere in the stack. Publishing
      // both forms, or the wrong one, is its own defect.
      expect(live).not.toMatch(/AzureWebJobsStorage__(blob|queue|table)ServiceUri/);
      // Belt-and-braces on the "exactly one form" rule: enumerate every
      // AzureWebJobsStorage* key the module actually publishes and require the set
      // to be exactly the account-name form, so a variant nobody thought to name
      // cannot slip past the two negatives above.
      expect(live.match(/AzureWebJobsStorage[A-Za-z0-9_]*/g)).toEqual([
        'AzureWebJobsStorage__accountName',
      ]);
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

  // `status` and `signal` are carried alongside `code` so a failing assertion can
  // distinguish a real nonzero EXIT (a verdict the gate rendered) from a null
  // status — killed by a signal, or execFileSync never running the process at all.
  // Collapsing both into `code: 1` reports an environment failure as a gate verdict.
  function run(
    shell: string,
    args: string[]
  ): { code: number; out: string; status: number | null; signal: string | null } {
    try {
      const out = execFileSync(shell, args, { encoding: 'utf8' });
      return { code: 0, out, status: 0, signal: null };
    } catch (e) {
      const err = e as {
        status?: number | null;
        signal?: string | null;
        stdout?: string;
        stderr?: string;
        message?: string;
      };
      const captured = `${err.stdout ?? ''}${err.stderr ?? ''}`;
      return {
        code: err.status ?? 1,
        out: captured || (err.message ?? ''),
        status: err.status ?? null,
        signal: err.signal ?? null,
      };
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
    const r = run('bash', [RUNNER]);
    // Asserted as ONE object so a failure carries the harness log — which names
    // WHICH case failed under WHICH shell — instead of a bare "Expected 0 /
    // Received 1" that says nothing about the 32 checks behind it. `signal` and a
    // null `status` are asserted alongside so a runner killed by a signal (or one
    // execFileSync could not spawn) is not reported as a gate verdict.
    expect({
      case: 'run-flex-secret-gate-fixtures.sh',
      shell: 'bash',
      status: r.status,
      signal: r.signal,
      log: r.out,
    }).toEqual({
      case: 'run-flex-secret-gate-fixtures.sh',
      shell: 'bash',
      status: 0,
      signal: null,
      log: expect.stringContaining('all fixtures behaved as expected'),
    });
    const out = r.out;
    // The two azapi-account cases are present in the run.
    expect(out).toMatch(/flex-plan-accepted\.json: exit 0 as expected/);
    expect(out).toMatch(/flex-plan-reenabled-shared-key\.json: nonzero \(\d+\) as expected/);
    // The new site_config AI-residual cases are present too (positive + negatives).
    expect(out).toMatch(
      /flex-plan-siteconfig-localauth-enabled\.json: nonzero \(\d+\) as expected/
    );
    expect(out).toMatch(/flex-plan-siteconfig-noncred\.json: nonzero \(\d+\) as expected/);
  });

  it('does not accept an mktemp-failure result unless the PATH stub actually intercepted the gate call', () => {
    // The gate below deliberately emits the expected FATAL without calling mktemp.
    // This models a future unrelated early failure that would otherwise make the
    // environment case green while the stub had silently stopped intercepting.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-40-no-stub-'));
    const scripts = path.join(root, 'scripts');
    const copiedFixtures = path.join(scripts, 'fixtures');
    try {
      fs.mkdirSync(scripts, { recursive: true });
      fs.cpSync(FIXTURES, copiedFixtures, { recursive: true });
      fs.writeFileSync(
        path.join(scripts, 'tf-plan-secret-inspection.sh'),
        `#!/bin/sh
if [ "${'${PATH}'}" = /nonexistent ]; then
  echo 'FATAL: jq is required' >&2
  exit 1
fi
case "${'$*'}" in
  *flex-plan-accepted.json*|*secret-gate-empty-resource-changes.json*) exit 0 ;;
  *) echo 'FATAL: cannot create a temp file' >&2; exit 1 ;;
esac
`
      );
      fs.chmodSync(path.join(scripts, 'tf-plan-secret-inspection.sh'), 0o755);

      const r = run('bash', [path.join(copiedFixtures, 'run-flex-secret-gate-fixtures.sh')]);
      expect({ status: r.status, signal: r.signal, log: r.out }).toEqual({
        status: 1,
        signal: null,
        log: expect.stringContaining('BOTH the stub interception marker and temp-file FATAL'),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('refuses the PATH-stub test when the gate names mktemp by absolute path', () => {
    // This exercises the guard's failure branch instead of merely scanning the
    // real gate. The fake gate otherwise supplies all fixture verdicts the
    // harness expects, so the observed failure is specifically the anti-vacuity
    // guard rather than an unrelated fixture failure.
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mg-40-absolute-mktemp-'));
    const scripts = path.join(root, 'scripts');
    const copiedFixtures = path.join(scripts, 'fixtures');
    try {
      fs.mkdirSync(scripts, { recursive: true });
      fs.cpSync(FIXTURES, copiedFixtures, { recursive: true });
      fs.writeFileSync(
        path.join(scripts, 'tf-plan-secret-inspection.sh'),
        `#!/bin/sh
# /bin/mktemp is intentionally named to prove the harness refuses this shape.
if [ "${'${PATH}'}" = /nonexistent ]; then
  echo 'FATAL: jq is required' >&2
  exit 1
fi
case "${'$*'}" in
  *flex-plan-accepted.json*|*secret-gate-empty-resource-changes.json*) exit 0 ;;
  *) exit 1 ;;
esac
`
      );
      fs.chmodSync(path.join(scripts, 'tf-plan-secret-inspection.sh'), 0o755);

      const r = run('bash', [path.join(copiedFixtures, 'run-flex-secret-gate-fixtures.sh')]);
      expect({ status: r.status, signal: r.signal, log: r.out }).toEqual({
        status: 1,
        signal: null,
        log: expect.stringContaining('names mktemp by ABSOLUTE path'),
      });
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('keeps signaled and failed-to-spawn runners distinct from a nonzero gate verdict', () => {
    const signaled = run('sh', ['-c', 'kill -TERM $$']);
    const spawnFailed = run('mg-40-command-does-not-exist', ['-c', 'exit 1']);

    expect({ code: signaled.code, status: signaled.status, signal: signaled.signal }).toEqual({
      code: 1,
      status: null,
      signal: 'SIGTERM',
    });
    expect({
      code: spawnFailed.code,
      status: spawnFailed.status,
      signal: spawnFailed.signal,
    }).toEqual({
      code: 1,
      status: null,
      signal: null,
    });
    expect(spawnFailed.out).toMatch(/mg-40-command-does-not-exist/);
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

/**
 * MG-23 — automated dev GitOps reconciliation (CI-run).
 *
 * Terminology, used precisely throughout: MG-24 = Terraform reconciliation
 * (operator-run); MG-23 = automated dev GitOps reconciliation (CI-run).
 *
 * MG-23 hands a CI job an apply identity that is Contributor scoped ONLY to
 * meatgeek-v2-<env>-rg plus CONDITIONED Role Based Access Control Administrator on
 * that same resource group. Three properties of the Terraform GRAPH have to hold
 * for that to be both APPLIABLE and SAFE, and none of them are visible in a
 * `terraform validate`:
 *
 *   1. Every azurerm_role_assignment declares principal_type = "ServicePrincipal".
 *      The apply identity's ABAC condition matches on PrincipalType; an ABAC clause
 *      over an attribute the request never SENDS does not match, so an omitted
 *      principal_type fails the condition SHUT and denies every apply that touches
 *      a role assignment. The remedy is to send the attribute — NEVER to loosen the
 *      condition with an `!(Exists ...) OR ...` tolerance, which is a one-field
 *      bypass any caller could take by simply omitting the field.
 *   2. No role assignment is scoped to a SUBSCRIPTION. "No identity inside
 *      meatgeek-v2-<env>-rg holds a role outside it" is the load-bearing invariant
 *      the whole resource-group boundary depends on.
 *   3. The subscription-scoped budget is count-guarded. It is the one resource in
 *      the stack scoped outside the resource group, and unguarded it makes the
 *      entire configuration unappliable by a resource-group-scoped identity.
 *
 * These are GRAPH regression guards. The genuinely out-of-resource-group grants
 * (the bootstrap-managed identities) are invisible to an HCL scan and are asserted
 * separately in apps/infrastructure/bootstrap/bootstrap.test.sh.
 */
describe('MG-23: the Terraform graph is appliable by a resource-group-scoped CI identity', () => {
  /** Every .tf file under the infra tree, excluding vendored/generated dirs. */
  function tfFiles(): string[] {
    const found: string[] = [];
    const skip = new Set(['.terraform', 'node_modules', '.nx']);
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) {
          if (!skip.has(entry.name)) walk(path.join(dir, entry.name));
        } else if (entry.name.endsWith('.tf')) {
          found.push(path.join(dir, entry.name));
        }
      }
    };
    walk(INFRA);
    return found;
  }

  interface RoleAssignment {
    file: string;
    name: string;
    body: string;
  }

  /**
   * Every `resource "azurerm_role_assignment" "<name>" { ... }` block in the tree,
   * COUNT-DISABLED ONES INCLUDED. Count-disabled resources are still part of the
   * graph — the native-otlp and app-deploy guards flip — so a scan that skipped
   * them would under-enumerate exactly the way deriving the set from a
   * `terraform plan` does.
   */
  function roleAssignments(): RoleAssignment[] {
    const out: RoleAssignment[] = [];
    for (const file of tfFiles()) {
      const live = stripComments(fs.readFileSync(file, 'utf8'));
      const re = /resource\s+"azurerm_role_assignment"\s+"([^"]+)"\s*\{([\s\S]*?)\n\}/g;
      let m: RegExpExecArray | null;
      while ((m = re.exec(live)) !== null) {
        out.push({ file: path.relative(INFRA, file), name: m[1], body: m[2] });
      }
    }
    return out;
  }

  it('finds every role assignment in the graph (9 blocks over 8 distinct roles)', () => {
    // Premise guard: if this scan silently matched nothing, the two assertions
    // below would be vacuously green. Pin the shape the MG-23 allowlist is derived
    // from — 9 azurerm_role_assignment blocks over 8 DISTINCT role definition
    // names (Monitoring Metrics Publisher is granted twice, at different scopes:
    // App Insights for the Function App, the DCR for the OTLP collector).
    const found = roleAssignments();
    expect(found.length).toBe(9);

    const roles = found.map(r => r.body.match(/role_definition_name\s*=\s*"([^"]+)"/)?.[1] ?? '');
    expect(roles).not.toContain('');
    expect([...new Set(roles)].sort()).toEqual(
      [
        'Azure Event Hubs Data Receiver',
        'Azure Event Hubs Data Sender',
        'Monitoring Metrics Publisher',
        'SignalR Service Owner',
        'Storage Blob Data Contributor',
        'Storage Blob Data Owner',
        'Storage Queue Data Contributor',
        'Website Contributor',
      ].sort()
    );
  });

  it('EVERY azurerm_role_assignment declares principal_type = "ServicePrincipal" (the ABAC condition fails SHUT without it)', () => {
    const offenders = roleAssignments()
      .filter(r => !/principal_type\s*=\s*"ServicePrincipal"/.test(r.body))
      .map(r => `${r.file}:${r.name}`);
    expect(offenders).toEqual([]);
  });

  it('NO azurerm_role_assignment is scoped to a subscription (the resource-group boundary depends on it)', () => {
    // A subscription-scoped grant is both unappliable by the resource-group-scoped
    // apply identity AND a breach of the invariant that no identity inside the
    // workload resource group holds a role outside it. Catch a literal
    // /subscriptions/... scope that never narrows to a resource group, and the
    // data-source forms that resolve to the subscription itself.
    const offenders: string[] = [];
    for (const r of roleAssignments()) {
      const scope = r.body.match(/scope\s*=\s*(.+)/)?.[1]?.trim() ?? '';
      const literalSubscriptionScope =
        /^"\/subscriptions\//.test(scope) && !/\/resourceGroups\//i.test(scope);
      const subscriptionDataSource =
        /data\.azurerm_subscription[\w.]*\.(id|subscription_id)\b/.test(scope) ||
        /data\.azurerm_client_config\.[\w]+\.subscription_id/.test(scope);
      if (literalSubscriptionScope || subscriptionDataSource) {
        offenders.push(`${r.file}:${r.name} -> ${scope}`);
      }
    }
    expect(offenders).toEqual([]);
  });

  it('the SUBSCRIPTION-scoped budget is count-guarded and defaults OFF', () => {
    // The one resource scoped outside the workload resource group. Unguarded, an
    // identity that is Contributor on meatgeek-v2-dev-rg alone cannot apply this
    // configuration AT ALL — it fails partway with AuthorizationFailed, leaving
    // partial state. Resolved in the GRAPH, never by widening the identity
    // (widening breaks the closed-escalation-path precondition).
    const mon = stripComments(read('modules/monitoring/main.tf'));
    const block = mon.match(
      /resource\s+"azurerm_consumption_budget_subscription"\s+"credit_budget"\s*\{[\s\S]*?\n\}/
    )?.[0];
    expect(block).toBeDefined();
    expect(block).toMatch(/count\s*=\s*var\.manage_subscription_budget\s*\?\s*1\s*:\s*0/);

    // The flag defaults OFF in BOTH the module and the root, so the default graph
    // — which is what CI applies — carries no subscription-scoped resource.
    const monVars = stripComments(read('modules/monitoring/variables.tf'));
    expect(monVars).toMatch(
      /variable\s+"manage_subscription_budget"\s*\{[\s\S]*?type\s*=\s*bool[\s\S]*?default\s*=\s*false/
    );
    const rootVars = stripComments(read('variables.tf'));
    expect(rootVars).toMatch(
      /variable\s+"manage_subscription_budget"\s*\{[\s\S]*?type\s*=\s*bool[\s\S]*?default\s*=\s*false/
    );

    // Both environments opt OUT explicitly rather than leaning on the default, so
    // the boundary is visible where an operator edits it.
    expect(read('environments/dev.tfvars')).toMatch(/^manage_subscription_budget\s*=\s*false/m);
    expect(read('environments/prod.tfvars')).toMatch(/^manage_subscription_budget\s*=\s*false/m);

    // The RESOURCE-GROUP budget is untouched — it stays the primary spend control.
    expect(mon).toMatch(/resource\s+"azurerm_consumption_budget_resource_group"\s+"main"/);
  });

  it('the azurerm provider does NOT register resource providers (a subscription-scope write at configure time)', () => {
    // The azurerm ~>4.0 default registers RPs at SUBSCRIPTION scope while the
    // provider is being configured — before any resource is planned — which a
    // resource-group-scoped identity cannot do. MG-24 never hit this because it
    // applied as the operator. RP registration becomes an explicit bootstrap /
    // operator precondition instead.
    const live = stripComments(read('main.tf'));
    expect(live).toMatch(/resource_provider_registrations\s*=\s*"none"/);
  });

  it('the three out-of-band-persistence Activity Log alerts are wired to the action group and scoped to the RG', () => {
    // The MG-23 final drift plan proves convergence of Terraform-MANAGED
    // CONTROL-PLANE resources ONLY. These three writes are the persistence paths it
    // structurally cannot see, so they get detective controls. The action-group
    // wiring is asserted HERE rather than in the module's terraform test because
    // the action group's id is unknown-at-plan under a mock provider — the tftest
    // can only prove an action block exists, not what it points at.
    const mon = stripComments(read('modules/monitoring/main.tf'));
    const expected: Array<[string, string]> = [
      ['role_assignment_write', 'Microsoft.Authorization/roleAssignments/write'],
      ['user_assigned_identity_write', 'Microsoft.ManagedIdentity/userAssignedIdentities/write'],
      [
        'cosmos_sql_role_assignment_write',
        'Microsoft.DocumentDB/databaseAccounts/sqlRoleAssignments/write',
      ],
    ];
    for (const [name, operation] of expected) {
      const block = mon.match(
        new RegExp(
          `resource\\s+"azurerm_monitor_activity_log_alert"\\s+"${name}"\\s*\\{[\\s\\S]*?\\n\\}`
        )
      )?.[0];
      expect(block).toBeDefined();
      expect(block).toContain(`operation_name = "${operation}"`);
      expect(block).toMatch(/category\s*=\s*"Administrative"/);
      // Scoped to the workload RESOURCE GROUP id — never the subscription.
      expect(block).toMatch(/scopes\s*=\s*\[var\.resource_group_id\]/);
      // Wired to the action group: an alert nobody receives is not a control.
      expect(block).toMatch(/action_group_id\s*=\s*azurerm_monitor_action_group\.main\.id/);
    }

    // The root threads the resource-group ID (an alert scope is a resource id, not
    // a name), and the module declares the input.
    expect(stripComments(read('main.tf'))).toMatch(
      /resource_group_id\s*=\s*azurerm_resource_group\.main\.id/
    );
    expect(stripComments(read('modules/monitoring/variables.tf'))).toMatch(
      /variable\s+"resource_group_id"/
    );
  });

  // NOTE — the "no `!(Exists ...)` ABAC tolerance" guard deliberately does NOT
  // live here. An ABAC condition is emitted by
  // apps/infrastructure/bootstrap/bootstrap.sh, never by Terraform, so a scan of
  // the .tf sources for that shape can only ever be vacuously green (and, run over
  // raw text, it false-positives on the prose in root main.tf that documents WHY
  // the tolerance is forbidden). The real assertion belongs on the emitted
  // condition, in bootstrap.test.sh.
});

/**
 * MG-58 guard 4 — the LIVE host-storage gate.
 *
 * WHY THIS SUITE EXISTS. Every guard this repo had before MG-58 asserted the
 * credential-carrying scalar `AzureWebJobsStorage` setting was absent from the
 * CONFIGURATION — where it was genuinely, permanently absent — and nothing
 * asserted anything about the DEPLOYED SITE. The pinned azurerm provider
 * composes and writes that key itself on every Function App create and update
 * and routes it out of app_settings on read, so it is not representable in HCL,
 * in the plan document or in state. Config-clean and site-dirty therefore
 * coexisted behind eleven green checks, and a correct-but-shadowed setting
 * shipped. `scripts/assert-live-host-storage.sh` is the ONLY gate in the system
 * on which that defect is representable at all, which makes its own properties
 * load-bearing in a way an ordinary script's are not.
 *
 * PORTABILITY IS A SECURITY PROPERTY HERE, NOT A STYLE NOTE. A gate that ERRORS
 * on one shell while still reaching a PASS is FAIL-OPEN, and this repo has
 * already shipped exactly that bug once: the bash-4-only `${1,,}` in
 * tf-plan-secret-inspection.sh raised "bad substitution" on macOS's default bash
 * 3.2 and let a foreign connection string through as accepted. The construct
 * scan below is the same list the dash-portability suite above applies to that
 * gate, and it is here for the same reason.
 *
 * This suite is deliberately NOT a duplicate of
 * scripts/fixtures/run-live-host-storage-fixtures.sh. That harness proves guard
 * 3 by mutating FIXTURES; this one pins the GATE — its portability, its
 * fail-closed posture, its exact key matching — and proves its own
 * non-vacuity by mutating the SCRIPT and requiring the mutants to go green
 * where the real gate goes red. Both run on every push; the harness runs in the
 * credentialless validate-infrastructure job, this in the lint-and-test matrix.
 */
describe('MG-58 guard 4: the live host-storage gate (assert-live-host-storage.sh)', () => {
  const GATE = path.join(INFRA, 'scripts', 'assert-live-host-storage.sh');
  const FIXTURES = path.join(INFRA, 'scripts', 'fixtures');

  /** What a caller resolves from `terraform output -raw` and passes as --account-name. */
  const ACCOUNT = 'mgv2dev13bd19e9f03d';
  const SCALAR_KEY = 'AzureWebJobsStorage';
  const IDENTITY_KEY = 'AzureWebJobsStorage__accountName';
  /** Present only in fixture VALUES, never in fixture names — names are printed by design. */
  const SENTINEL = 'MGSENTINELDONOTLOG';

  /** Both shells the gate must behave IDENTICALLY under. `/bin/sh` is dash here. */
  const SHELLS = ['bash', 'sh'];

  type Setting = { name: unknown; slotSetting?: unknown; value?: unknown };
  type Run = { code: number; stdout: string; stderr: string; both: string };

  /**
   * Run the gate (or a mutant of it) under an explicit shell. stdout and stderr
   * are captured SEPARATELY — merging them would make the redaction cases below
   * unable to tell which stream a leaked value reached, and the workflow reads
   * the `SCALAR_KEY_PRESENT=` marker off stdout specifically.
   *
   * `input` always defaults to '' rather than being left unset: an empty stdin
   * pipe makes a gate that unexpectedly reads stdin fail closed instead of
   * hanging the test run against jest's inherited terminal.
   */
  function runGate(
    shell: string,
    args: string[],
    opts: { input?: string; gate?: string } = {}
  ): Run {
    const r = spawnSync(shell, [opts.gate ?? GATE, ...args], {
      encoding: 'utf8',
      input: opts.input ?? '',
    });
    const stdout = r.stdout ?? '';
    const stderr = r.stderr ?? '';
    return { code: r.status ?? 1, stdout, stderr, both: `${stdout}${stderr}` };
  }

  function fixturePath(name: string): string {
    return path.join(FIXTURES, name);
  }

  function fixtureJson(name: string): Setting[] {
    return JSON.parse(fs.readFileSync(fixturePath(name), 'utf8'));
  }

  /** Write a generated settings document to a fresh temp dir; returns its path. */
  function writeDoc(content: string): string {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg58-live-'));
    const file = path.join(dir, 'appsettings.json');
    fs.writeFileSync(file, content);
    return file;
  }

  function writeSettings(settings: Setting[]): string {
    return writeDoc(JSON.stringify(settings));
  }

  const src = fs.readFileSync(GATE, 'utf8');
  /**
   * Scan CODE only. The gate's header comment legitimately NAMES every forbidden
   * construct (`${v,,}`, `<<<`, `[[ ]]`, …) while documenting why it is absent,
   * so a raw scan would false-positive on the prose that exists to keep the
   * constructs out. Same treatment the inspection gate's suite applies.
   */
  const code = src
    .split('\n')
    .filter(line => !/^\s*#/.test(line))
    .join('\n');

  describe('portability: runs identically under bash 3.2, bash 5 and dash — a shell-specific error would be FAIL-OPEN', () => {
    it('source is free of bash-4-only / bash-only constructs', () => {
      // ${v,,} / ${v^^} case modification: bash 4+. On bash 3.2 this is a "bad
      // substitution" — the exact shape of the fail-open already shipped once.
      expect(code).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*,,\}/);
      expect(code).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\^\^\}/);
      // Here-strings and process substitution: bash/ksh only, absent in dash.
      expect(code).not.toMatch(/<<</);
      expect(code).not.toMatch(/<\s*<\(/);
      expect(code).not.toMatch(/<\(/);
      // Associative arrays: bash 4+, and `local -A` is the sneakier spelling.
      expect(code).not.toMatch(/declare\s+-A/);
      expect(code).not.toMatch(/local\s+-A/);
      // `[[ ]]` is a bash/ksh keyword; dash has only `[`.
      expect(code).not.toMatch(/\[\[/);
      // Arrays of any kind, incl. `arr=( ... )` / ${arr[@]}.
      expect(code).not.toMatch(/\$\{[A-Za-z_][A-Za-z0-9_]*\[[@*]\]\}/);
    });

    it('enables `set -o pipefail` only behind a support probe (dash would abort on it)', () => {
      // dash has no pipefail: an unguarded `set -o pipefail` prints "Illegal
      // option -o pipefail" and perturbs the exit code — a gate whose exit code
      // is decided by its own option handling is not a gate.
      const unguarded = code
        .split('\n')
        .filter(line => /set\s+-o\s+pipefail/.test(line))
        .filter(line => !/^\s*if\s+\(set -o pipefail\) 2>\/dev\/null; then/.test(line));
      expect(unguarded).toEqual([]);
      expect(code).toMatch(/if \(set -o pipefail\) 2>\/dev\/null; then set -o pipefail; fi/);
    });

    it('parses cleanly under dash (`sh -n`) — no syntax errors', () => {
      let status = 0;
      let out = '';
      try {
        out = execFileSync('sh', ['-n', GATE], { encoding: 'utf8' });
      } catch (e) {
        const err = e as { status?: number; stderr?: string };
        status = err.status ?? 1;
        out = err.stderr ?? '';
      }
      expect(status).toBe(0);
      expect(out).not.toMatch(/bad substitution|syntax error/i);
    });

    it.each(SHELLS)('under `%s`: the accept path is reached with no shell diagnostic', shell => {
      const run = runGate(shell, [
        '--account-name',
        ACCOUNT,
        fixturePath('live-appsettings-clean.json'),
      ]);
      expect(run.code).toBe(0);
      expect(run.stdout).toMatch(/PASS/);
      expect(run.both).not.toMatch(/bad substitution|not found|Illegal option|syntax error/i);
    });

    it.each(SHELLS)('under `%s`: the reject path is reached with no shell diagnostic', shell => {
      const run = runGate(shell, [
        '--account-name',
        ACCOUNT,
        fixturePath('live-appsettings-scalar-injected.json'),
      ]);
      expect(run.code).toBe(3);
      expect(run.both).not.toMatch(/bad substitution|Illegal option|syntax error/i);
    });
  });

  describe('fail-closed: an assertion that could not run is never a PASS', () => {
    // Every case here must exit 1, not merely nonzero. 3 is the REMEDIABLE
    // verdict the apply job answers by DELETING a setting; an unreadable or
    // malformed document must never route into that branch.
    describe.each(SHELLS)('under `%s`', shell => {
      it('a missing input path is FATAL, not "no scalar key found"', () => {
        const run = runGate(shell, [
          '--account-name',
          ACCOUNT,
          path.join(os.tmpdir(), 'mg58-does-not-exist.json'),
        ]);
        expect(run.code).toBe(1);
        expect(run.both).toMatch(/input not found/);
        expect(run.stdout).not.toMatch(/PASS/);
      });

      it('an EMPTY document is FATAL — an az call that produced nothing is not a clean site', () => {
        const run = runGate(shell, ['--account-name', ACCOUNT, writeDoc('')]);
        expect(run.code).toBe(1);
        expect(run.both).toMatch(/no input \(empty/);
        expect(run.stdout).not.toMatch(/PASS/);
      });

      it('EMPTY STDIN is FATAL — the shape the workflow actually uses when a pipe dies', () => {
        const run = runGate(shell, ['--account-name', ACCOUNT], { input: '' });
        expect(run.code).toBe(1);
        expect(run.both).toMatch(/no input \(empty stdin\)/);
        expect(run.stdout).not.toMatch(/PASS/);
      });

      it('invalid JSON is FATAL, and the unparseable document is NOT echoed (it carries values)', () => {
        const run = runGate(shell, [
          '--account-name',
          ACCOUNT,
          writeDoc(`[{"name":"AzureWebJobsStorage","value":"AccountKey=${SENTINEL}"`),
        ]);
        expect(run.code).toBe(1);
        expect(run.both).toMatch(/not valid JSON/);
        expect(run.both).not.toContain(SENTINEL);
      });

      it.each([
        ['an object', '{}', 'object'],
        [
          'a wrapper object with a value array',
          '{"value":[{"name":"AzureWebJobsStorage__accountName"}]}',
          'object',
        ],
        ['a string', '"nope"', 'string'],
        ['a number', '123', 'number'],
      ])(
        'WRONG-TYPED document (%s) is FATAL — it parses, and would yield a vacuous PASS',
        (_label, json, typeName) => {
          const run = runGate(shell, ['--account-name', ACCOUNT, writeDoc(json)]);
          expect(run.code).toBe(1);
          expect(run.both).toMatch(new RegExp(`top-level is '${typeName}'`));
          expect(run.stdout).not.toMatch(/PASS/);
        }
      );

      it('a top-level `null` document is FATAL — rejected a stage earlier, still exit 1', () => {
        // `null` is syntactically valid JSON but `jq -e .` treats it as FALSY and
        // exits nonzero, so the gate rejects it at the parse check rather than at
        // the shape check. Different message, same verdict — pinned explicitly so
        // that an implementer "fixing" the parse check to tolerate a falsy
        // document cannot do so without noticing this document must still die.
        const run = runGate(shell, ['--account-name', ACCOUNT, writeDoc('null')]);
        expect(run.code).toBe(1);
        expect(run.both).toMatch(/FATAL/);
        expect(run.stdout).not.toMatch(/PASS/);
      });

      it('an EMPTY ARRAY is FATAL — a live Function App always carries settings', () => {
        const run = runGate(shell, ['--account-name', ACCOUNT, writeDoc('[]')]);
        expect(run.code).toBe(1);
        expect(run.both).toMatch(/EMPTY array/);
        expect(run.stdout).not.toMatch(/PASS/);
      });

      it('MALFORMED entries poison the whole document — the key comparisons ARE the assertion', () => {
        const run = runGate(shell, [
          '--account-name',
          ACCOUNT,
          fixturePath('live-appsettings-malformed.json'),
        ]);
        expect(run.code).toBe(1);
        expect(run.both).toMatch(/not objects with a string 'name'/);
        expect(run.stdout).not.toMatch(/PASS/);
      });

      it('a MISSING --account-name is FATAL — a gate with no expectation cannot pass', () => {
        const run = runGate(shell, [fixturePath('live-appsettings-clean.json')]);
        expect(run.code).toBe(1);
        expect(run.both).toMatch(/--account-name is required/);
        expect(run.stdout).not.toMatch(/PASS/);
      });

      it('an EMPTY --account-name is FATAL — the same vacuous-PASS hole, spelled differently', () => {
        const run = runGate(shell, [
          '--account-name',
          '',
          fixturePath('live-appsettings-clean.json'),
        ]);
        expect(run.code).toBe(1);
        expect(run.both).toMatch(/--account-name is required/);
        expect(run.stdout).not.toMatch(/PASS/);
      });

      it('the identity form ABSENT from the live site is a violation, not an all-clear', () => {
        const run = runGate(shell, [
          '--account-name',
          ACCOUNT,
          fixturePath('live-appsettings-accountname-missing.json'),
        ]);
        expect(run.code).toBe(1);
        expect(run.both).toMatch(new RegExp(`VIOLATION \\[${IDENTITY_KEY}\\]`));
        expect(run.stdout).not.toMatch(/PASS/);
      });

      it('the identity form pointing at the WRONG account is a violation — presence is not the assertion', () => {
        const run = runGate(shell, [
          '--account-name',
          ACCOUNT,
          fixturePath('live-appsettings-accountname-mismatch.json'),
        ]);
        expect(run.code).toBe(1);
        expect(run.both).toMatch(/observed=\[REDACTED\]/);
        expect(run.stdout).not.toMatch(/PASS/);
      });
    });
  });

  describe('key matching is EXACT in both directions', () => {
    // A prefix/substring/case-folded match would make this gate either
    // permanently RED (the identity form read as the scalar form) or permanently
    // VACUOUS (a scalar-only document read as satisfying the account-name
    // requirement). Both directions are pinned, under both shells.
    describe.each(SHELLS)('under `%s`', shell => {
      it(`${IDENTITY_KEY} does NOT trip the scalar check`, () => {
        // Non-vacuity first: the accepted document really does carry a key that
        // a prefix match would catch. Without this, a fixture edit that dropped
        // the identity form would leave this case green and meaningless.
        const clean = fixtureJson('live-appsettings-clean.json');
        expect(clean.filter(e => String(e.name).startsWith(SCALAR_KEY)).map(e => e.name)).toEqual([
          IDENTITY_KEY,
        ]);

        const run = runGate(shell, [
          '--account-name',
          ACCOUNT,
          fixturePath('live-appsettings-clean.json'),
        ]);
        expect(run.code).toBe(0);
        expect(run.stdout).not.toMatch(/SCALAR_KEY_PRESENT/);
        expect(run.stdout).toMatch(/PASS/);
      });

      it('other AzureWebJobsStorage* variants do NOT trip the scalar check — they are reported as NOTES', () => {
        const doc = [
          { name: 'WEBSITE_HEALTHCHECK_MAXPINGFAILURES', slotSetting: false, value: '10' },
          { name: IDENTITY_KEY, slotSetting: false, value: ACCOUNT },
          {
            name: 'AzureWebJobsStorage__blobServiceUri',
            slotSetting: false,
            value: `https://${ACCOUNT}.blob.core.windows.net`,
          },
          { name: 'AzureWebJobsStorageSomethingElse', slotSetting: false, value: 'x' },
        ];
        const run = runGate(shell, ['--account-name', ACCOUNT, writeSettings(doc)]);
        expect(run.code).toBe(0);
        expect(run.stdout).not.toMatch(/SCALAR_KEY_PRESENT/);
        expect(run.stdout).toMatch(/NOTE: additional AzureWebJobsStorage\* setting NAMES/);
        expect(run.stdout).toMatch(/AzureWebJobsStorage__blobServiceUri/);
      });

      it('the SCALAR key alone never satisfies the account-name requirement', () => {
        // The inverse conflation: a site carrying ONLY the broken form must be
        // reported as BOTH the shadowing defect AND a missing identity form —
        // never as "an AzureWebJobsStorage key is present, good enough".
        const doc = [
          { name: 'WEBSITE_HEALTHCHECK_MAXPINGFAILURES', slotSetting: false, value: '10' },
          {
            name: SCALAR_KEY,
            slotSetting: false,
            value: `DefaultEndpointsProtocol=https;AccountName=${ACCOUNT};AccountKey=;EndpointSuffix=core.windows.net`,
          },
        ];
        const run = runGate(shell, ['--account-name', ACCOUNT, writeSettings(doc)]);
        expect(run.code).toBe(3);
        expect(run.stdout).toContain(`SCALAR_KEY_PRESENT=${SCALAR_KEY}`);
        expect(run.both).toMatch(new RegExp(`VIOLATION \\[${IDENTITY_KEY}\\]`));
        expect(run.stdout).not.toMatch(/PASS/);
      });

      it('the exact scalar key present alongside a correct identity form is exit 3 (remediable), not 1', () => {
        // The apply job's bounded remediation keys off 3 specifically: it deletes
        // exactly this one key on exactly one app. If this verdict collapsed into
        // 1, a remediable defect would stop being remediated.
        const run = runGate(shell, [
          '--account-name',
          ACCOUNT,
          fixturePath('live-appsettings-scalar-injected.json'),
        ]);
        expect(run.code).toBe(3);
        expect(run.stdout).toContain(`SCALAR_KEY_PRESENT=${SCALAR_KEY}`);
        expect(run.both).toMatch(new RegExp(`VIOLATION \\[${SCALAR_KEY}\\]`));
        expect(run.stdout).not.toMatch(/PASS/);
      });
    });
  });

  describe('output hygiene: setting NAMES and fixed reasons, never VALUES', () => {
    // The document this gate consumes carries connection strings, and its own
    // stdout/stderr lands in a retained, broadly-readable CI log. Captured
    // SEPARATELY, not merged: "it did not leak to stdout" is not the claim.
    it.each(SHELLS)(
      'under `%s`: no setting VALUE reaches stdout or stderr on a rejecting run',
      shell => {
        const run = runGate(shell, [
          '--account-name',
          ACCOUNT,
          fixturePath('live-appsettings-sentinel.json'),
        ]);
        // The redaction claim is vacuous on a run that accepted — pin the reject.
        expect(run.code).toBe(3);
        expect(run.stdout).not.toContain(SENTINEL);
        expect(run.stderr).not.toContain(SENTINEL);
        // Names ARE printed by design, so the diagnostic surface is still there.
        expect(run.stdout).toContain(IDENTITY_KEY);
      }
    );

    it('the sentinel fixture hides its sentinels in VALUES only — otherwise the redaction cases are unprovable', () => {
      const doc = fixtureJson('live-appsettings-sentinel.json');
      expect(doc.length).toBeGreaterThan(0);
      expect(doc.filter(e => String(e.name).includes(SENTINEL))).toEqual([]);
      expect(doc.filter(e => String(e.value).includes(SENTINEL)).length).toBeGreaterThan(0);
    });
  });

  describe('the committed fixture pair is a genuine one-key mutation control', () => {
    // Guard 3 is proven by MUTATION, not by assertion. That proof is only worth
    // anything while the two documents differ by exactly the key under test: if
    // a later edit made them differ some other way, both exit codes would still
    // look right and the control would have silently stopped controlling. The
    // absence of a key is exactly what a PASS looks like, so nothing downstream
    // can notice this drift — only a direct comparison can.
    const clean = fixtureJson('live-appsettings-clean.json');
    const injected = fixtureJson('live-appsettings-scalar-injected.json');

    it('the injected document is the clean document PLUS exactly the scalar key', () => {
      expect(injected.filter(e => e.name !== SCALAR_KEY)).toEqual(clean);
      const added = injected.map(e => e.name).filter(n => !clean.some(c => c.name === n));
      expect(added).toEqual([SCALAR_KEY]);
      const removed = clean.map(e => e.name).filter(n => !injected.some(i => i.name === n));
      expect(removed).toEqual([]);
    });

    it('the clean document still carries the identity form equal to the expected account name', () => {
      const identity = clean.filter(e => e.name === IDENTITY_KEY);
      expect(identity).toHaveLength(1);
      expect(identity[0].value).toBe(ACCOUNT);
      expect(clean.filter(e => e.name === SCALAR_KEY)).toEqual([]);
    });

    it('the injected scalar value is the value observed live — the real defect, not a synthetic stand-in', () => {
      const scalar = injected.filter(e => e.name === SCALAR_KEY);
      expect(scalar).toHaveLength(1);
      expect(scalar[0].value).toBe(
        'DefaultEndpointsProtocol=https;AccountName=mgv2dev13bd19e9f03d;AccountKey=;EndpointSuffix=core.windows.net'
      );
      // The AccountKey field is EMPTY, and that is the whole point: this string
      // is a forensic fingerprint of provider injection, NOT a credential and
      // NOT a restore path. A fixture edit that put key material here would be
      // committing a secret to the repo.
      expect(scalar[0].value).toMatch(/AccountKey=;/);
    });
  });

  describe('the scalar key is matched in ANY capitalisation (App Service folds case on setting names)', () => {
    const CASE_FIXTURES = [
      ['lowercase', 'live-appsettings-scalar-lowercase.json'],
      ['uppercase', 'live-appsettings-scalar-uppercase.json'],
      ['mixedcase', 'live-appsettings-scalar-mixedcase.json'],
    ] as const;

    it.each(CASE_FIXTURES)(
      'the %s fixture is a ONE-KEY mutation of the clean document, spelled non-canonically',
      (_label, fixture) => {
        // Non-vacuity for the behavioural cases below: if one of these drifted
        // back to the canonical spelling it would silently become a duplicate of
        // live-appsettings-scalar-injected.json and prove nothing about case.
        const clean = fixtureJson('live-appsettings-clean.json');
        const variant = fixtureJson(fixture);

        const extra = variant.filter(e => !clean.some(c => String(c.name) === String(e.name)));
        expect(extra).toHaveLength(1);
        const addedName = String(extra[0].name);
        expect(addedName.toLowerCase()).toBe(SCALAR_KEY.toLowerCase());
        expect(addedName).not.toBe(SCALAR_KEY);

        // Nothing was removed either — the mutation is purely additive.
        expect(clean.filter(c => !variant.some(e => String(e.name) === String(c.name)))).toEqual(
          []
        );
        // The identity form survives, so the defect under test is the scalar
        // form SHADOWING a correct identity form, not a missing identity form.
        expect(variant.some(e => String(e.name) === IDENTITY_KEY)).toBe(true);
      }
    );

    describe.each(SHELLS)('under `%s`', shell => {
      it.each(CASE_FIXTURES)(
        'the %s scalar key is REJECTED into the one-key remediation branch',
        (_label, fixture) => {
          const run = runGate(shell, ['--account-name', ACCOUNT, fixturePath(fixture)]);
          // exit 3 specifically: the apply job remediates on 3, so a variant that
          // collapsed to 1 would be reported and then left on the site.
          expect(run.code).toBe(3);
          // The marker is spelled CANONICALLY even when the site is not — it is
          // the gate/workflow contract, and the management plane folds case, so
          // deleting the canonical name removes whichever spelling is live.
          expect(run.stdout).toContain(`SCALAR_KEY_PRESENT=${SCALAR_KEY}`);
          expect(run.stdout).not.toMatch(/PASS/);
        }
      );
    });
  });

  describe('non-vacuity, proven by mutating the GATE (not by asserting it works)', () => {
    /**
     * Copy the gate, apply one textual mutation, and require the MUTANT to reach
     * a verdict the real gate refuses. A green suite proves nothing unless the
     * assertions can be made to fail; these cases make them fail on demand, in
     * CI, every run. Each mutation asserts it actually applied before running,
     * so a rename upstream turns this red rather than silently vacuous.
     */
    function mutantOf(from: string, to: string): string {
      expect(src).toContain(from);
      const mutated = src.split(from).join(to);
      expect(mutated).not.toBe(src);
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mg58-mutant-'));
      const file = path.join(dir, 'assert-live-host-storage.sh');
      fs.writeFileSync(file, mutated, { mode: 0o755 });
      return file;
    }

    it('a gate whose scalar comparison cannot match ACCEPTS the injected document — so exit 3 is driven by that comparison', () => {
      const gate = mutantOf(
        'SCALAR_KEY="AzureWebJobsStorage"',
        'SCALAR_KEY="AzureWebJobsStorageThisNeverMatchesAnything"'
      );
      const mutant = runGate(
        'bash',
        ['--account-name', ACCOUNT, fixturePath('live-appsettings-scalar-injected.json')],
        { gate }
      );
      expect(mutant.code).toBe(0);
      expect(mutant.stdout).toMatch(/PASS/);

      // ...and the real gate, same document, rejects it. The pair is the proof.
      const real = runGate('bash', [
        '--account-name',
        ACCOUNT,
        fixturePath('live-appsettings-scalar-injected.json'),
      ]);
      expect(real.code).toBe(3);
    });

    it('a gate whose account-name comparison always reports MATCH ACCEPTS the mismatch document', () => {
      const gate = mutantOf('else "MISMATCH" end', 'else "MATCH" end');
      const mutant = runGate(
        'bash',
        ['--account-name', ACCOUNT, fixturePath('live-appsettings-accountname-mismatch.json')],
        { gate }
      );
      expect(mutant.code).toBe(0);

      const real = runGate('bash', [
        '--account-name',
        ACCOUNT,
        fixturePath('live-appsettings-accountname-mismatch.json'),
      ]);
      expect(real.code).toBe(1);
    });

    it('a gate that matches the scalar key by PREFIX goes RED on the clean site — why exactness is load-bearing', () => {
      // The other half of the conflation. A prefix match does not merely miss
      // things: it makes the gate permanently red on a correctly-configured
      // site, which is how a gate gets disabled and stops guarding anything.
      const gate = mutantOf(
        'select((.name | ascii_downcase) == $want) ] | length',
        'select((.name | ascii_downcase) | startswith($want)) ] | length'
      );
      const mutant = runGate(
        'bash',
        ['--account-name', ACCOUNT, fixturePath('live-appsettings-clean.json')],
        {
          gate,
        }
      );
      expect(mutant.code).toBe(3);

      const real = runGate('bash', [
        '--account-name',
        ACCOUNT,
        fixturePath('live-appsettings-clean.json'),
      ]);
      expect(real.code).toBe(0);
    });

    it('a CASE-SENSITIVE gate ACCEPTS a case-variant scalar key — the fail-open this fold closes', () => {
      // THE DEMONSTRATED DEFECT, pinned as a mutation so it cannot silently
      // return. App Service app-setting names are CASE-INSENSITIVE, so a site
      // carrying `AZUREWEBJOBSSTORAGE` with the empty-AccountKey connection
      // string is carrying the forbidden setting and the host resolves it ahead
      // of the identity form. Reverting the fold makes the gate report PASS on
      // exactly that document — which is what made the apply job take its clean
      // branch and never remediate.
      const gate = mutantOf(
        '($k | ascii_downcase) as $want\n  | [ .[] | select((.name | ascii_downcase) == $want) ] | length',
        '$k as $want\n  | [ .[] | select(.name == $want) ] | length'
      );
      for (const fixture of [
        'live-appsettings-scalar-lowercase.json',
        'live-appsettings-scalar-uppercase.json',
        'live-appsettings-scalar-mixedcase.json',
      ]) {
        const mutant = runGate('bash', ['--account-name', ACCOUNT, fixturePath(fixture)], { gate });
        expect({ fixture, code: mutant.code }).toEqual({ fixture, code: 0 });
        expect(mutant.stdout).toMatch(/PASS/);

        // ...and the real gate rejects the same document into the remediation
        // branch. The pair is the proof.
        const real = runGate('bash', ['--account-name', ACCOUNT, fixturePath(fixture)]);
        expect({ fixture, code: real.code }).toEqual({ fixture, code: 3 });
        expect(real.stdout).toContain(`SCALAR_KEY_PRESENT=${SCALAR_KEY}`);
      }
    });

    it('a gate whose structural validation is removed reports a vacuous PASS on `{}` — why fail-closed is asserted', () => {
      const gate = mutantOf(
        '[ "${top_type}" = "array" ] ||',
        '[ "${top_type}" = "array" ] || true ||'
      );
      const mutant = runGate('bash', ['--account-name', ACCOUNT, writeDoc('{}')], { gate });
      // The mutant sails past the shape check; whatever it then reports, it must
      // NOT be the real gate's fatal — that is the discrimination being proven.
      expect(mutant.both).not.toMatch(/expected the JSON 'array'/);

      const real = runGate('bash', ['--account-name', ACCOUNT, writeDoc('{}')]);
      expect(real.code).toBe(1);
      expect(real.both).toMatch(/expected the JSON 'array'/);
    });
  });
});
