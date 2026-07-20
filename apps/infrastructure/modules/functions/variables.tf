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

variable "storage_account_name" {
  description = "Globally-unique, Azure-valid (3-24 char, lowercase alphanumeric) name for the Functions storage account. Derived from a subscription-scoped hash in the root module so a greenfield apply cannot collide with a pre-existing account."
  type        = string
}

variable "application_insights_ingestion_endpoint" {
  description = "Non-secret Application Insights ingestion endpoint URL (the IngestionEndpoint parsed out of the AI connection string in the root module). Telemetry ingestion is identity-based (AAD): the Function App's managed identity is granted 'Monitoring Metrics Publisher' on the App Insights resource and the host authenticates with APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD, so NO instrumentation/ingestion key or secret connection-string value is placed in app_settings or Terraform state."
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
  description = "Allowed token audiences for App Service Authentication. Only consumed when auth_active_directory_client_id is set."
  type        = list(string)
  default     = []
}

variable "tags" {
  description = "Tags to apply to resources"
  type        = map(string)
  default     = {}
}
