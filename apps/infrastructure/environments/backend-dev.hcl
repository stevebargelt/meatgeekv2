# Terraform azurerm remote-state backend — MeatGeek V2 DEV (partial config)
#
# Consumed via: terraform init -reconfigure -backend-config=environments/backend-dev.hcl
# The storage account / container / RG below are the V2-OWNED remote-state
# resources stood up ONCE by apps/infrastructure/bootstrap/bootstrap.sh (Step 6).
# This is a dedicated V2 state account — the legacy V1 shared state account is
# deliberately NOT used here.
#
# dev and prod use DISTINCT, PER-ENVIRONMENT containers (tfstate-dev /
# tfstate-prod) so their state can never collide AND each CI identity's
# data-plane state access is RBAC-scoped to its own container only (MG-24
# per-env state isolation). The key is also distinct as defence in depth.

resource_group_name  = "meatgeek-v2-tfstate-rg"
storage_account_name = "meatgeekv2tfstate"
container_name       = "tfstate-dev"
key                  = "meatgeek-v2/dev.tfstate"

# Identity-based state access (MG-24 S1): the backend authenticates to the state
# blob via the caller's AAD identity + its container-scoped Storage Blob Data
# role, NOT a shared account key. This is what makes the per-env container RBAC
# actually restrict state access to the identity that requires it.
use_azuread_auth = true
