# Azure Functions Module for MeatGeek V2

# Storage account for Azure Functions
resource "azurerm_storage_account" "functions" {
  name                     = "${replace(var.resource_prefix, "-", "")}funcstore"
  resource_group_name      = var.resource_group_name
  location                = var.location
  account_tier            = "Standard"
  account_replication_type = "LRS"

  tags = var.tags
}

# App Service Plan for Azure Functions
resource "azurerm_service_plan" "functions" {
  name                = "${var.resource_prefix}-func-plan"
  resource_group_name = var.resource_group_name
  location           = var.location
  os_type            = "Linux"
  sku_name           = var.functions_app_service_plan_sku

  tags = var.tags
}

# Azure Function App
resource "azurerm_linux_function_app" "main" {
  name                = "${var.resource_prefix}-func"
  resource_group_name = var.resource_group_name
  location           = var.location

  storage_account_name       = azurerm_storage_account.functions.name
  storage_account_access_key = azurerm_storage_account.functions.primary_access_key
  service_plan_id           = azurerm_service_plan.functions.id

  app_settings = {
    "FUNCTIONS_WORKER_RUNTIME"     = "node"
    "WEBSITE_NODE_DEFAULT_VERSION" = "~20"
    "COSMOSDB_CONNECTION_STRING"   = var.cosmos_connection_string
    "IOTHUB_CONNECTION_STRING"     = var.iot_hub_connection_string
    "SIGNALR_CONNECTION_STRING"    = var.signalr_connection_string
    "APPINSIGHTS_INSTRUMENTATIONKEY" = var.application_insights_key
  }

  site_config {
    application_stack {
      node_version = "20"
    }
    
    cors {
      allowed_origins     = ["*"]
      support_credentials = false
    }
  }

  tags = var.tags
}