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
