# Key Vault for the APNs signing key (#241, spec #237 "Sending to Apple").
#
# The Function App will sign its APNs provider token (an ES256 JWT) with a key
# held here. The key is the owner's Apple "AuthKey_<KEYID>.p8", imported once by
# hand as a software-protected EC P-256 key whose only permitted operation is
# `sign` (docs/infrastructure/apns-key-vault.md). Terraform never creates, reads
# or imports the key: no key material, key id or Apple team id passes through
# Terraform, its state, an app setting or this repository. An EMPTY vault is the
# normal state after an apply, and nothing in the stack needs the key to exist.
#
# WHY AZAPI AND NOT azurerm_key_vault. azurerm_key_vault reads the vault's
# certificate contacts over the Key Vault DATA PLANE on every refresh. No
# Terraform principal in this stack performs a data-plane operation (the MG-24
# rule that moved the Functions storage account to azapi), and the CI plan and
# apply identities hold no Key Vault data-plane role. azapi creates the vault
# over the ARM control plane only.
#
# RBAC ONLY. enableRbacAuthorization = true and no access policies: every
# permission on the key is an Azure role assignment, visible to the
# role-assignment-write activity-log alert and to `az role assignment list`.
#
# SOFT DELETE, 7 DAYS, NO PURGE PROTECTION. Soft delete cannot be turned off.
# Retention is the minimum, 7 days, and is fixed once the vault exists. Purge
# protection stays off because, once on, it can never be turned off, and the
# vault name is deterministic: after an (authorised) destroy the name would be
# locked for the whole retention period with no way to purge it. With it off,
# the operator can `az keyvault recover` the vault, key included, or
# `az keyvault purge` it. The CI apply identity can do neither (deleted vaults
# live at subscription scope, outside its resource group), which is why a
# recreate after a destroy is an operator step; see the doc above. The key is
# also recoverable from Apple's side: a lost key is revoked and replaced in the
# Apple Developer portal.
#
# PUBLIC NETWORK ACCESS. The Function App runs on Flex Consumption with no VNet
# integration and no fixed outbound address, so the vault accepts connections
# from the internet and RBAC is the only gate. A key that only signs, held by a
# vault that grants sign to one managed identity, is the boundary.

terraform {
  required_providers {
    azurerm = {
      source  = "hashicorp/azurerm"
      version = "~> 4.0"
    }
    azapi = {
      source  = "Azure/azapi"
      version = "~> 2.0"
    }
  }
}

locals {
  # The one key this vault is for. The owner imports under exactly this name;
  # the app finds it through the APNS_KEY_NAME setting.
  key_name = "apns-auth-key"

  # The vault's data-plane URI, composed rather than read from the response so
  # it is known at plan time (the app setting that carries it then plans as a
  # known value, and the secret-inspection gate sees it before apply). Public
  # cloud DNS, like every other endpoint in this stack.
  vault_uri = "https://${var.name}.vault.azure.net/"
}

resource "azapi_resource" "vault" {
  type      = "Microsoft.KeyVault/vaults@2023-07-01"
  name      = var.name
  parent_id = var.resource_group_id
  location  = var.location
  tags      = var.tags

  body = {
    properties = {
      tenantId = var.tenant_id
      sku = {
        family = "A"
        name   = "standard"
      }

      enableRbacAuthorization = true
      accessPolicies          = []

      enableSoftDelete          = true
      softDeleteRetentionInDays = 7
      # enablePurgeProtection is deliberately ABSENT: ARM refuses `false` on
      # the property, and leaving it out keeps purge protection off. See above.

      enabledForDeployment         = false
      enabledForDiskEncryption     = false
      enabledForTemplateDeployment = false

      publicNetworkAccess = "Enabled"
    }
  }
}

# The Function App identity may SIGN with the key and may not read or export it.
#
# WHY THE BUILT-IN `Key Vault Crypto User` AND NOT A SIGN-ONLY CUSTOM ROLE.
# A custom role is a roleDefinitions write, which the CI apply identity cannot
# make (Contributor excludes Microsoft.Authorization writes, and its RBAC
# Administrator grant covers role ASSIGNMENTS only), so a custom role would turn
# every change to it into an operator step. No built-in role grants sign alone.
# Key Vault Crypto User is the narrowest built-in role that grants
# `Microsoft.KeyVault/vaults/keys/sign/action`. What it grants beyond sign, and
# why each is acceptable for this key:
#   - keys/read: the PUBLIC key and the key's attributes. A private key is never
#     returned by any Key Vault operation.
#   - encrypt, decrypt, wrap, unwrap, verify: meaningless here. An EC key has no
#     encrypt/wrap algorithms, and the key is imported with key_ops = [sign].
#   - backup: a blob that only Key Vault, in the same subscription and
#     geography, can restore. It is not the private key.
#   - update: the key's attributes (enabled, dates, tags, key_ops). It cannot
#     change the key material and cannot make it exportable: a vault (standard
#     or premium) has no export operation, and key release needs
#     `keys/release/action`, which this role does not have.
# So the identity can sign with the key, and at worst disable it or change its
# ops; it can never obtain the private key.
#
# Scoped to this vault, which holds only this key. A key-scoped assignment is
# not possible here: the key does not exist until the owner imports it.
#
# Count-guarded and OFF by default (var.signer_grant_enabled): the CI apply
# identity's ABAC condition only permits roles bootstrap.sh has learned from
# bootstrap/tf-managed-role-allowlist.tsv, so the grant may only be switched on
# after the owner has re-run bootstrap.sh. Same rule as every other grant that
# added a role (docs/infrastructure/bootstrap-runbook.md).
resource "azurerm_role_assignment" "signer" {
  count                = var.signer_grant_enabled ? 1 : 0
  scope                = azapi_resource.vault.id
  role_definition_name = "Key Vault Crypto User"
  principal_id         = var.signer_principal_id
  principal_type       = "ServicePrincipal"
}
