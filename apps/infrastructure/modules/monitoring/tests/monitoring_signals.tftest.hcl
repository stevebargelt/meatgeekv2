# Plan-level regression test for the two Flex/real-Azure monitoring defects found
# on the live MG-24 apply (MG-24 monitoring fixes):
#
#   1. SignalR diagnostic setting must use the `allLogs` category GROUP — the
#      Free_F1 SignalR tier exposes NO individual ConnectivityLogs/MessagingLogs/
#      HttpRequestLogs categories, so the former three enabled_log{category=...}
#      blocks were rejected by Azure.
#   2. The function-failure alert must target the App Insights resource with
#      metric_namespace=microsoft.insights/components + metric_name=requests/failed.
#      The Flex Function App has NO platform failure metric (FunctionExecutionCount
#      does not exist) and NO Status dimension, so the alert is repointed to AI.
#
# Runs the module as the config-under-test with MOCKED providers — NO live Azure,
# NO credentials, NO apply.
#
# Run:  terraform -chdir=apps/infrastructure/modules/monitoring test
# (init the module dir with `terraform init -backend=false` first).

mock_provider "azurerm" {}
mock_provider "time" {}

variables {
  resource_prefix              = "meatgeek-v2-dev"
  resource_group_name          = "meatgeek-v2-dev-rg"
  location                     = "westus2"
  log_analytics_workspace_id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.OperationalInsights/workspaces/mgv2dev-law"
  log_analytics_workspace_name = "mgv2dev-law"
  application_insights_id      = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Insights/components/mgv2dev-ai"
  iot_hub_id                   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Devices/IotHubs/mgv2dev-iothub"
  cosmos_db_id                 = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.DocumentDB/databaseAccounts/mgv2dev-cosmos"
  function_app_id              = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Web/sites/mgv2dev-func"
  signalr_id                   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.SignalRService/SignalR/mgv2dev-signalr"
  # Non-UUID placeholder — the tf-static-checks subscription-id guard forbids a
  # literal `subscription_id = "<uuid>"`, and the mocked provider needs no real GUID.
  subscription_id = "00000000000000000000000000000000"
}

# Defect 1 — SignalR diag uses the `allLogs` category GROUP, not individual
# ConnectivityLogs/MessagingLogs/HttpRequestLogs categories (Free_F1 exposes none
# of them). AllMetrics is retained.
run "signalr_diag_uses_alllogs_category_group" {
  command = plan

  # Exactly one enabled_log block, and it selects the group — not an individual
  # category. (mutation-check: reverting to three category blocks flips length to 3.)
  assert {
    condition     = length(azurerm_monitor_diagnostic_setting.signalr.enabled_log) == 1
    error_message = "SignalR diag must have exactly one enabled_log block (the allLogs category group)"
  }
  assert {
    condition     = one([for l in azurerm_monitor_diagnostic_setting.signalr.enabled_log : l.category_group]) == "allLogs"
    error_message = "SignalR diag enabled_log must use category_group = \"allLogs\""
  }
  # NEGATIVE — none of the rejected individual categories may be present.
  assert {
    condition     = alltrue([for l in azurerm_monitor_diagnostic_setting.signalr.enabled_log : !contains(["ConnectivityLogs", "MessagingLogs", "HttpRequestLogs"], coalesce(l.category, "none"))])
    error_message = "SignalR diag must NOT set individual log categories (Free_F1 exposes only the allLogs group)"
  }
  # AllMetrics retained.
  assert {
    condition     = one([for m in azurerm_monitor_diagnostic_setting.signalr.enabled_metric : m.category]) == "AllMetrics"
    error_message = "SignalR diag must keep enabled_metric category = AllMetrics"
  }
}

# Defect 2 — the function-failure alert targets App Insights (not the Function
# App) and uses the AI requests/failed metric (not the non-existent Flex platform
# metric FunctionExecutionCount), with no Status dimension.
run "function_failure_alert_targets_app_insights_requests_failed" {
  command = plan

  # Scope is the App Insights resource id, NOT the Function App id.
  assert {
    condition     = contains(azurerm_monitor_metric_alert.function_failure_rate.scopes, var.application_insights_id)
    error_message = "function_failure_rate must scope to the Application Insights resource id"
  }
  assert {
    condition     = !contains(azurerm_monitor_metric_alert.function_failure_rate.scopes, var.function_app_id)
    error_message = "function_failure_rate must NOT scope to the Function App (Flex has no platform failure metric)"
  }
  # AI metric namespace + metric name.
  assert {
    condition     = one(azurerm_monitor_metric_alert.function_failure_rate.criteria).metric_namespace == "microsoft.insights/components"
    error_message = "function_failure_rate metric_namespace must be microsoft.insights/components"
  }
  assert {
    condition     = one(azurerm_monitor_metric_alert.function_failure_rate.criteria).metric_name == "requests/failed"
    error_message = "function_failure_rate metric_name must be requests/failed"
  }
  # NEGATIVE — the rejected Flex platform metric must be gone.
  assert {
    condition     = one(azurerm_monitor_metric_alert.function_failure_rate.criteria).metric_name != "FunctionExecutionCount"
    error_message = "function_failure_rate must NOT use FunctionExecutionCount (does not exist on Flex)"
  }
  # NEGATIVE — no Status dimension (not an AI requests/failed dimension).
  assert {
    condition     = length(one(azurerm_monitor_metric_alert.function_failure_rate.criteria).dimension) == 0
    error_message = "function_failure_rate must not carry a Status dimension"
  }
  # Aggregation/operator/threshold and the window/frequency are preserved.
  assert {
    condition     = one(azurerm_monitor_metric_alert.function_failure_rate.criteria).aggregation == "Count" && one(azurerm_monitor_metric_alert.function_failure_rate.criteria).operator == "GreaterThan" && one(azurerm_monitor_metric_alert.function_failure_rate.criteria).threshold == 5
    error_message = "function_failure_rate criteria must be Count / GreaterThan / 5"
  }
  assert {
    condition     = azurerm_monitor_metric_alert.function_failure_rate.window_size == "PT5M" && azurerm_monitor_metric_alert.function_failure_rate.frequency == "PT1M"
    error_message = "function_failure_rate must keep window_size PT5M / frequency PT1M"
  }
}
