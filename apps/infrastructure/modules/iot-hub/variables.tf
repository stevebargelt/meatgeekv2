# IoT Hub Module Variables

variable "resource_prefix" {
  description = "Prefix for resource names"
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

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
