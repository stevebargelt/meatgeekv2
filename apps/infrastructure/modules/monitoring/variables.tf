# Monitoring Module Variables

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

variable "log_analytics_workspace_id" {
  description = "Log Analytics Workspace ID"
  type        = string
}

variable "application_insights_id" {
  description = "Application Insights ID"
  type        = string
}

variable "iot_hub_id" {
  description = "IoT Hub ID"
  type        = string
}

variable "cosmos_db_id" {
  description = "CosmosDB ID"
  type        = string
}

variable "function_app_id" {
  description = "Function App ID"
  type        = string
}

variable "admin_email" {
  description = "Admin email for alerts"
  type        = string
  default     = "admin@example.com"
}

variable "budget_limit" {
  description = "Monthly budget limit in USD"
  type        = number
  default     = 100
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}