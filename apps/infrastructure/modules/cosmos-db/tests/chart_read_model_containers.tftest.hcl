# Shape test for the HAR-74 cook chart read-model containers:
# azurerm_cosmosdb_sql_container.temperature_rollups_shared and
# azurerm_cosmosdb_sql_container.leases_shared.
#
# Mock provider, `command = plan` only (static check 15 forbids `command = apply`
# in any tftest, which keeps the PR gate credentialless).
#
# HOW "NO THROUGHPUT OF ITS OWN" IS ASSERTED HERE. The planned `.throughput` of a
# container that declares none is UNKNOWN at plan (Optional+Computed; see the
# header of shared_throughput_destination.tftest.hcl), so a plan condition on it
# errors rather than passing. CI pins Terraform ~1.9, which has no
# `override_during = plan` to make a mock value visible. So this file asserts the
# property two ways:
#
#   * `autoscale_settings` is a block that IS known at plan: its length must be 0.
#   * `throughput` is asserted against the module's OWN SOURCE: the resource block
#     for each container, read from main.tf with file(), must contain no
#     `throughput` or `autoscale_settings` argument. A non-vacuity run proves the
#     same detector DOES find the `throughput = 400` argument on the shared
#     database block, so a broken regex cannot pass by matching nothing.
#
# The live, authoritative check that neither container holds an offer is
# scripts/assert-live-shared-throughput.sh, run by the dev apply after create.
#
# Run:  terraform -chdir=apps/infrastructure/modules/cosmos-db test
# (init the module dir with `terraform init -backend=false` first).

mock_provider "azurerm" {}

variables {
  resource_prefix     = "meatgeek-v2-dev"
  environment         = "dev"
  cosmos_account_name = "mgv2-dev-f640e19ae7ab"
  resource_group_name = "meatgeek-v2-dev-rg"
  location            = "westus2"
}

run "rollups_and_leases_have_the_decided_partition_keys" {
  command = plan

  assert {
    condition     = azurerm_cosmosdb_sql_container.temperature_rollups_shared.name == "temperature-rollups"
    error_message = "The rollups container must be named temperature-rollups."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_container.temperature_rollups_shared.partition_key_paths == tolist(["/deviceId"])
    error_message = "temperature-rollups must partition on /deviceId: the chart query is scoped to one device, and a partition key path is create-only."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_container.temperature_rollups_shared.partition_key_version == 1
    error_message = "temperature-rollups must use partition_key_version 1, like its siblings."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_container.leases_shared.name == "leases"
    error_message = "The lease container must be named leases."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_container.leases_shared.partition_key_paths == tolist(["/id"])
    error_message = "leases must partition on /id, as the Functions Cosmos DB trigger requires of its lease container."
  }

  assert {
    condition = alltrue([
      azurerm_cosmosdb_sql_container.temperature_rollups_shared.database_name == azurerm_cosmosdb_sql_database.meatgeek_shared.name,
      azurerm_cosmosdb_sql_container.leases_shared.database_name == azurerm_cosmosdb_sql_database.meatgeek_shared.name,
    ])
    error_message = "Both containers must live under the shared-throughput database azurerm_cosmosdb_sql_database.meatgeek_shared, so they draw on its single 400 RU/s offer."
  }
}

run "rollups_has_no_ttl_and_a_narrow_index" {
  command = plan

  # default_ttl is Optional (not Computed): unset plans as a KNOWN null.
  assert {
    condition     = azurerm_cosmosdb_sql_container.temperature_rollups_shared.default_ttl == null
    error_message = "temperature-rollups must not set default_ttl: charts of past cooks outlive the raw readings' TTL."
  }

  assert {
    condition     = azurerm_cosmosdb_sql_container.leases_shared.default_ttl == null
    error_message = "leases must not set default_ttl."
  }

  assert {
    condition     = one(azurerm_cosmosdb_sql_container.temperature_rollups_shared.indexing_policy).indexing_mode == "consistent"
    error_message = "temperature-rollups must use consistent indexing."
  }

  assert {
    condition     = [for p in one(azurerm_cosmosdb_sql_container.temperature_rollups_shared.indexing_policy).excluded_path : p.path] == ["/*"]
    error_message = "temperature-rollups must exclude /* from indexing, so only the query's two paths are indexed."
  }

  assert {
    condition     = toset([for p in one(azurerm_cosmosdb_sql_container.temperature_rollups_shared.indexing_policy).included_path : p.path]) == toset(["/deviceId/?", "/hourStart/?"])
    error_message = "temperature-rollups must index exactly /deviceId/? and /hourStart/?, the two paths in WHERE c.deviceId = @d AND c.hourStart >= @from AND c.hourStart < @to."
  }
}

run "neither_container_has_throughput_of_its_own" {
  command = plan

  # Known at plan: an unset autoscale_settings block is an empty list.
  assert {
    condition = alltrue([
      length(azurerm_cosmosdb_sql_container.temperature_rollups_shared.autoscale_settings) == 0,
      length(azurerm_cosmosdb_sql_container.leases_shared.autoscale_settings) == 0,
    ])
    error_message = "Neither temperature-rollups nor leases may declare autoscale_settings: both share the database-level offer."
  }

  # `throughput` is unknown at plan when unset, so it is asserted on the source
  # block (see the header). The block runs from its `resource` line to the first
  # `}` at column 0.
  assert {
    condition = length(regexall(
      "(?m)^[ \\t]*(throughput|autoscale_settings)\\b",
      regex("(?ms)^resource \"azurerm_cosmosdb_sql_container\" \"temperature_rollups_shared\" \\{\\n(.*?)^\\}", file("${path.module}/main.tf"))[0]
    )) == 0
    error_message = "temperature-rollups must not declare throughput or autoscale_settings in main.tf. A container-level offer would cost at least 400 RU/s on its own instead of sharing the database's offer."
  }

  assert {
    condition = length(regexall(
      "(?m)^[ \\t]*(throughput|autoscale_settings)\\b",
      regex("(?ms)^resource \"azurerm_cosmosdb_sql_container\" \"leases_shared\" \\{\\n(.*?)^\\}", file("${path.module}/main.tf"))[0]
    )) == 0
    error_message = "leases must not declare throughput or autoscale_settings in main.tf. A container-level offer would cost at least 400 RU/s on its own instead of sharing the database's offer."
  }
}

# Non-vacuity control for the source-block detector above: the shared database
# block DOES declare `throughput = 400`, so the same regexes must find exactly one
# match there. If the block extraction or the argument pattern breaks, this fails
# instead of the two assertions above passing on nothing.
run "throughput_source_detector_is_not_vacuous" {
  command = plan

  assert {
    condition = length(regexall(
      "(?m)^[ \\t]*(throughput|autoscale_settings)\\b",
      regex("(?ms)^resource \"azurerm_cosmosdb_sql_database\" \"meatgeek_shared\" \\{\\n(.*?)^\\}", file("${path.module}/main.tf"))[0]
    )) == 1
    error_message = "The source-block throughput detector no longer finds the shared database's `throughput = 400`. The no-throughput assertions for temperature-rollups and leases would then pass vacuously; fix the regex before trusting them."
  }

  assert {
    condition = length(regexall(
      "(?m)^[ \\t]*partition_key_paths\\b",
      regex("(?ms)^resource \"azurerm_cosmosdb_sql_container\" \"temperature_rollups_shared\" \\{\\n(.*?)^\\}", file("${path.module}/main.tf"))[0]
    )) == 1
    error_message = "The source-block extraction for temperature_rollups_shared no longer captures the block body (partition_key_paths not found)."
  }

  assert {
    condition = length(regexall(
      "(?m)^[ \\t]*partition_key_paths\\b",
      regex("(?ms)^resource \"azurerm_cosmosdb_sql_container\" \"leases_shared\" \\{\\n(.*?)^\\}", file("${path.module}/main.tf"))[0]
    )) == 1
    error_message = "The source-block extraction for leases_shared no longer captures the block body (partition_key_paths not found)."
  }
}
