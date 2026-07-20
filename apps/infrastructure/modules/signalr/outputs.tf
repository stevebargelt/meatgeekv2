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

# Non-secret service URI for identity-based access from the Function App
# (AzureSignalRConnectionString__serviceUri). Runtime auth is via the caller's
# managed identity + a SignalR Service Owner role assignment, not a key.
output "service_uri" {
  description = "SignalR Service URI (non-secret) for identity-based access"
  value       = "https://${azurerm_signalr_service.main.hostname}"
}

# NOTE: the former `connection_string` and `access_key` secret outputs were
# REMOVED (MG-24 S1). No SignalR key is surfaced via Terraform state/outputs.