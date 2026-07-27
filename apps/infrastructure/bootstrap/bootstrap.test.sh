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

# --- Least-privilege: which identity may hold which write role (MG-23) -------
# REVISED for MG-23. The old assertion here was "no Contributor/Owner grant
# ANYWHERE in bootstrap.sh". That became false the moment the dev INFRA-APPLY
# identity landed — it legitimately needs Contributor to apply Terraform. Simply
# deleting the assertion would have thrown away the invariant; instead it is
# re-stated with the qualifiers that actually matter: WHICH identity, and at
# WHICH scope.
#
# Owner and User Access Administrator remain forbidden EVERYWHERE — neither is
# ever the least-privilege answer here, and User Access Administrator in
# particular is the unconditioned superset of the conditioned RBAC-admin grant
# below, so accepting it would silently discard the entire ABAC condition.
if grep -Eq '"(Owner|User Access Administrator)"' "$BOOT"; then
  bad "no identity may be granted Owner or User Access Administrator (found a literal role grant)"
else ok "no Owner / User Access Administrator grant anywhere in bootstrap.sh"; fi
if grep -q 'CI_PLAN_ROLE:-Reader' "$BOOT"; then ok "CI plan role defaults to Reader"
else bad "CI plan role should default to Reader"; fi

# The apply identity's write role is stock Contributor, scoped to the dev RG.
[ "${INFRA_APPLY_ROLE:-}" = "Contributor" ] \
  && ok "infra-apply role is stock Contributor (not Owner, not a custom superset)" \
  || bad "INFRA_APPLY_ROLE must be Contributor (got '${INFRA_APPLY_ROLE:-}')"
[ "${DEV_WORKLOAD_RG:-}" = "meatgeek-v2-dev-rg" ] \
  && ok "infra-apply blast radius is meatgeek-v2-dev-rg" \
  || bad "DEV_WORKLOAD_RG must be meatgeek-v2-dev-rg (got '${DEV_WORKLOAD_RG:-}')"
# The blast-radius literal must itself survive the V1-safety guard.
if assert_v2_name "resource group" "${DEV_WORKLOAD_RG:-}" 2>/dev/null; then
  ok "the infra-apply workload RG passes assert_v2_name (V1-safety guard)"
else bad "DEV_WORKLOAD_RG must pass assert_v2_name"; fi
# The Contributor grant is scoped to the RG — NEVER to a subscription.
if grep -Eq 'rg_scope="/subscriptions/\$\{sub_id\}/resourceGroups/\$\{DEV_WORKLOAD_RG\}"' "$BOOT" \
   && grep -Eq 'ensure_role_assignment[[:space:]]+"\$sp_id"[[:space:]]+ServicePrincipal[[:space:]]+"\$INFRA_APPLY_ROLE"[[:space:]]+"\$rg_scope"' "$BOOT"; then
  ok "Contributor is granted ONLY at the dev resource-group scope"
else bad "the infra-apply Contributor grant must be scoped to /resourceGroups/\${DEV_WORKLOAD_RG}"; fi
# ...and the apply identity gets NO subscription-scoped grant of any kind. The
# ONLY subscription-scoped grant in this file is the plan identity's Reader.
sub_scoped_grants="$(sed -e ':a' -e '/\\$/N; s/\\\n/ /; ta' "$BOOT" \
  | grep -E '^[[:space:]]*ensure_(conditioned_)?role_assignment[[:space:]]' \
  | grep -F '"/subscriptions/${sub_id}"' || true)"
if [ "$(printf '%s' "$sub_scoped_grants" | grep -c 'CI_PLAN_ROLE' || true)" -eq 1 ] \
   && [ "$(printf '%s\n' "$sub_scoped_grants" | grep -c . || true)" -eq 1 ]; then
  ok "exactly ONE subscription-scoped grant exists and it is the plan identity's Reader"
else bad "the only subscription-scoped grant may be the plan identity's \$CI_PLAN_ROLE; found: ${sub_scoped_grants}"; fi

# ===========================================================================
# MG-23 round 5: the RECOVERY-APPROVAL environment is EXPLICIT, not auto-created
# ===========================================================================
# GitHub auto-creates an environment the first time a workflow references a name
# that does not exist, and an auto-created environment has NO protection rules.
# The recovery path's human-approval gate would then be a NO-OP that still reads
# like a gate in the workflow file. Bootstrap must create it explicitly WITH a
# required reviewer and VERIFY that protection.
[ "${RECOVERY_APPROVAL_ENVIRONMENT:-}" = "development-infra-apply-recovery" ] \
  && ok "the recovery-approval environment is named explicitly in bootstrap" \
  || bad "RECOVERY_APPROVAL_ENVIRONMENT must be development-infra-apply-recovery (got '${RECOVERY_APPROVAL_ENVIRONMENT:-}')"
# It is an APPROVAL-ONLY environment: nothing federates it, so it must NOT be in
# the OIDC federation list (that would mint trust for a human-only gate).
case " $GITHUB_ENVIRONMENTS " in
  *" ${RECOVERY_APPROVAL_ENVIRONMENT:-development-infra-apply-recovery} "*)
    bad "the recovery-approval environment must NOT be federated — it holds a human, not an identity";;
  *) ok "the recovery-approval environment is verified, not federated (no OIDC trust)";;
esac
# ===========================================================================
# D1/D2: the APPLY identity's EXACT grants and EXACTLY ONE federated credential
# ===========================================================================
# This is the identity that reaches Contributor on the dev resource group, so
# "what exactly does it hold" must be an assertion, not a comment. Both checks
# below are EXACT-SET checks: a contains-check would not notice a FOURTH grant
# or a SECOND federated credential quietly added later, which is precisely how
# a least-privilege identity stops being one.
apply_fn="$(awk '/^bootstrap_infra_apply_identity\(\)/{f=1} f{print} f&&/^}/{exit}' "$BOOT" \
  | grep -v '^[[:space:]]*#')"

# D1: exactly three role grants — Contributor @ RG, RBAC-Admin @ RG (CONDITIONED),
#     Storage Blob Data Contributor @ the tfstate-dev CONTAINER. Nothing else,
#     and in particular nothing at subscription scope and nothing touching Graph.
apply_grants="$(printf '%s\n' "$apply_fn" \
  | grep -E '^[[:space:]]*ensure_(conditioned_)?role_assignment[[:space:]]' \
  | sed 's/^[[:space:]]*//' | sed 's/[[:space:]]*\\$//')"
apply_grant_count="$(printf '%s\n' "$apply_grants" | grep -c '[^[:space:]]' || true)"
if [ "$apply_grant_count" -eq 3 ]; then
  ok "D1: the apply identity has EXACTLY 3 role grants (no fourth grant crept in)"
else bad "D1: the apply identity must have exactly 3 role grants, found ${apply_grant_count}: $(printf '%s' "$apply_grants" | tr '\n' '|')"; fi
if printf '%s\n' "$apply_grants" | grep -q 'ensure_role_assignment "\$sp_id" ServicePrincipal "\$INFRA_APPLY_ROLE" "\$rg_scope"'; then
  ok "D1: Contributor is granted at the dev-RG scope"
else bad "D1: the apply identity must hold \$INFRA_APPLY_ROLE at \$rg_scope"; fi
if printf '%s\n' "$apply_grants" | grep -q 'ensure_conditioned_role_assignment'; then
  ok "D1: RBAC-Admin is granted through the CONDITIONED helper"
else bad "D1: the apply identity's RBAC-Admin grant must go through ensure_conditioned_role_assignment"; fi
if printf '%s\n' "$apply_grants" | grep -q 'ensure_role_assignment "\$sp_id" ServicePrincipal "Storage Blob Data Contributor" "\$container_scope"'; then
  ok "D1: Storage Blob Data Contributor is granted at the CONTAINER scope only"
else bad "D1: the apply identity's state role must be container-scoped"; fi
# No subscription-scoped grant anywhere in the apply path (F18: no subscription
# scope is a load-bearing precondition of the whole threat model).
if printf '%s\n' "$apply_grants" | grep -q '"/subscriptions/\${sub_id}"'; then
  bad "D1: the apply identity must hold NO subscription-scoped grant (F18 closed escalation path)"
else ok "D1: the apply identity holds no subscription-scoped grant (F18)"; fi

# D2: EXACTLY ONE federated credential, to the apply environment, then pruned.
# The recovery environment is deliberately NOT federated — infra-apply-dev.yml's
# recovery_approval job binds it for its protection rules and performs no Azure
# login, so "federated only to the apply (+recovery) environment(s)" must NOT be
# misread as requiring a second credential. Do not "fix" this by adding one.
apply_creds="$(printf '%s\n' "$apply_fn" | grep -c 'ensure_federated_credential' || true)"
if [ "$apply_creds" -eq 1 ]; then
  ok "D2: the apply identity creates EXACTLY ONE federated credential"
else bad "D2: the apply identity must create exactly one federated credential (found ${apply_creds})"; fi
# The subject is built from a local `env` that is bound to INFRA_APPLY_ENVIRONMENT,
# so assert BOTH halves — the binding and the subject shape. Asserting only the
# subject string would pass if `env` were rebound to something else.
if printf '%s\n' "$apply_fn" | grep -q 'local env="\$INFRA_APPLY_ENVIRONMENT"'; then
  ok "D2: the apply identity's environment is bound to \$INFRA_APPLY_ENVIRONMENT"
else bad "D2: bootstrap_infra_apply_identity must bind env to \$INFRA_APPLY_ENVIRONMENT"; fi
if printf '%s\n' "$apply_fn" | grep -q 'subject="repo:\${GITHUB_REPO}:environment:\${env}"'; then
  ok "D2: the apply credential's subject resolves to repo:${GITHUB_REPO}:environment:${INFRA_APPLY_ENVIRONMENT}"
else bad "D2: the apply credential subject must be repo:\${GITHUB_REPO}:environment:\${env}"; fi
if printf '%s\n' "$apply_fn" | grep -q 'prune_unexpected_federated_credentials'; then
  ok "D2: the apply identity prunes every credential outside its expected set"
else bad "D2: the apply identity must prune unexpected federated credentials"; fi
case " $GITHUB_ENVIRONMENTS " in
  *" ${RECOVERY_APPROVAL_ENVIRONMENT:-development-infra-apply-recovery} "*)
    bad "D2: the recovery environment must NOT be federated — it holds a human, not an identity";;
  *) ok "D2: the recovery environment stays approval-only and unfederated";;
esac

# ===========================================================================
# D7: no BLIND identity selection — 0 or >1 matches must not be guessed through
# ===========================================================================
# Display names are not unique in Entra ID. A `[0]` projection silently picks one
# of N matches in an order Azure does not guarantee, and the bootstrap would then
# attach federated trust and RG-scoped grants to the WRONG service principal and
# report success.
if grep -q '^az_discover_unique()' "$BOOT"; then
  ok "D7: az_discover_unique exists"
else bad "D7: bootstrap must define az_discover_unique"; fi
# The rule is about IDENTITY/OBJECT lookups, where `[0]` blindly picks one of N
# matches. There are exactly TWO legitimate `[0]` projections, and they are the
# two READ-BACKS in ensure_conditioned_role_assignment:
#
#   --query "[0].condition" -o tsv   the ABAC condition, for the drift compare
#   --query "[0]" -o json            the whole assignment object, for the
#                                    IN-PLACE condition update (which PUTs the
#                                    existing object with one field changed)
#
# Both are legitimate for the SAME reason: uniqueness was ALREADY proven, on the
# line above, by an az_discover_unique `[].id` lookup that dies on >1 match. So
# `[0]` there selects the one assignment that lookup already validated, not an
# arbitrary one of N. Neither may go through the line-counting guard itself — a
# condition is a multi-line VALUE and a JSON object is a multi-line DOCUMENT, and
# the guard would count their lines as N matching objects (see the multi-line
# reconcile tests further down).
#
# TWO INDEPENDENT ASSERTIONS, because shape alone is not enough: a `[0]` of an
# allowed SHAPE dropped somewhere with no uniqueness proof above it would still
# be a blind pick. So require (a) every `[0]` projection to be one of those two
# shapes — a `[0].id` / `[0].appId` / `[0].name` still fails — and (b) every one
# of them to live INSIDE ensure_conditioned_role_assignment, which is where the
# proof is.
zeroth_projections="$(grep -nE -- "--query [\"'][[]0[]]" "$BOOT" || true)"
disallowed_zeroth="$(printf '%s\n' "$zeroth_projections" \
  | grep -v '^[[:space:]]*$' \
  | grep -vE -- '--query "\[0\]\.condition" -o tsv' \
  | grep -vE -- '--query "\[0\]" -o json' || true)"
if [ -n "$disallowed_zeroth" ]; then
  bad "D7: no first-element projection may remain for object lookups — every identity lookup must project ALL matches so ambiguity is visible. Offending: ${disallowed_zeroth}"
else ok "D7: every first-element projection is one of the two uniqueness-proven read-back shapes"; fi

# (b) LOCATION: all of them are inside ensure_conditioned_role_assignment.
d7_cond_fn="$(awk '/^ensure_conditioned_role_assignment\(\)/{f=1} f{print} f&&/^}/{exit}' "$BOOT")"
d7_total="$(printf '%s\n' "$zeroth_projections" | grep -c . || true)"
d7_in_fn="$(printf '%s\n' "$d7_cond_fn" | grep -cE -- "--query [\"'][[]0[]]" || true)"
if [ "$d7_total" -eq "$d7_in_fn" ]; then
  ok "D7: all ${d7_total} first-element projections sit inside ensure_conditioned_role_assignment (where uniqueness is proven)"
else bad "D7: a first-element projection escaped ensure_conditioned_role_assignment — ${d7_total} in the file but only ${d7_in_fn} in the function, so at least one has no uniqueness proof above it"; fi
# BEHAVIOURAL: two matches must DIE, not silently select one.
UNIQ_LOG="$(mktemp)"
az() { printf 'id-one\nid-two\n'; }
if ( az_discover_unique "duplicate test app" az ad app list --display-name X --query '[].appId' -o tsv ) >"$UNIQ_LOG" 2>&1; then
  bad "D7: az_discover_unique must DIE when more than one object matches (it returned: $(cat "$UNIQ_LOG"))"
else
  if grep -q 'AMBIGUOUS' "$UNIQ_LOG"; then
    ok "D7: az_discover_unique dies on >1 match, naming the duplicates"
  else bad "D7: the >1-match failure must name the ambiguity (got: $(cat "$UNIQ_LOG"))"; fi
fi
# ...and ZERO matches is still a legitimate "absent" that returns empty, so
# create-if-absent callers keep working.
az() { printf ''; }
if [ -z "$(az_discover_unique "absent test app" az ad app list --display-name X --query '[].appId' -o tsv)" ]; then
  ok "D7: az_discover_unique returns empty for zero matches (absent -> caller creates)"
else bad "D7: zero matches must return empty, not an error"; fi
# ...and exactly one match returns that value.
az() { printf 'only-one\n'; }
if [ "$(az_discover_unique "single test app" az ad app list --display-name X --query '[].appId' -o tsv)" = "only-one" ]; then
  ok "D7: az_discover_unique returns the single match unchanged"
else bad "D7: a single match must be returned verbatim"; fi
unset -f az
rm -f "$UNIQ_LOG"

# ===========================================================================
# D8: create paths use the RETURNED id, never a re-lookup by display name
# ===========================================================================
# The other half of blocker 2. `az ad app create --query appId` and
# `az ad sp create --query id` return the id of the object just created; using it
# directly is immune to both duplicate display names AND Entra replication lag (a
# re-list immediately after a create can legitimately return nothing). This half
# was already correct — it is asserted here so it cannot regress silently.
if grep -q 'az ad app create --display-name "\$app_name" --query appId -o tsv' "$BOOT"; then
  ok "D8: app creation uses the appId the CREATE returned"
else bad "D8: app creation must use the appId returned by az ad app create"; fi
if grep -q 'az ad sp create --id "\$app_id" --query id -o tsv' "$BOOT"; then
  ok "D8: SP creation uses the object id the CREATE returned"
else bad "D8: SP creation must use the id returned by az ad sp create"; fi
# No create is immediately followed by a display-name re-lookup of the same thing.
if grep -A3 'az ad app create --display-name' "$BOOT" | grep -q 'az ad app list --display-name'; then
  bad "D8: a create must not be followed by a display-name re-lookup (replication lag + duplicate names)"
else ok "D8: no create path re-lists by display name afterwards"; fi

# --- D5: BOTH environments are explicitly created + verified ----------------
# Previously only the recovery environment was created, and `development-infra-
# apply` — the one that actually reaches Contributor on the dev RG — was left to
# GitHub auto-creation entirely. Both now go through one generalized helper.
if grep -q '^ensure_deployment_environment()' "$BOOT"; then
  ok "D5: bootstrap defines ensure_deployment_environment"
else bad "D5: bootstrap must define ensure_deployment_environment"; fi
if grep -qE '^[[:space:]]+ensure_deployment_environment "\$INFRA_APPLY_ENVIRONMENT" no$' "$BOOT"; then
  ok "D5: main() creates+verifies the APPLY environment with NO required reviewer"
else bad "D5: main() must call ensure_deployment_environment \"\$INFRA_APPLY_ENVIRONMENT\" no"; fi
if grep -qE '^[[:space:]]+ensure_deployment_environment "\$RECOVERY_APPROVAL_ENVIRONMENT" yes$' "$BOOT"; then
  ok "D5: main() creates+verifies the RECOVERY environment WITH a required reviewer"
else bad "D5: main() must call ensure_deployment_environment \"\$RECOVERY_APPROVAL_ENVIRONMENT\" yes"; fi

# Comment lines stripped: this function's comments describe every control it
# implements, so grepping the prose would green-light a body with the control
# deleted.
env_fn="$(awk '/^ensure_deployment_environment\(\)/{f=1} f{print} f&&/^}/{exit}' "$BOOT" \
  | grep -v '^[[:space:]]*#')"
# It must CREATE (PUT is create-or-update, so it also repairs an environment
# GitHub already auto-created without protection) ...
if printf '%s' "$env_fn" | grep -q -- '--method PUT'; then
  ok "D5: the environment is created/repaired via an explicit PUT"
else bad "D5: ensure_deployment_environment must PUT the environment (create-or-update)"; fi
# ...pin deployments to main ONLY, for BOTH environments...
if printf '%s' "$env_fn" | grep -q 'deployment-branch-policies' \
   && printf '%s' "$env_fn" | grep -q 'name=main'; then
  ok "D5: a main-only custom deployment branch policy is applied"
else bad "D5: ensure_deployment_environment must add a main-only deployment branch policy"; fi
# ...verified by READ-BACK as EXACTLY ONE policy named main (a PUT that returned
# 200 is not evidence, and two policies is not "main only").
if printf '%s' "$env_fn" | grep -q 'EXACTLY ONE deployment branch policy'; then
  ok "D5: the branch policy is read back and required to be exactly one named 'main'"
else bad "D5: ensure_deployment_environment must verify exactly one 'main' branch policy by read-back"; fi
# ...with a REQUIRED REVIEWER on the recovery path only...
if printf '%s' "$env_fn" | grep -q 'reviewers'; then
  ok "D5: a required reviewer is configured when requested"
else bad "D5: ensure_deployment_environment must configure a required reviewer for want_reviewer=yes"; fi
# ...and — the check the design implies but nothing used to assert — the APPLY
# environment must have NO reviewer. A stray reviewer there silently converts
# automatic reconciliation into a manual one while the YAML still reads
# automatic, so reconciliation just stops.
if printf '%s' "$env_fn" | grep -q 'must have NONE'; then
  ok "D5: the AUTOMATIC apply environment is verified to have NO required reviewer"
else bad "D5: ensure_deployment_environment must FAIL when the automatic apply environment carries a required reviewer"; fi
# An empty reviewer id must FAIL rather than produce an approval gate that
# approves everything.
if printf '%s' "$env_fn" | grep -q 'EMPTY GitHub reviewer id'; then
  ok "D5: an empty/unresolvable reviewer id fails loud (no reviewer-less approval gate)"
else bad "D5: ensure_deployment_environment must refuse to create an approval environment with no reviewer"; fi
# A verification that cannot run is NOT a pass.
if grep -q 'required_reviewers' "$BOOT"; then
  ok "D5: the protection rules are READ BACK from the live API (required_reviewers)"
else bad "D5: bootstrap must read back the live required_reviewers protection rule"; fi

# --- D6: BOTH statuses gate the DEV_TF_BACKEND_READY banner -----------------
# Reporting only one status would let the other ship unprotected behind a green
# summary.
if grep -q 'APPLY_ENV_STATUS' "$BOOT" && grep -q 'RECOVERY_ENV_STATUS' "$BOOT" \
   && grep -q 'BLOCKING PRE-ACTIVATION CHECK NOT SATISFIED' "$BOOT"; then
  ok "D6: both environment statuses are recorded and surfaced as a BLOCKING pre-activation check"
else bad "D6: bootstrap must record APPLY_ENV_STATUS and RECOVERY_ENV_STATUS and block activation on them"; fi
if grep -qE 'if \[ "\$APPLY_ENV_STATUS" != "PROTECTED" \] \|\| \[ "\$RECOVERY_ENV_STATUS" != "PROTECTED" \]' "$BOOT"; then
  ok "D6: the activation banner requires BOTH statuses to be PROTECTED"
else bad "D6: the DEV_TF_BACKEND_READY banner must require BOTH APPLY_ENV_STATUS and RECOVERY_ENV_STATUS to be PROTECTED"; fi
if printf '%s' "$env_fn" | grep -q 'DEV_TF_BACKEND_READY'; then
  ok "D6: the failure path names DEV_TF_BACKEND_READY as the thing that must not be set"
else bad "D6: the environment failure path must state that DEV_TF_BACKEND_READY must not be set true"; fi

# --- The RBAC-administrator grant is CONDITIONED, always (MG-23 F7/F11) ------
# An UNCONDITIONED "Role Based Access Control Administrator" at RG scope lets the
# apply identity grant itself (or anything else) any role in the RG — i.e. it is
# a self-escalation primitive that makes the Contributor scoping decorative. So
# that role must be reachable ONLY through the conditioned helper.
[ "${INFRA_APPLY_RBAC_ROLE:-}" = "Role Based Access Control Administrator" ] \
  && ok "the RBAC-admin role name is the stock built-in role" \
  || bad "INFRA_APPLY_RBAC_ROLE must be 'Role Based Access Control Administrator'"
if grep -Eq 'ensure_conditioned_role_assignment[[:space:]]+"\$sp_id"[[:space:]]+ServicePrincipal' "$BOOT" \
   && grep -Eq '"\$INFRA_APPLY_RBAC_ROLE"[[:space:]]+"\$rg_scope"[[:space:]]+"\$condition"' "$BOOT"; then
  ok "RBAC-admin is granted via ensure_conditioned_role_assignment with a condition"
else bad "the RBAC-admin grant must go through ensure_conditioned_role_assignment with a condition argument"; fi
# It must NEVER be granted through the UNCONDITIONED helper.
if sed -e ':a' -e '/\\$/N; s/\\\n/ /; ta' "$BOOT" \
   | grep -E '^[[:space:]]*ensure_role_assignment[[:space:]]' | grep -q 'INFRA_APPLY_RBAC_ROLE'; then
  bad "the RBAC-admin role must never be granted via the UNCONDITIONED ensure_role_assignment"
else ok "RBAC-admin never flows through the unconditioned role-assignment helper"; fi

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

# ===========================================================================
# MG-23 F8: ONE GitHub Environment per IDENTITY (the subject/privilege map)
# ===========================================================================
# Before MG-23, all three dev identities federated the IDENTICAL subject
# `repo:<repo>:environment:development`, and which one a job assumed was decided
# ONLY by which client-id string the job passed to azure/login. A one-line
# client-id edit merged to main therefore silently upgraded the read-only plan
# job to a full Contributor apply, with no environment protection rule ever
# consulted. The fix is one environment per identity, so the environment's
# protection rules are what decide who may assume which privilege. These
# assertions are what stop that collapsing back.
# D3: EXACTLY these three environments are FEDERATED — asserted as an exact SET,
# not a contains-check. A contains-check would not notice a re-added dev plan
# environment, which is precisely the thing this re-scope removed.
#
# THREE FEDERATED, FOUR TOTAL — the two counts are not in conflict.
# GITHUB_ENVIRONMENTS drives OIDC FEDERATION, so it lists only environments that
# back an identity. `development-infra-apply-recovery` is the fourth environment
# and is deliberately ABSENT here: it is approval-only, holds no federated
# credential, and is bound by the recovery_approval job purely for its protection
# rules (that job has no id-token permission and never calls azure/login).
# Adding it to this list would MINT IT AN IDENTITY — the opposite of its purpose.
# See the topology table in docs/infrastructure/mg23-live-acceptance.md.
expected_envs="development development-infra-apply production"
actual_envs="$(printf '%s\n' $GITHUB_ENVIRONMENTS | sort | tr '\n' ' ' | sed 's/ $//')"
if [ "$actual_envs" = "$expected_envs" ]; then
  ok "D3: GITHUB_ENVIRONMENTS is EXACTLY {development, development-infra-apply, production}"
else bad "D3: GITHUB_ENVIRONMENTS must be exactly '${expected_envs}' (got '${actual_envs}')"; fi
case " $GITHUB_ENVIRONMENTS " in
  *" dev "*) bad "GITHUB_ENVIRONMENTS must not federate bare 'dev' (workflows use long names; subjects would never match)";;
  *) ok "no stale bare-'dev' GitHub Environment federated";;
esac
# There is NO dev plan identity and NO dev plan environment: PR validation is
# credentialless. A re-added one would restore a PR-reachable path to tfstate-dev
# and its live IoT Hub SAS keys.
case " $GITHUB_ENVIRONMENTS $PLAN_IDENTITY_ENVIRONMENTS " in
  *"-infra-plan "*) bad "D3: no dev plan environment may be federated — PR validation is credentialless (re-adding one restores a PR-reachable path to tfstate-dev)";;
  *) ok "D3: no dev plan environment is federated (PR validation holds no identity)";;
esac

# D3-ENFORCED (MG-23 round-6 fix): the assertions above are only worth anything
# if GITHUB_ENVIRONMENTS reflects what the federation code actually does. It used
# to be a hand-written literal that NO code expanded — so this whole block
# described a map the bootstrap did not build, and would have kept passing while
# the real map drifted. It is now DERIVED from the three variables the identity
# functions read, and CONSUMED by a fail-closed check.
if grep -Eq '^GITHUB_ENVIRONMENTS="\$\(' "$BOOT"; then
  ok "D3: GITHUB_ENVIRONMENTS is DERIVED from the variables federation actually reads (not a drifting literal)"
else bad "D3: GITHUB_ENVIRONMENTS must be derived from PLAN_IDENTITY_ENVIRONMENTS / APP_DEPLOY_ENVIRONMENT / INFRA_APPLY_ENVIRONMENT, not written out by hand"; fi
if grep -q '^assert_federated_environment_map()' "$BOOT" \
   && grep -Eq '^[[:space:]]+assert_federated_environment_map$' "$BOOT"; then
  ok "D3: assert_federated_environment_map exists AND is called from main (the map is enforced, not just declared)"
else bad "D3: the environment/subject map must be enforced by a check that main actually calls"; fi

# BEHAVIOURAL: a COLLISION (two identities on one environment) must DIE. This is
# the F8 defect itself — identities sharing a subject are selected only by the
# client id a job passes — so the check has to bite, not just exist.
if ( APP_DEPLOY_ENVIRONMENT="$INFRA_APPLY_ENVIRONMENT" \
     assert_federated_environment_map >/dev/null 2>&1 ); then
  bad "D3: two identities federating the SAME environment must DIE (that is the F8 collision)"
else ok "D3: an environment-map COLLISION fails closed (F8 cannot silently return)"; fi
# ...and the un-collided real map passes, so the check is not vacuously failing.
if ( assert_federated_environment_map >/dev/null 2>&1 ); then
  ok "D3: the shipped environment map passes its own collision check"
else bad "D3: the shipped environment map must pass assert_federated_environment_map"; fi
# An EMPTY environment name would build the subject 'repo:<repo>:environment:'.
if ( INFRA_APPLY_ENVIRONMENT="" assert_federated_environment_map >/dev/null 2>&1 ); then
  bad "D3: an EMPTY federated environment name must DIE (it yields a subject matching nothing, or something unintended)"
else ok "D3: an empty federated environment name fails closed"; fi
# The RECOVERY environment holds a human; federating it would make it a machine.
if ( GITHUB_ENVIRONMENTS="$GITHUB_ENVIRONMENTS $RECOVERY_APPROVAL_ENVIRONMENT" \
     assert_federated_environment_map >/dev/null 2>&1 ); then
  bad "D3: federating the RECOVERY approval environment must DIE (it is the human gate on a destructive apply)"
else ok "D3: the recovery approval environment is refused federation (stays human-only)"; fi

# The PLAN identity list is PROD ONLY. The prod plan identity survives because
# infra-deploy-prod.yml still logs in as it under `production`.
if [ "$PLAN_IDENTITY_ENVIRONMENTS" = "production" ]; then
  ok "D3: PLAN_IDENTITY_ENVIRONMENTS is exactly 'production' (no dev plan identity)"
else bad "D3: PLAN_IDENTITY_ENVIRONMENTS must be exactly 'production' (got '${PLAN_IDENTITY_ENVIRONMENTS}')"; fi
case " $PLAN_IDENTITY_ENVIRONMENTS " in
  *" development "*) bad "the plan identity must NOT federate the bare 'development' environment (that is the app-deploy identity's; sharing it re-opens the F8 privilege collapse)";;
  *) ok "plan identity does NOT federate the bare 'development' environment";;
esac
case " $PLAN_IDENTITY_ENVIRONMENTS " in
  *" production "*) ok "plan identity federates 'production' (prod plan/read)";;
  *) bad "the prod plan identity must federate 'production'";;
esac
# The APPLY identity federates its own environment and nothing else...
[ "${INFRA_APPLY_ENVIRONMENT:-}" = "development-infra-apply" ] \
  && ok "apply identity federates 'development-infra-apply'" \
  || bad "INFRA_APPLY_ENVIRONMENT must be development-infra-apply (got '${INFRA_APPLY_ENVIRONMENT:-}')"
case " $PLAN_IDENTITY_ENVIRONMENTS " in
  *" ${INFRA_APPLY_ENVIRONMENT:-development-infra-apply} "*)
    bad "the apply environment must NOT also be federated to the plan identity (a plan job could then apply)";;
  *) ok "the apply environment is federated to the apply identity ALONE";;
esac
# ...and the bare `development` environment belongs to the APP-DEPLOY identity alone.
[ "${APP_DEPLOY_ENVIRONMENT:-}" = "development" ] \
  && ok "app-deploy identity federates the bare 'development' environment" \
  || bad "APP_DEPLOY_ENVIRONMENT must be development (got '${APP_DEPLOY_ENVIRONMENT:-}')"
if [ "${APP_DEPLOY_ENVIRONMENT:-}" != "${INFRA_APPLY_ENVIRONMENT:-}" ]; then
  ok "app-deploy and infra-apply federate DIFFERENT environments (no shared subject)"
else bad "app-deploy and infra-apply must not share a GitHub Environment"; fi
# The TWO remaining dev identities must resolve to two DISTINCT OIDC subjects.
dev_subjects="$(printf '%s\n%s\n' \
  "repo:${GITHUB_REPO}:environment:${INFRA_APPLY_ENVIRONMENT}" \
  "repo:${GITHUB_REPO}:environment:${APP_DEPLOY_ENVIRONMENT}" | sort -u | grep -c .)"
[ "$dev_subjects" -eq 2 ] \
  && ok "the two dev identities (apply, app-deploy) present two DISTINCT OIDC subjects" \
  || bad "the dev apply / app-deploy identities must present two distinct subjects (got $dev_subjects)"

# --- F16: GITHUB_REPO is a committed constant, not env-overridable ----------
# The OIDC trust ROOT. An inherited GITHUB_REPO would re-point every identity's
# federation at another repository with nothing but a log line to show for it.
if grep -Eq 'GITHUB_REPO="\$\{GITHUB_REPO:-' "$BOOT"; then
  bad "GITHUB_REPO must NOT read an env override (it is the OIDC trust root)"
else ok "GITHUB_REPO is a committed constant, not env-overridable (F16)"; fi
if grep -Eq '^GITHUB_REPO="[A-Za-z0-9._-]+/[A-Za-z0-9._-]+"$' "$BOOT"; then
  ok "GITHUB_REPO is a literal owner/repo constant"
else bad "GITHUB_REPO must be a literal owner/repo constant"; fi
# The environment map is likewise not env-overridable.
for v in GITHUB_ENVIRONMENTS STATE_ENVIRONMENTS PLAN_IDENTITY_ENVIRONMENTS; do
  if grep -Eq "${v}=\"\\\$\\{${v}:-" "$BOOT"; then
    bad "${v} must NOT read an env override (an injected environment mints an unreviewed trust)"
  else ok "${v} is a committed constant, not env-overridable"; fi
done

# --- State containers stay exactly tfstate-dev / tfstate-prod ---------------
# GITHUB_ENVIRONMENTS used to drive BOTH federation and the state-container loop.
# Extending it for MG-23 without splitting the two would have created containers
# named after a long GitHub-Environment name, silently diverging from the committed
# backend-{dev,prod}.hcl. STATE_ENVIRONMENTS is that split.
[ "$STATE_ENVIRONMENTS" = "development production" ] \
  && ok "state containers are driven by STATE_ENVIRONMENTS (development production) only" \
  || bad "STATE_ENVIRONMENTS must be exactly 'development production' (got '$STATE_ENVIRONMENTS')"
if grep -q 'for env in $STATE_ENVIRONMENTS; do' "$BOOT"; then
  ok "the state-container loop iterates STATE_ENVIRONMENTS, not GITHUB_ENVIRONMENTS"
else bad "the state-container loop must iterate STATE_ENVIRONMENTS (else new GitHub Environments mint bogus containers)"; fi
if grep -q 'for env in $PLAN_IDENTITY_ENVIRONMENTS; do' "$BOOT"; then
  ok "the plan-identity loop iterates PLAN_IDENTITY_ENVIRONMENTS"
else bad "the plan-identity loop must iterate PLAN_IDENTITY_ENVIRONMENTS"; fi
# Every state environment resolves to exactly one of the two committed containers.
state_containers="$(for e in $STATE_ENVIRONMENTS; do state_container_for "$e"; done | sort -u | tr '\n' ' ')"
[ "$state_containers" = "tfstate-dev tfstate-prod " ] \
  && ok "state containers are exactly tfstate-dev + tfstate-prod (backend-{dev,prod}.hcl)" \
  || bad "state containers must be exactly 'tfstate-dev tfstate-prod' (got '$state_containers')"
# ...and EVERY federated GitHub Environment maps onto one of them, so no
# environment can ever imply a third container.
for e in $GITHUB_ENVIRONMENTS; do
  case "$(state_container_for "$e")" in
    tfstate-dev|tfstate-prod) ok "D4: GitHub Environment '$e' maps to a committed state container ($(state_container_for "$e"))" ;;
    *) bad "D4: GitHub Environment '$e' maps to an UNKNOWN state container '$(state_container_for "$e")'" ;;
  esac
done
[ "$(tf_env_for development)" = "dev" ]  && ok "tf_env_for development -> dev"  || bad "tf_env_for development must map to dev"
[ "$(tf_env_for production)"  = "prod" ] && ok "tf_env_for production -> prod" || bad "tf_env_for production must map to prod"

# CROSS-CHECK the actual workflow YAML: every `environment:` a job declares
# (which becomes the presented OIDC subject repo:<repo>:environment:<env>) MUST
# be a GitHub Environment the bootstrap federates. This is the anti-drift gate.
# GLOBBED, not a hardcoded file list: a NEW workflow that declares an
# unfederated environment is exactly the drift this catches, and a hardcoded list
# would silently exempt it. (infra-apply-dev.yml, added by MG-23, is picked up
# automatically for the same reason.)
WF_DIR="$DIR/../../../.github/workflows"
if [ -d "$WF_DIR" ]; then
  # Associate each environment with the JOB that declares it, and with whether
  # that job actually authenticates to Azure. The rule is per-job, because an
  # OIDC subject only exists for a job that mints a token:
  #   * a job that calls azure/login MUST bind a FEDERATED environment, or its
  #     presented subject matches no credential and auth fails closed;
  #   * a job that never calls azure/login (an approval-only gate, e.g. the
  #     recovery path's manual deployment approval) must bind an environment that
  #     is NOT federated — a credential for an environment nothing authenticates
  #     from is an unused trust path, which is worse than no environment at all.
  # Comment lines are stripped first so prose mentioning azure/login or an
  # environment name cannot flip either verdict.
  wf_pairs="$(
    for wf in "$WF_DIR"/*.yml; do
      [ -f "$wf" ] || continue
      grep -vE '^[[:space:]]*#' "$wf" | awk -v file="$(basename "$wf")" '
        function emit() { if (job != "" && env != "") printf "%s|%s|%s|%d\n", file, job, env, azure }
        /^jobs:/ { injobs = 1; next }
        injobs && /^  [A-Za-z0-9_-]+:[[:space:]]*$/ {
          emit(); job = $1; sub(/:$/, "", job); env = ""; azure = 0; next
        }
        injobs && /^[[:space:]]*environment:[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*$/ { env = $2 }
        injobs && /azure\/login/ { azure = 1 }
        END { emit() }
      '
    done
  )"
  [ -n "$wf_pairs" ] || bad "no workflow environment: declarations found to cross-check"
  while IFS='|' read -r wf_file wf_job e is_azure; do
    [ -z "$e" ] && continue
    federated=0
    case " $GITHUB_ENVIRONMENTS " in *" $e "*) federated=1 ;; esac
    if [ "$is_azure" = "1" ]; then
      [ "$federated" -eq 1 ] \
        && ok "${wf_file}:${wf_job} authenticates to Azure in '$e', which the bootstrap federates" \
        || bad "${wf_file}:${wf_job} calls azure/login in environment '$e', which has NO bootstrap federated credential (the OIDC subject would not match)"
    else
      # A job that never calls azure/login binds an environment purely for its
      # PROTECTION RULES (an approval gate, or a pre-flight guard job that must
      # pass the same approval as the deploy job it precedes). Whether that
      # environment is also federated is not a security property of THIS job — it
      # holds no identity either way — so both shapes are legitimate and neither
      # is asserted. It is reported so the map stays visible.
      if [ "$federated" -eq 1 ]; then
        ok "${wf_file}:${wf_job} binds federated environment '$e' for its protection rules only (no azure/login in this job)"
      else
        ok "${wf_file}:${wf_job} binds '$e' as an approval-only gate (no federated credential, no Azure identity)"
      fi
    fi
  done <<< "$wf_pairs"
  # --- D9: ci.yml is CREDENTIALLESS -----------------------------------------
  # This REPLACES, and is strictly stronger than, the assertion that used to live
  # here (which REQUIRED ci.yml to bind a dev plan environment). The correct
  # invariant after the re-scope is the inverse: the PR-reachable workflow binds
  # NO environment at all, holds NO OIDC token permission, and performs NO Azure
  # login. "Which environment does the PR job bind" is no longer a question with
  # a right answer — the right answer is "none".
  if grep -qE '^[[:space:]]*environment:' "$WF_DIR/ci.yml"; then
    bad "D9: ci.yml must declare NO environment at all — PR validation is credentialless (found: $(grep -nE '^[[:space:]]*environment:' "$WF_DIR/ci.yml" | tr '\n' ' '))"
  else
    ok "D9: ci.yml binds NO GitHub Environment (PR validation is credentialless)"
  fi
  if grep -q 'id-token' "$WF_DIR/ci.yml"; then
    bad "D9: ci.yml must contain no id-token permission — without it GitHub cannot mint an OIDC token for any job in this workflow"
  else
    ok "D9: ci.yml grants no OIDC token permission anywhere"
  fi
  if grep -q 'azure/login' "$WF_DIR/ci.yml"; then
    bad "D9: ci.yml must not call azure/login — the PR path authenticates to nothing"
  else
    ok "D9: ci.yml never calls azure/login"
  fi
  # The runtime counterpart: the credentialless property is also PROVEN at job
  # runtime, not merely absent from the YAML.
  if grep -q 'assert-credentialless.sh' "$WF_DIR/ci.yml"; then
    ok "D9: ci.yml runs the runtime credentialless assertion"
  else
    bad "D9: ci.yml must run scripts/assert-credentialless.sh to prove the property at runtime"
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

# ===========================================================================
# F4 (reopened): operator Storage-Blob-Data grant — SP-skip vs user-fail-loud
# ===========================================================================
# The old resolution was `operator_oid="$(az ad signed-in-user show … 2>/dev/null
# || true)"`, which collapsed TWO different cases into one empty→silent-skip path:
#   (a) EXPECTED: a SERVICE PRINCIPAL session (CI/automation) for which
#       'signed-in-user show' legitimately fails — the per-operator grant is N/A
#       and skipping it is BY DESIGN, and
#   (b) GENUINE failure for a real USER (Graph down / auth / network) — which was
#       SILENTLY swallowed, dropping the operator's Storage-Blob-Data grant.
# The fix detects the principal TYPE first (az account show → user.type) then
# branches: SP → skip (log, no die); user → resolve WITHOUT the mask, DIE LOUD on
# a genuine failure. Tests stub `az` (no real Azure), exercising the new branch.

# The helper exists.
if grep -q '^operator_state_grant_oid()' "$BOOT"; then
  ok "operator_state_grant_oid helper exists (branches SP-skip vs user-fail-loud)"
else bad "bootstrap must define operator_state_grant_oid (branch SP-skip vs user-fail-loud)"; fi

# The principal TYPE is detected (az account show → user.type) before branching.
if grep -q 'az account show --query user.type' "$BOOT"; then
  ok "bootstrap detects the signed-in principal type (user vs servicePrincipal) before the operator grant"
else bad "bootstrap must detect the principal type (az account show --query user.type) to branch SP vs user"; fi

# The signed-in-user object-id lookup is no longer masked by `|| true`.
if grep -Eq 'signed-in-user show[^\n]*\|\| true' "$BOOT"; then
  bad "the signed-in-user object-id lookup must NOT be masked by '|| true' (collapses SP-skip and a real Graph/auth failure)"
else ok "no '|| true' masking on the signed-in-user object-id lookup (F4 fixed)"; fi
# ...and the exact old masked collapse is gone.
if grep -q 'signed-in-user show --query id -o tsv 2>/dev/null || true' "$BOOT"; then
  bad "the old masked 'signed-in-user … 2>/dev/null || true' resolution is still present"
else ok "old masked signed-in-user resolution removed"; fi

# The SP branch LOGS a clear, explicit by-design skip (not a silent drop).
if grep -Eiq 'SERVICE PRINCIPAL.*skipping.*Storage Blob Data' "$BOOT"; then
  ok "SP session logs a clear 'skipping the per-operator Storage Blob Data grant (by design)' message"
else bad "SP session must LOG a clear by-design skip of the operator Storage Blob Data grant"; fi

# NOTE: the `az` mocks below are defined at TOP LEVEL (not inside the `$(...)`
# / `(...)` that follows). System Bash 3.2 (macOS) has a parser bug that makes a
# function definition INSIDE a command substitution abort with a 127 parse error
# mid-suite; defining the mock first and calling only the helper inside the
# substitution/subshell is valid on Bash 3.2 and 4/5 alike. `operator_state_grant_oid`
# calls `az`, so the mock must keep the name `az`; each block redefines it.

# BEHAVIOUR (1): a SERVICE PRINCIPAL session yields SKIP_SP and does NOT die, and
# does NOT even call 'signed-in-user show' (which legitimately fails for an SP).
az() {
  case "$*" in
    "account show --query user.type -o tsv") echo "servicePrincipal" ;;
    "ad signed-in-user show --query id -o tsv") echo "SHOULD-NOT-BE-CALLED"; return 0 ;;
    *) return 0 ;;
  esac
}
sp_out="$(operator_state_grant_oid 2>/dev/null)"
if [ "$sp_out" = "SKIP_SP" ]; then
  ok "SP session -> operator_state_grant_oid emits SKIP_SP (deliberate fail-soft, no die, no signed-in-user call)"
else bad "SP session must yield SKIP_SP (got '$sp_out')"; fi

# BEHAVIOUR (2): a USER session whose signed-in-user lookup FAILS (Graph/auth/
# network) must DIE LOUDLY (non-zero) — never silently skip the grant. Run the
# helper in a SUBSHELL so die's `exit 1` cannot abort the runner.
az() {
  case "$*" in
    "account show --query user.type -o tsv") echo "user" ;;
    "ad signed-in-user show --query id -o tsv") return 1 ;;
    *) return 0 ;;
  esac
}
if ( operator_state_grant_oid >/dev/null 2>&1 ); then
  bad "USER session with a FAILED signed-in-user lookup must DIE (Graph/auth/network), not silently skip the operator grant"
else ok "USER session + failed signed-in-user lookup -> operator_state_grant_oid dies loudly (no masked skip)"; fi

# BEHAVIOUR (3): a USER session that resolves an object id returns it verbatim so
# the caller proceeds to the existing fail-loud role assignment.
az() {
  case "$*" in
    "account show --query user.type -o tsv") echo "user" ;;
    "ad signed-in-user show --query id -o tsv") echo "11111111-2222-3333-4444-555555555555" ;;
    *) return 0 ;;
  esac
}
usr_out="$(operator_state_grant_oid 2>/dev/null)"
if [ "$usr_out" = "11111111-2222-3333-4444-555555555555" ]; then
  ok "USER session -> operator_state_grant_oid returns the resolved object id (proceeds to the grant)"
else bad "USER session must yield the resolved object id (got '$usr_out')"; fi

# BEHAVIOUR (4): a USER session that returns an EMPTY id (Graph success, no id) is
# an anomaly -> DIE, not a silent skip.
az() {
  case "$*" in
    "account show --query user.type -o tsv") echo "user" ;;
    "ad signed-in-user show --query id -o tsv") echo "" ;;
    *) return 0 ;;
  esac
}
if ( operator_state_grant_oid >/dev/null 2>&1 ); then
  bad "USER session returning an EMPTY object id must DIE (Graph/auth anomaly), not silently skip"
else ok "USER session + empty object id -> operator_state_grant_oid dies loudly"; fi

# BEHAVIOUR (5): a REAL error fetching the principal TYPE itself (auth/throttle/
# network) must fail loud (via az_discover) rather than be mistaken for non-SP.
az() {
  case "$*" in
    "account show --query user.type -o tsv") return 1 ;;
    *) return 0 ;;
  esac
}
if ( operator_state_grant_oid >/dev/null 2>&1 ); then
  bad "a real error fetching the principal type must DIE (az_discover), not be treated as a non-SP user"
else ok "principal-type query error -> operator_state_grant_oid dies loudly (via az_discover)"; fi
unset -f az

# ===========================================================================
# BUG A (MG-24): the deploy-identity summary heredoc renders the LITERAL text
# `func publish` and NEVER executes command substitution.
# ===========================================================================
# The runbook line inside bootstrap_deploy_identity's SUMMARY heredoc must show
# the operator the literal string `func publish`. The backticks around it MUST be
# escaped (\`func publish\`) so the (unquoted) heredoc renders them verbatim
# instead of treating them as a command substitution that would try to RUN the
# Azure Functions Core Tools (`func publish`) at emit time — a bug that both
# corrupts the emitted guidance AND fires an unintended local command.
#
# We EXERCISE the real function with a stubbed `az` (no Azure) and a stubbed
# `func` that, IF it were ever invoked (i.e. if the backticks were live), would
# print unmistakable Functions Core Tools signatures. A correct (escaped) heredoc
# never calls `func`, so those signatures must be ABSENT and the literal present.
#
# Mocks are defined at TOP LEVEL (not inside the `$(...)` capture) for the Bash
# 3.2 parser-bug reason documented above; only the function is CALLED inside the
# substitution.
az() {
  case "$*" in
    "account show --query id -o tsv")        echo "11111111-1111-1111-1111-111111111111" ;;
    "account show --query tenantId -o tsv")  echo "22222222-2222-2222-2222-222222222222" ;;
    *"ad app list"*) echo "33333333-3333-3333-3333-333333333333" ;;
    *"ad sp list"*)  echo "44444444-4444-4444-4444-444444444444" ;;
    *) return 0 ;;
  esac
}
# If the heredoc backticks were live, this stub's output would replace the
# literal `func publish` with these Core Tools signatures.
func() {
  echo "Azure Functions Core Tools"
  echo "Core Tools Version 4.0.0"
  echo "unknown argument publish"
  return 0
}
deploy_summary="$( bootstrap_deploy_identity 2>/dev/null || true )"
unset -f az func

case "$deploy_summary" in
  *"func publish"*) ok "deploy summary renders the LITERAL 'func publish' (heredoc backticks are escaped)" ;;
  *) bad "deploy summary must contain the literal 'func publish' (escaped backticks); command substitution ate it" ;;
esac
# No Functions Core Tools signature may appear — that would prove `func` actually
# ran (live backticks / command substitution in the heredoc).
for sig in "unknown argument publish" "Core Tools Version" "Azure Functions Core Tools"; do
  case "$deploy_summary" in
    *"$sig"*) bad "deploy summary contains Core Tools signature '$sig' — the heredoc executed \`func publish\` (unescaped backticks)" ;;
    *) ok "deploy summary has no Core Tools signature '$sig' (no command substitution in the heredoc)" ;;
  esac
done

# ===========================================================================
# BUG B (MG-24): dev API registration issues the scope + preauth as TWO SEPARATE
# sequential Graph PATCHes; oauth2PermissionScopes and preAuthorizedApplications
# are NEVER in the same PATCH body, and the preauth PATCH is SKIPPED when empty.
# ===========================================================================
# Graph validates preAuthorizedApplications.delegatedPermissionIds against scopes
# that ALREADY EXIST on the app, so combining scope creation and preauth in one
# atomic PATCH returns 400 and the whole api block fails. The fix issues the
# oauth2PermissionScopes-defining PATCH FIRST, then a distinct second PATCH that
# sets preAuthorizedApplications referencing the now-persisted scope id — and
# skips the second PATCH entirely when there are no calling client ids.
#
# We capture every `az rest --method PATCH` --body via a stubbed `az` (bodies
# written to disk, in order) and assert the two-PATCH split + empty-skip.
PATCH_DIR="$(mktemp -d)"
# az mock: record each PATCH --body to patch-<n>.json in call order; serve the
# reads the function makes so it reaches BOTH PATCHes.
az() {
  if [ "${1:-}" = "rest" ]; then
    local a prev="" body="" n=0
    for a in "$@"; do
      [ "$prev" = "--body" ] && body="$a"
      prev="$a"
    done
    [ -f "$PATCH_DIR/count" ] && n="$(cat "$PATCH_DIR/count")"
    n=$((n+1))
    printf '%s' "$n" > "$PATCH_DIR/count"
    printf '%s' "$body" > "$PATCH_DIR/patch-$n.json"
    return 0
  fi
  case "$*" in
    "account show --query tenantId -o tsv") echo "22222222-2222-2222-2222-222222222222" ;;
    *"ad app list"*) echo "55555555-5555-5555-5555-555555555555" ;;
    *"ad sp list"*)  echo "66666666-6666-6666-6666-666666666666" ;;
    *) return 0 ;;
  esac
}

# --- Scenario 1: one calling client id -> exactly TWO PATCHes, split correctly.
( SMOKE_TEST_CLIENT_IDS="04b07795-8ddb-461a-bbee-02f9e1bf7b46"; bootstrap_dev_api_registration ) >/dev/null 2>&1 || true
patch_n="$(ls "$PATCH_DIR"/patch-*.json 2>/dev/null | wc -l | tr -d ' ')"
if [ "${patch_n:-0}" -eq 2 ]; then
  ok "dev API registration issues exactly TWO sequential Graph PATCHes (scope, then preauth)"
else bad "dev API registration must issue exactly two PATCHes (scope + preauth); got ${patch_n:-0}"; fi

# First PATCH = scope definition: has oauth2PermissionScopes, NOT preAuthorizedApplications.
if [ -f "$PATCH_DIR/patch-1.json" ] \
   && grep -q 'oauth2PermissionScopes' "$PATCH_DIR/patch-1.json" \
   && ! grep -q 'preAuthorizedApplications' "$PATCH_DIR/patch-1.json"; then
  ok "PATCH 1 defines oauth2PermissionScopes and carries NO preAuthorizedApplications (scope-first)"
else bad "PATCH 1 must define oauth2PermissionScopes without preAuthorizedApplications"; fi

# Second PATCH = preauth: has preAuthorizedApplications, NOT oauth2PermissionScopes.
if [ -f "$PATCH_DIR/patch-2.json" ] \
   && grep -q 'preAuthorizedApplications' "$PATCH_DIR/patch-2.json" \
   && ! grep -q 'oauth2PermissionScopes' "$PATCH_DIR/patch-2.json"; then
  ok "PATCH 2 sets preAuthorizedApplications and carries NO oauth2PermissionScopes (preauth-second)"
else bad "PATCH 2 must set preAuthorizedApplications without oauth2PermissionScopes"; fi

# The core invariant: no single PATCH body ever contains BOTH keys (the 400 bug).
both_in_one=0
for f in "$PATCH_DIR"/patch-*.json; do
  [ -f "$f" ] || continue
  if grep -q 'oauth2PermissionScopes' "$f" && grep -q 'preAuthorizedApplications' "$f"; then
    both_in_one=1
  fi
done
if [ "$both_in_one" -eq 0 ]; then
  ok "no Graph PATCH body ever combines oauth2PermissionScopes with preAuthorizedApplications"
else bad "a Graph PATCH body combined oauth2PermissionScopes AND preAuthorizedApplications (atomic-400 regression)"; fi

# --- Scenario 2: EMPTY calling-client list -> preauth PATCH SKIPPED (only scope).
rm -f "$PATCH_DIR"/patch-*.json "$PATCH_DIR"/count 2>/dev/null
( SMOKE_TEST_CLIENT_IDS=""; bootstrap_dev_api_registration ) >/dev/null 2>&1 || true
patch_n_empty="$(ls "$PATCH_DIR"/patch-*.json 2>/dev/null | wc -l | tr -d ' ')"
if [ "${patch_n_empty:-0}" -eq 1 ]; then
  ok "empty SMOKE_TEST_CLIENT_IDS -> only the scope PATCH is issued (preauth PATCH skipped)"
else bad "empty SMOKE_TEST_CLIENT_IDS must skip the preauth PATCH (expect 1 PATCH); got ${patch_n_empty:-0}"; fi
if [ -f "$PATCH_DIR/patch-1.json" ] \
   && grep -q 'oauth2PermissionScopes' "$PATCH_DIR/patch-1.json" \
   && ! grep -q 'preAuthorizedApplications' "$PATCH_DIR/patch-1.json"; then
  ok "empty-list scope PATCH still defines oauth2PermissionScopes and no preAuthorizedApplications"
else bad "empty-list run must still issue the scope PATCH (oauth2PermissionScopes, no preauth)"; fi

unset -f az
rm -rf "$PATCH_DIR" 2>/dev/null

# ===========================================================================
# MG-23 F14 (bootstrap half): the OUT-OF-RG GRANT INVENTORY
# ===========================================================================
# tf-static-checks.sh CHECK 14 guards the TERRAFORM GRAPH. It cannot see these:
# every genuinely out-of-resource-group grant in this system is BOOTSTRAP-managed
# and lives in this file. So the complete set of role grants is pinned here, as
# an exact inventory. Any NEW grant — of any role, at any scope, to any identity
# — produces a line that is not in the expected set and FAILS, which forces the
# question "does this escape the boundary?" to be answered in review rather than
# discovered later.
#
# Continuation lines are joined first so a multi-line call is compared whole.
grant_calls="$(sed -e ':a' -e '/\\$/N; s/\\\n/ /; ta' "$BOOT" \
  | grep -E '^[[:space:]]*ensure_(conditioned_)?role_assignment[[:space:]]' \
  | sed -E 's/[[:space:]]+/ /g; s/^ //; s/ $//; s/ \|\| die .*$//' | sort -u)"
# The three container-scoped grants are three DIFFERENT identities and must not
# be confused when reading this list:
#   "$state_role"                  -> the PLAN identity (Reader for dev, which is
#                                     the round-5 read-only demotion; still
#                                     write-capable for prod, whose plan locks)
#   "Storage Blob Data Contributor"-> the INFRA-APPLY identity (an apply writes state)
#   "Storage Blob Data Reader"     -> the APP-DEPLOY identity (reads outputs only)
expected_grants="$(printf '%s\n' \
  'ensure_conditioned_role_assignment "$sp_id" ServicePrincipal "$INFRA_APPLY_RBAC_ROLE" "$rg_scope" "$condition"' \
  'ensure_role_assignment "$operator_oid" User "Storage Blob Data Contributor" "$state_sa_id"' \
  'ensure_role_assignment "$sp_id" ServicePrincipal "$CI_PLAN_ROLE" "/subscriptions/${sub_id}"' \
  'ensure_role_assignment "$sp_id" ServicePrincipal "$INFRA_APPLY_ROLE" "$rg_scope"' \
  'ensure_role_assignment "$sp_id" ServicePrincipal "$state_role" "$container_scope"' \
  'ensure_role_assignment "$sp_id" ServicePrincipal "Storage Blob Data Contributor" "$container_scope"' \
  'ensure_role_assignment "$sp_id" ServicePrincipal "Storage Blob Data Reader" "$container_scope"' \
  | sort -u)"
if [ "$grant_calls" = "$expected_grants" ]; then
  ok "the bootstrap-managed role-grant inventory is exactly the expected set (7 distinct grants)"
else
  bad "the bootstrap role-grant inventory CHANGED. Every grant here is a deliberate boundary decision — review the diff, then update this expectation.
--- expected ---
${expected_grants}
--- actual ---
${grant_calls}"
fi

# ===========================================================================
# MG-23 F9/F10: the condition derives from the ALLOWLIST FILE, with LIVE GUIDs
# ===========================================================================
ALLOWLIST="$DIR/tf-managed-role-allowlist.tsv"
if [ -f "$ALLOWLIST" ]; then
  ok "the Terraform-managed role allowlist file exists"
else
  bad "missing $ALLOWLIST — bootstrap builds the ABAC condition from it"
fi
# bootstrap reads the FILE; it does not carry its own copy of the role list.
if grep -q 'ROLE_ALLOWLIST_FILE=' "$BOOT" && grep -q 'allowlist_role_names()' "$BOOT"; then
  ok "bootstrap reads the role allowlist from the committed file"
else bad "bootstrap must read the role allowlist from tf-managed-role-allowlist.tsv"; fi
# GUIDs are resolved LIVE, never remembered.
if grep -q 'az role definition list --name' "$BOOT"; then
  ok "role-definition GUIDs are resolved LIVE from the tenant"
else bad "bootstrap must resolve role-definition GUIDs live (az role definition list --name)"; fi
# ...and the condition builder itself contains NO literal GUID.
cond_fn="$(awk '/^build_rbac_admin_condition\(\)/{f=1} f{print} f&&/^}/{exit}' "$BOOT")"
if printf '%s' "$cond_fn" | grep -Eq '[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'; then
  bad "build_rbac_admin_condition contains a HARDCODED role-definition GUID (remembered GUIDs are a classic silent-authz-bug source)"
else ok "build_rbac_admin_condition contains no hardcoded GUID"; fi
# A committed GUID that disagrees with the live one must FAIL CLOSED, not be
# silently preferred in either direction.
if grep -q 'GUID MISMATCH' "$BOOT"; then
  ok "a committed-vs-live GUID disagreement fails closed"
else bad "bootstrap must fail closed when a committed GUID disagrees with the live one"; fi
# The 8 allowlisted role NAMES live in the allowlist file, not inlined here. Two
# names are permitted to overlap — 'Storage Blob Data Contributor' and 'Storage
# Blob Data Owner' — because bootstrap also reasons about blob DATA-PLANE roles
# on the STATE ACCOUNT (granting the former, and sweeping for both in
# STATE_WRITE_DATA_ROLES). That is an entirely separate concern from the
# Terraform graph's role allowlist; the names merely collide. The check that
# actually protects the single-derivation discipline is elsewhere and unaffected:
# build_rbac_admin_condition is asserted to contain no GUID and to be built from
# the resolved allowlist. Every OTHER allowlisted name must be absent here.
if [ -f "$ALLOWLIST" ]; then
  inlined=""
  while IFS= read -r r; do
    [ -z "$r" ] && continue
    [ "$r" = "Storage Blob Data Contributor" ] && continue
    [ "$r" = "Storage Blob Data Owner" ] && continue
    grep -qF "\"$r\"" "$BOOT" && inlined="${inlined}${r}; "
  done <<< "$(allowlist_role_names)"
  if [ -z "$inlined" ]; then
    ok "no allowlisted role name is inlined in bootstrap.sh (single source of truth is the .tsv)"
  else
    bad "allowlisted role name(s) inlined in bootstrap.sh — the condition must derive from the file: ${inlined}"
  fi
fi

# ===========================================================================
# MG-23 F11: the emitted condition — BOTH clauses, no tolerance escape hatch
# ===========================================================================
# EXERCISE the real builder with two sample GUIDs (not a grep of the source, so
# an assembled-at-runtime bypass would still be caught).
sample_resolved="$(printf 'Role A\t11111111-1111-1111-1111-111111111111\nRole B\t22222222-2222-2222-2222-222222222222\n')"
emitted_condition="$(build_rbac_admin_condition "$sample_resolved")"

# WRITE clause: allowlisted role definitions via @Request...
if printf '%s' "$emitted_condition" | grep -q "roleAssignments/write" \
   && printf '%s' "$emitted_condition" | grep -q "@Request\[Microsoft.Authorization/roleAssignments:RoleDefinitionId\]"; then
  ok "condition constrains roleAssignments/WRITE on @Request RoleDefinitionId"
else bad "condition must constrain roleAssignments/write via @Request RoleDefinitionId"; fi
# ...and PrincipalType ServicePrincipal on the write clause.
if printf '%s' "$emitted_condition" | grep -q "PrincipalType\] ForAnyOfAnyValues:StringEqualsIgnoreCase{'ServicePrincipal'}"; then
  ok "write clause requires PrincipalType ServicePrincipal"
else bad "the write clause must require PrincipalType ServicePrincipal"; fi
# DELETE clause via @Resource. WITHOUT this the identity could revoke ANY role
# assignment in the RG — including the Function App MI's — an outage primitive
# that needs no escalation at all.
if printf '%s' "$emitted_condition" | grep -q "roleAssignments/delete" \
   && printf '%s' "$emitted_condition" | grep -q "@Resource\[Microsoft.Authorization/roleAssignments:RoleDefinitionId\]"; then
  ok "condition ALSO constrains roleAssignments/DELETE on @Resource RoleDefinitionId (not write-only)"
else bad "condition must constrain DELETE too — a write-only condition leaves delete unconstrained at RG scope (outage primitive)"; fi
# Both sample GUIDs appear in the allowlist braces.
if printf '%s' "$emitted_condition" | grep -q '11111111-1111-1111-1111-111111111111' \
   && printf '%s' "$emitted_condition" | grep -q '22222222-2222-2222-2222-222222222222'; then
  ok "the emitted condition allowlists the resolved role-definition GUIDs"
else bad "the emitted condition must carry the resolved role-definition GUIDs"; fi
# NO `!(Exists ...)` tolerance anywhere — that shape is a ONE-FIELD BYPASS: any
# caller that simply omits the attribute satisfies the clause unconditionally.
if printf '%s' "$emitted_condition" | grep -q '!(Exists'; then
  bad "the condition contains an '!(Exists …)' tolerance — a one-field bypass (omit the attribute, satisfy the clause)"
else ok "no '!(Exists …)' tolerance in the emitted condition"; fi
# Comment lines are stripped: the prose that EXPLAINS why this tolerance is
# forbidden legitimately contains the string, and must not trip the guard that
# forbids it. Live code is what matters, and the emitted-condition assertion just
# above is the authoritative check either way.
if grep -vE '^[[:space:]]*#' "$BOOT" | grep -q '!(Exists'; then
  bad "bootstrap.sh contains an '!(Exists …)' condition tolerance in live code"
else ok "no '!(Exists …)' tolerance in bootstrap.sh live code"; fi
# The condition is authored at condition-version 2.0 (v1.0 lacks these operators).
if grep -q -- '--condition-version "2.0"' "$BOOT"; then
  ok "the condition is authored at condition-version 2.0"
else bad "the ABAC condition must be authored at --condition-version 2.0"; fi
# An EMPTY allowlist must abort, not emit a condition that denies everything
# silently (or, worse, an empty condition that denies nothing).
if (build_rbac_admin_condition "" >/dev/null 2>&1); then
  bad "build_rbac_admin_condition must REFUSE an empty allowlist"
else ok "build_rbac_admin_condition refuses an empty allowlist (fail-loud)"; fi

# ===========================================================================
# MG-23 F7: ensure_conditioned_role_assignment RECONCILES the live condition
# ===========================================================================
# The whole point: a tuple-only idempotence check FREEZES the condition at its
# first value, so adding a role to the allowlist would report success while the
# live condition still allowlisted the old set — and the next apply would fail
# mid-run with AuthorizationFailed and a partially-applied stack. These are
# BEHAVIOURAL tests against a mocked `az`, not greps.
COND_LOG="$(mktemp)"
LIVE_ID=""
LIVE_COND=""
# The whole live assignment object the IN-PLACE reconcile reads back. Carries the
# fields that must survive the update verbatim (principalId, roleDefinitionId,
# scope) so the assertions can prove the PUT changes ONLY the condition.
LIVE_OBJ='{"id":"/ra/1","name":"ra1","principalId":"oid","principalType":"ServicePrincipal","roleDefinitionId":"/subscriptions/s/providers/Microsoft.Authorization/roleDefinitions/RBAC-ADMIN-GUID","scope":"/scope","condition":"COND-OLD","conditionVersion":"2.0"}'
# Mock: records every create/update/delete; serves the three discovery queries
# from LIVE_ID / LIVE_COND / LIVE_OBJ so each scenario can pose a different live
# state.
az() {
  case "$*" in
    # MG-23 blocker 2: the ID lookup projects ALL matches (`[].id`), never
    # `[0].id`, so az_discover_unique can see — and refuse — an ambiguous
    # >1-match result. Matched STRICTLY: if that query is ever narrowed to
    # `[0].id`, this arm stops matching, the helper sees "absent", and scenario
    # (2) below fails loudly rather than silently losing the uniqueness guard.
    *"role assignment list"*"[].id"*) printf '%s' "$LIVE_ID" ;;
    # The whole-object read the in-place reconcile does. Matched on `-o json`,
    # which is what distinguishes it from the `-o tsv` condition read below.
    *"role assignment list"*"-o json"*) printf '%s' "$LIVE_OBJ" ;;
    # The CONDITION read is matched LOOSELY (any projection) on purpose: this
    # arm must serve whichever query shape the helper uses, so the multi-line
    # scenario (2c) tests the real behaviour rather than a shape we assumed.
    #
    # RBAC REPLICA LAG MODEL (off unless LAG_STALE_READS is set). A real ARM
    # read after a write can land on a replica that has not converged yet and
    # return the PREVIOUS condition. With LAG_STALE_READS=N the first N condition
    # reads of a scenario return LAG_STALE_COND regardless of what the mock
    # durably stored; read N+1 onwards returns the stored value — i.e. the write
    # DID take, the reader simply could not see it yet. The counter lives in a
    # FILE, not a variable: every condition read happens inside a `$( … )`
    # command substitution, so a variable increment would be discarded with the
    # subshell and the lag would never advance.
    *"role assignment list"*condition*)
      if [ -n "${LAG_STALE_READS:-}" ] && [ -f "${LAG_COUNT_FILE:-}" ]; then
        _lag="$(cat "$LAG_COUNT_FILE")"
        _lag=$((_lag + 1))
        printf '%s' "$_lag" > "$LAG_COUNT_FILE"
        if [ "$_lag" -le "$LAG_STALE_READS" ]; then
          printf '%s' "$LAG_STALE_COND"
          return 0
        fi
      fi
      printf '%s' "$LIVE_COND"
      ;;
    # THE IN-PLACE UPDATE. The PUT body arrives as an `@file` argument, so record
    # the FILE CONTENTS, not just the argv — the assertions below need to prove
    # what was actually sent to ARM, not merely that a command ran.
    #
    # THE PUT IS DURABLE BY DEFAULT (UPDATE_DURABLE=1): the mock writes the new
    # condition back into LIVE_COND / LIVE_OBJ, so a subsequent read-back sees
    # it. That models real ARM and is what lets scenario (6) below model the
    # opposite — an ACCEPTED-BUT-NOT-STORED PUT — by flipping the switch. Without
    # a durable default every drift scenario above would fail the new post-update
    # verification for the wrong reason (the mock, not the code).
    *"role assignment update"*)
      echo "UPDATE $*" >> "$COND_LOG"
      for _a in "$@"; do
        case "$_a" in
          @*) [ -f "${_a#@}" ] && {
                cat "${_a#@}" >> "$COND_LOG"; echo >> "$COND_LOG"
                if [ "${UPDATE_DURABLE:-1}" = "1" ]; then
                  LIVE_OBJ="$(cat "${_a#@}")"
                  LIVE_COND="$(printf '%s' "$LIVE_OBJ" | jq -r '.condition // ""')"
                fi
              } ;;
        esac
      done
      ;;
    # THE CREATE IS DURABLE BY DEFAULT (CREATE_DURABLE=1), for exactly the same
    # reason the update arm above is: the helper now READS THE GRANT BACK after
    # creating it, so a mock that recorded the create without storing anything
    # would make every create scenario fail on the mock's amnesia rather than on
    # the code. Parse the --condition value out of the argv, store it as the
    # live condition, and mint an assignment id so the `[].id` read-back sees
    # the grant exist.
    #
    # CREATE_STORES_COND overrides what the mock CLAIMS to have stored,
    # independently of what was sent — which is how the "ARM accepted the create
    # but stored something else" scenario is posed. CREATE_DURABLE=0 models a
    # create that never becomes readable at all.
    *"role assignment create"*)
      echo "CREATE $*" >> "$COND_LOG"
      if [ "${CREATE_DURABLE:-1}" = "1" ]; then
        _next=""; _cond=""
        for _a in "$@"; do
          if [ "$_next" = "cond" ]; then _cond="$_a"; _next=""; continue; fi
          if [ "$_a" = "--condition" ]; then _next="cond"; fi
        done
        LIVE_COND="${CREATE_STORES_COND-$_cond}"
        LIVE_ID="/ra/created"
      fi
      ;;
    *"role assignment delete"*) echo "DELETE $*" >> "$COND_LOG" ;;
    *) return 0 ;;
  esac
}

# (1) No existing assignment -> CREATE carrying the condition + version 2.0.
: > "$COND_LOG"; LIVE_ID=""; LIVE_COND=""
ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW" >/dev/null 2>&1
if grep -q '^CREATE' "$COND_LOG" && grep -q 'COND-NEW' "$COND_LOG" \
   && grep -q 'condition-version 2.0' "$COND_LOG" && ! grep -q '^DELETE' "$COND_LOG"; then
  ok "conditioned grant: absent -> creates WITH the condition at version 2.0"
else bad "conditioned grant must create with the condition (log: $(cat "$COND_LOG"))"; fi

# (1b) ...and the create is VERIFIED BY READ-BACK, so it must also SUCCEED when
#      the grant reads back correctly. Asserted on the EXIT STATUS, not just the
#      log: a helper that always failed after creating would satisfy (1c) below
#      while being unusable on a first-ever bootstrap.
: > "$COND_LOG"; LIVE_ID=""; LIVE_COND=""
create_status=0
create_out="$(ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW" 2>&1)" \
  || create_status=$?
if [ "$create_status" -eq 0 ] && printf '%s' "$create_out" | grep -qi 'read-back'; then
  ok "conditioned grant: a create that reads back correctly VERIFIES and succeeds"
else bad "a durable create must verify by read-back and succeed (exit=${create_status}, out: ${create_out})"; fi

# (1c) THE FIRST-EVER BOOTSTRAP IS THE RUN THAT ESTABLISHES THE CONDITION.
#      Before this, the create branch returned 0 the instant `az` exited 0 — and
#      an `az` 0 means ARM ACCEPTED the request, not that the grant it stored
#      carries the condition. A create that lands WITHOUT (or with a different)
#      condition is an UNCONDITIONED RBAC-administrator grant at RG scope: the
#      self-escalation primitive the condition exists to prevent, reported as a
#      green "Conditioned … granted" line. Pose exactly that: ARM stores
#      something other than what was sent.
#      Subshell — the helper reports this with `die`, which exits.
: > "$COND_LOG"; LIVE_ID=""; LIVE_COND=""
if ( CREATE_STORES_COND="COND-SOMETHING-ELSE" \
     ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW" >/dev/null 2>&1 ); then
  bad "a create whose read-back returns a DIFFERENT condition MUST fail — the grant is live carrying a condition this bootstrap did not author (log: $(cat "$COND_LOG"))"
elif grep -q '^CREATE' "$COND_LOG"; then
  ok "conditioned grant: a create whose read-back differs is CAUGHT and FAILS (no false success)"
else bad "the helper failed, but never issued the CREATE — it failed for the wrong reason, so the create read-back is not what was tested (log: $(cat "$COND_LOG"))"; fi
#      ...and it must not print a success line while failing. Captured to a FILE
#      via `if ( … ) >file`, not `out="$( … || true )"`: the helper reports this
#      with `die`, which EXITS the substitution subshell outright, so the
#      `|| true` never runs and the assignment trips the errexit that sourcing
#      bootstrap.sh turns on. Same reason the subshell above is an `if` condition.
: > "$COND_LOG"; LIVE_ID=""; LIVE_COND=""
MISMATCH_OUT="$(mktemp)"
if ( CREATE_STORES_COND="COND-SOMETHING-ELSE" \
     ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW" ) \
     >"$MISMATCH_OUT" 2>&1; then :; fi
if ! grep -q '✅' "$MISMATCH_OUT"; then
  ok "conditioned grant: the failing create prints NO success line"
else bad "a create whose read-back differs must not print a success line (out: $(cat "$MISMATCH_OUT"))"; fi
rm -f "$MISMATCH_OUT"

# (1d) ABSENCE is retried (ARM create->read is eventually consistent), but the
#      retry is BOUNDED and ends in a failure, never in an assumed success. An
#      unbounded/absent retry would either abort the first-ever bootstrap on a
#      normal replication lag, or — worse — treat "still cannot see it" as fine.
#      COND_READBACK_* keep the test fast; the production defaults are 5 x 3s.
: > "$COND_LOG"; LIVE_ID=""; LIVE_COND=""
if ( CREATE_DURABLE=0 COND_READBACK_ATTEMPTS=2 COND_READBACK_DELAY=0 \
     ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW" >/dev/null 2>&1 ); then
  bad "a create that never becomes readable must FAIL after the bounded retry, not be assumed good (log: $(cat "$COND_LOG"))"
else ok "conditioned grant: an unreadable create fails after a BOUNDED retry (absence is retried, never assumed)"; fi

# (1e) CODE SHAPE — the create path must re-establish uniqueness via `[].id`
#      through az_discover_unique. On this branch uniqueness was NEVER proven:
#      the pre-create read returned EMPTY, which is what selected this branch,
#      so without a fresh `[].id` read the `[0].condition` read below would be
#      indexing a set of unknown size.
#      (Extracted locally — cond_fn_body is not built until further down.)
create_branch="$(awk '/^ensure_conditioned_role_assignment\(\)/{f=1} f{print} f&&/^}/{exit}' "$BOOT" \
  | sed -n '/Creating CONDITIONED role assignment/,/^    return 0$/p')"
if printf '%s\n' "$create_branch" | grep -vE '^[[:space:]]*#' | grep -q 'az_discover_unique' \
   && printf '%s\n' "$create_branch" | grep -vE '^[[:space:]]*#' | grep -q '\[0\].condition'; then
  ok "conditioned grant: the create path re-reads [].id via az_discover_unique and [0].condition via az_discover"
else bad "the create path must re-establish uniqueness with an az_discover_unique [].id read and verify with a single-value [0].condition read"; fi

# (2) Existing assignment whose live condition MATCHES -> no-op (no churn).
: > "$COND_LOG"; LIVE_ID="/ra/1"; LIVE_COND="COND-SAME"
ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-SAME" >/dev/null 2>&1
if [ ! -s "$COND_LOG" ]; then
  ok "conditioned grant: live condition matches -> no create, no delete (idempotent)"
else bad "a matching live condition must be a no-op (log: $(cat "$COND_LOG"))"; fi

# (2b) ...and the match tolerates whitespace/case differences, since Azure does
# not return the exact bytes we sent. Without this the helper would churn the
# grant on EVERY run — delete+create on a live RBAC-admin assignment, every time.
: > "$COND_LOG"; LIVE_ID="/ra/1"; LIVE_COND="  cond-same
"
ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-SAME" >/dev/null 2>&1
if [ ! -s "$COND_LOG" ]; then
  ok "conditioned grant: match is whitespace/case-insensitive (no spurious re-grant churn)"
else bad "condition comparison must normalize whitespace/case (log: $(cat "$COND_LOG"))"; fi

# (2c) REGRESSION — MULTI-LINE live condition (the shape Azure actually stores).
#      az_discover_unique decides "how many objects matched?" by COUNTING OUTPUT
#      LINES. That is right for an object id (one id per line) and WRONG for a
#      condition, which is a multi-line string: routing the read-back through it
#      made every re-run AFTER the grant existed die with a bogus
#      "AMBIGUOUS: N objects match" and NEVER reconcile — converting the F7
#      reconcile into a hard failure. The condition this bootstrap actually
#      authors IS multi-line (two clauses), so this was the normal path, not an
#      edge case. Both directions are exercised: no-op on match, reconcile on
#      drift. Uniqueness is still enforced — on the ID read, which is where it
#      belongs (scenario (5) below proves that guard is intact).
multiline_cond="(
 (
  !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
 )
 OR
 (
  @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals{11111111-1111-1111-1111-111111111111}
 )
)"
: > "$COND_LOG"; LIVE_ID="/ra/1"; LIVE_COND="$multiline_cond"
cond_status=0
ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "$multiline_cond" \
  >/dev/null 2>&1 || cond_status=$?
if [ "$cond_status" -eq 0 ] && [ ! -s "$COND_LOG" ]; then
  ok "conditioned grant: MULTI-LINE live condition that MATCHES -> compares and no-ops (does not die AMBIGUOUS)"
else bad "a multi-line live condition must be COMPARED as one value, not counted as N matches (exit=${cond_status}, log: $(cat "$COND_LOG"))"; fi

# ...and a multi-line live condition that DIFFERS still reconciles — IN PLACE.
: > "$COND_LOG"; LIVE_ID="/ra/1"; LIVE_COND="$multiline_cond"
cond_status=0
ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "${multiline_cond}
 AND (@Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase{'ServicePrincipal'})" \
  >/dev/null 2>&1 || cond_status=$?
if [ "$cond_status" -eq 0 ] && grep -q '^UPDATE' "$COND_LOG" \
   && ! grep -q '^DELETE' "$COND_LOG" && ! grep -q '^CREATE' "$COND_LOG"; then
  ok "conditioned grant: MULTI-LINE live condition that DRIFTED -> reconciled IN PLACE (update, no delete)"
else bad "a drifted multi-line condition must reconcile in place, not die AMBIGUOUS and not delete+create (exit=${cond_status}, log: $(cat "$COND_LOG"))"; fi

# CODE SHAPE: the condition read-back must not be routed through the
# line-counting uniqueness guard at all. The behavioural tests above are
# authoritative, but this pins the specific mistake so it cannot creep back in
# under a mock that happens to return a single-line condition.
cond_fn_body="$(awk '/^ensure_conditioned_role_assignment\(\)/{f=1} f{print} f&&/^}/{exit}' "$BOOT")"
if printf '%s\n' "$cond_fn_body" | grep -vE '^[[:space:]]*#' \
     | grep -q 'az_discover_unique.*condition'; then
  bad "the CONDITION read-back must not go through az_discover_unique (it counts lines; a condition is a multi-line VALUE)"
else ok "the condition read-back bypasses the line-counting uniqueness guard (reads a single value)"; fi

# (3) THE REGRESSION THIS EXISTS FOR: existing assignment whose live condition
#     DIFFERS -> reconcile, never a silent no-op.
: > "$COND_LOG"; LIVE_ID="/ra/1"; LIVE_COND="COND-OLD"
ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW" >/dev/null 2>&1
if grep -q '^UPDATE' "$COND_LOG" && grep -q 'COND-NEW' "$COND_LOG"; then
  ok "conditioned grant: STALE live condition -> reconciled with the new condition"
else bad "a stale live condition MUST be reconciled, not silently accepted (log: $(cat "$COND_LOG"))"; fi

# (3a) THE NO-GRANT WINDOW. Reconciling by DELETE-then-CREATE leaves an interval
#      in which the apply identity holds no RBAC-administrator grant at all.
#      Under MG-23 the dev apply runs AUTOMATICALLY on every merge to `main`, so
#      an operator re-running bootstrap can land on top of an in-flight apply:
#      Terraform then hits AuthorizationFailed part-way through a role-assignment
#      write and leaves the stack PARTIALLY APPLIED. The reconcile must therefore
#      be a single in-place update — the grant is never absent, and never exists
#      momentarily without a condition.
: > "$COND_LOG"; LIVE_ID="/ra/1"; LIVE_COND="COND-OLD"
ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW" >/dev/null 2>&1
if ! grep -q '^DELETE' "$COND_LOG" && ! grep -q '^CREATE' "$COND_LOG"; then
  ok "conditioned grant: reconcile NEVER deletes or re-creates (no no-grant window)"
else bad "reconciling a live condition must NOT delete+recreate the grant — that strips RBAC-admin mid-flight (log: $(cat "$COND_LOG"))"; fi

# (3b) The PUT body must change ONLY the condition. Everything identity-bearing —
#      principalId, roleDefinitionId, scope — is carried through verbatim, so a
#      malformed update cannot silently re-point the grant at a different
#      principal or a different (broader) role.
if grep -q '"principalId": *"oid"' "$COND_LOG" \
   && grep -qi 'RBAC-ADMIN-GUID' "$COND_LOG" \
   && grep -q '"conditionVersion": *"2.0"' "$COND_LOG"; then
  ok "conditioned grant: the in-place PUT preserves principalId/roleDefinitionId and pins conditionVersion 2.0"
else bad "the in-place update must carry the existing principalId and roleDefinitionId through verbatim at condition-version 2.0 (log: $(cat "$COND_LOG"))"; fi

# (3c) CODE SHAPE — pin the specific regression. The reconcile path must contain
#      no role-assignment DELETE at all, so delete+recreate cannot creep back in
#      under a mock that happens not to exercise it.
if printf '%s\n' "$cond_fn_body" | grep -vE '^[[:space:]]*#' \
     | grep -q 'az role assignment delete'; then
  bad "ensure_conditioned_role_assignment must not delete a role assignment — reconcile IN PLACE (delete+create opens a no-grant window)"
else ok "ensure_conditioned_role_assignment contains no role-assignment delete (in-place reconcile only)"; fi

# (3d) THE POST-UPDATE READ-BACK (MG-23 red). A 2xx from `az role assignment
#      update` means ARM ACCEPTED the PUT, NOT that the new condition is what it
#      will enforce. Those come apart routinely: a partially-applied PUT, an
#      unconverged RBAC replica, a future az/ARM that ignores a field it does not
#      recognize. In every such case an unverified helper prints "reconciled" and
#      exits 0 over a grant still carrying the STALE condition — which is the
#      FROZEN-CONDITION failure this helper exists to prevent, reintroduced one
#      layer up, and now wearing a green bootstrap log. The operator's next signal
#      would be an apply dying mid-run with AuthorizationFailed.
#
#      NEGATIVE PATH: with UPDATE_DURABLE=0 the mock ACCEPTS the update (exit 0,
#      as ARM would) but does NOT store it, so the read-back still returns the old
#      condition. The helper MUST FAIL. A pass here means the verification is
#      absent or vacuous.
#      RUN IT IN A SUBSHELL — `if ( … )`, exactly like scenario (4) below. The
#      helper reports this failure with `die`, which `exit`s; called in THIS
#      shell it would terminate the whole test run at the first correct
#      behaviour. The subshell contains the exit so it reads as a boolean, and it
#      also keeps the mock's LIVE_* mutations from leaking into later scenarios.
#      COND_LOG is a file, so what the helper actually sent still survives.
#      COND_READBACK_* are pinned small here for the same reason scenario (1d)
#      pins them: the post-update read-back is RETRIED (see 3d-lag below), so at
#      the production defaults this negative case would sleep through the whole
#      5 x 3s budget before failing. The bounds only change how LONG the mismatch
#      is retried, never WHETHER a durable mismatch fails — which is the property
#      under test.
: > "$COND_LOG"; LIVE_ID="/ra/1"; LIVE_COND="COND-OLD"
if ( UPDATE_DURABLE=0 COND_READBACK_ATTEMPTS=2 COND_READBACK_DELAY=0 \
     ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW" >/dev/null 2>&1 ); then
  bad "an update ARM accepts but does not durably store MUST fail the helper — it left a stale condition live while reporting success (log: $(cat "$COND_LOG"))"
elif grep -q '^UPDATE' "$COND_LOG"; then
  ok "conditioned grant: an ACCEPTED-BUT-NOT-STORED update is caught by the read-back and FAILS (no false success)"
else bad "the helper failed, but never issued the in-place UPDATE — it failed for the wrong reason, so the read-back verification is not what was tested (log: $(cat "$COND_LOG"))"; fi

#      ...and the POSITIVE path: a durable update verifies and SUCCEEDS. Without
#      this, a helper that always failed after an update would satisfy the
#      negative case above while being unusable.
: > "$COND_LOG"; LIVE_ID="/ra/1"; LIVE_COND="COND-OLD"
cond_status=0
ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW" \
  >/dev/null 2>&1 || cond_status=$?
if [ "$cond_status" -eq 0 ] && grep -q '^UPDATE' "$COND_LOG"; then
  ok "conditioned grant: a DURABLE update verifies by read-back and succeeds"
else bad "a durable in-place update must verify and succeed (exit=${cond_status}, log: $(cat "$COND_LOG"))"; fi

# (3d-lag) REPLICA LAG ON THE POST-UPDATE READ-BACK IS RETRIED, NOT REPORTED AS A
#      VERIFICATION FAILURE. ARM role-assignment write->read is eventually
#      consistent in BOTH directions — the CREATE path has retried for exactly
#      this reason since (1d), and an in-place PUT is no more instantly readable
#      than a create. An unretried post-update read lands on a replica that has
#      not converged, sees the STALE condition, and aborts a bootstrap whose
#      update in fact SUCCEEDED — turning routine RBAC lag into a hard failure on
#      the highest-privilege grant in the repo.
#
#      The mock stores the PUT durably and then lies to the first two condition
#      reads (LAG_STALE_READS=2 — the pre-update drift read plus the first
#      post-update read-back), exactly as a lagging replica would. The helper must
#      RETRY and SUCCEED. Asserted on three things together, because any one alone
#      is satisfiable by a helper that never verifies at all: exit 0, the UPDATE
#      really was issued, and the condition was read back MORE THAN ONCE after it
#      (>= 3 reads total) — that last one is what proves the retry ran rather than
#      the lag model quietly failing to engage.
: > "$COND_LOG"; LIVE_ID="/ra/1"; LIVE_COND="COND-OLD"
LAG_COUNT_FILE="$(mktemp)"; printf '0' > "$LAG_COUNT_FILE"
lag_status=0
( LAG_STALE_READS=2 LAG_STALE_COND="COND-OLD" COND_READBACK_ATTEMPTS=5 COND_READBACK_DELAY=0 \
  ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW" >/dev/null 2>&1 ) \
  || lag_status=$?
lag_reads="$(cat "$LAG_COUNT_FILE")"
if [ "$lag_status" -eq 0 ] && grep -q '^UPDATE' "$COND_LOG" && [ "$lag_reads" -ge 3 ]; then
  ok "conditioned grant: post-update REPLICA LAG is retried and converges (lag is not a verification failure)"
else bad "a post-update read-back that lags then converges must be RETRIED and succeed, like the create path (exit=${lag_status}, condition reads=${lag_reads}, log: $(cat "$COND_LOG"))"; fi
rm -f "$LAG_COUNT_FILE"
unset LAG_COUNT_FILE

# (3d-bounds) CODE SHAPE — the update path must REUSE the create path's retry
#      bounds, not invent a second, independently-tunable strategy. Two knobs
#      would drift: a future change tightening one would silently leave the other
#      at the old budget, and the one left behind is whichever path the change
#      author was not looking at. Pin that BOTH read-back loops read the SAME two
#      environment overrides with the SAME defaults.
d3d_attempt_defaults="$(printf '%s\n' "$cond_fn_body" | grep -vE '^[[:space:]]*#' \
  | grep -c 'COND_READBACK_ATTEMPTS:-5' || true)"
d3d_delay_defaults="$(printf '%s\n' "$cond_fn_body" | grep -vE '^[[:space:]]*#' \
  | grep -c 'COND_READBACK_DELAY:-3' || true)"
if [ "$d3d_attempt_defaults" -eq 2 ] && [ "$d3d_delay_defaults" -eq 2 ]; then
  ok "conditioned grant: create and update read-backs share ONE retry strategy (same bounds, same defaults)"
else bad "both the create and the update read-back must use the SAME retry bounds (COND_READBACK_ATTEMPTS:-5 / COND_READBACK_DELAY:-3); got attempts=${d3d_attempt_defaults}, delay=${d3d_delay_defaults} (expected 2 each)"; fi

# (3e) CODE SHAPE — the post-update read-back must be a SINGLE-VALUE query, never
#      routed through the line-counting uniqueness guard. The real condition is
#      multi-line (two clauses), and az_discover_unique counts OUTPUT LINES to
#      decide how many objects matched — so routing the verification through it
#      would die "AMBIGUOUS: N objects match" on every genuine reconcile. This is
#      the same mistake (2c) pinned for the drift read; pin it for the
#      verification read too, since it is a second, later call.
d3e_unique_count="$(printf '%s\n' "$cond_fn_body" | grep -vE '^[[:space:]]*#' \
  | grep -c 'az_discover_unique' || true)"
d3e_cond_reads="$(printf '%s\n' "$cond_fn_body" | grep -vE '^[[:space:]]*#' \
  | grep -c '\[0\].condition' || true)"
#      COUNTS UPDATED when the CREATE path gained its own read-back: there are
#      now TWO az_discover_unique calls, and both are `[].id` reads (the
#      pre-create existence read and the post-create uniqueness re-establish) —
#      the invariant being pinned is unchanged, namely that NO condition read
#      goes through the uniqueness guard. Condition reads rise to three: drift,
#      post-update verify, post-create verify.
if [ "$d3e_unique_count" -eq 2 ] && [ "$d3e_cond_reads" -ge 3 ]; then
  ok "conditioned grant: all three condition reads (drift + post-update + post-create verify) are single-value; only the two [].id reads use the uniqueness guard"
else bad "expected exactly TWO az_discover_unique calls (both [].id reads) and at least THREE single-value [0].condition reads (drift + post-update + post-create verification); got unique=${d3e_unique_count}, condition-reads=${d3e_cond_reads}"; fi
#      ...and pin the invariant DIRECTLY, not just by count: no az_discover_unique
#      call in this function may be a condition read.
if printf '%s\n' "$cond_fn_body" | grep -vE '^[[:space:]]*#' \
     | grep -A6 'az_discover_unique' | grep -q '\[0\].condition'; then
  bad "no condition read may be routed through az_discover_unique — its line-counting uniqueness guard reads a multi-line condition as N matching objects"
else ok "conditioned grant: no az_discover_unique call reads a condition (only [].id)"; fi

# (4) An EMPTY condition must be refused outright — a 'conditioned' RBAC-admin
#     grant with no condition is a full RBAC-administrator grant.
: > "$COND_LOG"; LIVE_ID=""; LIVE_COND=""
if (ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "" >/dev/null 2>&1); then
  bad "ensure_conditioned_role_assignment must REFUSE an empty condition (that is an unconditioned RBAC-admin grant)"
else ok "ensure_conditioned_role_assignment refuses an empty condition"; fi

# (5) The uniqueness guard on the ASSIGNMENT ID is still intact — fixing (2c)
#     must not have loosened it. TWO matching assignment ids is genuine
#     ambiguity (reconciling one and leaving the other is a silent half-fix on
#     an RBAC-administrator grant), so it must still DIE rather than pick one.
#
#     Run in a FRESH `bash -c` with `set -euo pipefail`, exactly as bootstrap.sh
#     runs for real — NOT via `if ( … )`. `az_discover_unique`'s `die` exits the
#     `$( … )` command substitution it is called from, and the caller aborts
#     because the FAILED ASSIGNMENT trips `set -e`. Inside an `if` condition the
#     shell suppresses `set -e`, so an `if ( … )` wrapper would let the caller
#     sail past the die with an empty id and CREATE a duplicate grant — i.e. the
#     test would report a bug the production path does not have. This shape
#     tests the real semantics; assert on the ambiguity message and on the
#     mutation log, which must be empty.
AMBIG_LOG="$(mktemp)"
: > "$COND_LOG"
COND_LOG="$COND_LOG" "$BASH" -c '
  set -euo pipefail
  source "$1"
  az() {
    case "$*" in
      *"role assignment list"*"[].id"*) printf "/ra/1\n/ra/2" ;;
      *"role assignment list"*"-o json"*) printf "%s" "{\"id\":\"/ra/1\",\"condition\":\"COND-OLD\"}" ;;
      *"role assignment list"*condition*) printf "COND-OLD" ;;
      *"role assignment update"*) echo "UPDATE $*" >> "$COND_LOG" ;;
      *"role assignment create"*) echo "CREATE $*" >> "$COND_LOG" ;;
      *"role assignment delete"*) echo "DELETE $*" >> "$COND_LOG" ;;
      *) return 0 ;;
    esac
  }
  ensure_conditioned_role_assignment oid ServicePrincipal "RBAC Admin" /scope "COND-NEW"
  echo "REACHED-END-WITHOUT-DYING"
' _ "$BOOT" >"$AMBIG_LOG" 2>&1 && ambig_rc=0 || ambig_rc=$?

if [ "${ambig_rc}" -ne 0 ] && grep -q 'AMBIGUOUS' "$AMBIG_LOG" \
   && ! grep -q 'REACHED-END-WITHOUT-DYING' "$AMBIG_LOG"; then
  ok "conditioned grant: >1 matching assignment id still dies AMBIGUOUS (uniqueness guard intact)"
else bad "TWO matching role assignments must still be AMBIGUOUS -> die (rc=${ambig_rc}, output: $(cat "$AMBIG_LOG"))"; fi
[ ! -s "$COND_LOG" ] \
  && ok "conditioned grant: an ambiguous id set mutates NOTHING (no create, no update, no delete)" \
  || bad "an ambiguous assignment set must not create, update or delete anything (log: $(cat "$COND_LOG"))"
rm -f "$AMBIG_LOG"

unset -f az
rm -f "$COND_LOG"

# ===========================================================================
# MG-23 F8: stale federated credentials are PRUNED, not merely left unmentioned
# ===========================================================================
# MG-23 reassigns which identity owns the bare `development` environment (it is
# now the app-deploy identity's). Without a prune, an identity bootstrapped under
# an earlier revision KEEPS its old credential trusting `…:environment:development`
# — so a job in that environment could still assume the wrong identity. Trust is
# revoked by DELETING the credential, not by ceasing to grant it.
#
# The fixture below uses a name that is NOT in the current environment map, on
# purpose: it exercises "delete what is not expected" without depending on any
# particular environment still existing.
if grep -q '^prune_unexpected_federated_credentials()' "$BOOT"; then
  ok "prune_unexpected_federated_credentials helper exists"
else bad "bootstrap must prune federated credentials outside each identity's expected set"; fi
PRUNE_LOG="$(mktemp)"
FED_LIST="github-legacy-sandbox
github-development-infra-apply"
az() {
  case "$*" in
    *"federated-credential list"*) printf '%s\n' "$FED_LIST" ;;
    *"federated-credential delete"*) echo "DELETE $*" >> "$PRUNE_LOG" ;;
    *) return 0 ;;
  esac
}
: > "$PRUNE_LOG"
prune_unexpected_federated_credentials app-1 "github-development-infra-apply" >/dev/null 2>&1
if grep -q 'github-legacy-sandbox' "$PRUNE_LOG" && ! grep -q 'github-development-infra-apply' "$PRUNE_LOG"; then
  ok "prune DELETES the unexpected stale credential and KEEPS the expected one"
else bad "prune must delete only unexpected credentials (log: $(cat "$PRUNE_LOG"))"; fi
# Nothing is deleted when the live set already matches.
: > "$PRUNE_LOG"; FED_LIST="github-development-infra-apply"
prune_unexpected_federated_credentials app-1 "github-development-infra-apply" >/dev/null 2>&1
[ ! -s "$PRUNE_LOG" ] && ok "prune is a no-op when the live credential set already matches" \
  || bad "prune must not delete an expected credential (log: $(cat "$PRUNE_LOG"))"
unset -f az
rm -f "$PRUNE_LOG"
# Every identity function prunes (three call sites: plan, app-deploy, infra-apply).
prune_sites="$(grep -c 'prune_unexpected_federated_credentials "\$app_id"' "$BOOT" || true)"
[ "${prune_sites:-0}" -eq 3 ] \
  && ok "all three identities prune their federated credentials (${prune_sites}/3)" \
  || bad "each identity must prune its federated credentials (found ${prune_sites}, expected 3)"

# ===========================================================================
# MG-23: the infra-apply identity is OIDC-only, distinct, and emits its client id
# ===========================================================================
if grep -q '^bootstrap_infra_apply_identity()' "$BOOT"; then
  ok "bootstrap_infra_apply_identity exists"
else bad "bootstrap must provision the dev infra-apply identity"; fi
# A FOURTH distinct AAD app — never a reuse of the plan or app-deploy app.
if [ -n "${AAD_INFRA_APPLY_APP_NAME:-}" ] \
   && [ "${AAD_INFRA_APPLY_APP_NAME:-}" != "${AAD_APP_NAME:-}" ] \
   && [ "${AAD_INFRA_APPLY_APP_NAME:-}" != "${AAD_DEPLOY_APP_NAME:-}" ] \
   && [ "${AAD_INFRA_APPLY_APP_NAME:-}" != "${DEV_API_APP_NAME:-}" ]; then
  ok "the infra-apply identity is a SEPARATE AAD app from plan / app-deploy / API"
else bad "AAD_INFRA_APPLY_APP_NAME must be distinct from every other app name"; fi
# It emits the client id the apply workflow consumes, distinct from the others.
if grep -q 'AZURE_INFRA_APPLY_CLIENT_ID' "$BOOT"; then
  ok "bootstrap emits AZURE_INFRA_APPLY_CLIENT_ID for the apply workflow"
else bad "bootstrap must emit AZURE_INFRA_APPLY_CLIENT_ID"; fi
# NO Microsoft Graph permission is ever requested for it — that closure is what
# stops the apply identity minting itself a second identity (F18).
if grep -Eq 'az ad app permission (add|grant|admin-consent)' "$BOOT"; then
  bad "no identity may be granted Microsoft Graph permissions (F18: that escalation path must stay CLOSED)"
else ok "no Microsoft Graph permission grant anywhere (F18 closed path)"; fi
# The F18 preconditions are recorded IN the code, so a future change that breaks
# them has to delete a comment that says it is breaking the threat model.
if grep -q 'F18' "$BOOT" && grep -qi 'INVALIDATES this' "$BOOT" && grep -qi 'threat model' "$BOOT"; then
  ok "the F18 closed-escalation-path preconditions are recorded in bootstrap.sh"
else bad "bootstrap.sh must record the F18 preconditions (no Graph, no subscription scope, separate state RG) as invalidating"; fi
# The three empirical facts the condition rests on are surfaced to the operator
# as BLOCKING pre-activation checks, not silently assumed.
if grep -q 'BLOCKING PRE-ACTIVATION CHECKS' "$BOOT" && grep -q 'mg23-live-acceptance.md' "$BOOT"; then
  ok "bootstrap prints the blocking pre-activation checklist and points at the acceptance doc"
else bad "bootstrap must print the B1/B2/B3 blocking pre-activation checks and reference mg23-live-acceptance.md"; fi
# This run creates no live SP and flips no switch.
if grep -q 'does NOT set DEV_TF_BACKEND_READY' "$BOOT"; then
  ok "bootstrap states plainly that it does not activate the loop (DEV_TF_BACKEND_READY untouched)"
else bad "bootstrap must state that it does not set DEV_TF_BACKEND_READY"; fi

# ===========================================================================
# MG-23 finding 5: no UNREACHABLE state-account fallback, and no az_discover
# misuse on `az storage account show`
# ===========================================================================
# az_discover's own contract says it is for LIST-style queries only — a query
# whose EMPTY result means "absent". `az … show` returns NON-ZERO for not-found,
# so az_discover DIES on an absent account and can never return empty. Three
# call sites nevertheless wrapped their blob-data grant in
# `if [ -n "$state_sa_id" ] … else warn "…run state bootstrap first" fi`, so
# those else-branches were UNREACHABLE and their guidance was wrong: an operator
# hitting that case would actually see az_discover's "REAL Azure error" message,
# never the warning. The account is also guaranteed to exist by then —
# bootstrap_state_backend runs first in main().
#
# Both halves are pinned. Removing the dead branch without also pinning the
# lookup shape would let a future edit reintroduce `az_discover … show`, which
# would restore the same unreachable-branch confusion one layer down.
if grep -q 'State storage account not found for blob-role scope' "$BOOT"; then
  bad "the UNREACHABLE state-account fallback branch is back — az_discover dies on an absent account (az … show returns non-zero for not-found), so this warn can never be reached and its 'run state bootstrap first' guidance is wrong"
else ok "no unreachable state-account fallback branch (the absent-account case cannot occur: bootstrap_state_backend runs first and the lookup fails loud)"; fi

if printf '%s\n' "$(grep -A3 'az_discover ' "$BOOT")" | grep -q 'az storage account show'; then
  bad "az_discover must not be used with 'az storage account show' — az_discover is for LIST-style queries whose empty result means ABSENT, and 'show' returns non-zero for not-found, so absence and error become indistinguishable"
else ok "no az_discover invocation wraps 'az storage account show' (single-value show reads go through state_account_id, which fails loud)"; fi

# ...and the three grant summaries the runbook and downstream readers rely on
# must survive the branch removal. Deleting the dead `else` is only correct if
# the SUCCESS path it wrapped is still there and still unconditional.
sa_grant_oks="$(grep -c 'granted on container' "$BOOT" || true)"
if [ "$sa_grant_oks" -eq 3 ]; then
  ok "all three container-scoped grant confirmations survive the fallback removal (now unconditional)"
else bad "expected exactly 3 'granted on container' confirmations after removing the unreachable fallback; got ${sa_grant_oks}"; fi

# ===========================================================================
# FAIL-FAST PRECONDITIONS AND ERREXIT-SAFE GRANTS
# ---------------------------------------------------------------------------
# One theme runs through all of these: bootstrap.sh MUTATES LIVE RBAC under
# `set -euo pipefail`, so anything that can abort it mid-sequence, or let it
# sail past a guard, leaves the operator with a half-provisioned identity
# boundary. Each assertion below pins one such path shut.
# ===========================================================================

# --- T1: the tool preflight is enumerated and runs before any mutation ------
# A missing binary discovered mid-run aborts exactly where it hurts. The
# motivating case: sha1 is needed by stable_guid, whose only caller runs AFTER
# every RBAC grant and BEFORE either GitHub Environment is protected — so on a
# machine without `sha1sum` (every macOS box) the run ended with all grants live
# and zero protected environments.
req_missing=""
for t in az gh jq mktemp awk sed sort tr cut grep wc paste rm; do
  case " ${REQUIRED_TOOLS:-} " in
    *" $t "*) : ;;
    *) req_missing="${req_missing:+${req_missing} }${t}" ;;
  esac
done
# The sha1 tool is satisfied by EITHER implementation, so it is checked by name
# in the preflight body rather than listed as a plain tool name.
req_fn="$(awk '/^require_tools\(\)/{f=1} f{print} f&&/^}/{exit}' "$BOOT")"
printf '%s\n' "$req_fn" | grep -q 'resolve_sha1_cmd' \
  || req_missing="${req_missing:+${req_missing} }sha1"
if [ -z "$req_missing" ]; then
  ok "T1: the tool preflight enumerates every external binary bootstrap.sh needs (incl. gh, jq and a sha1 tool)"
else bad "T1: require_tools must check these tools before any mutation, missing: ${req_missing}"; fi

# The hard `sha1sum` dependency is gone — it is resolved, not assumed.
if grep -q '| sha1sum' "$BOOT"; then
  bad "T1: bootstrap.sh must not pipe to a bare 'sha1sum' (macOS ships 'shasum', not 'sha1sum')"
else ok "T1: no bare '| sha1sum' — the sha1 implementation is resolved (sha1sum OR shasum)"; fi

# ...and PROVE it functionally: with sha1sum off PATH, stable_guid must still
# produce a GUID, and THE SAME GUID. That equality is load-bearing — stable_guid
# exists so a re-run reuses the same delegated-permission scope id instead of
# minting a duplicate, so a digest that moved with the operator's OS would break
# idempotence just as surely as a crash.
guid_with="$(stable_guid seed)"
sha1_farm="$(mktemp -d)"
for b in cut shasum; do
  b_src="$(command -v "$b" 2>/dev/null || true)"
  [ -n "$b_src" ] && ln -sf "$b_src" "$sha1_farm/$b"
done
if [ -e "$sha1_farm/shasum" ]; then
  guid_without="FAILED"
  guid_without="$( PATH="$sha1_farm" SHA1_CMD="" stable_guid seed )" || guid_without="FAILED"
  if [ "$guid_without" = "$guid_with" ] \
     && printf '%s' "$guid_without" | grep -qE '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
    ok "T1: stable_guid works with sha1sum OFF PATH and derives the IDENTICAL GUID (idempotence preserved)"
  else bad "T1: stable_guid must fall back to shasum and derive the same GUID (with=${guid_with}, without=${guid_without})"; fi
else
  # No shasum on this machine — assert the fallback exists in source instead, so
  # the assertion count stays stable across platforms.
  if printf '%s\n' "$(awk '/^resolve_sha1_cmd\(\)/{f=1} f{print} f&&/^}/{exit}' "$BOOT")" \
       | grep -q 'shasum'; then
    ok "T1: stable_guid resolves a sha1 tool with a shasum fallback (shasum absent here; source-asserted)"
  else bad "T1: resolve_sha1_cmd must fall back to 'shasum -a 1' when sha1sum is absent"; fi
fi
rm -rf "$sha1_farm"

# The preflight is worthless if it runs after the first mutation. It must come
# before the environment-map assertion and before every bootstrap_* step. (A
# banner `log` ahead of it is not a mutation and does not count.)
main_body="$(awk '/^main\(\)/{f=1} f{print} f&&/^}/{exit}' "$BOOT")"
# COMMENTS STRIPPED before any ordering check: main()'s comments legitimately
# NAME the calls they describe, so an ordering assertion over the raw body
# measures prose placement rather than execution order.
main_code="$(printf '%s\n' "$main_body" | grep -vE '^[[:space:]]*#')"
req_line="$(printf '%s\n' "$main_code" | grep -n 'require_tools' | head -1 | cut -d: -f1)"
first_work="$(printf '%s\n' "$main_code" | grep -nE 'assert_federated_environment_map|bootstrap_[a-z_]+' \
  | head -1 | cut -d: -f1)"
if [ -n "$req_line" ] && [ -n "$first_work" ] && [ "$req_line" -lt "$first_work" ]; then
  ok "T1: require_tools runs BEFORE any mutation in main() (nothing is provisioned when it dies)"
else bad "T1: require_tools must be the first work main() does (got require_tools@${req_line:-none}, first step@${first_work:-none})"; fi

# --- T2: the blocking pre-activation gate actually BLOCKS -------------------
# It used to be a `warn` printed AFTER "Bootstrap complete", with main()
# returning 0 — so the one condition that must stop activation was a yellow line
# under a green summary, and the exit status said everything was fine.
t2_save_apply="$APPLY_ENV_STATUS"; t2_save_rec="$RECOVERY_ENV_STATUS"

APPLY_ENV_STATUS="PROTECTED"; RECOVERY_ENV_STATUS="UNVERIFIED"
t2_rc=0; assert_environments_protected >/dev/null 2>&1 || t2_rc=$?
[ "$t2_rc" -ne 0 ] \
  && ok "T2: an UNVERIFIED recovery environment fails the gate (non-zero)" \
  || bad "T2: the gate must FAIL when the recovery environment is not PROTECTED (rc=${t2_rc})"

APPLY_ENV_STATUS="UNVERIFIED"; RECOVERY_ENV_STATUS="PROTECTED"
t2_rc=0; assert_environments_protected >/dev/null 2>&1 || t2_rc=$?
[ "$t2_rc" -ne 0 ] \
  && ok "T2: an UNVERIFIED apply environment fails the gate (non-zero)" \
  || bad "T2: the gate must FAIL when the apply environment is not PROTECTED (rc=${t2_rc})"

APPLY_ENV_STATUS="PROTECTED"; RECOVERY_ENV_STATUS="PROTECTED"
t2_rc=0; assert_environments_protected >/dev/null 2>&1 || t2_rc=$?
[ "$t2_rc" -eq 0 ] \
  && ok "T2: BOTH environments PROTECTED passes the gate (exit 0)" \
  || bad "T2: the gate must PASS when both environments are PROTECTED (rc=${t2_rc})"

APPLY_ENV_STATUS="$t2_save_apply"; RECOVERY_ENV_STATUS="$t2_save_rec"

# ...and main() must not print its success line unless the gate passed.
t2_gate_line="$(printf '%s\n' "$main_code" | grep -n 'assert_environments_protected' | head -1 | cut -d: -f1)"
t2_done_line="$(printf '%s\n' "$main_code" | grep -n 'Bootstrap complete' | head -1 | cut -d: -f1)"
if [ -n "$t2_gate_line" ] && [ -n "$t2_done_line" ] && [ "$t2_gate_line" -lt "$t2_done_line" ]; then
  ok "T2: main() calls the gate BEFORE printing 'Bootstrap complete' (no success line behind a failed check)"
else bad "T2: main() must call assert_environments_protected before the success line (gate@${t2_gate_line:-none}, success@${t2_done_line:-none})"; fi

# --- T4: a failed/ambiguous discovery cannot fall through to a create -------
# The operator state grant used to be written `ensure_role_assignment … || die`.
# Putting the CALL in a `||` context suppresses errexit for the whole function
# body, and az_discover_unique's `die` runs inside a command-substitution
# SUBSHELL — so an AMBIGUOUS (>1 match) or errored discovery killed only the
# subshell, left `existing` empty, and execution continued into the create.
T4_LOG="$(mktemp)"
"$BASH" -c '
  set -euo pipefail
  source "$1"
  az() {
    case "$*" in
      *"role assignment list"*"[].id"*) printf "/ra/1\n/ra/2" ;;
      *"role assignment create"*) echo "CREATE $*" ;;
      *) return 0 ;;
    esac
  }
  ensure_role_assignment oid User "Storage Blob Data Contributor" /subscriptions/s/rg/sa
  echo "REACHED-END-WITHOUT-DYING"
' _ "$BOOT" >"$T4_LOG" 2>&1 && t4_rc=0 || t4_rc=$?
if [ "$t4_rc" -ne 0 ] && grep -q 'AMBIGUOUS' "$T4_LOG" \
   && ! grep -q 'CREATE' "$T4_LOG" && ! grep -q 'REACHED-END-WITHOUT-DYING' "$T4_LOG"; then
  ok "T4: an AMBIGUOUS discovery in ensure_role_assignment fails LOUD and creates NOTHING"
else bad "T4: >1 matching assignment must abort before the create (rc=${t4_rc}, out: $(cat "$T4_LOG"))"; fi
rm -f "$T4_LOG"

# --- T4b: the SAME guarantee for the HIGHER-PRIVILEGE conditioned sibling ----
# ensure_conditioned_role_assignment mints the RBAC-ADMINISTRATOR grant, so a
# fall-through here is strictly worse than in the unconditioned helper above:
# an AMBIGUOUS or errored discovery that lands empty sends execution into the
# CREATE branch, issuing a second conditioned RBAC-administrator assignment on
# top of a set the bootstrap just admitted it could not read.
#
# NOTE ON WHY THIS IS A SEPARATE TEST: T4's greps match the literal substring
# `ensure_role_assignment` — which does NOT appear inside
# `ensure_conditioned_role_assignment` (`ensure_` is followed by `conditioned_`,
# not by `role_assignment`). The conditioned helper was therefore invisible to
# every assertion above. Name it explicitly or it stays unguarded.
T4B_LOG="$(mktemp)"
"$BASH" -c '
  set -euo pipefail
  source "$1"
  az() {
    case "$*" in
      *"role assignment list"*"[].id"*) printf "/ra/1\n/ra/2" ;;
      *"role assignment create"*) echo "CREATE $*" ;;
      *"role assignment update"*) echo "UPDATE $*" ;;
      *) return 0 ;;
    esac
  }
  # THE CALL SITE DELIBERATELY SUPPRESSES ERREXIT (`|| true`). This is the whole
  # point of the test and the only shape that distinguishes a guarded discovery
  # from an unguarded one. Called BARE under `set -e`, even an UNGUARDED
  # assignment aborts — the non-zero command substitution trips errexit on its
  # own, so a bare call passes this test whether or not the guard is present.
  # Put the call in a conditional context and errexit switches OFF for the whole
  # function body: only the in-function `|| exit 1`, which runs `exit` in the
  # CURRENT shell, can still stop the fall-through into the create.
  ensure_conditioned_role_assignment oid ServicePrincipal "Role Based Access Control Administrator" /subscriptions/s/rg "@Request[x] StringEquals 1" || true
  echo "REACHED-END-WITHOUT-DYING"
' _ "$BOOT" >"$T4B_LOG" 2>&1 && t4b_rc=0 || t4b_rc=$?
if [ "$t4b_rc" -ne 0 ] && grep -q 'AMBIGUOUS' "$T4B_LOG" \
   && ! grep -q 'CREATE' "$T4B_LOG" && ! grep -q 'UPDATE' "$T4B_LOG" \
   && ! grep -q 'REACHED-END-WITHOUT-DYING' "$T4B_LOG"; then
  ok "T4b: an AMBIGUOUS discovery in ensure_conditioned_role_assignment fails LOUD and creates/updates NOTHING"
else bad "T4b: >1 matching assignment must abort ensure_conditioned_role_assignment before the create (rc=${t4b_rc}, out: $(cat "$T4B_LOG"))"; fi
rm -f "$T4B_LOG"

# ...and the conditioned helper must carry the `|| exit 1` on EVERY discovery in
# its body, not just the pre-create one. Each az_discover/az_discover_unique
# command substitution inside the function is a place a subshell `die` can be
# swallowed, so count them and require one `|| exit 1` per discovery.
t4b_fn="$(awk '/^ensure_conditioned_role_assignment\(\)/{f=1} f{print} f&&/^}/{exit}' "$BOOT")"
t4b_disc="$(printf '%s\n' "$t4b_fn" | grep -cE '="\$\(az_discover(_unique)? ' || true)"
t4b_guard="$(printf '%s\n' "$t4b_fn" | grep -cE '\)"[[:space:]]*\|\|[[:space:]]*exit 1[[:space:]]*$' || true)"
if [ "$t4b_disc" -gt 0 ] && [ "$t4b_disc" -eq "$t4b_guard" ]; then
  ok "T4b: all ${t4b_disc} discoveries in ensure_conditioned_role_assignment carry '|| exit 1' (no swallowed subshell die)"
else bad "T4b: ensure_conditioned_role_assignment has ${t4b_disc} discovery call(s) but only ${t4b_guard} '|| exit 1' guard(s) — an unguarded discovery lets a failed/ambiguous read fall through inside the RBAC-administrator helper"; fi

# ...and no call site of EITHER helper may reintroduce the suppressing context.
# `if ! ensure_… ` is not an acceptable alternative to `|| die`: it suppresses
# errexit identically. Both names are checked — the conditioned helper is the
# higher-privilege one and must fail loud exactly as its sibling does.
for t4_fn_name in ensure_role_assignment ensure_conditioned_role_assignment; do
  # -A1 so a backslash-continued call (the conditioned grant spans two lines)
  # has its continuation inspected too. Anchor with a word boundary so
  # `ensure_role_assignment` does not also match the conditioned helper's own
  # call sites and double-report them.
  t4_calls="$(grep -vE '^[[:space:]]*#' "$BOOT" | grep -A1 -E "(^|[^_])${t4_fn_name} \"" || true)"
  if printf '%s\n' "$t4_calls" | grep -qE '\|\||^[[:space:]]*if ! ' ; then
    bad "T4: no ${t4_fn_name} call site may sit in a '|| …' or 'if ! …' context — that suppresses errexit inside the function and lets a failed discovery fall through to a create"
  else ok "T4: every ${t4_fn_name} call site is BARE (errexit and the guards stay in force)"; fi
done

# --- T5: no unreachable state-account fallbacks, no az_discover misuse -------
# az_discover is documented for LIST-style queries whose empty result means
# "absent"; `az … show` exits NON-ZERO for not-found, so routing show through it
# could only ever die or return a value — never the empty string the three
# `else warn "run state bootstrap first"` branches were written to catch. The
# branches were dead and their guidance was wrong.
if grep -q 'State storage account not found for blob-role scope' "$BOOT"; then
  bad "T5: the unreachable state-account fallback branches (and their wrong guidance) must be gone"
else ok "T5: no unreachable 'state storage account not found' fallback remains"; fi
if grep -vE '^[[:space:]]*#' "$BOOT" | grep -A2 'az_discover "' | grep -q 'az storage account show'; then
  bad "T5: az_discover must not be used with 'az storage account show' — it is a LIST-style helper and show exits non-zero for not-found"
else ok "T5: no az_discover invocation wraps 'az storage account show' (the lookup asserts non-empty directly)"; fi

echo "-----------------------------------------"
echo "passed=$pass failed=$fail"
[ "$fail" -eq 0 ]
