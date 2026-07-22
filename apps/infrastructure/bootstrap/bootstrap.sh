#!/usr/bin/env bash
#
# MeatGeek V2 — run-once infrastructure BOOTSTRAP (chicken-and-egg)
# =================================================================
# Stands up the two things the main Terraform stack CANNOT create for itself
# because they must exist BEFORE `terraform init`:
#
#   1. Durable azurerm REMOTE-STATE storage (a dedicated V2 state RG + storage
#      account + PER-ENVIRONMENT containers) — the exact account/containers
#      referenced by environments/backend-dev.hcl and backend-prod.hcl. The
#      state-account NAME is derived from the subscription id (globally unique,
#      MG-24 item 9) by the single sourced helper scripts/state-account-name.sh.
#   2. PER-ENVIRONMENT GitHub-Actions OIDC PLAN/READ IDENTITIES — one Azure AD
#      application + service principal PER environment (dev, prod), each with a
#      single FEDERATED credential scoped to its GitHub Environment, granted a
#      least-privilege PLAN/READ-ONLY role (Reader + a container-scoped state
#      role). No client secret is ever created (OIDC = no long-lived secret).
#   3. A SEPARATE dev APP-DEPLOYMENT IDENTITY (MG-24 item 4) — a distinct AAD
#      app/SP used ONLY to publish the dev Function App. It gets `Website
#      Contributor` scoped to the dev Function App ALONE (Reader cannot publish
#      code) + Storage Blob Data READER on the dev state container. It is NOT the
#      plan identity, and it never receives a subscription-wide write role. The
#      PROD app-deployment identity + its role is an explicit MG-25 gap and is
#      deliberately NOT created here.
#   4. A SEPARATE dev ENTRA API AUTH REGISTRATION (MG-24 item 3) — an AAD app
#      exposing the delegated scope `access_as_user` that the Function App's
#      Easy Auth validates. It is DISTINCT from every OIDC/deployment app (the
#      GitHub deployment OIDC app is never reused as the API's user auth) and
#      has NO client secret. It emits the client id / tenant / App ID URI the
#      operator wires into environments/dev.tfvars.
#
# Per-env ISOLATION (MG-24 red-fix): dev and prod do NOT share a service
# principal, and each SP's data-plane state access is scoped to ITS OWN state
# container only (tfstate-dev / tfstate-prod). The dev CI identity can neither
# assume the prod trust nor read the prod state blob, and vice-versa. The
# app-deployment identity is a THIRD, distinct SP — separating "read to plan"
# from "publish code" so neither role is over-granted.
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
#   * Each PLAN/READ identity is granted Reader (plan/read) only — never
#     Contributor/Owner. Apply is an OPERATOR action, run locally with the
#     operator's own elevated credentials, per the bootstrap runbook.
#   * The dev APP-DEPLOYMENT identity is granted `Website Contributor` scoped to
#     the dev Function App ALONE (never a subscription-wide write role) plus
#     Storage Blob Data Reader on the dev state container — enough to publish
#     code, nothing more.
#   * No client secret is ever minted for ANY identity (OIDC federation + Easy
#     Auth token validation only).
#
# Usage:
#   az login            # as a subscription Owner/User Access Administrator
#   az account set --subscription <V2-subscription-id>
#   ./bootstrap.sh      # idempotent; safe to re-run
#
# All inputs are overridable via environment variables (defaults below match
# the committed backend-*.hcl files). See docs/infrastructure/bootstrap-runbook.md.

set -euo pipefail

# Single source of truth for the subscription-derived state-account name
# (MG-24 item 9). Sourced (not exec'd) so `state_account_name` is callable here
# and, via this file, from the bootstrap tests. The helper defines a function
# and does nothing else when sourced.
BOOTSTRAP_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=../scripts/state-account-name.sh
source "${BOOTSTRAP_DIR}/../scripts/state-account-name.sh"

# --------------------------------------------------------------------------
# Configuration (defaults intentionally match environments/backend-*.hcl)
# --------------------------------------------------------------------------
STATE_RG="${STATE_RG:-meatgeek-v2-tfstate-rg}"
# The state-account name is ALWAYS derived from the subscription id via the
# single sourced helper state-account-name.sh (single source of truth, globally
# unique — MG-24 item 9). It is intentionally NOT overridable: reading a
# STATE_STORAGE_ACCOUNT env override would let bootstrap, the backend-*.hcl init,
# and the workflows drift to different names. Filled in bootstrap_state_backend;
# any inherited STATE_STORAGE_ACCOUNT from the environment is deliberately ignored.
STATE_STORAGE_ACCOUNT=""
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

# Base display name for the per-environment PLAN/READ AAD applications. Each
# environment gets its OWN app: "${AAD_APP_NAME}-dev" and "${AAD_APP_NAME}-prod".
# These are PLAN/READ identities (Reader) — they never publish app code.
AAD_APP_NAME="${AAD_APP_NAME:-meatgeek-v2-github-oidc}"

# Least-privilege CI PLAN role. Reader lets `terraform plan` read live resource
# state; it CANNOT create/modify/delete infrastructure, so an accidental
# CI apply fails closed. Do NOT change this to Contributor.
CI_PLAN_ROLE="${CI_PLAN_ROLE:-Reader}"

# --- dev APP-DEPLOYMENT identity (MG-24 item 4) ----------------------------
# A SEPARATE app/SP whose ONLY job is publishing the dev Function App. It is not
# the plan identity. `Website Contributor` is the least-privilege built-in role
# that permits web-app/Functions code deployment scoped to a single site — a
# Reader cannot publish. It is scoped to the dev Function App ALONE, never the
# subscription. Emitted as AZURE_APP_DEPLOY_CLIENT_ID for the app-deploy job.
AAD_DEPLOY_APP_NAME="${AAD_DEPLOY_APP_NAME:-meatgeek-v2-github-appdeploy}"
DEPLOY_APP_ROLE="${DEPLOY_APP_ROLE:-Website Contributor}"
# --- dev ENTRA API AUTH registration (MG-24 item 3) ------------------------
# The API app the Function App's Easy Auth validates tokens against. DISTINCT
# from every OIDC/deployment app. Exposes ONE delegated scope, `access_as_user`.
# No client secret is created. SMOKE_TEST_CLIENT_IDS is the SPACE-SEPARATED list
# of CALLING client app ids pre-authorized for access_as_user so the MG-21
# authenticated smoke test can acquire a token without a consent prompt. These
# are the SAME ids the Function App's Easy Auth allowed_applications accepts
# (functions_auth_allowed_client_app_ids in dev.tfvars) — the CALLING client, NOT
# the API registration. It DEFAULTS to the Azure CLI public client
# (04b07795-8ddb-461a-bbee-02f9e1bf7b46), the caller for
# `az account get-access-token --scope "<App ID URI>/access_as_user"`; override
# with a dedicated dev client's app id (or a space-separated list). The legacy
# singular SMOKE_TEST_CLIENT_ID is still honored (appended) for compatibility.
DEV_API_APP_NAME="${DEV_API_APP_NAME:-meatgeek-v2-dev-api}"
DEV_API_SCOPE_NAME="${DEV_API_SCOPE_NAME:-access_as_user}"
AZURE_CLI_PUBLIC_CLIENT_ID="04b07795-8ddb-461a-bbee-02f9e1bf7b46"
SMOKE_TEST_CLIENT_IDS="${SMOKE_TEST_CLIENT_IDS:-${AZURE_CLI_PUBLIC_CLIENT_ID}} ${SMOKE_TEST_CLIENT_ID:-}"

OIDC_ISSUER="https://token.actions.githubusercontent.com"
OIDC_AUDIENCE="api://AzureADTokenExchange"

log()  { printf '\033[0;36m%s\033[0m\n' "$*"; }
ok()   { printf '\033[0;32m✅ %s\033[0m\n' "$*"; }
warn() { printf '\033[0;33m⚠️  %s\033[0m\n' "$*"; }
die()  { printf '\033[0;31m❌ %s\033[0m\n' "$*" >&2; exit 1; }

# Run an az DISCOVERY/read query (a *list* whose empty result means "resource
# absent"), distinguishing ABSENCE from a REAL error. A blanket `|| true` on a
# discovery collapses a transient Azure failure (auth / throttling / network)
# into an empty string, making it indistinguishable from "not found" — so the
# create-if-absent callers would then WRONGLY proceed to create a duplicate. This
# helper captures the command's exit status SEPARATELY from its stdout: a clean
# exit (status 0) with empty stdout is a legitimate ABSENT (the caller creates);
# a NON-ZERO exit is a genuine error and we FAIL LOUD. Use it ONLY with list-style
# queries (`az … list … --query '[0].…'`) that return empty-with-exit-0 when there
# is no match — NOT with `az … show`, which returns non-zero for not-found and so
# cannot distinguish absence from error (use a `list --filter` form instead).
#   usage: value="$(az_discover "<what>" az ad app list --display-name X --query '[0].appId' -o tsv)"
az_discover() {
  local what="$1"; shift
  local out status=0
  # `|| status=$?` keeps the command-substitution failure from aborting under
  # `set -e` before we can inspect the status.
  out="$("$@")" || status=$?
  if [ "$status" -ne 0 ]; then
    die "discovery failed while checking for ${what} (az exited ${status}) — this is a REAL Azure error (auth / throttling / network), NOT resource-absent. Aborting rather than risk creating a duplicate. Command: $*"
  fi
  printf '%s' "$out"
}

# Decide create-vs-skip for an `az … show` EXISTENCE check, distinguishing a
# genuinely ABSENT resource from a REAL error. Unlike a *list* (empty result +
# exit 0 = absent, handled by az_discover), `az … show` on a missing resource
# exits NON-ZERO and reports not-found — az CLI exit code 3, and/or a
# ResourceNotFound / ContainerNotFound / "not found" / "does not exist" marker in
# its output. An auth / throttle / network failure ALSO exits non-zero, but
# WITHOUT that not-found signal. A bare `if az … show; then … else <create>`
# treats BOTH as absent, so a transient Azure error triggers an ERRONEOUS create
# attempt against a resource that may already exist. This helper captures the
# command's output (stdout+stderr) and exit status separately and reports:
#   * exit 0             -> resource PRESENT -> return 1 (caller SKIPS create)
#   * a not-found signal -> resource ABSENT  -> return 0 (caller CREATES)
#   * any OTHER non-zero -> REAL error       -> die (fail loud, name the exit)
# Use ONLY with `az … show` (or another not-found-non-zero) existence check used
# to decide create-vs-skip.
#   usage: if resource_absent_or_die "storage account X" \
#              az storage account show --name X --resource-group Y -o none; then
#            <create>
#          fi
resource_absent_or_die() {
  local what="$1"; shift
  local out status=0
  # Capture stdout+stderr together so a not-found marker on stderr is inspectable;
  # `|| status=$?` keeps `set -e` from aborting before we can classify the exit.
  out="$("$@" 2>&1)" || status=$?
  if [ "$status" -eq 0 ]; then
    return 1   # present → caller skips create
  fi
  # Not-found signal: az CLI exit code 3, OR an explicit not-found marker in the
  # captured output. Everything else non-zero is a REAL error (auth / throttling /
  # network) and must NOT be mistaken for absence.
  if [ "$status" -eq 3 ] \
     || printf '%s' "$out" | grep -qiE 'ResourceNotFound|ContainerNotFound|not[[:space:]_-]?found|does not exist|could not be found|was not found'; then
    return 0   # genuinely absent → caller creates
  fi
  die "existence check for ${what} failed (az exited ${status}) — this is a REAL Azure error (auth / throttling / network), NOT resource-absent. Refusing to attempt a create that could collide with an existing resource. Command: $*  |  az: ${out}"
}

# Assert a token is a bare AAD/Azure GUID (8-4-4-4-12 hex). Caller-controlled
# client/app ids (SMOKE_TEST_CLIENT_IDS → the emitted
# functions_auth_allowed_client_app_ids HCL list and the Graph
# preAuthorizedApplications manifest) are rendered VERBATIM into those artifacts,
# so a malformed value (embedded quote, space, or non-UUID) would yield INVALID
# HCL / a bogus manifest. Reject it LOUD — naming the offending value and its
# source env var — rather than emit a broken artifact. Quoting alone is not
# enough: for a client-app-id list the correct behavior is to REJECT a non-UUID.
assert_uuid() {
  local value="$1" source="${2:-value}"
  if ! [[ "$value" =~ ^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$ ]]; then
    die "invalid client/app id '${value}' from ${source}: expected a bare GUID (8-4-4-4-12 hex). Refusing to emit invalid HCL/manifest."
  fi
}

# Render a SPACE-SEPARATED list of values as a VALID HCL list of quoted strings,
# so copy-paste tfvars guidance parses (Terraform rejects bare/unquoted tokens):
#   "id1 id2" -> ["id1", "id2"]      ""  -> []
# Every token is VALIDATED as a bare GUID (assert_uuid) before it is rendered, so
# a malformed id fails loud instead of producing broken HCL. Used for
# functions_auth_allowed_client_app_ids in the emitted dev.tfvars block. The
# optional second arg names the source env var for the failure message.
hcl_string_list() {
  local values="$1" source="${2:-value}" out="" v
  for v in $values; do
    [ -z "$v" ] && continue
    assert_uuid "$v" "$source"
    out="${out:+${out}, }\"${v}\""
  done
  printf '[%s]' "$out"
}

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

# Idempotent role-assignment (create-if-absent), consistent with every other
# resource here. On a modern Azure CLI `az role assignment create` returns a
# non-zero "role assignment already exists" error for an already-present
# (assignee, role, scope) tuple, which would break the stated safe-to-re-run
# contract on the SECOND bootstrap run. Guard the create with a list-first
# existence check. The list query runs through az_discover so an empty/no-match
# result (legitimate on a first run) proceeds to create, while a REAL Azure error
# fails loud instead of being masked as absence under `set -euo pipefail`.
ensure_role_assignment() {
  local object_id="$1" principal_type="$2" role="$3" scope="$4"
  local existing
  # Discovery: distinguish "no such assignment yet" (clean exit, empty → create)
  # from a REAL Azure error (non-zero → die) instead of a blanket `|| true` that
  # would mask the error and wrongly proceed to create.
  existing="$(az_discover "existing role assignment (${role} on ${scope})" \
    az role assignment list \
    --assignee "$object_id" \
    --role "$role" \
    --scope "$scope" \
    --query "[0].id" -o tsv)"
  if [ -n "$existing" ] && [ "$existing" != "null" ]; then
    return 0
  fi
  az role assignment create \
    --assignee-object-id "$object_id" \
    --assignee-principal-type "$principal_type" \
    --role "$role" \
    --scope "$scope" \
    -o none
}

# Data-plane RBAC (Storage Blob Data roles) is EVENTUALLY CONSISTENT: a freshly
# granted role is not immediately effective for `--auth-mode login` blob calls.
# Poll (bounded attempts + backoff) for an AAD data-plane op against the account
# to succeed, instead of a blind fixed sleep. This waits ONLY for the verified
# propagation condition — the grant itself already succeeded (fail-loud), so this
# never masks an authorization error; if it never propagates within the bound we
# fail with a clear message rather than proceeding into a confusing blob error.
wait_for_blob_data_plane() {
  local account="$1" attempt=1 max_attempts=12 delay=5
  while :; do
    if az storage container list --account-name "$account" --auth-mode login -o none 2>/dev/null; then
      ok "Data-plane RBAC effective for --auth-mode login on ${account}"
      return 0
    fi
    if [ "$attempt" -ge "$max_attempts" ]; then
      die "Storage data-plane RBAC did not become effective on ${account} after ${max_attempts} attempts; the operator's Storage Blob Data grant has not propagated — re-run the bootstrap in a few minutes."
    fi
    log "Waiting for data-plane RBAC to propagate on ${account} (attempt ${attempt}/${max_attempts}, ${delay}s)…"
    sleep "$delay"
    attempt=$((attempt+1))
    [ "$delay" -lt 20 ] && delay=$((delay+5))
  done
}

# Resolve the object id of the signed-in principal for the OPERATOR Storage Blob
# Data grant — but ONLY when a per-operator grant actually applies. This exists
# to keep two DIFFERENT cases from collapsing into the same empty→silent-skip
# path (F4/F6, the "masked Azure error"):
#
#   (a) EXPECTED: the session principal is a SERVICE PRINCIPAL (CI/automation).
#       `az ad signed-in-user show` legitimately fails for an SP (there is no
#       interactive "signed-in user"), and the per-OPERATOR grant is simply not
#       applicable. This is a deliberate FAIL-SOFT: emit SKIP_SP so the caller
#       logs a clear "by design, not a failure" notice and moves on. Do NOT die.
#
#   (b) GENUINE FAILURE for a real USER session (Microsoft Graph down, auth/token
#       error, network): the object-id lookup must FAIL LOUD, never be silently
#       swallowed. Previously the whole thing hung off `… 2>/dev/null || true`,
#       so a real user's Graph outage looked identical to an SP session and the
#       operator's Storage-Blob-Data grant was skipped with nobody the wiser.
#
# Determine the principal TYPE first (az account show → user.type: `user` vs
# `servicePrincipal`), then branch. The type query itself routes through
# az_discover, so a REAL error fetching the type also fails loud rather than
# being mistaken for "not an SP". Prints SKIP_SP (SP session) or the bare object
# id (user session) on stdout; dies on a genuine user-session lookup failure.
operator_state_grant_oid() {
  local ptype oid
  ptype="$(az_discover "signed-in principal type" \
    az account show --query user.type -o tsv)"
  if [ "$ptype" = "servicePrincipal" ]; then
    # (a) SP session — the per-operator Storage Blob Data grant is N/A by design.
    printf 'SKIP_SP'
    return 0
  fi
  # (b) USER session (or any non-SP type): resolve the object id WITHOUT a
  # masking `|| true`. A non-zero exit (Graph/auth/network) fails loud here.
  oid="$(az ad signed-in-user show --query id -o tsv)" \
    || die "could not resolve the signed-in USER's object id via 'az ad signed-in-user show' (Microsoft Graph unreachable / auth/token error / network). Refusing to SILENTLY SKIP the operator's 'Storage Blob Data Contributor' grant on ${STATE_STORAGE_ACCOUNT} — re-authenticate (az login) or retry once Graph is reachable, then re-run the bootstrap."
  # A user session that returns an EMPTY/null id is itself an anomaly (Graph
  # returned success but no id) — treat it as a genuine failure, not a skip.
  if [ -z "$oid" ] || [ "$oid" = "null" ]; then
    die "'az ad signed-in-user show' returned an EMPTY object id for a USER session (Graph/auth anomaly). Refusing to silently skip the operator's 'Storage Blob Data Contributor' grant on ${STATE_STORAGE_ACCOUNT}."
  fi
  printf '%s' "$oid"
}

# --------------------------------------------------------------------------
# Reconcile a GitHub-Actions OIDC federated credential on SUBJECT, not just
# name. The subject IS the OIDC trust binding, so a credential with the right
# name but a stale/wrong subject (prior repo/env or subject-format change)
# would bind federation to the WRONG trust. Create-if-absent /
# no-op-if-subject-matches / delete+recreate-if-subject-drifts. Single helper
# for BOTH the plan/read and app-deploy credentials so the reconciliation can
# never drift between them again.
# --------------------------------------------------------------------------
ensure_federated_credential() {
  local app_id="$1" cred_name="$2" subject="$3" description="$4"
  local fc_params existing_subject
  fc_params="$(cat <<JSON
{
  "name": "${cred_name}",
  "issuer": "${OIDC_ISSUER}",
  "subject": "${subject}",
  "audiences": ["${OIDC_AUDIENCE}"],
  "description": "${description}"
}
JSON
)"
  existing_subject="$(az_discover "federated credential '${cred_name}' on app ${app_id}" \
    az ad app federated-credential list --id "$app_id" \
    --query "[?name=='${cred_name}'].subject | [0]" -o tsv)"
  if [ -z "$existing_subject" ] || [ "$existing_subject" = "null" ]; then
    log "Creating federated credential: ${cred_name} -> ${subject}"
    az ad app federated-credential create --id "$app_id" --parameters "$fc_params" -o none
    ok "Federated credential created: ${cred_name}"
  elif [ "$existing_subject" = "$subject" ]; then
    ok "Federated credential already exists (subject matches): ${cred_name} (${subject})"
  else
    log "Reconciling federated credential subject: ${cred_name} (${existing_subject} -> ${subject})"
    az ad app federated-credential delete --id "$app_id" \
      --federated-credential-id "$cred_name" -o none
    az ad app federated-credential create --id "$app_id" --parameters "$fc_params" -o none
    ok "Federated credential subject reconciled: ${cred_name} -> ${subject}"
  fi
}

# --------------------------------------------------------------------------
# 1. Durable remote-state storage + per-env containers (create-if-absent)
# --------------------------------------------------------------------------
bootstrap_state_backend() {
  local sub_id
  sub_id="$(az account show --query id -o tsv)"
  log "Subscription: ${sub_id}"

  # Derive the globally-unique state-account name from the subscription id
  # (MG-24 item 9). ALWAYS derived — no override path — so bootstrap, the
  # backend-*.hcl init, and the CI workflows all resolve the SAME name from the
  # same helper and can never drift.
  STATE_STORAGE_ACCOUNT="$(state_account_name "$sub_id")" \
    || die "could not derive the state-account name from the subscription id"
  log "State storage account (subscription-derived): ${STATE_STORAGE_ACCOUNT}"

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

  # Existence check via resource_absent_or_die: a genuine not-found (exit 3 /
  # ResourceNotFound) proceeds to CREATE; a REAL error (auth / throttle / network)
  # fails loud instead of triggering an erroneous create. Do NOT revert to a bare
  # `if az … show; then … else create` — that treats every non-zero as absence.
  if resource_absent_or_die "storage account ${STATE_STORAGE_ACCOUNT}" \
      az storage account show --name "$STATE_STORAGE_ACCOUNT" --resource-group "$STATE_RG" -o none; then
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
  else
    ok "Storage account already exists: ${STATE_STORAGE_ACCOUNT}"
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
  # #item 2 red-fix: the container create/show uses AAD data-plane auth
  # (`--auth-mode login`), NOT `--auth-mode key --account-key <KEY>`. Passing the
  # account key on the command line exposes a live storage credential in the child
  # process's argv (visible in `ps` / process listings / shell traces). Instead we
  # grant the OPERATOR a Storage Blob DATA role (below) — consistent with the
  # per-env Storage Blob Data grants this bootstrap already issues to the CI/deploy
  # SPs — so the container ops authenticate via the operator's AAD token and NO
  # secret ever appears on argv. No account key is fetched at all.
  local operator_oid state_sa_id
  # Determine the signed-in principal TYPE first, then branch (see
  # operator_state_grant_oid). An SP session yields SKIP_SP (deliberate
  # fail-soft); a USER session yields the object id or DIES LOUD on a genuine
  # Graph/auth/network failure — no blanket `|| true` masking a real error.
  operator_oid="$(operator_state_grant_oid)"
  state_sa_id="$(az storage account show \
    --name "$STATE_STORAGE_ACCOUNT" --resource-group "$STATE_RG" --query id -o tsv)"
  if [ "$operator_oid" = "SKIP_SP" ]; then
    # Legitimate FAIL-SOFT: the session is a SERVICE PRINCIPAL, so the per-operator
    # 'Storage Blob Data Contributor' grant is NOT APPLICABLE — skip it by design
    # (this is not a failure). Whatever principal runs `terraform init` against
    # this backend must already hold a Storage Blob Data role on the state account;
    # granting that to an arbitrary automation SP is intentionally out of scope
    # here (that is what the per-env CI/deploy SP grants below cover).
    log "Signed-in principal is a SERVICE PRINCIPAL — skipping the per-operator 'Storage Blob Data Contributor' grant on ${STATE_STORAGE_ACCOUNT} (not applicable to an SP session; by design, not a failure)."
  else
    # USER session with a resolved object id. Storage Blob Data Contributor on the
    # state account so `--auth-mode login` can create/list containers. Idempotent
    # (create is a no-op if already held). FAIL LOUD on a genuine authorization/
    # role-assignment failure — no blanket `|| true` that would print a false
    # "granted". A real AuthorizationFailed (operator lacks User Access
    # Administrator/Owner) must abort here.
    ensure_role_assignment "$operator_oid" User "Storage Blob Data Contributor" "$state_sa_id" \
      || die "failed to grant the operator 'Storage Blob Data Contributor' on ${STATE_STORAGE_ACCOUNT} — the signed-in principal likely lacks Owner/User Access Administrator on the state account."
    ok "Storage Blob Data Contributor granted to the operator on ${STATE_STORAGE_ACCOUNT}"
    # Wait (bounded poll, not a blind sleep) for the just-granted data-plane role
    # to become effective before the first `--auth-mode login` container call.
    wait_for_blob_data_plane "$STATE_STORAGE_ACCOUNT"
  fi

  local env container
  for env in $GITHUB_ENVIRONMENTS; do
    container="$(state_container_for "$env")"
    # Existence check via resource_absent_or_die (NOT a bare `if az … show`, which
    # would discard stderr and treat every non-zero — auth / throttle / network —
    # as absence): a genuine ContainerNotFound proceeds to CREATE; a REAL error
    # fails loud rather than triggering an erroneous create.
    if resource_absent_or_die "state container ${container}" \
        az storage container show \
        --name "$container" \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --auth-mode login -o none; then
      az storage container create \
        --name "$container" \
        --account-name "$STATE_STORAGE_ACCOUNT" \
        --auth-mode login \
        -o none
      ok "State container created: ${container}"
    else
      ok "State container already exists: ${container}"
    fi
  done
}

# --------------------------------------------------------------------------
# 2. Per-environment OIDC PLAN/READ identities (create-if-absent).
#    One AAD app + SP per environment, least-privilege PLAN/READ-only (Reader),
#    with data-plane state access scoped to that environment's container ONLY.
#    These identities NEVER publish app code — that is the separate deployment
#    identity below (bootstrap_deploy_identity).
# --------------------------------------------------------------------------
bootstrap_oidc_identity() {
  local sub_id tenant_id state_sa_id
  sub_id="$(az account show --query id -o tsv)"
  tenant_id="$(az account show --query tenantId -o tsv)"
  # State account was created (fail-loud) by bootstrap_state_backend, so a lookup
  # failure here is a REAL error, not "absent" — fail loud rather than a blanket
  # `|| true` that would silently skip the per-env blob-role grant.
  state_sa_id="$(az_discover "state storage account ${STATE_STORAGE_ACCOUNT}" \
    az storage account show \
    --name "$STATE_STORAGE_ACCOUNT" --resource-group "$STATE_RG" \
    --query id -o tsv)"

  local env tfenv app_name app_id sp_id cred_name subject container container_scope
  for env in $GITHUB_ENVIRONMENTS; do
    tfenv="$(tf_env_for "$env")"
    app_name="${AAD_APP_NAME}-${tfenv}"
    container="$(state_container_for "$env")"

    log "── Environment '${env}' (tf: ${tfenv}) — PLAN/READ identity ${app_name}"

    # AAD application PER ENVIRONMENT (create-if-absent, keyed by display name).
    # Discovery distinguishes absent (empty, exit 0 → create) from a real error.
    app_id="$(az_discover "AAD application '${app_name}'" \
      az ad app list --display-name "$app_name" --query '[0].appId' -o tsv)"
    if [ -z "$app_id" ] || [ "$app_id" = "null" ]; then
      log "Creating AAD application: ${app_name}"
      app_id="$(az ad app create --display-name "$app_name" --query appId -o tsv)" \
        || die "failed to create the AAD application '${app_name}' for the ${env} plan/read identity — check tenant app-registration permissions."
      ok "AAD application created: ${app_id}"
    else
      ok "AAD application already exists: ${app_id}"
    fi

    # Service principal (create-if-absent). No password/secret is ever
    # generated — federation is the only credential. Use `sp list --filter` (not
    # `sp show`, which returns non-zero for not-found and so can't distinguish
    # absence from a real error) so absent = empty/exit-0.
    sp_id="$(az_discover "service principal for app ${app_id}" \
      az ad sp list --filter "appId eq '${app_id}'" --query '[0].id' -o tsv)"
    if [ -z "$sp_id" ] || [ "$sp_id" = "null" ]; then
      log "Creating service principal for ${app_id}"
      sp_id="$(az ad sp create --id "$app_id" --query id -o tsv)" \
        || die "failed to create the service principal for the ${env} plan/read identity (${app_id}) — check you may create service principals in the tenant."
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
    # Reconcile on SUBJECT, not just name (see ensure_federated_credential): the
    # subject IS the OIDC trust binding, so a credential with the right name but
    # a stale subject (prior repo/env or subject-format change) would bind
    # federation to the WRONG trust.
    ensure_federated_credential "$app_id" "$cred_name" "$subject" \
      "GitHub Actions OIDC for the '${env}' environment of ${GITHUB_REPO}"

    # Least-privilege role: Reader (plan/read) at the subscription scope so
    # `terraform plan` can read live resource state. This role CANNOT mutate
    # infrastructure — an accidental CI apply fails closed. Idempotent.
    log "Assigning ${CI_PLAN_ROLE} (plan/read-only) at subscription scope for ${env}"
    ensure_role_assignment "$sp_id" ServicePrincipal "$CI_PLAN_ROLE" "/subscriptions/${sub_id}"
    ok "${CI_PLAN_ROLE} granted to the ${env} CI identity (no write/apply role)"

    # Data-plane access to THIS ENVIRONMENT'S state container ONLY — not the
    # whole state account, and not the other environment's container. This is
    # the per-env state isolation: the dev SP can read/lock dev.tfstate but
    # cannot touch prod.tfstate, and vice-versa.
    if [ -n "$state_sa_id" ]; then
      container_scope="${state_sa_id}/blobServices/default/containers/${container}"
      ensure_role_assignment "$sp_id" ServicePrincipal "Storage Blob Data Contributor" "$container_scope"
      ok "Storage Blob Data Contributor granted on container ${container} ONLY"
    else
      warn "State storage account not found for blob-role scope — run state bootstrap first"
    fi

    # Emit the (non-secret) coordinates the operator wires into the matching
    # GitHub Environment. NOTE: these are identifiers, NOT secrets — OIDC issues
    # short-lived tokens at run time, so nothing here needs guarding.
    cat <<SUMMARY

────────────────────────────────────────────────────────────────────
GitHub Environment '${env}' — PLAN/READ identity. Add these as *Environment*
variables (NO client secret exists or is needed):

  AZURE_CLIENT_ID        = ${app_id}
  AZURE_TENANT_ID        = ${tenant_id}
  AZURE_SUBSCRIPTION_ID  = ${sub_id}

  Federated subject: ${subject}
  State container:   ${container} (this env's isolated tfstate)
  CI role: ${CI_PLAN_ROLE} (plan/read-only) + Storage Blob Data Contributor
           on container ${container} ONLY. Apply is OPERATOR-run, never CI.
           Publishing app code is the SEPARATE deployment identity
           (AZURE_APP_DEPLOY_CLIENT_ID) — this identity cannot publish.
────────────────────────────────────────────────────────────────────
SUMMARY
  done
}

# --------------------------------------------------------------------------
# Deterministic GUID (8-4-4-4-12) derived from a seed via sha1 — NO randomness,
# so re-running the bootstrap reuses the SAME scope id (idempotent) instead of
# minting a duplicate delegated-permission scope each run.
# --------------------------------------------------------------------------
stable_guid() {
  local h
  h="$(printf '%s' "$1" | sha1sum | cut -c1-32)"
  printf '%s-%s-%s-%s-%s\n' "${h:0:8}" "${h:8:4}" "${h:12:4}" "${h:16:4}" "${h:20:12}"
}

# --------------------------------------------------------------------------
# 3. dev APP-DEPLOYMENT identity (create-if-absent) — MG-24 item 4.
#    A SEPARATE app/SP from the plan identity, granted ONLY enough to publish
#    the dev Function App: `Website Contributor` scoped to the dev Function App
#    ALONE + Storage Blob Data Reader on the dev state container. Emitted as
#    AZURE_APP_DEPLOY_CLIENT_ID for ci.yml/app-deploy. The PROD deployment
#    identity + role is an explicit MG-25 gap — NOT created here.
# --------------------------------------------------------------------------
bootstrap_deploy_identity() {
  local sub_id tenant_id state_sa_id
  sub_id="$(az account show --query id -o tsv)"
  tenant_id="$(az account show --query tenantId -o tsv)"
  # Fail loud on a state-account lookup error (the account already exists from
  # bootstrap_state_backend) rather than a blanket `|| true` masking it as absent.
  state_sa_id="$(az_discover "state storage account ${STATE_STORAGE_ACCOUNT}" \
    az storage account show \
    --name "$STATE_STORAGE_ACCOUNT" --resource-group "$STATE_RG" \
    --query id -o tsv)"

  # DEV ONLY. Prod app-deployment identity is MG-25 (see runbook / summary).
  local env="development" tfenv="dev"
  local app_name="${AAD_DEPLOY_APP_NAME}-${tfenv}"
  local container app_id sp_id cred_name subject container_scope
  container="$(state_container_for "$env")"

  log "── dev APP-DEPLOYMENT identity ${app_name} (publish-only, separate SP)"

  app_id="$(az_discover "AAD application '${app_name}'" \
    az ad app list --display-name "$app_name" --query '[0].appId' -o tsv)"
  if [ -z "$app_id" ] || [ "$app_id" = "null" ]; then
    log "Creating AAD application: ${app_name}"
    app_id="$(az ad app create --display-name "$app_name" --query appId -o tsv)" \
      || die "failed to create the AAD application '${app_name}' for the dev app-deployment identity — check tenant app-registration permissions."
    ok "AAD application created: ${app_id}"
  else
    ok "AAD application already exists: ${app_id}"
  fi

  # Service principal (create-if-absent). NO password/secret — OIDC federation
  # is the only credential for this identity too. `sp list --filter` (not
  # `sp show`) so absent = empty/exit-0 and a real error stays non-zero.
  sp_id="$(az_discover "service principal for app ${app_id}" \
    az ad sp list --filter "appId eq '${app_id}'" --query '[0].id' -o tsv)"
  if [ -z "$sp_id" ] || [ "$sp_id" = "null" ]; then
    log "Creating service principal for ${app_id}"
    sp_id="$(az ad sp create --id "$app_id" --query id -o tsv)" \
      || die "failed to create the service principal for the dev app-deployment identity (${app_id}) — check you may create service principals in the tenant."
    ok "Service principal created: ${sp_id}"
  else
    ok "Service principal already exists: ${sp_id}"
  fi

  # Federate the SAME GitHub Environment subject as the dev plan job
  # (repo:<repo>:environment:development). The app-deploy job selects THIS
  # app's client id (AZURE_APP_DEPLOY_CLIENT_ID) rather than the plan identity's.
  cred_name="github-appdeploy-${env}"
  subject="repo:${GITHUB_REPO}:environment:${env}"
  # Reconcile on SUBJECT, not just name (see ensure_federated_credential): a
  # credential with the right name but a stale/wrong subject would bind
  # deployment federation to the WRONG trust.
  ensure_federated_credential "$app_id" "$cred_name" "$subject" \
    "GitHub Actions OIDC (app-deploy) for the '${env}' environment of ${GITHUB_REPO}"

  # Publish role: `${DEPLOY_APP_ROLE}` (Website Contributor) scoped to the dev
  # Function App ALONE. This role is now created by TERRAFORM in the SAME apply
  # that creates the Function App (root azurerm_role_assignment
  # "functions_app_deploy_publisher", guarded by var.app_deploy_principal_object_id)
  # — NOT here. Bootstrap runs BEFORE the apply, so the FA does not exist yet;
  # discovering it here and granting via CLI would only ever defer, and a
  # post-apply re-run would collide with Terraform's own assignment. Instead we
  # EMIT this identity's SP OBJECT ID below so the operator sets
  # app_deploy_principal_object_id in dev.tfvars and the single apply grants it.
  # The SP object id is $sp_id (resolved above via `az ad sp list --filter
  # "appId eq <appId>" --query [0].id`). No Function-App lookup is needed here.

  # State read for publish (resolve outputs) — READER, not Contributor, on the
  # dev container ONLY. The deploy identity must never write state.
  if [ -n "$state_sa_id" ]; then
    container_scope="${state_sa_id}/blobServices/default/containers/${container}"
    ensure_role_assignment "$sp_id" ServicePrincipal "Storage Blob Data Reader" "$container_scope"
    ok "Storage Blob Data Reader granted on container ${container} ONLY (read-only)"
  else
    warn "State storage account not found for blob-role scope — run state bootstrap first"
  fi

  cat <<SUMMARY

────────────────────────────────────────────────────────────────────
dev APP-DEPLOYMENT identity — separate SP, publish-only.

  1) Add as an *Environment* variable on the GitHub 'development' environment
     (NO client secret exists or is needed):

       AZURE_APP_DEPLOY_CLIENT_ID = ${app_id}
       (AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID are shared with the plan identity)

  2) Set this SP OBJECT ID in environments/dev.tfvars BEFORE the apply so
     Terraform grants '${DEPLOY_APP_ROLE}' scoped to the Function App alone in
     the SAME apply that creates it (then `func publish` works immediately):

       AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID = ${sp_id}
       # → app_deploy_principal_object_id = "${sp_id}"

  Federated subject: ${subject}
  Role: ${DEPLOY_APP_ROLE} on the dev Function App ONLY (Terraform-managed via
        app_deploy_principal_object_id) + Storage Blob Data Reader on
        ${container} ONLY (granted above). This identity publishes code; it
        cannot plan/mutate other infra and cannot write state.
  MG-25 GAP: the PROD app-deployment identity + its publish role are NOT
             created here — they are provisioned under MG-25 (prod activation).
────────────────────────────────────────────────────────────────────
SUMMARY
}

# --------------------------------------------------------------------------
# 4. dev ENTRA API AUTH registration (create-if-absent) — MG-24 item 3.
#    The API app the Function App's Easy Auth validates user/API tokens against.
#    DISTINCT from every OIDC/deployment app; exposes ONE delegated scope
#    (access_as_user); NO client secret. Emits the coordinates the operator
#    wires into environments/dev.tfvars (functions_auth_*).
# --------------------------------------------------------------------------
bootstrap_dev_api_registration() {
  local tenant_id app_id app_uri scope_id preauth_json api_body
  tenant_id="$(az account show --query tenantId -o tsv)"

  log "── dev ENTRA API auth registration ${DEV_API_APP_NAME} (scope ${DEV_API_SCOPE_NAME})"

  app_id="$(az_discover "dev API registration '${DEV_API_APP_NAME}'" \
    az ad app list --display-name "$DEV_API_APP_NAME" --query '[0].appId' -o tsv)"
  if [ -z "$app_id" ] || [ "$app_id" = "null" ]; then
    log "Creating dev API registration: ${DEV_API_APP_NAME}"
    # Single tenant (AzureADMyOrg): the dev API is not multi-tenant.
    app_id="$(az ad app create --display-name "$DEV_API_APP_NAME" \
      --sign-in-audience AzureADMyOrg --query appId -o tsv)" \
      || die "failed to create the dev API registration '${DEV_API_APP_NAME}' — check tenant app-registration permissions."
    ok "Dev API registration created: ${app_id}"
  else
    ok "Dev API registration already exists: ${app_id}"
  fi

  app_uri="api://${app_id}"
  # Stable scope id (idempotent — no randomness) so re-runs reuse the scope.
  scope_id="$(stable_guid "meatgeek-v2-dev-api-${DEV_API_SCOPE_NAME}-${app_id}")"

  # Pre-authorize the CALLING smoke-test client app id(s) for the access_as_user
  # scope so the MG-21 authenticated smoke test acquires a token without an
  # interactive consent prompt. These MUST match the Function App Easy Auth
  # allowed_applications (functions_auth_allowed_client_app_ids) — the calling
  # client, NOT the API registration. Deduped; empty tokens skipped.
  local preauth_entries="" cid seen=" " preauth_ids=""
  for cid in $SMOKE_TEST_CLIENT_IDS; do
    [ -z "$cid" ] && continue
    # Caller-controlled id rendered verbatim into the Graph preAuthorizedApplications
    # manifest AND the emitted functions_auth_allowed_client_app_ids HCL — validate
    # it is a bare GUID (fail loud) before it can produce a bogus manifest / broken HCL.
    assert_uuid "$cid" "SMOKE_TEST_CLIENT_IDS"
    case "$seen" in *" $cid "*) continue ;; esac
    seen="${seen}${cid} "
    preauth_ids="${preauth_ids:+${preauth_ids} }${cid}"
    preauth_entries="${preauth_entries:+${preauth_entries},} { \"appId\": \"${cid}\", \"delegatedPermissionIds\": [\"${scope_id}\"] }"
    log "Pre-authorizing calling client ${cid} for ${DEV_API_SCOPE_NAME}"
  done
  preauth_json="[ ${preauth_entries} ]"

  # Expose the delegated scope + set the App ID URI + v2 access tokens via a
  # single Microsoft Graph PATCH (idempotent — the stable scope id makes repeat
  # PATCHes converge). NO client secret / password anywhere.
  api_body="$(cat <<JSON
{
  "identifierUris": ["${app_uri}"],
  "api": {
    "requestedAccessTokenVersion": 2,
    "oauth2PermissionScopes": [
      {
        "id": "${scope_id}",
        "value": "${DEV_API_SCOPE_NAME}",
        "type": "User",
        "isEnabled": true,
        "adminConsentDisplayName": "Access MeatGeek V2 dev API",
        "adminConsentDescription": "Allow the app to access the MeatGeek V2 dev API as the signed-in user.",
        "userConsentDisplayName": "Access MeatGeek V2 dev API",
        "userConsentDescription": "Allow the app to access the MeatGeek V2 dev API on your behalf."
      }
    ],
    "preAuthorizedApplications": ${preauth_json}
  }
}
JSON
)"
  az rest --method PATCH \
    --uri "https://graph.microsoft.com/v1.0/applications(appId='${app_id}')" \
    --headers "Content-Type=application/json" \
    --body "$api_body" \
    -o none
  ok "Delegated scope '${DEV_API_SCOPE_NAME}' exposed on ${app_uri} (no client secret)"

  # Enterprise app (SP) so the API can be granted admin consent in the tenant.
  # Guarded create-if-absent: `sp list --filter` distinguishes absent (empty,
  # exit 0) from a REAL discovery error (non-zero → die via az_discover), and the
  # create itself FAILS LOUD — no `|| true` that would report a phantom "created".
  local api_sp_id
  api_sp_id="$(az_discover "service principal for the dev API registration (${app_id})" \
    az ad sp list --filter "appId eq '${app_id}'" --query '[0].id' -o tsv)"
  if [ -z "$api_sp_id" ] || [ "$api_sp_id" = "null" ]; then
    az ad sp create --id "$app_id" -o none \
      || die "failed to create the service principal for the dev API registration (${app_id})"
    ok "Service principal created for the dev API registration"
  fi

  cat <<SUMMARY

────────────────────────────────────────────────────────────────────
dev ENTRA API auth registration — emitted coordinates (identifiers, NOT
secrets). COPY THESE — the App ID URI is what the operator authenticated
smoke test needs; it is NOT a Terraform output (this app is bootstrap-created,
not TF-managed), so there is no 'terraform output' for it:

  DEV_API_CLIENT_ID   = ${app_id}
  DEV_API_TENANT_ID   = ${tenant_id}
  DEV_API_APP_ID_URI  = ${app_uri}          # the audience (aud) Easy Auth validates

  Retrieve the App ID URI later (already-bootstrapped env, no re-run needed):
    az ad app show --id ${app_id} --query 'identifierUris[0]' -o tsv

Wire these into environments/dev.tfvars (functions_auth_*) post-bootstrap:

  functions_auth_client_id          = "${app_id}"
  functions_auth_tenant_id          = "${tenant_id}"
  functions_auth_allowed_audiences  = ["${app_uri}"]

  functions_auth_allowed_client_app_ids = $(hcl_string_list "$preauth_ids" "SMOKE_TEST_CLIENT_IDS")  # calling client(s)

  Delegated scope: ${app_uri}/${DEV_API_SCOPE_NAME}
  Operator token:  APP_ID_URI=\$(az ad app show --id ${app_id} --query 'identifierUris[0]' -o tsv)
                   az account get-access-token --scope "\$APP_ID_URI/${DEV_API_SCOPE_NAME}"
  Pre-authorized calling client(s) (allowed_applications): ${preauth_ids}
  These are the CALLING client(s) Easy Auth accepts (validates appid/azp), NOT the
  API registration. A token minted by any OTHER client is rejected. The default is
  the Azure CLI public client (04b07795-8ddb-461a-bbee-02f9e1bf7b46).
  This app is SEPARATE from the OIDC/deployment apps and has NO client secret.
  (See docs/infrastructure/bootstrap-runbook.md for the authenticated smoke test.)
────────────────────────────────────────────────────────────────────
SUMMARY
}

main() {
  log "🚀 MeatGeek V2 bootstrap (remote state + plan/deploy identities + dev API auth)"
  require_tools
  bootstrap_state_backend
  bootstrap_oidc_identity        # per-env PLAN/READ identities (Reader)
  bootstrap_deploy_identity      # dev APP-DEPLOYMENT identity (publish-only)
  bootstrap_dev_api_registration # dev Entra API auth registration (access_as_user)
  ok "Bootstrap complete. Next: follow docs/infrastructure/bootstrap-runbook.md"
}

# Only auto-run when executed directly; allows sourcing for unit tests.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
