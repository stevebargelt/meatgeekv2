#!/usr/bin/env bash
#
# run-destroy-guard-fixtures.sh — deterministic regression harness for the MG-23
# destructive-change circuit-breaker (scripts/tf-plan-destroy-guard.sh).
#
# Exercises the gate against the committed terraform-show-json PLAN fixtures next
# to this script and asserts each expected exit code. No Azure, no `terraform`
# binary, no credentials — the gate consumes a `terraform show -json` document
# and every fixture here IS one.
#
# WHY EACH FIXTURE RUNS UNDER BOTH bash AND dash: the ubuntu-latest runner's
# /bin/sh is dash, and a gate that PASSes under bash but ERRORs under dash is
# FAIL-OPEN — the exact MG-24 portable-shell regression that
# run-flex-secret-gate-fixtures.sh next door was written to catch. A circuit
# breaker whose erroring-out is indistinguishable from its clearing is not a
# circuit breaker.
#
# EXPECTATIONS ARE EXIT CODES, NOT JUST "nonzero".
#   pass  -> exit 0
#   fail  -> exit nonzero (either kind of refusal is acceptable for this case)
#   1     -> EXACTLY 1: a VERDICT about a readable plan, which the reviewer-
#            approved override can act on
#   2     -> EXACTLY 2: the plan could not be INSPECTED at all
#
#   The 1-vs-2 distinction is load-bearing and is asserted exactly, not folded
#   into "nonzero". Exit 2 happens BEFORE the verdict section, so no override can
#   ever clear it: any ordinary plan shape that lands on 2 WEDGES the GitOps loop
#   with no in-band recovery. That was a real bug — a deposed object made the
#   address enumeration disagree with the row count and tripped a self-
#   consistency `die`, so the recovery dispatch provably could not clear a
#   perfectly readable plan. Asserting "nonzero" would have called that green.
#
# WHAT THE OVERRIDE CASES PIN. Authorization is an exact SET of ACTION-QUALIFIED
# change TOKENS (`<action>:<address>[#deposed=<key>]`), not a count and not a
# bare address. The semantics are pinned from every direction that could quietly
# degrade:
#   * exact set                        -> pass
#   * same set, reordered + duplicated -> pass  (normalization, not luck)
#   * SAME COUNT, DIFFERENT ADDRESSES  -> FAIL  <- a count-based override cleared
#     this: an authorization issued for two disposable Container Apps gets spent
#     on the Cosmos account and the IoT Hub instead. Pinned in BOTH directions
#     with two fixtures that each destroy exactly two resources.
#   * superset / subset                -> FAIL
#   * plan destroys nothing but a set was authorized -> FAIL (plan changed)
#   * SAME ADDRESS, DIFFERENT ACTION   -> FAIL, both directions. `delete:X` must
#     not authorize `forget:X` and vice versa: destroying a resource and dropping
#     it out of Terraform management are different decisions with different
#     consequences, and approving one is not approving the other.
#   * DEPOSED OBJECTS sharing one address -> each individually enumerated and
#     individually authorizable; an incomplete OR an excessive override FAILS,
#     and every one of those is exit 1, never exit 2.
#   * an UNKNOWN action verb           -> FAIL CLOSED at exit 1 (blocked, and
#     NOT overridable — no in-band authorization exists for a verb the gate does
#     not model) — never ignored, never exit 2. Pinned from three directions: no
#     override, an override naming the unmodeled verb itself, and — the sharper
#     case — a COMPOSITE action list (["delete","obliterate"]) under an override
#     naming the MODELED verb the gate's own paste-ready output would have
#     emitted. Without that third case a fix that only allowlisted the AUTH
#     token's verb would look complete while the composite hole stayed open.
#   * bare count / bare address / all / true / -1 / '*' -> FAIL (no wildcard, no
#     legacy form)
#   * the retired TF_DESTROY_GUARD_EXPECTED_DESTROYS (count) and
#     TF_DESTROY_GUARD_AUTHORIZED_DESTROYS (bare-address) variables -> FAIL
#     loudly, never silently ignored
#
# Exit 0 iff every case behaves as expected under every shell.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="${HERE}/../tf-plan-destroy-guard.sh"

[ -f "${GATE}" ] || { echo "FATAL: gate not found: ${GATE}" >&2; exit 2; }

# The two 2-destroy fixtures. Same arity, disjoint token sets — which is what
# makes the count-vs-set distinction testable rather than merely asserted.
SET_OTLP="delete:module.native_otlp.azurerm_container_app.collector,delete:module.native_otlp.azapi_resource.otlp_dcr"
SET_DATA="delete:module.cosmos_db.azurerm_cosmosdb_account.main,delete:module.iot_hub.azurerm_iothub.main"
SET_OTLP_REORDERED="delete:module.native_otlp.azapi_resource.otlp_dcr, delete:module.native_otlp.azurerm_container_app.collector,delete:module.native_otlp.azapi_resource.otlp_dcr"
SET_OTLP_SUBSET="delete:module.native_otlp.azurerm_container_app.collector"
SET_OTLP_SUPERSET="${SET_OTLP},delete:module.cosmos_db.azurerm_cosmosdb_account.main"
# The SAME addresses as SET_OTLP under the WRONG action qualifier.
SET_OTLP_AS_FORGET="forget:module.native_otlp.azurerm_container_app.collector,forget:module.native_otlp.azapi_resource.otlp_dcr"
# The retired, action-UNqualified form of SET_OTLP.
SET_OTLP_BARE="module.native_otlp.azurerm_container_app.collector,module.native_otlp.azapi_resource.otlp_dcr"

# The three tokens of destroy-guard-deposed.json: one current object and two
# deposed objects, ALL SHARING ONE ADDRESS.
DEP_CUR="delete:module.functions.azurerm_linux_function_app.main"
DEP_A="delete:module.functions.azurerm_linux_function_app.main#deposed=a1b2c3d4"
DEP_B="delete:module.functions.azurerm_linux_function_app.main#deposed=e5f6a7b8"
SET_DEPOSED_ALL="${DEP_CUR},${DEP_A},${DEP_B}"
SET_DEPOSED_INCOMPLETE="${DEP_CUR}"                    # only the current object
SET_DEPOSED_CURRENT_AND_ONE="${DEP_CUR},${DEP_A}"      # one deposed object missed
SET_DEPOSED_EXCESSIVE="${SET_DEPOSED_ALL},delete:module.iot_hub.azurerm_iothub.main"
SET_DEPOSED_ONLY_DEPOSED="${DEP_A},${DEP_B}"           # current object missed

FORGET_COSMOS="forget:module.cosmos_db.azurerm_cosmosdb_account.main"
DELETE_COSMOS="delete:module.cosmos_db.azurerm_cosmosdb_account.main"
UNKNOWN_IOTHUB="obliterate:module.iot_hub.azurerm_iothub.main"
# destroy-guard-unknown-action-composite.json carries actions ["delete","obliterate"]
# on one address. COMPOSITE_AS_MODELED is the token verb precedence would emit for
# it — the one an operator would be handed and would authorize in good faith.
COMPOSITE_AS_MODELED="delete:module.native_otlp.azurerm_container_app.collector"
COMPOSITE_AS_UNMODELED="obliterate:module.native_otlp.azurerm_container_app.collector"

# "<fixture> <expectation> <override>" rows — POSIX-portable, no arrays.
#   expectation: pass | fail | <exact numeric exit code>
#   override:    the TF_DESTROY_GUARD_AUTHORIZED_CHANGES value, or "-" for unset.
CASES="
destroy-guard-noop.json pass -
destroy-guard-create-only.json pass -
destroy-guard-single-destroy.json 1 -
destroy-guard-relocation.json 1 -
destroy-guard-override-match.json 1 -
destroy-guard-override-setdiff.json 1 -
destroy-guard-override-match.json pass ${SET_OTLP}
destroy-guard-override-match.json pass ${SET_OTLP_REORDERED}
destroy-guard-override-setdiff.json pass ${SET_DATA}
destroy-guard-override-match.json 1 ${SET_DATA}
destroy-guard-override-setdiff.json 1 ${SET_OTLP}
destroy-guard-override-match.json 1 ${SET_OTLP_SUBSET}
destroy-guard-override-match.json 1 ${SET_OTLP_SUPERSET}
destroy-guard-override-match.json 1 ${SET_OTLP_AS_FORGET}
destroy-guard-override-match.json 1 ${SET_OTLP_BARE}
destroy-guard-relocation.json 1 ${SET_OTLP}
destroy-guard-noop.json 1 ${SET_OTLP}
destroy-guard-override-match.json 1 2
destroy-guard-override-match.json 1 all
destroy-guard-override-match.json 1 true
destroy-guard-override-match.json 1 -1
destroy-guard-override-match.json 1 *
destroy-guard-deposed.json 1 -
destroy-guard-deposed.json pass ${SET_DEPOSED_ALL}
destroy-guard-deposed.json 1 ${SET_DEPOSED_INCOMPLETE}
destroy-guard-deposed.json 1 ${SET_DEPOSED_CURRENT_AND_ONE}
destroy-guard-deposed.json 1 ${SET_DEPOSED_ONLY_DEPOSED}
destroy-guard-deposed.json 1 ${SET_DEPOSED_EXCESSIVE}
destroy-guard-forget.json 1 -
destroy-guard-forget.json pass ${FORGET_COSMOS}
destroy-guard-forget.json 1 ${DELETE_COSMOS}
destroy-guard-unknown-action.json 1 -
destroy-guard-unknown-action.json 1 ${UNKNOWN_IOTHUB}
destroy-guard-unknown-action-composite.json 1 -
destroy-guard-unknown-action-composite.json 1 ${COMPOSITE_AS_MODELED}
destroy-guard-unknown-action-composite.json 1 ${COMPOSITE_AS_UNMODELED}
destroy-guard-malformed-entry.json 2 -
destroy-guard-malformed-entry.json 2 ${DELETE_COSMOS}
flex-plan-accepted.json 2 -
"
# The last three rows are not typos.
#   flex-plan-accepted.json is a valid `terraform show -json` document with NO
#   resource_changes key (a planned_values-only doc; a post-apply STATE doc has
#   the same shape). The gate must FAIL CLOSED rather than walking zero changes
#   and reporting a vacuous PASS — "I found no destroys" and "I could not look
#   for destroys" must never share an exit code.
#   destroy-guard-malformed-entry.json is the ONE class that legitimately earns
#   exit 2, and it stays 2 even WITH a valid-looking override: an uninspectable
#   document cannot be authorized past, by anyone.

# --- Shell resolution: dash is REQUIRED, not best-effort ---------------------
#
# This block used to read `SHELLS="bash"` and only ADD dash when it happened to
# be installed, falling back to `sh` otherwise. Two defects compounded there, and
# together they made a dash-only regression ship green — precisely the fail-open
# this harness's header says it exists to prevent:
#
#   1. SILENT DEGRADATION. When dash was absent the harness fell back to `sh`,
#      and on many developer machines (and in many containers) /bin/sh IS bash.
#      So "both shells" could be bash twice. The harness printed two reassuring
#      section headers and proved exactly one thing.
#   2. AN AGGREGATE FLOOR. The final guard was `[ "${checks}" -lt 41 ]` against a
#      TOTAL that summed every shell. One shell running its full ~42 checks
#      satisfied it on its own, so a second shell that ran ZERO rows — or was
#      never run at all — was indistinguishable from one that ran them all.
#
# Neither fix works alone: requiring dash without making the count per-shell
# still passes if dash runs zero rows, and per-shell counts without requiring
# dash still passes when dash was never resolved. Both are fixed below.
#
# The opt-out exists for local development on a machine without dash. It is
# LOUD, and it must never be set in CI — ci.yml deliberately does not set it.
BASH_BIN="$(command -v bash 2>/dev/null || true)"
DASH_BIN="$(command -v dash 2>/dev/null || true)"

[ -n "${BASH_BIN}" ] || {
  echo "run-destroy-guard-fixtures: FATAL: bash not found on PATH" >&2
  exit 2
}

if [ -n "${DASH_BIN}" ]; then
  SHELL_NAMES="bash dash"
  EXPECTED_SHELLS=2
elif [ "${DESTROY_GUARD_ALLOW_SINGLE_SHELL:-0}" = "1" ]; then
  echo "!!!===================================================================!!!" >&2
  echo "!!! run-destroy-guard-fixtures: SINGLE-SHELL MODE — dash NOT FOUND    !!!" >&2
  echo "!!! DESTROY_GUARD_ALLOW_SINGLE_SHELL=1 is set, so the harness will    !!!" >&2
  echo "!!! run under bash ONLY. The dash portability contract is NOT being   !!!" >&2
  echo "!!! verified: a gate that errors under dash while still reaching a    !!!" >&2
  echo "!!! PASS is fail-open, and this run cannot detect that. Local use     !!!" >&2
  echo "!!! only — this variable MUST NOT be set in CI.                       !!!" >&2
  echo "!!!===================================================================!!!" >&2
  SHELL_NAMES="bash"
  EXPECTED_SHELLS=1
else
  echo "run-destroy-guard-fixtures: FATAL: dash NOT FOUND on PATH." >&2
  echo "  The destroy circuit-breaker must be proven under dash as well as bash:" >&2
  echo "  the ubuntu-latest runner's /bin/sh is dash, and a gate that ERRORS under" >&2
  echo "  dash while the caller still reaches a PASS is FAIL-OPEN." >&2
  echo "  Install dash (apt-get install dash), or — for LOCAL development only —" >&2
  echo "  re-run with DESTROY_GUARD_ALLOW_SINGLE_SHELL=1 to accept a bash-only run." >&2
  exit 2
fi

CASEFILE="$(mktemp)"
OUTFILE="$(mktemp)"
# shellcheck disable=SC2064
trap "rm -f '${CASEFILE}' '${OUTFILE}'" EXIT INT TERM

printf '%s\n' "${CASES}" | grep -v '^[[:space:]]*$' | grep -v '^#' > "${CASEFILE}"

failures=0          # across every shell
checks_total=0      # across every shell
shells_run=0
checks=0            # PER SHELL — reset at the top of each shell's pass
failures_shell=0    # PER SHELL — so a dash-only regression is attributable
SHELL_LABEL=""      # name of the shell currently under test, for messages
SUMMARY=""          # "<shell> <passed>/<ran>" per shell, printed at the end

# Record a failure against BOTH the global tally and the current shell's, so the
# final report can say WHICH shell broke. A gate that regresses only under dash
# is the whole reason this harness exists; "3 checks failed" with no shell
# attribution would send the reader looking in the wrong place.
note_failure() {
  failures=$((failures + 1))
  failures_shell=$((failures_shell + 1))
}

# Assert one gate invocation. $1=shell $2=fixture path $3=pass|fail|<code> $4=label
run_case() {
  _shell="$1"; _path="$2"; _expect="$3"; _label="[${SHELL_LABEL}] $4"
  if "${_shell}" "${GATE}" "${_path}" >"${OUTFILE}" 2>&1; then
    _code=0
  else
    _code=$?
  fi
  case "${_expect}" in
    pass)
      if [ "${_code}" -eq 0 ]; then
        echo "  ✓ ${_label}: exit 0 as expected"
      else
        echo "  ✗ ${_label}: expected exit 0, got ${_code}" >&2
        sed 's/^/      /' "${OUTFILE}" >&2
        note_failure
      fi
      ;;
    fail)
      if [ "${_code}" -ne 0 ]; then
        echo "  ✓ ${_label}: nonzero (${_code}) as expected (fail-closed)"
      else
        echo "  ✗ ${_label}: expected nonzero, got 0 — FAIL-OPEN" >&2
        sed 's/^/      /' "${OUTFILE}" >&2
        note_failure
      fi
      ;;
    *)
      # An EXACT code. This is where the 1-vs-2 contract is enforced: a "verdict"
      # case that drifts to 2 is unreachable by the override and silently wedges
      # the recovery path, and an "uninspectable" case that drifts to 1 claims a
      # verdict the gate had no basis to reach.
      if [ "${_code}" -eq "${_expect}" ]; then
        echo "  ✓ ${_label}: exit ${_code} exactly as expected"
      else
        echo "  ✗ ${_label}: expected EXACT exit ${_expect}, got ${_code}" >&2
        if [ "${_expect}" = "1" ] && [ "${_code}" = "2" ]; then
          echo "      (exit 2 happens BEFORE the verdict section — no override can clear it," >&2
          echo "       so this wedges the GitOps loop with no in-band recovery path)" >&2
        fi
        sed 's/^/      /' "${OUTFILE}" >&2
        note_failure
      fi
      ;;
  esac
}

for shell_name in ${SHELL_NAMES}; do
  # Resolve the NAME to the absolute binary resolved up front. The section header
  # prints the short name so it stays greppable and readable.
  case "${shell_name}" in
    bash) shell="${BASH_BIN}" ;;
    dash) shell="${DASH_BIN}" ;;
    *)    echo "run-destroy-guard-fixtures: FATAL: unknown shell '${shell_name}'" >&2; exit 2 ;;
  esac
  SHELL_LABEL="${shell_name}"
  # PER-SHELL counters, reset here. The old code summed one `checks` across every
  # shell, so a shell that ran zero rows was invisible behind another that ran
  # them all.
  checks=0
  failures_shell=0
  echo "== running destroy-guard fixtures under: ${shell_name} =="
  echo "   (${shell})"
  # `done < file` (no pipe) keeps the loop in THIS shell so the counters survive.
  while read -r fixture expect override; do
    [ -z "${fixture}" ] && continue
    path="${HERE}/${fixture}"
    checks=$((checks + 1))

    if [ ! -f "${path}" ]; then
      echo "  ✗ [${SHELL_LABEL}] ${fixture}: fixture file missing" >&2
      note_failure
      continue
    fi

    if [ "${override}" = "-" ]; then
      label="${fixture} (no override)"
      unset TF_DESTROY_GUARD_AUTHORIZED_CHANGES
    else
      label="${fixture} (authorized=${override})"
      TF_DESTROY_GUARD_AUTHORIZED_CHANGES="${override}"
      export TF_DESTROY_GUARD_AUTHORIZED_CHANGES
    fi

    run_case "${shell}" "${path}" "${expect}" "${label}"
    unset TF_DESTROY_GUARD_AUTHORIZED_CHANGES
  done < "${CASEFILE}"

  # RETIRED VARIABLES MUST BE REFUSED LOUDLY, NOT IGNORED. Ignoring one leaves an
  # operator believing they authorized a change while the gate behaves as if
  # nothing was authorized — and lets a stale name linger in a workflow long
  # enough to look supported.
  checks=$((checks + 1))
  TF_DESTROY_GUARD_EXPECTED_DESTROYS=2
  export TF_DESTROY_GUARD_EXPECTED_DESTROYS
  run_case "${shell}" "${HERE}/destroy-guard-override-match.json" 1 \
    "destroy-guard-override-match.json (retired TF_DESTROY_GUARD_EXPECTED_DESTROYS=2)"
  unset TF_DESTROY_GUARD_EXPECTED_DESTROYS

  # ...and it must still be refused even when the correct SET is also supplied:
  # the retired variable is rejected on sight, never silently superseded.
  checks=$((checks + 1))
  TF_DESTROY_GUARD_EXPECTED_DESTROYS=2
  TF_DESTROY_GUARD_AUTHORIZED_CHANGES="${SET_OTLP}"
  export TF_DESTROY_GUARD_EXPECTED_DESTROYS TF_DESTROY_GUARD_AUTHORIZED_CHANGES
  run_case "${shell}" "${HERE}/destroy-guard-override-match.json" 1 \
    "destroy-guard-override-match.json (retired count var alongside a valid set)"
  unset TF_DESTROY_GUARD_EXPECTED_DESTROYS TF_DESTROY_GUARD_AUTHORIZED_CHANGES

  # The action-UNQUALIFIED predecessor variable is retired the same way. Silently
  # ignoring it would be the worst option available: it named real addresses, so
  # an operator would reasonably believe a destroy was authorized.
  checks=$((checks + 1))
  TF_DESTROY_GUARD_AUTHORIZED_DESTROYS="${SET_OTLP_BARE}"
  export TF_DESTROY_GUARD_AUTHORIZED_DESTROYS
  run_case "${shell}" "${HERE}/destroy-guard-override-match.json" 1 \
    "destroy-guard-override-match.json (retired TF_DESTROY_GUARD_AUTHORIZED_DESTROYS)"
  unset TF_DESTROY_GUARD_AUTHORIZED_DESTROYS

  # ...including on a plan it would otherwise have matched exactly, and even
  # alongside the correct new-form set: rejected on sight, never superseded.
  checks=$((checks + 1))
  TF_DESTROY_GUARD_AUTHORIZED_DESTROYS="${SET_OTLP_BARE}"
  TF_DESTROY_GUARD_AUTHORIZED_CHANGES="${SET_OTLP}"
  export TF_DESTROY_GUARD_AUTHORIZED_DESTROYS TF_DESTROY_GUARD_AUTHORIZED_CHANGES
  run_case "${shell}" "${HERE}/destroy-guard-override-match.json" 1 \
    "destroy-guard-override-match.json (retired address var alongside a valid token set)"
  unset TF_DESTROY_GUARD_AUTHORIZED_DESTROYS TF_DESTROY_GUARD_AUTHORIZED_CHANGES

  # An override that normalizes to nothing is a malformed instruction, not a
  # request to authorize nothing — it must not be downgraded to "unset".
  checks=$((checks + 1))
  TF_DESTROY_GUARD_AUTHORIZED_CHANGES="   ,  , "
  export TF_DESTROY_GUARD_AUTHORIZED_CHANGES
  run_case "${shell}" "${HERE}/destroy-guard-override-match.json" 1 \
    "destroy-guard-override-match.json (override normalizes to an empty set)"
  unset TF_DESTROY_GUARD_AUTHORIZED_CHANGES

  # --- end of this shell's pass: bank the per-shell numbers ------------------
  shells_run=$((shells_run + 1))
  checks_total=$((checks_total + checks))
  # Named per-shell counters, so the contract is legible in the source and not
  # only in the printed summary.
  case "${shell_name}" in
    bash) checks_bash="${checks}"; failures_bash="${failures_shell}" ;;
    dash) checks_dash="${checks}"; failures_dash="${failures_shell}" ;;
  esac
  SUMMARY="${SUMMARY}${SUMMARY:+, }${shell_name} $((checks - failures_shell))/${checks}"
  if [ "${failures_shell}" -ne 0 ]; then
    echo "  -- ${shell_name}: ${failures_shell} of ${checks} checks FAILED under this shell" >&2
  else
    echo "  -- ${shell_name}: ${checks}/${checks} checks behaved as expected"
  fi
done

echo
# Per-shell summary, so both runs are observable in the CI log rather than
# inferred from a single aggregate number.
echo "run-destroy-guard-fixtures: ${SUMMARY}"

# --- Verdict -----------------------------------------------------------------
# Four independent assertions. Each closes a distinct way this harness could
# report green while having proven less than it claims.

# 1. Both shells actually RAN. Catches a resolution bug or a degraded fallback.
if [ "${shells_run}" -ne "${EXPECTED_SHELLS}" ]; then
  echo "run-destroy-guard-fixtures: FAILED — ${shells_run} shell(s) ran, expected ${EXPECTED_SHELLS}." >&2
  exit 1
fi

# 2. EACH shell independently met the floor. The old aggregate floor was
#    satisfied by one shell's full pass, so a second shell running zero rows
#    looked identical to one running all of them.
# The EXACT per-shell count: every row in CASES plus the five retired-variable /
# empty-override checks appended after the loop. It is raised in lockstep with
# the case table on purpose — a floor left trailing the table stops detecting a
# dropped row, which is the only thing it exists to detect.
MIN_CHECKS_PER_SHELL=44
for shell_name in ${SHELL_NAMES}; do
  case "${shell_name}" in
    bash) _c="${checks_bash:-0}" ;;
    dash) _c="${checks_dash:-0}" ;;
  esac
  if [ "${_c}" -lt "${MIN_CHECKS_PER_SHELL}" ]; then
    echo "run-destroy-guard-fixtures: FAILED — ${shell_name} ran only ${_c} checks (floor ${MIN_CHECKS_PER_SHELL}); the case table was not exercised under that shell." >&2
    exit 1
  fi
done

# 3. The shells ran the SAME number of checks. A shell that skipped rows is as
#    bad as one that never ran — and only a cross-shell comparison catches it.
if [ "${EXPECTED_SHELLS}" -eq 2 ] && [ "${checks_bash:-0}" -ne "${checks_dash:-0}" ]; then
  echo "run-destroy-guard-fixtures: FAILED — bash ran ${checks_bash:-0} checks but dash ran ${checks_dash:-0}; the two shells did not exercise the same case table." >&2
  exit 1
fi

# 4. Nothing failed — reported WITH the shell attribution gathered above.
if [ "${failures}" -ne 0 ]; then
  echo "run-destroy-guard-fixtures: FAILED — ${failures} of ${checks_total} checks did not behave as expected." >&2
  [ "${failures_bash:-0}" -ne 0 ] && echo "  bash: ${failures_bash} failure(s)" >&2
  [ "${failures_dash:-0}" -ne 0 ] && echo "  dash: ${failures_dash} failure(s) — the gate regresses under dash, which is /bin/sh on the CI runner" >&2
  exit 1
fi

echo "run-destroy-guard-fixtures: all ${checks_total} checks behaved as expected across ${shells_run} shell(s)."
exit 0
