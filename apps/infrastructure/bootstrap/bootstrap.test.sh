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
# The old whole-account blob-role scope must be gone.
if grep -Eq -- '--scope[[:space:]]+"\$state_sa_id"' "$BOOT"; then
  bad "state blob role must NOT be scoped to the whole state account"
else ok "no whole-state-account blob-role grant"; fi

# --- Per-env state CONTAINERS (isolation): tfstate-<env> ---------------------
if grep -q 'state_container_for() { echo "tfstate-' "$BOOT"; then
  ok "per-environment state containers (tfstate-<env>)"
else bad "state containers must be per-environment (tfstate-<env>)"; fi

# --- #6: container create works with the operator's control-plane role ------
# The initial container create must use KEY auth (control-plane-fetched key),
# not a data-plane `--auth-mode login` that fails closed when the operator has
# no Storage Blob DATA role yet.
if grep -q 'az storage account keys list' "$BOOT" && grep -q -- '--auth-mode key --account-key' "$BOOT"; then
  ok "container create uses control-plane key auth (does not fail closed)"
else bad "container create must use control-plane key auth for the first run"; fi
# Ignore comment lines so the note documenting WHY login-auth was dropped
# doesn't self-trip this check.
if grep -vE '^[[:space:]]*#' "$BOOT" | grep -q -- '--auth-mode login'; then
  bad "container ops must not rely on data-plane --auth-mode login"
else ok "no data-plane --auth-mode login in bootstrap"; fi

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

echo "-----------------------------------------"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
