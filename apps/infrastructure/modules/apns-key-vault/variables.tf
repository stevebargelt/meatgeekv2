# APNs Key Vault module variables (#241)

variable "name" {
  description = "Key Vault name. Globally unique (it is the vault's DNS label), 3-24 characters, letters, digits and hyphens, starting with a letter. The root derives it from the subscription."
  type        = string

  validation {
    condition     = can(regex("^[a-zA-Z][a-zA-Z0-9-]{1,22}[a-zA-Z0-9]$", var.name)) && !strcontains(var.name, "--")
    error_message = "name must be 3-24 characters of letters, digits and hyphens, start with a letter, not end with a hyphen, and not contain two hyphens in a row."
  }
}

variable "resource_group_id" {
  description = "Resource ID of the workload resource group the vault lives in."
  type        = string
}

variable "location" {
  description = "Azure region of the vault (the resource group's region)."
  type        = string
}

variable "tenant_id" {
  description = "Entra tenant that authenticates requests to the vault. The root passes the tenant of the authenticated Terraform context; it is never a literal."
  type        = string
}

variable "signer_principal_id" {
  description = "Principal id of the identity allowed to sign with the APNs key: the Function App's system-assigned managed identity."
  type        = string
}

variable "signer_grant_enabled" {
  description = "When true, grants signer_principal_id Key Vault Crypto User on the vault. Default false. Requires a bootstrap.sh re-run first (role allowlist)."
  type        = bool
  default     = false
}

variable "tags" {
  description = "Tags applied to the vault."
  type        = map(string)
  default     = {}
}
