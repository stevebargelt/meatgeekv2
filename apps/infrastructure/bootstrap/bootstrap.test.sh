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
# container-scoped — and it must be a User-principal grant, not an SP grant. So
# expect EXACTLY ONE `--scope "$state_sa_id"`, tied to the operator (signed-in-user).
whole_acct_scopes="$(grep -Ec -- '--scope[[:space:]]+"\$state_sa_id"' "$BOOT" || true)"
if [ "${whole_acct_scopes:-0}" -eq 1 ] && grep -q 'signed-in-user' "$BOOT"; then
  ok "only the operator holds a whole-account blob grant (item 2); SP grants stay container-scoped"
else bad "the only whole-account blob-role grant may be the operator's (item 2); SP state grants must be container-scoped"; fi

# --- Per-env state CONTAINERS (isolation): tfstate-<env> ---------------------
if grep -q 'state_container_for() { echo "tfstate-' "$BOOT"; then
  ok "per-environment state containers (tfstate-<env>)"
else bad "state containers must be per-environment (tfstate-<env>)"; fi

# --- #item 2: no storage account key on the command line --------------------
# The container create/show must NOT pass the storage account key on argv (it
# would leak a live credential into process listings). No account key is fetched
# and no `--auth-mode key --account-key` call exists; container ops use AAD
# (`--auth-mode login`) instead, backed by an operator Storage Blob DATA grant.
# Ignore comment lines so the note explaining the fix doesn't self-trip.
if grep -vE '^[[:space:]]*#' "$BOOT" | grep -q -- '--account-key'; then
  bad "no storage account key may appear on the command line (leaks via argv)"
else ok "no storage account key on argv (no --account-key)"; fi
if grep -vE '^[[:space:]]*#' "$BOOT" | grep -q 'az storage account keys list'; then
  bad "bootstrap must not fetch a storage account key for container ops"
else ok "bootstrap does not fetch a storage account key"; fi
if grep -vE '^[[:space:]]*#' "$BOOT" | grep -q -- '--auth-mode login'; then
  ok "container ops use AAD data-plane auth (--auth-mode login), no secret on argv"
else bad "container ops must use --auth-mode login (no account key on argv)"; fi
# The operator gets a Storage Blob DATA role so --auth-mode login works, mirroring
# the per-env Storage Blob Data grants issued to the CI/deploy SPs.
if grep -q 'signed-in-user' "$BOOT" && grep -q -- '--role "Storage Blob Data Contributor"' "$BOOT"; then
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
# asserted above via CI_PLAN_ROLE default; here assert the DEPLOY identity is a
# publish role scoped to the Function App ALONE, never subscription-wide write.
if grep -q 'DEPLOY_APP_ROLE:-Website Contributor' "$BOOT"; then
  ok "deploy identity role defaults to Website Contributor (publish-scoped)"
else bad "deploy identity role must default to Website Contributor"; fi
if grep -q -- '--scope "$fa_id"' "$BOOT"; then
  ok "deploy publish role is scoped to the Function App id ONLY"
else bad "deploy publish role must be scoped to the Function App (\$fa_id), not subscription"; fi
# The deploy role must NOT be granted at a /subscriptions/ scope.
if grep -A2 -- '--role "$DEPLOY_APP_ROLE"' "$BOOT" | grep -q '/subscriptions/'; then
  bad "deploy publish role must not be granted at subscription scope"
else ok "no subscription-scoped grant for the deploy publish role"; fi
# Deploy identity's state access is READ-ONLY (Reader, not Contributor).
if grep -q -- '--role "Storage Blob Data Reader"' "$BOOT"; then
  ok "deploy identity gets Storage Blob Data READER on state (read-only)"
else bad "deploy identity must get read-only state access (Storage Blob Data Reader)"; fi
# Emits the client id the app-deploy job consumes.
if grep -q 'AZURE_APP_DEPLOY_CLIENT_ID' "$BOOT"; then
  ok "bootstrap emits AZURE_APP_DEPLOY_CLIENT_ID for the app-deploy job"
else bad "bootstrap must emit AZURE_APP_DEPLOY_CLIENT_ID"; fi
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

echo "-----------------------------------------"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
