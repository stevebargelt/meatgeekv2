# CosmosDB Module Variables - For Existing Account Usage

variable "resource_prefix" {
  description = "Prefix for resource names (e.g., meatgeek-dev)"
  type        = string
}

variable "existing_cosmos_account_name" {
  description = "Name of the existing CosmosDB account to use"
  type        = string
}

variable "existing_cosmos_resource_group_name" {
  description = "Resource group name where the existing CosmosDB account is located"
  type        = string
}

# Database configuration
variable "database_throughput" {
  description = "Shared throughput for the database (RU/s)"
  type        = number
  default     = 400
  validation {
    condition     = var.database_throughput >= 200 && var.database_throughput <= 100000
    error_message = "Database throughput must be between 200 and 100,000 RU/s."
  }
}

variable "database_max_throughput" {
  description = "Maximum throughput for auto-scaling (RU/s)"
  type        = number
  default     = 4000
  validation {
    condition     = var.database_max_throughput >= 200
    error_message = "Max throughput must be at least 200 RU/s (minimum for auto-scaling)."
  }
}

# TTL configuration for temperature data
variable "temperature_data_ttl" {
  description = "TTL for temperature data in seconds (default: 90 days)"
  type        = number
  default     = 7776000 # 90 days
}

# Container-specific configurations
variable "enable_container_auto_scale" {
  description = "Enable auto-scaling for containers"
  type        = bool
  default     = false
}

variable "indexing_mode" {
  description = "Indexing mode for containers"
  type        = string
  default     = "consistent"
  validation {
    condition     = contains(["consistent", "lazy", "none"], var.indexing_mode)
    error_message = "Indexing mode must be one of: consistent, lazy, none."
  }
}

# Backup configuration
variable "backup_policy" {
  description = "Backup policy configuration"
  type = object({
    type                = string # "Periodic" or "Continuous"
    interval_in_minutes = optional(number, 240) # 4 hours default
    retention_in_hours  = optional(number, 168) # 7 days default
  })
  default = {
    type                = "Periodic"
    interval_in_minutes = 240
    retention_in_hours  = 168
  }
}

# Multi-region settings (for production)
variable "enable_multiple_write_locations" {
  description = "Enable multiple write locations for CosmosDB"
  type        = bool
  default     = false
}

variable "failover_locations" {
  description = "Failover locations for CosmosDB"
  type = list(object({
    location          = string
    failover_priority = number
    zone_redundant    = optional(bool, false)
  }))
  default = []
}

# Environment-specific settings
variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}