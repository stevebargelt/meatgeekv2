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

output "connection_string" {
  description = "Connection string for IoT Hub"
  value       = "HostName=${azurerm_iothub.main.hostname};SharedAccessKeyName=iothubowner;SharedAccessKey=${azurerm_iothub.main.shared_access_policy[0].primary_key}"
  sensitive   = true
}

output "device_connection_strings" {
  description = "Connection strings for IoT devices (to be created manually)"
  value = {
    meatgeek1 = "HostName=${azurerm_iothub.main.hostname};DeviceId=meatgeek1;SharedAccessKey=DEVICE_KEY_TO_BE_CREATED"
    meatgeek2 = "HostName=${azurerm_iothub.main.hostname};DeviceId=meatgeek2;SharedAccessKey=DEVICE_KEY_TO_BE_CREATED"
    meatgeek3 = "HostName=${azurerm_iothub.main.hostname};DeviceId=meatgeek3;SharedAccessKey=DEVICE_KEY_TO_BE_CREATED"
  }
  sensitive = true
}

output "eventhub_namespace_name" {
  description = "Name of the Event Hub namespace"
  value       = azurerm_eventhub_namespace.main.name
}

output "eventhub_name" {
  description = "Name of the Event Hub"
  value       = azurerm_eventhub.temperature_data.name
}

output "eventhub_connection_string" {
  description = "Event Hub connection string"
  value       = azurerm_eventhub_authorization_rule.iothub.primary_connection_string
  sensitive   = true
}