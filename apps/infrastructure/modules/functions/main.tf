# Azure Functions Module for MeatGeek V2
#
# Security posture (MG-24 S1/S2):
#   * The Function App runs under a SYSTEM-ASSIGNED MANAGED IDENTITY. Runtime
#     access to Cosmos / Storage / Event Hub (IoT telemetry) / SignalR is
#     identity-based (RBAC + non-secret endpoints) — NO connection strings or
#     primary keys are placed in app settings or Terraform state.
#   * Host storage uses the managed identity (storage_uses_managed_identity),
#     so no storage_account_access_key is written to state.
#   * Application Insights ingestion is identity-based (AAD): the managed
#     identity is granted 'Monitoring Metrics Publisher' on the App Insights
#     resource (root module) and the host authenticates telemetry via
#     APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD. The FULL
#     TF-managed connection string (InstrumentationKey included, as Microsoft
#     requires) is placed in app settings, but the ikey CANNOT authenticate
#     ingestion because the AI resource sets local_authentication_disabled=true
#     (AAD-only). This residual is safe ONLY while local auth stays disabled —
#     enforced by the pre-apply secret-inspection gate. See the MG-24 ADR.
#   * CORS is explicit per-environment (no wildcard). App Service Authentication
#     is FAIL-CLOSED: the module refuses to deploy (plan precondition) unless an
#     Entra identity provider is configured, so an anonymous Function App can
#     never be shipped; once configured every request is validated at the
#     platform layer (Return401 on no/invalid token) before any function runs.

locals {
  # Globally-unique storage account name. Storage account names must be 3-24
  # chars, lowercase alphanumeric only (no hyphens). Like the Cosmos account
  # name, this is derived from a subscription-scoped hash (passed in by the
  # root as var.storage_account_name) so a greenfield apply cannot collide with
  # a pre-existing account anywhere in Azure. The substr() is a defensive cap.
  functions_storage_account_name = substr(var.storage_account_name, 0, 24)
}

# Storage account for Azure Functions
resource "azurerm_storage_account" "functions" {
  name                     = local.functions_storage_account_name
  resource_group_name      = var.resource_group_name
  location                 = var.location
  account_tier             = "Standard"
  account_replication_type = "LRS"

  # Identity-based host storage: shared key access is disabled so no account
  # key can be used (or leak into state). The Function App's managed identity
  # is granted the Blob/Queue data roles below.
  shared_access_key_enabled = false
  min_tls_version           = "TLS1_2"

  tags = var.tags
}

# App Service Plan for Azure Functions
resource "azurerm_service_plan" "functions" {
  name                = "${var.resource_prefix}-func-plan"
  resource_group_name = var.resource_group_name
  location            = var.location
  os_type             = "Linux"
  sku_name            = var.functions_app_service_plan_sku

  tags = var.tags
}

# Azure Function App
resource "azurerm_linux_function_app" "main" {
  # Globally-unique name: the FDQN <name>.azurewebsites.net must be unique across
  # all of Azure, so the subscription-derived global_suffix is appended (same
  # suffix shared with IoT Hub / Event Hubs / SignalR). "-func-" + 12 hex chars
  # keeps the name inside the 60-char Function App limit.
  name                = "${var.resource_prefix}-func-${var.global_suffix}"
  resource_group_name = var.resource_group_name
  location            = var.location

  storage_account_name = azurerm_storage_account.functions.name
  # Identity-based host storage — no storage_account_access_key in state.
  storage_uses_managed_identity = true
  service_plan_id               = azurerm_service_plan.functions.id

  # System-assigned managed identity — the runtime credential for all
  # identity-based service access (Cosmos, Storage, Event Hub, SignalR).
  identity {
    type = "SystemAssigned"
  }

  # Runtime configuration. Every external service is wired identity-based via a
  # NON-SECRET endpoint (the `__`-suffixed settings the Functions host resolves
  # against the app's managed identity). No connection strings / primary keys.
  app_settings = {
    "FUNCTIONS_WORKER_RUNTIME"     = "node"
    "WEBSITE_NODE_DEFAULT_VERSION" = "~20"

    # Application Insights — identity-based (AAD) telemetry ingestion. The
    # managed identity is granted 'Monitoring Metrics Publisher' on the App
    # Insights resource (root module); Authorization=AAD makes the host
    # authenticate with an AAD token. The FULL connection string (InstrumentationKey
    # included) is required by Microsoft as the destination-resource identifier
    # even under Entra-only ingestion — but the ikey CANNOT authenticate because
    # local_authentication_disabled=true on the AI resource. This ikey-in-state
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
    application_stack {
      node_version = "20"
    }

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
# Host storage: the Functions runtime needs Blob (deployment/host) and Queue
# (triggers/scaling) data-plane access on ITS OWN storage account. Scoped to
# the storage account only — least privilege.
resource "azurerm_role_assignment" "functions_storage_blob" {
  scope                = azurerm_storage_account.functions.id
  role_definition_name = "Storage Blob Data Owner"
  principal_id         = azurerm_linux_function_app.main.identity[0].principal_id
}

resource "azurerm_role_assignment" "functions_storage_queue" {
  scope                = azurerm_storage_account.functions.id
  role_definition_name = "Storage Queue Data Contributor"
  principal_id         = azurerm_linux_function_app.main.identity[0].principal_id
}
