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
#   2. The PROD GitHub-Actions OIDC PLAN/READ IDENTITY — an Azure AD application
#      + service principal with a single FEDERATED credential scoped to the
#      `production` GitHub Environment, granted a least-privilege PLAN/READ-ONLY
#      role (Reader + a container-scoped state role). No client secret is ever
#      created (OIDC = no long-lived secret).
#      THERE IS NO DEV PLAN IDENTITY (MG-23, re-scoped 2026-07-27). Dev PR
#      validation is CREDENTIALLESS — it authenticates to nothing — so the only
#      identity that ever touched dev state from a pull request has been deleted
#      rather than narrowed. Prod keeps its plan identity because
#      infra-deploy-prod.yml still logs in as it, and that workflow is
#      workflow_dispatch-only behind a protected environment, never PR-reachable.
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
#   5. The dev INFRA-APPLY IDENTITY (MG-23) — a FOURTH, distinct AAD app + SP,
#      OIDC-only, that .github/workflows/infra-apply-dev.yml uses to run the
#      AUTOMATED dev GitOps reconciliation (CI-run apply on merge to main). It is
#      NOT the plan identity and NOT the app-deploy identity. It is granted
#      EXACTLY: Contributor scoped to meatgeek-v2-dev-rg; "Role Based Access
#      Control Administrator" scoped to the same RG and CONDITIONED (ABAC v2.0) to
#      the Terraform-managed role allowlist in tf-managed-role-allowlist.tsv;
#      Storage Blob Data Contributor on the tfstate-dev container. NO
#      subscription-wide permission, NO Microsoft Graph permission, no secret.
#
# TERMS (use these precisely — they name two DIFFERENT things):
#   MG-24 = Terraform reconciliation, OPERATOR-run apply from a workstation.
#   MG-23 = automated dev GitOps reconciliation, CI-run apply on merge to main.
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
#     Contributor/Owner — and the DEV plan identity additionally holds NO write
#     or delete authority over Terraform STATE (Storage Blob Data READER on the
#     tfstate-dev container; any pre-existing write-capable blob-data role is
#     actively REVOKED on every run). The ONLY identity here that may write
#     infrastructure is the MG-23 dev INFRA-APPLY identity, and only inside
#     meatgeek-v2-dev-rg.
#     Bootstrap itself, resource-group creation, subscription-scoped
#     configuration and disaster recovery remain OPERATOR actions per the
#     bootstrap runbook; steady-state dev reconciliation is CI-run (MG-23).
#   * NO identity created here is granted Owner, User Access Administrator, or an
#     UNCONDITIONED "Role Based Access Control Administrator" anywhere.
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
# SUBJECT is scoped per GitHub Environment, so this repo's dev and prod
# environments get DISTINCT trust on DISTINCT identities.
#
# F16 (MG-23): this is a COMMITTED, NON-OVERRIDABLE constant, exactly like
# STATE_ACCOUNT_PREFIX in scripts/state-account-name.sh and STATE_STORAGE_ACCOUNT
# above. It used to read `${GITHUB_REPO:-…}`. This value is the OIDC TRUST ROOT:
# every federated subject is `repo:${GITHUB_REPO}:environment:<env>`, so an
# inherited/poisoned GITHUB_REPO in the operator's shell would silently re-point
# the trust of EVERY identity — the dev apply identity included — at an
# attacker-controlled repository, announced by nothing but a log line. There is
# no legitimate reason to bootstrap this stack against a different repo; forking
# the repo means editing this constant in a commit that is reviewed.
GITHUB_REPO="stevebargelt/meatgeekv2"

# ---------------------------------------------------------------------------
# GitHub Environment / OIDC-subject map (MG-23). Read this before changing it.
# ---------------------------------------------------------------------------
# CANONICAL SUBJECT SCHEME (MG-24 red-fix — must not drift):
#   subject = repo:<owner>/<repo>:environment:<github-env>
# The <github-env> tokens MUST be the EXACT `environment:` values the workflow
# jobs declare. A job with `environment: development-infra-apply` presents the
# OIDC subject `repo:<owner>/<repo>:environment:development-infra-apply`, so the
# federated credential must be created for exactly that string. These MUST be
# `environment:` scopes (never `ref:refs/heads/<branch>`) so trust is gated by
# the GitHub Environment protection rules, not merely by which branch ran.
#
# WHY THE MAP IS ONE-IDENTITY-PER-ENVIRONMENT (MG-23 F8) — this is the whole
# point of the MG-23 rework. Before MG-23, ALL THREE dev identities (plan,
# app-deploy, and — had it existed — apply) federated the IDENTICAL subject
# `repo:<repo>:environment:development`, and which one a job actually assumed was
# decided ONLY by which client-id the job passed to azure/login. That is not a
# boundary: a ONE-LINE client-id edit merged to main silently upgrades the
# read-only PR plan job to a full Contributor apply, with no environment
# protection rule ever consulted. Now each identity federates its OWN
# environment, so the environment's protection rules (deployment branch policy,
# required reviewers) are what actually decide who may assume which privilege.
#
#   development-infra-apply  -> dev INFRA-APPLY identity (infra-apply-dev.yml)
#   development              -> dev APP-DEPLOY identity  (MG-36 consumes it)
#   production               -> prod PLAN/READ identity  (infra-deploy-prod,
#                                                         app-deploy-prod)
#
# THERE IS NO DEV PLAN IDENTITY AND NO DEV PLAN ENVIRONMENT (MG-23, re-scoped
# 2026-07-27). An earlier revision of this design gave a PULL-REQUEST-reachable
# identity READ access to live dev Terraform state so a PR could show a real
# plan. Dev state carries the live IoT Hub SAS keys — the one remaining
# credential in an otherwise key-free stack — so that arrangement needed a
# required-reviewer gate on the plan environment to contain the disclosure risk,
# and then needed a read-only-vs-write state-role split to contain the lease, and
# then needed protected-environment verification to contain THAT. The
# complexity was all downstream of one decision. Removing the identity removes
# the whole chain: PR validation is now CREDENTIALLESS (no identity, no
# environment, no OIDC subject at all — see the validate-infrastructure job in
# .github/workflows/ci.yml and scripts/assert-credentialless.sh, which proves it
# at runtime). The disclosure risk is closed BY CONSTRUCTION rather than gated.
#
# The PROD plan/read identity SURVIVES: infra-deploy-prod.yml still authenticates
# as it under `production`, and that workflow is workflow_dispatch-only and not
# PR-reachable. Prod moving to a CI-run apply is MG-25, not this ticket.
#
# NOT env-overridable, for the same reason as GITHUB_REPO: an extra environment
# injected here would mint a federated credential trusting a subject nobody
# reviewed.
#
# DERIVED, NOT HAND-MAINTAINED (MG-23 round-6 fix). This used to be a literal
# list that no code ever expanded — so the environment/subject map was asserted
# in bootstrap.test.sh but enforced by nothing, and a literal that drifts from
# the variables the federation code ACTUALLY reads is worse than no list at all:
# the tests would keep passing while describing a map the bootstrap no longer
# builds. It is now computed from the three variables that really drive
# federation (see each one below), and consumed by
# assert_federated_environment_map() — which fails closed if two identities
# would federate the SAME environment, the exact F8 collision this map exists to
# prevent. The assignment therefore lives BELOW those three declarations.

# GitHub Environments that OWN a Terraform state container. DELIBERATELY SEPARATE
# from GITHUB_ENVIRONMENTS: the container loop below derives its name via
# state_container_for(), so folding the two new dev environments into that loop
# would create bogus `tfstate-dev` duplicates / mis-named containers and drift
# from the committed environments/backend-{dev,prod}.hcl. There is exactly ONE
# state container per TERRAFORM environment (tfstate-dev, tfstate-prod), and
# several GitHub Environments share the dev one.
STATE_ENVIRONMENTS="development production"

# GitHub Environments that get a PLAN/READ identity (Reader + its env's state
# container).
#
# PROD ONLY. There is no dev plan identity any more (see the map above): dev PR
# validation is credentialless, and the dev apply identity is provisioned
# separately by bootstrap_infra_apply_identity(). The prod plan identity remains
# because .github/workflows/infra-deploy-prod.yml still logs in as it under the
# `production` environment to run its plan-only, workflow_dispatch-only job.
PLAN_IDENTITY_ENVIRONMENTS="production"

# The GitHub Environment the dev APP-DEPLOY identity federates (MG-36).
APP_DEPLOY_ENVIRONMENT="development"

# The GitHub Environment the dev INFRA-APPLY identity federates (MG-23).
INFRA_APPLY_ENVIRONMENT="development-infra-apply"

# The full set of GitHub Environments that an Azure identity federates — the
# environment/subject map, DERIVED from the three variables above so it cannot
# describe a map the code does not build. See the long note above the
# STATE_ENVIRONMENTS block for why this is derived rather than written out.
# `sort -u` because several identities may legitimately share nothing here but
# the list must be stable and duplicate-free for the collision check to read
# cleanly. Word-splitting on PLAN_IDENTITY_ENVIRONMENTS is intentional (it is a
# space-separated list), hence the shellcheck waiver.
# shellcheck disable=SC2086
GITHUB_ENVIRONMENTS="$(printf '%s\n' $PLAN_IDENTITY_ENVIRONMENTS \
  "$APP_DEPLOY_ENVIRONMENT" "$INFRA_APPLY_ENVIRONMENT" \
  | grep -v '^[[:space:]]*$' | sort -u | tr '\n' ' ' | sed 's/ $//')"

# The APPROVAL-ONLY GitHub Environment the workflow_dispatch RECOVERY path in
# .github/workflows/infra-apply-dev.yml binds (MG-23 round-5 fix).
#
# WHY IT IS NAMED HERE AT ALL, when no Azure identity federates it. GitHub
# AUTO-CREATES an environment the first time a workflow references one that does
# not exist, and an auto-created environment has NO protection rules whatsoever.
# The recovery path's human-approval gate would then be a NO-OP that still READS
# like an approval gate in the workflow file — the worst possible failure mode
# for a gate guarding a destructive recovery apply. So the environment must be
# created EXPLICITLY, with its required reviewer, and that protection must be
# VERIFIED before DEV_TF_BACKEND_READY is ever set true.
#
# Deliberately NOT in GITHUB_ENVIRONMENTS: nothing federates it, and adding it
# there would mint an OIDC trust for an environment whose entire purpose is to
# hold a human. It is verified, not federated.
RECOVERY_APPROVAL_ENVIRONMENT="development-infra-apply-recovery"

# Optional: the GitHub login to install as the recovery environment's required
# reviewer. Defaults to the authenticated `gh` user (the solo-maintainer case).
RECOVERY_APPROVAL_REVIEWER_LOGIN="${RECOVERY_APPROVAL_REVIEWER_LOGIN:-}"

# Base display name for the per-environment PLAN/READ AAD applications. Each
# environment gets its OWN app: "${AAD_APP_NAME}-dev" and "${AAD_APP_NAME}-prod".
# These are PLAN/READ identities (Reader) — they never publish app code.
AAD_APP_NAME="${AAD_APP_NAME:-meatgeek-v2-github-oidc}"

# Least-privilege CI PLAN role. Reader lets `terraform plan` read live resource
# state; it CANNOT create/modify/delete infrastructure, so an accidental
# CI apply fails closed. Do NOT change this to Contributor.
CI_PLAN_ROLE="${CI_PLAN_ROLE:-Reader}"

# --------------------------------------------------------------------------
# REMOVED (MG-23, re-scoped 2026-07-27): the plan identity's read-only state role.
# --------------------------------------------------------------------------
# An earlier revision carried a read-only-state environment list, a helper that
# chose a plan identity's blob-data role from it, and a revoke helper that
# actively stripped any write role such an identity had accumulated. All of that
# existed for exactly one reason: to narrow a PULL-REQUEST-reachable identity
# that held live dev state access.
#
# There is no such identity now, so the machinery is DELETED rather than left in
# place. Dead code that still READS as a live security control is worse than no
# code: the next reader believes a narrowing is being enforced on an identity
# that no longer exists, and the real invariant (no PR-reachable Azure identity
# at all) is the one that needs stating.
#
# The consequence, stated plainly rather than glossed: the PROD plan identity
# reverts to a plain `Storage Blob Data Contributor` grant on tfstate-prod via
# ensure_role_assignment(). That is what it held before the round-5 narrowing,
# and it is correct — infra-deploy-prod.yml runs a LOCKED plan, and taking the
# Azure blob lease genuinely requires blob write. Prod is not PR-reachable
# (workflow_dispatch-only behind the `production` environment), so the risk that
# motivated the dev narrowing does not apply to it.

# --- dev APP-DEPLOYMENT identity (MG-24 item 4) ----------------------------
# A SEPARATE app/SP whose ONLY job is publishing the dev Function App. It is not
# the plan identity. `Website Contributor` is the least-privilege built-in role
# that permits web-app/Functions code deployment scoped to a single site — a
# Reader cannot publish. It is scoped to the dev Function App ALONE, never the
# subscription. Emitted as AZURE_APP_DEPLOY_CLIENT_ID for the app-deploy job.
AAD_DEPLOY_APP_NAME="${AAD_DEPLOY_APP_NAME:-meatgeek-v2-github-appdeploy}"
DEPLOY_APP_ROLE="${DEPLOY_APP_ROLE:-Website Contributor}"

# --- dev INFRA-APPLY identity (MG-23) --------------------------------------
# The identity .github/workflows/infra-apply-dev.yml assumes to run the AUTOMATED
# dev GitOps reconciliation (CI-run apply on merge to main). A FOURTH distinct
# app/SP: not the plan identity (Reader), not the app-deploy identity (publish
# only). Its entire authority is bounded by the dev workload RG plus the dev
# state container — see bootstrap_infra_apply_identity().
AAD_INFRA_APPLY_APP_NAME="${AAD_INFRA_APPLY_APP_NAME:-meatgeek-v2-github-infra-apply}"
# The ONE resource group the apply identity may write. NOT overridable: this
# string IS the blast radius. It is asserted against the V1-safety guard before
# any grant is issued.
DEV_WORKLOAD_RG="meatgeek-v2-dev-rg"
# Stock built-in roles. Contributor cannot grant RBAC (that is why the separate,
# CONDITIONED RBAC-admin grant exists) and cannot read Microsoft Graph.
INFRA_APPLY_ROLE="Contributor"
INFRA_APPLY_RBAC_ROLE="Role Based Access Control Administrator"

# The SINGLE SOURCE OF TRUTH for the Terraform-managed role definitions the apply
# identity may grant/revoke. Read by BOTH this script (to build the ABAC
# condition) and scripts/tf-static-checks.sh CHECK 13 (to diff against the
# Terraform graph). NEVER inline the role list here — see the file's header.
ROLE_ALLOWLIST_FILE="${BOOTSTRAP_DIR}/tf-managed-role-allowlist.tsv"
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
# queries (`az … list … --query` projecting a field) that return empty-with-exit-0 when there
# is no match — NOT with `az … show`, which returns non-zero for not-found and so
# cannot distinguish absence from error (use a `list --filter` form instead).
#   usage: value="$(az_discover "<what>" az ad app list --display-name X --query '[].appId' -o tsv)"
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

# --------------------------------------------------------------------------
# Discovery that refuses to guess when MORE THAN ONE object matches (MG-23).
# --------------------------------------------------------------------------
# az_discover above answers "did the query error, or is the thing absent?" — but
# it is deliberately blind to how MANY things matched, because callers passed
# a first-element projection and took whatever Azure happened to return first.
#
# WHY THAT IS A SECURITY BUG, NOT A STYLE ONE. Every identity here is looked up
# by DISPLAY NAME, and display names are NOT unique in Entra ID. Two apps called
# `meatgeek-v2-github-infra-apply-dev` can coexist — created by a re-run against
# a half-failed bootstrap, by a second operator, or by anyone in the tenant who
# can register an application. `[0]` then silently selects one of them, in an
# order Azure does not guarantee and does not document as stable. The bootstrap
# would go on to attach a federated credential trusting
# `repo:<repo>:environment:development-infra-apply`, and grant Contributor +
# conditioned RBAC-Admin on the dev resource group, TO THE WRONG SERVICE
# PRINCIPAL — and report success. Nothing downstream would notice: the workflow
# would authenticate as an identity holding none of the grants, or an attacker-
# planted identity would quietly receive all of them.
#
# So: 0 matches -> "" (legitimately absent; the caller creates and then uses the
# id the CREATE returned, never a re-lookup). Exactly 1 -> that value. MORE than
# one -> DIE, naming every match, because there is no safe way to pick.
#
# Callers must use `--query '[].<field>'` (ALL matches), not `[0]`, or this
# helper can never see the ambiguity it exists to catch.
#   usage: value="$(az_discover_unique "<what>" az ad app list --display-name X --query '[].appId' -o tsv)"
az_discover_unique() {
  local what="$1"; shift
  local out count
  out="$(az_discover "$what" "$@")"

  # Normalize: drop blank lines and a literal "null" that `-o tsv` emits for an
  # empty result set, so "absent" is unambiguously the empty string.
  out="$(printf '%s\n' "$out" | grep -v '^[[:space:]]*$' | grep -v '^null$' || true)"

  if [ -z "$out" ]; then
    printf ''            # absent — the caller creates
    return 0
  fi

  count="$(printf '%s\n' "$out" | wc -l | tr -d ' ')"
  if [ "$count" -gt 1 ]; then
    die "AMBIGUOUS: ${count} objects match ${what}. Refusing to guess which one to configure — selecting arbitrarily would attach federated trust and role grants to the wrong principal and still report success. Resolve the duplicates in the tenant, then re-run. Matches:
$(printf '%s\n' "$out" | sed 's/^/    /')"
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
# GitHub uses the long names (which is what the workflow `environment:` values —
# and therefore the OIDC subjects — use); Terraform + state keys use the short
# `dev`/`prod`. Federation happens on the GitHub-env name (the subject), NOT this
# short form. MG-23: SEVERAL GitHub Environments map to the SAME Terraform
# environment — the dev plan, apply and app-deploy identities are three different
# trust boundaries over one `dev` stack and one `tfstate-dev` container.
tf_env_for() {
  case "$1" in
    development|development-infra-apply) echo "dev" ;;
    production) echo "prod" ;;
    *) echo "$1" ;;
  esac
}
# ONE container per TERRAFORM environment — tfstate-dev / tfstate-prod, exactly as
# environments/backend-{dev,prod}.hcl name them.
#
# LOAD-BEARING, AND EASY TO BREAK BY "SIMPLIFYING": the container loop iterates
# STATE_ENVIRONMENTS, NOT GITHUB_ENVIRONMENTS. That separation is the only reason
# adding or removing a GitHub Environment cannot mint a bogus container such as
# `tfstate-development-infra-apply`. `tf_env_for development-infra-apply` -> `dev`
# is what collapses the several dev GitHub Environments onto the single dev state
# container. Do not fold the two lists together.
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

# --------------------------------------------------------------------------
# FAIL-FAST TOOL PREFLIGHT — every external binary, checked BEFORE any mutation.
# --------------------------------------------------------------------------
# This used to check `az` alone. Everything else this script shells out to was
# discovered at the moment it was first needed, which under `set -euo pipefail`
# means the run ABORTS AT THAT POINT — and "that point" is routinely
# mid-mutation. The concrete case that motivated this: `stable_guid` hashes with
# sha1, and macOS ships `shasum` but NOT `sha1sum`. Its only caller sits in
# bootstrap_dev_api_registration, which main() invokes AFTER the state backend
# and all three identities (every RBAC grant already live) and BEFORE
# ensure_deployment_environment for either environment. A missing binary there
# left the operator with every grant issued and ZERO protected environments —
# precisely the half-provisioned state the blocking pre-activation gate exists
# to refuse, reached by a route that never runs the gate at all.
#
# So: enumerate the tools, check them ALL up front, and report EVERY missing one
# at once. An operator on a fresh workstation should learn the full list in one
# run, not discover them one abort at a time. This list was derived by scanning
# the external commands this script actually invokes; keep it in sync when a new
# one is introduced.
REQUIRED_TOOLS="az gh jq mktemp awk sed sort tr cut grep wc paste rm"

# The sha1 implementation, resolved ONCE and reused. Linux coreutils provides
# `sha1sum`; macOS provides `shasum` (and perl's `shasum -a 1`), not `sha1sum`.
# Both emit the same lowercase hex digest, so the GUID stable_guid derives is
# IDENTICAL across the two — which is load-bearing: stable_guid's entire
# contract is that a re-run reuses the same delegated-permission scope id
# instead of minting a duplicate. A hash that moved with the operator's OS would
# silently break idempotence.
SHA1_CMD="${SHA1_CMD:-}"
resolve_sha1_cmd() {
  if [ -n "${SHA1_CMD:-}" ]; then printf '%s' "$SHA1_CMD"; return 0; fi
  if command -v sha1sum >/dev/null 2>&1; then
    SHA1_CMD="sha1sum"
  elif command -v shasum >/dev/null 2>&1; then
    SHA1_CMD="shasum -a 1"
  else
    return 1
  fi
  printf '%s' "$SHA1_CMD"
}

require_tools() {
  local missing="" t
  for t in $REQUIRED_TOOLS; do
    command -v "$t" >/dev/null 2>&1 || missing="${missing:+${missing} }${t}"
  done
  # sha1: EITHER implementation satisfies the requirement, so it cannot be
  # expressed as a plain name in REQUIRED_TOOLS.
  resolve_sha1_cmd >/dev/null 2>&1 \
    || missing="${missing:+${missing} }sha1sum-or-shasum"
  [ -z "$missing" ] \
    || die "missing required tool(s): ${missing}. Install them and re-run — this check runs BEFORE anything is provisioned, so nothing has been changed. On macOS: 'brew install azure-cli gh jq coreutils' ('shasum' ships with the system and is accepted in place of 'sha1sum')."
  # Authentication, not availability — kept here so the whole precondition set is
  # verified in one place before the first mutation.
  az account show >/dev/null 2>&1 || die "Not authenticated. Run: az login"
}

# --------------------------------------------------------------------------
# The state storage account's resource id — ONE lookup, asserted non-empty.
# --------------------------------------------------------------------------
# Every container-scoped blob-data grant needs this id to build its scope, and
# three call sites each carried an identical copy of the lookup wrapped in an
# `if [ -n "$state_sa_id" ]; then <grant> else <warn: account missing, run the
# state bootstrap first> fi`.
#
# THOSE ELSE BRANCHES WERE UNREACHABLE, and their guidance was wrong. They read
# the lookup through az_discover, whose own contract (see above) restricts it to
# LIST-style queries whose empty result means "absent" and says explicitly: not
# with `az … show`, which exits NON-ZERO for not-found. So on a missing account
# az_discover DIED — it could never return the empty string the `else` was
# written to catch — and the operator saw az_discover's "REAL Azure error"
# text, never the "run state bootstrap first" hint.
#
# The absence they guarded against cannot occur anyway: bootstrap_state_backend
# runs FIRST in main() and fails loud, so by the time any identity is
# provisioned the account EXISTS. Absence here is therefore an ERROR, not a
# state to warn about and continue past — continuing past it would silently skip
# a per-identity state grant and report success.
#
# So this asks `az … show` DIRECTLY (the honest helper for a not-found-non-zero
# command) and dies with an accurate message.
state_account_id() {
  local id status=0
  id="$(az storage account show \
    --name "$STATE_STORAGE_ACCOUNT" --resource-group "$STATE_RG" \
    --query id -o tsv 2>/dev/null)" || status=$?
  if [ "$status" -ne 0 ] || [ -z "$id" ]; then
    die "could not read the state storage account ${STATE_STORAGE_ACCOUNT} in ${STATE_RG} (az exited ${status}). It is created by bootstrap_state_backend, which runs FIRST, so this is a REAL error (auth / throttling / network / wrong subscription), not an account that is merely absent. No blob-data grant has been issued."
  fi
  printf '%s' "$id"
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
  # `|| exit 1`, NOT a bare assignment. az_discover / az_discover_unique report a
  # REAL Azure error or an AMBIGUOUS >1-match by calling die — but die runs
  # INSIDE the command-substitution SUBSHELL, so its exit kills only that
  # subshell and the assignment merely lands non-zero. Whether that aborts the
  # run then depends on the CALLER's errexit state: a caller that suffixed the
  # CALL with an `|| die "…"` diagnosis — or wrapped it in an `if ! …` — puts
  # this whole function body in a conditional context, which turns errexit OFF
  # for every command in it. (Both shapes are now rejected by a test.)
  # The observable failure was
  # not a wrong diagnosis, it was FALL-THROUGH: `existing` came back empty from
  # a discovery that had ERRORED or found MULTIPLE matches, and execution
  # continued straight into the create below. `exit` here runs in the CURRENT
  # shell and aborts regardless of what the caller did.
  existing="$(az_discover_unique "existing role assignment (${role} on ${scope})" \
    az role assignment list \
    --assignee "$object_id" \
    --role "$role" \
    --scope "$scope" \
    --query "[].id" -o tsv)" || exit 1
  if [ -n "$existing" ] && [ "$existing" != "null" ]; then
    return 0
  fi
  # The operator-facing diagnosis lives HERE, on the create, rather than at one
  # call site. A failing create at this point is almost always the signed-in
  # principal lacking the authority to grant — and every call site deserves that
  # sentence, not just the one that happened to spell it out. Attaching it to
  # the create (not to the whole function call) is also what makes it safe:
  # wrapping the CALL in `||` is what disabled the guards above.
  az role assignment create \
    --assignee-object-id "$object_id" \
    --assignee-principal-type "$principal_type" \
    --role "$role" \
    --scope "$scope" \
    -o none \
    || die "failed to grant '${role}' on ${scope} — the signed-in principal likely lacks Owner / User Access Administrator at that scope."
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
# Delete every federated credential on an app that is NOT in the expected set.
# --------------------------------------------------------------------------
# MG-23 F8. ensure_federated_credential is CREATE/RECONCILE-only: it fixes a
# credential it knows the name of, and is blind to any OTHER credential on the
# same app. That blindness is load-bearing here, because MG-23 reassigns which
# identity owns the bare `development` environment (it is now the app-deploy
# identity's, and no one else's). Without a prune, an identity bootstrapped under
# an earlier revision would KEEP its old credential trusting
# `repo:<repo>:environment:development` — so a job running in the `development`
# environment could still assume the wrong identity, and the whole
# one-environment-one-identity boundary this ticket builds would be decorative on
# the very first re-run. Trust is REVOKED by deleting the credential, not by
# ceasing to mention it.
#
#   usage: prune_unexpected_federated_credentials <app_id> <keep_name>...
prune_unexpected_federated_credentials() {
  local app_id="$1"; shift
  local keep=" $* " existing name
  existing="$(az_discover "federated credentials on app ${app_id}" \
    az ad app federated-credential list --id "$app_id" --query "[].name" -o tsv)"
  for name in $existing; do
    [ -z "$name" ] && continue
    case "$keep" in
      *" $name "*) continue ;;
    esac
    warn "Deleting UNEXPECTED federated credential '${name}' on app ${app_id} — it is not in this identity's expected set (${*}). A credential nobody expects is a trust path nobody reviews."
    az ad app federated-credential delete --id "$app_id" \
      --federated-credential-id "$name" -o none \
      || die "failed to delete the unexpected federated credential '${name}' on app ${app_id}; the identity would keep an unreviewed OIDC trust path. Remove it manually before continuing."
    ok "Unexpected federated credential deleted: ${name}"
  done
}

# ===========================================================================
# The RECOVERY-APPROVAL GitHub Environment — created EXPLICITLY, then VERIFIED.
# ===========================================================================
# MG-23 round-5 fix. .github/workflows/infra-apply-dev.yml's workflow_dispatch
# RECOVERY path binds `environment: development-infra-apply-recovery` for exactly
# one reason: to park the run on a HUMAN APPROVAL before a destructive recovery
# apply (the path that may carry a destroy authorization).
#
# THE FAILURE MODE THIS CLOSES. GitHub AUTO-CREATES an environment the first time
# a workflow references a name that does not exist — and an auto-created
# environment has NO protection rules at all. So a recovery dispatch would sail
# straight through, with the workflow file still reading as though a reviewer had
# approved it. An approval gate that silently isn't one is worse than no gate:
# nobody goes looking for the control they can see in the YAML. Relying on the
# operator to have created the environment by hand is the same bet.
#
# So: create it explicitly with a required reviewer, and VERIFY the protection is
# actually present. The verification is a BLOCKING PRE-ACTIVATION CHECK —
# DEV_TF_BACKEND_READY must not be set true until it reports PROTECTED. See
# docs/infrastructure/mg23-live-acceptance.md (activation order + blocking
# checks).
#
# WHY THIS IS gh AND NOT az: it is a GitHub resource, and this script otherwise
# holds only Azure credentials. When `gh` is unavailable or unauthenticated we do
# NOT silently skip — the status is recorded as UNVERIFIED and the final summary
# prints a blocking banner naming the exact commands to run. A silent skip here
# would reproduce the very "gate that isn't" this function exists to prevent.
#
# TWO environments are managed here, and BOTH must be explicitly created and
# verified (MG-23, re-scoped 2026-07-27):
#
#   development-infra-apply            automatic reconciliation. main-only
#                                      deployment branch policy. NO required
#                                      reviewer — the normal GitOps path is
#                                      governed by protected-main + the CI gates
#                                      + the destroy circuit-breaker, not by a
#                                      human clicking approve on every merge.
#   development-infra-apply-recovery   the branch-restricted workflow_dispatch
#                                      RECOVERY path. main-only AND required
#                                      reviewers.
#
# The apply environment was previously not created by this script at ALL — it
# relied entirely on GitHub auto-creation, which is exactly the failure mode
# described above, left open on the environment that actually reaches Contributor
# on the dev resource group. That is now fixed.
#
# THE NEGATIVE CHECK MATTERS AS MUCH AS THE POSITIVE ONE. The apply environment
# is verified to have NO required-reviewers rule. A stray reviewer added there
# would silently convert automatic reconciliation into a manual one while
# infra-apply-dev.yml still reads as automatic — reconciliation would simply stop
# happening, and the workflow file would give a reader no clue why. "Protected"
# here means "protected AS DESIGNED", not "has the most rules".
APPLY_ENV_STATUS="UNVERIFIED"
RECOVERY_ENV_STATUS="UNVERIFIED"

# --------------------------------------------------------------------------
# THE BLOCKING PRE-ACTIVATION GATE — blocking, not advisory.
# --------------------------------------------------------------------------
# This check used to run as a `warn` AFTER main() had already printed
# "Bootstrap complete", and main() then returned 0. So the single condition that
# is supposed to stop activation — the recovery approval gate being unverified —
# was reported as a yellow line underneath a green success summary, and the
# script's EXIT STATUS, which is what any wrapper or operator actually keys off,
# said everything was fine. A gate whose failure exits 0 is not a gate.
#
# Now: it is a FAILURE with a NON-ZERO return, main() calls it BEFORE the
# success line, and "bootstrap exited 0" is a trustworthy signal that activation
# is safe to proceed to. Extracted into a named function so the tests can drive
# it directly with both statuses posed, rather than inferring it from source
# text. Callers must propagate the non-zero status.
#
# NOTE: the Azure-side work is idempotent and has already completed by the time
# this runs. The intended operator response to a non-zero exit here is to fix
# the GitHub-side protection (commonly: `gh auth login`, then re-run) — NOT to
# treat the Azure provisioning as suspect.
assert_environments_protected() {
  # BOTH statuses gate activation. Reporting only one would let the other ship
  # unprotected behind a green summary.
  if [ "$APPLY_ENV_STATUS" != "PROTECTED" ] || [ "$RECOVERY_ENV_STATUS" != "PROTECTED" ]; then
    printf '\033[0;31m❌ %s\033[0m\n' "BLOCKING PRE-ACTIVATION CHECK NOT SATISFIED — '${INFRA_APPLY_ENVIRONMENT}' is ${APPLY_ENV_STATUS} and '${RECOVERY_APPROVAL_ENVIRONMENT}' is ${RECOVERY_ENV_STATUS}. BOTH must report PROTECTED before DEV_TF_BACKEND_READY is set true: the apply environment needs a main-only branch policy and NO required reviewer (automatic reconciliation), the recovery environment needs a main-only branch policy AND a non-empty required_reviewers rule. See docs/infrastructure/mg23-live-acceptance.md." >&2
    return 1
  fi
  return 0
}

# Print the manual procedure for one environment. Also used as the failure
# message, so the operator always ends up with a runnable next step rather than a
# diagnosis. $1=env name, $2=yes|no (does it need a required reviewer)
deployment_environment_manual_procedure() {
  local env="$1" want_reviewer="$2"
  if [ "$want_reviewer" = "yes" ]; then
    cat <<PROCEDURE
  # 1. Create/patch the environment WITH a required reviewer (prevent_self_review
  #    is false so a solo maintainer can approve their own recovery run):
  REVIEWER_ID=\$(gh api /user --jq .id)
  gh api --method PUT "repos/${GITHUB_REPO}/environments/${env}" \\
    --input - <<'JSON'
  {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true},
   "prevent_self_review": false, "reviewers": [{"type": "User", "id": REVIEWER_ID}]}
JSON
PROCEDURE
  else
    cat <<PROCEDURE
  # 1. Create/patch the environment with NO required reviewer (the automatic
  #    reconciliation path must not wait on a human):
  gh api --method PUT "repos/${GITHUB_REPO}/environments/${env}" \\
    --input - <<'JSON'
  {"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}
JSON
PROCEDURE
  fi
  cat <<PROCEDURE
  # 2. Restrict deployments to main ONLY:
  gh api --method POST "repos/${GITHUB_REPO}/environments/${env}/deployment-branch-policies" \\
    -f name=main
  # 3. VERIFY (this is the blocking check). Expect EXACTLY ONE policy named main:
  gh api "repos/${GITHUB_REPO}/environments/${env}/deployment-branch-policies" \\
    --jq '.branch_policies[].name'
  # 4. VERIFY the reviewer rule is $( [ "$want_reviewer" = "yes" ] && echo "PRESENT and non-empty" || echo "ABSENT" ):
  gh api "repos/${GITHUB_REPO}/environments/${env}" \\
    --jq '[.protection_rules[]? | select(.type=="required_reviewers")] | length'
PROCEDURE
}

# Count reviewers on an environment. Echoes an integer, or "error".
environment_reviewer_count() {
  local env="$1" n
  n="$(gh api "repos/${GITHUB_REPO}/environments/${env}" \
    --jq '[.protection_rules[]? | select(.type=="required_reviewers") | .reviewers[]?] | length' \
    2>/dev/null)" || { echo "error"; return 0; }
  case "$n" in
    ''|null) echo "error" ;;
    *)       echo "$n" ;;
  esac
}

# Echo the environment's custom deployment-branch-policy names, one per line.
environment_branch_policies() {
  local env="$1"
  gh api "repos/${GITHUB_REPO}/environments/${env}/deployment-branch-policies" \
    --jq '.branch_policies[]?.name' 2>/dev/null || true
}

# --------------------------------------------------------------------------
# Create + VERIFY one deployment environment.
#   usage: ensure_deployment_environment <env-name> <yes|no require_reviewer>
# --------------------------------------------------------------------------
# Sets the matching *_ENV_STATUS to PROTECTED | UNPROTECTED | UNVERIFIED. A
# successful PUT is NOT evidence: every property is read back from the live API
# before a PROTECTED status is recorded.
ensure_deployment_environment() {
  local env="$1" want_reviewer="$2"
  local reviewer_id body policies policy_count reviewers status_var

  case "$env" in
    "$INFRA_APPLY_ENVIRONMENT")       status_var="APPLY_ENV_STATUS" ;;
    "$RECOVERY_APPROVAL_ENVIRONMENT") status_var="RECOVERY_ENV_STATUS" ;;
    *) die "ensure_deployment_environment called with an unmanaged environment '${env}'" ;;
  esac

  log "── GitHub Environment '${env}' (required reviewer: ${want_reviewer})"

  if ! command -v gh >/dev/null 2>&1 || ! gh auth status >/dev/null 2>&1; then
    eval "${status_var}=UNVERIFIED"
    warn "The GitHub CLI is unavailable or unauthenticated, so '${env}' could NOT be created or verified. This is NOT a pass — GitHub auto-creates an UNPROTECTED environment on first workflow reference. Run this before setting DEV_TF_BACKEND_READY=true:"
    deployment_environment_manual_procedure "$env" "$want_reviewer"
    return 0
  fi

  # Body. custom_branch_policies=true is what lets us pin deployments to main
  # below; protected_branches=false because "protected branches" is a DIFFERENT
  # GitHub concept (it would track whatever branches happen to be protected,
  # which is not the same as "main and only main").
  if [ "$want_reviewer" = "yes" ]; then
    # Reuse the reviewer resolution verbatim, including its die-on-empty
    # behaviour: an approval environment with no reviewer approves everything.
    if [ -n "$RECOVERY_APPROVAL_REVIEWER_LOGIN" ]; then
      reviewer_id="$(gh api "/users/${RECOVERY_APPROVAL_REVIEWER_LOGIN}" --jq .id 2>/dev/null)" \
        || die "could not resolve the GitHub user '${RECOVERY_APPROVAL_REVIEWER_LOGIN}' named in RECOVERY_APPROVAL_REVIEWER_LOGIN. Refusing to create '${env}' with no reviewer — an environment with no required reviewer is an approval gate that approves everything."
    else
      reviewer_id="$(gh api /user --jq .id 2>/dev/null)" \
        || die "could not resolve the authenticated GitHub user id. Refusing to create '${env}' with no reviewer — an environment with no required reviewer is an approval gate that approves everything."
    fi
    if [ -z "$reviewer_id" ] || [ "$reviewer_id" = "null" ]; then
      die "resolved an EMPTY GitHub reviewer id for '${env}'. Refusing to create an approval environment with no required reviewer."
    fi
    # prevent_self_review=false: this repo has one maintainer, and a gate nobody
    # can satisfy is a gate that gets deleted. The reviewer's value here is the
    # deliberate pause plus the audit record, not two-person control.
    body="$(printf '{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}, "prevent_self_review": false, "reviewers": [{"type": "User", "id": %s}]}' "$reviewer_id")"
  else
    body='{"deployment_branch_policy": {"protected_branches": false, "custom_branch_policies": true}}'
  fi

  # PUT is create-or-update and idempotent: it both creates the environment on a
  # first run and REPAIRS one GitHub already auto-created without protection —
  # the dangerous state this function exists for.
  printf '%s' "$body" \
    | gh api --method PUT "repos/${GITHUB_REPO}/environments/${env}" --input - >/dev/null \
    || die "failed to create/update the GitHub Environment '${env}'. Do NOT set DEV_TF_BACKEND_READY=true."

  # Pin deployments to main. Idempotent: POSTing an existing policy name errors,
  # so only create it when a `main` policy is not already present.
  if ! environment_branch_policies "$env" | grep -qx 'main'; then
    log "Restricting '${env}' deployments to main"
    gh api --method POST \
      "repos/${GITHUB_REPO}/environments/${env}/deployment-branch-policies" \
      -f name=main >/dev/null \
      || die "failed to add the main-only deployment branch policy to '${env}'. Without it the environment would accept a deployment from ANY branch, which for the apply environment means an arbitrary branch could reach Contributor on ${DEV_WORKLOAD_RG}."
  fi

  # --- VERIFY by read-back. A PUT that returned 200 proves nothing. ----------
  policies="$(environment_branch_policies "$env")"
  policy_count="$(printf '%s\n' "$policies" | grep -c '[^[:space:]]' || true)"
  if [ "$policy_count" != "1" ] || ! printf '%s\n' "$policies" | grep -qx 'main'; then
    eval "${status_var}=UNPROTECTED"
    die "'${env}' does NOT have EXACTLY ONE deployment branch policy named 'main' (found ${policy_count}: $(printf '%s' "$policies" | tr '\n' ' ')). Do NOT set DEV_TF_BACKEND_READY=true until it does:
$(deployment_environment_manual_procedure "$env" "$want_reviewer")"
  fi

  reviewers="$(environment_reviewer_count "$env")"
  if [ "$reviewers" = "error" ]; then
    eval "${status_var}=UNVERIFIED"
    warn "Could not read the protection rules of '${env}' back. NOT a pass."
    deployment_environment_manual_procedure "$env" "$want_reviewer"
    return 0
  fi

  if [ "$want_reviewer" = "yes" ]; then
    if [ "$reviewers" -gt 0 ] 2>/dev/null; then
      eval "${status_var}=PROTECTED"
      ok "'${env}': main-only branch policy + ${reviewers} required reviewer(s) (verified live)"
    else
      eval "${status_var}=UNPROTECTED"
      die "'${env}' does NOT report a required-reviewer protection rule after configuration. The recovery path's approval gate would be a NO-OP. Do NOT set DEV_TF_BACKEND_READY=true until this reports a non-empty required_reviewers rule:
$(deployment_environment_manual_procedure "$env" "$want_reviewer")"
    fi
  else
    # THE NEGATIVE CHECK. A reviewer here does not make things safer — it stops
    # automatic reconciliation dead while the workflow still claims to be
    # automatic.
    if [ "$reviewers" -eq 0 ] 2>/dev/null; then
      eval "${status_var}=PROTECTED"
      ok "'${env}': main-only branch policy, NO required reviewer (verified live — automatic reconciliation is unblocked)"
    else
      eval "${status_var}=UNPROTECTED"
      die "'${env}' reports ${reviewers} required reviewer(s), but the AUTOMATIC reconciliation path must have NONE. Every merge to main would queue for a human while infra-apply-dev.yml still reads as automatic, so reconciliation would silently stop. Remove the reviewer rule from '${env}' (the RECOVERY environment '${RECOVERY_APPROVAL_ENVIRONMENT}' is where the human gate belongs)."
    fi
  fi
}

# --------------------------------------------------------------------------
# Normalize an ABAC condition for COMPARISON only (never for authoring).
# --------------------------------------------------------------------------
# Azure returns the condition it stored, not the exact bytes we sent: whitespace
# and line breaks are not preserved verbatim, and the identifiers/GUIDs are
# case-insensitive. Comparing raw strings would therefore report a spurious
# mismatch on EVERY run and reconcile (delete+recreate) the RBAC-admin grant each
# time. Collapse whitespace and lowercase, then compare.
normalize_condition() {
  printf '%s' "$1" | tr '\n\t' '  ' | tr -s ' ' | sed -e 's/^ //' -e 's/ $//' \
    | tr '[:upper:]' '[:lower:]'
}

# --------------------------------------------------------------------------
# Idempotent CONDITIONED role assignment, reconciled on the CONDITION.
# --------------------------------------------------------------------------
# MG-23 F7. ensure_role_assignment (above) decides idempotence from the
# (assignee, role, scope) TUPLE alone. For a conditioned grant that is unsafe in
# a specific, silent way: the tuple matches on every re-run, so the FIRST
# condition ever written is FROZEN forever. Add a role to the allowlist, re-run
# bootstrap, and it reports success while the live condition still allowlists the
# OLD role set — the next apply then fails mid-run with AuthorizationFailed and a
# partially-applied stack, and the bootstrap output gave no hint.
#
# So: read the LIVE condition back, normalize both sides, compare, and reconcile
# on mismatch. This mirrors the discipline ensure_federated_credential already
# uses for subjects (reconcile on the SECURITY-BEARING field, not just on
# existence). ensure_role_assignment is deliberately left alone for
# UNCONDITIONED grants — three small explicit helpers beat one clever one.
#
# RECONCILIATION IS AN IN-PLACE UPDATE, NEVER DELETE+CREATE.
#
# An earlier revision reconciled by deleting the stale assignment and creating a
# replacement. Between those two calls the apply identity holds NO
# RBAC-administrator grant AT ALL. `az role assignment update` instead PUTs the
# existing assignment object with only the condition changed: ARM applies it as
# one operation, so the grant is never absent and there is no intermediate state
# in which it exists without a condition.
#
# WHAT THAT ACTUALLY BUYS — STATED NARROWLY, BECAUSE IT IS NARROW.
#
# In-place update removes the momentary NO-GRANT WINDOW. It does NOT make this
# helper safe to run underneath an in-flight apply, and an earlier version of
# this comment claimed it did. It does not, for a simple reason: NARROWING a
# condition mid-apply denies a role write just as effectively as deleting the
# grant would. If bootstrap reconciles the allowlist from 8 roles to 7 while a CI
# apply is part-way through assigning the 8th, that apply hits AuthorizationFailed
# and leaves the stack PARTIALLY APPLIED — identically to the delete+create case
# it was supposedly fixed by. The failure mode survived the fix; only its window
# shrank, from "between two az calls" to "any condition change at all".
#
# THE ACTUAL PROTECTION against a mid-apply condition change is OPERATIONAL, not
# structural: do not run this bootstrap while an automatic apply may be in
# flight. Nothing in this script can enforce that — it has no view of the
# GitHub Actions queue — so it is a procedure, and it is written down as one in
# docs/infrastructure/mg23-live-acceptance.md. In-place update is still the right
# implementation (a strictly smaller window is strictly better, and the no-grant
# window had failure modes of its own), but it is a mitigation, not a solution,
# and treating it as one would put an apply at risk on the strength of a comment.
#
# ON FAILURE WE DIE WITHOUT MUTATING ANYTHING. There is deliberately NO
# delete+create fallback: a fallback would reinstate the very window this exists
# to close, and would do so on the unhappy path, where an operator is least
# likely to be watching. The live grant keeps its STALE condition — which still
# constrains role writes to the previously-allowlisted set, so the apply fails
# closed on any newly-added role rather than being handed an unconditioned grant
# — and the bootstrap exits non-zero telling the operator exactly that.
#
# OPERATIONAL CONSTRAINT — the load-bearing one, per the note above. This
# bootstrap MUTATES LIVE RBAC, and a condition change lands on an in-flight apply
# as an authorization denial regardless of how the change is written. Run it only
# when NO automatic apply is in flight (no queued or running infra-apply-dev run).
# See the activation and recovery procedure in
# docs/infrastructure/mg23-live-acceptance.md.
ensure_conditioned_role_assignment() {
  local object_id="$1" principal_type="$2" role="$3" scope="$4" condition="$5"
  local existing_id existing_condition existing_json updated_json assignment_file verify_condition
  local created_id attempt max_attempts delay

  [ -n "$condition" ] || die "refusing to create an UNCONDITIONED '${role}' assignment on ${scope} — a conditioned grant with an empty condition is a full RBAC-administrator grant."

  # `|| exit 1` ON EVERY DISCOVERY IN THIS FUNCTION — the IDENTICAL hardening
  # ensure_role_assignment carries, and it matters MORE here, not less: this is
  # the higher-privilege sibling, the one that mints the RBAC-ADMINISTRATOR
  # grant.
  #
  # az_discover / az_discover_unique report a REAL Azure error or an AMBIGUOUS
  # >1-match by calling `die` — but `die` runs INSIDE the command-substitution
  # SUBSHELL, so its exit kills only that subshell and the assignment merely
  # lands non-zero. Whether that aborts the run then depends on the CALLER's
  # errexit state, and any caller that wrapped the call in `|| …` or `if ! …`
  # turns errexit OFF for this entire function body. The observable failure is
  # not a wrong diagnosis, it is FALL-THROUGH: `existing_id` comes back empty
  # from a discovery that ERRORED or found MULTIPLE matches, and execution
  # continues straight into the CREATE below — issuing a SECOND conditioned
  # RBAC-administrator assignment on top of an ambiguous set the bootstrap just
  # admitted it could not read. `exit` here runs in the CURRENT shell and aborts
  # regardless of what the caller did.
  existing_id="$(az_discover_unique "existing role assignment (${role} on ${scope})" \
    az role assignment list \
    --assignee "$object_id" \
    --role "$role" \
    --scope "$scope" \
    --query "[].id" -o tsv)" || exit 1

  if [ -z "$existing_id" ] || [ "$existing_id" = "null" ]; then
    log "Creating CONDITIONED role assignment: ${role} on ${scope}"
    az role assignment create \
      --assignee-object-id "$object_id" \
      --assignee-principal-type "$principal_type" \
      --role "$role" \
      --scope "$scope" \
      --condition "$condition" \
      --condition-version "2.0" \
      -o none \
      || die "failed to create the CONDITIONED '${role}' assignment on ${scope}."

    # VERIFY THE CREATE LANDED — the same discipline the UPDATE path below
    # applies, for the same reason. This branch is the FIRST-EVER bootstrap: the
    # run that establishes the conditioned RBAC-administrator grant in the first
    # place. It previously returned success the instant az exited 0, which says
    # ARM ACCEPTED the request, not that the grant it stored carries the
    # condition we sent. A create that lands WITHOUT the condition is an
    # UNCONDITIONED RBAC-administrator grant at RG scope — the exact
    # self-escalation primitive the condition exists to prevent — and the
    # operator's only signal would have been a green line saying it was
    # conditioned. The read-back is cheap; being wrong here is not.
    #
    # The `[].id` read goes through az_discover_unique for a SECOND reason
    # beyond proving the create landed: it re-establishes the uniqueness
    # precondition that the `[0].condition` read below depends on. On this
    # branch uniqueness was NEVER proven — the pre-create read returned empty,
    # which is what sent us here — so without this read `[0]` would be selecting
    # from a set of unknown size.
    #
    # BOUNDED RETRY, AND ONLY FOR ABSENCE. ARM role-assignment create→read is
    # eventually consistent, so an unretried read-back would intermittently
    # abort the first-ever bootstrap immediately after the grant went live —
    # reintroducing the mid-mutation abort class this whole pass is removing.
    # Same shape as wait_for_blob_data_plane. A NON-EMPTY condition that DIFFERS
    # is a real mismatch and fails IMMEDIATELY: retrying a wrong answer until it
    # becomes a right one is how a verification turns into a formality.
    # Bounds are overridable ONLY so the tests can exercise the retry without
    # sleeping through it; the defaults are what every real run uses.
    attempt=1
    max_attempts="${COND_READBACK_ATTEMPTS:-5}"
    delay="${COND_READBACK_DELAY:-3}"
    while :; do
      # `|| exit 1` for the same fall-through reason as the pre-create read: an
      # AMBIGUOUS read-back here means the create landed into a set this
      # bootstrap cannot identify, and the retry loop must NOT paper over that
      # by re-reading until the attempt budget runs out and reporting the
      # generic "could not read it back" message. Fail with the accurate
      # AMBIGUOUS diagnosis instead.
      created_id="$(az_discover_unique "created role assignment (${role} on ${scope})" \
        az role assignment list \
        --assignee "$object_id" \
        --role "$role" \
        --scope "$scope" \
        --query "[].id" -o tsv)" || exit 1
      # Single-value read via az_discover, NEVER az_discover_unique: the real
      # condition is multi-line (two clauses) and the line-counting uniqueness
      # guard would read it as N matching objects and die AMBIGUOUS. Same trap
      # as the drift read below. `|| exit 1` still applies: az_discover dies
      # ONLY on a REAL az error, and a not-yet-propagated assignment returns
      # cleanly empty — so the retry below still covers eventual consistency
      # while a genuine Azure error aborts instead of being retried away.
      verify_condition="$(az_discover "post-create condition on ${role} @ ${scope}" \
        az role assignment list \
        --assignee "$object_id" \
        --role "$role" \
        --scope "$scope" \
        --query "[0].condition" -o tsv)" || exit 1
      if [ -n "$created_id" ] && [ -n "$(normalize_condition "$verify_condition")" ]; then
        break
      fi
      if [ "$attempt" -ge "$max_attempts" ]; then
        die "created the '${role}' assignment on ${scope} but could not read it back with a condition after ${max_attempts} attempts. The grant may be live WITHOUT the ABAC condition — i.e. an UNCONDITIONED RBAC-administrator grant at that scope. Treat it as UNVERIFIED and do NOT activate the apply loop: inspect it with 'az role assignment list' for assignee ${object_id}, role '${role}', scope '${scope}', then re-run this bootstrap."
      fi
      attempt=$((attempt + 1))
      sleep "$delay"
    done

    # Normalized compare, matching the reconcile path: Azure does not return the
    # exact bytes we sent (whitespace and keyword case differ), so a byte
    # compare would fail every time.
    if [ "$(normalize_condition "$verify_condition")" != "$(normalize_condition "$condition")" ]; then
      die "the '${role}' assignment on ${scope} was created but the condition read back afterwards DIFFERS from the one this bootstrap authored. The grant is live carrying a condition this bootstrap did not author — treat it as UNVERIFIED and do not activate the apply loop against it. Inspect the live condition with 'az role assignment list' for assignee ${object_id}, role '${role}', scope '${scope}', then re-run this bootstrap."
    fi

    ok "Conditioned ${role} granted on ${scope} and VERIFIED by read-back"
    return 0
  fi

  # Read the condition of THAT one assignment as a SINGLE VALUE — deliberately
  # NOT through az_discover_unique.
  #
  # az_discover_unique decides "how many matched?" by COUNTING OUTPUT LINES. That
  # is exactly right for an object id (one id per line, so >1 line is genuine
  # ambiguity) and exactly WRONG for a condition, which is a multi-line string:
  # `[].condition -o tsv` on a single assignment whose condition spans N lines
  # emits N lines, the line-counting guard reads that as N matching objects, and
  # every re-run after the grant exists dies with a bogus
  # "AMBIGUOUS: N objects match" and NEVER reconciles — turning the F7 reconcile
  # into a hard failure, which is the freeze this helper exists to prevent.
  #
  # Uniqueness is already PROVEN above: the `[].id` read went through
  # az_discover_unique and died if more than one assignment matched this
  # (assignee, role, scope). So `[0]` here selects the same single assignment,
  # not an arbitrary one. az_discover (not _unique) still fails loud on a REAL
  # az error rather than collapsing it to an empty string.
  # `|| exit 1` — without it a REAL az error here collapses to the empty string,
  # which does not match the intended condition, so the function would proceed
  # into the in-place UPDATE path on the strength of a read it never actually
  # got. Reconciling blind is exactly what this helper exists to prevent.
  existing_condition="$(az_discover "live condition on ${role} @ ${scope}" \
    az role assignment list \
    --assignee "$object_id" \
    --role "$role" \
    --scope "$scope" \
    --query "[0].condition" -o tsv)" || exit 1

  if [ "$(normalize_condition "$existing_condition")" = "$(normalize_condition "$condition")" ]; then
    ok "Conditioned ${role} already correct on ${scope} (live condition matches)"
    return 0
  fi

  log "Reconciling the ABAC condition on ${role} @ ${scope} IN PLACE (live condition differs from the allowlist-derived one)"

  # BELT AND BRACES. The AUTHORITATIVE jq check is now in require_tools, which
  # runs as the first statement of main() — before anything is provisioned — so
  # a missing jq can never be discovered halfway through a mutation. (This check
  # used to be the only one, justified by exactly that reasoning; the reasoning
  # was right and is now served by a preflight that covers every tool rather
  # than this one.) It is kept here because it guards a hard requirement of this
  # specific path — the in-place update PUTs the existing assignment object with
  # exactly one field changed, and hand-editing JSON in shell is how you get a
  # malformed PUT — and because the refusal below states a policy worth stating
  # at the point it applies: we do NOT degrade to delete+create when jq is
  # missing, since that would make the no-grant window reappear on precisely the
  # machine least prepared for it.
  command -v jq >/dev/null 2>&1 \
    || die "jq is required to reconcile the ABAC condition on '${role}' @ ${scope} in place. Install jq and re-run. Refusing to fall back to delete+create: that momentarily strips the grant, and an automatic apply running in that window fails mid-write with a partially-applied stack."

  # Re-read the SAME assignment as a whole object. Uniqueness was already proven
  # by the az_discover_unique `[].id` read above, so `[0]` is that one
  # assignment. az_discover (not _unique) because this is one JSON document, not
  # a line-per-match list — see the note on the condition read above.
  existing_json="$(az_discover "live role assignment object (${role} @ ${scope})" \
    az role assignment list \
    --assignee "$object_id" \
    --role "$role" \
    --scope "$scope" \
    --query "[0]" -o json)" || exit 1
  [ -n "$existing_json" ] && [ "$existing_json" != "null" ] \
    || die "could not read back the live '${role}' assignment on ${scope} as an object; refusing to reconcile blind."

  # Change ONLY the condition and its version. Everything else — id, name,
  # principalId, roleDefinitionId, scope — is carried through verbatim, so the
  # PUT cannot silently re-point the grant at a different principal or role.
  updated_json="$(printf '%s' "$existing_json" \
    | jq --arg cond "$condition" '.condition = $cond | .conditionVersion = "2.0"')" \
    || die "failed to build the updated role-assignment document for '${role}' on ${scope}; nothing was changed."

  # A temp FILE, not an inline argument: the condition is a multi-line
  # expression full of quotes and braces, and `@file` hands az the bytes
  # directly instead of routing them through another layer of shell quoting.
  assignment_file="$(mktemp)" || die "could not create a temporary file for the role-assignment update."
  printf '%s' "$updated_json" > "$assignment_file" \
    || { rm -f "$assignment_file"; die "could not write the role-assignment update document."; }
  if ! az role assignment update --role-assignment "@${assignment_file}" -o none; then
    rm -f "$assignment_file"
    die "failed to update the ABAC condition on '${role}' @ ${scope} IN PLACE. NOTHING WAS DELETED — the identity still holds its grant with the PREVIOUS condition, which still constrains role writes to the previously-allowlisted set (so an apply needing a newly-allowlisted role fails closed rather than being handed an unconditioned grant). Fix the cause and re-run; do NOT work around this by deleting the assignment by hand while an automatic apply may be in flight."
  fi
  rm -f "$assignment_file"

  # VERIFY THE WRITE LANDED (MG-23 red). A 2xx from `az role assignment update`
  # says ARM ACCEPTED the PUT, not that the new condition is what the service
  # will enforce from here on. The two come apart in ways that are entirely
  # ordinary: a partially-applied PUT, an RBAC replica that has not converged, a
  # future az/ARM version that silently ignores a field it does not recognize,
  # or a condition ARM normalizes into something other than what we sent.
  #
  # In every one of those cases the un-verified helper prints "reconciled" and
  # exits 0 over a grant that still carries the STALE condition — which is
  # exactly the FROZEN-CONDITION failure this whole helper exists to prevent,
  # reintroduced one layer up. The operator's next signal would be an apply
  # dying mid-run with AuthorizationFailed and a partially-applied stack, with a
  # green bootstrap log behind it saying the condition was updated. A reconcile
  # that cannot prove it reconciled is not a reconcile.
  #
  # So: READ THE LIVE CONDITION BACK AND ASSERT IT. Same SINGLE-VALUE query
  # discipline as the read above — `[0].condition` through az_discover, NEVER
  # az_discover_unique, whose line-counting uniqueness guard would read a
  # multi-line condition (which the real one is: two clauses) as N matching
  # objects and die AMBIGUOUS. Uniqueness was already proven by the `[].id` read
  # at the top of this function.
  # `|| exit 1` — a REAL az error on the verification read must abort with that
  # error, not collapse to empty and be reported as "the condition did NOT take".
  #
  # BOUNDED RETRY, THE SAME ONE THE CREATE PATH USES — same COND_READBACK_*
  # bounds, same backoff, deliberately not a second retry strategy invented for
  # this path. ARM role-assignment write→read is eventually consistent in BOTH
  # directions: the create path already retries for exactly this reason, and an
  # in-place PUT is no more instantly readable than a create. A single unretried
  # read here turns ordinary RBAC REPLICA LAG — the read landing on a replica
  # that has not yet seen the PUT, so it still returns the STALE condition — into
  # a hard "the condition did NOT take" verification failure, aborting a
  # bootstrap whose update in fact succeeded.
  #
  # WHAT IS AND IS NOT RETRIED. The loop retries only the MISMATCH, and only
  # within the budget: a genuine, DURABLE mismatch — ARM accepted the PUT but did
  # not store it — never converges, so it exhausts the attempts and still fails,
  # which is the behaviour this verification exists for. Retrying does not soften
  # the check; it only declines to call the first read authoritative. A REAL az
  # error is not retried at all (`|| exit 1` aborts with that error), because a
  # broken read is not replica lag.
  attempt=1
  max_attempts="${COND_READBACK_ATTEMPTS:-5}"
  delay="${COND_READBACK_DELAY:-3}"
  while :; do
    verify_condition="$(az_discover "post-update condition on ${role} @ ${scope}" \
      az role assignment list \
      --assignee "$object_id" \
      --role "$role" \
      --scope "$scope" \
      --query "[0].condition" -o tsv)" || exit 1

    # Normalized compare, matching the drift check above: Azure does not return
    # the exact bytes we sent (whitespace and keyword case differ), so a byte
    # compare would fail every time and turn a correct reconcile into a hard
    # error.
    if [ "$(normalize_condition "$verify_condition")" = "$(normalize_condition "$condition")" ]; then
      break
    fi

    if [ "$attempt" -ge "$max_attempts" ]; then
      die "the ABAC condition on '${role}' @ ${scope} did NOT take: ARM accepted the in-place update but the condition read back afterwards still differs from the intended one after ${max_attempts} attempts. The grant is live with a condition this bootstrap did not author — treat it as UNVERIFIED and do not activate the apply loop against it. NOTHING WAS DELETED. Inspect the live condition by hand with 'az role assignment list' for assignee ${object_id}, role '${role}', scope '${scope}', then re-run this bootstrap."
    fi
    attempt=$((attempt + 1))
    sleep "$delay"
  done

  ok "ABAC condition reconciled IN PLACE on ${role} @ ${scope} and VERIFIED by read-back (no no-grant window)"
}

# --------------------------------------------------------------------------
# The Terraform-managed role allowlist (MG-23 F9/F10) — read, never inlined.
# --------------------------------------------------------------------------
# The role NAMES live in exactly one place outside the Terraform graph:
# tf-managed-role-allowlist.tsv. This script builds the ABAC condition FROM that
# file and scripts/tf-static-checks.sh CHECK 13 diffs the SAME file against every
# `role_definition_name` in the graph. Re-listing the roles here would defeat the
# single-derivation discipline the file exists for: the CI check would then guard
# a list this script does not use.
allowlist_role_names() {
  [ -f "$ROLE_ALLOWLIST_FILE" ] \
    || die "role allowlist not found: ${ROLE_ALLOWLIST_FILE}. It is the single source of truth for the apply identity's ABAC condition; refusing to author a condition without it (an empty allowlist would deny every Terraform-managed role grant and break every apply)."
  awk -F'\t' '$0 !~ /^#/ && NF >= 2 && $1 != "" { print $1 }' "$ROLE_ALLOWLIST_FILE"
}

# The GUID column as COMMITTED (may be the literal PENDING before the first run).
allowlist_committed_guid() {
  awk -F'\t' -v role="$1" '$0 !~ /^#/ && NF >= 2 && $1 == role { print $2; exit }' \
    "$ROLE_ALLOWLIST_FILE"
}

# --------------------------------------------------------------------------
# Resolve every allowlisted role's definition GUID LIVE, fail-closed.
# --------------------------------------------------------------------------
# MG-23 F10. An ABAC condition matches on the role-definition GUID, never on the
# display name, so the GUIDs must be right or the condition silently means
# something other than what it reads. They are resolved LIVE from the tenant —
# NEVER from a remembered constant — and a committed GUID that DISAGREES with the
# live one is a hard failure, not something to paper over by preferring either
# value. Emits `role<TAB>guid` on stdout (all logging goes to stderr so the
# caller can capture the result cleanly).
resolve_allowlist_role_guids() {
  local names role live committed out=""
  names="$(allowlist_role_names)"
  # Read from a here-string, NOT `allowlist_role_names | while`: a pipeline runs
  # the loop body in a SUBSHELL, where `die`'s exit would abort only that
  # subshell and the caller's `$(...)` capture would proceed with a partial
  # allowlist — i.e. a fail-closed check silently degraded into a shorter
  # allowlist. Same shell, so a die here really aborts the bootstrap.
  while IFS= read -r role; do
    [ -z "$role" ] && continue
    live="$(az_discover_unique "role definition '${role}'" \
      az role definition list --name "$role" --query "[].name" -o tsv)"
    if [ -z "$live" ] || [ "$live" = "null" ]; then
      die "could not resolve a role-definition id for '${role}' in this tenant. The allowlist names a role Azure does not know here; the ABAC condition would silently omit it and every Terraform grant of that role would fail mid-apply."
    fi
    committed="$(allowlist_committed_guid "$role")"
    if [ -n "$committed" ] && [ "$committed" != "PENDING" ] \
       && [ "$(printf '%s' "$committed" | tr '[:upper:]' '[:lower:]')" != "$(printf '%s' "$live" | tr '[:upper:]' '[:lower:]')" ]; then
      die "role-definition GUID MISMATCH for '${role}': committed '${committed}' but this tenant resolves '${live}'. Refusing to guess which is authoritative — a wrong GUID authors a condition that does not mean what it reads. Investigate, then update ${ROLE_ALLOWLIST_FILE}."
    fi
    out="${out}${role}	${live}"$'\n'
    printf 'resolved role definition: %s -> %s\n' "$role" "$live" >&2
  done <<< "$names"
  printf '%s' "$out"
}

# --------------------------------------------------------------------------
# Build the ABAC condition for the apply identity's RBAC-administrator grant.
# --------------------------------------------------------------------------
# MG-23 F11. TWO clauses, both at condition-version 2.0:
#
#   WRITE  — @Request: the role being granted must be one of the allowlisted
#            Terraform-managed definitions AND the grantee must be a
#            ServicePrincipal. Constraining the request is what stops the apply
#            identity granting itself (or anyone) Owner / Contributor / User
#            Access Administrator inside the RG.
#   DELETE — @Resource: the role being revoked must be allowlisted. This clause
#            is NOT optional. A write-only condition leaves DELETE completely
#            unconstrained at RG scope, which is an OUTAGE PRIMITIVE: the identity
#            could revoke the Function App's managed-identity role assignments, or
#            its own, and take dev down without ever escalating. PrincipalType is
#            not asserted on the delete clause because it may not exist in the
#            @Resource attribute set; RoleDefinitionId alone is sufficient there,
#            since deleting an assignment cannot escalate privilege.
#
# EXPLICITLY NOT DONE: no `!(Exists ...) OR ...` tolerance on any attribute. That
# shape reads as defensive but is a ONE-FIELD BYPASS — a caller that simply omits
# the attribute satisfies the clause. If the azurerm provider turns out not to
# send principalType (blocking check B1 in docs/infrastructure/mg23-live-acceptance.md),
# the fix is the explicit `principal_type = "ServicePrincipal"` on every
# azurerm_role_assignment in the graph, NOT a loosened condition.
#
# UNVERIFIED UNTIL THE LIVE PHASE (B3): whether GuidEquals matches when the
# provider sends a FULL ARM roleDefinitionId path rather than a bare GUID. If it
# does not, this condition fails SHUT (every apply denied) — loudly, not silently.
# That is the correct failure direction, and it is a BLOCKING pre-activation
# check, not an assumption.
build_rbac_admin_condition() {
  local resolved="$1" guids
  guids="$(printf '%s\n' "$resolved" \
    | awk -F'\t' 'NF >= 2 && $2 != "" { printf "%s%s", sep, $2; sep=", " }')"
  [ -n "$guids" ] \
    || die "the resolved role allowlist is EMPTY — refusing to author an RBAC-administrator condition with no allowlisted roles (it would deny every Terraform role grant, breaking every apply)."
  cat <<CONDITION
(
 (
  !(ActionMatches{'Microsoft.Authorization/roleAssignments/write'})
 )
 OR
 (
  @Request[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals{${guids}}
  AND
  @Request[Microsoft.Authorization/roleAssignments:PrincipalType] ForAnyOfAnyValues:StringEqualsIgnoreCase{'ServicePrincipal'}
 )
)
AND
(
 (
  !(ActionMatches{'Microsoft.Authorization/roleAssignments/delete'})
 )
 OR
 (
  @Resource[Microsoft.Authorization/roleAssignments:RoleDefinitionId] ForAnyOfAnyValues:GuidEquals{${guids}}
 )
)
CONDITION
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
  state_sa_id="$(state_account_id)"
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
    # A BARE call, deliberately. This used to be `… || die "…"`, which put the
    # whole function body in a `||` context and thereby suppressed errexit
    # inside it — letting a failed/ambiguous discovery fall through to a create.
    # The diagnosis that `die` carried now lives on the create INSIDE
    # ensure_role_assignment, where it covers every call site. `if !` is not an
    # alternative here: it suppresses errexit identically.
    ensure_role_assignment "$operator_oid" User "Storage Blob Data Contributor" "$state_sa_id"
    ok "Storage Blob Data Contributor granted to the operator on ${STATE_STORAGE_ACCOUNT}"
    # Wait (bounded poll, not a blind sleep) for the just-granted data-plane role
    # to become effective before the first `--auth-mode login` container call.
    wait_for_blob_data_plane "$STATE_STORAGE_ACCOUNT"
  fi

  # STATE_ENVIRONMENTS, not GITHUB_ENVIRONMENTS: there is one container per
  # TERRAFORM environment (tfstate-dev / tfstate-prod). The extra MG-23 GitHub
  # Environments federate trust; they do not own state.
  local env container
  for env in $STATE_ENVIRONMENTS; do
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
  # Fail-loud, non-empty-asserted (see state_account_id): the account already
  # exists from bootstrap_state_backend, so a failure here is a REAL error and
  # must not silently skip the per-env blob-role grant.
  state_sa_id="$(state_account_id)"

  # PLAN_IDENTITY_ENVIRONMENTS, not GITHUB_ENVIRONMENTS (MG-23 F8): one
  # environment, one identity, one privilege level. As of the 2026-07-27
  # re-scope this loop runs for `production` ALONE — there is no dev plan
  # identity, because dev PR validation is credentialless. The `development` and
  # `development-infra-apply` environments belong to the app-deploy and
  # infra-apply identities respectively, each provisioned by its own function.
  local env tfenv app_name app_id sp_id cred_name subject container container_scope
  local state_role
  for env in $PLAN_IDENTITY_ENVIRONMENTS; do
    tfenv="$(tf_env_for "$env")"
    app_name="${AAD_APP_NAME}-${tfenv}"
    container="$(state_container_for "$env")"
    # A plain write-capable blob-data role: infra-deploy-prod.yml runs a LOCKED
    # plan, and taking the Azure blob lease requires blob write. The round-5
    # read-only variant applied only to the (now deleted) PR-reachable dev plan
    # identity; see the REMOVED note near PLAN_IDENTITY_ENVIRONMENTS.
    state_role="Storage Blob Data Contributor"

    log "── Environment '${env}' (tf: ${tfenv}) — PLAN/READ identity ${app_name}"

    # AAD application PER ENVIRONMENT (create-if-absent, keyed by display name).
    # Discovery distinguishes absent (empty, exit 0 → create) from a real error.
    app_id="$(az_discover_unique "AAD application '${app_name}'" \
      az ad app list --display-name "$app_name" --query '[].appId' -o tsv)"
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
    sp_id="$(az_discover_unique "service principal for app ${app_id}" \
      az ad sp list --filter "appId eq '${app_id}'" --query '[].id' -o tsv)"
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
    # MG-23 F8: this identity trusts EXACTLY ONE environment. The dev plan
    # identity previously carried a `github-development` credential; leaving it in
    # place would let a job in the `development` environment (now the app-deploy
    # identity's) still assume this one, defeating the whole split.
    prune_unexpected_federated_credentials "$app_id" "$cred_name"

    # Least-privilege role: Reader (plan/read) at the subscription scope so
    # `terraform plan` can read live resource state. This role CANNOT mutate
    # infrastructure — an accidental CI apply fails closed. Idempotent.
    log "Assigning ${CI_PLAN_ROLE} (plan/read-only) at subscription scope for ${env}"
    ensure_role_assignment "$sp_id" ServicePrincipal "$CI_PLAN_ROLE" "/subscriptions/${sub_id}"
    ok "${CI_PLAN_ROLE} granted to the ${env} CI identity (no write/apply role)"

    # Data-plane access to THIS ENVIRONMENT'S state container ONLY — not the
    # whole state account, and not the other environment's container. This is
    # the per-env state isolation: the dev SP can read dev.tfstate but cannot
    # touch prod.tfstate, and vice-versa.
    #
    container_scope="${state_sa_id}/blobServices/default/containers/${container}"
    ensure_role_assignment "$sp_id" ServicePrincipal "$state_role" "$container_scope"
    ok "${state_role} granted on container ${container} ONLY"

    # Emit the (non-secret) coordinates the operator wires into the matching
    # GitHub Environment. NOTE: these are identifiers, NOT secrets — OIDC issues
    # short-lived tokens at run time, so nothing here needs guarding.
    #
    # ONE state posture, stated unconditionally. There used to be a second
    # branch here describing a READ-ONLY, `-lock=false`, PR-time plan identity.
    # That identity no longer exists — MG-23 deleted the dev plan identity along
    # with the remote-state PR plan job, because PR validation is now
    # credentialless. `state_role` is assigned exactly one value above, so the
    # branch was unreachable, and it survived only to describe a posture nothing
    # in this repo has. (It also leaked a non-`local` variable out of this
    # function.) Deleted rather than left as documentation of a design that was
    # removed: an unreachable branch reads as a live alternative.
    cat <<SUMMARY

────────────────────────────────────────────────────────────────────
GitHub Environment '${env}' — PLAN/READ identity. Add these as *Environment*
variables (NO client secret exists or is needed):

  AZURE_CLIENT_ID        = ${app_id}
  AZURE_TENANT_ID        = ${tenant_id}
  AZURE_SUBSCRIPTION_ID  = ${sub_id}

  Federated subject: ${subject}
  State container:   ${container} (this env's isolated tfstate)
  CI role: ${CI_PLAN_ROLE} (plan/read-only) + ${state_role}
           on container ${container} ONLY. This identity can NEVER apply.
           The dev CI-run apply is the SEPARATE infra-apply identity
           (AZURE_INFRA_APPLY_CLIENT_ID, MG-23); publishing app code is the
           SEPARATE deployment identity (AZURE_APP_DEPLOY_CLIENT_ID). Prod
           infra remains plan-only until MG-25 activates it.
  NOTE: this environment's plan is LOCKED, so its identity keeps a
           write-capable blob-data role on state. It is NOT PR-reachable
           (workflow_dispatch behind the environment's protection rules).
           Narrowing it belongs with MG-25, where that workflow changes.
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
  local h cmd
  # Resolved, not hardcoded: `sha1sum` is coreutils (Linux), `shasum -a 1` is
  # what macOS ships. Both produce the same digest, so the derived scope id does
  # not move with the operator's platform. require_tools has already proven one
  # of them exists; this second check keeps the function honest when it is
  # sourced and called directly (as the tests do).
  cmd="$(resolve_sha1_cmd)" \
    || die "no sha1 implementation found (need 'sha1sum' or 'shasum') — cannot derive the stable scope GUID."
  # shellcheck disable=SC2086  # $cmd is a resolved command + flags, split intentionally.
  h="$(printf '%s' "$1" | $cmd | cut -c1-32)"
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
  # Fail-loud, non-empty-asserted — see state_account_id.
  state_sa_id="$(state_account_id)"

  # DEV ONLY. Prod app-deployment identity is MG-25 (see runbook / summary).
  # MG-23: the bare `development` GitHub Environment now belongs to THIS identity
  # alone — the dev infra-apply identity has its own environment, and there is no
  # dev plan identity at all (PR validation is credentialless).
  local env="$APP_DEPLOY_ENVIRONMENT" tfenv
  tfenv="$(tf_env_for "$env")"
  local app_name="${AAD_DEPLOY_APP_NAME}-${tfenv}"
  local container app_id sp_id cred_name subject container_scope
  container="$(state_container_for "$env")"

  log "── dev APP-DEPLOYMENT identity ${app_name} (publish-only, separate SP)"

  app_id="$(az_discover_unique "AAD application '${app_name}'" \
    az ad app list --display-name "$app_name" --query '[].appId' -o tsv)"
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
  sp_id="$(az_discover_unique "service principal for app ${app_id}" \
    az ad sp list --filter "appId eq '${app_id}'" --query '[].id' -o tsv)"
  if [ -z "$sp_id" ] || [ "$sp_id" = "null" ]; then
    log "Creating service principal for ${app_id}"
    sp_id="$(az ad sp create --id "$app_id" --query id -o tsv)" \
      || die "failed to create the service principal for the dev app-deployment identity (${app_id}) — check you may create service principals in the tenant."
    ok "Service principal created: ${sp_id}"
  else
    ok "Service principal already exists: ${sp_id}"
  fi

  # Federate the `development` GitHub Environment — which, post-MG-23, is THIS
  # identity's environment and no one else's. The post-merge apply job runs in
  # `development-infra-apply` under its own identity, and PR validation runs
  # under no identity at all, so the privilege a job gets is now decided by the
  # environment it declares (and that environment's protection rules) rather
  # than by which client-id string the job happens to pass.
  cred_name="github-appdeploy-${env}"
  subject="repo:${GITHUB_REPO}:environment:${env}"
  # Reconcile on SUBJECT, not just name (see ensure_federated_credential): a
  # credential with the right name but a stale/wrong subject would bind
  # deployment federation to the WRONG trust.
  ensure_federated_credential "$app_id" "$cred_name" "$subject" \
    "GitHub Actions OIDC (app-deploy) for the '${env}' environment of ${GITHUB_REPO}"
  prune_unexpected_federated_credentials "$app_id" "$cred_name"

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
  container_scope="${state_sa_id}/blobServices/default/containers/${container}"
  ensure_role_assignment "$sp_id" ServicePrincipal "Storage Blob Data Reader" "$container_scope"
  ok "Storage Blob Data Reader granted on container ${container} ONLY (read-only)"

  cat <<SUMMARY

────────────────────────────────────────────────────────────────────
dev APP-DEPLOYMENT identity — separate SP, publish-only.

  1) Add as an *Environment* variable on the GitHub 'development' environment
     (NO client secret exists or is needed):

       AZURE_APP_DEPLOY_CLIENT_ID = ${app_id}
       (AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID are shared with the plan identity)

  2) Set this SP OBJECT ID in environments/dev.tfvars BEFORE the apply so
     Terraform grants '${DEPLOY_APP_ROLE}' scoped to the Function App alone in
     the SAME apply that creates it (then \`func publish\` works immediately):

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
# 3b. dev INFRA-APPLY identity (create-if-absent) — MG-23.
#
#     The identity .github/workflows/infra-apply-dev.yml assumes to run the
#     AUTOMATED dev GitOps reconciliation (CI-run apply on merge to main). This is
#     the ONLY identity in this bootstrap that can write infrastructure, so its
#     authority is bounded on every axis that can be bounded:
#
#       WHERE  Contributor scoped to /resourceGroups/meatgeek-v2-dev-rg ONLY.
#              No subscription-scoped grant of any kind.
#       WHAT   "Role Based Access Control Administrator" on the SAME RG, carrying
#              an ABAC condition (v2.0) that allowlists exactly the
#              Terraform-managed role definitions and restricts grants to
#              ServicePrincipal principals — on BOTH write and delete.
#       STATE  Storage Blob Data Contributor on the tfstate-dev CONTAINER ONLY
#              (not the account, so it cannot touch prod state).
#       WHO    One federated credential, one subject:
#              repo:<repo>:environment:development-infra-apply.
#       HOW    OIDC only. No client secret is ever minted.
#
#     THREAT MODEL PRECONDITIONS (F18) — these are LOAD-BEARING, not incidental.
#     The escalation paths that would otherwise defeat everything above are
#     CLOSED because:
#       * NO Microsoft Graph permission — the identity cannot create apps, mint
#         credentials on existing apps, or add federated credentials, so it cannot
#         manufacture a second identity for itself.
#       * NO subscription scope — it cannot read or write outside the dev RG,
#         cannot enumerate the subscription, and cannot register resource
#         providers (which is why the provider block sets
#         resource_provider_registrations = "none" and RP registration is an
#         operator precondition).
#       * The Terraform STATE ACCOUNT lives in a SEPARATE resource group
#         (meatgeek-v2-tfstate-rg), so RG-scoped Contributor on the workload RG
#         confers NOTHING over state beyond the container-scoped data role above.
#     Any future change that adds a Graph permission, widens a scope to the
#     subscription, or moves the state account into the dev RG INVALIDATES this
#     threat model and requires a fresh one — it is not a tuning knob.
#
#     ACCEPTED RESIDUALS (stated plainly; the condition does NOT cover them, and
#     nothing here should be read as claiming it does) — see
#     docs/infrastructure/mg23-live-acceptance.md:
#       F4  the condition constrains WHICH role, never WHERE. An allowlisted role
#           can be re-granted RG-wide -> code execution as the Function App's
#           managed identity. That is persistence/stealth, not a boundary break:
#           it does not exceed the identity's own Contributor. Compensating
#           control is the Activity Log alerting on roleAssignments/write.
#       F6  Cosmos data-plane sqlRoleAssignments are Contributor-granted, are
#           invisible to a Microsoft.Authorization condition, and accept USER
#           principals — the clearest gap versus "SP/MI-only". Accepted for dev.
#       F17 PrincipalType ServicePrincipal excludes humans and groups but CANNOT
#           exclude ordinary application service principals, and managed
#           identities are not separable (they ARE service principals).
# --------------------------------------------------------------------------
bootstrap_infra_apply_identity() {
  local sub_id tenant_id state_sa_id
  sub_id="$(az account show --query id -o tsv)"
  tenant_id="$(az account show --query tenantId -o tsv)"
  state_sa_id="$(state_account_id)"

  # The blast radius is a literal in this file, and it must survive the V1-safety
  # guard before ANY grant is issued — a mistyped RG here is a Contributor grant
  # on the wrong resource group.
  assert_v2_name "resource group" "$DEV_WORKLOAD_RG" \
    || die "the dev workload resource group failed the V2 guard; refusing to grant ${INFRA_APPLY_ROLE} anywhere"

  local env="$INFRA_APPLY_ENVIRONMENT" tfenv
  tfenv="$(tf_env_for "$env")"
  local app_name="${AAD_INFRA_APPLY_APP_NAME}-${tfenv}"
  local container app_id sp_id cred_name subject container_scope rg_scope
  local resolved condition
  container="$(state_container_for "$env")"
  rg_scope="/subscriptions/${sub_id}/resourceGroups/${DEV_WORKLOAD_RG}"

  log "── dev INFRA-APPLY identity ${app_name} (MG-23 automated dev GitOps reconciliation)"

  app_id="$(az_discover_unique "AAD application '${app_name}'" \
    az ad app list --display-name "$app_name" --query '[].appId' -o tsv)"
  if [ -z "$app_id" ] || [ "$app_id" = "null" ]; then
    log "Creating AAD application: ${app_name}"
    app_id="$(az ad app create --display-name "$app_name" --query appId -o tsv)" \
      || die "failed to create the AAD application '${app_name}' for the dev infra-apply identity — check tenant app-registration permissions."
    ok "AAD application created: ${app_id}"
  else
    ok "AAD application already exists: ${app_id}"
  fi

  # Service principal (create-if-absent). NO password/secret — OIDC federation is
  # the only credential this identity will ever have. `sp list --filter` (not
  # `sp show`) so absent = empty/exit-0 and a real error stays non-zero.
  sp_id="$(az_discover_unique "service principal for app ${app_id}" \
    az ad sp list --filter "appId eq '${app_id}'" --query '[].id' -o tsv)"
  if [ -z "$sp_id" ] || [ "$sp_id" = "null" ]; then
    log "Creating service principal for ${app_id}"
    sp_id="$(az ad sp create --id "$app_id" --query id -o tsv)" \
      || die "failed to create the service principal for the dev infra-apply identity (${app_id}) — check you may create service principals in the tenant."
    ok "Service principal created: ${sp_id}"
  else
    ok "Service principal already exists: ${sp_id}"
  fi

  # ONE federated credential, ONE subject — and nothing else on this app. The
  # `development-infra-apply` GitHub Environment carries the deployment-branch
  # policy (main) that decides which refs may ever mint a token for this identity;
  # an extra credential here would be a trust path outside that policy.
  cred_name="github-infra-apply-${env}"
  subject="repo:${GITHUB_REPO}:environment:${env}"
  ensure_federated_credential "$app_id" "$cred_name" "$subject" \
    "GitHub Actions OIDC (dev infra apply, MG-23) for the '${env}' environment of ${GITHUB_REPO}"
  prune_unexpected_federated_credentials "$app_id" "$cred_name"

  # WHERE: Contributor on the dev workload RG and nowhere else. Contributor
  # cannot grant RBAC and holds no Graph permission, which is precisely why the
  # separate CONDITIONED RBAC-admin grant below is needed — and why it is worth
  # conditioning rather than just adding User Access Administrator.
  log "Assigning ${INFRA_APPLY_ROLE} scoped ONLY to ${DEV_WORKLOAD_RG} (no subscription scope)"
  ensure_role_assignment "$sp_id" ServicePrincipal "$INFRA_APPLY_ROLE" "$rg_scope"
  ok "${INFRA_APPLY_ROLE} granted on ${DEV_WORKLOAD_RG} ONLY"

  # WHAT: the conditioned RBAC-administrator grant. The condition is built FROM
  # the allowlist file with LIVE-resolved GUIDs — never from a role list written
  # into this script, and never from remembered GUIDs.
  resolved="$(resolve_allowlist_role_guids)" \
    || die "could not resolve the Terraform-managed role allowlist; refusing to author an RBAC-administrator condition from an incomplete list."
  condition="$(build_rbac_admin_condition "$resolved")"
  log "Assigning CONDITIONED ${INFRA_APPLY_RBAC_ROLE} scoped ONLY to ${DEV_WORKLOAD_RG}"
  ensure_conditioned_role_assignment "$sp_id" ServicePrincipal \
    "$INFRA_APPLY_RBAC_ROLE" "$rg_scope" "$condition"

  # STATE: the dev container ONLY — the same per-env isolation every other
  # identity here gets. Contributor (not Reader) because an apply WRITES state.
  container_scope="${state_sa_id}/blobServices/default/containers/${container}"
  ensure_role_assignment "$sp_id" ServicePrincipal "Storage Blob Data Contributor" "$container_scope"
  ok "Storage Blob Data Contributor granted on container ${container} ONLY"

  cat <<SUMMARY

────────────────────────────────────────────────────────────────────
dev INFRA-APPLY identity (MG-23) — CI-run automated dev GitOps reconciliation.

  Add as an *Environment* variable on the GitHub '${env}' environment
  (NO client secret exists or is needed):

    AZURE_INFRA_APPLY_CLIENT_ID = ${app_id}
    (AZURE_TENANT_ID / AZURE_SUBSCRIPTION_ID are shared with the other identities)

  Federated subject: ${subject}
  This client id is DISTINCT from AZURE_CLIENT_ID (the read-only plan identity)
  and AZURE_APP_DEPLOY_CLIENT_ID (the publish identity). Do not cross-wire them.

  Grants — the complete set, nothing else:
    ${INFRA_APPLY_ROLE} on /resourceGroups/${DEV_WORKLOAD_RG}
    ${INFRA_APPLY_RBAC_ROLE} on /resourceGroups/${DEV_WORKLOAD_RG}, CONDITIONED
      to the allowlist in $(basename "$ROLE_ALLOWLIST_FILE") (write AND delete)
    Storage Blob Data Contributor on container ${container} ONLY
  No subscription-wide role. No Microsoft Graph permission. No client secret.

  ⚠ BLOCKING PRE-ACTIVATION CHECKS — the ABAC condition above encodes three
    facts about Azure that have NOT been verified live. Verify each BEFORE you
    set DEV_TF_BACKEND_READY=true; do not assume either outcome. Both branches
    of each are designed in docs/infrastructure/mg23-live-acceptance.md
    (B1/B2/B3), together with the T1-T7 live acceptance tests:

      B1  Does the azurerm provider send principalType in the roleAssignments
          request body? If it does NOT, the PrincipalType clause fails SHUT
          against every apply. Remedy: the explicit principal_type on every
          azurerm_role_assignment in the graph — NEVER an attribute-existence
          tolerance clause, which is a one-field bypass (a caller that simply
          omits principalType would then satisfy the clause unconditionally).
      B2  Does Azure validate a caller-declared principalType against the
          directory, or is "SP/MI-only" decorative? (Acceptance test T3.)
      B3  Does GuidEquals match when the provider sends a full ARM
          roleDefinitionId PATH rather than a bare GUID? If not, the condition
          fails shut — loudly, which is the correct direction.

  ⚠ Run the T1-T7 acceptance tests AS THIS SERVICE PRINCIPAL, via TERRAFORM (not
    via 'az'): the az CLI always sends principalType, which false-greens B1.

  This bootstrap creates the identity. It does NOT set DEV_TF_BACKEND_READY and
  runs no apply — activation is a separate, gated operator step.
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
  local tenant_id app_id app_uri scope_id preauth_json api_body preauth_body
  tenant_id="$(az account show --query tenantId -o tsv)"

  log "── dev ENTRA API auth registration ${DEV_API_APP_NAME} (scope ${DEV_API_SCOPE_NAME})"

  app_id="$(az_discover_unique "dev API registration '${DEV_API_APP_NAME}'" \
    az ad app list --display-name "$DEV_API_APP_NAME" --query '[].appId' -o tsv)"
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
  # Microsoft Graph PATCH (idempotent — the stable scope id makes repeat PATCHes
  # converge). NO client secret / password anywhere. This scope-defining PATCH
  # MUST be issued BEFORE the preAuthorizedApplications PATCH below: Graph
  # validates preAuthorizedApplications.delegatedPermissionIds against scopes
  # that ALREADY EXIST on the app and cannot see a scope defined in the SAME
  # request, so combining both in one atomic PATCH returns 400
  # ('Permission Id … cannot be found in the AppPermissions sets') and the
  # ENTIRE api block fails (no scope, no identifierUris).
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
    ]
  }
}
JSON
)"
  az rest --method PATCH \
    --uri "https://graph.microsoft.com/v1.0/applications(appId='${app_id}')" \
    --headers "Content-Type=application/json" \
    --body "$api_body" \
    -o none \
    || die "failed to expose the delegated scope '${DEV_API_SCOPE_NAME}' on ${app_uri} (Graph PATCH 1)"
  ok "Delegated scope '${DEV_API_SCOPE_NAME}' exposed on ${app_uri} (no client secret)"

  # SECOND Graph PATCH: now that the scope id is PERSISTED on the app, set
  # api.preAuthorizedApplications referencing it. Kept separate from the first
  # PATCH (see above) because delegatedPermissionIds only resolves against
  # already-existing scopes. Idempotent (the stable scope id converges on
  # re-run) and fail-loud. Skipped entirely when no calling client ids exist.
  if [ -n "$preauth_entries" ]; then
    preauth_body="$(cat <<JSON
{
  "api": {
    "preAuthorizedApplications": ${preauth_json}
  }
}
JSON
)"
    az rest --method PATCH \
      --uri "https://graph.microsoft.com/v1.0/applications(appId='${app_id}')" \
      --headers "Content-Type=application/json" \
      --body "$preauth_body" \
      -o none \
      || die "failed to pre-authorize calling client(s) [${preauth_ids}] for '${DEV_API_SCOPE_NAME}' (Graph PATCH 2)"
    ok "Pre-authorized calling client(s) for '${DEV_API_SCOPE_NAME}': ${preauth_ids}"
  else
    log "No calling client ids supplied — skipping preAuthorizedApplications PATCH"
  fi

  # Enterprise app (SP) so the API can be granted admin consent in the tenant.
  # Guarded create-if-absent: `sp list --filter` distinguishes absent (empty,
  # exit 0) from a REAL discovery error (non-zero → die via az_discover), and the
  # create itself FAILS LOUD — no `|| true` that would report a phantom "created".
  local api_sp_id
  api_sp_id="$(az_discover_unique "service principal for the dev API registration (${app_id})" \
    az ad sp list --filter "appId eq '${app_id}'" --query '[].id' -o tsv)"
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

# --------------------------------------------------------------------------
# The environment/subject map is ENFORCED here, not merely described (MG-23 F8).
# --------------------------------------------------------------------------
# F8's whole point: before MG-23, every dev identity federated the IDENTICAL
# subject `repo:<repo>:environment:development`, and which identity a job
# assumed was decided ONLY by the client id the job passed. A one-line client-id
# edit merged to main therefore upgraded a read-only job to a full apply, with
# nothing in the OIDC trust to stop it. The fix is that each identity federates
# its OWN environment — but that fix holds only while the environments stay
# DISTINCT, and nothing was checking.
#
# So this runs BEFORE any identity is provisioned and fails closed on a
# collision. Two identities sharing an environment is not a cosmetic duplicate:
# it silently restores the exact ambiguity F8 removed, and it would do so
# quietly, since both identities would bootstrap successfully.
#
# It also refuses to let the RECOVERY environment become federated. That
# environment exists to hold a HUMAN approval on a destructive recovery apply;
# minting an OIDC trust for it would turn the gate into just another machine
# identity.
assert_federated_environment_map() {
  local env seen="" dupes=""
  # Every environment an identity actually federates, in the same derivation
  # order GITHUB_ENVIRONMENTS is built from — listed WITH duplicates on purpose,
  # because duplicates are precisely what this check is looking for.
  # shellcheck disable=SC2086
  for env in $PLAN_IDENTITY_ENVIRONMENTS "$APP_DEPLOY_ENVIRONMENT" "$INFRA_APPLY_ENVIRONMENT"; do
    [ -n "$env" ] || die "an identity is configured to federate an EMPTY GitHub Environment name; the resulting subject would be 'repo:${GITHUB_REPO}:environment:' and would match nothing (or, worse, something unintended)."
    case " $seen " in
      *" $env "*) dupes="${dupes} ${env}" ;;
      *) seen="${seen} ${env}" ;;
    esac
  done

  if [ -n "$dupes" ]; then
    die "ENVIRONMENT MAP COLLISION: more than one identity federates${dupes}. That is the MG-23 F8 defect this map exists to remove — identities sharing one OIDC subject are selected only by the client id a workflow job passes, so a one-line client-id edit silently swaps a read-only identity for an apply-capable one. Give each identity its own GitHub Environment."
  fi

  # The recovery environment holds a human, never a machine.
  case " $GITHUB_ENVIRONMENTS " in
    *" $RECOVERY_APPROVAL_ENVIRONMENT "*)
      die "'${RECOVERY_APPROVAL_ENVIRONMENT}' must NOT be federated: it is the human-approval gate on the destructive recovery apply. Federating it would mint an OIDC trust for the one environment whose entire purpose is to require a person." ;;
  esac

  log "Environment/subject map: ${GITHUB_ENVIRONMENTS// /, } (one identity each; '${RECOVERY_APPROVAL_ENVIRONMENT}' is approval-only, unfederated)"
}

main() {
  log "🚀 MeatGeek V2 bootstrap (remote state + plan/deploy identities + dev API auth)"
  require_tools
  # BEFORE anything is provisioned: refuse to build a map that reintroduces F8.
  assert_federated_environment_map
  bootstrap_state_backend
  bootstrap_oidc_identity        # per-env PLAN/READ identities (Reader)
  bootstrap_deploy_identity      # dev APP-DEPLOYMENT identity (publish-only)
  bootstrap_infra_apply_identity # dev INFRA-APPLY identity (MG-23, RG-scoped)
  bootstrap_dev_api_registration # dev Entra API auth registration (access_as_user)
  # GitHub-side, not Azure-side. BOTH environments must EXIST WITH THE RIGHT
  # PROTECTION before activation, or GitHub auto-creates them unprotected on
  # first workflow reference. Neither may be left to auto-creation: the apply
  # environment reaches Contributor on ${DEV_WORKLOAD_RG}, and the recovery
  # environment is the only human gate on a destructive recovery apply.
  ensure_deployment_environment "$INFRA_APPLY_ENVIRONMENT" no
  ensure_deployment_environment "$RECOVERY_APPROVAL_ENVIRONMENT" yes
  # THE GATE, BEFORE THE SUCCESS LINE. If either environment is not verifiably
  # PROTECTED this returns non-zero and "Bootstrap complete" is never printed —
  # so a green bootstrap is the signal that activation is safe, and the absence
  # of that line is not something a reader has to notice for themselves.
  assert_environments_protected || return 1
  ok "Bootstrap complete. Next: follow docs/infrastructure/bootstrap-runbook.md"
}

# Only auto-run when executed directly; allows sourcing for unit tests.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  main "$@"
fi
