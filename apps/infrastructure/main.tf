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

  # backend "azurerm" {
  #   # Backend configuration will be provided via backend config file
  #   # terraform init -backend-config=backend-config.hcl
  # }
}

# Configure the Microsoft Azure Provider
provider "azurerm" {
  subscription_id = "c7e800cb-0ee6-4175-9605-a6b97c6f419f"

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
  # Resource naming convention: meatgeek-{environment}-{service}
  resource_prefix = "meatgeek-${var.environment}"

  # Common tags applied to all resources
  common_tags = {
    Project     = "MeatGeek V2"
    Environment = var.environment
    ManagedBy   = "Terraform"
    Repository  = "stevebargelt/meatgeekv2"
    CreatedDate = formatdate("YYYY-MM-DD", timestamp())
  }

  # Location mapping for different environments
  location = var.location
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

  tags = merge(local.common_tags, {
    Service = "Monitoring"
  })
}

# IoT Hub Module
module "iot_hub" {
  source = "./modules/iot-hub"

  resource_prefix     = local.resource_prefix
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  iot_hub_sku_name     = var.iot_hub_sku_name
  iot_hub_sku_capacity = var.iot_hub_sku_capacity

  # Parallel routing destinations: direct→Cosmos for storage, EventHub→Functions for real-time fan-out.
  cosmos_account_endpoint = module.cosmos_db.endpoint
  cosmos_database_name    = module.cosmos_db.database_name
  cosmos_container_name   = "temperatures"

  tags = local.common_tags
}

# Grant the IoT Hub's system-assigned identity Cosmos DB Built-in Data Contributor
# on the existing shared Cosmos account, so the direct route can use AAD auth instead of keys.
# Role definition ID 00000000-0000-0000-0000-000000000002 = "Cosmos DB Built-in Data Contributor"
# (data-plane built-in role; assigned at the account scope).
resource "azurerm_cosmosdb_sql_role_assignment" "iot_hub_writer" {
  resource_group_name = var.existing_cosmos_resource_group_name
  account_name        = var.existing_cosmos_account_name
  role_definition_id  = "${module.cosmos_db.cosmos_account_id}/sqlRoleDefinitions/00000000-0000-0000-0000-000000000002"
  principal_id        = module.iot_hub.identity_principal_id
  scope               = module.cosmos_db.cosmos_account_id
}

# CosmosDB Module - Uses existing account with environment-specific database
module "cosmos_db" {
  source = "./modules/cosmos-db"

  resource_prefix                     = local.resource_prefix
  environment                         = var.environment
  existing_cosmos_account_name        = var.existing_cosmos_account_name
  existing_cosmos_resource_group_name = var.existing_cosmos_resource_group_name

  database_throughput     = var.cosmos_database_throughput
  database_max_throughput = var.cosmos_database_max_throughput
  temperature_data_ttl    = var.temperature_data_ttl_days * 86400 # Convert days to seconds

  tags = local.common_tags
}

# Azure Functions Module
module "azure_functions" {
  source = "./modules/functions"

  resource_prefix     = local.resource_prefix
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  functions_app_service_plan_sku         = var.functions_app_service_plan_sku
  application_insights_connection_string = azurerm_application_insights.main.connection_string
  cosmos_connection_string               = module.cosmos_db.connection_string
  iot_hub_connection_string              = module.iot_hub.connection_string
  signalr_connection_string              = module.signalr.connection_string

  tags = local.common_tags

  depends_on = [
    module.cosmos_db,
    module.iot_hub,
    module.signalr
  ]
}

# SignalR Module
module "signalr" {
  source = "./modules/signalr"

  resource_prefix     = local.resource_prefix
  resource_group_name = azurerm_resource_group.main.name
  location            = azurerm_resource_group.main.location

  signalr_sku_name     = var.signalr_sku_name
  signalr_sku_capacity = var.signalr_sku_capacity

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