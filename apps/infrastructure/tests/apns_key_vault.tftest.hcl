# Plan-level test for the APNs Key Vault wiring in the root module (#241).
#
# Runs the ROOT module with MOCKED providers: no live Azure, no credentials, no
# apply (static check 15). It pins the two switches:
#
#   - apns_key_vault_enabled (default false; dev.tfvars sets it, prod does not):
#     off creates no vault and publishes no APNS_* setting; on creates one vault
#     and publishes exactly its URI and the key's name to the Function App;
#   - apns_key_signer_enabled (default false until bootstrap.sh is re-run): the
#     Function App identity's Key Vault Crypto User grant exists only when both
#     are on.
#
# module.iot_hub is overridden for known names, as in the other root tests. The
# vault's shape and the grant's role are pinned by the module's own test
# (modules/apns-key-vault/tests/apns_key_vault.tftest.hcl).
#
# Run:  terraform -chdir=apps/infrastructure test
# (init with `terraform init -backend=false` first).

mock_provider "azurerm" {}
mock_provider "azapi" {}
mock_provider "time" {}

override_module {
  target = module.iot_hub
  outputs = {
    iot_hub_id                                = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.Devices/IotHubs/meatgeek-v2-dev-iothub"
    iot_hub_name                              = "meatgeek-v2-dev-iothub"
    hostname                                  = "meatgeek-v2-dev-iothub.azure-devices.net"
    identity_principal_id                     = "33333333-3333-3333-3333-333333333333"
    eventhub_namespace_id                     = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg/providers/Microsoft.EventHub/namespaces/meatgeek-v2-dev-ehns"
    eventhub_namespace_fqdn                   = "meatgeek-v2-dev-ehns.servicebus.windows.net"
    temperature_broadcast_consumer_group_name = "api-broadcast"
    targets_consumer_group_name               = "api-targets"
  }
}

# A known subscription id makes the derived vault name known at plan time. Not
# GUID-shaped, so static check 1 (no hardcoded subscription id) has nothing to
# flag; the mocked provider needs no real value.
override_data {
  target = data.azurerm_client_config.current
  values = {
    subscription_id = "subscription-under-test"
    tenant_id       = "00000000-0000-0000-0000-000000000000"
  }
}

# Placeholder ids only, never the real dev coordinates. The functions_auth_*
# values are here because modules/functions refuses, by precondition, to plan a
# Function App without Easy Auth; they are not what this test is about.
variables {
  environment                      = "dev"
  functions_auth_client_id         = "11111111-1111-1111-1111-111111111111"
  functions_auth_tenant_id         = "00000000-0000-0000-0000-000000000000"
  functions_auth_allowed_audiences = ["api://11111111-1111-1111-1111-111111111111"]
}

run "no_vault_by_default" {
  command = plan

  assert {
    condition     = var.apns_key_vault_enabled == false && var.apns_key_signer_enabled == false
    error_message = "both APNs Key Vault switches must default to false"
  }

  assert {
    condition     = length(module.apns_key_vault) == 0
    error_message = "no Key Vault may be created while apns_key_vault_enabled is false"
  }

  assert {
    condition     = length([for s in module.azure_functions.app_setting_names : s if startswith(s, "APNS_")]) == 0
    error_message = "with no vault, the Function App must have no APNS_* setting"
  }

  assert {
    condition     = output.apns_key_vault_name == null && output.apns_key_name == null
    error_message = "the vault outputs must be null when there is no vault"
  }
}

run "vault_without_grant" {
  command = plan

  variables {
    apns_key_vault_enabled = true
  }

  assert {
    condition     = length(module.apns_key_vault) == 1
    error_message = "exactly one Key Vault when apns_key_vault_enabled is true"
  }

  assert {
    condition     = output.apns_key_vault_name == "mgv2-dev-kv-${substr(sha1("subscription-under-test-apns-kv"), 0, 10)}"
    error_message = "the vault name must be mgv2-<env>-kv-<10 hex derived from the subscription>"
  }

  assert {
    condition     = length(output.apns_key_vault_name) <= 24
    error_message = "a Key Vault name is at most 24 characters"
  }

  assert {
    condition     = output.apns_key_name == "apns-auth-key"
    error_message = "the key name must come from the module (apns-auth-key)"
  }

  assert {
    condition     = jsonencode(sort([for s in module.azure_functions.app_setting_names : s if startswith(s, "APNS_")])) == jsonencode(["APNS_KEY_NAME", "APNS_KEY_VAULT_URI"])
    error_message = "the vault must publish exactly APNS_KEY_VAULT_URI and APNS_KEY_NAME to the Function App"
  }

  assert {
    condition     = length(module.apns_key_vault[0].signer_assignment_ids) == 0
    error_message = "the signer grant must stay off until apns_key_signer_enabled is set (bootstrap.sh re-run first)"
  }
}

run "vault_with_grant" {
  command = plan

  variables {
    apns_key_vault_enabled  = true
    apns_key_signer_enabled = true
  }

  assert {
    condition     = length(module.apns_key_vault[0].signer_assignment_ids) == 1
    error_message = "exactly one signer grant when both switches are on"
  }
}

run "grant_switch_alone_creates_nothing" {
  command = plan

  variables {
    apns_key_signer_enabled = true
  }

  assert {
    condition     = length(module.apns_key_vault) == 0
    error_message = "apns_key_signer_enabled alone must not create a vault or a grant"
  }
}
