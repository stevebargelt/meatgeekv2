# IoT Hub Module Outputs

output "iot_hub_id" {
  description = "ID of the IoT Hub"
  value       = azurerm_iothub.main.id
}

output "iot_hub_name" {
  description = "Name of the IoT Hub"
  value       = azurerm_iothub.main.name
}

output "hostname" {
  description = "Hostname of the IoT Hub"
  value       = azurerm_iothub.main.hostname
}

# NOTE: the former `connection_string`, `device_connection_strings`, and
# `eventhub_connection_string` secret outputs were REMOVED (MG-24 S1). The
# Function App consumes IoT telemetry identity-based via the Event Hubs
# namespace FQDN below; no SharedAccessKey / connection string is surfaced.

output "eventhub_namespace_name" {
  description = "Name of the Event Hub namespace"
  value       = azurerm_eventhub_namespace.main.name
}

output "eventhub_namespace_id" {
  description = "Resource ID of the Event Hub namespace (consumed by the root module to grant the Function App identity Azure Event Hubs Data Receiver)."
  value       = azurerm_eventhub_namespace.main.id
}

output "eventhub_namespace_fqdn" {
  description = "Fully-qualified Event Hubs namespace hostname (non-secret) for identity-based access by the Function App."
  value       = "${azurerm_eventhub_namespace.main.name}.servicebus.windows.net"
}

output "eventhub_name" {
  description = "Name of the Event Hub"
  value       = azurerm_eventhub.temperature_data.name
}

output "identity_principal_id" {
  description = "Principal ID of the IoT Hub system-assigned managed identity (consumed by root to grant Cosmos DB Built-in Data Contributor)"
  value       = azurerm_iothub.main.identity[0].principal_id
}

output "routes" {
  description = "Names of the custom routes created on the IoT Hub, keyed by destination"
  value = {
    cosmos   = azurerm_iothub_route.cosmos.name
    eventhub = azurerm_iothub_route.eventhub.name
  }
}
