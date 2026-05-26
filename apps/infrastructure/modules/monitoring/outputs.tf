# Monitoring Module Outputs

output "action_group_id" {
  description = "ID of the action group"
  value       = azurerm_monitor_action_group.main.id
}

output "budget_id" {
  description = "ID of the budget alert"
  value       = azurerm_consumption_budget_resource_group.main.id
}