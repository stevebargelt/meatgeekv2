#!/usr/bin/env bash
#
# assert-live-host-storage.sh — FAIL-CLOSED assertion that the DEPLOYED Function
# App's host-storage configuration is identity-based and un-shadowed (MG-58,
# guard 4).
#
# WHY THIS GATE EXISTS AT ALL — read this before changing anything here.
# Every pre-existing guard in this repo asserts that the credential-carrying
# scalar app setting `AzureWebJobsStorage` is absent from the CONFIGURATION:
#   * modules/functions/tests/security_posture.tftest.hcl  (declared app_settings)
#   * modules/functions/tests/flex_hosting_behavior.tftest.hcl (declared app_settings)
#   * scripts/tf-plan-secret-inspection.sh + the flex-plan-* fixtures (plan/state)
#   * scripts/tf-static-checks.sh (lexical HCL scan)
# All of them PASS, and all of them always did — the scalar key appears in ZERO
# .tf files (grep and see). Yet the live dev Function App carried BOTH the scalar
# connection-string form (with an EMPTY AccountKey, against an account whose
# shared keys are disabled) AND the identity form `AzureWebJobsStorage__accountName`
# at the same time. The host resolves the connection-string form FIRST and never
# reaches the identity form, so it authenticated with an unusable key: the setting
# that shipped in PR #42 was correct and simply SHADOWED. Config-clean and
# site-dirty coexisted behind eleven green checks.
#
# The reason no config-surface gate can ever see this: hashicorp/azurerm v4.81.0
# (pinned in apps/infrastructure/.terraform.lock.hcl) COMPOSES and WRITES the
# scalar key itself on create and on every Update, and on READ routes it out of
# app_settings into the `storage_access_key` attribute. So the key is structurally
# absent from HCL, from the plan document, and from post-apply state — it is not
# representable on any surface Terraform exposes, and the provider can therefore
# never prune it either. The DEPLOYED SITE is the only surface on which this
# defect exists, so this gate reads the live settings document and nothing else.
#
# Authority splits, deliberately (see the MG-58 ADR):
#   * the desired state (modules/functions/main.tf + its tftest guards) stays
#     authoritative for the identity form's PRESENCE;
#   * THIS gate becomes authoritative for the scalar form's ABSENCE.
#
# WHAT IT ASSERTS, against an `az functionapp config appsettings list` document:
#   1. The EXACT scalar key `AzureWebJobsStorage` is ABSENT.
#   2. The EXACT key `AzureWebJobsStorage__accountName` is PRESENT exactly once
#      and its value EQUALS the `--account-name` the caller passed (which the
#      caller resolves from `terraform output`, i.e. from the desired state — so
#      this compares LIVE against DESIRED, not live against itself).
#   3. It prints the FULL list of setting NAMES for operator diagnosis, including
#      any stray deployment-storage connection-string setting the provider's
#      Update path injects (whose presence is itself evidence that an UPDATE, not
#      a create and not `func publish`, was the injector).
#
# KEY MATCHING IS EXACT IN BOTH DIRECTIONS, and that is load-bearing. A PREFIX
# match would conflate the two forms and make this gate either permanently red
# (`AzureWebJobsStorage__accountName` read as the scalar form) or permanently
# vacuous (a document carrying ONLY the scalar form read as satisfying the
# account-name requirement). Both comparisons below are jq `==` on the whole
# string; no prefix, glob, substring or case-folded test is used anywhere.
#
# OUTPUT CONTRACT — NAMES AND REASONS, NEVER VALUES.
# The document this gate consumes carries app setting VALUES, and among them
# connection strings. This gate runs in a CI job whose log is retained and
# broadly readable, so its own stdout/stderr is a place a credential must not
# reach. Every line it prints is a setting NAME, a fixed reason, or a scalar the
# CALLER supplied (`--account-name`) — never a value read out of the document.
# On the account-name MISMATCH path in particular the observed value is withheld
# and printed as [REDACTED]: the operator has the setting name and the expected
# value, which is all they need to go look at the live site directly. Same rule
# as scripts/tf-plan-secret-inspection.sh, and for the same reason.
#
# PORTABILITY IS A SECURITY PROPERTY HERE, NOT A STYLE NOTE.
# Written to strict POSIX sh so it behaves IDENTICALLY under macOS's default
# bash 3.2, modern bash 5, and dash. No bash-4 case modification (${v,,}/${v^^}),
# no associative arrays, no here-strings (<<<), no process substitution, no
# [[ ]]. A gate that ERRORS on one shell while still reaching a PASS is
# FAIL-OPEN, and this repo has already shipped exactly that bug once (the
# bash-4-only ${1,,} in tf-plan-secret-inspection.sh let a foreign connection
# string through). Every accept path below is reachable ONLY after both
# comparisons provably ran and returned a recognized verdict.
#
# EXIT CODES — the workflow that calls this depends on the distinction.
#   0  PASS: scalar key absent AND account-name form present and equal.
#   3  The scalar key `AzureWebJobsStorage` is PRESENT on the live site. This is
#      the REMEDIABLE defect: deleting that one key on that one app fixes it.
#      A caller may act on 3 by deleting exactly that key and re-running this
#      gate — it must NOT treat 3 as success, and must not leave its run green.
#      Presence is also announced on stdout as a stable machine-readable marker
#      line, `SCALAR_KEY_PRESENT=AzureWebJobsStorage`, so a caller can key off
#      either. (A name is not a secret; that line carries no value.)
#   1  Everything else: any other violation, and every operational failure —
#      no jq, no input, unreadable file, invalid JSON, wrong top-level type,
#      malformed entries, an empty document, a missing/empty --account-name, or
#      a probe that itself errored. FAIL-CLOSED: an assertion that could not run
#      is never a PASS, and "cannot tell" is never "nothing to see".
#
# USAGE
#   assert-live-host-storage.sh --account-name <name> <settings.json>
#   az functionapp config appsettings list -g RG -n APP -o json \
#     | assert-live-host-storage.sh --account-name <name>
#   assert-live-host-storage.sh --account-name <name> -      # explicit stdin
#
# Pipe the az output STRAIGHT into this gate. Do not `tee` it, redirect it to a
# file, echo it, or upload it as an artifact: that document carries values.
#
set -u
# pipefail is a bash/ksh feature; dash lacks it and would print
# "Illegal option -o pipefail" and skew the exit code. Enable it only when the
# running shell supports it. Correctness never DEPENDS on it here — every
# pipeline below begins with printf, which cannot fail — so this is defense in
# depth, not a load-bearing option (and probing it in a subshell keeps dash
# silent and clean).
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

PROG="assert-live-host-storage"

# The two keys, spelled out ONCE and compared with jq `==` everywhere below.
SCALAR_KEY="AzureWebJobsStorage"
IDENTITY_KEY="AzureWebJobsStorage__accountName"

die() { echo "${PROG}: FATAL: $*" >&2; exit 1; }   # fail-closed

usage() {
  echo "usage: ${PROG}.sh --account-name <storage-account-name> [<appsettings.json>|-]" >&2
  echo "       az functionapp config appsettings list -g RG -n APP -o json | ${PROG}.sh --account-name <name>" >&2
}

command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"

# --- 1. Arguments -----------------------------------------------------------
# --account-name is REQUIRED and must be non-empty. Without it there is nothing
# to compare the live value AGAINST, and a gate that "passes" because it had no
# expectation is the vacuous-PASS class this whole file exists to close.
ACCOUNT_NAME=""
INPUT=""
have_input=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --account-name)
      [ "$#" -ge 2 ] || { usage; die "--account-name requires a value"; }
      ACCOUNT_NAME="$2"
      shift 2
      ;;
    --account-name=*)
      # POSIX parameter expansion; no bash-only string ops.
      ACCOUNT_NAME="${1#--account-name=}"
      shift
      ;;
    -h|--help)
      usage
      exit 1   # fail-closed: help is not a passing assertion
      ;;
    -)
      have_input=1
      INPUT=""
      shift
      ;;
    -*)
      usage
      die "unknown option: $1"
      ;;
    *)
      [ "${have_input}" -eq 0 ] || { usage; die "more than one input document given"; }
      have_input=1
      INPUT="$1"
      shift
      ;;
  esac
done

[ -n "${ACCOUNT_NAME}" ] || { usage; die "--account-name is required and must be non-empty — refusing to assert host storage with no expected account name to compare against"; }

# --- 2. Load the live settings document -------------------------------------
SRC=""
JSON=""
if [ -n "${INPUT}" ]; then
  SRC="${INPUT}"
  [ -f "${INPUT}" ] || die "input not found: ${INPUT}"
  [ -r "${INPUT}" ] || die "input not readable: ${INPUT}"
  JSON="$(cat "${INPUT}")" || die "could not read input: ${INPUT}"
else
  SRC="stdin"
  JSON="$(cat)" || die "could not read the settings document from stdin"
fi

# An empty read is NOT "no findings". It is an `az` invocation that produced
# nothing — a wrong app name, a failed login, a swallowed error. Fail closed.
[ -n "${JSON}" ] || die "no input (empty ${SRC}) — an unreadable live settings document is NOT an absent scalar key; refusing to report PASS on an assertion that never ran"

printf '%s\n' "${JSON}" | jq -e . >/dev/null 2>&1 || \
  die "input is not valid JSON (${SRC}) — refusing to report PASS on a document that could not be parsed. (The document is NOT echoed here: it carries app setting values.)"

# --- 2b. Fail-closed STRUCTURAL validation ----------------------------------
# Valid JSON is not enough. `{}`, `"nope"`, `123` and `{"value":[]}` all parse;
# every one of them would yield zero settings from the collectors below and trip
# a vacuous PASS. `az functionapp config appsettings list` emits a JSON ARRAY of
# `{"name": ..., "slotSetting": ..., "value": ...}` objects and nothing else, so
# require exactly that shape before trusting anything.
top_type="$(printf '%s\n' "${JSON}" | jq -r 'type' 2>/dev/null || echo "__PROBE_ERROR__")"
[ "${top_type}" = "__PROBE_ERROR__" ] && \
  die "the top-level type probe itself failed on ${SRC} — refusing to report PASS on a document whose structure could not be validated"
[ "${top_type}" = "array" ] || \
  die "unexpected document shape (${SRC}): top-level is '${top_type}', expected the JSON 'array' that 'az functionapp config appsettings list' emits. An object/string/number here is not a settings document; refusing to inspect it"

# An empty array is a FATAL, not a PASS. A live Function App always carries
# settings (the platform injects several before anything of ours is applied), so
# `[]` means the query did not reach the app it was meant to: wrong name, wrong
# resource group, or an identity that can read the resource but returned nothing.
# Reporting "no scalar key found" from a document with no settings in it would be
# true and completely worthless.
entry_count="$(printf '%s\n' "${JSON}" | jq -r 'length' 2>/dev/null || echo "__PROBE_ERROR__")"
case "${entry_count}" in
  ''|*[!0-9]*) die "the entry-count probe returned a non-numeric result on ${SRC} — refusing to report PASS on a document that could not be counted" ;;
esac
[ "${entry_count}" -gt 0 ] || \
  die "the settings document (${SRC}) is an EMPTY array — a live Function App always carries settings, so this is a query that did not reach the intended app (wrong app/resource-group, or an error swallowed upstream), NOT a clean site. Fail-closed"

# Every entry must be an OBJECT carrying a STRING "name". Anything else is a
# malformed document: the name comparisons below are the entire assertion, and a
# document whose entries cannot be named reliably cannot be asserted against.
malformed="$(printf '%s\n' "${JSON}" | jq -r '
  [ .[]
    | if type != "object" then 1
      elif (has("name") | not) then 1
      elif ((.name | type) != "string") then 1
      else empty end
  ] | length
' 2>/dev/null || echo "__PROBE_ERROR__")"
case "${malformed}" in
  ''|*[!0-9]*) die "the entry-shape probe itself failed on ${SRC} — refusing to report PASS on a document whose entries could not be validated" ;;
esac
[ "${malformed}" -eq 0 ] || \
  die "${malformed} of ${entry_count} entries in ${SRC} are not objects with a string 'name' — a malformed settings document cannot be asserted against, since the key comparisons ARE the assertion. Fail-closed"

# --- 3. Diagnosis: the full list of setting NAMES ---------------------------
# NAMES ONLY — never values. This is the operator's diagnostic surface: it is how
# a stray deployment-storage connection-string setting (which the provider's
# Update path injects, and whose presence is itself evidence the injector was an
# UPDATE rather than a create or a `func publish`) becomes visible without anyone
# having to dump the document somewhere it can be read.
names="$(printf '%s\n' "${JSON}" | jq -r '.[].name' 2>/dev/null || echo "__PROBE_ERROR__")"
[ "${names}" = "__PROBE_ERROR__" ] && \
  die "failed to collect the setting NAME list from ${SRC} — refusing to report PASS on an assertion whose inputs could not be enumerated"

echo "${PROG}: asserting live host storage on ${SRC} (${entry_count} settings; expected account name: ${ACCOUNT_NAME})"
echo "${PROG}: live setting NAMES (values deliberately NOT shown):"
printf '%s\n' "${names}" | sed 's/^/      /'
echo

# --- 4. The two comparisons -------------------------------------------------
# EXACT equality, both directions, via jq `==`. No prefix/substring/case-folded
# test appears anywhere: `AzureWebJobsStorage__accountName` must never satisfy or
# trip the scalar check, and the scalar form must never satisfy the account-name
# requirement.
scalar_count="$(printf '%s\n' "${JSON}" | jq -r --arg k "${SCALAR_KEY}" '
  [ .[] | select(.name == $k) ] | length
' 2>/dev/null || echo "__PROBE_ERROR__")"
case "${scalar_count}" in
  ''|*[!0-9]*) die "the scalar-key probe itself failed on ${SRC} (key ${SCALAR_KEY}) — refusing to report PASS on a comparison that did not provably run" ;;
esac

# The account-name verdict is a NAMED STATE, not a boolean, so that "the
# comparison ran and disagreed" can never be confused with "the comparison did
# not run". Any value other than the five recognized states is a fatal.
acct_state="$(printf '%s\n' "${JSON}" | jq -r --arg k "${IDENTITY_KEY}" --arg want "${ACCOUNT_NAME}" '
  [ .[] | select(.name == $k) ] as $m
  | if   ($m | length) == 0            then "MISSING"
    elif ($m | length) > 1             then "DUPLICATE"
    elif (($m[0].value | type) != "string") then "NONSTRING"
    elif ($m[0].value == $want)        then "MATCH"
    else "MISMATCH" end
' 2>/dev/null || echo "__PROBE_ERROR__")"

violations=0
scalar_present=0

# report <setting-name> <reason>  — a NAME and a fixed reason. Never a value.
report() {
  echo "  ✗ VIOLATION [${1}]" >&2
  echo "        reason: ${2}" >&2
  violations=$((violations + 1))
}

if [ "${scalar_count}" -gt 0 ]; then
  scalar_present=1
  # Machine-readable marker for the calling workflow's bounded remediation. A
  # setting NAME, so this leaks nothing; it exists so the caller never has to
  # parse prose to decide whether the one-key delete applies.
  echo "SCALAR_KEY_PRESENT=${SCALAR_KEY}"
  report "${SCALAR_KEY}" "the credential-carrying scalar host-storage connection string is PRESENT on the live site. The Functions host resolves this form BEFORE ${IDENTITY_KEY}, so it authenticates with the empty AccountKey this value carries against an account with allowSharedKeyAccess=false, and host storage is dead (no host lock lease, no timer schedule status, 'Process reporting unhealthy' every ~30s). CAUSE: hashicorp/azurerm v4.81.0 composes and writes this key on every Function App create AND Update, and hides it on read by routing it into storage_access_key — it is NOT drift and NOT a human edit, and it is absent from HCL, from the plan and from state by construction. FIX: delete exactly this one setting on this one app, then restart the host. See learnings/decisions/mg-58-host-storage-managed-identity.md and docs/infrastructure/mg58-host-storage-verification.md"
fi

case "${acct_state}" in
  MATCH)
    echo "  · ${IDENTITY_KEY} present and equal to the expected account name (${ACCOUNT_NAME}) — identity-based host storage is configured"
    ;;
  MISSING)
    report "${IDENTITY_KEY}" "the identity-based host-storage setting is ABSENT from the live site. Without it the host has no way to reach its own required storage by managed identity. It is declared in apps/infrastructure/modules/functions/main.tf and asserted by the module's terraform tests, so its absence live means the apply did not reach this app (or something removed it out of band)"
    ;;
  DUPLICATE)
    report "${IDENTITY_KEY}" "the live site carries MORE THAN ONE entry for this setting. Which one the host resolves is not determinable from here, so the identity configuration cannot be asserted. Fail-closed"
    ;;
  NONSTRING)
    report "${IDENTITY_KEY}" "the live setting exists but its value is not a JSON string (null or a non-string type), so it cannot equal the expected account name. Fail-closed"
    ;;
  MISMATCH)
    # The observed value is WITHHELD on purpose. The expected name came from the
    # caller (terraform output), so echoing it back is safe; the observed one was
    # read out of the live document, and this gate does not print values.
    report "${IDENTITY_KEY}" "the live value does NOT equal the expected storage account name. expected='${ACCOUNT_NAME}' observed=[REDACTED] — the host would authenticate against the wrong account, or against nothing. Inspect the live setting directly rather than in this log"
    ;;
  __PROBE_ERROR__)
    die "the ${IDENTITY_KEY} comparison itself failed on ${SRC} — refusing to report PASS on a comparison that did not provably run"
    ;;
  *)
    die "the ${IDENTITY_KEY} comparison returned an unrecognized verdict — refusing to interpret it. This is a bug in this gate, and it fails closed by design"
    ;;
esac

# --- 5. Non-fatal operator NOTES --------------------------------------------
# Reported, never enforced. These are names worth an operator's attention that
# are NOT part of guard 4's contract: turning them into failures here would make
# this gate red for reasons the ticket did not scope, and a gate that cries wolf
# gets disabled. NAMES only, as everywhere else.
other_hoststorage="$(printf '%s\n' "${JSON}" | jq -r --arg s "${SCALAR_KEY}" --arg i "${IDENTITY_KEY}" '
  .[].name | select(startswith($s) and . != $s and . != $i)
' 2>/dev/null || echo "__PROBE_ERROR__")"
[ "${other_hoststorage}" = "__PROBE_ERROR__" ] && \
  die "the host-storage variant probe itself failed on ${SRC} — refusing to report PASS on a partially-run inspection"
if [ -n "${other_hoststorage}" ]; then
  echo "  NOTE: additional ${SCALAR_KEY}* setting NAMES are present on the live site (the account-name and *ServiceUri forms are ALTERNATIVES, not complements — see modules/functions/main.tf):"
  printf '%s\n' "${other_hoststorage}" | sed 's/^/          /'
fi

deploy_connstr="$(printf '%s\n' "${JSON}" | jq -r '
  .[].name | select(test("DEPLOYMENT_STORAGE_CONNECTION_STRING"; "i"))
' 2>/dev/null || echo "__PROBE_ERROR__")"
[ "${deploy_connstr}" = "__PROBE_ERROR__" ] && \
  die "the deployment-storage probe itself failed on ${SRC} — refusing to report PASS on a partially-run inspection"
if [ -n "${deploy_connstr}" ]; then
  echo "  NOTE: a deployment-storage connection-string setting NAME is present. The module declares no such setting; the azurerm provider's Function App UPDATE path injects it, so its presence is forensic evidence that an UPDATE (not a create, and not 'func azure functionapp publish') was the injector here too:"
  printf '%s\n' "${deploy_connstr}" | sed 's/^/          /'
fi

# --- 6. Verdict -------------------------------------------------------------
# The PASS below is re-derived from the two comparisons rather than from the
# violation counter alone, so no future edit can reach it by decrementing a
# counter: it requires the scalar count to have been read as exactly 0 AND the
# account-name verdict to have been read as exactly MATCH.
echo
if [ "${violations}" -ne 0 ] || [ "${scalar_count}" -ne 0 ] || [ "${acct_state}" != "MATCH" ]; then
  if [ "${scalar_present}" -eq 1 ]; then
    echo "${PROG}: FAILED — the scalar ${SCALAR_KEY} setting is on the live site and SHADOWS ${IDENTITY_KEY}. Delete that ONE setting on that ONE app and re-run this gate. Do NOT restore shared keys, and do NOT remove the account-name setting (that rollback is strictly worse than the defect)." >&2
    exit 3
  fi
  echo "${PROG}: FAILED — ${violations} live host-storage violation(s)." >&2
  exit 1
fi
echo "${PROG}: PASS — the scalar ${SCALAR_KEY} setting is ABSENT from the live site and ${IDENTITY_KEY} equals ${ACCOUNT_NAME}."
exit 0
