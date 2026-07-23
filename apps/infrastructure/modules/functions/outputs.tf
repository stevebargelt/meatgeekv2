# Azure Functions Module Outputs

output "function_app_id" {
  description = "ID of the Azure Function App"
  value       = azurerm_function_app_flex_consumption.main.id
}

output "function_app_name" {
  description = "Name of the Azure Function App"
  value       = azurerm_function_app_flex_consumption.main.name
}

output "function_app_url" {
  description = "URL of the Azure Function App"
  value       = "https://${azurerm_function_app_flex_consumption.main.default_hostname}"
}

output "hostname" {
  description = "Default hostname of the Function App"
  value       = azurerm_function_app_flex_consumption.main.default_hostname
}

output "storage_account_name" {
  description = "Name of the storage account"
  value       = azurerm_storage_account.functions.name
}

output "deployment_container_name" {
  description = "Name of the Flex Consumption deployment-package blob container (target of `func publish`/OneDeploy). function_app_name remains the deploy source of truth; this is informational for the runbook."
  value       = local.deployment_container_name
}

# NOTE: the former `storage_connection_string` output was REMOVED (MG-24 S1).
# Storage is identity-based (Flex MI blob deployment; shared_access_key_enabled=
# false); no account key / connection string is generated or surfaced, so none
# can leak via state.

output "identity_principal_id" {
  description = "Principal ID of the Function App system-assigned managed identity (consumed by the root module to grant Cosmos / Event Hub / SignalR data-plane roles)."
  value       = azurerm_function_app_flex_consumption.main.identity[0].principal_id
}
