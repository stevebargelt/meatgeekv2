# CosmosDB Module Outputs

# Existing CosmosDB Account Information
output "cosmos_account_id" {
  description = "ID of the existing CosmosDB account"
  value       = data.azurerm_cosmosdb_account.existing.id
}

output "cosmos_account_name" {
  description = "Name of the existing CosmosDB account"
  value       = data.azurerm_cosmosdb_account.existing.name
}

output "endpoint" {
  description = "CosmosDB account endpoint"
  value       = data.azurerm_cosmosdb_account.existing.endpoint
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
output "connection_string" {
  description = "CosmosDB connection string for the existing account"
  value       = "AccountEndpoint=${data.azurerm_cosmosdb_account.existing.endpoint};AccountKey=${data.azurerm_cosmosdb_account.existing.primary_key};Database=${azurerm_cosmosdb_sql_database.meatgeek.name}"
  sensitive   = true
}

output "primary_key" {
  description = "Primary key for the CosmosDB account"
  value       = data.azurerm_cosmosdb_account.existing.primary_key
  sensitive   = true
}

output "secondary_key" {
  description = "Secondary key for the CosmosDB account"  
  value       = data.azurerm_cosmosdb_account.existing.secondary_key
  sensitive   = true
}

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
    endpoint            = data.azurerm_cosmosdb_account.existing.endpoint
    database_name       = azurerm_cosmosdb_sql_database.meatgeek.name
    account_name        = data.azurerm_cosmosdb_account.existing.name
    resource_group_name = data.azurerm_cosmosdb_account.existing.resource_group_name
    
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

output "estimated_monthly_cost" {
  description = "Estimated monthly cost for this database in USD"
  value = {
    base_throughput = var.database_throughput * 0.008 * 24 * 30 # $0.008 per RU/hour
    max_throughput  = var.database_max_throughput * 0.008 * 24 * 30
    storage_gb      = "Variable based on data volume"
  }
}

# Environment Information
output "environment_info" {
  description = "Environment-specific information"
  value = {
    environment     = var.environment
    database_prefix = var.resource_prefix
    ttl_days       = var.temperature_data_ttl / 86400
    auto_scale_max = var.database_max_throughput
  }
}