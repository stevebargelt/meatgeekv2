# Azure Functions Module Outputs

output "function_app_id" {
  description = "ID of the Azure Function App"
  value       = azurerm_linux_function_app.main.id
}

output "function_app_name" {
  description = "Name of the Azure Function App"
  value       = azurerm_linux_function_app.main.name
}

output "function_app_url" {
  description = "URL of the Azure Function App"
  value       = "https://${azurerm_linux_function_app.main.default_hostname}"
}

output "hostname" {
  description = "Default hostname of the Function App"
  value       = azurerm_linux_function_app.main.default_hostname
}

output "storage_account_name" {
  description = "Name of the storage account"
  value       = azurerm_storage_account.functions.name
}

# NOTE: the former `storage_connection_string` output was REMOVED (MG-24 S1).
# Host storage is identity-based (storage_uses_managed_identity); no account
# key / connection string is generated or surfaced, so none can leak via state.

output "identity_principal_id" {
  description = "Principal ID of the Function App system-assigned managed identity (consumed by the root module to grant Cosmos / Event Hub / SignalR data-plane roles)."
  value       = azurerm_linux_function_app.main.identity[0].principal_id
}