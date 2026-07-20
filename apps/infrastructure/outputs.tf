# MeatGeek V2 Infrastructure Outputs
#
# SECURITY (MG-24 S1): NO runtime credentials, connection strings, primary
# keys, or access keys are exported here. Every consumer accesses services
# identity-based (managed identity + RBAC) via the NON-SECRET endpoints below,
# so nothing sensitive is written to Terraform state via an output. The former
# *_connection_string / *_key / environment_config / device_configuration
# secret outputs were removed.

# Resource Group
output "resource_group_name" {
  description = "Name of the main resource group"
  value       = azurerm_resource_group.main.name
}

output "resource_group_location" {
  description = "Location of the main resource group"
  value       = azurerm_resource_group.main.location
}

# IoT Hub Outputs (non-secret)
output "iot_hub_name" {
  description = "Name of the IoT Hub"
  value       = module.iot_hub.iot_hub_name
}

output "iot_hub_hostname" {
  description = "Hostname of the IoT Hub"
  value       = module.iot_hub.hostname
}

output "eventhub_namespace_fqdn" {
  description = "Fully-qualified Event Hubs namespace hostname (non-secret) for identity-based telemetry access"
  value       = module.iot_hub.eventhub_namespace_fqdn
}

# CosmosDB Outputs (non-secret)
output "cosmos_db_endpoint" {
  description = "CosmosDB endpoint URL (non-secret; access is identity-based)"
  value       = module.cosmos_db.endpoint
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

# SignalR Outputs (non-secret)
output "signalr_service_uri" {
  description = "SignalR Service URI (non-secret; access is identity-based)"
  value       = module.signalr.service_uri
}

output "signalr_hostname" {
  description = "SignalR Service hostname"
  value       = module.signalr.hostname
}

# Storage Outputs (from Functions module — name only, non-secret)
output "storage_account_name" {
  description = "Name of the Functions storage account"
  value       = module.azure_functions.storage_account_name
}

# Monitoring Outputs (non-secret)
output "log_analytics_workspace_id" {
  description = "Log Analytics Workspace ID"
  value       = azurerm_log_analytics_workspace.main.id
}

# Development URLs (all non-secret endpoints)
output "development_urls" {
  description = "URLs for development and testing"
  value = {
    api_base_url    = "https://${module.azure_functions.hostname}/api"
    signalr_url     = module.signalr.service_uri
    cosmos_endpoint = module.cosmos_db.endpoint
    app_insights    = "https://portal.azure.com/#@/resource${azurerm_application_insights.main.id}"
  }
}
