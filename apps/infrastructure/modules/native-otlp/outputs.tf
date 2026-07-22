# native-otlp module outputs (non-secret only — MG-24 S1: no keys/connection
# strings leave via state). These are ingestion coordinates + identity ids the
# operator uses to verify the path once activated (MG-25/MG-34).

output "collector_uai_client_id" {
  description = "Client id of the collector's user-assigned managed identity (matches AZURE_OTLP_UAI_CLIENT_ID)."
  value       = azurerm_user_assigned_identity.collector.client_id
}

output "collector_uai_principal_id" {
  description = "Principal id of the collector's user-assigned managed identity (the DCR role assignment target)."
  value       = azurerm_user_assigned_identity.collector.principal_id
}

output "dce_logs_ingestion_endpoint" {
  description = "DCE logs-ingestion endpoint the collector's otlphttp exporter targets (AZURE_MONITOR_OTLP_ENDPOINT). Non-secret."
  value       = azurerm_monitor_data_collection_endpoint.otlp.logs_ingestion_endpoint
}

output "dcr_immutable_id" {
  description = "DCR immutable id used to route ingestion (AZURE_MONITOR_DCR_IMMUTABLE_ID). Non-secret."
  value       = azurerm_monitor_data_collection_rule.otlp.immutable_id
}

output "dcr_id" {
  description = "DCR resource id — the SCOPE of the Monitoring Metrics Publisher role assignment (MG-34 AC3 negative check target)."
  value       = azurerm_monitor_data_collection_rule.otlp.id
}
