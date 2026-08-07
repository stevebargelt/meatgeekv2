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

variable "cosmos_database_id" {
  description = <<-EOT
    Resource ID of the Cosmos SQL database that owns the routing target container.
    It exists ONLY to carry that database's IDENTITY across the module boundary
    (MG-48). cosmos_database_name above is a CONFIGURED literal — byte-identical
    before and after the database is destroyed and recreated — so a name tells this
    module what the database is called but erases, at the boundary, whether the
    thing it names still exists. An id is COMPUTED and changes on replacement,
    which is what lets the Cosmos routing endpoint both order after the database
    and be replaced with it (see terraform_data.cosmos_target_ready in main.tf).
    The names stay because the Azure API writes the literal names into the
    endpoint; the ids are what carry existence.
  EOT
  type        = string
}

variable "cosmos_container_id" {
  description = <<-EOT
    Resource ID of the Cosmos container receiving routed device telemetry. Same
    role as cosmos_database_id above — identity, not name — so the routing
    endpoint depends on the container EXISTING and is replaced along with it.
  EOT
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
