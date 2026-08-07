# Account/child replacement-pairing test for the cosmos-db module (MG-48).
#
# Runs the module as the config-under-test with a MOCKED azurerm provider — NO
# live Azure, NO credentials, NO apply.
#
# WHAT THIS FILE DOES NOT DO — read before trusting it as the regression guard.
# It does NOT prove that replacing azurerm_cosmosdb_account.main plans the SQL
# database and its five containers for replacement. That property is a state
# DIFF: a resource can only be "replaced" relative to a prior state. A
# `terraform test` run block with `command = plan` always starts from EMPTY
# state, and static check 15 forbids `command = apply` because the PR gate is
# credentialless — so a tftest that satisfies check 15 has no prior state and
# can never observe a replacement. `plan_options { replace = [...] }` does not
# help either: with nothing in state it is a no-op. And `replace_triggered_by`
# is a lifecycle meta-argument that never appears in `terraform show -json`, so
# the plan JSON cannot be inspected for it either.
#
# No Terraform-native test can observe this property. STATIC CHECK 18 in
# apps/infrastructure/scripts/tf-static-checks.sh is the real guard: it scans the
# committed HCL for every child that reaches a parent by the parent's configured
# name and requires that child to carry a matching lifecycle.replace_triggered_by.
# That check is enumeration-complete by construction (it discovers pairs rather
# than listing them) and is mutation-verified. This file cannot replace it.
#
# A second limit, stated plainly: the assertions below compare VALUES, and value
# equality cannot distinguish "the child references the parent" from "the child
# happens to restate the same literal". Only check 18's lexical scan sees the
# reference itself. What value equality DOES catch is the failure mode that would
# invalidate the fix — see below.
#
# What this file DOES pin is the premise the fix rests on. Each child reaches its
# parent through the parent's CONFIGURED `name` (main.tf:99 for the database;
# :109-110, :156-157, :204-205, :252-253, :278-279 for the containers), and every
# one of those names is a pure function of input variables — a static literal,
# identical before and after a replacement. That is exactly why those references
# propagate ORDERING but not REPLACEMENT, and therefore why each of the six
# children needs its own `replace_triggered_by` lifecycle block in main.tf.
#
# The concrete failure this premise explains: `free_tier_enabled` is create-only,
# so claiming the free tier REPLACED the dev account. Azure destroyed the account
# and, with it, meatgeek-v2-dev-db and all five containers — but Terraform had
# never planned those six for replacement, so state went on listing them as
# existing. The IoT Hub Cosmos endpoint create then failed with Azure IH400142
# "Database does not exist. DatabaseName: meatgeek-v2-dev-db".
#
# If anyone ever makes a child reach its parent through a COMPUTED attribute
# (`.id`, or a name Azure hands back), these assertions fail — under the mocked
# provider a computed attribute is UNKNOWN at plan time, so the condition cannot
# be evaluated — and the lifecycle blocks should be revisited: a reference to a
# computed attribute carries replacement on its own.
#
# `resource_group_name` is deliberately NOT asserted here, for the same reason
# check 18 excludes it: every resource in the stack reaches the resource group by
# name, and an RG replacement is a whole-stack event the destroy guard blocks on
# sight. It is not a Cosmos-account pairing.
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

# The three parent names the whole graph hangs off. Each must be derivable from
# input variables ALONE: a value Terraform computes from config survives a
# replacement byte-for-byte, which is the entire reason the children below cannot
# see their parent go away.
run "parent_names_are_configured_values_that_survive_replacement" {
  command = plan

  assert {
    condition     = azurerm_cosmosdb_account.main.name == substr(join("", regexall("[a-z0-9-]", lower(var.cosmos_account_name))), 0, 44)
    error_message = "The Cosmos account name must be a deterministic function of var.cosmos_account_name only. If it ever became computed (Azure-assigned, random-suffixed), children referencing it would change on replacement and would be planned for replacement for free — at which point the replace_triggered_by blocks in main.tf are no longer the thing carrying replacement across and should be re-derived rather than left as dead weight"
  }

  assert {
    condition     = azurerm_cosmosdb_sql_database.meatgeek.name == "${var.resource_prefix}-db"
    error_message = "The SQL database name must be the configured literal '${var.resource_prefix}-db' — this is the name that stayed in Terraform state after Azure destroyed the database with the account, and the name Azure rejected with IH400142 when the IoT Hub endpoint tried to bind to it"
  }

  assert {
    condition     = azurerm_cosmosdb_account.main.free_tier_enabled == var.enable_free_tier
    error_message = "free_tier_enabled must track var.enable_free_tier. It is CREATE-ONLY on Azure, so this one argument is the trigger for the whole account-replacement scenario this file exists to document — if it ever stops reaching the account, the propagation premise still holds but its most likely cause has been silently disarmed"
  }
}

# The database reaches its account by the account's CONFIGURED name, not by its
# id. Ordering only. azurerm_cosmosdb_sql_database.meatgeek therefore needs
# lifecycle.replace_triggered_by = [azurerm_cosmosdb_account.main].
run "database_reaches_its_account_through_the_accounts_configured_name" {
  command = plan

  assert {
    condition     = azurerm_cosmosdb_sql_database.meatgeek.account_name == azurerm_cosmosdb_account.main.name
    error_message = "The SQL database must reach the account through azurerm_cosmosdb_account.main.name — a configured value identical before and after replacement. This pairing is what azurerm_cosmosdb_sql_database.meatgeek's replace_triggered_by must name; without that block Azure destroys the database with the account while Terraform's state keeps listing it"
  }
}

# All five containers reach the account AND the database by configured name.
# Each therefore needs replace_triggered_by naming BOTH parents: the account
# because Azure destroys the container with it, and the database because a
# replaced database is a new, empty database that the old container is not in.
run "containers_reach_their_parents_through_configured_names" {
  command = plan

  # --- devices ---
  assert {
    condition     = azurerm_cosmosdb_sql_container.devices.account_name == azurerm_cosmosdb_account.main.name
    error_message = "Container 'devices' must reach the account through azurerm_cosmosdb_account.main.name — a configured value that does not change on replacement, so this reference orders creation but never propagates replacement. azurerm_cosmosdb_sql_container.devices must name azurerm_cosmosdb_account.main in replace_triggered_by"
  }
  assert {
    condition     = azurerm_cosmosdb_sql_container.devices.database_name == azurerm_cosmosdb_sql_database.meatgeek.name
    error_message = "Container 'devices' must reach the database through azurerm_cosmosdb_sql_database.meatgeek.name — a configured literal, so a REPLACED database looks identical from here. azurerm_cosmosdb_sql_container.devices must name azurerm_cosmosdb_sql_database.meatgeek in replace_triggered_by or it is left in state pointing at a database that no longer holds it"
  }

  # --- temperatures ---
  assert {
    condition     = azurerm_cosmosdb_sql_container.temperatures.account_name == azurerm_cosmosdb_account.main.name
    error_message = "Container 'temperatures' must reach the account through azurerm_cosmosdb_account.main.name — configured, unchanged by replacement, ordering only. azurerm_cosmosdb_sql_container.temperatures must name azurerm_cosmosdb_account.main in replace_triggered_by. This is the container the IoT Hub Cosmos endpoint writes into, so a ghost entry here is the IH400142 path"
  }
  assert {
    condition     = azurerm_cosmosdb_sql_container.temperatures.database_name == azurerm_cosmosdb_sql_database.meatgeek.name
    error_message = "Container 'temperatures' must reach the database through azurerm_cosmosdb_sql_database.meatgeek.name — a configured literal that survives the database's replacement, so azurerm_cosmosdb_sql_container.temperatures must name azurerm_cosmosdb_sql_database.meatgeek in replace_triggered_by"
  }

  # --- cooks ---
  assert {
    condition     = azurerm_cosmosdb_sql_container.cooks.account_name == azurerm_cosmosdb_account.main.name
    error_message = "Container 'cooks' must reach the account through azurerm_cosmosdb_account.main.name — configured, unchanged by replacement, ordering only. azurerm_cosmosdb_sql_container.cooks must name azurerm_cosmosdb_account.main in replace_triggered_by"
  }
  assert {
    condition     = azurerm_cosmosdb_sql_container.cooks.database_name == azurerm_cosmosdb_sql_database.meatgeek.name
    error_message = "Container 'cooks' must reach the database through azurerm_cosmosdb_sql_database.meatgeek.name — a configured literal that survives the database's replacement, so azurerm_cosmosdb_sql_container.cooks must name azurerm_cosmosdb_sql_database.meatgeek in replace_triggered_by"
  }

  # --- users ---
  assert {
    condition     = azurerm_cosmosdb_sql_container.users.account_name == azurerm_cosmosdb_account.main.name
    error_message = "Container 'users' must reach the account through azurerm_cosmosdb_account.main.name — configured, unchanged by replacement, ordering only. azurerm_cosmosdb_sql_container.users must name azurerm_cosmosdb_account.main in replace_triggered_by"
  }
  assert {
    condition     = azurerm_cosmosdb_sql_container.users.database_name == azurerm_cosmosdb_sql_database.meatgeek.name
    error_message = "Container 'users' must reach the database through azurerm_cosmosdb_sql_database.meatgeek.name — a configured literal that survives the database's replacement, so azurerm_cosmosdb_sql_container.users must name azurerm_cosmosdb_sql_database.meatgeek in replace_triggered_by"
  }

  # --- recipes ---
  assert {
    condition     = azurerm_cosmosdb_sql_container.recipes.account_name == azurerm_cosmosdb_account.main.name
    error_message = "Container 'recipes' must reach the account through azurerm_cosmosdb_account.main.name — configured, unchanged by replacement, ordering only. azurerm_cosmosdb_sql_container.recipes must name azurerm_cosmosdb_account.main in replace_triggered_by"
  }
  assert {
    condition     = azurerm_cosmosdb_sql_container.recipes.database_name == azurerm_cosmosdb_sql_database.meatgeek.name
    error_message = "Container 'recipes' must reach the database through azurerm_cosmosdb_sql_database.meatgeek.name — a configured literal that survives the database's replacement, so azurerm_cosmosdb_sql_container.recipes must name azurerm_cosmosdb_sql_database.meatgeek in replace_triggered_by"
  }
}
