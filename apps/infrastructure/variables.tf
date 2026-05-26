# MeatGeek V2 Infrastructure Variables

# Environment Configuration
variable "environment" {
  description = "Environment name (dev, staging, prod)"
  type        = string
  validation {
    condition = contains(["dev", "staging", "prod"], var.environment)
    error_message = "Environment must be one of: dev, staging, prod."
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
    condition = contains(["F1", "S1", "S2", "S3"], var.iot_hub_sku_name)
    error_message = "IoT Hub SKU must be one of: F1, S1, S2, S3."
  }
}

variable "iot_hub_sku_capacity" {
  description = "Number of IoT Hub units"
  type        = number
  default     = 1
}

# CosmosDB Configuration - Using Existing Account
variable "existing_cosmos_account_name" {
  description = "Name of your existing CosmosDB account"
  type        = string
}

variable "existing_cosmos_resource_group_name" {
  description = "Resource group name where your existing CosmosDB account is located"
  type        = string
}

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
    condition = contains(["Y1", "EP1", "EP2", "EP3"], var.functions_app_service_plan_sku)
    error_message = "Functions App Service Plan SKU must be one of: Y1 (Consumption), EP1, EP2, EP3 (Premium)."
  }
}

# SignalR Configuration
variable "signalr_sku_name" {
  description = "SKU name for SignalR Service"
  type        = string
  default     = "Free_F1"
  validation {
    condition = contains(["Free_F1", "Standard_S1"], var.signalr_sku_name)
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
  description = "Monthly budget limit in USD for cost alerts"
  type        = number
  default     = 100
}

# Admin Configuration
variable "admin_email" {
  description = "Admin email address for alerts and notifications"
  type        = string
  default     = "admin@example.com"
}
