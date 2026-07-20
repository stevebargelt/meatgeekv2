#!/usr/bin/env bash
#
# MeatGeek V2 — Terraform environment check + pointer
# ===================================================
# This is NOT the state bootstrap and NOT a local-state helper. V2 Terraform
# ALWAYS uses the azurerm remote backend with a per-environment state key; there
# is no supported local-state path (a Terraform apply against ephemeral local
# state would try to create/recreate live infra — see MG-24 HARD SAFETY).
#
# Order of operations:
#   1. Run-once, per subscription:  ./bootstrap/bootstrap.sh
#        Stands up the remote-state storage account/container and the OIDC
#        deployment identity that the backend-*.hcl files point at.
#   2. Per environment, per operator (export ARM_SUBSCRIPTION_ID first — the
#      state storage account name is derived from it, not carried in the .hcl):
#        rm -f terraform.tfstate terraform.tfstate.backup && rm -rf .terraform
#        terraform init -reconfigure \
#          -backend-config=environments/backend-<env>.hcl \
#          -backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"
#        terraform plan  -var-file=environments/<env>.tfvars
#        # apply is OPERATOR-run (never in CI) — see the runbook
#
# Full procedure + evidence capture: docs/infrastructure/bootstrap-runbook.md

set -euo pipefail

echo "🚀 MeatGeek V2 Terraform environment check"
echo "=========================================="

# Prerequisites
command -v terraform >/dev/null 2>&1 || { echo "❌ Terraform not found. Install Terraform first."; exit 1; }
command -v az        >/dev/null 2>&1 || { echo "❌ Azure CLI not found. Install Azure CLI first."; exit 1; }
echo "✅ terraform and az are installed"

if ! az account show >/dev/null 2>&1; then
  echo "❌ Not authenticated with Azure. Run: az login"
  exit 1
fi
echo "✅ Azure authentication verified"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"
echo "📂 Working directory: $SCRIPT_DIR"

# Warn about stale local state — it must be deleted before a clean remote init
# so the V1-bound local state is never migrated into the V2 remote backend.
if [ -f terraform.tfstate ] || [ -d .terraform ]; then
  echo ""
  echo "⚠️  Stale local terraform state detected (terraform.tfstate / .terraform)."
  echo "    Delete it BEFORE the first remote init (never use -migrate-state):"
  echo "      rm -f terraform.tfstate terraform.tfstate.backup && rm -rf .terraform"
fi

cat <<'GUIDE'

📋 Next steps (V2 remote-backend model — NO local state):

  1) Run-once bootstrap (per subscription, needs Owner/UA-Admin):
       ./bootstrap/bootstrap.sh

  2) Initialize against the per-environment remote state
     (export ARM_SUBSCRIPTION_ID first — the state storage account name is
      derived from it via scripts/state-account-name.sh, not in the .hcl):
       terraform init -reconfigure \
         -backend-config=environments/backend-<env>.hcl \
         -backend-config="storage_account_name=$(scripts/state-account-name.sh "$ARM_SUBSCRIPTION_ID")"
       #   <env> = dev | prod   (distinct state keys, see environments/backend-*.hcl)

  3) Validate / format (backend not required):
       terraform init -backend=false && terraform validate
       terraform fmt -check -recursive

  4) Plan (apply is OPERATOR-run, never in CI):
       terraform plan -var-file=environments/<env>.tfvars

Full runbook + greenfield acceptance + evidence capture:
  docs/infrastructure/bootstrap-runbook.md
GUIDE
