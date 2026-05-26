# Monitoring Module for MeatGeek V2

# Action Group for alerts
resource "azurerm_monitor_action_group" "main" {
  name                = "${var.resource_prefix}-alerts"
  resource_group_name = var.resource_group_name
  short_name          = "meatgeek"

  email_receiver {
    name          = "admin"
    email_address = var.admin_email
  }

  tags = var.tags
}

# Budget alert for cost monitoring
resource "azurerm_consumption_budget_resource_group" "main" {
  name              = "${var.resource_prefix}-budget"
  resource_group_id = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/resourceGroups/${var.resource_group_name}"

  amount     = var.budget_limit
  time_grain = "Monthly"

  time_period {
    start_date = formatdate("YYYY-MM-01'T'00:00:00'Z'", timestamp())
  }

  notification {
    enabled   = true
    threshold = 80
    operator  = "GreaterThan"
    
    contact_emails = [
      var.admin_email
    ]
  }

  notification {
    enabled   = true
    threshold = 100
    operator  = "GreaterThan"
    
    contact_emails = [
      var.admin_email
    ]
  }
}

# Data source for current client config
data "azurerm_client_config" "current" {}