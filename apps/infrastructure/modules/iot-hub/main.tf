# IoT Hub Module for MeatGeek V2

# IoT Hub
#
# DOCUMENTED EXCEPTION (MG-24 ADR) — key/SAS auth is INTENTIONALLY kept enabled.
# Unlike Cosmos/SignalR (local auth disabled) and Storage (shared-key disabled),
# the IoT Hub keeps its shared-access policies: real BBQ devices, the data-pusher,
# and the device-controller authenticate to the hub with SAS keys — the device
# SDKs' supported path. Disabling local auth here (local_authentication_enabled =
# false) would sever device connectivity, so it is deliberately left at its
# default (enabled). The hub's inherent shared_access_policy key attributes are
# therefore live credentials that DO land in Terraform state. The mitigation is
# restricted, container-scoped RBAC state access (state blob is not broadly
# readable) plus the documented acceptance in the MG-24 ADR. The secret-
# inspection gate treats these IoT key attributes as the acknowledged exception
# (accepted with a note), NOT as a violation.
resource "azurerm_iothub" "main" {
  name                = "${var.resource_prefix}-iothub-${var.global_suffix}"
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
  name                = "${var.resource_prefix}-eventhub-ns-${var.global_suffix}"
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

# Dependency handle for the Cosmos data-plane role assignment. It carries the
# role-assignment id passed from root into the graph as a concrete node the
# identity-based Cosmos endpoint can depends_on. Using terraform_data (rather than
# making azurerm_iothub.main depend on the role) is what keeps the graph acyclic:
# the role assignment depends on this module's identity_principal_id output, so
# only the endpoint below — never the IoT Hub resource — sits downstream of it.
resource "terraform_data" "cosmos_role_ready" {
  input = var.cosmos_role_assignment_id
}

# Custom routing endpoint: Cosmos DB temperatures container (identity-based auth).
# The IoT Hub system-assigned identity (output: identity_principal_id) must hold
# the "Cosmos DB Built-in Data Contributor" role on the Cosmos account BEFORE this
# endpoint is created — the service validates the identity's data-plane access at
# creation, so a greenfield apply that races the endpoint ahead of the role fails
# until the role propagates. The depends_on below orders it strictly after the
# role assignment via the terraform_data handle (MG-24).
resource "azurerm_iothub_endpoint_cosmosdb_account" "cosmos_storage" {
  name                = "cosmos-storage"
  iothub_id           = azurerm_iothub.main.id
  resource_group_name = var.resource_group_name

  endpoint_uri   = var.cosmos_account_endpoint
  database_name  = var.cosmos_database_name
  container_name = var.cosmos_container_name

  authentication_type = "identityBased"

  depends_on = [terraform_data.cosmos_role_ready]
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
