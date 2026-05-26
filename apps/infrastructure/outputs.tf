# MeatGeek V2 Infrastructure Outputs

# Resource Group
output "resource_group_name" {
  description = "Name of the main resource group"
  value       = azurerm_resource_group.main.name
}

output "resource_group_location" {
  description = "Location of the main resource group"
  value       = azurerm_resource_group.main.location
}

# Application Insights
output "application_insights_instrumentation_key" {
  description = "Application Insights instrumentation key"
  value       = azurerm_application_insights.main.instrumentation_key
  sensitive   = true
}

output "application_insights_connection_string" {
  description = "Application Insights connection string"
  value       = azurerm_application_insights.main.connection_string
  sensitive   = true
}

# IoT Hub Outputs
output "iot_hub_name" {
  description = "Name of the IoT Hub"
  value       = module.iot_hub.iot_hub_name
}

output "iot_hub_hostname" {
  description = "Hostname of the IoT Hub"
  value       = module.iot_hub.hostname
}

output "iot_hub_connection_string" {
  description = "IoT Hub connection string"
  value       = module.iot_hub.connection_string
  sensitive   = true
}

output "iot_hub_device_connection_strings" {
  description = "Device connection strings for IoT Hub"
  value       = module.iot_hub.device_connection_strings
  sensitive   = true
}

# CosmosDB Outputs
output "cosmos_db_endpoint" {
  description = "CosmosDB endpoint URL"
  value       = module.cosmos_db.endpoint
}

output "cosmos_db_connection_string" {
  description = "CosmosDB connection string"
  value       = module.cosmos_db.connection_string
  sensitive   = true
}

output "cosmos_db_database_name" {
  description = "CosmosDB database name"
  value       = module.cosmos_db.database_name
}

# Azure Functions Outputs
output "function_app_name" {
  description = "Name of the Azure Function App"
  value       = module.azure_functions.function_app_name
}

output "function_app_url" {
  description = "URL of the Azure Function App"
  value       = module.azure_functions.function_app_url
}

output "function_app_hostname" {
  description = "Hostname of the Azure Function App"
  value       = module.azure_functions.hostname
}

# SignalR Outputs
output "signalr_connection_string" {
  description = "SignalR Service connection string"
  value       = module.signalr.connection_string
  sensitive   = true
}

output "signalr_hostname" {
  description = "SignalR Service hostname"
  value       = module.signalr.hostname
}

# Storage Outputs (from Functions module)
output "storage_account_name" {
  description = "Name of the storage account"
  value       = module.azure_functions.storage_account_name
}

output "storage_connection_string" {
  description = "Storage account connection string"
  value       = module.azure_functions.storage_connection_string
  sensitive   = true
}

# Monitoring Outputs
output "log_analytics_workspace_id" {
  description = "Log Analytics Workspace ID"
  value       = azurerm_log_analytics_workspace.main.id
}

output "log_analytics_workspace_key" {
  description = "Log Analytics Workspace primary key"
  value       = azurerm_log_analytics_workspace.main.primary_shared_key
  sensitive   = true
}

# Environment Configuration for Applications
output "environment_config" {
  description = "Environment configuration for applications"
  value = {
    COSMOSDB_CONNECTION_STRING    = module.cosmos_db.connection_string
    COSMOSDB_DATABASE_NAME        = module.cosmos_db.database_name
    IOTHUB_CONNECTION_STRING      = module.iot_hub.connection_string
    SIGNALR_CONNECTION_STRING     = module.signalr.connection_string
    APPINSIGHTS_CONNECTION_STRING = azurerm_application_insights.main.connection_string
    FUNCTIONS_APP_URL             = module.azure_functions.function_app_url
    STORAGE_CONNECTION_STRING     = module.azure_functions.storage_connection_string
  }
  sensitive = true
}

# Device Configuration
output "device_configuration" {
  description = "Configuration needed for device registration"
  value = {
    iot_hub_hostname          = module.iot_hub.hostname
    device_connection_strings = module.iot_hub.device_connection_strings
    api_endpoint              = module.azure_functions.function_app_url
  }
  sensitive = true
}

# Development URLs
output "development_urls" {
  description = "URLs for development and testing"
  value = {
    api_base_url    = "https://${module.azure_functions.hostname}/api"
    signalr_url     = "https://${module.signalr.hostname}"
    cosmos_endpoint = module.cosmos_db.endpoint
    app_insights    = "https://portal.azure.com/#@/resource${azurerm_application_insights.main.id}"
  }
}