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

variable "log_analytics_workspace_name" {
  description = "Log Analytics Workspace name (used by the ingestion-cap metric alert dimension)"
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
  description = "CosmosDB account ID"
  type        = string
}

variable "function_app_id" {
  description = "Function App ID"
  type        = string
}

variable "signalr_id" {
  description = "SignalR Service ID"
  type        = string
}

variable "subscription_id" {
  description = "Azure Subscription ID (GUID only; the secondary subscription-scope budget prepends /subscriptions/)"
  type        = string
}

variable "admin_email" {
  description = "Admin email for alerts"
  type        = string
  default     = "admin@example.com"
}

variable "budget_limit" {
  description = "Monthly resource-group budget limit in USD (primary)"
  type        = number
  default     = 100
}

variable "secondary_budget_limit" {
  description = "Monthly subscription-scope secondary budget limit in USD (warning before Azure credit exhausted)"
  type        = number
  default     = 150
}

variable "ingestion_cap_gb" {
  description = "Daily ingestion cap (GB/day) configured on the Log Analytics workspace; used as the alert threshold for ingestion-cap-reached"
  type        = number
  default     = 2
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
