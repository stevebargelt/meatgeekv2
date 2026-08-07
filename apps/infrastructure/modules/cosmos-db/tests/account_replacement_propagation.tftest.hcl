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
# It is DISCOVERY-DRIVEN rather than an allowlist, which makes it complete over
# the reference SHAPES its scan recognizes — a new resource of a type nobody
# anticipated is covered the day it is written. That is NOT the same as being
# enumeration-complete, and an earlier revision of this preamble claimed it was.
# The correction matters, so it is stated rather than quietly dropped: a lexical
# scan can only match shapes it was taught, every unmatched shape is an unguarded
# pairing, and check 18's own exclusion boundary is the authoritative list of what
# it does not see. Read that boundary, not this file, before concluding a
# reference is covered.
#
# A second limit, stated plainly: the assertions below compare VALUES, and value
# equality cannot distinguish "the child references the parent" from "the child
# happens to restate the same literal". Only check 18's lexical scan sees the
# reference itself. What value equality DOES catch is the failure mode that would
# invalidate the fix — see below.
#
# What this file DOES pin is the premise the fix rests on. Each child reaches its
# parent through the parent's CONFIGURED `name` (main.tf:119 for the database;
# :134-135, :189-190, :243-244, :297-298, :329-330 for the containers), and every
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
# REFERENCE AUDIT OF THIS MODULE, and a correction to an earlier revision of this
# file. The MG-48 re-dispatch found that the sibling iot-hub module carried a
# whole class of parent reference nobody had enumerated: values that reach a
# parent by configured name WITHOUT being a bare `<type>.<label>.name` — an
# `entity_path` whose field name does not end in `_name`, and a parent name
# interpolated inside a larger string. Both are invisible to a scan keyed on the
# argument's name or on a bare reference. So this module was re-scanned for every
# managed-resource reference of any shape, not just the ones check 18 matches:
#
#   grep -nE '(^|[^A-Za-z0-9_.])azurerm_[a-z0-9_]+\.[a-z0-9_]+\.[a-z0-9_]+' main.tf
#   grep -nE '"\$\{[^}]*azurerm_' main.tf
#
# Result: 17 managed-resource references inside `resource` blocks, and ZERO
# interpolated ones — the shape that broke iot-hub does not occur in this module.
# The 17 fall into exactly three attribute shapes, all configured, all therefore
# ordering-only:
#
#   account_name        = azurerm_cosmosdb_account.main.name           (6: db + 5 containers)
#   database_name       = azurerm_cosmosdb_sql_database.meatgeek.name  (5: containers)
#   resource_group_name = azurerm_cosmosdb_account.main.resource_group_name (6)
#
# That third shape is the correction. An earlier revision of this preamble
# declined to assert `resource_group_name` "for the same reason check 18 excludes
# it — it is not a Cosmos-account pairing." That is FALSE HERE, and a reader who
# believed it would mis-enumerate the module. These lines do not reach a resource
# group at all: they reach `azurerm_cosmosdb_account.main`, the very parent this
# file is about, through a configured attribute that simply is not called `name`.
# They are Cosmos-account pairings. Check 18 skips them TWICE — once because the
# field is `resource_group_name`, once because the value's trailing attribute is
# not `.name` — so nothing but this file pins them.
#
# They are not a defect: the same `replace_triggered_by = [azurerm_cosmosdb_account.main]`
# that covers the `account_name` reference covers this one, because it names the
# parent, not the attribute. The point is that the coverage is a coincidence of
# the two shapes sharing a parent, not something either scan verified — so the
# shape is asserted below rather than excluded on a rationale that does not hold.
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

# THE THIRD SHAPE, asserted because no static scan sees it. Every one of the six
# children also reaches azurerm_cosmosdb_account.main through the account's
# CONFIGURED `resource_group_name` attribute. It is a reference to the ACCOUNT —
# not to a resource group — and it is exactly as ordering-only as `account_name`,
# for exactly the same reason: the value is var.resource_group_name passed
# through, byte-identical before and after the account is replaced.
#
# The first assertion is the load-bearing one: it pins that the attribute really
# is a pure function of the input variable. If the account's resource_group_name
# ever became computed, this reference would start carrying replacement on its
# own and the lifecycle blocks would no longer be the thing doing the work.
run "children_reach_the_account_through_its_configured_resource_group_name" {
  command = plan

  assert {
    condition     = azurerm_cosmosdb_account.main.resource_group_name == var.resource_group_name
    error_message = "The account's resource_group_name must be var.resource_group_name unchanged — a configured value. This is what makes the six children's `resource_group_name = azurerm_cosmosdb_account.main.resource_group_name` references ordering-only rather than replacement-carrying. Static check 18 cannot see this shape (the field is excluded by name AND the value's trailing attribute is not `.name`), so if it ever becomes computed this assertion is the only place that will notice"
  }

  assert {
    condition     = azurerm_cosmosdb_sql_database.meatgeek.resource_group_name == azurerm_cosmosdb_account.main.resource_group_name
    error_message = "The SQL database reaches azurerm_cosmosdb_account.main through the account's configured resource_group_name — a second, unscanned pairing with the SAME parent as its account_name reference. It is already covered by the database's replace_triggered_by only because that block names the parent rather than the attribute; nothing verifies that coincidence except this assertion"
  }

  assert {
    condition = alltrue([
      azurerm_cosmosdb_sql_container.devices.resource_group_name == azurerm_cosmosdb_account.main.resource_group_name,
      azurerm_cosmosdb_sql_container.temperatures.resource_group_name == azurerm_cosmosdb_account.main.resource_group_name,
      azurerm_cosmosdb_sql_container.cooks.resource_group_name == azurerm_cosmosdb_account.main.resource_group_name,
      azurerm_cosmosdb_sql_container.users.resource_group_name == azurerm_cosmosdb_account.main.resource_group_name,
      azurerm_cosmosdb_sql_container.recipes.resource_group_name == azurerm_cosmosdb_account.main.resource_group_name,
    ])
    error_message = "All five containers reach azurerm_cosmosdb_account.main through the account's configured resource_group_name. If a container ever sourced its resource group from anywhere else — var.resource_group_name directly, or a different parent — it would stop being paired with the account through this attribute, and the enumeration in this file's preamble would be stale. That silent staleness is how MG-48 broke dev three times"
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
