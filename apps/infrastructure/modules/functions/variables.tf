# Azure Functions Module Variables

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

variable "functions_app_service_plan_sku" {
  description = "SKU for the App Service Plan"
  type        = string
  default     = "Y1"
}

variable "application_insights_connection_string" {
  description = "Application Insights connection string"
  type        = string
  sensitive   = true
}

variable "cosmos_connection_string" {
  description = "CosmosDB connection string"
  type        = string
  sensitive   = true
}

variable "iot_hub_connection_string" {
  description = "IoT Hub connection string"
  type        = string
  sensitive   = true
}

variable "signalr_connection_string" {
  description = "SignalR connection string"
  type        = string
  sensitive   = true
  default     = ""
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}