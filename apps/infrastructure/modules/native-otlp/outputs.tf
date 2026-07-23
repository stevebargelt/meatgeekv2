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
  description = "DCE logs-ingestion host used to build the native-OTLP traces_endpoint. Non-secret."
  value       = azurerm_monitor_data_collection_endpoint.otlp.logs_ingestion_endpoint
}

output "dcr_immutable_id" {
  description = "Native-OTLP DCR immutable id (from the azapi resource) embedded in the traces_endpoint URL path. Non-secret."
  value       = local.dcr_immutable_id
}

output "dcr_id" {
  description = "azapi DCR resource id — the SCOPE of the Monitoring Metrics Publisher role assignment (MG-34 AC3 negative check target)."
  value       = azapi_resource.otlp_dcr.id
}

output "otlp_traces_endpoint" {
  description = "Full native-OTLP traces ingestion URL (AZURE_MONITOR_OTLP_TRACES_ENDPOINT) built from the DCE ingestion host + DCR immutable id: https://<host>/dataCollectionRules/<immutable-id>/streams/Microsoft-OTLP-Traces/otlp/v1/traces. Non-secret."
  value       = local.otlp_traces_endpoint
}
