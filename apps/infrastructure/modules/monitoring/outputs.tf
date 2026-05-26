# Monitoring Module Outputs

output "action_group_id" {
  description = "ID of the action group"
  value       = azurerm_monitor_action_group.main.id
}

output "budget_id" {
  description = "ID of the primary resource-group budget alert"
  value       = azurerm_consumption_budget_resource_group.main.id
}

output "secondary_budget_id" {
  description = "ID of the secondary subscription-scope (credit) budget"
  value       = azurerm_consumption_budget_subscription.credit_budget.id
}

output "diagnostic_setting_ids" {
  description = "Map of diagnostic setting IDs by target resource shorthand"
  value = {
    iot_hub      = azurerm_monitor_diagnostic_setting.iot_hub.id
    cosmos_db    = azurerm_monitor_diagnostic_setting.cosmos_db.id
    function_app = azurerm_monitor_diagnostic_setting.function_app.id
    signalr      = azurerm_monitor_diagnostic_setting.signalr.id
  }
}

output "alert_ids" {
  description = "Map of metric-alert IDs by alert shorthand"
  value = {
    function_failure_rate           = azurerm_monitor_metric_alert.function_failure_rate.id
    cosmos_429_rate                 = azurerm_monitor_metric_alert.cosmos_429_rate.id
    signalr_connection_failure_rate = azurerm_monitor_metric_alert.signalr_connection_failure_rate.id
    ingestion_cap_reached           = azurerm_monitor_metric_alert.ingestion_cap_reached.id
  }
}

output "workbook_id" {
  description = "ID of the observability workbook stub (content lands in #6)"
  value       = azurerm_application_insights_workbook.main.id
}
