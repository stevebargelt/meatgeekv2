# Terraform azurerm remote-state backend — MeatGeek V2 PROD (partial config)
#
# Consumed via:
#   NAME=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")
#   terraform init -reconfigure \
#     -backend-config=environments/backend-prod.hcl \
#     -backend-config="storage_account_name=$NAME"
#
# storage_account_name is DELIBERATELY absent here: it is derived from the
# subscription id (meatgeekv2tf + first 12 chars of sha1(sub_id) = 24 chars) by
# the single sourced helper apps/infrastructure/scripts/state-account-name.sh and
# injected at init as an extra -backend-config. Keeping it out of this file means
# there is exactly ONE derivation of the state-account name (no divergent literal
# to drift). The container / RG below are the V2-OWNED remote-state resources
# stood up ONCE by apps/infrastructure/bootstrap/bootstrap.sh. This is a dedicated
# V2 state account — the legacy V1 shared state account is deliberately NOT used.
#
# dev and prod use DISTINCT, PER-ENVIRONMENT containers (tfstate-dev /
# tfstate-prod) so their state can never collide AND each CI identity's
# data-plane state access is RBAC-scoped to its own container only (MG-24
# per-env state isolation). The key is also distinct as defence in depth.

resource_group_name = "meatgeek-v2-tfstate-rg"
container_name      = "tfstate-prod"
key                 = "meatgeek-v2/prod.tfstate"

# Identity-based state access (MG-24 S1): the backend authenticates to the state
# blob via the caller's AAD identity + its container-scoped Storage Blob Data
# role, NOT a shared account key. This is what makes the per-env container RBAC
# actually restrict state access to the identity that requires it.
use_azuread_auth = true
