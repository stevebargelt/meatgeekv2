# Plan-level free-tier wiring test for the cosmos-db module (MG-48).
#
# Runs the module as the config-under-test with a MOCKED azurerm provider — NO
# live Azure, NO credentials, NO apply. It pins the one thing MG-48 found broken:
# `enable_free_tier` existed as a module variable but nothing carried a value into
# it, so the module default (false) applied silently and the dev account paid for
# throughput the subscription's free-tier allowance already covers.
#
# The assertions are on free_tier_enabled TRACKING the variable in both directions,
# not on a fixed value — the value is an environment decision (dev holds the
# subscription's single free-tier slot; prod is explicitly false), while "the knob
# reaches the resource" is the module's contract.
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

# dev claims the subscription's one free-tier slot.
run "free_tier_reaches_the_account_when_enabled" {
  command = plan

  variables {
    enable_free_tier = true
  }

  assert {
    condition     = azurerm_cosmosdb_account.main.free_tier_enabled == true
    error_message = "enable_free_tier = true must reach the account as free_tier_enabled — an unwired knob is the MG-48 defect itself"
  }
}

# prod (and the module default) must NOT claim it: only one free-tier account is
# allowed per subscription, and a second claimant strands the first.
run "free_tier_is_off_when_disabled" {
  command = plan

  variables {
    enable_free_tier = false
  }

  assert {
    condition     = azurerm_cosmosdb_account.main.free_tier_enabled == false
    error_message = "enable_free_tier = false must leave the account off the free tier so it cannot take the subscription's single slot from dev"
  }
}
