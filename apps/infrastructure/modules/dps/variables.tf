# IoT Hub Device Provisioning Service module variables (HAR-131)

variable "resource_prefix" {
  description = "Prefix for resource names (meatgeek-v2-<env>)."
  type        = string
}

variable "global_suffix" {
  description = "Subscription-derived suffix appended to the DPS name. A DPS name is globally unique (it is part of its service host name), so it carries the same suffix as the IoT Hub."
  type        = string
}

variable "resource_group_id" {
  description = "Resource ID of the resource group the DPS lives in (the IoT Hub's resource group)."
  type        = string
}

variable "location" {
  description = "Azure region of the DPS and of the linked IoT Hub (both live in the resource group's region)."
  type        = string
}

variable "iot_hub_hostname" {
  description = "Host name of the IoT Hub to link (<hub>.azure-devices.net). The link is identity-based, so the host name is all the DPS is given about the hub: no connection string, no key."
  type        = string

  validation {
    condition     = can(regex("^[A-Za-z0-9-]+\\.azure-devices\\.net$", var.iot_hub_hostname))
    error_message = "iot_hub_hostname must be an IoT Hub host name (<hub>.azure-devices.net), never a connection string."
  }
}

variable "hub_registry_role_assignment_id" {
  description = <<-EOT
    ID of the role assignment that grants THIS DPS's system-assigned identity
    IoT Hub Registry Contributor on the hub. Passed in from the root module so
    the linked hub (azapi_update_resource.linked_hub) is created only after the
    identity holds the role, through terraform_data.hub_registry_role_ready.
  EOT
  type        = string
}

variable "tags" {
  description = "Tags applied to the DPS (the same tags as the IoT Hub)."
  type        = map(string)
  default     = {}
}
