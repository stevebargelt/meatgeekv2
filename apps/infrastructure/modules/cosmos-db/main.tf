# CosmosDB Module - Creates and OWNS the MeatGeek V2 CosmosDB account
#
# V2 is greenfield: this module CREATES its own Cosmos account inside the V2
# resource group. It never reads, imports, or adopts the V1 shared account.

# Provider requirements (MG-39). An unconstrained module resolves the LATEST
# azurerm on a standalone init — v5.0.1 as of 2026-08-03, a breaking major. This
# codebase targets azurerm 4.x; v5 is a separate, deliberate migration.
terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
  }
}

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
#
# REPLACEMENT PROPAGATION RULE — read this before deleting any lifecycle block in
# this file. A child that reaches its parent through one of the parent's COMPUTED
# attributes (`.id`, an endpoint URI) carries REPLACEMENT: the attribute is
# unknown until the new parent exists, so the child's own configuration changes
# and Terraform plans it for replacement too. A child that reaches its parent
# through the parent's CONFIGURED `name` carries ORDERING ONLY: that name is a
# static literal, identical before and after, so the child's configuration never
# changes, Terraform never plans the child for replacement — while Azure destroys
# it along with the parent regardless. State is then left listing a resource that
# no longer exists, and the next apply builds on a lie.
#
# Every account_name / database_name reference below is that second kind. That is
# not hypothetical here: `free_tier_enabled` is create-only, so claiming the free
# tier REPLACED azurerm_cosmosdb_account.main. Terraform planned no change for
# this database or its five containers, Azure deleted them with the account
# anyway, state kept listing all six, and the IoT Hub Cosmos endpoint's create
# then failed with IH400142 "Database does not exist. DatabaseName:
# meatgeek-v2-dev-db". replace_triggered_by is what makes the plan match what
# Azure actually does; the name references below still supply the ordering.
resource "azurerm_cosmosdb_sql_database" "meatgeek" {
  name                = "${var.resource_prefix}-db"
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name

  # No throughput at database level - containers will have individual throughput for minimal usage

  # NOT redundant with the account_name reference above — see the rule above.
  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main]
  }
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

  # Indexing policy optimized for device queries.
  #
  # No `excluded_path` for `/"_etag"/?` is declared here (nor on the other four
  # containers): Cosmos does not persist that system exclusion in the readable
  # indexing policy, so the azurerm provider reads it back as excluded_path=[].
  # Declaring it in config therefore produced a perpetual second-plan diff
  # (config had the _etag path; Azure returned none), re-adding it every plan.
  # Omitting it makes config == Azure's canonical form and the container plans as
  # a no-op (MG-24 second-plan no-op fix).
  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
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

  # NOT redundant with the account_name / database_name references above — both
  # are configured literals and carry ordering only. See the rule above the
  # database block. Azure destroys a container with either parent, so both belong
  # here: replacing the account destroys the database, which destroys this.
  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main, azurerm_cosmosdb_sql_database.meatgeek]
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

  # NOT redundant with the account_name / database_name references above — see the
  # rule above the database block.
  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main, azurerm_cosmosdb_sql_database.meatgeek]
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

  # NOT redundant with the account_name / database_name references above — see the
  # rule above the database block.
  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main, azurerm_cosmosdb_sql_database.meatgeek]
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
  }

  # Unique constraint on email addresses
  unique_key {
    paths = ["/email"]
  }

  # NOT redundant with the account_name / database_name references above — see the
  # rule above the database block.
  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main, azurerm_cosmosdb_sql_database.meatgeek]
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

  # NOT redundant with the account_name / database_name references above — see the
  # rule above the database block.
  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main, azurerm_cosmosdb_sql_database.meatgeek]
  }
}
