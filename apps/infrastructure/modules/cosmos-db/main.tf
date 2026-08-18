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

  # MG-54: free-tier account throughput ceiling. Cap total provisioned throughput
  # for the WHOLE account at 1000 RU/s — the free-tier grant (dev has
  # free_tier_enabled = true). This is an IN-PLACE account update, not ForceNew:
  # total_throughput_limit is updatable, so adding it plans as a '~ update' on
  # azurerm_cosmosdb_account.main and never destroys/recreates the account or the
  # destination twins beneath it.
  #
  # ORDERING (MG-54): this 1000 RU/s ceiling is BELOW the throughput provisioned
  # while the deleted source container offers still exist, so Azure rejects it if it
  # lands first. A single `terraform apply` gives no edge ordering this in-place
  # account update AFTER the source child destroys, so delete-before-limit is
  # guaranteed by the documented TWO-PHASE apply, not by one plan. See the runbook
  # in apps/infrastructure/COSMOS-COST-STRATEGY.md.
  capacity {
    total_throughput_limit = 1000
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

# =============================================================================
# MG-53 DESTINATION — shared-throughput database (CREATE ONLY)
# =============================================================================
#
# Everything above this banner is the SOURCE and is left as it was (only the two
# false throughput comments on the source database and source devices container
# were corrected). Everything below is a NEW, parallel destination that provisions
# throughput the way the code always intended: a SINGLE 400 RU/s offer at the
# DATABASE level, shared by all five containers, none of which declares its own
# throughput.
#
# Why a whole new database rather than an edit to the source: Azure cannot convert
# an existing dedicated-throughput container to shared throughput, and a database
# created without a shared offer cannot acquire one later. The offer cannot be
# moved from container to database in place. So the correct destination MUST be
# newly created. This is strictly ADDITIVE — no source resource is replaced,
# renamed, or repointed; the applied plan is creates-only.
#
# The five container definitions below are reproduced FAITHFULLY from their source
# siblings (partition_key_paths, partition_key_version, indexing_policy including
# included/excluded/composite, default_ttl, unique_key) so the destination is a
# definition-faithful twin. The ONLY intended differences are (1) no per-container
# throughput and (2) the database-level offer. Definition parity against the live
# source is proven by scripts/cosmos-definition-parity.sh (MG-53 step 3) and the
# post-create assertion scripts/assert-live-shared-throughput.sh (step 4).
#
# The composite indexes are copied verbatim from the source and are deliberately
# NOT redesigned here (recorded for MG-59): they may not serve the routed
# envelope's fields, but they are not wrong in themselves.
#
# Consumers (the IoT Hub Cosmos endpoint, the Function App database-name setting)
# still address the SOURCE at the end of this work — the repoint is MG-62. The
# destination outputs in outputs.tf are published but intentionally unwired.

resource "azurerm_cosmosdb_sql_database" "meatgeek_shared" {
  name                = "${var.resource_prefix}-shared-db"
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name

  # The fix: a SINGLE database-level shared-throughput offer. Up to 25 containers
  # under this database share this 400 RU/s pool, so the five destination
  # containers below carry NO throughput of their own.
  throughput = 400

  # Same reasoning as the source database's lifecycle block above: this child
  # reaches azurerm_cosmosdb_account.main through the account's CONFIGURED name
  # (ordering only), so it needs an explicit replace_triggered_by on the account's
  # `.id` to be replaced along with a replaced account. `.id`, not the bare
  # resource, to avoid firing on the account's in-place updates (MG-48 F4).
  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main.id]
  }
}

# Destination container: devices (faithful twin of azurerm_cosmosdb_sql_container.devices)
resource "azurerm_cosmosdb_sql_container" "devices_shared" {
  name                = "devices"
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek_shared.name

  partition_key_paths   = ["/id"]
  partition_key_version = 1
  # No throughput — shared from the database-level offer above.

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

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

  unique_key {
    paths = ["/userId", "/name"]
  }

  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main.id, azurerm_cosmosdb_sql_database.meatgeek_shared.id]
  }
}

# Destination container: temperatures (faithful twin of azurerm_cosmosdb_sql_container.temperatures)
#
# CREATE-ONLY PARTITION KEY (MG-73). partition_key_paths MUST stay ["/deviceId"] to
# match the IoT Hub Cosmos routing endpoint's partition_key_name = "deviceId"; a
# container partition path cannot be repaired after creation. The source-contract
# check (tf-static-checks check 20) keys on the SOURCE container label and cannot
# see this differently-labeled destination — scripts/assert-live-shared-throughput.sh
# (MG-53 step 4) and the module tftest (step 2) are what guard this destination's
# partition key.
resource "azurerm_cosmosdb_sql_container" "temperatures_shared" {
  name                = "temperatures"
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek_shared.name

  partition_key_paths   = ["/deviceId"]
  partition_key_version = 1
  # No throughput — shared from the database-level offer above. The source
  # temperatures container carries throughput = 400; that is intentionally NOT
  # reproduced here, and the parity comparison scopes throughput out.

  default_ttl = var.temperature_data_ttl

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

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

  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main.id, azurerm_cosmosdb_sql_database.meatgeek_shared.id]
  }
}

# Destination container: cooks (faithful twin of azurerm_cosmosdb_sql_container.cooks)
resource "azurerm_cosmosdb_sql_container" "cooks_shared" {
  name                = "cooks"
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek_shared.name

  partition_key_paths   = ["/userId"]
  partition_key_version = 1
  # No throughput — shared from the database-level offer above.

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

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

  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main.id, azurerm_cosmosdb_sql_database.meatgeek_shared.id]
  }
}

# Destination container: users (faithful twin of azurerm_cosmosdb_sql_container.users)
resource "azurerm_cosmosdb_sql_container" "users_shared" {
  name                = "users"
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek_shared.name

  partition_key_paths   = ["/id"]
  partition_key_version = 1
  # No throughput — shared from the database-level offer above.

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }
  }

  unique_key {
    paths = ["/email"]
  }

  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main.id, azurerm_cosmosdb_sql_database.meatgeek_shared.id]
  }
}

# Destination container: recipes (faithful twin of azurerm_cosmosdb_sql_container.recipes)
resource "azurerm_cosmosdb_sql_container" "recipes_shared" {
  name                = "recipes"
  resource_group_name = azurerm_cosmosdb_account.main.resource_group_name
  account_name        = azurerm_cosmosdb_account.main.name
  database_name       = azurerm_cosmosdb_sql_database.meatgeek_shared.name

  partition_key_paths   = ["/userId"]
  partition_key_version = 1
  # No throughput — shared from the database-level offer above.

  indexing_policy {
    indexing_mode = "consistent"

    included_path {
      path = "/*"
    }

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

  lifecycle {
    replace_triggered_by = [azurerm_cosmosdb_account.main.id, azurerm_cosmosdb_sql_database.meatgeek_shared.id]
  }
}
