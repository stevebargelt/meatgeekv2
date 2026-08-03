# SignalR Service Module for MeatGeek V2

# Provider requirements (MG-39). An unconstrained module resolves the LATEST
# azurerm on a standalone init — v5.0.1 as of 2026-08-03, a breaking major. This
# codebase targets azurerm 4.x; v5 is a separate, deliberate migration.
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

# SignalR Service
resource "azurerm_signalr_service" "main" {
  name                = "${var.resource_prefix}-signalr-${var.global_suffix}"
  resource_group_name = var.resource_group_name
  location            = var.location

  sku {
    name     = var.signalr_sku_name
    capacity = var.signalr_sku_capacity
  }

  # Disable local (AccessKey-based) authentication so the service's inherent
  # computed key attributes (primary_access_key, primary_connection_string) —
  # stored in state for any managed resource — CANNOT authenticate. Access is
  # AAD-only: the Function App connects identity-based via the non-secret
  # `AzureSignalRConnectionString__serviceUri` setting and holds the "SignalR
  # Service Owner" role (root module), which keeps working with local auth off.
  # This makes the in-state key a present-but-non-authenticating residual
  # (MG-24 ADR). The pre-apply secret-inspection gate rejects this service if
  # this flag is ever flipped back to true.
  local_auth_enabled = false

  # Service mode configuration
  service_mode              = "Default"
  connectivity_logs_enabled = true
  messaging_logs_enabled    = true
  http_request_logs_enabled = true

  # CORS configuration for web clients — explicit per-environment origins
  # (no wildcard). Empty list => no cross-origin access permitted (S2).
  cors {
    allowed_origins = var.cors_allowed_origins
  }


  tags = var.tags
}