# IoT Hub Module for MeatGeek V2

# IoT Hub
resource "azurerm_iothub" "main" {
  name                = "${var.resource_prefix}-iothub"
  resource_group_name = var.resource_group_name
  location           = var.location

  sku {
    name     = var.iot_hub_sku_name
    capacity = var.iot_hub_sku_capacity
  }

  # Basic IoT Hub configuration - routing will be added in Phase 1
  # All messages will go to the built-in events endpoint by default

  tags = var.tags
}

# Event Hub Namespace for real-time processing
resource "azurerm_eventhub_namespace" "main" {
  name                = "${var.resource_prefix}-eventhub-ns"
  location           = var.location
  resource_group_name = var.resource_group_name
  sku                = "Standard"
  capacity           = 1

  tags = var.tags
}

# Event Hub for temperature data
resource "azurerm_eventhub" "temperature_data" {
  name                = "temperature-data"
  namespace_name      = azurerm_eventhub_namespace.main.name
  resource_group_name = var.resource_group_name
  partition_count     = 2
  message_retention   = 1
}

# Event Hub authorization rule for IoT Hub
resource "azurerm_eventhub_authorization_rule" "iothub" {
  name                = "iothub-sender"
  namespace_name      = azurerm_eventhub_namespace.main.name
  eventhub_name       = azurerm_eventhub.temperature_data.name
  resource_group_name = var.resource_group_name
  listen              = false
  send                = true
  manage              = false
}

# Storage account for routing endpoints
resource "azurerm_storage_account" "routing" {
  name                     = "${replace(var.resource_prefix, "-", "")}routing"
  resource_group_name      = var.resource_group_name
  location                = var.location
  account_tier            = "Standard"
  account_replication_type = "LRS"

  tags = var.tags
}

# Storage container for CosmosDB routing
resource "azurerm_storage_container" "cosmosdb_routing" {
  name                  = "cosmosdb-routing"
  storage_account_name  = azurerm_storage_account.routing.name
  container_access_type = "private"
}

# Consumer group for Azure Functions
resource "azurerm_iothub_consumer_group" "functions" {
  name                   = "azure-functions"
  iothub_name           = azurerm_iothub.main.name
  eventhub_endpoint_name = "events"
  resource_group_name    = var.resource_group_name
}

# Consumer group for real-time processing
resource "azurerm_iothub_consumer_group" "realtime" {
  name                   = "realtime-processing"
  iothub_name           = azurerm_iothub.main.name
  eventhub_endpoint_name = "events"
  resource_group_name    = var.resource_group_name
}