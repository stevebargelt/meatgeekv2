# CosmosDB Module Variables - For the V2-OWNED account

variable "resource_prefix" {
  description = "Prefix for resource names (e.g., meatgeek-v2-dev)"
  type        = string
}

# --- V2-owned account inputs (contract A) ---

variable "cosmos_account_name" {
  description = "Globally-unique name for the V2-owned CosmosDB account. Sanitized to Azure's rule (3-44 chars, lowercase alphanumeric + hyphen) inside the module."
  type        = string
}

variable "resource_group_name" {
  description = "Resource group in which to create the V2-owned CosmosDB account"
  type        = string
}

variable "location" {
  description = "Azure region for the V2-owned CosmosDB account"
  type        = string
}

# Consistency configuration
variable "consistency_level" {
  description = "CosmosDB consistency level"
  type        = string
  default     = "Session"
  validation {
    condition     = contains(["BoundedStaleness", "Eventual", "Session", "Strong", "ConsistentPrefix"], var.consistency_level)
    error_message = "Consistency level must be one of: BoundedStaleness, Eventual, Session, Strong, ConsistentPrefix."
  }
}

variable "consistency_max_interval_in_seconds" {
  description = "Max lag interval (seconds) - only used when consistency_level is BoundedStaleness"
  type        = number
  default     = 300
}

variable "consistency_max_staleness_prefix" {
  description = "Max staleness prefix (operations) - only used when consistency_level is BoundedStaleness"
  type        = number
  default     = 100000
}

# Free-tier knob (one free-tier account allowed per subscription; dev-only)
variable "enable_free_tier" {
  description = "Enable the CosmosDB free tier for the V2 account (one per subscription)"
  type        = bool
  default     = false
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
    type                = string                # "Periodic" or "Continuous"
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
  description = "Additional read/failover regions for CosmosDB (production only)"
  type = list(object({
    location          = string
    failover_priority = number
    zone_redundant    = optional(bool, false)
  }))
  default = []
}

# Environment-specific settings
variable "environment" {
  description = "Environment name (dev, prod)"
  type        = string
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
