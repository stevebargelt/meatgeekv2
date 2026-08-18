# Destination-shape test for the MG-53 shared-throughput Cosmos database.
#
# Runs the module as the config-under-test with a MOCKED azurerm provider — NO
# live Azure, NO credentials, NO apply (static check 15 forbids `command = apply`
# in any tftest, which is what keeps the PR gate credentialless). Every run below
# is `command = plan`.
#
# WHY THIS FILE EXISTS. MG-53 adds a parallel, shared-throughput destination —
# azurerm_cosmosdb_sql_database.meatgeek_shared with a SINGLE 400 RU/s
# database-level offer, and five *_shared containers that carry no throughput of
# their own. Two properties of that destination are unrepairable-after-create and
# so are the ones worth a fast in-container guard:
#
#   1. The destination temperatures container's partition_key_paths. It MUST stay
#      ["/deviceId"] to match the IoT Hub Cosmos routing endpoint's
#      partition_key_name = "deviceId" (MG-73). A container's partition key path
#      is CREATE-ONLY on Azure — a drift here is a mis-partition that can only be
#      fixed by rebuilding the container. tf-static-checks check 20 already guards
#      this agreement, but it keys on the SOURCE label
#      azurerm_cosmosdb_sql_container.temperatures and structurally cannot see the
#      differently-labeled destination azurerm_cosmosdb_sql_container.temperatures_shared.
#      This file is the in-container safety net for the DESTINATION's create-only
#      key. It does NOT modify check 20, which remains the source-contract guard.
#
#   2. The single 400 RU/s offer living at the DATABASE level. If it is removed
#      from the destination database, the fix is undone: with no shared offer each
#      container silently falls back to its own 400 RU/s minimum (the exact defect
#      MG-53 corrects). `meatgeek_shared.throughput == 400` below fails closed if
#      that offer is ever dropped — a removed optional value plans as unknown, and
#      an unknown makes the `== 400` condition error rather than silently pass.
#
# WHAT THIS FILE CANNOT OBSERVE, stated plainly so it is not mistaken for coverage
# it does not provide. The third destination property — that NO *_shared container
# carries its OWN throughput — is NOT assertable here, and the reason is a hard
# property of `command = plan`, not an oversight:
#
#   `throughput` on azurerm_cosmosdb_sql_container is Optional+Computed (verified
#   against the provider schema). When a container declares no throughput, its
#   planned `.throughput` is UNKNOWN ("known after apply"), and an unknown value
#   poisons any condition that reads it — Terraform aborts the run with "Unknown
#   condition value" rather than returning true or false. So there is no plan
#   assertion that PASSES when throughput is unset and FAILS when it is set: the
#   correct (unset) state cannot be expressed as a passing condition at all. The
#   command that WOULD resolve the value — `command = apply` — is banned by check
#   15. `override_resource`/mock defaults do not help either: they populate
#   computed attributes at apply, not plan (all three were tried and stay unknown
#   at plan).
#
#   The authoritative guard for "no destination container holds a dedicated offer"
#   is therefore the LIVE post-create assertion,
#   apps/infrastructure/scripts/assert-live-shared-throughput.sh (MG-53 step 4),
#   with its per-container fail-closed offer probe, exercised by fixtures in
#   apps/infrastructure/scripts/fixtures/run-assert-live-shared-throughput-fixtures.sh
#   (step 6). That is where the brief places the per-container check, and it is not
#   duplicated here because it cannot be. What this file pins instead — the
#   database-level offer being present at 400 — is the other half of the same
#   invariant and IS plan-observable.
#
# Run:  terraform -chdir=apps/infrastructure/modules/cosmos-db test
# (init the module dir with `terraform init -backend=false` first).
#
# List-vs-tuple note: a bracket literal like ["/deviceId"] is a tuple, and
# `list(string) == tuple(...)` is FALSE under Terraform's strict `==`. The
# partition_key_paths comparisons below wrap the expected value in tolist() so the
# types match; unique_key.paths is a set, compared with toset().

mock_provider "azurerm" {}

variables {
  resource_prefix     = "meatgeek-v2-dev"
  environment         = "dev"
  cosmos_account_name = "mgv2-dev-f640e19ae7ab"
  resource_group_name = "meatgeek-v2-dev-rg"
  location            = "westus2"
}

# The single database-level offer is the whole point of the destination: 400 RU/s
# at the DATABASE, shared by all five containers. This run fails closed if that
# offer is removed (a removed optional throughput plans as unknown, so `== 400`
# errors) or set to any other value.
run "destination_database_carries_a_single_400_rus_database_level_offer" {
  command = plan

  assert {
    condition     = azurerm_cosmosdb_sql_database.meatgeek_shared.throughput == 400
    error_message = "The destination database azurerm_cosmosdb_sql_database.meatgeek_shared must carry a 400 RU/s DATABASE-level offer (throughput = 400). This single shared offer is what lets the five destination containers run with no throughput of their own; remove it and each container silently falls back to its own 400 RU/s minimum — the exact ~2000 RU/s defect MG-53 exists to correct."
  }

  # The destination is a NEW database inside the EXISTING account — not a second
  # azurerm_cosmosdb_account. It must reach azurerm_cosmosdb_account.main by the
  # account's configured name, exactly as the source database does.
  assert {
    condition     = azurerm_cosmosdb_sql_database.meatgeek_shared.name == "${var.resource_prefix}-shared-db"
    error_message = "The destination database name must be the configured literal '${var.resource_prefix}-shared-db' — distinct from the source '${var.resource_prefix}-db', so the destination is strictly additive and never collides with or replaces the source database."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_database.meatgeek_shared.account_name == azurerm_cosmosdb_account.main.name
    error_message = "The destination database must live in the EXISTING account azurerm_cosmosdb_account.main (reached by the account's configured name), not a newly-introduced second account. MG-53 adds one database to the account that is already there."
  }
}

# The create-only partition key. This is the property tf-static-checks check 20
# cannot see on the destination label, so it is asserted here directly.
run "destination_temperatures_keeps_the_create_only_deviceid_partition_key" {
  command = plan

  assert {
    condition     = azurerm_cosmosdb_sql_container.temperatures_shared.partition_key_paths == tolist(["/deviceId"])
    error_message = "The destination temperatures container azurerm_cosmosdb_sql_container.temperatures_shared MUST partition on /deviceId, matching the IoT Hub Cosmos routing endpoint's partition_key_name = \"deviceId\" (MG-73). A container's partition key path is CREATE-ONLY on Azure — a drift here is an unrepairable mis-partition, and check 20 keys on the source label and cannot see this destination container."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_container.temperatures_shared.partition_key_version == 1
    error_message = "The destination temperatures container must reproduce the source partition_key_version (1). A version drift is a definition drift on a create-only property."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_container.temperatures_shared.default_ttl == var.temperature_data_ttl
    error_message = "The destination temperatures container must reproduce the source default_ttl (var.temperature_data_ttl). TTL is part of the faithful definition MG-53 requires."
  }
}

# Faithful destination shape for all five containers — the config-known half of
# the definition (partition keys, versions, database binding, unique keys). The
# indexing policy and the live definition-parity comparison are covered by the
# parity script (step 3) and the live assertion (step 4); this pins the parts a
# plan can see so a copy-paste drift on the destination is caught in-container.
run "destination_containers_reproduce_the_source_definition_shape" {
  command = plan

  # Partition key paths — each destination container matches its source sibling.
  assert {
    condition = alltrue([
      azurerm_cosmosdb_sql_container.devices_shared.partition_key_paths == tolist(["/id"]),
      azurerm_cosmosdb_sql_container.temperatures_shared.partition_key_paths == tolist(["/deviceId"]),
      azurerm_cosmosdb_sql_container.cooks_shared.partition_key_paths == tolist(["/userId"]),
      azurerm_cosmosdb_sql_container.users_shared.partition_key_paths == tolist(["/id"]),
      azurerm_cosmosdb_sql_container.recipes_shared.partition_key_paths == tolist(["/userId"]),
    ])
    error_message = "Every destination container must reproduce its source sibling's partition key path: devices /id, temperatures /deviceId, cooks /userId, users /id, recipes /userId. Partition key paths are create-only; a drift is an unrepairable mis-partition."
  }

  # Partition key version — each destination container matches its source sibling.
  assert {
    condition = alltrue([
      azurerm_cosmosdb_sql_container.devices_shared.partition_key_version == 1,
      azurerm_cosmosdb_sql_container.temperatures_shared.partition_key_version == 1,
      azurerm_cosmosdb_sql_container.cooks_shared.partition_key_version == 1,
      azurerm_cosmosdb_sql_container.users_shared.partition_key_version == 1,
      azurerm_cosmosdb_sql_container.recipes_shared.partition_key_version == 1,
    ])
    error_message = "Every destination container must reproduce the source partition_key_version (1)."
  }

  # Every destination container lives under the shared-throughput database, not
  # the source database — this is what makes them draw on the database-level offer.
  assert {
    condition = alltrue([
      azurerm_cosmosdb_sql_container.devices_shared.database_name == azurerm_cosmosdb_sql_database.meatgeek_shared.name,
      azurerm_cosmosdb_sql_container.temperatures_shared.database_name == azurerm_cosmosdb_sql_database.meatgeek_shared.name,
      azurerm_cosmosdb_sql_container.cooks_shared.database_name == azurerm_cosmosdb_sql_database.meatgeek_shared.name,
      azurerm_cosmosdb_sql_container.users_shared.database_name == azurerm_cosmosdb_sql_database.meatgeek_shared.name,
      azurerm_cosmosdb_sql_container.recipes_shared.database_name == azurerm_cosmosdb_sql_database.meatgeek_shared.name,
    ])
    error_message = "Every destination container must be created under azurerm_cosmosdb_sql_database.meatgeek_shared (the shared-throughput database), not the source database. Living under the shared database is what lets a container share the single database-level offer instead of taking its own dedicated offer."
  }

  # Unique key policies reproduced faithfully (the two containers that declare them).
  assert {
    condition     = one(azurerm_cosmosdb_sql_container.devices_shared.unique_key).paths == toset(["/userId", "/name"])
    error_message = "The destination devices container must reproduce the source unique_key policy (paths /userId + /name). Unique key policy is part of the faithful definition and is create-only on Azure."
  }

  assert {
    condition     = one(azurerm_cosmosdb_sql_container.users_shared.unique_key).paths == toset(["/email"])
    error_message = "The destination users container must reproduce the source unique_key policy (path /email)."
  }
}

# Regression fence RETIRED by MG-54. This run block asserted that the SOURCE
# subtree (azurerm_cosmosdb_sql_container.temperatures + azurerm_cosmosdb_sql_database.meatgeek)
# was left untouched by the MG-53 destination addition. MG-54 has now DELETED that
# source subtree entirely (the five source containers and the source database), so
# there is no source left to fence — every assertion here referenced resources that
# no longer exist and would error on resolution under `terraform test`. The
# regression it guarded (destination work perturbing the source) is moot once the
# source is gone; the surviving destination-shape coverage above is unaffected.
