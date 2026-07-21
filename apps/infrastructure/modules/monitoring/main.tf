# Monitoring Module for MeatGeek V2
#
# Phase 1 observability layer: action group + budgets + diagnostic settings +
# 5 platform-metric alerts + workbook stub. The 5 custom-metric alerts
# (device-disconnected, real-time error rate, storage p95 latency,
# temp-out-of-safe-range, cook-idle) intentionally land in ticket #6 alongside
# the StandardDimensions emitter — wiring them now produces always-green
# alerts (no telemetry source emits the required custom metrics yet),
# which is the anti-pattern the architect's synthesis called out.

# Budget start-date anchor. `time_static` captures the apply time ONCE and then
# persists it in state, so `time_static.budget_anchor.rfc3339` is stable across
# subsequent plans/applies. Deriving the budget start_date from this (instead of
# from the wall-clock time, which re-evaluates on every plan) keeps the first-of-month
# start date fixed and guarantees a 2nd-plan no-op even across a month boundary.
resource "time_static" "budget_anchor" {}

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

# Budget alert for cost monitoring (resource-group scope, primary)
resource "azurerm_consumption_budget_resource_group" "main" {
  name              = "${var.resource_prefix}-budget"
  resource_group_id = "/subscriptions/${data.azurerm_client_config.current.subscription_id}/resourceGroups/${var.resource_group_name}"

  amount     = var.budget_limit
  time_grain = "Monthly"

  time_period {
    start_date = formatdate("YYYY-MM-01'T'00:00:00'Z'", time_static.budget_anchor.rfc3339)
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

# -----------------------------------------------------------------------------
# Diagnostic settings: route platform/resource logs + metrics to the workspace
# Categories are scoped to what the o11y story actually needs — verbose
# categories are intentionally omitted to stay under the 2 GB/day cap.
# -----------------------------------------------------------------------------

resource "azurerm_monitor_diagnostic_setting" "iot_hub" {
  name                       = "${var.resource_prefix}-iothub-diag"
  target_resource_id         = var.iot_hub_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "Connections"
  }
  enabled_log {
    category = "DeviceTelemetry"
  }
  enabled_log {
    category = "Routes"
  }
  enabled_log {
    category = "C2DCommands"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "cosmos_db" {
  name                       = "${var.resource_prefix}-cosmos-diag"
  target_resource_id         = var.cosmos_db_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "DataPlaneRequests"
  }
  enabled_log {
    category = "QueryRuntimeStatistics"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "function_app" {
  name                       = "${var.resource_prefix}-functions-diag"
  target_resource_id         = var.function_app_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "FunctionAppLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

resource "azurerm_monitor_diagnostic_setting" "signalr" {
  name                       = "${var.resource_prefix}-signalr-diag"
  target_resource_id         = var.signalr_id
  log_analytics_workspace_id = var.log_analytics_workspace_id

  enabled_log {
    category = "ConnectivityLogs"
  }
  enabled_log {
    category = "MessagingLogs"
  }
  enabled_log {
    category = "HttpRequestLogs"
  }

  enabled_metric {
    category = "AllMetrics"
  }
}

# -----------------------------------------------------------------------------
# 5 platform-metric alerts wired to the existing action group.
# Custom-metric alerts (device-disconnected, real-time error rate,
# storage p95 latency, temp-out-of-safe-range, cook-idle) are deferred to #6.
# -----------------------------------------------------------------------------

resource "azurerm_monitor_metric_alert" "function_failure_rate" {
  name                = "${var.resource_prefix}-function-failure-rate"
  resource_group_name = var.resource_group_name
  scopes              = [var.function_app_id]
  description         = "Function execution failures > 5 over a 5m window"
  severity            = 2
  frequency           = "PT1M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.Web/sites"
    metric_name      = "FunctionExecutionCount"
    aggregation      = "Total"
    operator         = "GreaterThan"
    threshold        = 5

    dimension {
      name     = "Status"
      operator = "Include"
      values   = ["Failed"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = var.tags
}

resource "azurerm_monitor_metric_alert" "cosmos_429_rate" {
  name                = "${var.resource_prefix}-cosmos-429-rate"
  resource_group_name = var.resource_group_name
  scopes              = [var.cosmos_db_id]
  description         = "Any Cosmos DB 429 throttling responses over a 5m window"
  severity            = 2
  frequency           = "PT1M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.DocumentDB/databaseAccounts"
    metric_name      = "TotalRequests"
    aggregation      = "Count"
    operator         = "GreaterThan"
    threshold        = 0

    dimension {
      name     = "StatusCode"
      operator = "Include"
      values   = ["429"]
    }
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = var.tags
}

resource "azurerm_monitor_metric_alert" "signalr_connection_failure_rate" {
  name                = "${var.resource_prefix}-signalr-connection-failure-rate"
  resource_group_name = var.resource_group_name
  scopes              = [var.signalr_id]
  description         = "SignalR system errors > 5 over a 5m window"
  severity            = 2
  frequency           = "PT1M"
  window_size         = "PT5M"

  criteria {
    metric_namespace = "Microsoft.SignalRService/SignalR"
    metric_name      = "SystemErrors"
    aggregation      = "Maximum"
    operator         = "GreaterThan"
    threshold        = 5
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = var.tags
}

# Ingestion-cap-reached alert: MUST be a platform metric alert on the workspace
# resource, NOT a KQL log-search alert. Reason: a log-search query against the
# workspace becomes self-referential when the cap is reached — ingestion stops,
# so the query that watches for the cap also stops returning data, masking the
# very condition it is supposed to detect. Heartbeat absence is used as the
# signal: when ingestion is capped, heartbeats stop arriving in the workspace.
resource "azurerm_monitor_metric_alert" "ingestion_cap_reached" {
  name                = "${var.resource_prefix}-ingestion-cap-reached"
  resource_group_name = var.resource_group_name
  scopes              = [var.log_analytics_workspace_id]
  description         = "Workspace '${var.log_analytics_workspace_name}' ingestion stopped — likely daily cap reached (cap=${var.ingestion_cap_gb} GB/day)"
  severity            = 1
  frequency           = "PT5M"
  window_size         = "PT15M"

  criteria {
    metric_namespace = "Microsoft.OperationalInsights/workspaces"
    metric_name      = "Heartbeat"
    aggregation      = "Count"
    operator         = "LessThanOrEqual"
    threshold        = 0
  }

  action {
    action_group_id = azurerm_monitor_action_group.main.id
  }

  tags = var.tags
}

# Secondary subscription-scope budget — warning before the $200 Azure credit
# is exhausted. Resource-group budget (above) is the primary; this one catches
# any spend that lands outside the meatgeek-{env}-rg group.
resource "azurerm_consumption_budget_subscription" "credit_budget" {
  name            = "${var.resource_prefix}-credit-budget"
  subscription_id = "/subscriptions/${var.subscription_id}"

  amount     = var.secondary_budget_limit
  time_grain = "Monthly"

  time_period {
    start_date = formatdate("YYYY-MM-01'T'00:00:00'Z'", time_static.budget_anchor.rfc3339)
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

# -----------------------------------------------------------------------------
# Workbook stub — content lands in ticket #6.
# -----------------------------------------------------------------------------
resource "azurerm_application_insights_workbook" "main" {
  name                = "5a3c1d2e-7b4f-4a0e-9c1a-000000000006"
  resource_group_name = var.resource_group_name
  location            = var.location
  display_name        = "${var.resource_prefix}-observability"

  data_json = jsonencode({
    version = "Notebook/1.0"
    items = [
      {
        type = 1
        content = {
          json = "Populated in ticket #6"
        }
      }
    ]
    isLocked = false
    fallbackResourceIds = [
      "Azure Monitor"
    ]
  })

  tags = merge(var.tags, {
    Service = "Monitoring"
  })
}
