# IoT Hub Module Variables

variable "resource_prefix" {
  description = "Prefix for resource names"
  type        = string
}

variable "global_suffix" {
  description = "Subscription-derived suffix appended to globally-scoped resource names (IoT Hub, Event Hubs namespace) to guarantee cross-tenant DNS uniqueness (MG-24 item 9)."
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

variable "iot_hub_sku_name" {
  description = "SKU name for IoT Hub (must be S1 or higher for custom routing)"
  type        = string
  default     = "S1"
}

variable "iot_hub_sku_capacity" {
  description = "Capacity for IoT Hub"
  type        = number
  default     = 1
}

variable "cosmos_account_endpoint" {
  description = "Cosmos DB account endpoint URI used by the IoT Hub routing endpoint"
  type        = string
}

variable "cosmos_database_name" {
  description = "Cosmos DB database name that owns the routing target container"
  type        = string
}

variable "cosmos_container_name" {
  description = "Cosmos DB container name receiving routed device telemetry"
  type        = string
}

variable "cosmos_role_assignment_id" {
  description = <<-EOT
    ID of the Cosmos DB SQL data-plane role assignment ("Cosmos DB Built-in Data
    Contributor") that grants THIS IoT Hub's system-assigned identity write access
    to the routing target. Passed in from the root module so the Cosmos routing
    endpoint (azurerm_iothub_endpoint_cosmosdb_account.cosmos_storage) can gate on
    it — the endpoint is validated with the identity, so it must be created only
    AFTER the role exists (MG-24). Threading the id (rather than making the whole
    module depend on the role) keeps the graph acyclic: the role assignment itself
    depends on this module's identity_principal_id output, and only the endpoint —
    not azurerm_iothub.main — consumes this handle.
  EOT
  type        = string
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
