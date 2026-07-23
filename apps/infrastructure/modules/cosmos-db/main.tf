# CosmosDB Module - Creates and OWNS the MeatGeek V2 CosmosDB account
#
# V2 is greenfield: this module CREATES its own Cosmos account inside the V2
# resource group. It never reads, imports, or adopts the V1 shared account.

locals {
  # Azure Cosmos DB account naming rule: 3-44 chars, lowercase letters,
  # numbers and hyphens only. Sanitize the caller-supplied name so the
  # account name is always valid and deterministic (no timestamp/random).
  cosmos_account_name = substr(
    join("", regexall("[a-z0-9-]", lower(var.cosmos_account_name))),
    0,
    44
  )
}

# V2-owned CosmosDB account
resource "azurerm_cosmosdb_account" "main" {
  name                = local.cosmos_account_name
  resource_group_name = var.resource_group_name
  location            = var.location
  offer_type          = "Standard"
  kind                = "GlobalDocumentDB"

  free_tier_enabled                = var.enable_free_tier
  multiple_write_locations_enabled = var.enable_multiple_write_locations

  # Disable local (account-key / connection-string) authentication so the
  # account's inherent computed key attributes (primary_key, connection_strings)
  # — which Terraform stores in state for ANY managed resource — CANNOT
  # authenticate a data-plane request. Access is AAD/RBAC only: the Function App
  # and the IoT Hub identity each hold "Cosmos DB Built-in Data Contributor"
  # (data-plane SQL role assignments in the root module), which keep working with
  # local auth off. This makes the in-state key a present-but-non-authenticating
  # residual, mirroring the App Insights posture (MG-24 ADR). The pre-apply
  # secret-inspection gate rejects this account if this flag is ever removed.
  local_authentication_enabled = false

  consistency_policy {
    consistency_level       = var.consistency_level
    max_interval_in_seconds = var.consistency_level == "BoundedStaleness" ? var.consistency_max_interval_in_seconds : null
    max_staleness_prefix    = var.consistency_level == "BoundedStaleness" ? var.consistency_max_staleness_prefix : null
  }

  # Primary write region for the V2 account.
  geo_location {
    location          = var.location
    failover_priority = 0
    zone_redundant    = false
  }

  # Additional read/failover regions (production only; empty by default).
  dynamic "geo_location" {
    for_each = var.failover_locations
    content {
      location          = geo_location.value.location
      failover_priority = geo_location.value.failover_priority
      zone_redundant    = geo_location.value.zone_redundant
    }
  }

  backup {
    type                = var.backup_policy.type
    interval_in_minutes = var.backup_policy.type == "Periodic" ? var.backup_policy.interval_in_minutes : null
    retention_in_hours  = var.backup_policy.type == "Periodic" ? var.backup_policy.retention_in_hours : null
  }

  tags = var.tags

  # FORCE-NEW / DATA-LOSS NOTE (MG-24). `location` is ForceNew on a Cosmos
  # account: the MG-24 hosting revision sets location = "West US 2", so on an
  # ALREADY-POPULATED environment a region change would destroy+recreate this
  # account and DROP its stored data (temperature history, cooks, sessions).
  #
  # No `prevent_destroy` guard is set here on purpose. V2 is GREENFIELD — there is
  # no data to protect yet, and prevent_destroy is a LITERAL (Terraform cannot
  # env-gate it), so it would be ON for dev and BLOCK the intended greenfield
  # West US 2 recreate that MG-24 requires. Real prod data-loss protection
  # (prod-specific prevent_destroy / backup policy / approval gate for Cosmos AND
  # IoT Hub) is deferred to follow-up ticket MG-35 (MG-25 prod-hardening scope).
}

# Create environment-specific database within the V2-owned account
resource "azurerm_cosmosdb_sql_database" "meatgeek" {
  name                = "${var.resource_prefix}-db"
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name

  # No throughput at database level - containers will have individual throughput for minimal usage
}

# Container: devices
# Stores device information and configuration
resource "azurerm_cosmosdb_sql_container" "devices" {
  name                = "devices"
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
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
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek.name

  partition_key_paths   = ["/deviceId"]
  partition_key_version = 1
  throughput            = 400 # All throughput allocated to most active container

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
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
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
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
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
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
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
