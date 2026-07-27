#!/usr/bin/env bash
#
# tf-plan-destroy-guard.sh — FAIL-CLOSED destructive-change circuit-breaker for
# the MeatGeek V2 Terraform stack (MG-23, automated dev GitOps reconciliation).
#
# CONTEXT — why this exists at all.
#   MG-24 = Terraform reconciliation, OPERATOR-run: a human read every plan
#           before typing `terraform apply`, so "this plan destroys the whole
#           stack" was caught by eyeball.
#   MG-23 = automated dev GitOps reconciliation, CI-run: the apply happens
#           unattended on merge to `main`. That eyeball is gone. This script is
#           its replacement, and it is the LAST thing standing between a merged
#           one-line HCL edit and an unattended teardown of live dev
#           infrastructure.
#
#   The concrete hazard: the dev stack sets
#   `prevent_deletion_if_contains_resources = false`, and Cosmos DB / IoT Hub
#   treat `location` as ForceNew. A single-token `location` edit therefore plans
#   as a destroy-and-recreate ACROSS the stack — data-bearing resources included
#   — and, with no guard, an automatic apply would execute it.
#
# WHAT COUNTS AS A PROTECTED CHANGE — TWO VERBS, NOT ONE.
#   `delete`  the resource is destroyed. Includes REPLACE plans
#             (`["delete","create"]` and the create-before-destroy
#             `["create","delete"]`), because a replace destroys the original
#             resource and its data just as thoroughly as a bare delete does.
#   `forget`  the resource is DROPPED OUT OF TERRAFORM MANAGEMENT and left
#             running, which is what a `removed { destroy = false }` block
#             plans. This is not a destroy, and that is exactly why it needs
#             guarding: every downstream control in the pipeline stays GREEN.
#             The post-apply state gate sees a smaller state and finds no
#             secrets; the final drift plan sees a smaller configuration and
#             reports CONVERGED. A data-bearing resource can be silently
#             orphaned out of the GitOps loop — still holding its data, still
#             costing money, now managed by nobody and watched by nothing —
#             with a fully green run. So `forget` is protected too.
#
#   ANY OTHER ACTION VERB the plan carries that this gate does not recognize as
#   benign (`no-op`, `create`, `read`, `update`) is ALSO treated as protected.
#   A future Terraform release that introduces a new destructive verb must fail
#   this gate on sight rather than fall through it as unclassified. Fail-closed
#   means an unrecognized verb blocks; it does not mean it is ignored.
#
#   AND IT IS UNAUTHORIZABLE — blocking is not enough on its own. A verb outside
#   the MODELED set (`no-op`, `create`, `read`, `update`, `delete`, `forget`)
#   cannot be classified, so this gate cannot describe what applying it would do,
#   so it will not present it for review: the RECOVERY override cannot clear it
#   under the unmodeled verb itself, nor under a modeled verb that the same entry
#   also carries. See section 3b.
#
# THE AUTHORIZATION UNIT IS AN ACTION-QUALIFIED CHANGE TOKEN.
#   A genuinely intended destructive change is unblocked by setting
#   TF_DESTROY_GUARD_AUTHORIZED_CHANGES to the EXACT SET of change TOKENS the
#   operator reviewed (comma- or whitespace-separated). A token is:
#
#       <action>:<address>[#deposed=<key>]
#
#   e.g.  delete:module.native_otlp.azurerm_container_app.collector
#         forget:module.cosmos_db.azurerm_cosmosdb_account.main
#         delete:azurerm_linux_function_app.main#deposed=a1b2c3d4
#
#   The gate fails unless the plan's actual protected-change set is EXACTLY that
#   set — same members, no more, no fewer. The gate PRINTS the paste-ready token
#   list for the plan it just inspected, so the operator never has to hand-build
#   one.
#
#   WHY THE ACTION IS PART OF THE TOKEN. `destroy this resource` and `stop
#   managing this resource` are different decisions with different consequences,
#   and an operator who reviewed and approved one has not approved the other. If
#   authorization were keyed on the address alone, an approval issued to tear
#   down a retired Container App would also clear a `removed { destroy = false }`
#   block that silently orphans it instead — same address, opposite outcome,
#   gate green. Action-qualified tokens make `delete:<addr>` and `forget:<addr>`
#   non-interchangeable in both directions.
#
#   WHY THE DEPOSED KEY IS PART OF THE TOKEN. When a create-before-destroy
#   replacement fails part-way, Terraform keeps the old object in state as a
#   DEPOSED object, and the next plan carries BOTH a change for the current
#   object and a separate change for each deposed one — ALL SHARING ONE ADDRESS.
#   Deposed objects are real, live infrastructure holding real data. Keyed on
#   address alone, three distinct destructive changes collapse into one
#   authorization unit: approving the current object's destroy would silently
#   authorize the deposed objects' destroys too, and the operator would never
#   see them enumerated. Qualifying with `#deposed=<key>` makes every deposed
#   object INDIVIDUALLY visible in the failure output and INDIVIDUALLY
#   authorizable.
#
#   IT IS NOT A COUNT, AND NEVER WILL BE. A count authorizes an ARITY, and arity
#   is not the thing the operator reviewed: "2 destroys were approved" is cleared
#   just as happily by a DIFFERENT two resources. Under an exact-count override,
#   an operator who reviews and authorizes the teardown of two disposable
#   Container Apps hands out a token that a later, rebased, or maliciously
#   amended plan can spend on the Cosmos account and the IoT Hub instead — same
#   count, total data loss, gate green. The tokens ARE the authorization;
#   anything less re-authorizes a plan nobody looked at.
#
#   Consequently a superset FAILS (the plan grew a change since review), a subset
#   FAILS (the plan is not the plan that was reviewed — re-review it), and a
#   permutation of the same arity FAILS. There is deliberately no `true` / `yes`
#   / `all` / `*` escape hatch. A BARE NUMBER is rejected outright with a pointed
#   message (it is the pre-MG-23 count form), and so is a BARE ADDRESS with no
#   action prefix. Malformed values are REJECTED (fail-closed), never downgraded
#   to "unset".
#
#   In .github/workflows/infra-apply-dev.yml the override is populated ONLY from
#   the branch-restricted `workflow_dispatch` RECOVERY input — the automatic
#   apply-on-merge path passes no override at all, so an unattended apply can
#   never destroy or orphan anything regardless of repository-variable state.
#
# EXIT CODES ARE PART OF THE CONTRACT.
#   0  inspection completed AND the protected-change set is empty, or exactly
#      equals a valid authorization set.
#   1  a VERDICT of "blocked": protected changes exist and are not (exactly)
#      authorized, or the authorization value itself is malformed.
#   2  the plan could NOT BE INSPECTED: no jq, unreadable input, invalid JSON,
#      not a plan document, or a resource_changes entry whose shape this gate
#      does not understand.
#
#   THE SPLIT IS LOAD-BEARING, not cosmetic. Exit 2 is unreachable by the
#   authorization logic — it happens BEFORE the verdict section, so an operator
#   cannot clear it with an override no matter how correct that override is. Any
#   ordinary plan shape that lands on exit 2 therefore WEDGES the GitOps loop
#   with no in-band recovery path. That is precisely the bug an earlier revision
#   had: a deposed object made the address enumeration disagree with the row
#   count, which tripped a self-consistency `die` at exit 2 and left the recovery
#   dispatch provably unable to clear it. Reserve exit 2 for documents this gate
#   genuinely cannot read; everything that is a JUDGEMENT about a readable plan
#   must be exit 1, where the reviewer-approved override can reach it.
#
# PORTABILITY IS A SECURITY PROPERTY, NOT A STYLE NOTE.
#   Written to strict POSIX sh so it behaves IDENTICALLY under macOS's default
#   bash 3.2, modern bash 5, and dash (`/bin/sh` on the ubuntu-latest runner).
#   No bash-4 case modification (${v,,}), no associative arrays, no here-strings
#   (<<<), no process substitution. A gate that ERRORS on one shell while still
#   reaching a PASS on another is FAIL-OPEN — the exact MG-24 regression that
#   scripts/fixtures/run-flex-secret-gate-fixtures.sh was written to catch, and
#   scripts/fixtures/run-destroy-guard-fixtures.sh runs every fixture here under
#   BOTH bash and dash for the same reason.
#
# WHAT IT DOES
#   1. Loads a `terraform show -json` PLAN document (from a file arg, a plan
#      binary it renders via `terraform show -json`, or stdin).
#   2. Requires the shape of a real PLAN document — a top-level object with
#      `format_version` AND a `resource_changes` ARRAY — and requires every
#      entry in that array to carry an inspectable address and action list. A
#      STATE document has no `resource_changes`, and `{}` / `[]` /
#      `{"foo":"bar"}` all parse as valid JSON while containing nothing to
#      inspect. Any of those would walk zero changes and trip a VACUOUS PASS, so
#      all of them FAIL CLOSED here.
#   3. Canonicalizes every protected change to `<action>:<address>[#deposed=key]`
#      and prints each one with its full action list. Tokens are STRUCTURAL
#      identifiers, never resource VALUES — nothing this script prints can leak a
#      credential out of the plan. (Value inspection is
#      scripts/tf-plan-secret-inspection.sh's job; the two gates compose and
#      neither replaces the other.)
#   4. Exits per the contract above.
#
# USAGE
#   tf-plan-destroy-guard.sh <plan.json>     # a `terraform show -json` doc
#   tf-plan-destroy-guard.sh <tfplan>        # a plan binary (needs terraform)
#   terraform show -json tfplan | tf-plan-destroy-guard.sh -    # via stdin
#   tf-plan-destroy-guard.sh --json <file>   # force JSON interpretation
#
#   TF_DESTROY_GUARD_AUTHORIZED_CHANGES='delete:module.native_otlp.azurerm_container_app.collector,delete:module.native_otlp.azapi_resource.otlp_dcr' \
#     tf-plan-destroy-guard.sh tfplan.bin
#
set -u
# pipefail is a bash/ksh feature; dash lacks it and would print
# "Illegal option -o pipefail" and skew the exit code. Enable it only where it
# exists. Correctness never DEPENDS on it here — every pipeline below starts
# with printf, which cannot fail — so this is defense in depth. Probing it in a
# subshell keeps dash silent.
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

# die() is for "I could not inspect this", and ONLY that — see the exit-code
# contract in the header. Never reach for it to express a verdict.
die() { echo "tf-plan-destroy-guard: FATAL: $*" >&2; exit 2; }   # uninspectable

command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"

# --- 1. Load the plan JSON --------------------------------------------------
force_json=0
if [ "${1:-}" = "--json" ]; then
  force_json=1
  shift
fi

SRC=""
if [ -z "${1:-}" ] || [ "${1:-}" = "-" ]; then SRC="stdin"; else SRC="${1}"; fi

read_input() {
  arg="${1:-}"
  if [ -z "${arg}" ] || [ "${arg}" = "-" ]; then
    cat
    return
  fi
  [ -f "${arg}" ] || die "input not found: ${arg}"
  # A `terraform show -json` document is JSON; a plan binary is not. If the file
  # already parses as JSON (or the caller forced --json), use it directly.
  # Otherwise treat it as a plan binary and render it with terraform.
  if [ "${force_json}" -eq 1 ] || jq -e . "${arg}" >/dev/null 2>&1; then
    cat "${arg}"
    return
  fi
  command -v terraform >/dev/null 2>&1 || \
    die "input '${arg}' is not JSON and terraform is not on PATH to render it"
  terraform show -json "${arg}" 2>/dev/null || \
    die "terraform show -json failed on plan binary: ${arg}"
}

# read_input runs in a command substitution (a subshell); its die() exits that
# subshell, which the substitution propagates here. Catch it so we surface ONE
# fatal and stay fail-closed rather than dying twice.
if ! JSON="$(read_input "${1:-}")"; then
  exit 2
fi
[ -n "${JSON}" ] || die "no plan input (empty ${SRC})"
printf '%s\n' "${JSON}" | jq -e . >/dev/null 2>&1 || die "input is not valid JSON (${SRC})"

# --- 2. Fail-closed STRUCTURAL validation -----------------------------------
# Valid JSON is NOT enough. A PASS must be reachable ONLY after genuinely
# walking a recognizable terraform PLAN document, so require that shape up
# front: a top-level OBJECT carrying format_version AND a resource_changes
# ARRAY. An empty resource_changes array is a legitimate no-op plan and passes;
# a MISSING resource_changes means this is not a plan (most likely a STATE
# document, where destroys are not expressible) and fails closed.
top_type="$(printf '%s\n' "${JSON}" | jq -r 'type' 2>/dev/null || true)"
[ "${top_type}" = "object" ] || \
  die "cannot inspect: top-level is '${top_type:-unknown}', expected a 'terraform show -json' plan object (${SRC})"

has_shape="$(printf '%s\n' "${JSON}" | jq -r '
  (has("format_version")) and ((.resource_changes | type) == "array")
' 2>/dev/null || echo "error")"
[ "${has_shape}" = "true" ] || \
  die "cannot inspect: ${SRC} is missing format_version and/or a resource_changes ARRAY — this gate inspects a terraform PLAN document (a STATE document cannot express destroys); refusing to report PASS on a document it did not walk"

# PER-ENTRY shape validation. The classification below reads .address,
# .change.actions and .deposed; if any entry does not carry those in a form this
# gate understands, the gate has NOT inspected that entry and must not speak for
# it. Newlines and tabs in an address are rejected here because the enumeration
# is line- and tab-delimited: an address containing either could forge extra
# rows or truncate a token, which is a parsing ambiguity in the identifier the
# whole authorization turns on.
bad_entries="$(printf '%s\n' "${JSON}" | jq -r '
  [ .resource_changes[]
    | select(
        ((.address | type) != "string")
        or (.address == "")
        or ((.address | test("[\n\t]")))
        or ((.change | type) != "object")
        or ((.change.actions | type) != "array")
        or ((.change.actions | length) == 0)
        or (([ .change.actions[]
               | select((type != "string") or ((test("^[a-z][a-z-]*$")) | not)) ] | length) > 0)
        or ((.deposed != null)
            and (((.deposed | type) != "string")
                 or ((.deposed | test("^[A-Za-z0-9_-]+$")) | not)))
      )
  ] | length
' 2>/dev/null)" || die "cannot inspect: failed to validate resource_changes entries from ${SRC}"
case "${bad_entries}" in
  ''|*[!0-9]*) die "cannot inspect: entry validation did not resolve to a number (${SRC})" ;;
esac
[ "${bad_entries}" -eq 0 ] || \
  die "cannot inspect: ${bad_entries} resource_changes entr(ies) in ${SRC} lack a usable address / action list / deposed key — this gate refuses to report on a change set it could not fully classify"

# --- 3. Enumerate the PROTECTED changes -------------------------------------
# Canonical token: <action>:<address>[#deposed=<key>]  (see the header).
#
# Verb precedence is delete > forget > any-unrecognized-verb. A change carrying
# `delete` is a destroy whatever else it carries; `forget` is state orphaning;
# anything this gate has no opinion about is protected under its own verb so a
# new Terraform action cannot slip through as unclassified — and, per section 3b
# below, it is also UNAUTHORIZABLE: the gate cannot present a change it has no
# model of for review, so there is no in-band override for it in either
# direction. PROTECTED alone was not enough: a token like `obliterate:<addr>` is
# a well-formed member of the actual set, so the verdict's set-equality test
# would happily match an override naming it and print AUTHORIZED over a verb
# whose consequences this gate cannot describe. Section 3b closes that.
#
# A jq failure here means the change set could not be enumerated — that is an
# inspection that could not run, so FAIL CLOSED (exit 2) rather than defaulting
# to "nothing protected".
JQ_PROTECTED='
  def benign: {"no-op": true, "create": true, "read": true, "update": true};
  def pverb($a):
    if ($a | index("delete")) then "delete"
    elif ($a | index("forget")) then "forget"
    else ([ $a[] | select(benign[.] != true) ] | first)
    end;
  .resource_changes[]
  | (.change.actions) as $a
  | (pverb($a)) as $v
  | select($v != null)
  | ((.deposed // "")) as $d
  | (if $d == "" then "" else "#deposed=" + $d end) as $dsuf
'

PROTECTED_ROWS="$(printf '%s\n' "${JSON}" | jq -r "${JQ_PROTECTED}"'
  | "\($v):\(.address)\($dsuf)\t[\($a | join(","))]"
' 2>/dev/null)" || die "cannot inspect: failed to enumerate resource_changes from ${SRC}"

if [ -z "${PROTECTED_ROWS}" ]; then
  protected_count=0
else
  protected_count="$(printf '%s\n' "${PROTECTED_ROWS}" | grep -c '^' 2>/dev/null || true)"
fi
case "${protected_count}" in
  ''|*[!0-9]*) die "cannot inspect: protected-change count did not resolve to a number (${SRC})" ;;
esac

# The TOKEN SET is the authorization unit. Enumerate it straight from jq rather
# than by re-parsing the formatted display rows.
#
# The jq run and the sort are two SEPARATE statements on purpose. As one
# pipeline, a jq failure under dash (which has no pipefail) would be masked by
# sort's exit 0, yielding an empty set that reads as "this plan changes nothing
# destructively" — a fail-open on the very field the verdict turns on.
ACTUAL_TOKENS="$(printf '%s\n' "${JSON}" | jq -r "${JQ_PROTECTED}"'
  | "\($v):\(.address)\($dsuf)"
' 2>/dev/null)" || die "cannot inspect: failed to enumerate protected-change tokens from ${SRC}"

ACTUAL_SET="$(printf '%s\n' "${ACTUAL_TOKENS}" | sed '/^[[:space:]]*$/d' | sort -u)"

# Consistency invariant: (action, address, deposed key) is unique per plan entry,
# so the de-duplicated token set must have exactly as many members as there are
# protected rows. This is the invariant a bare-address identity BROKE: a current
# object and its deposed twin share one address, so address-keyed de-duplication
# lost a row here and tripped this check at exit 2 — unreachable by any override.
# With the deposed key in the token the two are distinct, and this check is back
# to meaning what it says: the two enumerations agree.
if [ -z "${ACTUAL_SET}" ]; then
  actual_set_size=0
else
  actual_set_size="$(printf '%s\n' "${ACTUAL_SET}" | grep -c '^' 2>/dev/null || true)"
fi
[ "${actual_set_size}" = "${protected_count}" ] || \
  die "cannot inspect: protected rows (${protected_count}) and protected tokens (${actual_set_size}) disagree for ${SRC}"

total_changes="$(printf '%s\n' "${JSON}" | jq -r '
  [.resource_changes[] | select(((.change.actions // []) | index("no-op")) | not)] | length
' 2>/dev/null)" || die "cannot inspect: failed to count planned changes from ${SRC}"

echo "tf-plan-destroy-guard: inspecting ${SRC}"
echo "  planned changes (excluding no-op): ${total_changes}"
echo "  DESTRUCTIVE / state-orphaning changes: ${protected_count}"

if [ "${protected_count}" -gt 0 ]; then
  echo
  echo "  the following changes are PROTECTED and must be authorized individually:" >&2
  printf '%s\n' "${PROTECTED_ROWS}" | sed 's/^/    ✗ /' >&2
  echo
  echo "  paste-ready authorization set for THIS plan (review every token first):" >&2
  printf '    %s\n' "$(printf '%s\n' "${ACTUAL_SET}" | paste -sd, - 2>/dev/null || printf '%s' "${ACTUAL_SET}" | tr '\n' ',')" >&2
  echo
fi

# A token that cannot be expressed in the override cannot be authorized in band.
# Commas and whitespace are the override's own separators, so a token containing
# either could never be handed back as an authorization — and a change nobody can
# authorize must BLOCK (exit 1, a verdict), not masquerade as an unreadable plan
# (exit 2). No address in this stack has ever contained one; a terraform index
# key would have to introduce it.
OLD_IFS="${IFS}"
IFS='
'
set -f
for tok in ${ACTUAL_SET}; do
  [ -n "${tok}" ] || continue
  case "${tok}" in
    *,*|*\ *|*"	"*)
      set +f; IFS="${OLD_IFS}"
      echo "tf-plan-destroy-guard: FAILED — protected change '${tok}' contains a comma or whitespace. DO NOT APPLY." >&2
      echo "  The authorization set is comma/whitespace separated, so this token could never" >&2
      echo "  be handed back as an authorization: there is NO in-band override for it. This" >&2
      echo "  plan must be reviewed and applied by an operator. See" >&2
      echo "  docs/infrastructure/mg23-live-acceptance.md." >&2
      exit 1 ;;
  esac
done
set +f
IFS="${OLD_IFS}"

# --- 3b. UNMODELED ACTION VERBS ARE UNAUTHORIZABLE --------------------------
# Section 3 makes an unrecognized verb PROTECTED (it is enumerated under its own
# verb, so it blocks the automatic path). That is necessary but NOT sufficient:
# `<verb>:<address>` is a well-formed token, so the RECOVERY path's set-equality
# check would happily accept `obliterate:module.iot_hub.azurerm_iothub.main` and
# print DESTRUCTIVE APPLY AUTHORIZED for a verb this gate has no model of. The
# operator would be approving a consequence nobody — including this gate — can
# describe. Authorization is only meaningful over changes the gate can present
# for review, so a verb outside the modeled set has NO in-band authorization at
# all, in either direction.
#
# The sharper case, which an allowlist on the AUTH token's verb alone would miss:
# actions ["delete","obliterate"]. Verb precedence emits `delete:<addr>`, an
# operator authorizes THAT in good faith, and the apply proceeds while the gate
# silently drops a second verb it cannot reason about. So this screens every
# action string on every entry, not just the one verb that won precedence.
#
# THE MODELED SET is the complete resource_changes[].change.actions vocabulary of
# the terraform plan JSON format: no-op, create, read, update, delete, forget.
# (`replace` is not an action — it is expressed as the PAIR ["delete","create"],
# or ["create","delete"] for create-before-destroy.)
#
# EXIT 1, NOT 2, DELIBERATELY. This is a VERDICT about a perfectly readable plan,
# not a document the gate could not inspect — the same reasoning as the
# comma/whitespace token check one screen up. Exit 2 fires before the verdict
# section and no override can clear it, so routing this there would WEDGE the
# GitOps loop with no in-band recovery path. It therefore lives HERE, after the
# enumeration and before the verdict, and NOT in the per-entry shape validation
# of section 2 (which exits 2).
UNMODELED_ROWS="$(printf '%s\n' "${JSON}" | jq -r '
  def modeled: {"no-op": true, "create": true, "read": true,
                "update": true, "delete": true, "forget": true};
  .resource_changes[]
  | select([ .change.actions[] | select(modeled[.] != true) ] | length > 0)
  | "\(.address)\t[\(.change.actions | join(","))]"
' 2>/dev/null)" || die "cannot inspect: failed to screen resource_changes for unmodeled action verbs from ${SRC}"

if [ -n "${UNMODELED_ROWS}" ]; then
  echo "tf-plan-destroy-guard: FAILED — this plan carries action verb(s) this gate has no model of. DO NOT APPLY." >&2
  printf '%s\n' "${UNMODELED_ROWS}" | sed 's/^/    ✗ /' >&2
  echo "  The modeled action vocabulary is: no-op, create, read, update, delete, forget." >&2
  echo "  A verb outside it cannot be classified, so the gate cannot describe what applying" >&2
  echo "  it would do — and it will not present a change for review that it cannot explain." >&2
  echo "  There is therefore NO in-band authorization for it: TF_DESTROY_GUARD_AUTHORIZED_CHANGES" >&2
  echo "  cannot clear this, neither under the unmodeled verb itself nor under a modeled verb" >&2
  echo "  the same entry also carries. This plan must be reviewed and applied by an operator," >&2
  echo "  and this gate taught the new verb first. See docs/infrastructure/mg23-live-acceptance.md." >&2
  exit 1
fi

# --- 4. Verdict -------------------------------------------------------------
AUTHORIZED="${TF_DESTROY_GUARD_AUTHORIZED_CHANGES:-}"

# RETIRED VARIABLES ARE REFUSED, NEVER IGNORED. Ignoring one is the worst
# outcome available: the operator believes they authorized a change while the
# gate behaves as though nothing was authorized — or, on the automatic path,
# a stale name lingers in a workflow long enough to look supported.
#
#   TF_DESTROY_GUARD_EXPECTED_DESTROYS  authorized a destroy COUNT (pre-MG-23).
#   TF_DESTROY_GUARD_AUTHORIZED_DESTROYS  authorized bare ADDRESSES, with no
#     action qualifier — so an approval to DESTROY a resource also cleared a
#     `removed { destroy = false }` block that ORPHANS it instead. Renamed to
#     ...AUTHORIZED_CHANGES because the set now covers both outcomes.
if [ -n "${TF_DESTROY_GUARD_EXPECTED_DESTROYS:-}" ]; then
  echo "tf-plan-destroy-guard: FAILED — TF_DESTROY_GUARD_EXPECTED_DESTROYS is no longer supported." >&2
  echo "  That variable authorized a destroy COUNT, which a different set of resources" >&2
  echo "  with the same count satisfies just as well. Authorization is now the exact SET" >&2
  echo "  of action-qualified change tokens: set TF_DESTROY_GUARD_AUTHORIZED_CHANGES" >&2
  echo "  instead. DO NOT APPLY." >&2
  exit 1
fi

if [ -n "${TF_DESTROY_GUARD_AUTHORIZED_DESTROYS:-}" ]; then
  echo "tf-plan-destroy-guard: FAILED — TF_DESTROY_GUARD_AUTHORIZED_DESTROYS is no longer supported." >&2
  echo "  That variable authorized bare ADDRESSES, so an approval to DESTROY a resource" >&2
  echo "  also cleared a 'removed { destroy = false }' block that ORPHANS the same address" >&2
  echo "  out of Terraform management instead. Authorization is now action-qualified:" >&2
  echo "  set TF_DESTROY_GUARD_AUTHORIZED_CHANGES to tokens of the form" >&2
  echo "  '<action>:<address>[#deposed=<key>]'. DO NOT APPLY." >&2
  exit 1
fi

if [ -z "${AUTHORIZED}" ]; then
  if [ "${protected_count}" -eq 0 ]; then
    echo "tf-plan-destroy-guard: PASS — this plan destroys nothing and orphans nothing."
    exit 0
  fi
  echo "tf-plan-destroy-guard: FAILED — ${protected_count} protected change(s) and none were authorized. DO NOT APPLY." >&2
  echo "  An automatic apply-on-merge must never destroy dev infrastructure, and must" >&2
  echo "  never drop a resource out of Terraform management, unattended." >&2
  echo "  If these changes ARE intended: review each token above, then re-run the" >&2
  echo "  branch-restricted workflow_dispatch RECOVERY path of infra-apply-dev.yml with" >&2
  echo "  authorized_changes set to the EXACT comma-separated TOKEN LIST above." >&2
  exit 1
fi

# An override was supplied. Normalize it to a sorted, de-duplicated set:
# split on commas and any whitespace, drop blanks, sort -u. Same normalization
# as ACTUAL_SET, so the comparison below is order- and duplicate-insensitive
# without either side needing to be canonical at its source.
AUTH_SET="$(printf '%s\n' "${AUTHORIZED}" \
  | tr ',' '\n' \
  | tr -s '[:space:]' '\n' \
  | sed 's/^[[:space:]]*//; s/[[:space:]]*$//' \
  | sed '/^$/d' \
  | sort -u)"

if [ -z "${AUTH_SET}" ]; then
  echo "tf-plan-destroy-guard: FAILED — TF_DESTROY_GUARD_AUTHORIZED_CHANGES was set but names no tokens. DO NOT APPLY." >&2
  echo "  An override that resolves to an empty set is a malformed instruction, not a" >&2
  echo "  request to authorize nothing; it is refused rather than downgraded to 'unset'." >&2
  exit 1
fi

# Membership test for a newline-delimited set. -F (literal, so a '.' in a token
# is a '.'), -x (whole line, so a substring can never masquerade as a member),
# -- (so an entry starting with '-' is data, not an option).
set_contains() {
  printf '%s\n' "$1" | grep -F -x -q -- "$2"
}

# Iterate members with IFS=newline and pathname expansion OFF. `set -f` is not
# cosmetic: a terraform address may contain [ ] " (e.g. module.x.res["key"]),
# and with globbing live an unquoted expansion could rewrite a token into a
# matching FILENAME — silently altering the very identifiers being compared.
# Both loops below run in THIS shell (no pipe), so `exit` exits the gate.
OLD_IFS="${IFS}"
IFS='
'
set -f

# Validate every member LOOKS like an action-qualified change token before
# trusting the comparison. This is what rejects the wildcard/boolean forms
# ('all', 'true', '*'), the stale bare-count form ('2'), and the stale bare
# ADDRESS form: none of them are tokens, and the failure they deserve is an
# explicit refusal, not a silent set mismatch whose message would send the
# operator hunting the wrong problem.
for tok in ${AUTH_SET}; do
  [ -n "${tok}" ] || continue

  # (a) the pre-MG-23 count form.
  case "${tok}" in
    *[!0-9]*) : ;;
    *)
      set +f; IFS="${OLD_IFS}"
      echo "tf-plan-destroy-guard: FAILED — authorized entry '${tok}' is a bare number. DO NOT APPLY." >&2
      echo "  Authorization is an exact SET of action-qualified change TOKENS, never a count:" >&2
      echo "  the same count is satisfied by a different — possibly data-bearing — set." >&2
      exit 1 ;;
  esac

  # (b) characters that cannot occur in a token. Catches '*' and friends.
  case "${tok}" in
    *[!A-Za-z0-9_.\[\]\"/:#=-]*)
      set +f; IFS="${OLD_IFS}"
      echo "tf-plan-destroy-guard: FAILED — authorized entry '${tok}' contains characters that cannot appear in a change token. DO NOT APPLY." >&2
      exit 1 ;;
  esac

  # (c) the ACTION QUALIFIER is mandatory. A bare address is the retired form and
  #     is refused rather than guessed at: guessing would have to pick a verb,
  #     and picking 'delete' for an operator who meant to review a 'forget' (or
  #     the reverse) hands out an authorization for a decision they did not make.
  #     'all' / 'true' and every other wildcard-ish word land here too.
  case "${tok}" in
    *:*) : ;;
    *)
      set +f; IFS="${OLD_IFS}"
      echo "tf-plan-destroy-guard: FAILED — authorized entry '${tok}' is not action-qualified. DO NOT APPLY." >&2
      echo "  Expected '<action>:<address>[#deposed=<key>]', e.g." >&2
      echo "    delete:module.native_otlp.azurerm_container_app.collector" >&2
      echo "    forget:module.cosmos_db.azurerm_cosmosdb_account.main" >&2
      echo "  A bare address cannot distinguish DESTROYING a resource from ORPHANING it out" >&2
      echo "  of Terraform management. There is no wildcard / boolean override form." >&2
      exit 1 ;;
  esac

  # The verb is everything before the FIRST colon; the address is the rest. A
  # terraform index key may itself contain a colon, which is why this splits on
  # the first one only and never re-splits the remainder.
  tok_verb="${tok%%:*}"
  tok_addr="${tok#*:}"

  case "${tok_verb}" in
    ''|*[!a-z-]*|-*)
      set +f; IFS="${OLD_IFS}"
      echo "tf-plan-destroy-guard: FAILED — authorized entry '${tok}' has an action qualifier ('${tok_verb}') that is not a terraform action verb. DO NOT APPLY." >&2
      exit 1 ;;
  esac

  case "${tok_addr}" in
    *.*) : ;;
    *)
      set +f; IFS="${OLD_IFS}"
      echo "tf-plan-destroy-guard: FAILED — authorized entry '${tok}' does not name a terraform resource address (expected e.g. delete:module.foo.azurerm_bar.baz). DO NOT APPLY." >&2
      exit 1 ;;
  esac
done

# Set equality, both directions, reported separately: "the plan grew a change
# since you reviewed it" and "the plan is missing a change you authorized" are
# different situations and the operator should not have to diff two lists to
# tell them apart. Note a same-COUNT permutation trips BOTH lists — which is
# precisely the case an exact-count override waved through.
UNAUTHORIZED=""
for tok in ${ACTUAL_SET}; do
  [ -n "${tok}" ] || continue
  set_contains "${AUTH_SET}" "${tok}" || UNAUTHORIZED="${UNAUTHORIZED}${tok}
"
done

MISSING=""
for tok in ${AUTH_SET}; do
  [ -n "${tok}" ] || continue
  set_contains "${ACTUAL_SET}" "${tok}" || MISSING="${MISSING}${tok}
"
done

set +f
IFS="${OLD_IFS}"

if [ -n "${UNAUTHORIZED}" ] || [ -n "${MISSING}" ]; then
  echo "tf-plan-destroy-guard: FAILED — the plan's protected-change set is NOT the authorized set. DO NOT APPLY." >&2
  if [ -n "${UNAUTHORIZED}" ]; then
    echo "  planned but NOT authorized:" >&2
    # The accumulators end in a newline; drop the blank line it produces.
    printf '%s' "${UNAUTHORIZED}" | sed '/^$/d; s/^/    ✗ /' >&2
  fi
  if [ -n "${MISSING}" ]; then
    echo "  authorized but NOT in this plan (the plan has changed since review):" >&2
    printf '%s' "${MISSING}" | sed '/^$/d; s/^/    ? /' >&2
  fi
  echo "  Authorization names the exact action-qualified tokens reviewed. A matching COUNT" >&2
  echo "  is not a match, and neither is a matching ADDRESS under a different action:" >&2
  echo "  re-review the plan and re-authorize the changes it actually makes." >&2
  exit 1
fi

echo "tf-plan-destroy-guard: PASS — ${protected_count} protected change(s), exactly matching the authorized token set."
if [ "${protected_count}" -gt 0 ]; then
  echo "  DESTRUCTIVE APPLY AUTHORIZED — the changes listed above will be executed."
fi
exit 0
