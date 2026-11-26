# APNs Key Vault module outputs (#241). None is a credential: the vault holds a
# key that never leaves it, and these name where it is.

output "vault_id" {
  description = "Resource ID of the vault (the scope of the signer grant, and of the owner's one-off import grant)."
  value       = azapi_resource.vault.id
}

output "vault_name" {
  description = "Name of the vault."
  value       = azapi_resource.vault.name
}

output "vault_uri" {
  description = "Data-plane URI of the vault (https://<name>.vault.azure.net/), published to the app as APNS_KEY_VAULT_URI."
  value       = local.vault_uri
}

output "key_name" {
  description = "Name the owner imports the APNs key under, published to the app as APNS_KEY_NAME."
  value       = local.key_name
}

output "signer_assignment_ids" {
  description = "IDs of the signer's Key Vault Crypto User assignment: one when signer_grant_enabled is true, none otherwise."
  value       = [for a in azurerm_role_assignment.signer : a.id]
}
