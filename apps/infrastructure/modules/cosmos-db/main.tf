# CosmosDB Module - Uses existing CosmosDB account with multiple databases

# Data source to reference existing CosmosDB account
data "azurerm_cosmosdb_account" "existing" {
  name                = var.existing_cosmos_account_name
  resource_group_name = var.existing_cosmos_resource_group_name
}

# Create environment-specific database within existing account
resource "azurerm_cosmosdb_sql_database" "meatgeek" {
  name                = "${var.resource_prefix}-db"
  resource_group_name = data.azurerm_cosmosdb_account.existing.resource_group_name
  account_name        = data.azurerm_cosmosdb_account.existing.name
  
  # No throughput at database level - containers will have individual throughput for minimal usage
}

# Container: devices
# Stores device information and configuration
resource "azurerm_cosmosdb_sql_container" "devices" {
  name                = "devices"
  resource_group_name = data.azurerm_cosmosdb_account.existing.resource_group_name
  account_name        = data.azurerm_cosmosdb_account.existing.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek.name
  
  partition_key_paths   = ["/id"]
  partition_key_version = 1
  # No throughput - will share from temperatures container

  # Indexing policy optimized for device queries
  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    excluded_path {
      path = "/\"_etag\"/?"
    }

    # Composite index for user device queries
    composite_index {
      index {
        path  = "/userId"
        order = "ascending"
      }
      index {
        path  = "/isActive"
        order = "ascending"
      }
    }
  }

  # Unique key constraint for device names per user
  unique_key {
    paths = ["/userId", "/name"]
  }
}

# Container: temperatures  
# Stores temperature readings with TTL for data retention
resource "azurerm_cosmosdb_sql_container" "temperatures" {
  name                = "temperatures"
  resource_group_name = data.azurerm_cosmosdb_account.existing.resource_group_name
  account_name        = data.azurerm_cosmosdb_account.existing.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek.name
  
  partition_key_paths   = ["/deviceId"]
  partition_key_version = 1
  throughput           = 400  # All throughput allocated to most active container
  
  # TTL for automatic data cleanup (90 days = 7776000 seconds)
  default_ttl = var.temperature_data_ttl

  # Indexing optimized for time-series queries
  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    excluded_path {
      path = "/\"_etag\"/?"
    }

    # Composite indexes for common temperature queries
    composite_index {
      index {
        path  = "/deviceId" 
        order = "ascending"
      }
      index {
        path  = "/timestamp"
        order = "descending"
      }
    }

    composite_index {
      index {
        path  = "/cookId"
        order = "ascending"  
      }
      index {
        path  = "/timestamp"
        order = "descending"
      }
    }
  }
}

# Container: cooks
# Stores cook session data partitioned by user
resource "azurerm_cosmosdb_sql_container" "cooks" {
  name                = "cooks"
  resource_group_name = data.azurerm_cosmosdb_account.existing.resource_group_name
  account_name        = data.azurerm_cosmosdb_account.existing.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek.name
  
  partition_key_paths   = ["/userId"]
  partition_key_version = 1

  # Indexing for cook queries
  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    excluded_path {
      path = "/\"_etag\"/?"
    }

    # Composite indexes for cook filtering and sorting
    composite_index {
      index {
        path  = "/userId"
        order = "ascending"
      }
      index {
        path  = "/status"
        order = "ascending"
      }
      index {
        path  = "/startTime"
        order = "descending"
      }
    }

    composite_index {
      index {
        path  = "/userId"
        order = "ascending"
      }
      index {
        path  = "/meatType"
        order = "ascending"
      }
    }
  }
}

# Container: users
# Stores user profiles and preferences  
resource "azurerm_cosmosdb_sql_container" "users" {
  name                = "users"
  resource_group_name = data.azurerm_cosmosdb_account.existing.resource_group_name
  account_name        = data.azurerm_cosmosdb_account.existing.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek.name
  
  partition_key_paths   = ["/id"]
  partition_key_version = 1

  # Indexing for user queries
  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    excluded_path {
      path = "/\"_etag\"/?"
    }
  }

  # Unique constraint on email addresses
  unique_key {
    paths = ["/email"]
  }
}

# Container: recipes
# Stores recipe data partitioned by user
resource "azurerm_cosmosdb_sql_container" "recipes" {
  name                = "recipes"
  resource_group_name = data.azurerm_cosmosdb_account.existing.resource_group_name
  account_name        = data.azurerm_cosmosdb_account.existing.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek.name
  
  partition_key_paths   = ["/userId"]
  partition_key_version = 1

  # Indexing for recipe queries
  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

    excluded_path {
      path = "/\"_etag\"/?"
    }

    # Composite indexes for recipe filtering
    composite_index {
      index {
        path  = "/meatType"
        order = "ascending"
      }
      index {
        path  = "/rating"
        order = "descending"
      }
    }

    composite_index {
      index {
        path  = "/isPublic"
        order = "ascending"
      }
      index {
        path  = "/rating"  
        order = "descending"
      }
    }
  }
}