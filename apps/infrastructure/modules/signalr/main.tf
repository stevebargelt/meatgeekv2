# SignalR Service Module for MeatGeek V2

# SignalR Service
resource "azurerm_signalr_service" "main" {
  name                = "${var.resource_prefix}-signalr"
  resource_group_name = var.resource_group_name
  location           = var.location

  sku {
    name     = var.signalr_sku_name
    capacity = var.signalr_sku_capacity
  }

  # Service mode configuration
  service_mode                 = "Default"
  connectivity_logs_enabled    = true
  messaging_logs_enabled       = true
  http_request_logs_enabled    = true

  # CORS configuration for web clients
  cors {
    allowed_origins = ["*"]
  }


  tags = var.tags
}