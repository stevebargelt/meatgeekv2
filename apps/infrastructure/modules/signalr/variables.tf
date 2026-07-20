# SignalR Module Variables

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

variable "signalr_sku_name" {
  description = "SKU name for SignalR Service"
  type        = string
  default     = "Free_F1"
}

variable "signalr_sku_capacity" {
  description = "Capacity for SignalR Service"
  type        = number
  default     = 1
}

variable "cors_allowed_origins" {
  description = "Explicit list of allowed CORS origins for SignalR. Environment-specific. Empty list => no cross-origin access. Wildcard '*' is intentionally NOT permitted."
  type        = list(string)
  default     = []
  validation {
    condition     = !contains(var.cors_allowed_origins, "*")
    error_message = "Wildcard CORS ('*') is not allowed; specify explicit origins per environment."
  }
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}