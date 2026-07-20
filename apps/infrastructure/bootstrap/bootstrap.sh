#!/usr/bin/env bash
#
# MeatGeek V2 — run-once infrastructure BOOTSTRAP (chicken-and-egg)
# =================================================================
# Stands up the two things the main Terraform stack CANNOT create for itself
# because they must exist BEFORE `terraform init`:
#
#   1. Durable azurerm REMOTE-STATE storage (a dedicated V2 state RG + storage
#      account + PER-ENVIRONMENT containers) — the exact account/containers
#      referenced by environments/backend-dev.hcl and backend-prod.hcl.
#   2. PER-ENVIRONMENT GitHub-Actions OIDC DEPLOYMENT IDENTITIES — one Azure AD
#      application + service principal PER environment (dev, prod), each with a
#      single FEDERATED credential scoped to its GitHub Environment, granted a
#      least-privilege PLAN/READ-ONLY role. No client secret is ever created
#      (OIDC = no long-lived secret).
#
# Per-env ISOLATION (MG-24 red-fix): dev and prod do NOT share a service
# principal, and each SP's data-plane state access is scoped to ITS OWN state
# container only (tfstate-dev / tfstate-prod). The dev CI identity can neither
# assume the prod trust nor read the prod state blob, and vice-versa.
#
# This script keeps NO long-lived Terraform state of its own — it is a plain,
# idempotent Azure CLI procedure. Re-running it against already-created
# resources is a no-op (create-if-absent everywhere).
#
# HARD SAFETY (MG-24):
#   * It creates ONLY V2 state storage + the V2 OIDC identities. It never
#     creates, imports, renames, modifies, or deletes any V1 resource or any
#     app-stack resource. A name guard (assert_v2_name) refuses to operate on
#     anything that looks like the legacy V1 shared account/state.
#   * It NEVER runs a Terraform apply. It does not run terraform at all.
#   * Each CI identity is granted Reader (plan/read) only — never Contributor/
#     Owner. Apply is an OPERATOR action, run locally with the operator's own
#     elevated credentials, per the bootstrap runbook.
#
# Usage:
#   az login            # as a subscription Owner/User Access Administrator
#   az account set --subscription <V2-subscription-id>
#   ./bootstrap.sh      # idempotent; safe to re-run
#
# All inputs are overridable via environment variables (defaults below match
# the committed backend-*.hcl files). See docs/infrastructure/bootstrap-runbook.md.

set -euo pipefail

# --------------------------------------------------------------------------
# Configuration (defaults intentionally match environments/backend-*.hcl)
# --------------------------------------------------------------------------
STATE_RG="${STATE_RG:-meatgeek-v2-tfstate-rg}"
STATE_STORAGE_ACCOUNT="${STATE_STORAGE_ACCOUNT:-meatgeekv2tfstate}"
STATE_LOCATION="${STATE_LOCATION:-eastus}"

# GitHub repository that will assume the OIDC identities. The federated-credential
# SUBJECT is scoped per GitHub Environment, so this repo's `dev` and
# `production` environments get DISTINCT trust on DISTINCT identities.
GITHUB_REPO="${GITHUB_REPO:-stevebargelt/meatgeekv2}"

# GitHub Environments to federate, each mapped to its Terraform env + state
# container below. These MUST be `environment:<name>` scopes (not
# `ref:refs/heads/<branch>`), so trust is gated by the GitHub Environment
# protection rules, not merely by which branch a workflow ran on.
#
# CANONICAL SUBJECT SCHEME (MG-24 red-fix — must not drift):
#   subject = repo:<owner>/<repo>:environment:<github-env>
# The <github-env> tokens here MUST be the EXACT `environment:` values the
# workflow jobs declare — `development` (ci.yml deploy-dev) and `production`
# (infra-deploy-prod / app-deploy-prod). A GitHub deploy job with
# `environment: development` presents the OIDC subject
# `repo:<owner>/<repo>:environment:development`, so the dev federated credential
# MUST be created for exactly that subject (previously `…:environment:dev`,
# which silently never matched). The short tf env / state names (dev, prod) are
# derived from these via tf_env_for below — do NOT federate the short forms.
GITHUB_ENVIRONMENTS="${GITHUB_ENVIRONMENTS:-development production}"

# Base display name for the per-environment AAD applications. Each environment
# gets its OWN app: "${AAD_APP_NAME}-dev" and "${AAD_APP_NAME}-prod".
AAD_APP_NAME="${AAD_APP_NAME:-meatgeek-v2-github-oidc}"

# Least-privilege CI role. Reader lets `terraform plan` read live resource
# state; it CANNOT create/modify/delete infrastructure, so an accidental
# CI apply fails closed. Do NOT change this to Contributor.
CI_PLAN_ROLE="${CI_PLAN_ROLE:-Reader}"

OIDC_ISSUER="https://token.actions.githubusercontent.com"
OIDC_AUDIENCE="api://AzureADTokenExchange"

log()  { printf '\033[0;36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m⚠️  %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

# Map a GitHub Environment name to its Terraform environment / state container.
# GitHub uses the full words `development`/`production` (which is what the
# workflow `environment:` values — and therefore the OIDC subjects — use);
# Terraform + state keys use the short `dev`/`prod`. Federation happens on the
# GitHub-env name (the subject), NOT this short form.
tf_env_for() {
  case "$1" in
    development) echo "dev" ;;
    production) echo "prod" ;;
    *) echo "$1" ;;
  esac
}
state_container_for() { echo "tfstate-$(tf_env_for "$1")"; }

# --------------------------------------------------------------------------
# V1-SAFETY GUARD (pure string logic — unit-testable without Azure)
# --------------------------------------------------------------------------
# Refuse to operate on anything that is NOT unambiguously a V2 resource. This
# is the last line of defense against a mistyped/overridden name pointing the
# bootstrap at the legacy V1 shared state account or resource group.
#
# Returns 0 for a valid V2 name, non-zero (with a message) otherwise.
assert_v2_name() {
  local kind="$1" value="$2"
  local lc
  lc="$(printf '%s' "$value" | tr '[:upper:]' '[:lower:]')"

  # Must be positively identified as V2.
  case "$lc" in
    *meatgeek-v2-*|meatgeekv2*) : ;;
    *) echo "refusing ${kind} '${value}': not an unambiguous meatgeek-v2 name" >&2; return 1 ;;
  esac

  # Explicitly reject known-legacy V1 identifiers even if 'v2' also appears.
  case "$lc" in
    *meatgeek-shared*|*meatgeekterraformstate*)
      echo "refusing ${kind} '${value}': matches a legacy V1 shared identifier" >&2
      return 1 ;;
  esac
  return 0
}

require_tools() {
  command -v az >/dev/null 2>&1 || die "Azure CLI (az) not found — install it first."
  az account show >/dev/null 2>&1 || die "Not authenticated. Run: az login"
}

# --------------------------------------------------------------------------
# 1. Durable remote-state storage + per-env containers (create-if-absent)
# --------------------------------------------------------------------------
bootstrap_state_backend() {
  local sub_id
  sub_id="$(az account show --query id -o tsv)"
  log "Subscription: ${sub_id}"

  assert_v2_name "resource group"   "$STATE_RG"              || die "state RG failed V2 guard"
  assert_v2_name "storage account"  "$STATE_STORAGE_ACCOUNT" || die "state storage failed V2 guard"

  log "State RG: ${STATE_RG}"
  # `az group create` is idempotent.
  az group create \
    --name "$STATE_RG" \
    --location "$STATE_LOCATION" \
    --tags Project="MeatGeek V2" ManagedBy="bootstrap.sh" Purpose="terraform-remote-state" \
    -o none
  ok "Resource group ready: ${STATE_RG}"

  if az storage account show --name "$STATE_STORAGE_ACCOUNT" --resource-group "$STATE_RG" -o none 2>/dev/null; then
    ok "Storage account already exists: ${STATE_STORAGE_ACCOUNT}"
  else
    log "Creating state storage account: ${STATE_STORAGE_ACCOUNT}"
    # Hardened for a state store: TLS1.2 floor, no public blob access,
    # HTTPS-only, key-based & AAD auth both usable by the backend.
    az storage account create \
      --name "$STATE_STORAGE_ACCOUNT" \
      --resource-group "$STATE_RG" \
      --location "$STATE_LOCATION" \
      --sku Standard_LRS \
      --kind StorageV2 \
      --min-tls-version TLS1_2 \
      --allow-blob-public-access false \
      --https-only true \
      --tags Project="MeatGeek V2" ManagedBy="bootstrap.sh" Purpose="terraform-remote-state" \
      -o none
    ok "Storage account created: ${STATE_STORAGE_ACCOUNT}"
  fi

  # State-file protection: blob versioning + soft delete so a bad apply/lock
  # can be recovered. Idempotent.
  az storage account blob-service-properties update \
    --account-name "$STATE_STORAGE_ACCOUNT" \
    --resource-group "$STATE_RG" \
    --enable-versioning true \
    --enable-delete-retention true \
    --delete-retention-days 30 \
    -o none
  ok "Blob versioning + 30-day soft delete enabled on ${STATE_STORAGE_ACCOUNT}"

  # Per-environment containers (create-if-absent), one per environment so state
  # access can be RBAC-scoped per env (dev/prod isolation).
  #
  # #6 red-fix: the container create/show uses KEY auth with a control-plane-
  # fetched account key, NOT `--auth-mode login`. The operator running the
  # bootstrap has a control-plane role (Owner / Contributor / User Access
  # Administrator) and can list account keys, but may NOT yet hold a
  # Storage Blob DATA role — so a data-plane `--auth-mode login` call would
  # fail CLOSED on the very first run (the exact bug this fixes). Key auth
  # works with the operator's control-plane role for the initial create.
  local state_key
  state_key="$(az storage account keys list \
    --account-name "$STATE_STORAGE_ACCOUNT" --resource-group "$STATE_RG" \
    --query '[0].value' -o tsv)"
  [ -n "$state_key" ] || die "could not read a control-plane account key for ${STATE_STORAGE_ACCOUNT}"

  local env container
  for env in $GITHUB_ENVIRONMENTS; do
    container="$(state_container_for "$env")"
    if az storage container show \
        --name "$container" \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --auth-mode key --account-key "$state_key" -o none 2>/dev/null; then
      ok "State container already exists: ${container}"
    else
      az storage container create \
        --name "$container" \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --auth-mode key --account-key "$state_key" \
        -o none
      ok "State container created: ${container}"
    fi
  done
}

# --------------------------------------------------------------------------
# 2. Per-environment OIDC deployment identities (create-if-absent).
#    One AAD app + SP per environment, least-privilege PLAN-only, with
#    data-plane state access scoped to that environment's container ONLY.
# --------------------------------------------------------------------------
bootstrap_oidc_identity() {
  local sub_id tenant_id state_sa_id
  sub_id="$(az account show --query id -o tsv)"
  tenant_id="$(az account show --query tenantId -o tsv)"
  state_sa_id="$(az storage account show \
    --name "$STATE_STORAGE_ACCOUNT" --resource-group "$STATE_RG" \
    --query id -o tsv 2>/dev/null || true)"

  local env tfenv app_name app_id sp_id cred_name subject container container_scope existing
  for env in $GITHUB_ENVIRONMENTS; do
    tfenv="$(tf_env_for "$env")"
    app_name="${AAD_APP_NAME}-${tfenv}"
    container="$(state_container_for "$env")"

    log "── Environment '${env}' (tf: ${tfenv}) — identity ${app_name}"

    # AAD application PER ENVIRONMENT (create-if-absent, keyed by display name).
    app_id="$(az ad app list --display-name "$app_name" --query '[0].appId' -o tsv 2>/dev/null || true)"
    if [ -z "$app_id" ] || [ "$app_id" = "null" ]; then
      log "Creating AAD application: ${app_name}"
      app_id="$(az ad app create --display-name "$app_name" --query appId -o tsv)"
      ok "AAD application created: ${app_id}"
    else
      ok "AAD application already exists: ${app_id}"
    fi

    # Service principal (create-if-absent). No password/secret is ever
    # generated — federation is the only credential.
    sp_id="$(az ad sp show --id "$app_id" --query id -o tsv 2>/dev/null || true)"
    if [ -z "$sp_id" ] || [ "$sp_id" = "null" ]; then
      log "Creating service principal for ${app_id}"
      sp_id="$(az ad sp create --id "$app_id" --query id -o tsv)"
      ok "Service principal created: ${sp_id}"
    else
      ok "Service principal already exists: ${sp_id}"
    fi

    # ONE federated credential per environment. SUBJECT is
    # `repo:<org/repo>:environment:<env>`, so trust is bound to the GitHub
    # Environment (and its protection rules), NOT to a branch ref, and each
    # env's identity trusts ONLY its own environment.
    cred_name="github-${env}"
    subject="repo:${GITHUB_REPO}:environment:${env}"
    existing="$(az ad app federated-credential list --id "$app_id" \
      --query "[?name=='${cred_name}'].name | [0]" -o tsv 2>/dev/null || true)"
    if [ -n "$existing" ] && [ "$existing" != "null" ]; then
      ok "Federated credential already exists: ${cred_name} (${subject})"
    else
      log "Creating federated credential: ${cred_name} -> ${subject}"
      az ad app federated-credential create --id "$app_id" --parameters "$(cat <<JSON
{
  "name": "${cred_name}",
  "issuer": "${OIDC_ISSUER}",
  "subject": "${subject}",
  "audiences": ["${OIDC_AUDIENCE}"],
  "description": "GitHub Actions OIDC for the '${env}' environment of ${GITHUB_REPO}"
}
JSON
)" -o none
      ok "Federated credential created: ${cred_name}"
    fi

    # Least-privilege role: Reader (plan/read) at the subscription scope so
    # `terraform plan` can read live resource state. This role CANNOT mutate
    # infrastructure — an accidental CI apply fails closed. Idempotent.
    log "Assigning ${CI_PLAN_ROLE} (plan/read-only) at subscription scope for ${env}"
    az role assignment create \
      --assignee-object-id "$sp_id" \
      --assignee-principal-type ServicePrincipal \
      --role "$CI_PLAN_ROLE" \
      --scope "/subscriptions/${sub_id}" \
      -o none
    ok "${CI_PLAN_ROLE} granted to the ${env} CI identity (no write/apply role)"

    # Data-plane access to THIS ENVIRONMENT'S state container ONLY — not the
    # whole state account, and not the other environment's container. This is
    # the per-env state isolation: the dev SP can read/lock dev.tfstate but
    # cannot touch prod.tfstate, and vice-versa.
    if [ -n "$state_sa_id" ]; then
      container_scope="${state_sa_id}/blobServices/default/containers/${container}"
      az role assignment create \
        --assignee-object-id "$sp_id" \
        --assignee-principal-type ServicePrincipal \
        --role "Storage Blob Data Contributor" \
        --scope "$container_scope" \
        -o none
      ok "Storage Blob Data Contributor granted on container ${container} ONLY"
    else
      warn "State storage account not found for blob-role scope — run state bootstrap first"
    fi

    # Emit the (non-secret) coordinates the operator wires into the matching
    # GitHub Environment. NOTE: these are identifiers, NOT secrets — OIDC issues
    # short-lived tokens at run time, so nothing here needs guarding.
    cat <<SUMMARY

────────────────────────────────────────────────────────────────────
GitHub Environment '${env}' — add these as *Environment* variables
(NO client secret exists or is needed):

  AZURE_CLIENT_ID        = ${app_id}
  AZURE_TENANT_ID        = ${tenant_id}
  AZURE_SUBSCRIPTION_ID  = ${sub_id}

  Federated subject: ${subject}
  State container:   ${container} (this env's isolated tfstate)
  CI role: ${CI_PLAN_ROLE} (plan/read-only) + Storage Blob Data Contributor
           on container ${container} ONLY. Apply is OPERATOR-run, never CI.
────────────────────────────────────────────────────────────────────
SUMMARY
  done
}

main() {
  log "🚀 MeatGeek V2 bootstrap (remote state + per-env OIDC identities)"
  require_tools
  bootstrap_state_backend
  bootstrap_oidc_identity
  ok "Bootstrap complete. Next: follow docs/infrastructure/bootstrap-runbook.md"
}

# Only auto-run when executed directly; allows sourcing for unit tests.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
