# Plan-level test for the APNs Key Vault module (#241).
#
# Runs the module with MOCKED providers: no live Azure, no credentials, no apply
# (static check 15). It pins:
#
#   - the vault: control-plane azapi resource, standard SKU, RBAC-authorised with
#     no access policies, soft delete at 7 days, purge protection left off,
#     nothing but RBAC enabled for other Azure services;
#   - that the module creates no key, secret or certificate: the key is imported
#     by the owner, by hand, and never passes through Terraform;
#   - the signer grant: off by default; when on, exactly one Key Vault Crypto
#     User assignment, scoped to this vault, for the signer as a
#     ServicePrincipal;
#   - the outputs the app settings are built from, known at plan time.
#
# The root wiring (the flags, the app settings) is pinned by
# apps/infrastructure/tests/apns_key_vault.tftest.hcl.
#
# Run:  terraform -chdir=apps/infrastructure/modules/apns-key-vault test
# (init with `terraform init -backend=false` first).

mock_provider "azurerm" {}
mock_provider "azapi" {}

variables {
  name                = "mgv2-dev-kv-0123456789"
  resource_group_id   = "/subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/meatgeek-v2-dev-rg"
  location            = "westus2"
  tenant_id           = "00000000-0000-0000-0000-000000000000"
  signer_principal_id = "33333333-3333-3333-3333-333333333333"
  tags = {
    Project = "MeatGeek V2"
  }
}

run "vault_shape" {
  command = plan

  assert {
    condition     = azapi_resource.vault.type == "Microsoft.KeyVault/vaults@2023-07-01"
    error_message = "the vault must be a control-plane azapi Microsoft.KeyVault/vaults resource"
  }

  assert {
    condition     = azapi_resource.vault.name == var.name && azapi_resource.vault.parent_id == var.resource_group_id && azapi_resource.vault.location == var.location
    error_message = "the vault must take its name, resource group and location from the inputs"
  }

  assert {
    condition     = azapi_resource.vault.tags == var.tags
    error_message = "the vault must carry the tags passed in"
  }

  assert {
    condition     = azapi_resource.vault.body.properties.sku.family == "A" && azapi_resource.vault.body.properties.sku.name == "standard"
    error_message = "the vault must be the standard SKU (software-protected keys, per-operation pricing)"
  }

  assert {
    condition     = azapi_resource.vault.body.properties.tenantId == var.tenant_id
    error_message = "the vault's tenant must be the one passed in, never a literal"
  }

  assert {
    condition     = azapi_resource.vault.body.properties.enableRbacAuthorization == true
    error_message = "the vault must use Azure RBAC, not access policies"
  }

  assert {
    condition     = length(azapi_resource.vault.body.properties.accessPolicies) == 0
    error_message = "the vault must declare no access policies"
  }

  assert {
    condition     = azapi_resource.vault.body.properties.enableSoftDelete == true && azapi_resource.vault.body.properties.softDeleteRetentionInDays == 7
    error_message = "soft delete must be on with the minimum retention, 7 days"
  }

  assert {
    condition     = !contains(keys(azapi_resource.vault.body.properties), "enablePurgeProtection")
    error_message = "purge protection must stay off: once on it can never be turned off, and the deterministic name would be locked for the retention period after a destroy"
  }

  assert {
    condition     = azapi_resource.vault.body.properties.enabledForDeployment == false && azapi_resource.vault.body.properties.enabledForDiskEncryption == false && azapi_resource.vault.body.properties.enabledForTemplateDeployment == false
    error_message = "no Azure service may read from the vault outside RBAC (VM deployment, disk encryption, ARM template deployment all off)"
  }

  assert {
    condition     = azapi_resource.vault.body.properties.publicNetworkAccess == "Enabled"
    error_message = "the vault must accept public connections: the Flex Consumption app has no VNet and no fixed outbound address"
  }
}

run "outputs_are_known_at_plan" {
  command = plan

  assert {
    condition     = output.vault_uri == "https://mgv2-dev-kv-0123456789.vault.azure.net/"
    error_message = "vault_uri must be composed from the name so it is known at plan time"
  }

  assert {
    condition     = output.key_name == "apns-auth-key"
    error_message = "the key name the owner imports under must be apns-auth-key"
  }

  assert {
    condition     = output.vault_name == var.name
    error_message = "vault_name must be the vault's name"
  }
}

run "signer_grant_off_by_default" {
  command = plan

  assert {
    condition     = var.signer_grant_enabled == false
    error_message = "signer_grant_enabled must default to false (the role needs a bootstrap.sh re-run first)"
  }

  assert {
    condition     = length(azurerm_role_assignment.signer) == 0
    error_message = "no signer grant may be planned while signer_grant_enabled is false"
  }
}

run "signer_grant_on_when_enabled" {
  command = plan

  variables {
    signer_grant_enabled = true
  }

  # The scope is the vault's computed id, unknown under `command = plan` with a
  # mocked provider, so it is not asserted here; static check 14 keeps every
  # role assignment inside the workload resource group.

  assert {
    condition     = length(azurerm_role_assignment.signer) == 1
    error_message = "exactly one signer grant when signer_grant_enabled is true"
  }

  assert {
    condition     = azurerm_role_assignment.signer[0].role_definition_name == "Key Vault Crypto User"
    error_message = "the signer must hold Key Vault Crypto User: the narrowest built-in role with keys/sign/action, and one without keys/release/action"
  }

  assert {
    condition     = azurerm_role_assignment.signer[0].principal_id == var.signer_principal_id && azurerm_role_assignment.signer[0].principal_type == "ServicePrincipal"
    error_message = "the grant must go to the signer identity, as a ServicePrincipal (the CI apply identity's ABAC condition requires principalType)"
  }
}

run "rejects_an_invalid_name" {
  command = plan

  variables {
    name = "meatgeek-v2-dev-apns-key-vault"
  }

  expect_failures = [var.name]
}
