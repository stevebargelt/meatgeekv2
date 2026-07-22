#!/usr/bin/env bash
#
# Security/behaviour tests for the MeatGeek V2 bootstrap (Step 6, infosec).
# Pure bash — no Azure required. Sources bootstrap.sh (main is guarded, so it
# does NOT execute) and asserts the V1-safety guard + the hard-safety
# invariants of both scripts. Run: bash bootstrap.test.sh
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOT="$DIR/bootstrap.sh"
SETUP="$DIR/../terraform-setup.sh"
pass=0; fail=0

# Source FIRST (main is guarded by BASH_SOURCE==0), then define the test
# helpers with distinct names — bootstrap.sh defines its own ok()/warn()/die(),
# so the tallying helpers must not collide with those.
# shellcheck disable=SC1090
source "$BOOT"

ok()   { pass=$((pass+1)); printf 'ok   - %s\n' "$1"; }
bad()  { fail=$((fail+1)); printf 'FAIL - %s\n' "$1"; }

# --- V1-safety guard: POSITIVE (valid V2 names accepted) --------------------
for name in "meatgeek-v2-tfstate-rg" "meatgeekv2tfstate" "meatgeek-v2-dev-rg"; do
  if assert_v2_name "test" "$name" 2>/dev/null; then ok "accepts V2 name: $name"
  else bad "should accept V2 name: $name"; fi
done

# --- V1-safety guard: NEGATIVE (wrong/legacy names REJECTED) ----------------
# This is the security-critical direction: the guard must refuse anything that
# is not unambiguously V2, and refuse known legacy V1 identifiers outright.
for name in \
  "meatgeekterraformstate" \
  "MeatGeek-Shared" \
  "meatgeek-shared-rg" \
  "meatgeek-dev-rg" \
  "terraformstate" \
  "" ; do
  if assert_v2_name "test" "$name" 2>/dev/null; then bad "should REJECT non-V2/legacy name: '$name'"
  else ok "rejects non-V2/legacy name: '$name'"; fi
done

# A legacy identifier that also contains 'v2' must still be rejected.
if assert_v2_name "test" "meatgeek-v2-meatgeekterraformstate" 2>/dev/null; then
  bad "should REJECT name containing a legacy V1 identifier"
else ok "rejects V2-looking name that embeds a legacy V1 identifier"; fi

# --- Hard-safety invariant: NO terraform apply anywhere ---------------------
if grep -Eq 'terraform[[:space:]]+apply' "$BOOT" "$SETUP"; then
  bad "scripts must never invoke 'terraform apply'"
else ok "no 'terraform apply' in bootstrap.sh or terraform-setup.sh"; fi

# --- Least-privilege: CI role is plan/read-only, never Contributor/Owner ----
if grep -Eq -- '--role[[:space:]]+"?(Contributor|Owner)"?' "$BOOT"; then
  bad "CI identity must not be granted Contributor/Owner"
else ok "no Contributor/Owner role grant in bootstrap.sh"; fi
if grep -q 'CI_PLAN_ROLE:-Reader' "$BOOT"; then ok "CI plan role defaults to Reader"
else bad "CI plan role should default to Reader"; fi

# --- OIDC: federated subjects are per-GitHub-Environment, not branch-only ----
if grep -q 'repo:${GITHUB_REPO}:environment:${env}' "$BOOT"; then
  ok "federated subject is scoped per GitHub Environment"
else bad "federated subject must be environment-scoped"; fi
if grep -Eq 'subject.*:ref:refs/heads' "$BOOT"; then
  bad "federated subject must NOT be a bare branch ref"
else ok "no branch-ref-only federated subject"; fi

# --- OIDC subject CONSISTENCY (MG-24 red-fix): bootstrap subjects == workflow ---
# The dev-auth-fails bug was a silent DRIFT: bootstrap federated
# `…:environment:dev` while the workflow job declared `environment: development`,
# so the presented OIDC subject (`repo:<repo>:environment:development`) never
# matched the credential. Assert the two sides agree, per environment, so it
# cannot silently drift again.
#
# bootstrap.sh is sourced above, so GITHUB_ENVIRONMENTS / tf_env_for /
# state_container_for are callable directly.

# The canonical GitHub-Environment set the bootstrap federates must be the
# full-word names the workflows use — `development` (ci.yml deploy-dev) and
# `production` — NOT the retired bare `dev` that never matched.
case " $GITHUB_ENVIRONMENTS " in
  *" development "*) ok "bootstrap federates 'development' (matches ci.yml deploy-dev environment)";;
  *) bad "GITHUB_ENVIRONMENTS must include 'development' (deploy-dev uses environment: development)";;
esac
case " $GITHUB_ENVIRONMENTS " in
  *" production "*) ok "bootstrap federates 'production'";;
  *) bad "GITHUB_ENVIRONMENTS must include 'production'";;
esac
case " $GITHUB_ENVIRONMENTS " in
  *" dev "*) bad "GITHUB_ENVIRONMENTS must not federate bare 'dev' (workflow uses 'development'; subjects would never match)";;
  *) ok "no stale bare-'dev' GitHub Environment federated";;
esac

# The full-word GitHub-env names still derive the short dev/prod tf + state
# names, so state containers keep matching backend-{dev,prod}.hcl.
[ "$(tf_env_for development)" = "dev" ]  && ok "tf_env_for development -> dev"  || bad "tf_env_for development must map to dev"
[ "$(tf_env_for production)"  = "prod" ] && ok "tf_env_for production -> prod" || bad "tf_env_for production must map to prod"
[ "$(state_container_for development)" = "tfstate-dev" ]  && ok "dev state container -> tfstate-dev (backend-dev.hcl)"  || bad "dev container must be tfstate-dev"
[ "$(state_container_for production)"  = "tfstate-prod" ] && ok "prod state container -> tfstate-prod (backend-prod.hcl)" || bad "prod container must be tfstate-prod"

# CROSS-CHECK the actual workflow YAML: every `environment:` a job declares
# (which becomes the presented OIDC subject repo:<repo>:environment:<env>) MUST
# be a GitHub Environment the bootstrap federates. This is the anti-drift gate.
WF_DIR="$DIR/../../../.github/workflows"
if [ -d "$WF_DIR" ]; then
  wf_envs="$(grep -rhoE '^[[:space:]]*environment:[[:space:]]*[A-Za-z0-9_-]+' \
      "$WF_DIR/ci.yml" "$WF_DIR/infra-deploy-prod.yml" "$WF_DIR/app-deploy-prod.yml" 2>/dev/null \
    | sed -E 's/.*environment:[[:space:]]*//' | sort -u)"
  [ -n "$wf_envs" ] || bad "no workflow environment: declarations found to cross-check"
  for e in $wf_envs; do
    case " $GITHUB_ENVIRONMENTS " in
      *" $e "*) ok "workflow environment '$e' matches a bootstrap federated subject" ;;
      *) bad "workflow environment '$e' has NO matching bootstrap federated credential (OIDC subject would not match)" ;;
    esac
  done
  if grep -qE '^[[:space:]]*environment:[[:space:]]*development[[:space:]]*$' "$WF_DIR/ci.yml"; then
    ok "ci.yml deploy-dev declares environment: development (subject repo:*:environment:development)"
  else
    bad "ci.yml must declare environment: development so the dev OIDC subject matches bootstrap"
  fi
else
  bad "workflow dir not found for OIDC subject cross-check: $WF_DIR"
fi

# --- No client secret is created (OIDC = no long-lived secret) --------------
if grep -Eq 'az ad (app|sp) credential (reset|create)' "$BOOT"; then
  bad "must not mint a client secret for the OIDC identity"
else ok "no client secret minted for the OIDC identity"; fi

# --- Per-env ISOLATED identities (MG-24 red-fix): one AAD app per env --------
# The app display name must be per-environment (…-${tfenv}) so dev and prod get
# SEPARATE service principals rather than sharing a single OIDC identity.
if grep -q 'app_name="${AAD_APP_NAME}-${tfenv}"' "$BOOT"; then
  ok "per-environment AAD application (separate SP per env)"
else bad "AAD application must be per-environment (…-\${tfenv}), not shared"; fi

# --- Per-env STATE RBAC (MG-24 red-fix): container-scoped, not whole-account --
# Each SP's Storage Blob Data role must be scoped to that env's container only,
# NOT the whole state account (which would give dev access to prod state).
if grep -q '/blobServices/default/containers/${container}' "$BOOT"; then
  ok "state blob role is scoped to the env's container only"
else bad "state blob role must be scoped per-env container, not whole account"; fi
# Whole-state-account blob-role grants: the SP (dev/prod CI + deploy) identities
# must NEVER get one (that would give dev access to prod state). The ONE permitted
# whole-account grant is the OPERATOR's Storage Blob Data role (item 2) — creating
# a state container is an account-level data-plane op that cannot be
# container-scoped — and it must be a User-principal grant, not an SP grant.
# All role grants now flow through the ensure_role_assignment helper
# (object_id principal_type role scope); assert EXACTLY ONE grant whose scope is
# the whole account ("$state_sa_id"), and that it is the operator's User grant.
whole_acct_scopes="$(grep -Ec 'ensure_role_assignment[[:space:]].*[[:space:]]"\$state_sa_id"([[:space:]]|$|\\)' "$BOOT" || true)"
if [ "${whole_acct_scopes:-0}" -eq 1 ] \
   && grep -Eq 'ensure_role_assignment[[:space:]]+"\$operator_oid"[[:space:]]+User[[:space:]]+"Storage Blob Data Contributor"[[:space:]]+"\$state_sa_id"' "$BOOT" \
   && grep -q 'signed-in-user' "$BOOT"; then
  ok "only the operator holds a whole-account blob grant (item 2); SP grants stay container-scoped"
else bad "the only whole-account blob-role grant may be the operator's User grant (item 2); SP state grants must be container-scoped"; fi

# --- Per-env state CONTAINERS (isolation): tfstate-<env> ---------------------
if grep -q 'state_container_for() { echo "tfstate-' "$BOOT"; then
  ok "per-environment state containers (tfstate-<env>)"
else bad "state containers must be per-environment (tfstate-<env>)"; fi

# --- #item 2: no storage account key on the command line --------------------
# The container create/show must NOT pass the storage account key on argv (it
# would leak a live credential into process listings). No account key is fetched
# and no `--auth-mode key --account-key` call exists; container ops use AAD
# (`--auth-mode login`) instead, backed by an operator Storage Blob DATA grant.
# Ignore comment lines so the note explaining the fix doesn't self-trip. Compute
# the non-comment body ONCE into a var and search it with a here-string (not a
# `grep -v | grep -q` pipe: grep -q short-circuits and SIGPIPEs the upstream
# grep, which under `pipefail` non-deterministically fails the pipeline).
BOOT_NONCOMMENT="$(grep -vE '^[[:space:]]*#' "$BOOT")"
if grep -q -- '--account-key' <<<"$BOOT_NONCOMMENT"; then
  bad "no storage account key may appear on the command line (leaks via argv)"
else ok "no storage account key on argv (no --account-key)"; fi
if grep -q 'az storage account keys list' <<<"$BOOT_NONCOMMENT"; then
  bad "bootstrap must not fetch a storage account key for container ops"
else ok "bootstrap does not fetch a storage account key"; fi
if grep -q -- '--auth-mode login' <<<"$BOOT_NONCOMMENT"; then
  ok "container ops use AAD data-plane auth (--auth-mode login), no secret on argv"
else bad "container ops must use --auth-mode login (no account key on argv)"; fi
# The operator gets a Storage Blob DATA role so --auth-mode login works, mirroring
# the per-env Storage Blob Data grants issued to the CI/deploy SPs. The grant now
# goes through the ensure_role_assignment helper as a User-principal assignment.
if grep -q 'signed-in-user' "$BOOT" \
   && grep -Eq 'ensure_role_assignment[[:space:]]+"\$operator_oid"[[:space:]]+User[[:space:]]+"Storage Blob Data Contributor"' "$BOOT"; then
  ok "operator granted Storage Blob Data Contributor for AAD container ops"
else bad "operator must get a Storage Blob DATA role so --auth-mode login can create containers"; fi

# --- terraform-setup.sh: no 'local backend' guidance, points to bootstrap ---
if grep -Eqi 'local backend' "$SETUP"; then bad "terraform-setup.sh still advertises a local backend"
else ok "terraform-setup.sh has no local-backend guidance"; fi
if grep -q 'backend-config=environments/backend-' "$SETUP"; then
  ok "terraform-setup.sh directs to a -backend-config init"
else bad "terraform-setup.sh must direct to -backend-config init"; fi
if grep -q 'bootstrap.sh' "$SETUP" && grep -q 'bootstrap-runbook.md' "$SETUP"; then
  ok "terraform-setup.sh points at bootstrap.sh + the runbook"
else bad "terraform-setup.sh must point at bootstrap.sh + the runbook"; fi
# Reject the OLD bare 'terraform init' (no backend-config) recommendation.
if grep -Eq '(Run|run):[[:space:]]*terraform init[[:space:]]*$' "$SETUP"; then
  bad "terraform-setup.sh still recommends a bare 'terraform init'"
else ok "no bare 'terraform init' recommendation in terraform-setup.sh"; fi

# ===========================================================================
# MG-24 corrective (item 9): subscription-derived state-account NAME helper
# ===========================================================================
HELPER="$DIR/../scripts/state-account-name.sh"
if [ -f "$HELPER" ]; then
  # EXERCISE the helper: a sample uuid must yield a <=24-char lowercase-alnum
  # storage-account name that also passes the V1-safety guard.
  san="$(bash "$HELPER" "12345678-1234-1234-1234-123456789abc" 2>/dev/null || true)"
  if [ -n "$san" ] && [ "${#san}" -le 24 ] && printf '%s' "$san" | grep -Eq '^[a-z0-9]{3,24}$'; then
    ok "state-account-name.sh emits a <=24-char lowercase-alnum name ($san)"
  else
    bad "state-account-name.sh must emit a <=24-char lowercase-alnum name (got '$san')"
  fi
  if assert_v2_name "state account" "$san" 2>/dev/null; then
    ok "derived state-account name passes assert_v2_name (V1-safety guard)"
  else
    bad "derived state-account name must pass assert_v2_name"
  fi
  # Determinism: the SAME subscription id must always derive the SAME name
  # (single source of truth — no drift between bootstrap, workflows, runbook).
  san2="$(bash "$HELPER" "12345678-1234-1234-1234-123456789abc" 2>/dev/null || true)"
  if [ "$san" = "$san2" ]; then ok "state-account name derivation is deterministic (no drift)"
  else bad "state-account name derivation must be deterministic"; fi
  # SINGLE SOURCE OF TRUTH (MG-24 item 9): the prefix is a FIXED committed
  # constant, NOT env-overridable. A STATE_ACCOUNT_PREFIX env var must be IGNORED
  # so bootstrap and the CI workflows can never derive different state-account
  # names for the same subscription.
  san_env="$(STATE_ACCOUNT_PREFIX="somethingelse00" \
       bash "$HELPER" "12345678-1234-1234-1234-123456789abc" 2>/dev/null || true)"
  if [ "$san_env" = "$san" ]; then
    ok "state-account-name.sh prefix is NOT env-overridable (STATE_ACCOUNT_PREFIX ignored)"
  else
    bad "state-account-name.sh prefix must be fixed, not env-overridable (env-set derived '$san_env' != '$san')"
  fi
  # The fixed prefix must be exactly the committed literal.
  if printf '%s' "$san" | grep -q '^meatgeekv2tf'; then
    ok "derived state-account name uses the fixed 'meatgeekv2tf' prefix"
  else
    bad "derived state-account name must start with the fixed 'meatgeekv2tf' prefix (got '$san')"
  fi
else
  bad "state-account-name.sh helper not found: $HELPER"
fi

# bootstrap.sh must DERIVE the state-account name via the single helper, not a
# hardcoded literal (the old always-taken 'meatgeekv2tfstate').
if grep -q 'scripts/state-account-name.sh' "$BOOT"; then
  ok "bootstrap sources the single state-account-name helper"
else bad "bootstrap must source scripts/state-account-name.sh"; fi
if grep -q 'STATE_STORAGE_ACCOUNT="$(state_account_name' "$BOOT"; then
  ok "state-account name is subscription-derived (state_account_name)"
else bad "state-account name must be derived via state_account_name"; fi
if grep -q 'STATE_STORAGE_ACCOUNT:-meatgeekv2tfstate' "$BOOT"; then
  bad "state-account default must not be the hardcoded meatgeekv2tfstate literal"
else ok "no hardcoded meatgeekv2tfstate default (derived instead)"; fi

# SINGLE-SOURCE derivation (MG-24 item 9): the state-account name is ALWAYS
# derived from the helper — NO STATE_STORAGE_ACCOUNT env override may win, or
# bootstrap could drift from the backend-*.hcl init / workflows. Assert no
# override path exists: no env-seeded default and no `if [ -z ... ]` guard that
# would preserve an inherited value.
if grep -Eq 'STATE_STORAGE_ACCOUNT="\$\{STATE_STORAGE_ACCOUNT:-' "$BOOT"; then
  bad "STATE_STORAGE_ACCOUNT must not read an env override (single-source derivation)"
else ok "no STATE_STORAGE_ACCOUNT env override (name is always derived)"; fi
if grep -Eq 'if \[ -z "\$\{STATE_STORAGE_ACCOUNT' "$BOOT"; then
  bad "state-account derivation must be unconditional (no override-preserving guard)"
else ok "state-account name is derived unconditionally (no override guard)"; fi

# ===========================================================================
# MG-24 corrective (item 4): TWO distinct dev identities — plan/read vs deploy
# ===========================================================================
# The app-deployment identity must be a SEPARATE AAD app (distinct SP) from the
# plan/read identity, so "read to plan" and "publish code" are never the same SP.
if grep -q 'app_name="${AAD_DEPLOY_APP_NAME}-${tfenv}"' "$BOOT"; then
  ok "dev app-deployment identity is a separate AAD app (distinct SP)"
else bad "dev app-deployment identity must be a separate AAD app (…-\${tfenv})"; fi
# The base display names of plan vs deploy identities must differ (globals are
# in scope because bootstrap.sh is sourced above).
if [ "${AAD_APP_NAME:-}" != "${AAD_DEPLOY_APP_NAME:-}" ] && [ -n "${AAD_DEPLOY_APP_NAME:-}" ]; then
  ok "plan vs deploy identity base names differ (${AAD_APP_NAME} != ${AAD_DEPLOY_APP_NAME})"
else bad "plan and deploy identities must use distinct base display names"; fi

# The PLAN identity keeps Reader (subscription-scope, read-only) — already
# asserted above via CI_PLAN_ROLE default; here assert the DEPLOY identity's
# publish role is Website Contributor scoped to the Function App ALONE. The role
# assignment is now created by TERRAFORM (root main.tf) in the SAME apply that
# creates the Function App — NOT by a bootstrap CLI grant (bootstrap runs
# pre-apply, before the FA exists) — so these invariants are asserted against
# the root Terraform, and the bootstrap must EMIT the SP object id coordinate.
ROOT_MAIN="$DIR/../main.tf"
ROOT_VARS="$DIR/../variables.tf"
if grep -q 'DEPLOY_APP_ROLE:-Website Contributor' "$BOOT"; then
  ok "deploy identity role defaults to Website Contributor (publish-scoped)"
else bad "deploy identity role must default to Website Contributor"; fi
# The Terraform publish role assignment targets the Function App id with the
# Website Contributor role.
if grep -q 'functions_app_deploy_publisher' "$ROOT_MAIN" \
   && grep -A6 'functions_app_deploy_publisher' "$ROOT_MAIN" | grep -q 'role_definition_name = "Website Contributor"' \
   && grep -A6 'functions_app_deploy_publisher' "$ROOT_MAIN" | grep -q 'scope *= module.azure_functions.function_app_id'; then
  ok "Terraform grants Website Contributor scoped to the Function App id ONLY"
else bad "Terraform must grant Website Contributor scoped to module.azure_functions.function_app_id"; fi
# The Terraform publish assignment is GUARDED by the object-id var so an empty
# value still validates/plans (count → 0).
if grep -A6 'functions_app_deploy_publisher' "$ROOT_MAIN" | grep -q 'count .*app_deploy_principal_object_id != ""'; then
  ok "Terraform publish assignment guarded by app_deploy_principal_object_id (empty → skipped)"
else bad "Terraform publish assignment must be guarded (count) on app_deploy_principal_object_id being non-empty"; fi
# The publish role must NOT be granted at a /subscriptions/ scope anywhere.
if grep -A6 'functions_app_deploy_publisher' "$ROOT_MAIN" | grep -q '/subscriptions/'; then
  bad "publish role must not be scoped to a subscription"
else ok "no subscription-scoped grant for the deploy publish role"; fi
# The object-id variable exists and defaults to empty (so a bare plan validates).
if grep -q 'variable "app_deploy_principal_object_id"' "$ROOT_VARS" \
   && grep -A5 'variable "app_deploy_principal_object_id"' "$ROOT_VARS" | grep -q 'default *= ""'; then
  ok "app_deploy_principal_object_id variable exists and defaults to empty"
else bad "app_deploy_principal_object_id variable must exist with an empty default"; fi
# Deploy identity's state access is READ-ONLY (Reader, not Contributor). The
# grant flows through ensure_role_assignment as an SP-principal assignment scoped
# to the dev container ("$container_scope"), not the whole account.
if grep -Eq 'ensure_role_assignment[[:space:]]+"\$sp_id"[[:space:]]+ServicePrincipal[[:space:]]+"Storage Blob Data Reader"[[:space:]]+"\$container_scope"' "$BOOT"; then
  ok "deploy identity gets Storage Blob Data READER on state (read-only, container-scoped)"
else bad "deploy identity must get read-only state access (Storage Blob Data Reader) via ensure_role_assignment, container-scoped"; fi
# Emits the client id the app-deploy job consumes.
if grep -q 'AZURE_APP_DEPLOY_CLIENT_ID' "$BOOT"; then
  ok "bootstrap emits AZURE_APP_DEPLOY_CLIENT_ID for the app-deploy job"
else bad "bootstrap must emit AZURE_APP_DEPLOY_CLIENT_ID"; fi
# Emits the SP OBJECT ID as a labeled coordinate so the operator sets
# app_deploy_principal_object_id in dev.tfvars BEFORE the apply (closes the
# publish-role sequencing gap without a missing post-apply step).
if grep -q 'AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID' "$BOOT" \
   && grep -q 'app_deploy_principal_object_id' "$BOOT"; then
  ok "bootstrap emits AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID + names the tfvars key"
else bad "bootstrap must emit the app-deploy SP object id coordinate (AZURE_APP_DEPLOY_PRINCIPAL_OBJECT_ID)"; fi
# Prod deployment identity is an EXPLICIT MG-25 gap, not silently created here.
if grep -q 'MG-25' "$BOOT"; then
  ok "prod app-deployment identity is documented as an explicit MG-25 gap"
else bad "prod app-deployment identity must be documented as an MG-25 gap"; fi

# ===========================================================================
# MG-24 corrective (item 3): dev ENTRA API auth registration (access_as_user)
# ===========================================================================
if grep -q 'DEV_API_SCOPE_NAME:-access_as_user' "$BOOT"; then
  ok "dev API registration exposes the access_as_user delegated scope"
else bad "dev API registration must expose access_as_user"; fi
if grep -q 'oauth2PermissionScopes' "$BOOT" && grep -q '"value": "${DEV_API_SCOPE_NAME}"' "$BOOT"; then
  ok "delegated scope is written into the Graph application manifest"
else bad "dev API registration must write the delegated scope into the app manifest"; fi
# SEPARATE from the OIDC/deployment apps.
if [ "${DEV_API_APP_NAME:-}" != "${AAD_APP_NAME:-}" ] && [ "${DEV_API_APP_NAME:-}" != "${AAD_DEPLOY_APP_NAME:-}" ] && [ -n "${DEV_API_APP_NAME:-}" ]; then
  ok "dev API registration is a separate app from the OIDC/deployment apps"
else bad "dev API registration must be separate from the OIDC/deployment apps"; fi
# NO client secret / password on ANY az ad app create (OIDC + Easy Auth only).
if grep -E 'az ad app create' "$BOOT" | grep -q -- '--password'; then
  bad "no az ad app create may mint a client secret (--password)"
else ok "no --password on any az ad app create (no client secret minted)"; fi
# Single-tenant API (not multi-tenant).
if grep -q -- '--sign-in-audience AzureADMyOrg' "$BOOT"; then
  ok "dev API registration is single-tenant (AzureADMyOrg)"
else bad "dev API registration must be single-tenant (AzureADMyOrg)"; fi
# The Graph write for the API scope must not smuggle in a passwordCredential.
if grep -q 'passwordCredential' "$BOOT"; then
  bad "dev API registration Graph manifest must not include a passwordCredential"
else ok "no passwordCredential in the dev API registration manifest"; fi
# The App ID URI must be EMITTED as an explicit, labeled coordinate alongside the
# client id / tenant — the operator copies it for the Step 6a authenticated smoke
# test (the dev API reg is bootstrap-created, NOT TF-managed, so there is no
# `terraform output` for it; a missing coordinate leaves a dangling placeholder).
if grep -q 'DEV_API_APP_ID_URI' "$BOOT"; then
  ok "bootstrap emits the dev API App ID URI as a labeled coordinate (DEV_API_APP_ID_URI)"
else bad "bootstrap must emit the dev API App ID URI coordinate (DEV_API_APP_ID_URI)"; fi
# ...and a retrieval command for an already-bootstrapped env (no re-run needed).
if grep -Fq "identifierUris[0]" "$BOOT"; then
  ok "bootstrap prints the App ID URI retrieval command (az ad app show … identifierUris[0])"
else bad "bootstrap must print an App ID URI retrieval command (identifierUris[0])"; fi

# ===========================================================================
# F1/F5: the copy-paste tfvars/HCL the bootstrap EMITS must be VALID HCL
# ===========================================================================
# The previous emit printed functions_auth_allowed_client_app_ids as
# [uuid1, uuid2] — UNQUOTED uuids, which Terraform rejects. bootstrap.sh is
# sourced above, so the pure renderer hcl_string_list is callable directly.
#
# 1) The renderer quotes every element and brackets the list.
hcl_list_out="$(hcl_string_list "04b07795-8ddb-461a-bbee-02f9e1bf7b46 33333333-3333-3333-3333-333333333333")"
if [ "$hcl_list_out" = '["04b07795-8ddb-461a-bbee-02f9e1bf7b46", "33333333-3333-3333-3333-333333333333"]' ]; then
  ok "hcl_string_list quotes every element (valid HCL list literal)"
else
  bad "hcl_string_list must emit a quoted HCL list (got '$hcl_list_out')"
fi
# 2) Empty input renders as [] (valid HCL), not a syntax error.
[ "$(hcl_string_list "")" = "[]" ] && ok "hcl_string_list renders empty input as []" \
  || bad "hcl_string_list of empty input must be []"

# 3) Assemble the EXACT functions_auth_* block the bootstrap emits (with sample
#    values) and assert it parses as valid HCL. Prefer terraform fmt (a real HCL
#    parser) when available; else fall back to a portable structural check that
#    every list element is quoted (no bare uuid survives quote-stripping).
gen_block="$(cat <<TFVARS
functions_auth_client_id          = "11111111-1111-1111-1111-111111111111"
functions_auth_tenant_id          = "22222222-2222-2222-2222-222222222222"
functions_auth_allowed_audiences  = ["api://11111111-1111-1111-1111-111111111111"]
functions_auth_allowed_client_app_ids = $(hcl_string_list "04b07795-8ddb-461a-bbee-02f9e1bf7b46 33333333-3333-3333-3333-333333333333")
TFVARS
)"
if command -v terraform >/dev/null 2>&1; then
  if printf '%s\n' "$gen_block" | terraform fmt - >/dev/null 2>&1; then
    ok "emitted functions_auth_* tfvars block is valid HCL (terraform fmt parsed it)"
  else
    bad "emitted functions_auth_* tfvars block is INVALID HCL (terraform fmt failed to parse it)"
  fi
else
  # Portable fallback: strip every "quoted" segment from the client-app-ids list;
  # anything alphanumeric left inside the brackets is an UNQUOTED (invalid) token.
  list_rhs="$(printf '%s\n' "$gen_block" | grep 'functions_auth_allowed_client_app_ids')"
  list_rhs="${list_rhs#*=}"
  residue="$(printf '%s' "$list_rhs" | sed 's/"[^"]*"//g')"
  if printf '%s' "$residue" | grep -Eq '[0-9A-Za-z_-]'; then
    bad "emitted client-app-ids list contains an UNQUOTED token (invalid HCL): residue='$residue'"
  else
    ok "emitted client-app-ids list has every element quoted (portable HCL check; terraform not installed)"
  fi
fi

# ===========================================================================
# F1 (round-2 hardening): hcl_string_list REJECTS non-UUID / HCL-breaking tokens
# ===========================================================================
# Quoting alone is not enough — a malformed client-app id (embedded quote, space,
# or a non-UUID token) must FAIL LOUD rather than be emitted as (broken) HCL. The
# renderer validates every token as a bare GUID (assert_uuid) and dies otherwise.
# Run each rejecting call in a SUBSHELL so die's `exit 1` cannot abort the runner.
if (hcl_string_list "not-a-uuid" SMOKE_TEST_CLIENT_IDS >/dev/null 2>&1); then
  bad "hcl_string_list must REJECT a non-UUID token (emitted a value instead of dying)"
else ok "hcl_string_list rejects a non-UUID token (fail-loud)"; fi
if (hcl_string_list '11111111-1111-1111-1111-11111111111"' SMOKE_TEST_CLIENT_IDS >/dev/null 2>&1); then
  bad "hcl_string_list must REJECT a token containing a quote (HCL-breaking)"
else ok "hcl_string_list rejects a token containing an embedded quote"; fi
if (hcl_string_list "04b07795-8ddb-461a-bbee-02f9e1bf7b46 not a uuid" X >/dev/null 2>&1); then
  bad "hcl_string_list must REJECT a space-split non-UUID token"
else ok "hcl_string_list rejects a space-embedded non-UUID token"; fi
# The happy path (valid GUIDs) still renders a quoted HCL list.
if [ "$(hcl_string_list '04b07795-8ddb-461a-bbee-02f9e1bf7b46')" = '["04b07795-8ddb-461a-bbee-02f9e1bf7b46"]' ]; then
  ok "hcl_string_list still renders valid GUIDs as a quoted HCL list"
else bad "hcl_string_list must still render valid GUIDs"; fi
# assert_uuid is the shared validator (used by the preauth loop too).
if (assert_uuid "not-a-uuid" X 2>/dev/null); then
  bad "assert_uuid must reject a non-UUID"
else ok "assert_uuid rejects a non-UUID token"; fi
if assert_uuid "04b07795-8ddb-461a-bbee-02f9e1bf7b46" X 2>/dev/null; then
  ok "assert_uuid accepts a bare GUID"
else bad "assert_uuid must accept a bare GUID"; fi

# ===========================================================================
# F3 (round-2): az discovery distinguishes NOT-FOUND from a REAL error
# ===========================================================================
# A blanket `|| true` on a discovery/list/show collapses a transient Azure error
# (auth / throttling / network) into an empty result, so a create-if-absent caller
# wrongly proceeds to CREATE. The az_discover helper captures exit status
# SEPARATELY and dies on a non-zero exit; assert it exists and is wired in.
if grep -q '^az_discover()' "$BOOT"; then
  ok "az_discover helper exists (distinguishes absent from real error)"
else bad "bootstrap must define an az_discover helper (distinguish absent from error)"; fi
# az_discover behaves: clean exit passes stdout through; non-zero exit dies.
if [ "$(az_discover "clean" printf 'hello')" = "hello" ]; then
  ok "az_discover passes through stdout on a clean exit"
else bad "az_discover must pass through stdout on a clean (exit-0) discovery"; fi
if (az_discover "boom" bash -c 'exit 3' >/dev/null 2>&1); then
  bad "az_discover must die on a non-zero discovery exit"
else ok "az_discover dies on a non-zero discovery exit (real error, not absence)"; fi
# The create-if-absent discoveries route through az_discover, not `|| true`.
if grep -q 'az_discover .*az ad app list' "$BOOT"; then
  ok "AAD app discovery routes through az_discover"
else bad "AAD app discovery must route through az_discover"; fi
# SP discovery uses `sp list --filter` (absent = empty/exit-0) — az_discover is on
# the preceding continuation line — and NEVER `sp show` (which returns non-zero for
# not-found and so can't distinguish absence from a real error).
if grep -q "az ad sp list --filter \"appId eq" "$BOOT" && ! grep -q 'az ad sp show' "$BOOT"; then
  ok "service-principal discovery uses 'sp list --filter' (absent = empty/exit-0), no 'sp show'"
else bad "SP discovery must use 'az ad sp list --filter' (not 'sp show', which can't distinguish absent from error)"; fi
# No blanket `|| true` may remain on these discovery calls (the masking hazard).
for pat in 'az ad app list .*\|\| true' \
           'az ad sp show .*\|\| true' \
           'az ad app federated-credential list .*\|\| true' \
           'az role assignment list .*\|\| true' ; do
  if grep -Eq "$pat" "$BOOT"; then
    bad "blanket '|| true' still masks a real error on discovery: /$pat/"
  else ok "no blanket '|| true' masking on discovery: /$pat/"; fi
done

# ===========================================================================
# F2 (round-2): every `az ad sp create` FAILS LOUD (|| die) — no phantom success
# ===========================================================================
# Each service-principal create must be paired with `|| die` (the die is on the
# continuation line for the `x="$(...)" \` form), so a genuine create failure
# aborts with a clear message instead of a bare success line after a failed create.
sp_create_lines="$(grep -c 'az ad sp create' "$BOOT" || true)"
sp_create_guarded="$(grep -A2 'az ad sp create' "$BOOT" | grep -c '|| die' || true)"
if [ "${sp_create_lines:-0}" -ge 3 ] && [ "${sp_create_guarded:-0}" -eq "${sp_create_lines:-0}" ]; then
  ok "every 'az ad sp create' is guarded by || die (${sp_create_guarded}/${sp_create_lines} fail-loud)"
else bad "each 'az ad sp create' must fail loud (|| die); guarded=${sp_create_guarded} total=${sp_create_lines}"; fi
# The AAD app creates are likewise fail-loud (no phantom appId after a failed
# create). -A2 covers the dev-API create, whose `|| die` is two lines down (the
# --sign-in-audience flag is on the intervening continuation line).
app_create_lines="$(grep -c 'az ad app create' "$BOOT" || true)"
app_create_guarded="$(grep -A2 'az ad app create' "$BOOT" | grep -c '|| die' || true)"
if [ "${app_create_lines:-0}" -ge 3 ] && [ "${app_create_guarded:-0}" -eq "${app_create_lines:-0}" ]; then
  ok "every 'az ad app create' is guarded by || die (${app_create_guarded}/${app_create_lines} fail-loud)"
else bad "each 'az ad app create' must fail loud (|| die); guarded=${app_create_guarded} total=${app_create_lines}"; fi

# ===========================================================================
# F4 (round-3): `az … show` EXISTENCE checks distinguish NOT-FOUND from a REAL error
# ===========================================================================
# The same masked-error hazard as F3, but on the create-vs-skip EXISTENCE checks
# (storage account + per-env state container). A bare `if az … show; then … else
# <create>` fires the create branch for ANY non-zero exit (auth / throttle /
# network), not just genuine absence — so a real Azure error causes an erroneous
# create attempt. The resource_absent_or_die helper classifies the exit: a
# not-found signal (az exit 3, or a ResourceNotFound/ContainerNotFound marker) is
# ABSENT (create); any other non-zero is a REAL error (die).
if grep -q '^resource_absent_or_die()' "$BOOT"; then
  ok "resource_absent_or_die helper exists (distinguishes not-found from a real 'show' error)"
else bad "bootstrap must define resource_absent_or_die for 'az … show' existence checks"; fi

# BEHAVIOUR: exit 0 -> PRESENT (return non-zero, caller skips create).
if resource_absent_or_die "present" true; then
  bad "resource_absent_or_die must report PRESENT (non-absent) on a clean exit-0 show"
else ok "resource_absent_or_die reports present on exit-0 (caller skips create)"; fi
# az CLI not-found exit code 3 -> ABSENT (return 0, caller creates).
if resource_absent_or_die "absent-exit3" bash -c 'exit 3'; then
  ok "resource_absent_or_die reports ABSENT on az not-found exit 3 (caller creates)"
else bad "resource_absent_or_die must report absent on a not-found exit 3"; fi
# A ContainerNotFound marker on a NON-3 exit -> ABSENT (container show can exit 1).
if resource_absent_or_die "absent-marker" bash -c 'echo "ErrorCode:ContainerNotFound" >&2; exit 1'; then
  ok "resource_absent_or_die treats a ContainerNotFound marker (exit 1) as ABSENT"
else bad "resource_absent_or_die must treat a not-found marker as absent even on a non-3 exit"; fi
# A ResourceNotFound marker (storage account show) -> ABSENT.
if resource_absent_or_die "absent-rnf" bash -c 'echo "(ResourceNotFound) not found" >&2; exit 1'; then
  ok "resource_absent_or_die treats a ResourceNotFound marker as ABSENT"
else bad "resource_absent_or_die must treat a ResourceNotFound marker as absent"; fi
# A REAL error (non-3 exit, NO not-found marker) -> DIE (fail loud, not "absent").
# Run in a SUBSHELL so die's `exit 1` cannot abort the runner.
if (resource_absent_or_die "authfail" bash -c 'echo "(AuthorizationFailed) forbidden" >&2; exit 1' >/dev/null 2>&1); then
  bad "resource_absent_or_die must DIE on a real auth error, not treat it as absent"
else ok "resource_absent_or_die dies on a real auth error (not mistaken for absence)"; fi
# An unrecognized non-zero (e.g. a network exit 4, no marker) -> DIE.
if (resource_absent_or_die "netfail" bash -c 'exit 4' >/dev/null 2>&1); then
  bad "resource_absent_or_die must DIE on an unrecognized non-zero exit (real error)"
else ok "resource_absent_or_die dies on an unrecognized non-zero exit (real error)"; fi

# WIRING: the storage-account + state-container create-deciders route through the
# helper, and NO bare `if az storage … show` create-decider remains.
if grep -Eq 'resource_absent_or_die "storage account' "$BOOT" \
   && grep -A2 'resource_absent_or_die "storage account' "$BOOT" | grep -q 'az storage account show'; then
  ok "storage-account existence check routes through resource_absent_or_die"
else bad "storage-account create-vs-skip must route through resource_absent_or_die"; fi
if grep -Eq 'resource_absent_or_die "state container' "$BOOT" \
   && grep -A3 'resource_absent_or_die "state container' "$BOOT" | grep -q 'az storage container show'; then
  ok "state-container existence check routes through resource_absent_or_die"
else bad "state-container create-vs-skip must route through resource_absent_or_die"; fi
# No bare `if az storage … show` create-decider (treats every non-zero as absent).
if grep -Eq 'if az storage (account|container) show' "$BOOT"; then
  bad "a bare 'if az storage … show' create-decider remains (treats every non-zero as absent)"
else ok "no bare 'if az storage … show' create-decider (all route through resource_absent_or_die)"; fi

echo "-----------------------------------------"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
