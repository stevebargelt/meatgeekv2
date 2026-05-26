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
  description = "SKU name for IoT Hub"
  type        = string
  default     = "S1"
}

variable "iot_hub_sku_capacity" {
  description = "Capacity for IoT Hub"
  type        = number
  default     = 1
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}