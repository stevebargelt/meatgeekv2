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
#
# Where the apply happens (MG-23 changed this — read before applying by hand):
#   dev  — CI-RUN. Steady-state dev reconciliation is automated GitOps (MG-23):
#          a PR is validated CREDENTIALLESSLY by ci.yml's validate-infrastructure
#          job (fmt / backend-less init / validate / mock-provider tests / static
#          checks — NO terraform plan, NO Azure identity, NO remote state), and
#          the merge to main drives .github/workflows/infra-apply-dev.yml, which
#          takes the authoritative plan against real state and applies it. Do NOT
#          apply dev from a workstation for a steady-state change — you would be
#          racing CI. The plan below is for YOUR review; it is not the one CI
#          applies.
#   prod — still operator-run; infra-deploy-prod.yml stays plan-only until MG-25
#          activates the CI-run prod reconciliation.
#   Always OPERATOR-run, in every environment: this bootstrap, resource-group
#   creation, subscription-scoped configuration, and disaster recovery. The dev
#   apply identity is scoped to meatgeek-v2-dev-rg, so CI can reconcile that RG
#   but cannot rebuild it.
# MG-24 = Terraform reconciliation (operator-run). MG-23 = automated dev GitOps
# reconciliation (CI-run).
#
# Full procedure + evidence capture: docs/infrastructure/bootstrap-runbook.md
# Dev GitOps activation + live acceptance: docs/infrastructure/mg23-live-acceptance.md

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

  4) Plan:
       terraform plan -var-file=environments/<env>.tfvars

     Steady-state DEV reconciliation is CI-run (MG-23 automated dev GitOps):
     credentialless PR validation in ci.yml (no plan, no Azure identity), then
     automatic apply-on-merge via infra-apply-dev.yml, which takes the
     authoritative plan against real state.
     PROD infra stays operator-run (infra-deploy-prod.yml is plan-only) until
     MG-25. Bootstrap, resource-group creation, subscription-scoped config and
     disaster recovery remain OPERATOR actions everywhere.

Full runbook + greenfield acceptance + evidence capture:
  docs/infrastructure/bootstrap-runbook.md
Dev GitOps activation + live acceptance procedure:
  docs/infrastructure/mg23-live-acceptance.md
GUIDE
