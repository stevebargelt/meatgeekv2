# IoT Hub Module for MeatGeek V2

# IoT Hub
resource "azurerm_iothub" "main" {
  name                = "${var.resource_prefix}-iothub"
  resource_group_name = var.resource_group_name
  location            = var.location

  sku {
    name     = var.iot_hub_sku_name
    capacity = var.iot_hub_sku_capacity
  }

  # System-assigned identity enables identity-based auth on custom routing endpoints
  # (Cosmos DB endpoint uses this identity; AAD avoids key rotation).
  identity {
    type = "SystemAssigned"
  }

  tags = var.tags
}

# Event Hub Namespace for real-time processing
resource "azurerm_eventhub_namespace" "main" {
  name                = "${var.resource_prefix}-eventhub-ns"
  location            = var.location
  resource_group_name = var.resource_group_name
  sku                 = "Standard"
  capacity            = 1

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

# Identity-based send access for the IoT Hub routing endpoint.
# The IoT Hub's system-assigned identity is granted "Azure Event Hubs Data
# Sender" on the target Event Hub so the custom endpoint below authenticates via
# AAD. This replaces the former azurerm_eventhub_authorization_rule ("iothub-sender"),
# whose primary_connection_string / primary_key were SAS secrets materialized
# into Terraform state (MG-24 S1). No SAS rule, no connection string, no key.
resource "azurerm_role_assignment" "iothub_eventhub_sender" {
  scope                = azurerm_eventhub.temperature_data.id
  role_definition_name = "Azure Event Hubs Data Sender"
  principal_id         = azurerm_iothub.main.identity[0].principal_id
}

# Custom routing endpoint: Cosmos DB temperatures container (identity-based auth).
# Caller must grant the IoT Hub system-assigned identity (output: identity_principal_id)
# the "Cosmos DB Built-in Data Contributor" role on the Cosmos account before apply.
resource "azurerm_iothub_endpoint_cosmosdb_account" "cosmos_storage" {
  name                = "cosmos-storage"
  iothub_id           = azurerm_iothub.main.id
  resource_group_name = var.resource_group_name

  endpoint_uri   = var.cosmos_account_endpoint
  database_name  = var.cosmos_database_name
  container_name = var.cosmos_container_name

  authentication_type = "identityBased"
}

# Custom routing endpoint: Event Hub for real-time fan-out to Functions.
# IDENTITY-BASED auth (MG-24 S1): the IoT Hub authenticates to the Event Hub
# with its system-assigned managed identity (endpoint_uri + entity_path), so NO
# SAS connection string / key is generated or stored in Terraform state. The
# role assignment above must exist before the endpoint is created.
resource "azurerm_iothub_endpoint_eventhub" "eventhub_realtime" {
  name                = "eventhub-realtime"
  iothub_id           = azurerm_iothub.main.id
  resource_group_name = var.resource_group_name

  authentication_type = "identityBased"
  endpoint_uri        = "sb://${azurerm_eventhub_namespace.main.name}.servicebus.windows.net"
  entity_path         = azurerm_eventhub.temperature_data.name

  depends_on = [azurerm_role_assignment.iothub_eventhub_sender]
}

# Parallel route #1: all DeviceMessages → Cosmos (storage of record).
resource "azurerm_iothub_route" "cosmos" {
  name                = "cosmos-storage-route"
  iothub_name         = azurerm_iothub.main.name
  resource_group_name = var.resource_group_name

  source         = "DeviceMessages"
  condition      = "true"
  endpoint_names = [azurerm_iothub_endpoint_cosmosdb_account.cosmos_storage.name]
  enabled        = true
}

# Parallel route #2: all DeviceMessages → Event Hub (real-time path).
resource "azurerm_iothub_route" "eventhub" {
  name                = "eventhub-realtime-route"
  iothub_name         = azurerm_iothub.main.name
  resource_group_name = var.resource_group_name

  source         = "DeviceMessages"
  condition      = "true"
  endpoint_names = [azurerm_iothub_endpoint_eventhub.eventhub_realtime.name]
  enabled        = true
}

# Consumer group for Azure Functions
resource "azurerm_iothub_consumer_group" "functions" {
  name                   = "azure-functions"
  iothub_name            = azurerm_iothub.main.name
  eventhub_endpoint_name = "events"
  resource_group_name    = var.resource_group_name
}

# Consumer group for real-time processing
resource "azurerm_iothub_consumer_group" "realtime" {
  name                   = "realtime-processing"
  iothub_name            = azurerm_iothub.main.name
  eventhub_endpoint_name = "events"
  resource_group_name    = var.resource_group_name
}
