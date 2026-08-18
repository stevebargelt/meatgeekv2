# CosmosDB Module Outputs

# V2-owned CosmosDB Account Information
output "cosmos_account_id" {
  description = "ID of the V2-owned CosmosDB account"
  value       = azurerm_cosmosdb_account.main.id
}

output "cosmos_account_name" {
  description = "Name of the V2-owned CosmosDB account"
  value       = azurerm_cosmosdb_account.main.name
}

output "endpoint" {
  description = "CosmosDB account endpoint"
  value       = azurerm_cosmosdb_account.main.endpoint
}

# Connection Information
# NOTE: the former `connection_string`, `primary_key`, and `secondary_key`
# secret outputs were REMOVED (MG-24 S1). Consumers (the Function App, the IoT
# Hub route) access Cosmos identity-based via the non-secret `endpoint` above
# plus a Cosmos SQL data-plane role assignment — no AccountKey enters state.

# The former `estimated_monthly_cost` output was REMOVED (MG-48). It was wrong by
# 100x — it read $0.008 as a per-RU/s-hour rate when Azure charges it per 100 RU/s
# per hour, so it reported ~$2,304/mo for a 400 RU/s database that costs ~$23/mo.
# It was also computed from `database_throughput` / `database_max_throughput`,
# inputs that governed NOTHING: this module sets no database-level throughput and
# has no autoscale_settings block anywhere, so those variables described a
# provisioning shape that does not exist. Both are deleted with it. A cost figure
# that is confidently wrong is worse than no cost figure — this one was found
# during a cost-reduction effort, where it would have misdirected the reader.

# =============================================================================
# MG-53 DESTINATION OUTPUTS — shared-throughput database (intentionally UNWIRED)
# =============================================================================
#
# These publish the NEW shared-throughput destination created in main.tf. They are
# SEPARATE from the source-bound outputs above (database_name, database_id,
# container_names, container_ids, partition_keys, application_config), which STILL
# resolve to the SOURCE and must not be changed here — the IoT Hub Cosmos endpoint
# and the Function App COSMOSDB_DATABASE_NAME read those source outputs and must
# keep addressing the source at the end of MG-53.
#
# Nothing consumes the outputs below yet. They exist so MG-62's repoint is a
# one-line change (swap the consumer from the source output to its destination
# twin), not a schema edit. Do NOT wire them to any consumer as part of MG-53.

output "destination_database_id" {
  description = "ID of the MG-53 shared-throughput destination database (UNWIRED; MG-62 repoints consumers here)"
  value       = azurerm_cosmosdb_sql_database.meatgeek_shared.id
}

output "destination_database_name" {
  description = "Name of the MG-53 shared-throughput destination database (UNWIRED; MG-62 repoints consumers here)"
  value       = azurerm_cosmosdb_sql_database.meatgeek_shared.name
}

output "destination_database_throughput" {
  description = "Database-level shared throughput (RU/s) on the destination database — the single 400 RU/s offer the five destination containers share"
  value       = azurerm_cosmosdb_sql_database.meatgeek_shared.throughput
}

output "destination_container_names" {
  description = "Names of the containers under the MG-53 shared-throughput destination database (UNWIRED)"
  value = {
    devices      = azurerm_cosmosdb_sql_container.devices_shared.name
    temperatures = azurerm_cosmosdb_sql_container.temperatures_shared.name
    cooks        = azurerm_cosmosdb_sql_container.cooks_shared.name
    users        = azurerm_cosmosdb_sql_container.users_shared.name
    recipes      = azurerm_cosmosdb_sql_container.recipes_shared.name
  }
}

output "destination_container_ids" {
  description = "Resource IDs of the containers under the MG-53 shared-throughput destination database (UNWIRED). As with container_ids above, reference the id (not a bare resource address) in any future replace_triggered_by."
  value = {
    devices      = azurerm_cosmosdb_sql_container.devices_shared.id
    temperatures = azurerm_cosmosdb_sql_container.temperatures_shared.id
    cooks        = azurerm_cosmosdb_sql_container.cooks_shared.id
    users        = azurerm_cosmosdb_sql_container.users_shared.id
    recipes      = azurerm_cosmosdb_sql_container.recipes_shared.id
  }
}

output "destination_partition_keys" {
  description = "Partition key paths for each destination container. temperatures MUST be /deviceId to match the IoT Hub Cosmos endpoint's authenticated partition identity (MG-73)."
  value = {
    devices      = "/id"
    temperatures = "/deviceId"
    cooks        = "/userId"
    users        = "/id"
    recipes      = "/userId"
  }
}

# Environment Information
output "environment_info" {
  description = "Environment-specific information"
  value = {
    environment     = var.environment
    database_prefix = var.resource_prefix
    ttl_days        = var.temperature_data_ttl / 86400
  }
}
