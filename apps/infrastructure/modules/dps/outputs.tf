# IoT Hub Device Provisioning Service module outputs (HAR-131). None of them is
# a credential: a DPS has no key here, and the link to the hub is identity-based.

output "dps_id" {
  description = "Resource ID of the DPS (the scope of the root's CI enroller grant)."
  value       = azapi_resource.dps.id
}

output "dps_name" {
  description = "Name of the DPS."
  value       = azapi_resource.dps.name
}

output "dps_id_scope" {
  description = "ID scope of the DPS. Devices present it to the global endpoint to say which DPS they enroll with; it is an identifier, not a secret."
  value       = azapi_resource.dps.output.properties.idScope
}

output "dps_global_endpoint" {
  description = "Device provisioning host name devices connect to (global.azure-devices-provisioning.net)."
  value       = azapi_resource.dps.output.properties.deviceProvisioningHostName
}

output "linked_iot_hub_hostname" {
  description = "Host name of the IoT Hub the DPS links to. The link is identity-based, so this host name is everything the DPS holds about the hub."
  value       = azapi_update_resource.linked_hub.body.properties.iotHubs[0].hostName
}

output "identity_principal_id" {
  description = "Principal ID of the DPS system-assigned managed identity (the root grants it IoT Hub Registry Contributor on the hub)."
  value       = azapi_resource.dps.identity[0].principal_id
}
