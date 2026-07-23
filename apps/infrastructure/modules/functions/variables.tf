# Azure Functions Module Variables

variable "resource_prefix" {
  description = "Prefix for resource names"
  type        = string
}

variable "resource_group_name" {
  description = "Name of the resource group"
  type        = string
}

variable "resource_group_id" {
  description = "Resource ID of the resource group. Used as the azapi parent_id for the Functions storage account, which is created over the ARM control plane (Microsoft.Storage/storageAccounts) rather than azurerm_storage_account — the azurerm resource performs shared-key storage data-plane reads that 403 on a shared-key-disabled account (MG-24 operational fix)."
  type        = string
}

variable "location" {
  description = "Azure region"
  type        = string
}

# --- Flex Consumption scale knobs (MG-24) -----------------------------------
# The former functions_app_service_plan_sku (Y1/EP1) is REMOVED: Flex uses a
# fixed FC1 plan (set in main.tf) and is tuned by these knobs instead.

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

# App-deployment identity → deployment-container Blob Data write (MG-24 item 4).
# The SERVICE PRINCIPAL OBJECT ID of the SEPARATE app-deploy identity that Flex
# OneDeploy (`func publish` / `nx deploy api`) runs as. Flex writes the package
# ZIP to the blob deployment container, so this principal is granted Storage Blob
# Data Contributor scoped to that container alone (main.tf). Empty (default)
# skips the grant and still validates; set it (bootstrap-emitted object id) for
# any environment you deploy code to.
variable "app_deploy_principal_object_id" {
  description = "Service principal OBJECT ID of the app-deployment identity. When non-empty, this module grants it Storage Blob Data Contributor scoped to the Flex deployment container alone so `func publish`/OneDeploy can write the package ZIP. Empty (default) skips the grant and still validates."
  type        = string
  default     = ""
}

variable "storage_account_name" {
  description = "Globally-unique, Azure-valid (3-24 char, lowercase alphanumeric) name for the Functions storage account. Derived from a subscription-scoped hash in the root module so a greenfield apply cannot collide with a pre-existing account."
  type        = string
}

variable "global_suffix" {
  description = "Deterministic, subscription-derived suffix appended to the GLOBALLY-scoped Function App name so a greenfield apply cannot collide with a pre-existing Function App anywhere in Azure. Supplied by the root module (local.global_name_suffix); shared verbatim with the IoT Hub, Event Hubs namespace, and SignalR modules."
  type        = string
}

variable "application_insights_connection_string" {
  description = "FULL Terraform-managed Application Insights connection string (InstrumentationKey included), set as APPLICATIONINSIGHTS_CONNECTION_STRING. Microsoft requires the connection string — with the ikey as the destination-resource identifier — even under Entra-only ingestion. The ikey is a NON-credential here because the root module sets local_authentication_enabled=false on the App Insights resource, forcing AAD-only ingestion (the host authenticates via APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD + the Monitoring Metrics Publisher role). This residual is safe ONLY while local auth stays disabled — enforced by the pre-apply secret-inspection gate."
  type        = string
}

# --- Identity-based service endpoints (NON-SECRET) --------------------------
# These replace the former Cosmos / IoT Hub / SignalR connection-string inputs.
# They carry only endpoints/URIs; runtime authorization is via the Function
# App's managed identity + RBAC role assignments, so no secret enters state.

variable "cosmos_account_endpoint" {
  description = "Cosmos DB account endpoint URI (non-secret). Runtime access is identity-based via a Cosmos SQL data-plane role assignment."
  type        = string
}

variable "eventhub_namespace_fqdn" {
  description = "Fully-qualified Event Hubs namespace hostname (non-secret) for the IoT telemetry stream. Runtime access is identity-based via an Azure Event Hubs Data Receiver role assignment."
  type        = string
}

variable "signalr_service_uri" {
  description = "SignalR Service URI (non-secret, e.g. https://<name>.service.signalr.net). Runtime access is identity-based via a SignalR Service Owner role assignment."
  type        = string
  default     = ""
}

# --- HTTP posture (S2) ------------------------------------------------------

variable "cors_allowed_origins" {
  description = "Explicit list of allowed CORS origins for the Function App. Environment-specific (set per env in *.tfvars). Empty list => no cross-origin browser access. Wildcard '*' is intentionally NOT permitted."
  type        = list(string)
  default     = []
  validation {
    condition     = !contains(var.cors_allowed_origins, "*")
    error_message = "Wildcard CORS ('*') is not allowed; specify explicit origins per environment."
  }
}

variable "auth_active_directory_client_id" {
  description = "Entra ID (Azure AD) application client id for App Service Authentication. Empty (the default) keeps the Function App in default-DENY: authentication is required but no provider is configured, so every request is rejected at the platform layer until the auth design is finalized."
  type        = string
  default     = ""
}

variable "auth_active_directory_tenant_id" {
  description = "Entra ID tenant id used to build the auth token issuer endpoint. Only consumed when auth_active_directory_client_id is set."
  type        = string
  default     = ""
}

variable "auth_allowed_audiences" {
  description = "Allowed token audiences for App Service Authentication. Only consumed when auth_active_directory_client_id is set. Carries the API App ID URI (e.g. api://<dev-api-client-id>)."
  type        = list(string)
  default     = []
}

variable "auth_allowed_client_app_ids" {
  description = <<-EOT
    Client (CALLING) application ids allowed by Easy Auth's `allowed_applications`.
    Easy Auth's allowed_applications validates the CALLING client's appid/azp claim
    — NOT the API registration. So this must be the SMOKE-TEST CLIENT's app id(s),
    not auth_active_directory_client_id (which is the API registration and belongs
    on client_id + allowed_audiences). For the operator's
    `az account get-access-token --scope <API App ID URI>/access_as_user`, the
    calling client is the Azure CLI PUBLIC client 04b07795-8ddb-461a-bbee-02f9e1bf7b46,
    so that is the default; override with a dedicated dev client if preferred.
    Every id here MUST also be pre-authorized for the access_as_user scope on the dev
    API registration (bootstrap preAuthorizedApplications) so token acquisition needs
    no consent prompt. Only consumed when auth_active_directory_client_id is set. A
    token minted for any client NOT in this list is rejected at the platform layer.
  EOT
  type        = list(string)
  default     = ["04b07795-8ddb-461a-bbee-02f9e1bf7b46"]
  validation {
    condition     = !contains(var.auth_allowed_client_app_ids, "")
    error_message = "auth_allowed_client_app_ids must not contain an empty string; provide the calling client app id(s) (default: the Azure CLI public client)."
  }
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
