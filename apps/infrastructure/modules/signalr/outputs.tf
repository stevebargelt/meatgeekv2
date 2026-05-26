# SignalR Module Outputs

output "signalr_service_id" {
  description = "ID of the SignalR Service"
  value       = azurerm_signalr_service.main.id
}

output "signalr_service_name" {
  description = "Name of the SignalR Service"
  value       = azurerm_signalr_service.main.name
}

output "hostname" {
  description = "Hostname of the SignalR Service"
  value       = azurerm_signalr_service.main.hostname
}

output "connection_string" {
  description = "Connection string for SignalR Service"
  value       = azurerm_signalr_service.main.primary_connection_string
  sensitive   = true
}

output "access_key" {
  description = "Primary access key for SignalR Service"
  value       = azurerm_signalr_service.main.primary_access_key
  sensitive   = true
}