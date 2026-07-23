# native-otlp module provider requirements.
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    # azapi authors the native-OTLP DCR (Microsoft.Insights/dataCollectionRules
    # @2024-03-11 with a directDataSources.otelTraces body) — a shape the azurerm
    # azurerm_monitor_data_collection_rule resource cannot express.
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }
}
