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
#     APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD. Only the
#     NON-SECRET ingestion endpoint is placed in app settings — no
#     instrumentation/ingestion key or secret connection string enters state.
#   * CORS is explicit per-environment (no wildcard); App Service Authentication
#     default-DENIES every request until an identity provider is configured.

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
  name                = "${var.resource_prefix}-func"
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
    # authenticate with an AAD token, so NO instrumentation/ingestion key lands
    # here. The connection string carries ONLY the non-secret ingestion endpoint
    # (no InstrumentationKey / secret) — the resource is identified via the
    # AAD-authorized publisher role, not an ingestion key.
    "APPLICATIONINSIGHTS_AUTHENTICATION_STRING" = "Authorization=AAD"
    "APPLICATIONINSIGHTS_CONNECTION_STRING"     = "IngestionEndpoint=${var.application_insights_ingestion_endpoint}"
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

  # App Service Authentication (Easy Auth). Default-DENY: until an identity
  # provider (Entra ID) is wired via var.auth_active_directory_client_id, every
  # unauthenticated request is rejected with 401 at the platform layer — BEFORE
  # any function runs — so no business endpoint (e.g. startCook) is reachable
  # anonymously regardless of its per-function authLevel. This is the S2
  # default-deny posture; Function keys are never distributed to clients.
  auth_settings_v2 {
    auth_enabled           = true
    require_authentication = true
    unauthenticated_action = "Return401"

    # Entra ID provider, configured only when a client id is supplied. With no
    # provider AND require_authentication=true, the platform denies everything
    # (fail-closed) — the intended default until the auth design is finalized.
    dynamic "active_directory_v2" {
      for_each = var.auth_active_directory_client_id == "" ? [] : [1]
      content {
        client_id                   = var.auth_active_directory_client_id
        tenant_auth_endpoint        = "https://login.microsoftonline.com/${var.auth_active_directory_tenant_id}/v2.0"
        allowed_audiences           = var.auth_allowed_audiences
        www_authentication_disabled = false
      }
    }

    login {}
  }

  tags = var.tags
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
