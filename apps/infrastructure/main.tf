# MeatGeek V2 Infrastructure - Main Configuration

terraform {
  required_version = ">= 1.9"

  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }

  # Remote state backend. Left empty for partial configuration: per-environment
  # values (storage account / container / key) are supplied at init time via
  #   terraform init -backend-config=environments/backend-<env>.hcl
  # so dev and prod state can never collide. See the bootstrap runbook.
  backend "azurerm" {}
}

# Configure the Microsoft Azure Provider
provider "azurerm" {
  # No hardcoded subscription. The subscription is resolved from the authenticated
  # environment (ARM_SUBSCRIPTION_ID / OIDC federated credential) or, for local
  # operator runs, from the optional `subscription_id` variable (default null,
  # which lets the provider fall back to the ambient Azure CLI / env context).
  subscription_id = var.subscription_id

  features {
    resource_group {
      prevent_deletion_if_contains_resources = false
    }

    key_vault {
      purge_soft_delete_on_destroy    = true
      recover_soft_deleted_key_vaults = true
    }
  }
}

provider "azapi" {
  # Configuration options
}

# Local values for resource naming and tagging
locals {
  # V2 resource naming convention: meatgeek-v2-{environment}-{service}
  # `v2` makes every resource unambiguously the V2 stack so it can never be
  # confused with (or accidentally target) the legacy V1 system. This is the
  # single source of naming, cascaded to every module.
  resource_prefix = "meatgeek-v2-${var.environment}"

  # Common tags applied to all resources.
  # NOTE: no wall-clock-derived tag (previously a CreatedDate built from the
  # current time) — a dynamic value changes on every plan and produces
  # perpetual tag drift on otherwise-unchanged resources.
  common_tags = {
    Project     = "MeatGeek V2"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Repository  = "stevebargelt/meatgeekv2"
  }

  # Location mapping for different environments
  location = var.location

  # Globally-unique Cosmos DB account name for the V2-owned account.
  # Decoupled from resource_prefix (uses a deterministic subscription-derived
  # suffix rather than the human-readable prefix) so it stays globally unique
  # and can never collide with a V1 or third-party account. Deterministic (a
  # subscription-derived hash, no dynamic wall-clock or random function) so it
  # is stable across plans. Cosmos account naming rule: 3-44 chars, lowercase
  # letters/numbers/hyphens.
  cosmos_account_name = "mgv2-${var.environment}-${substr(sha1("${data.azurerm_client_config.current.subscription_id}-cosmos"), 0, 12)}"

  # Globally-unique Functions storage account name — same subscription-derived
  # approach as the Cosmos name so a greenfield apply can never fail on a name
  # collision. Storage account rule: 3-24 chars, lowercase letters/numbers only
  # (NO hyphens). "mgv2" + env (dev|prod) + a 12-char subscription-derived hash
  # keeps it deterministic and comfortably under 24 chars (e.g. mgv2dev<hash> =
  # 19, mgv2prod<hash> = 20).
  functions_storage_account_name = "mgv2${var.environment}${substr(sha1("${data.azurerm_client_config.current.subscription_id}-funcstorage"), 0, 12)}"

  # Deterministic, subscription-derived suffix for GLOBALLY-scoped resource names
  # (Function App, IoT Hub, Event Hubs namespace, SignalR). A greenfield apply in
  # any subscription gets a name that cannot collide with a pre-existing global
  # resource. Deterministic (subscription-derived hash, no wall-clock / random)
  # so it is stable across plans; 12 hex chars keeps every derived name inside
  # Azure's per-service length limits. Threaded to each module as `global_suffix`.
  global_name_suffix = substr(sha1("${data.azurerm_client_config.current.subscription_id}-global"), 0, 12)

  # FULL Terraform-managed Application Insights connection string — including the
  # InstrumentationKey. Microsoft requires the connection string (with the ikey
  # as the destination-resource identifier) as APPLICATIONINSIGHTS_CONNECTION_STRING
  # even under Entra-only ingestion. The ikey is NOT a usable credential here:
  # `local_authentication_enabled = false` on azurerm_application_insights.main
  # (below) forces AAD-only ingestion — the host authenticates with a Monitoring
  # Metrics Publisher AAD token (Authorization=AAD), and an ikey-only client is
  # rejected. This residual is safe ONLY while local auth stays disabled; the
  # pre-apply secret-inspection gate (scripts/tf-plan-secret-inspection.sh)
  # enforces that coupling. nonsensitive() is intentional: with local auth
  # disabled the string is not a credential, and keeping it un-redacted lets the
  # fail-closed gate inspect the accepted residual. See the MG-24 ADR.
  appinsights_connection_string = nonsensitive(azurerm_application_insights.main.connection_string)
}

# Data sources for existing resources (if any)
data "azurerm_client_config" "current" {}

# Resource Group
resource "azurerm_resource_group" "main" {
  name     = "${local.resource_prefix}-rg"
  location = local.location
  tags     = local.common_tags
}

# Log Analytics Workspace for centralized logging
# Daily ingestion cap (daily_quota_gb) is the hard guardrail against runaway Azure Monitor cost.
resource "azurerm_log_analytics_workspace" "main" {
  name                = "${local.resource_prefix}-logs"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  sku                 = "PerGB2018"
  retention_in_days   = var.log_retention_days
  daily_quota_gb      = var.ingestion_cap_gb

  tags = merge(local.common_tags, {
    Service = "Logging"
  })
}

# Application Insights — workspace-based variant. Migration from the classic resource is a destroy+create (one-time event in dev).
resource "azurerm_application_insights" "main" {
  name                = "${local.resource_prefix}-appinsights"
  location            = azurerm_resource_group.main.location
  resource_group_name = azurerm_resource_group.main.name
  application_type    = "web"
  retention_in_days   = var.appinsights_retention_days
  workspace_id        = azurerm_log_analytics_workspace.main.id
  sampling_percentage = 50

  # Disable local (ingestion-key) authentication: telemetry can ONLY be ingested
  # with an Entra (AAD) token. This is what makes the InstrumentationKey inside
  # the connection string a non-credential — it cannot authenticate ingestion.
  # The Function App publishes via its managed identity + the Monitoring Metrics
  # Publisher role assignment below. Do not re-enable without revisiting the
  # secret-in-state posture (MG-24 ADR + tf-plan-secret-inspection.sh gate).
  local_authentication_enabled = false

  tags = merge(local.common_tags, {
    Service = "Monitoring"
  })
}

# IoT Hub Module
module "iot_hub" {
  source = "./modules/iot-hub"

  resource_prefix     = local.resource_prefix
  global_suffix       = local.global_name_suffix
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  iot_hub_sku_name     = var.iot_hub_sku_name
  iot_hub_sku_capacity = var.iot_hub_sku_capacity

  # Parallel routing destinations: direct→Cosmos for storage, EventHub→Functions for real-time fan-out.
  cosmos_account_endpoint = module.cosmos_db.endpoint
  cosmos_database_name    = module.cosmos_db.database_name
  cosmos_container_name   = "temperatures"

  # Dependency handle: the Cosmos routing endpoint uses the IoT Hub identity, so
  # it must be created only AFTER that identity holds the data-plane role. Only
  # the endpoint (not azurerm_iothub.main) consumes this, so the graph stays
  # acyclic even though the role assignment itself depends on this module's
  # identity_principal_id output (MG-24).
  cosmos_role_assignment_id = azurerm_cosmosdb_sql_role_assignment.iot_hub_writer.id

  tags = local.common_tags
}

# Grant the IoT Hub's system-assigned identity Cosmos DB Built-in Data Contributor
# on the V2-OWNED Cosmos account, so the direct route can use AAD auth instead of keys.
# Role definition ID 00000000-0000-0000-0000-000000000002 = "Cosmos DB Built-in Data Contributor"
# (data-plane built-in role; assigned at the account scope).
resource "azurerm_cosmosdb_sql_role_assignment" "iot_hub_writer" {
  resource_group_name = azurerm_resource_group.main.name
  account_name        = module.cosmos_db.cosmos_account_name
  role_definition_id  = "${module.cosmos_db.cosmos_account_id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = module.iot_hub.identity_principal_id
  scope               = module.cosmos_db.cosmos_account_id
}

# CosmosDB Module - CREATES and OWNS the V2 Cosmos account (no V1 dependency).
#
# Contract A (module input interface — Step 2 mirrors this exactly):
#   cosmos_account_name  (string)  globally-unique, Azure-valid account name
#   resource_group_name  (string)  the V2 resource group the account lives in
#   location             (string)  Azure region for the account
#   resource_prefix / environment / throughput / ttl / tags as before
# The former V1 shared-account adoption inputs are removed — V2 no longer reads
# or adopts the V1 shared Cosmos account; it provisions and owns its own.
module "cosmos_db" {
  source = "./modules/cosmos-db"

  resource_prefix     = local.resource_prefix
  environment         = var.environment
  cosmos_account_name = local.cosmos_account_name
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  database_throughput     = var.cosmos_database_throughput
  database_max_throughput = var.cosmos_database_max_throughput
  temperature_data_ttl    = var.temperature_data_ttl_days * 86400 # Convert days to seconds

  tags = local.common_tags
}

# Azure Functions Module
module "azure_functions" {
  source = "./modules/functions"

  resource_prefix     = local.resource_prefix
  global_suffix       = local.global_name_suffix
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  functions_app_service_plan_sku = var.functions_app_service_plan_sku
  storage_account_name           = local.functions_storage_account_name

  # App Insights telemetry wiring — identity-based (AAD). The FULL TF-managed
  # connection string (InstrumentationKey included, per Microsoft's requirement)
  # is passed; the managed identity is granted Monitoring Metrics Publisher below
  # and the host authenticates via Authorization=AAD. The ikey cannot ingest
  # because local_authentication_enabled=false on the AI resource — so this is a
  # non-credential residual, enforced by the pre-apply secret-inspection gate.
  application_insights_connection_string = local.appinsights_connection_string

  # Identity-based service endpoints (NON-SECRET). Runtime authorization is via
  # the Function App's managed identity + the role assignments below.
  cosmos_account_endpoint = module.cosmos_db.endpoint
  eventhub_namespace_fqdn = module.iot_hub.eventhub_namespace_fqdn
  signalr_service_uri     = module.signalr.service_uri

  # S2 HTTP posture — explicit per-environment CORS + optional Entra ID auth.
  cors_allowed_origins            = var.functions_cors_allowed_origins
  auth_active_directory_client_id = var.functions_auth_client_id
  auth_active_directory_tenant_id = var.functions_auth_tenant_id
  auth_allowed_audiences          = var.functions_auth_allowed_audiences
  # CALLING-client allowlist (validates the token's appid/azp — the smoke-test
  # client), NOT the API registration. Default: the Azure CLI public client.
  auth_allowed_client_app_ids = var.functions_auth_allowed_client_app_ids

  tags = local.common_tags

  depends_on = [
    module.cosmos_db,
    module.iot_hub,
    module.signalr
  ]
}

# --- Function App identity → data-plane RBAC (least privilege, MG-24 S1) -----
# Cosmos DB Built-in Data Contributor (data-plane) on the V2-owned account so
# the Function App reads/writes documents via AAD, not an account key.
resource "azurerm_cosmosdb_sql_role_assignment" "functions_cosmos" {
  resource_group_name = azurerm_resource_group.main.name
  account_name        = module.cosmos_db.cosmos_account_name
  role_definition_id  = "${module.cosmos_db.cosmos_account_id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = module.azure_functions.identity_principal_id
  scope               = module.cosmos_db.cosmos_account_id
}

# Azure Event Hubs Data Receiver on the IoT telemetry namespace so the Function
# App consumes the real-time device stream identity-based (no SAS key).
resource "azurerm_role_assignment" "functions_eventhub_receiver" {
  scope                = module.iot_hub.eventhub_namespace_id
  role_definition_name = "Azure Event Hubs Data Receiver"
  principal_id         = module.azure_functions.identity_principal_id
}

# SignalR Service Owner so the Function App negotiates/broadcasts identity-based.
resource "azurerm_role_assignment" "functions_signalr" {
  scope                = module.signalr.signalr_service_id
  role_definition_name = "SignalR Service Owner"
  principal_id         = module.azure_functions.identity_principal_id
}

# Monitoring Metrics Publisher on the App Insights resource so the Function App
# publishes telemetry with an AAD token (identity-based ingestion) instead of an
# instrumentation/ingestion key. Combined with
# APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD on the app, this
# makes ingestion AAD-only. The FULL App Insights connection string
# (InstrumentationKey included, as the destination-resource identifier Microsoft
# requires) IS in app_settings and the ikey is inherently in Terraform state, but
# it is NON-AUTHENTICATING: local_authentication_enabled=false on the AI resource
# forces Entra-only ingestion, so the ikey cannot ingest. This residual is safe
# ONLY while local auth stays disabled — enforced by the pre-apply secret-
# inspection gate (MG-24 S1). See the MG-24 ADR.
resource "azurerm_role_assignment" "functions_appinsights_publisher" {
  scope                = azurerm_application_insights.main.id
  role_definition_name = "Monitoring Metrics Publisher"
  principal_id         = module.azure_functions.identity_principal_id
}

# App-deployment identity → Function App publish RBAC (MG-24 item 4).
# `Website Contributor` scoped to the Function App ALONE so the SEPARATE
# app-deployment SP can run `func publish`. A Reader (the plan identity) cannot
# publish, which is why publishing is a distinct identity with this scoped role.
# Created in the SAME apply as the Function App — closing the sequencing gap
# where the FA only exists post-apply and nothing granted the publish role.
# Guarded by count: when var.app_deploy_principal_object_id is empty (e.g. a bare
# `terraform validate` / plan without the bootstrap-emitted object id) the
# assignment is skipped and the plan still validates. Set the var (from the
# bootstrap coordinate) for any environment you deploy code to. The object id is
# the SP's OBJECT id — created by bootstrap phase 1, BEFORE this apply — so no
# apply-time-computed principal is referenced and the graph stays acyclic.
resource "azurerm_role_assignment" "functions_app_deploy_publisher" {
  count                = var.app_deploy_principal_object_id != "" ? 1 : 0
  scope                = module.azure_functions.function_app_id
  role_definition_name = "Website Contributor"
  principal_id         = var.app_deploy_principal_object_id
}

# SignalR Module
module "signalr" {
  source = "./modules/signalr"

  resource_prefix     = local.resource_prefix
  global_suffix       = local.global_name_suffix
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  signalr_sku_name     = var.signalr_sku_name
  signalr_sku_capacity = var.signalr_sku_capacity

  # Explicit per-environment CORS origins (no wildcard).
  cors_allowed_origins = var.signalr_cors_allowed_origins

  tags = local.common_tags
}

# Native Azure Monitor OTLP path (MG-33 F1/F3) — DEFAULT-OFF, AUTHORED ONLY.
#
# Authors the OUTBOUND native-OTLP telemetry path: the edge Go services' OTLP
# lands at a central collector Container App that forwards via otlphttp +
# azureauth (user-assigned MI) to a DCE/DCR, which transforms it into the
# workspace-based App Insights tables. This REPLACES the collector's former
# `azuremonitor` (Breeze) exporter (see apps/infrastructure/otel-collector).
#
# count-guarded by var.enable_native_otlp (default false): with the flag OFF the
# module is NOT instantiated and creates ZERO net-new resources, so
# `terraform validate`/`plan` here are unchanged. APPLY is additionally gated on
# MG-24 (the Container Apps environment does not exist yet — passed in via
# var.container_app_environment_id), MG-25 (native-OTLP preview acceptance), and
# MG-34 (secure off-VNet edge ingress + live proof). Production activation is a
# deliberate flag flip, NOT a side effect of a normal apply. The
# Monitoring Metrics Publisher role inside the module is scoped to the DCR (NOT
# App Insights — deliberately different from functions_appinsights_publisher).
module "native_otlp" {
  count  = var.enable_native_otlp ? 1 : 0
  source = "./modules/native-otlp"

  resource_prefix     = local.resource_prefix
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  # The DCR routes OTLP traces into the workspace-based App Insights tables, so
  # it targets the SAME Log Analytics workspace App Insights is bound to.
  log_analytics_workspace_id = azurerm_log_analytics_workspace.main.id

  # MG-24 handles: the Container Apps environment + its Azure File storage
  # association. Empty until then; REQUIRED before the flag can be flipped on.
  container_app_environment_id = var.container_app_environment_id
  collector_storage_name       = var.otlp_collector_storage_name

  tags = local.common_tags
}

# Monitoring Module (additional monitoring beyond App Insights)
module "monitoring" {
  source = "./modules/monitoring"

  resource_prefix     = local.resource_prefix
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  log_analytics_workspace_id   = azurerm_log_analytics_workspace.main.id
  log_analytics_workspace_name = azurerm_log_analytics_workspace.main.name
  application_insights_id      = azurerm_application_insights.main.id
  iot_hub_id                   = module.iot_hub.iot_hub_id
  cosmos_db_id                 = module.cosmos_db.cosmos_account_id
  function_app_id              = module.azure_functions.function_app_id
  signalr_id                   = module.signalr.signalr_service_id
  subscription_id              = data.azurerm_client_config.current.subscription_id
  ingestion_cap_gb             = var.ingestion_cap_gb
  secondary_budget_limit       = var.secondary_budget_limit
  admin_email                  = var.admin_email
  budget_limit                 = var.budget_limit

  tags = local.common_tags

  depends_on = [
    module.iot_hub,
    module.cosmos_db,
    module.azure_functions,
    module.signalr
  ]
}