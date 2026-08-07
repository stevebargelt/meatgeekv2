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

# Database Information
output "database_id" {
  description = "ID of the environment-specific database"
  value       = azurerm_cosmosdb_sql_database.meatgeek.id
}

output "database_name" {
  description = "Name of the environment-specific database"
  value       = azurerm_cosmosdb_sql_database.meatgeek.name
}

# Connection Information
# NOTE: the former `connection_string`, `primary_key`, and `secondary_key`
# secret outputs were REMOVED (MG-24 S1). Consumers (the Function App, the IoT
# Hub route) access Cosmos identity-based via the non-secret `endpoint` above
# plus a Cosmos SQL data-plane role assignment — no AccountKey enters state.

# Container Information
output "container_names" {
  description = "Names of all containers created in the database"
  value = {
    devices      = azurerm_cosmosdb_sql_container.devices.name
    temperatures = azurerm_cosmosdb_sql_container.temperatures.name
    cooks        = azurerm_cosmosdb_sql_container.cooks.name
    users        = azurerm_cosmosdb_sql_container.users.name
    recipes      = azurerm_cosmosdb_sql_container.recipes.name
  }
}

# Container identities, published so a consumer can depend on a container's
# EXISTENCE and not merely on its name (MG-48).
#
# A container's `name` is a CONFIGURED literal — "temperatures" is spelled in
# main.tf and is byte-identical before and after the container is replaced. A
# consumer handed `container_names.temperatures` therefore learns what the
# container is called but never learns WHETHER the thing behind that name still
# exists: the value it sees is unchanged across a destroy-and-recreate, so it is
# never planned for replacement alongside it. An `id` is COMPUTED and changes on
# replacement, which is what makes it usable as a `replace_triggered_by` trigger
# (see the route comments in modules/iot-hub/main.tf for the same distinction one
# layer up). Names still cross the boundary next to these ids — the Azure APIs
# want the literal name — but the ids are what carry identity.
output "container_ids" {
  description = "Resource IDs of all containers created in the database. Computed, unlike container_names: an id changes when a container is replaced, so a consumer that must be replaced WITH a container references the id — the configured name survives replacement unchanged and cannot carry that dependency."
  value = {
    devices      = azurerm_cosmosdb_sql_container.devices.id
    temperatures = azurerm_cosmosdb_sql_container.temperatures.id
    cooks        = azurerm_cosmosdb_sql_container.cooks.id
    users        = azurerm_cosmosdb_sql_container.users.id
    recipes      = azurerm_cosmosdb_sql_container.recipes.id
  }
}

output "partition_keys" {
  description = "Partition key paths for each container"
  value = {
    devices      = "/id"
    temperatures = "/deviceId"
    cooks        = "/userId"
    users        = "/id"
    recipes      = "/userId"
  }
}

# Application Configuration
output "application_config" {
  description = "Configuration object for applications"
  value = {
    endpoint            = azurerm_cosmosdb_account.main.endpoint
    database_name       = azurerm_cosmosdb_sql_database.meatgeek.name
    account_name        = azurerm_cosmosdb_account.main.name
    resource_group_name = azurerm_cosmosdb_account.main.resource_group_name

    containers = {
      devices      = azurerm_cosmosdb_sql_container.devices.name
      temperatures = azurerm_cosmosdb_sql_container.temperatures.name
      cooks        = azurerm_cosmosdb_sql_container.cooks.name
      users        = azurerm_cosmosdb_sql_container.users.name
      recipes      = azurerm_cosmosdb_sql_container.recipes.name
    }

    partition_keys = {
      devices      = "/id"
      temperatures = "/deviceId"
      cooks        = "/userId"
      users        = "/id"
      recipes      = "/userId"
    }
  }
}

# Cost and Performance Information
output "database_throughput" {
  description = "Configured database throughput in RU/s"
  value       = azurerm_cosmosdb_sql_database.meatgeek.throughput
}

# The former `estimated_monthly_cost` output was REMOVED (MG-48). It was wrong by
# 100x — it read $0.008 as a per-RU/s-hour rate when Azure charges it per 100 RU/s
# per hour, so it reported ~$2,304/mo for a 400 RU/s database that costs ~$23/mo.
# It was also computed from `database_throughput` / `database_max_throughput`,
# inputs that governed NOTHING: this module sets no database-level throughput and
# has no autoscale_settings block anywhere, so those variables described a
# provisioning shape that does not exist. Both are deleted with it. A cost figure
# that is confidently wrong is worse than no cost figure — this one was found
# during a cost-reduction effort, where it would have misdirected the reader.

# Environment Information
output "environment_info" {
  description = "Environment-specific information"
  value = {
    environment     = var.environment
    database_prefix = var.resource_prefix
    ttl_days        = var.temperature_data_ttl / 86400
  }
}
