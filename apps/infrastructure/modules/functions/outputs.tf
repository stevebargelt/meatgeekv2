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

output "storage_connection_string" {
  description = "Storage account connection string"
  value       = azurerm_storage_account.functions.primary_connection_string
  sensitive   = true
}