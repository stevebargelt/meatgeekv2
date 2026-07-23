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

# Azure Functions Configuration — FLEX CONSUMPTION (MG-24).
# The former functions_app_service_plan_sku (Y1/EP1) is REMOVED: a single Flex
# Consumption model runs both dev and prod on the fixed FC1 plan, tuned by the
# knobs below instead of a plan SKU.
variable "instance_memory_in_mb" {
  description = "Per-instance memory (MB) for the Flex Consumption plan. Allowed Flex tiers: 512, 2048, 4096."
  type        = number
  default     = 2048
  validation {
    condition     = contains([512, 2048, 4096], var.instance_memory_in_mb)
    error_message = "instance_memory_in_mb must be one of the Flex-supported tiers: 512, 2048, or 4096."
  }
}

variable "maximum_instance_count" {
  description = "Maximum number of instances the Flex Consumption app may scale out to (horizontal ceiling / cost bound)."
  type        = number
  default     = 100
  validation {
    condition     = var.maximum_instance_count >= 1 && var.maximum_instance_count <= 1000
    error_message = "maximum_instance_count must be between 1 and 1000."
  }
}

variable "always_ready" {
  description = "Number of always-ready (pre-warmed) HTTP instances. 0 (dev) => scale-to-zero, ~$0 idle. >=1 (prod) => a warm baseline so the first post-idle request is not cold."
  type        = number
  default     = 0
  validation {
    condition     = var.always_ready >= 0
    error_message = "always_ready must be non-negative (0 = scale-to-zero)."
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
  description = "Allowed token audiences for Function App authentication (only used when functions_auth_client_id is set). Carries the API App ID URI (e.g. api://<dev-api-client-id>)."
  type        = list(string)
  default     = []
}

variable "functions_auth_allowed_client_app_ids" {
  description = "Client (CALLING) application ids allowed by the Function App's Easy Auth allowed_applications. This validates the calling client's appid/azp — NOT the API registration (functions_auth_client_id). Defaults to the Azure CLI public client (04b07795-8ddb-461a-bbee-02f9e1bf7b46), which is the caller for `az account get-access-token --scope <API App ID URI>/access_as_user`; override with a dedicated dev client. Each id must be pre-authorized on the dev API registration (bootstrap preAuthorizedApplications). Only used when functions_auth_client_id is set."
  type        = list(string)
  default     = ["04b07795-8ddb-461a-bbee-02f9e1bf7b46"]
}

# App-deployment identity → Function App publish RBAC (MG-24 item 4).
# The SERVICE PRINCIPAL OBJECT ID (not the appId/client id) of the SEPARATE
# app-deployment identity that `func publish` runs as. It is created by the
# bootstrap (Part 1) BEFORE this apply, and the bootstrap emits its object id as
# AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID. Setting it here makes THIS apply create
# the `Website Contributor` role assignment (scoped to the Function App alone)
# in the SAME apply that creates the Function App — so `func publish` works
# immediately after, with no missing post-apply grant step. Left empty (default)
# the assignment is skipped and the plan still validates; REQUIRED for any
# environment you intend to deploy code to.
variable "app_deploy_principal_object_id" {
  description = "Service principal OBJECT ID of the app-deployment identity (bootstrap-emitted AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID). When non-empty, this apply grants it Website Contributor scoped to the Function App alone so `func publish` works post-apply. Empty (default) skips the grant and still validates; required for a deployable environment."
  type        = string
  default     = ""
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

# Native Azure Monitor OTLP path (MG-33 F1/F3) — DEFAULT-OFF.
# Gates the entire native-otlp module (collector Container App + DCE + DCR + UAI
# + DCR-scoped role assignment). false => the module is not instantiated and ZERO
# net-new resources are created, so `terraform validate`/`plan` are unchanged.
# Flip to true ONLY after MG-24 (Container Apps env) + MG-25 (native-OTLP preview
# acceptance) + MG-34 (secure edge ingress) — production activation is deliberate.
variable "enable_native_otlp" {
  description = "Enable the native Azure Monitor OTLP telemetry path (MG-33 F1/F3). Default false: no resources created; validate/plan unchanged. Flip on only after MG-24/MG-25/MG-34."
  type        = bool
  default     = false
}

variable "container_app_environment_id" {
  description = "Resource id of the Container Apps managed environment (created by MG-24 bootstrap) that hosts the native-OTLP collector. Empty until MG-24 lands; required (non-empty) before enable_native_otlp can be flipped on."
  type        = string
  default     = ""
}

variable "otlp_collector_storage_name" {
  description = "Name of the Container Apps environment storage (Azure File share) association backing the native-OTLP collector's persistent spool. Provisioned under MG-24; empty until then."
  type        = string
  default     = ""
}

# Admin Configuration
variable "admin_email" {
  description = "Admin email address for alerts and notifications"
  type        = string
  default     = "admin@example.com"
}
