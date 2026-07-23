# Azure Functions Module for MeatGeek V2 — FLEX CONSUMPTION hosting (MG-24)
#
# Hosting model (MG-24, 2026-07-23): a SINGLE Flex Consumption model runs BOTH
# dev and prod, replacing the inherited Y1(dev)/EP1(prod) split. Flex is viable
# on the pinned azurerm v4.81.0 (no provider upgrade) and RESOLVES the Y1
# MI-storage apply failure: Flex deploys the package from an MI-authenticated
# BLOB container (not an Azure Files content share that requires a shared key),
# so the functions storage account can keep shared_access_key_enabled=false.
#
# Flex still requires a service plan — but of SKU "FC1" (the Flex Consumption
# plan), NOT Y1/EP1. `azurerm_function_app_flex_consumption.service_plan_id` is a
# REQUIRED argument in the pinned provider schema, so the plan resource is kept
# (repurposed to FC1) rather than removed.
#
# Security posture (MG-24 S1/S2 — carried 1:1 from the former linux_function_app):
#   * The Function App runs under a SYSTEM-ASSIGNED MANAGED IDENTITY. Runtime
#     access to Cosmos / Storage / Event Hub (IoT telemetry) / SignalR is
#     identity-based (RBAC + non-secret endpoints) — NO connection strings or
#     primary keys are placed in app settings or Terraform state.
#   * Deployment storage is identity-based: storage_authentication_type =
#     "SystemAssignedIdentity" against a blobContainer on the functions storage
#     account, which KEEPS allowSharedKeyAccess=false — so no
#     storage_account_access_key is written to state and no shared key can leak.
#     BOTH the storage account AND its deployment container are created via azapi
#     over the ARM CONTROL PLANE, because the azurerm_storage_account resource
#     itself performs shared-key storage DATA-PLANE reads that 403 on a shared-key-
#     disabled account with storage_use_azuread unset (MG-24 operational fix).
#   * Application Insights ingestion is identity-based (AAD): the managed
#     identity is granted 'Monitoring Metrics Publisher' on the App Insights
#     resource (root module) and the host authenticates telemetry via
#     APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD. The FULL
#     TF-managed connection string (InstrumentationKey included, as Microsoft
#     requires) is placed in app settings, but the ikey CANNOT authenticate
#     ingestion because the AI resource sets local_authentication_enabled=false
#     (AAD-only). This residual is safe ONLY while local auth stays disabled —
#     enforced by the pre-apply secret-inspection gate. See the MG-24 ADR.
#   * CORS is explicit per-environment (no wildcard). App Service Authentication
#     is FAIL-CLOSED: the module refuses to deploy (plan precondition) unless an
#     Entra identity provider is configured, so an anonymous Function App can
#     never be shipped; once configured every request is validated at the
#     platform layer (Return401 on no/invalid token) before any function runs.

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    # azapi creates BOTH the Functions storage ACCOUNT
    # (Microsoft.Storage/storageAccounts) and the Flex deployment BLOB container
    # (Microsoft.Storage/storageAccounts/blobServices/containers) over the ARM
    # CONTROL PLANE — same pattern the native-otlp module uses for its DCR.
    # Control-plane creation sidesteps the storage DATA-plane entirely: neither the
    # account's OWN reads (a data-plane azurerm_storage_account performs
    # blob-service/queue/share reads that 403 on a shared-key-disabled account) nor
    # the container create needs a Storage Blob Data role or storage_use_azuread on
    # the apply principal against an account THIS apply creates. See the MG-24 ADR.
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }
}

locals {
  # Globally-unique storage account name. Storage account names must be 3-24
  # chars, lowercase alphanumeric only (no hyphens). Like the Cosmos account
  # name, this is derived from a subscription-scoped hash (passed in by the
  # root as var.storage_account_name) so a greenfield apply cannot collide with
  # a pre-existing account anywhere in Azure. The substr() is a defensive cap.
  functions_storage_account_name = substr(var.storage_account_name, 0, 24)

  # Name of the Flex deployment-package blob container (target of the OneDeploy
  # package ZIP). Held as a local so the container resource, the Function App's
  # storage_container_endpoint, the app-deploy role-assignment scope, and the
  # module output all reference ONE source of truth.
  deployment_container_name = "deployment-package"
}

# Storage account for Azure Functions — created via azapi over the ARM CONTROL
# PLANE (Microsoft.Storage/storageAccounts@2023-05-01), NOT azurerm_storage_account.
#
# WHY azapi and not azurerm (MG-24 operational fix — 403'd twice on live Azure):
# the azurerm_storage_account RESOURCE performs its OWN storage DATA-PLANE reads —
# a blob-service-availability poll on create, and queue/blob/share property reads
# on refresh — using SHARED-KEY auth by default. With allowSharedKeyAccess=false
# and the provider's storage_use_azuread deliberately unset, those reads 403
# (KeyBasedAuthenticationNotPermitted): the original Y1 apply AND the Flex
# destroy-refresh both failed here, on the account's OWN reads (not the container).
# Creating the account over the ARM control plane — the same pattern as the
# deployment container below and the native-otlp DCR — performs NO storage
# data-plane operation at plan/apply for ANY terraform principal, so the account
# can keep shared key disabled with no storage_use_azuread and no pre-apply
# data-plane grant for the apply or CI identities. See the MG-24 ADR.
#
# Identity-based storage: allowSharedKeyAccess=false so no account key can be used
# (or leak into state). The Function App's managed identity is granted the
# Blob/Queue data roles below and reads the package ZIP from the blob deployment
# container at runtime over that identity
# (storage_authentication_type=SystemAssignedIdentity on the flex resource).
resource "azapi_resource" "functions_storage" {
  type      = "Microsoft.Storage/storageAccounts@2023-05-01"
  name      = local.functions_storage_account_name
  parent_id = var.resource_group_id
  location  = var.location
  tags      = var.tags

  body = {
    # Standard_LRS StorageV2 — carried 1:1 from the former azurerm resource
    # (account_tier="Standard" + account_replication_type="LRS" => Standard_LRS;
    # azurerm's default account_kind was StorageV2).
    sku = {
      name = "Standard_LRS"
    }
    kind = "StorageV2"
    properties = {
      # min_tls_version = "TLS1_2" on the former azurerm resource.
      minimumTlsVersion = "TLS1_2"
      # shared_access_key_enabled = false — the secrets-out-of-state invariant,
      # now expressed in the azapi body. No account key can authenticate or leak.
      allowSharedKeyAccess = false
      # Private storage — no anonymous blob access; HTTPS only.
      allowBlobPublicAccess    = false
      supportsHttpsTrafficOnly = true
    }
  }
}

# Deployment package container (Flex Consumption). Flex reads the deployed
# package ZIP from THIS blob container, authenticated by the Function App's
# managed identity (storage_authentication_type=SystemAssignedIdentity below).
#
# Created via azapi over the ARM CONTROL PLANE
# (Microsoft.Storage/storageAccounts/blobServices/containers) rather than
# azurerm_storage_container, which is a storage DATA-PLANE operation. That
# distinction is load-bearing here (MG-24 red 2f5154 / b08ced): the account sets
# shared_access_key_enabled=false, and it is CREATED BY THIS APPLY — so a
# data-plane container create would require the apply principal to already hold a
# Storage Blob Data role on an account that does not exist until mid-apply (a
# same-apply chicken-and-egg that 403s, or forces a fragile pre-apply data-plane
# grant + RBAC-propagation wait). The control-plane create needs only the
# resource-management permission the apply principal already has (Contributor on
# the RG), so the FIRST apply is executable with NO manual pre-grant and the
# provider no longer needs the storage_use_azuread data-plane switch.
#
# publicAccess = "None": private container, never anonymously readable — the
# package ZIP is fetched by the Function App's managed identity, so no public
# blob access is ever needed.
resource "azapi_resource" "deployment_container" {
  type      = "Microsoft.Storage/storageAccounts/blobServices/containers@2023-05-01"
  name      = local.deployment_container_name
  parent_id = "${azapi_resource.functions_storage.id}/blobServices/default"

  body = {
    properties = {
      publicAccess = "None"
    }
  }
}

# App Service Plan for Azure Functions — FLEX CONSUMPTION (SKU FC1). Flex
# requires a plan (service_plan_id is a required argument on the flex resource),
# but it is the Flex plan, not Y1/EP1. Billing is per-execution GB-s with
# scale-to-zero when always_ready=0 (dev) and an always-ready baseline (prod).
resource "azurerm_service_plan" "functions" {
  name                = "${var.resource_prefix}-func-plan"
  resource_group_name = var.resource_group_name
  location            = var.location
  os_type             = "Linux"
  sku_name            = "FC1"

  tags = var.tags
}

# Azure Function App — Flex Consumption
resource "azurerm_function_app_flex_consumption" "main" {
  # Globally-unique name: the FDQN <name>.azurewebsites.net must be unique across
  # all of Azure, so the subscription-derived global_suffix is appended (same
  # suffix shared with IoT Hub / Event Hubs / SignalR). "-func-" + 12 hex chars
  # keeps the name inside the 60-char Function App limit.
  name                = "${var.resource_prefix}-func-${var.global_suffix}"
  resource_group_name = var.resource_group_name
  location            = var.location
  service_plan_id     = azurerm_service_plan.functions.id

  # Node 24 runtime (matches the Flex runtime and the API's engines.node).
  runtime_name    = "node"
  runtime_version = "24"

  # MI-authenticated blob deployment storage — NO Azure Files content share, NO
  # shared key. This is what resolves the Y1 MI-storage 403 and lets the account
  # stay shared_access_key_enabled=false. The endpoint is a plain blob-container
  # URL (no SAS / no AccountKey), so it carries no secret into state.
  storage_container_type = "blobContainer"
  # Plain blob-container URL built from the account name (no SAS / no AccountKey),
  # so it carries no secret into state. The account is created via azapi (control
  # plane) and exposes no azurerm primary_blob_endpoint attribute, so the endpoint
  # is composed from the deterministic account name + the deployment container name.
  storage_container_endpoint  = "https://${local.functions_storage_account_name}.blob.core.windows.net/${local.deployment_container_name}"
  storage_authentication_type = "SystemAssignedIdentity"

  # Flex scale knobs (per-env via tfvars). instance_memory_in_mb + maximum
  # concurrency bound the per-instance footprint and the horizontal ceiling.
  instance_memory_in_mb  = var.instance_memory_in_mb
  maximum_instance_count = var.maximum_instance_count

  # The deployment blob container must exist before the app binds to it. The
  # endpoint above is a plain URL string (not a reference to the container
  # resource), so declare the ordering explicitly.
  depends_on = [azapi_resource.deployment_container]

  # System-assigned managed identity — the runtime credential for all
  # identity-based service access (deployment storage, Cosmos, Event Hub, SignalR).
  identity {
    type = "SystemAssigned"
  }

  # Always-ready instances. dev sets always_ready=0 => NO always_ready block =>
  # scale-to-zero (~$0 idle). prod sets always_ready>=1 => a warm HTTP baseline
  # so the first request after idle is not cold. "http" is the built-in group
  # covering all HTTP-triggered functions.
  dynamic "always_ready" {
    for_each = var.always_ready > 0 ? [1] : []
    content {
      name           = "http"
      instance_count = var.always_ready
    }
  }

  # Runtime configuration. Every external service is wired identity-based via a
  # NON-SECRET endpoint (the `__`-suffixed settings the Functions host resolves
  # against the app's managed identity). No connection strings / primary keys.
  # Flex-deprecated settings (WEBSITE_NODE_DEFAULT_VERSION, WEBSITE_CONTENT*,
  # WEBSITE_RUN_FROM_PACKAGE, WEBSITE_TIME_ZONE) are intentionally NOT set — Flex
  # manages the runtime version (runtime_version) and package mount itself.
  app_settings = {
    "FUNCTIONS_WORKER_RUNTIME" = "node"

    # Application Insights — identity-based (AAD) telemetry ingestion. The
    # managed identity is granted 'Monitoring Metrics Publisher' on the App
    # Insights resource (root module); Authorization=AAD makes the host
    # authenticate with an AAD token. The FULL connection string (InstrumentationKey
    # included) is required by Microsoft as the destination-resource identifier
    # even under Entra-only ingestion — but the ikey CANNOT authenticate because
    # local_authentication_enabled=false on the AI resource. This ikey-in-state
    # residual is safe ONLY while local auth stays disabled; the pre-apply
    # secret-inspection gate enforces that coupling.
    "APPLICATIONINSIGHTS_AUTHENTICATION_STRING" = "Authorization=AAD"
    "APPLICATIONINSIGHTS_CONNECTION_STRING"     = var.application_insights_connection_string
    "APPLICATIONINSIGHTS_SAMPLING_PERCENTAGE"   = "50"

    # Cosmos DB — identity-based. Endpoint is non-secret; data-plane access is
    # granted via the Cosmos SQL role assignment in the root module.
    "COSMOSDB__accountEndpoint" = var.cosmos_account_endpoint

    # IoT telemetry (Event Hubs-compatible) — identity-based. The fully-qualified
    # namespace is non-secret; the identity is granted Azure Event Hubs Data
    # Receiver in the root module.
    "IOTHUB_EVENTS__fullyQualifiedNamespace" = var.eventhub_namespace_fqdn

    # SignalR — identity-based. Service URI is non-secret; the identity is
    # granted SignalR Service Owner in the root module.
    "AzureSignalRConnectionString__serviceUri" = var.signalr_service_uri
  }

  site_config {
    # Explicit per-environment allowed origins (no wildcard). Empty list =>
    # no cross-origin browser access is permitted. support_credentials stays
    # false unless a cookie/credential design requires it.
    cors {
      allowed_origins     = var.cors_allowed_origins
      support_credentials = false
    }
  }

  # App Service Authentication (Easy Auth). FAIL-CLOSED.
  #
  # Azure requires auth_settings_v2 to declare AT LEAST ONE identity provider —
  # an "authentication required but no provider" block is not a valid plan. So we
  # cannot express default-deny as an empty provider list. Instead the ENTIRE
  # auth_settings_v2 block is present ONLY when the Entra API registration is
  # configured (var.auth_active_directory_client_id set), and the precondition
  # below REFUSES the plan when it is not. Net effect: it is impossible to deploy
  # this Function App without platform-enforced authentication — an unconfigured
  # deployment fails closed at plan time rather than silently shipping an
  # anonymous app. No business endpoint (e.g. startCook) is ever reachable
  # anonymously regardless of its per-function authLevel.
  #
  # When configured, this is API/bearer-token VALIDATION only — NOT an interactive
  # sign-in flow: no client secret is set (client-secret-free bearer validation),
  # allowed_audiences carries the exact API App ID URI (the API registration), and
  # the token store is disabled (no token-at-rest).
  #
  # allowed_applications validates the CALLING CLIENT's appid/azp claim, NOT the API
  # registration — so it is set to var.auth_allowed_client_app_ids (the smoke-test
  # client: the Azure CLI public client by default, or a dedicated dev client), each
  # of which the dev API registration pre-authorizes for access_as_user. A token
  # minted by any OTHER client is rejected at the platform layer. (Binding the API
  # registration's OWN client id here would be wrong — the API is never the caller.)
  dynamic "auth_settings_v2" {
    for_each = var.auth_active_directory_client_id == "" ? [] : [1]
    content {
      auth_enabled           = true
      require_authentication = true
      unauthenticated_action = "Return401"

      active_directory_v2 {
        client_id            = var.auth_active_directory_client_id
        tenant_auth_endpoint = "https://login.microsoftonline.com/${var.auth_active_directory_tenant_id}/v2.0"
        allowed_audiences    = var.auth_allowed_audiences
        allowed_applications = var.auth_allowed_client_app_ids
        # Bearer-validation-only API: no interactive caller, so suppress the
        # WWW-Authenticate challenge. An unauthenticated request gets a clean 401
        # (unauthenticated_action = Return401) with no browser sign-in challenge.
        www_authentication_disabled = true
      }

      login {
        token_store_enabled = false
      }
    }
  }

  tags = var.tags

  lifecycle {
    # Fail-closed: refuse to deploy without platform authentication. Converts the
    # (otherwise cryptic) "auth_settings_v2 needs >=1 provider" provider error
    # into an explicit, testable guard. Populate auth_active_directory_client_id
    # from the dev API Entra registration (see the MG-24 bootstrap runbook's
    # token-acquisition path) before applying.
    precondition {
      condition     = var.auth_active_directory_client_id != ""
      error_message = "Function App Easy Auth is not configured: set auth_active_directory_client_id to the dev API Entra registration client id (MG-24 runbook). An empty value cannot produce a valid auth_settings_v2 (Azure requires >=1 identity provider), so deployment is refused fail-closed rather than shipping an anonymous Function App."
    }
    # Easy Auth is all-or-nothing here: a client_id alone yields an INCOMPLETE
    # active_directory_v2 block. tenant_auth_endpoint (built from tenant_id) fixes
    # the token issuer, and allowed_audiences fixes which audience is accepted; if
    # either is empty, bearer validation rejects EVERY token (wrong issuer / no
    # allowed audience) and the step-9 authenticated smoke test fails. So once auth
    # is enabled (client_id != ""), require both fail-closed too.
    precondition {
      condition     = var.auth_active_directory_client_id == "" || var.auth_active_directory_tenant_id != ""
      error_message = "Function App Easy Auth is incompletely configured: auth_active_directory_client_id is set but auth_active_directory_tenant_id is empty. tenant_auth_endpoint would point at an invalid issuer and bearer validation would reject every token. Set auth_active_directory_tenant_id to the dev API Entra tenant id (MG-24 runbook)."
    }
    precondition {
      condition     = var.auth_active_directory_client_id == "" || length(var.auth_allowed_audiences) > 0
      error_message = "Function App Easy Auth is incompletely configured: auth_active_directory_client_id is set but auth_allowed_audiences is empty. With no allowed audience, bearer validation rejects every token. Set auth_allowed_audiences to the dev API's accepted audience(s) (MG-24 runbook)."
    }
    # allowed_applications validates the CALLING CLIENT's appid/azp claim, but Azure
    # Easy Auth treats an EMPTY allowed_applications as NO calling-client restriction:
    # any client holding a valid token for an allowed audience is accepted, silently
    # disabling the stated calling-client guarantee. So once auth is enabled require a
    # NON-EMPTY allowed_client_app_ids fail-closed too.
    precondition {
      condition     = var.auth_active_directory_client_id == "" || length(var.auth_allowed_client_app_ids) > 0
      error_message = "Function App Easy Auth is incompletely configured: auth_active_directory_client_id is set but auth_allowed_client_app_ids is empty. Azure Easy Auth treats an empty allowed_applications as no calling-client restriction, so ANY client holding a token for an allowed audience could call the API, contradicting the bearer-validation-only contract. Set auth_allowed_client_app_ids to the calling client app id(s) — the smoke-test client (the Azure CLI public client 04b07795-8ddb-461a-bbee-02f9e1bf7b46 by default, or a dedicated dev client) (MG-24 runbook)."
    }
  }
}

# --- Identity-based access grants for the Function App managed identity ------
# Deployment + host storage: the Flex runtime needs Blob (package deployment /
# host) and Queue (triggers/scaling) data-plane access on ITS OWN storage
# account. Scoped to the storage account only — least privilege. Storage Blob
# Data Owner covers reading the deployment package from the blob container under
# the app's managed identity (storage_authentication_type=SystemAssignedIdentity).
resource "azurerm_role_assignment" "functions_storage_blob" {
  scope                = azapi_resource.functions_storage.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = azurerm_function_app_flex_consumption.main.identity[0].principal_id
}

resource "azurerm_role_assignment" "functions_storage_queue" {
  scope                = azapi_resource.functions_storage.id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = azurerm_function_app_flex_consumption.main.identity[0].principal_id
}

# App-deployment identity → deployment-container write access (MG-24 item 4).
# Flex OneDeploy (func publish / `nx deploy api`) writes the package ZIP into the
# blob deployment container, so the SEPARATE app-deploy principal needs Blob Data
# write on THAT CONTAINER (in addition to its Website Contributor on the Function
# App granted in the root module). Scoped to the container alone — least
# privilege; it cannot touch other blobs on the account. Guarded by count so a
# bare `terraform validate`/plan with an empty app_deploy_principal_object_id
# still validates (the grant is skipped). The object id is the SP's OBJECT id,
# created by the bootstrap BEFORE this apply, so no apply-time principal is
# referenced and the graph stays acyclic.
resource "azurerm_role_assignment" "deploy_principal_deployment_container" {
  count                = var.app_deploy_principal_object_id != "" ? 1 : 0
  scope                = azapi_resource.deployment_container.id
  role_definition_name = "Storage Blob Data Contributor"
  principal_id         = var.app_deploy_principal_object_id
}
