#!/usr/bin/env bash
#
# MG-42 INTEGRATION suite — the OIDC subject prefix, end to end.
# ===========================================================================
# Run: bash bootstrap.oidc-subject.integration.test.sh
#
# WHY THIS FILE EXISTS SEPARATELY FROM bootstrap.test.sh.
#
# bootstrap.test.sh proves the MG-42 pieces in isolation, and proves them well:
# assert_oidc_subject_prefix admits/rejects the right shapes, resolve_oidc_subject_prefix
# classifies gh's outcomes correctly, and ensure_federated_credential reconciles
# toward a subject it is HANDED. What no assertion there covers is the SEAM: the
# desired subject in those reconcile tests is a literal the test itself wrote, so
# nothing proves the value that gh returned is the value that reaches
# `az ad app federated-credential create`. Every link is checked; the chain is
# not.
#
# That gap is not academic. MG-42 was itself a wiring bug — the validated,
# well-understood constant GITHUB_REPO was interpolated into a subject at three
# call sites that no test ever ran with a real prefix in play, and the result was
# an outage on all three identities. A suite that mocks the composition step
# cannot catch the next one of those.
#
# So this file drives the REAL functions, in the REAL order, with only the two
# external CLIs replaced:
#
#     gh api  →  stub          (no network, no GitHub credentials)
#     az      →  stub          (no tenant, no Azure credentials; mutations recorded)
#
# and asserts on the subject that arrives at the az command line. Everything
# between — resolve_oidc_subject_prefix, assert_oidc_subject_prefix,
# federated_environment_subject, ensure_federated_credential,
# prune_unexpected_federated_credentials, and all three bootstrap_*_identity
# functions — is the shipped code, unstubbed.
#
# NO CREDENTIALS ARE USED OR WANTED. main() is BASH_SOURCE-guarded, so sourcing
# provisions nothing; `az` and `gh` are shell functions, which `command -v` also
# resolves, so neither real binary is reachable from here even if installed.
#
# WHAT EACH GROUP OWNS
#   1. resolve → validate → compose → reconcile, for all THREE identities, under
#      both the custom (live) prefix and the default one.
#   2. RE-RUN IDEMPOTENCE — the actual point of MG-42. A credential already on
#      the derived subject must survive a re-run untouched. This is what stops
#      the hand-corrected development-infra-apply credential being reverted.
#   3. `|| exit 1` PROPAGATION at each of the three call sites — `die` inside
#      `$(federated_environment_subject …)` runs in a subshell, so "it dies" and
#      "the caller stops" are different claims and only the second one matters.
#   4. A prefix that cannot be proven provisions NOTHING — asserted on the az
#      call log, not on a message.
#   5. `use_default` vs `sub_claim_prefix` PRECEDENCE — the verbatim live
#      response (which carries both) end to end, and the ambiguous
#      `use_default=false` + unreadable-prefix branch, now fail-closed.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
BOOT="$DIR/bootstrap.sh"

# Source FIRST (main is BASH_SOURCE-guarded, so nothing runs). This also turns
# ON errexit for the rest of this file — every call below that may legitimately
# fail is therefore written `|| status=$?`.
# shellcheck disable=SC1090
source "$BOOT"

# Tally helpers are NAMED t_ok / t_bad, deliberately. bootstrap.sh defines its
# own ok(); the identity functions under test call it dozens of times, so
# redefining `ok` as the tallying helper here would count the SUBJECT's log lines
# as passing assertions.
t_pass=0; t_fail=0
t_ok()  { t_pass=$((t_pass+1)); printf 'ok   - %s\n' "$1"; }
t_bad() { t_fail=$((t_fail+1)); printf 'FAIL - %s\n' "$1"; }

# ---------------------------------------------------------------------------
# The harness.
# ---------------------------------------------------------------------------
# Runs `resolve_oidc_subject_prefix` (unless told to pose the prefix directly)
# and then the named identity functions, inside ONE subshell with `gh` and `az`
# stubbed, and reports:
#
#   MG42_STATUS      exit status of the chain
#   MG42_MUTATIONS   every az MUTATION issued, one per line, in order
#                    (`CREATE …` / `DELETE …` / `AZMUTATE …`)
#   MG42_LOG         everything the chain printed (stdout+stderr)
#
# Inputs are globals so a caller can set only what a case cares about:
#   MG42_GH_BODY      body `gh api` prints (stdout on success, stderr on failure)
#   MG42_GH_STATUS    exit status of `gh api`                       (default 0)
#   MG42_GH_AUTH      exit status of `gh auth status`               (default 0)
#   MG42_EXISTING     subject already on the app's credential, "" = absent
#   MG42_EXISTING_NAMES  credential names already on the app (prune input)
#   MG42_POSE_PREFIX  set → skip resolution and pose this OIDC_SUBJECT_PREFIX
#
# EVERY local here is mg42_-prefixed on purpose: bash locals are dynamically
# scoped, so a bare `existing_subject` in this harness would silently shadow
# ensure_federated_credential's own local of that name and make the stub read a
# variable the function under test had just blanked.
mg42_reset() {
  MG42_GH_BODY=""; MG42_GH_STATUS=0; MG42_GH_AUTH=0
  MG42_EXISTING=""; MG42_EXISTING_NAMES=""
  unset MG42_POSE_PREFIX 2>/dev/null || true
}

mg42_run() {
  local mg42_muts mg42_log mg42_status=0
  mg42_muts="$(mktemp)"; mg42_log="$(mktemp)"
  (
    gh() {
      case "${1:-}" in
        auth) return "$MG42_GH_AUTH" ;;
        api)  if [ "$MG42_GH_STATUS" -eq 0 ]; then printf '%s' "$MG42_GH_BODY"
              else printf '%s' "$MG42_GH_BODY" >&2; fi
              return "$MG42_GH_STATUS" ;;
      esac
      return 0
    }
    # The condition the ABAC reconciler will find already live. Computed from
    # bootstrap.sh's OWN builders (below, once the stub is installed) so the
    # unrelated RBAC-admin path reaches its "already correct" early return
    # instead of dying halfway and truncating the run under test.
    mg42_cond=""
    az() {
      local mg42_all="$*" mg42_role
      case "$mg42_all" in
        "account show --query id -o tsv")       echo "11111111-1111-1111-1111-111111111111" ;;
        "account show --query tenantId -o tsv") echo "22222222-2222-2222-2222-222222222222" ;;
        *"storage account show"*) echo "/subscriptions/1/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/sa" ;;
        *"ad app list"*)          echo "33333333-3333-3333-3333-333333333333" ;;
        *"ad sp list"*)           echo "44444444-4444-4444-4444-444444444444" ;;
        # The two `federated-credential list` reads differ ONLY by --query: the
        # reconciler asks for one credential's subject, the pruner asks for every
        # credential's name. Matching the pruner's query FIRST keeps them apart.
        *"federated-credential list"*"[].name"*) printf '%s' "$MG42_EXISTING_NAMES" ;;
        *"federated-credential list"*)           printf '%s' "$MG42_EXISTING" ;;
        *"federated-credential create"*) printf 'CREATE %s\n' "$mg42_all" >&3 ;;
        *"federated-credential delete"*) printf 'DELETE %s\n' "$mg42_all" >&3 ;;
        *"role definition list"*)
          mg42_role="${mg42_all#*--name }"; mg42_role="${mg42_role%% --query*}"
          allowlist_committed_guid "$mg42_role" ;;
        *"role assignment list"*"[0].condition"*) printf '%s' "$mg42_cond" ;;
        *"role assignment list"*) echo "/subscriptions/1/providers/Microsoft.Authorization/roleAssignments/ra-1" ;;
        # Any OTHER az verb that mutates is recorded too, so "nothing was
        # provisioned" can be asserted on the call log rather than on a message.
        *" create "*|*" create"|*" delete "*|*" delete"|*" update "*|*" set "*)
          printf 'AZMUTATE %s\n' "$mg42_all" >&3 ;;
        *) return 0 ;;
      esac
    }

    if [ -n "${MG42_POSE_PREFIX+x}" ]; then
      OIDC_SUBJECT_PREFIX="$MG42_POSE_PREFIX"
    else
      resolve_oidc_subject_prefix
    fi
    mg42_cond="$(build_rbac_admin_condition "$(resolve_allowlist_role_guids)")"
    for mg42_fn in "$@"; do "$mg42_fn" || exit 1; done
  ) 3>"$mg42_muts" >"$mg42_log" 2>&1 || mg42_status=$?

  MG42_STATUS="$mg42_status"
  MG42_MUTATIONS="$(cat "$mg42_muts")"
  MG42_LOG="$(cat "$mg42_log")"
  rm -f "$mg42_muts" "$mg42_log"
}

# The two prefixes MG-42 is about: what this repo's live sub-claim customization
# returns, and what GitHub's default sub claim would return.
MG42_OWNER="${GITHUB_REPO%%/*}"
MG42_REPO="${GITHUB_REPO##*/}"
CUSTOM_PREFIX="repo:${MG42_OWNER}@4857343/${MG42_REPO}@1304558512"
DEFAULT_PREFIX="repo:${GITHUB_REPO}"
CUSTOM_BODY="{\"use_default\": false, \"include_claim_keys\": [\"repo\"], \"sub_claim_prefix\": \"${CUSTOM_PREFIX}\"}"

# The three identities, each as: <function> <github-environment> <credential-name>
MG42_IDENTITIES="
bootstrap_oidc_identity|${PLAN_IDENTITY_ENVIRONMENTS}|github-${PLAN_IDENTITY_ENVIRONMENTS}
bootstrap_deploy_identity|${APP_DEPLOY_ENVIRONMENT}|github-appdeploy-${APP_DEPLOY_ENVIRONMENT}
bootstrap_infra_apply_identity|${INFRA_APPLY_ENVIRONMENT}|github-infra-apply-${INFRA_APPLY_ENVIRONMENT}
"

# The suite asserts against all three identities by name; if the map ever grows a
# fourth, this must be updated rather than silently covering two thirds of it.
mg42_identity_count="$(printf '%s\n' "$MG42_IDENTITIES" | grep -c '|' || true)"
[ "$mg42_identity_count" -eq 3 ] \
  && t_ok "harness covers all THREE federating identities (plan/read, app-deploy, infra-apply)" \
  || t_bad "expected 3 identities in the MG-42 map, harness models ${mg42_identity_count}"
# PLAN_IDENTITY_ENVIRONMENTS is a LIST; the row above only models it correctly
# while it holds exactly one environment. Assert that rather than assume it.
[ "$(printf '%s\n' $PLAN_IDENTITY_ENVIRONMENTS | grep -c . || true)" -eq 1 ] \
  && t_ok "PLAN_IDENTITY_ENVIRONMENTS holds exactly one environment (the harness models it as scalar)" \
  || t_bad "PLAN_IDENTITY_ENVIRONMENTS is now a multi-element list ('${PLAN_IDENTITY_ENVIRONMENTS}') — this harness models it as one row"

# Pull the `"subject": "…"` values out of a recorded CREATE payload. The payload
# is multi-line JSON, so the subject lands on a LATER line than the CREATE
# marker — never grep only the marker line.
mg42_created_subjects() {
  printf '%s\n' "$MG42_MUTATIONS" | grep -oE '"subject": "[^"]*"' | sed 's/"subject": "//; s/"$//'
}

# ===========================================================================
# GROUP 1 — the whole chain: gh's answer reaches az's command line.
# ===========================================================================
# The assertion that bootstrap.test.sh structurally cannot make: run the real
# resolver against a stubbed gh, then run the real identity function, and read
# the subject off the `az ad app federated-credential create` invocation.
for mg42_row in $MG42_IDENTITIES; do
  mg42_fn="${mg42_row%%|*}"; mg42_rest="${mg42_row#*|}"
  mg42_env="${mg42_rest%%|*}"; mg42_cred="${mg42_rest##*|}"

  # --- the LIVE case: a custom sub_claim_prefix is configured --------------
  mg42_reset
  MG42_GH_BODY="$CUSTOM_BODY"
  mg42_run "$mg42_fn"
  mg42_want="${CUSTOM_PREFIX}:environment:${mg42_env}"
  mg42_got="$(mg42_created_subjects)"

  [ "$MG42_STATUS" -eq 0 ] \
    && t_ok "${mg42_fn}: completes end-to-end against the live custom prefix" \
    || t_bad "${mg42_fn}: must complete against the live custom prefix (exit ${MG42_STATUS}); log: $(printf '%s' "$MG42_LOG" | tail -3)"
  [ "$mg42_got" = "$mg42_want" ] \
    && t_ok "${mg42_fn}: federates the DERIVED subject ${mg42_want}" \
    || t_bad "${mg42_fn}: must federate '${mg42_want}', az was handed '${mg42_got}'"
  # The precise regression: the subject Entra never matched.
  case "$mg42_got" in
    "${DEFAULT_PREFIX}:"*) t_bad "${mg42_fn}: federated the HARDCODED default prefix while a custom one is live — this IS the MG-42 outage (AADSTS700213)" ;;
    *) t_ok "${mg42_fn}: never federates the hardcoded default prefix when a custom one is live" ;;
  esac
  # Exactly one credential is minted, and nothing is deleted on a clean app.
  [ "$(printf '%s\n' "$MG42_MUTATIONS" | grep -c '^CREATE' || true)" -eq 1 ] \
    && t_ok "${mg42_fn}: mints exactly ONE federated credential" \
    || t_bad "${mg42_fn}: must mint exactly one federated credential (did: ${MG42_MUTATIONS})"
  printf '%s\n' "$MG42_MUTATIONS" | grep -q "\"name\": \"${mg42_cred}\"" \
    && t_ok "${mg42_fn}: the credential is named ${mg42_cred}" \
    || t_bad "${mg42_fn}: expected the credential to be named '${mg42_cred}' (did: ${MG42_MUTATIONS})"

  # --- the DEFAULT case: no customization is configured (HTTP 404) ---------
  # Run through the SAME chain. This is what proves the composed subject tracks
  # the gh response rather than being a constant that happens to match above.
  mg42_reset
  MG42_GH_BODY="gh: Not Found (HTTP 404)"; MG42_GH_STATUS=1
  mg42_run "$mg42_fn"
  mg42_want_default="${DEFAULT_PREFIX}:environment:${mg42_env}"
  mg42_got_default="$(mg42_created_subjects)"
  [ "$MG42_STATUS" -eq 0 ] && [ "$mg42_got_default" = "$mg42_want_default" ] \
    && t_ok "${mg42_fn}: on a repo with NO customization, federates ${mg42_want_default}" \
    || t_bad "${mg42_fn}: with no customization must federate '${mg42_want_default}' (exit ${MG42_STATUS}, got '${mg42_got_default}')"
  # ANTI-VACUITY. If the two gh answers produced the SAME subject, every
  # assertion above would pass against a hardcoded composition and prove nothing.
  [ "$mg42_got" != "$mg42_got_default" ] \
    && t_ok "${mg42_fn}: the subject TRACKS the gh response (custom and default answers differ)" \
    || t_bad "${mg42_fn}: two different gh answers produced the same subject '${mg42_got}' — the prefix is not actually derived"
done

# ===========================================================================
# GROUP 2 — RE-RUN IDEMPOTENCE. The property this ticket exists for.
# ===========================================================================
# The destructive half of MG-42: ensure_federated_credential reconciles on
# SUBJECT, so while the desired subject was the hardcoded literal, EVERY re-run
# deleted the hand-corrected development-infra-apply credential and recreated it
# on the broken value — taking the dev auto-apply loop down again each time.
#
# Asserted at the INTEGRATION level, not on ensure_federated_credential alone:
# the desired subject here is not written by the test, it is whatever the chain
# derives from the stubbed gh response. That is the only version of this
# assertion that would have failed before the fix.
for mg42_row in $MG42_IDENTITIES; do
  mg42_fn="${mg42_row%%|*}"; mg42_rest="${mg42_row#*|}"
  mg42_env="${mg42_rest%%|*}"; mg42_cred="${mg42_rest##*|}"
  mg42_live="${CUSTOM_PREFIX}:environment:${mg42_env}"
  mg42_legacy="${DEFAULT_PREFIX}:environment:${mg42_env}"

  # --- a credential ALREADY on the derived subject: ZERO mutations ---------
  mg42_reset
  MG42_GH_BODY="$CUSTOM_BODY"
  MG42_EXISTING="$mg42_live"
  MG42_EXISTING_NAMES="$mg42_cred"
  mg42_run "$mg42_fn"
  # Both halves are required. "Zero mutations" alone would also be true of a run
  # that died before it ever reached the reconciler, so the run must ALSO have
  # completed AND logged the reconciler's no-op branch naming this subject.
  if [ "$MG42_STATUS" -eq 0 ] && [ -z "$MG42_MUTATIONS" ] \
     && printf '%s' "$MG42_LOG" | grep -qF "subject matches): ${mg42_cred} (${mg42_live})"; then
    t_ok "${mg42_fn}: a RE-RUN over a credential already on the derived subject issues ZERO az mutations"
  else
    t_bad "${mg42_fn}: a re-run must leave the correct credential alone and say so (exit ${MG42_STATUS}, mutations: '${MG42_MUTATIONS}')"
  fi

  # --- the same credential stuck on the OLD hardcoded subject --------------
  # The forward direction, so the no-op above cannot be a reconciler that simply
  # never fires.
  mg42_reset
  MG42_GH_BODY="$CUSTOM_BODY"
  MG42_EXISTING="$mg42_legacy"
  MG42_EXISTING_NAMES="$mg42_cred"
  mg42_run "$mg42_fn"
  if [ "$MG42_STATUS" -eq 0 ] \
     && printf '%s\n' "$MG42_MUTATIONS" | grep -q '^DELETE' \
     && [ "$(mg42_created_subjects)" = "$mg42_live" ]; then
    t_ok "${mg42_fn}: a credential stuck on the old hardcoded subject is reconciled FORWARD to ${mg42_live}"
  else
    t_bad "${mg42_fn}: a stale hardcoded subject must be deleted and recreated on the derived subject (did: ${MG42_MUTATIONS})"
  fi
  printf '%s\n' "$MG42_MUTATIONS" | grep -qF "\"subject\": \"${mg42_legacy}\"" \
    && t_bad "${mg42_fn}: recreated the credential on the HARDCODED subject — this is the reversion MG-42 removes" \
    || t_ok "${mg42_fn}: never writes the hardcoded subject back"
done

# THE LIVE INCIDENT, NAMED. The dev infra-apply credential was corrected by hand
# on the tenant so the auto-apply loop could authenticate at all; the bug was
# that a re-run reverted it. Asserted once more on its own, because it is the
# ticket's acceptance criterion rather than a member of a loop.
mg42_reset
MG42_GH_BODY="$CUSTOM_BODY"
MG42_EXISTING="${CUSTOM_PREFIX}:environment:${INFRA_APPLY_ENVIRONMENT}"
MG42_EXISTING_NAMES="github-infra-apply-${INFRA_APPLY_ENVIRONMENT}"
mg42_run bootstrap_infra_apply_identity
if [ "$MG42_STATUS" -eq 0 ] && [ -z "$MG42_MUTATIONS" ]; then
  t_ok "MG-42 AC: a bootstrap re-run does NOT revert the hand-corrected ${INFRA_APPLY_ENVIRONMENT} credential"
else
  t_bad "MG-42 AC: a re-run reverted or disturbed the hand-corrected ${INFRA_APPLY_ENVIRONMENT} credential (exit ${MG42_STATUS}, did: ${MG42_MUTATIONS})"
fi

# ===========================================================================
# GROUP 3 — `|| exit 1` PROPAGATION at each of the three call sites.
# ===========================================================================
# `die` inside `$(federated_environment_subject …)` runs in the command
# substitution's SUBSHELL. Without `|| exit 1` the caller sees only a non-zero
# assignment — and under a caller whose errexit is suppressed it would carry on
# with an EMPTY subject and federate `:environment:<env>`. "The helper dies" and
# "the caller stops" are different claims; only the second one protects anything.
#
# bootstrap.test.sh asserts this behaviourally for ONE of the three call sites
# (app-deploy) and by grep-count for the other two. A grep proves the text is
# present, not that the abort happens — so each site is driven here.
for mg42_row in $MG42_IDENTITIES; do
  mg42_fn="${mg42_row%%|*}"

  mg42_reset
  MG42_POSE_PREFIX=""          # the prefix was never resolved
  mg42_run "$mg42_fn"
  if [ "$MG42_STATUS" -ne 0 ] \
     && printf '%s' "$MG42_LOG" | grep -q 'before resolve_oidc_subject_prefix' \
     && [ -z "$MG42_MUTATIONS" ]; then
    t_ok "${mg42_fn}: an UNRESOLVED prefix aborts the caller and federates nothing (the subshell die propagates)"
  else
    t_bad "${mg42_fn}: an unresolved prefix must abort the caller with nothing provisioned (exit ${MG42_STATUS}, mutations: '${MG42_MUTATIONS}')"
  fi
done

# The OTHER die inside the composer — an empty GitHub Environment name — driven
# through the two call sites whose environment is a scalar constant.
for mg42_pair in "bootstrap_deploy_identity APP_DEPLOY_ENVIRONMENT" \
                 "bootstrap_infra_apply_identity INFRA_APPLY_ENVIRONMENT"; do
  set -- $mg42_pair
  mg42_fn="$1"; mg42_var="$2"
  mg42_saved="$(eval "printf '%s' \"\$${mg42_var}\"")"
  mg42_reset
  MG42_POSE_PREFIX="$CUSTOM_PREFIX"
  eval "${mg42_var}=''"
  mg42_run "$mg42_fn"
  eval "${mg42_var}=\"\$mg42_saved\""
  if [ "$MG42_STATUS" -ne 0 ] && [ -z "$MG42_MUTATIONS" ]; then
    t_ok "${mg42_fn}: an EMPTY ${mg42_var} aborts the caller and federates nothing"
  else
    t_bad "${mg42_fn}: an empty ${mg42_var} must abort with nothing provisioned (exit ${MG42_STATUS}, mutations: '${MG42_MUTATIONS}')"
  fi
done

# ===========================================================================
# GROUP 4 — an UNPROVABLE prefix provisions NOTHING.
# ===========================================================================
# main() resolves the prefix before the first identity precisely so a prefix that
# cannot be proven aborts while nothing exists. Asserted on the az call log:
# "it printed an error" is not the property — "it created nothing" is.
#
# Each row is a gh outcome that must NOT be read as "no customization
# configured": another repository (the F16 trust-root attack), a near-miss fork
# name a contains-check would wave through, a 5xx/403/network outage, an
# unauthenticated CLI whose 404s are indistinguishable from an unconfigured
# repo, and a body that is not JSON at all.
mg42_case() {
  # usage: mg42_case "<label>" <body> <api-status> <auth-status>
  local mg42_label="$1"
  mg42_reset
  MG42_GH_BODY="$2"; MG42_GH_STATUS="$3"; MG42_GH_AUTH="$4"
  mg42_run bootstrap_oidc_identity bootstrap_deploy_identity bootstrap_infra_apply_identity
  if [ "$MG42_STATUS" -ne 0 ] && [ -z "$MG42_MUTATIONS" ]; then
    t_ok "unprovable prefix provisions NOTHING: ${mg42_label}"
  else
    t_bad "unprovable prefix must abort before provisioning: ${mg42_label} (exit ${MG42_STATUS}, mutations: '${MG42_MUTATIONS}')"
  fi
}
mg42_case "a prefix naming ANOTHER repository"        '{"sub_claim_prefix": "repo:attacker/'"${MG42_REPO}"'"}' 0 0
mg42_case "a look-alike fork of this repository"      '{"sub_claim_prefix": "repo:'"${MG42_OWNER}"'/'"${MG42_REPO}"'-fork"}' 0 0
mg42_case "a prefix carrying an extra claim segment"  '{"sub_claim_prefix": "repo:'"${GITHUB_REPO}"':ref:refs/heads/main"}' 0 0
mg42_case "a non-numeric owner id"                    '{"sub_claim_prefix": "repo:'"${MG42_OWNER}"'@abc/'"${MG42_REPO}"'"}' 0 0
mg42_case "HTTP 500 (an outage, not a configuration fact)" 'gh: Server Error (HTTP 500)' 1 0
mg42_case "HTTP 403 (a permission error, not a fact)"      'gh: Forbidden (HTTP 403)' 1 0
mg42_case "a network failure"                              'error connecting to api.github.com' 1 0
mg42_case "an UNAUTHENTICATED gh (its 404s are ambiguous)" "$CUSTOM_BODY" 0 1
mg42_case "an unparseable response body"                   'not json at all' 0 0

# ...and the POSITIVE control for the whole group: the same three-identity chain
# under a provable prefix DOES provision. Without it, every case above would
# also pass against a chain that is simply broken.
mg42_reset
MG42_GH_BODY="$CUSTOM_BODY"
mg42_run bootstrap_oidc_identity bootstrap_deploy_identity bootstrap_infra_apply_identity
mg42_all_subjects="$(mg42_created_subjects | sort -u | tr '\n' ' ')"
if [ "$MG42_STATUS" -eq 0 ] \
   && [ "$(mg42_created_subjects | grep -c . || true)" -eq 3 ] \
   && [ "$(mg42_created_subjects | grep -cv "^${CUSTOM_PREFIX}:environment:" || true)" -eq 0 ]; then
  t_ok "positive control: a PROVABLE prefix provisions all three identities, every subject on the derived prefix"
else
  t_bad "a provable prefix must provision all three identities on the derived prefix (exit ${MG42_STATUS}, subjects: ${mg42_all_subjects})"
fi
# The three subjects are DISTINCT — one environment per identity, so no two
# identities can be assumed by the same token (MG-23 F8, under the MG-42 prefix).
[ "$(mg42_created_subjects | sort -u | grep -c . || true)" -eq 3 ] \
  && t_ok "the three identities federate three DISTINCT subjects under the derived prefix" \
  || t_bad "the three identities must federate distinct subjects (got: ${mg42_all_subjects})"

# ===========================================================================
# GROUP 5 — `use_default` vs `sub_claim_prefix`: PRECEDENCE, and the ambiguous
#           branch that is now fail-closed.
# ===========================================================================
# THIS GROUP USED TO BE A CHARACTERIZATION GROUP. It pinned — explicitly as a
# risk, explicitly "not endorsed" — that resolve_oidc_subject_prefix treated
# these three as the same fact:
#     use_default = true                       "this repo uses the default claim"
#     sub_claim_prefix absent, on a 200        "…"
#     sub_claim_prefix empty/null, on a 200    "…"
# and fell back to `repo:<owner>/<repo>` for all of them, on a routine cyan `log`
# line. The note here said: if bootstrap.sh is changed to die on `use_default=false`
# with an unreadable prefix, these assertions are what will notice — update them
# in that same commit. That change has now been made, and this is that update.
# The group is kept, not deleted: the cases it named are exactly the ones the new
# semantics have to get right, so they stay as ASSERTIONS OF THE FIX rather than
# as a record of the risk.
#
# TWO THINGS WERE WRONG, not one.
#
# (1) THE PRECEDENCE WAS INVERTED. `use_default: true` short-circuited to the
#     default prefix even when the response CARRIED a custom one. The verbatim
#     live response from this repository (recorded below) is precisely that
#     shape, so the "fix" resolved to `repo:stevebargelt/meatgeekv2` — the exact
#     broken subject MG-42 exists to eliminate. And because
#     ensure_federated_credential reconciles ON SUBJECT, a bootstrap run would
#     have DELETED the hand-corrected development-infra-apply credential and
#     recreated it on a subject no token carries (AADSTS700213), taking the live
#     dev auto-apply loop down. `use_default` describes the claim-KEY list
#     (`include_claim_keys`); the enterprise policy injects the owner-id/repo-id
#     prefix independently of it. They are NOT mutually exclusive.
#
# (2) THE AMBIGUOUS BRANCH FELL BACK. `use_default: false` with a missing or
#     empty prefix is GitHub positively stating that a customization EXISTS whose
#     prefix could not be read — the same epistemic position as the 403/5xx/network
#     cases in GROUP 4, every one of which dies. It now dies too.
#
# The accident-proneness that made (2) worth pinning is unchanged and is why the
# cases stay: GitHub's documented response for
# GET /repos/{owner}/{repo}/actions/oidc/customization/sub is
# `{"use_default": <bool>, "include_claim_keys": [<string>]}` — the
# `sub_claim_prefix` key this resolver depends on is not in that documented
# schema, so any response omitting it lands here.

# --- THE CANONICAL LIVE FIXTURE, end to end -------------------------------
# VERBATIM output of
#   gh api repos/stevebargelt/meatgeekv2/actions/oidc/customization/sub
# run against the real repository on the host, 2026-07-27, re-confirmed
# 2026-07-28. Recorded fact, not an invention — do not tidy the field order, the
# `use_default: true`, or the `use_immutable_subject` key, all of which are part
# of what was observed. This is the case every fixture in this repo previously
# got wrong, and it is asserted here through the WHOLE chain (resolve → validate
# → compose → reconcile) so a regression shows up as the wrong string on the az
# command line, not merely as a wrong return value.
MG42_LIVE_BODY='{"use_default":true,"use_immutable_subject":false,"sub_claim_prefix":"repo:stevebargelt@4857343/meatgeekv2@1304558512"}'
MG42_LIVE_PREFIX='repo:stevebargelt@4857343/meatgeekv2@1304558512'
mg42_reset
MG42_GH_BODY="$MG42_LIVE_BODY"
mg42_run bootstrap_infra_apply_identity
if [ "$MG42_STATUS" -eq 0 ] \
   && [ "$(mg42_created_subjects)" = "${MG42_LIVE_PREFIX}:environment:${INFRA_APPLY_ENVIRONMENT}" ]; then
  t_ok "the VERBATIM live 2026-07-27 response federates ${MG42_LIVE_PREFIX}:environment:${INFRA_APPLY_ENVIRONMENT} (use_default=true does NOT veto a present sub_claim_prefix)"
else
  t_bad "the live response must federate '${MG42_LIVE_PREFIX}:environment:${INFRA_APPLY_ENVIRONMENT}' (exit ${MG42_STATUS}, subject '$(mg42_created_subjects)')"
fi
# The specific regression, stated as its own assertion so the failure message
# names it: the default prefix must NEVER reach az for this body.
if printf '%s\n' "$MG42_MUTATIONS" | grep -q "${DEFAULT_PREFIX}:environment:"; then
  t_bad "the live response resolved to the DEFAULT prefix — this is the MG-42 outage re-caused by the MG-42 fix (mutations: ${MG42_MUTATIONS})"
else
  t_ok "the live response never federates the default prefix '${DEFAULT_PREFIX}' (the hand-corrected dev apply credential survives a re-run)"
fi
# ...and the idempotence that protects the live credential: a re-run against the
# credential already on the live subject must touch NOTHING.
mg42_reset
MG42_GH_BODY="$MG42_LIVE_BODY"
MG42_EXISTING="${MG42_LIVE_PREFIX}:environment:${INFRA_APPLY_ENVIRONMENT}"
MG42_EXISTING_NAMES="github-infra-apply-${INFRA_APPLY_ENVIRONMENT}"
mg42_run bootstrap_infra_apply_identity
if [ "$MG42_STATUS" -eq 0 ] && ! printf '%s\n' "$MG42_MUTATIONS" | grep -qE '^(CREATE|DELETE) '; then
  t_ok "a re-run under the LIVE response leaves the hand-corrected credential untouched (no CREATE, no DELETE)"
else
  t_bad "a re-run under the live response must not touch the credential (exit ${MG42_STATUS}, mutations: '${MG42_MUTATIONS}')"
fi

# --- the ambiguous branch: now FAIL-CLOSED ---------------------------------
# Same two bodies the characterization used, asserting the new semantics. As in
# GROUP 4, the property asserted is "it created NOTHING" — not "it printed an
# error".
mg42_ambiguous() {
  local mg42_label="$1" mg42_body="$2"
  mg42_reset
  MG42_GH_BODY="$mg42_body"
  mg42_run bootstrap_infra_apply_identity
  if [ "$MG42_STATUS" -ne 0 ] && [ -z "$MG42_MUTATIONS" ]; then
    t_ok "use_default=false with an unreadable prefix aborts with NOTHING provisioned: ${mg42_label}"
  else
    t_bad "use_default=false with an unreadable prefix must abort before provisioning: ${mg42_label} (exit ${MG42_STATUS}, mutations: '${MG42_MUTATIONS}')"
  fi
}
mg42_ambiguous "NO sub_claim_prefix key (GitHub's documented response shape)" \
  '{"use_default": false, "include_claim_keys": ["repo","context"]}'
mg42_ambiguous "an EMPTY sub_claim_prefix" \
  '{"use_default": false, "sub_claim_prefix": ""}'
mg42_ambiguous "a NULL sub_claim_prefix" \
  '{"use_default": false, "sub_claim_prefix": null}'

# The genuine default — use_default=true AND nothing to contradict it — still
# falls back. Without this, the three cases above would also pass against a
# resolver that simply died on every 200.
mg42_reset
MG42_GH_BODY='{"use_default": true, "include_claim_keys": ["repo","context"]}'
mg42_run bootstrap_infra_apply_identity
if [ "$MG42_STATUS" -eq 0 ] \
   && [ "$(mg42_created_subjects)" = "${DEFAULT_PREFIX}:environment:${INFRA_APPLY_ENVIRONMENT}" ]; then
  t_ok "use_default=true with NO sub_claim_prefix still federates the DEFAULT prefix (the fail-closed branch is not over-broad)"
else
  t_bad "a genuine default response must federate '${DEFAULT_PREFIX}:environment:${INFRA_APPLY_ENVIRONMENT}' (exit ${MG42_STATUS}, subject '$(mg42_created_subjects)')"
fi

# --- the operator-visible signal ------------------------------------------
# The old message asserted "Repository … uses GitHub's DEFAULT OIDC sub claim" on
# a body that had just said use_default=false — a log line contradicting the
# response it read. That wording is gone; the ambiguous case is now a `die` whose
# text names what was actually seen.
mg42_reset
MG42_GH_BODY='{"use_default": false, "include_claim_keys": ["repo","context"]}'
mg42_run bootstrap_infra_apply_identity
if printf '%s' "$MG42_LOG" | grep -q 'use_default=false' \
   && printf '%s' "$MG42_LOG" | grep -qi 'NO readable sub_claim_prefix' \
   && ! printf '%s' "$MG42_LOG" | grep -q "uses GitHub's DEFAULT OIDC sub claim"; then
  t_ok "the ambiguous case dies naming what was read (use_default=false, no readable prefix) and no longer claims the repo uses the default sub claim"
else
  t_bad "the ambiguous-case message must name use_default=false and the unreadable prefix, and must not announce the default sub claim (log: $(printf '%s' "$MG42_LOG" | tail -3))"
fi
# ...and the genuine-default log line no longer overstates either: it reports the
# absent prefix as well as the flag.
mg42_reset
MG42_GH_BODY='{"use_default": true}'
mg42_run bootstrap_infra_apply_identity
if printf '%s' "$MG42_LOG" | grep -q 'no OIDC sub_claim_prefix'; then
  t_ok "the genuine-default log line reports BOTH halves of the fact (use_default=true AND no prefix returned)"
else
  t_bad "the genuine-default log line must state that no sub_claim_prefix was returned (log: $(printf '%s' "$MG42_LOG" | head -3))"
fi

printf -- '-----------------------------------------\n'
printf 'passed=%d failed=%d\n' "$t_pass" "$t_fail"
[ "$t_fail" -eq 0 ]
