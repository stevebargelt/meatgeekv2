# MeatGeek V2 Infrastructure Variables

# Azure Subscription
variable "subscription_id" {
  description = "Azure subscription ID for the V2 stack. Leave null (the default) to resolve it from the authenticated environment (ARM_SUBSCRIPTION_ID / OIDC federated credential). Set explicitly only for local operator runs."
  type        = string
  default     = null
}

# Environment Configuration
variable "environment" {
  description = "Environment name (dev, prod)"
  type        = string
  validation {
    condition     = contains(["dev", "prod"], var.environment)
    error_message = "Environment must be one of: dev, prod."
  }
}

variable "location" {
  description = "Azure region for resource deployment"
  type        = string
  default     = "North Central US"
}

# Application Insights Configuration
variable "appinsights_retention_days" {
  description = "Retention period in days for Application Insights data"
  type        = number
  default     = 90
}

# Log Analytics Configuration
variable "log_retention_days" {
  description = "Retention period in days for Log Analytics data"
  type        = number
  default     = 30
}

# IoT Hub Configuration
variable "iot_hub_sku_name" {
  description = "SKU name for IoT Hub"
  type        = string
  default     = "S1"
  validation {
    condition     = contains(["F1", "S1", "S2", "S3"], var.iot_hub_sku_name)
    error_message = "IoT Hub SKU must be one of: F1, S1, S2, S3."
  }
}

variable "iot_hub_sku_capacity" {
  description = "Number of IoT Hub units"
  type        = number
  default     = 1
}

# CosmosDB Configuration - V2 CREATES and OWNS its Cosmos account.
# The account name is derived deterministically in main.tf (local.cosmos_account_name)
# and the account is provisioned inside the V2 resource group by the cosmos-db module,
# so there are no existing/shared-account inputs here anymore.
variable "cosmos_database_throughput" {
  description = "Shared throughput for the environment-specific database (RU/s)"
  type        = number
  default     = 400
  validation {
    condition     = var.cosmos_database_throughput >= 200 && var.cosmos_database_throughput <= 100000
    error_message = "Database throughput must be between 200 and 100,000 RU/s."
  }
}

variable "cosmos_database_max_throughput" {
  description = "Maximum throughput for database auto-scaling (RU/s)"
  type        = number
  default     = 4000
  validation {
    condition     = var.cosmos_database_max_throughput >= 200
    error_message = "Max throughput must be at least 200 RU/s (minimum for auto-scaling)."
  }
}

variable "temperature_data_ttl_days" {
  description = "TTL for temperature data in days"
  type        = number
  default     = 90
  validation {
    condition     = var.temperature_data_ttl_days >= 1 && var.temperature_data_ttl_days <= 365
    error_message = "Temperature data TTL must be between 1 and 365 days."
  }
}

# Azure Functions Configuration
variable "functions_app_service_plan_sku" {
  description = "SKU for Azure Functions App Service Plan"
  type        = string
  default     = "Y1" # Consumption plan
  validation {
    condition     = contains(["Y1", "EP1", "EP2", "EP3"], var.functions_app_service_plan_sku)
    error_message = "Functions App Service Plan SKU must be one of: Y1 (Consumption), EP1, EP2, EP3 (Premium)."
  }
}

# SignalR Configuration
variable "signalr_sku_name" {
  description = "SKU name for SignalR Service"
  type        = string
  default     = "Free_F1"
  validation {
    condition     = contains(["Free_F1", "Standard_S1"], var.signalr_sku_name)
    error_message = "SignalR SKU must be one of: Free_F1, Standard_S1."
  }
}

variable "signalr_sku_capacity" {
  description = "Capacity for SignalR Service"
  type        = number
  default     = 1
}

# Device Configuration
variable "device_count" {
  description = "Expected number of devices to provision for"
  type        = number
  default     = 10
}

variable "max_daily_messages" {
  description = "Maximum expected daily messages across all devices"
  type        = number
  default     = 100000
}

# HTTP posture (MG-24 S2) — explicit per-environment CORS + optional auth.
variable "functions_cors_allowed_origins" {
  description = "Explicit allowed CORS origins for the Function App (per environment). Empty => no cross-origin browser access. Wildcard '*' is rejected."
  type        = list(string)
  default     = []
  validation {
    condition     = !contains(var.functions_cors_allowed_origins, "*")
    error_message = "Wildcard CORS ('*') is not allowed for the Function App; specify explicit origins per environment."
  }
}

variable "signalr_cors_allowed_origins" {
  description = "Explicit allowed CORS origins for SignalR (per environment). Empty => no cross-origin access. Wildcard '*' is rejected."
  type        = list(string)
  default     = []
  validation {
    condition     = !contains(var.signalr_cors_allowed_origins, "*")
    error_message = "Wildcard CORS ('*') is not allowed for SignalR; specify explicit origins per environment."
  }
}

variable "functions_auth_client_id" {
  description = "Entra ID application client id for Function App App Service Authentication. Empty (default) keeps the Function App in default-DENY (require_authentication with no provider) until the auth design is finalized."
  type        = string
  default     = ""
}

variable "functions_auth_tenant_id" {
  description = "Entra ID tenant id for Function App authentication (only used when functions_auth_client_id is set)."
  type        = string
  default     = ""
}

variable "functions_auth_allowed_audiences" {
  description = "Allowed token audiences for Function App authentication (only used when functions_auth_client_id is set)."
  type        = list(string)
  default     = []
}

# Security Configuration
variable "allowed_ip_ranges" {
  description = "IP ranges allowed to access resources (CIDR notation)"
  type        = list(string)
  default     = ["0.0.0.0/0"] # Default allows all - should be restricted in production
}

# Backup and Disaster Recovery
variable "enable_backup" {
  description = "Enable automated backups for applicable resources"
  type        = bool
  default     = true
}

variable "backup_retention_days" {
  description = "Number of days to retain backups"
  type        = number
  default     = 7
}

# Cost Management
variable "auto_shutdown_enabled" {
  description = "Enable auto-shutdown for development resources"
  type        = bool
  default     = false
}

variable "budget_limit" {
  description = "Monthly budget limit in USD for cost alerts (resource group scope)"
  type        = number
  default     = 100
}

variable "secondary_budget_limit" {
  description = "Secondary subscription-level budget limit in USD (warning before Azure credit exhausted)"
  type        = number
  default     = 150
}

# Observability / Azure Monitor cost control
variable "ingestion_cap_gb" {
  description = "Daily ingestion cap (GB/day) on the Log Analytics workspace. Hard guardrail against runaway Azure Monitor cost."
  type        = number
  default     = 2
  validation {
    condition     = var.ingestion_cap_gb >= 1 && var.ingestion_cap_gb <= 10
    error_message = "ingestion_cap_gb must be between 1 and 10 (inclusive)."
  }
}

# Admin Configuration
variable "admin_email" {
  description = "Admin email address for alerts and notifications"
  type        = string
  default     = "admin@example.com"
}
