#!/usr/bin/env bash
#
# run-cosmos-definition-parity-fixtures.sh — deterministic, credential-less
# regression harness for the fail-closed definition-parity gate (MG-53, step 3:
# scripts/cosmos-definition-parity.sh).
#
# Exercises the gate against committed canonical `az cosmosdb sql container show`
# documents next to this script and asserts each expected EXIT CODE exactly. No
# Azure, no credentials, no `az`, no `terraform` — the gate consumes two
# container-show documents, and every fixture here IS one. This is the in-repo
# proof that the parity gate stays fail-closed and definition-faithful; the live
# read-back comparison it models is an operator-phase step (MG-53 runs in a
# container with no Azure creds).
#
# WHAT THE GATE PROMISES, AND HOW EACH PROMISE IS PINNED HERE.
#   * PASS (exit 0) only when two container definitions AGREE on every scoped
#     field — partition key, indexing policy (mode + included/excluded/composite),
#     default TTL, unique keys, conflict-resolution policy. The matching pair
#     proves this, and it is deliberately NOT byte-identical (reordered composite
#     indexes, deep-reordered keys, different system fields) so the PASS exercises
#     the gate's normalisation rather than a string compare (the [normalize] case
#     asserts that non-identity lexically).
#   * DIFF (exit 3) — a real, provable definition drift — on any single scoped
#     field. One committed fixture per scoped field, each a ONE-FIELD mutation of
#     the matching source, and each asserted to NAME its differing field on the
#     gate's output. A distinct code from operational failure so the caller
#     (assert-live-shared-throughput.sh, step 4) can tell a schema drift apart
#     from "I could not tell".
#   * THROUGHPUT IS OUT OF SCOPE. The throughput-only pair differs only in
#     out-of-scope material (a top-level throughput hint, the non-scoped indexing
#     `automatic` flag, system fields) and MUST still PASS. Its PASS is proven
#     non-vacuous by the [defang] case: inject a REAL scoped diff into that pair
#     at run time and the gate must flip to exit 3 — so the exit-0 depends on the
#     scoped fields agreeing, not on the gate ignoring everything.
#   * FAIL-CLOSED (exit 1) on anything that prevented the comparison from provably
#     running — empty, invalid, wrong-shape, or an input missing `.resource`, and
#     the both-stdin misuse. "Cannot tell" is never reported as "no difference".
#
# DUAL SHELL is a SECURITY property, not a style one: a gate that ERRORs under one
# shell while reaching a verdict under another is fail-open, and this repo has
# shipped exactly that bug (a bash-4-only ${1,,}). Every case runs under BOTH bash
# and sh, per-shell counts are tracked against a floor, and the per-shell counts
# must be EQUAL — a harness that silently runs fewer cases than it advertises is
# the same fail-open class as the gate holes it exists to catch.
#
# Exit 0 iff every case behaves as expected under every shell AND the counts hold.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="${HERE}/../cosmos-definition-parity.sh"

[ -f "${GATE}" ] || { echo "FATAL: gate not found: ${GATE}" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq is required by this harness (and by the gate)" >&2; exit 2; }

# Committed fixtures. Every one is a canonical container-show document.
MATCH_SRC="${HERE}/cosmos-parity-match-source.json"
MATCH_DST="${HERE}/cosmos-parity-match-destination.json"
TP_SRC="${HERE}/cosmos-parity-throughput-only-source.json"
TP_DST="${HERE}/cosmos-parity-throughput-only-destination.json"
DIFF_PK="${HERE}/cosmos-parity-diff-partition-key.json"
DIFF_EXCL="${HERE}/cosmos-parity-diff-excluded-path.json"
DIFF_COMP="${HERE}/cosmos-parity-diff-composite-index.json"
DIFF_TTL="${HERE}/cosmos-parity-diff-ttl.json"
DIFF_UK="${HERE}/cosmos-parity-diff-unique-key.json"

for required in "${MATCH_SRC}" "${MATCH_DST}" "${TP_SRC}" "${TP_DST}" \
                "${DIFF_PK}" "${DIFF_EXCL}" "${DIFF_COMP}" "${DIFF_TTL}" "${DIFF_UK}"; do
  [ -f "${required}" ] || { echo "FATAL: required fixture missing: ${required}" >&2; exit 2; }
done

# The gate's exit-code contract, spelled out once so the assertions read clearly.
EX_PASS=0
EX_OP=1
EX_DIFF=3

# Committed table cases: "<src-basename> <dst-basename> <expected-exit> <field>".
# field is the scoped-field TOKEN the gate must NAME on a DIFF, or "-" when the
# case is a PASS. POSIX-portable, no arrays.
CASES="
cosmos-parity-match-source.json cosmos-parity-match-destination.json 0 -
cosmos-parity-throughput-only-source.json cosmos-parity-throughput-only-destination.json 0 -
cosmos-parity-match-source.json cosmos-parity-diff-partition-key.json 3 partition_key
cosmos-parity-match-source.json cosmos-parity-diff-excluded-path.json 3 excluded_paths
cosmos-parity-match-source.json cosmos-parity-diff-composite-index.json 3 composite_indexes
cosmos-parity-match-source.json cosmos-parity-diff-ttl.json 3 default_ttl
cosmos-parity-match-source.json cosmos-parity-diff-unique-key.json 3 unique_keys
"

# 7 table cases + 1 stdin case + 1 derived conflict-policy diff
# + 6 structural fail-closed cases + 1 [normalize] control + 1 [defang] control.
# Raise this floor whenever a case is added, so the harness cannot quietly run
# fewer than it advertises.
MIN_CHECKS_PER_SHELL=17

# Resolve each shell to an ABSOLUTE path.
SHELL_BINS=""
for cand in bash sh; do
  p="$(command -v "${cand}" 2>/dev/null || true)"
  [ -n "${p}" ] && SHELL_BINS="${SHELL_BINS} ${p}"
done
[ -n "${SHELL_BINS}" ] || { echo "FATAL: no shell found to run the gate under" >&2; exit 2; }

WORK="$(mktemp -d)" || { echo "FATAL: mktemp -d failed" >&2; exit 2; }
trap 'rm -rf "${WORK}"' EXIT HUP INT TERM
CASES_FILE="${WORK}/cases"
printf '%s\n' "${CASES}" | grep -v '^[[:space:]]*$' > "${CASES_FILE}"
OUT="${WORK}/out"

# --- Run-time derived documents ---------------------------------------------
# A conflict-resolution-policy DIFF, derived from the matching source so it can
# only ever differ from it in the one field this case is about. The gate has no
# committed fixture for this field (the plan's committed set covers the other
# five); deriving keeps the pair a genuine one-field mutation.
CONFLICT_DST="${WORK}/diff-conflict-policy.json"
jq '.resource.conflictResolutionPolicy.mode = "Custom"
    | .resource.conflictResolutionPolicy.conflictResolutionProcedure = "dbs/x/colls/y/sprocs/resolver"
    | .resource.conflictResolutionPolicy.conflictResolutionPath = ""' \
   "${MATCH_SRC}" > "${CONFLICT_DST}" || { echo "FATAL: could not derive the conflict-policy diff" >&2; exit 2; }

# Structural fail-closed inputs. Each parses as far as its own class allows and
# would let a comparison run against nothing if the gate were not fail-closed.
EMPTY_FILE="${WORK}/empty.json"
: > "${EMPTY_FILE}"
INVALID="${WORK}/invalid.json"
printf '%s\n' '{ "resource": ' > "${INVALID}"
WRONGTYPE="${WORK}/wrong-top-level-type.json"
printf '%s\n' '[]' > "${WRONGTYPE}"
NO_RESOURCE="${WORK}/no-resource.json"
printf '%s\n' '{ "id": "temperatures" }' > "${NO_RESOURCE}"

# The [defang] control target: the throughput-only DESTINATION with a REAL scoped
# diff injected (partition key moved off /deviceId). Compared against the
# throughput-only SOURCE, the gate must now DIFF — proving that pair's PASS is a
# property of the scoped fields agreeing, not of the gate ignoring them.
DEFANGED_TP="${WORK}/throughput-only-destination-defanged.json"
jq '.resource.partitionKey.paths = ["/id"]' "${TP_DST}" > "${DEFANGED_TP}" \
  || { echo "FATAL: could not derive the defanged throughput-only control" >&2; exit 2; }

# Report what `sh` actually resolves to. On many systems /bin/sh IS bash, in which
# case "both shells" is bash twice and the dash-portability property is NOT tested.
# Stated rather than silently laundered.
sh_target="$(readlink -f /bin/sh 2>/dev/null || echo unknown)"
echo "run-cosmos-definition-parity-fixtures: /bin/sh resolves to ${sh_target}"
case "${sh_target}" in
  *bash*) echo "  NOTE: /bin/sh is bash on this host — the dash-portability leg is NOT exercised here." ;;
esac
echo

failures=0
shells_run=0
counts=""

# assert_code <label> <expected> <actual>
# Shared exit-code reporting. Reads/writes the enclosing shell's counters, so it
# must never be called from a subshell or a pipeline.
assert_code() {
  ac_label="$1"; ac_expect="$2"; ac_actual="$3"
  if [ "${ac_actual}" -eq "${ac_expect}" ]; then
    echo "  ✓ ${ac_label}: exit ${ac_actual} as expected"
    return 0
  fi
  echo "  ✗ ${ac_label}: expected exit ${ac_expect}, got ${ac_actual}" >&2
  if [ "${ac_expect}" -ne 0 ] && [ "${ac_actual}" -eq 0 ]; then
    echo "      FAIL-OPEN: the gate reported PARITY on a comparison it must not have passed." >&2
  fi
  sed 's/^/      /' "${OUT}" >&2
  failures=$((failures + 1))
  return 1
}

for shell_bin in ${SHELL_BINS}; do
  echo "== running fixtures under: ${shell_bin} =="
  checks=0
  failures_before=${failures}

  # Read with `< file` (not a pipe) so the loop runs in THIS shell and the
  # counters survive. A piped `while` runs in a subshell under dash and would
  # silently discard every count — exactly the miscount the floor detects.
  while IFS=' ' read -r src dst expect field; do
    [ -z "${src}" ] && continue
    checks=$((checks + 1))
    "${shell_bin}" "${GATE}" --source "${HERE}/${src}" --destination "${HERE}/${dst}" --label temperatures >"${OUT}" 2>&1
    code=$?
    if assert_code "${src} -> ${dst}" "${expect}" "${code}"; then
      # On a DIFF the gate must NAME the differing scoped field. A gate that
      # reached exit 3 but named nothing (or the wrong field) is not the recorded
      # comparison the brief requires.
      if [ "${expect}" -eq "${EX_DIFF}" ] && [ "${field}" != "-" ]; then
        if grep -q "DIFF \[${field}\]" "${OUT}"; then
          echo "    · named the differing field '${field}'"
        else
          echo "  ✗ ${src} -> ${dst}: exit 3 but did NOT name the expected field '${field}'" >&2
          sed 's/^/      /' "${OUT}" >&2
          failures=$((failures + 1))
        fi
      fi
    fi
  done < "${CASES_FILE}"

  # --- STDIN case -------------------------------------------------------------
  # The gate accepts ONE document on stdin via `-`. The operator reads a live
  # container-show straight into it, so the stdin path must reach the same verdict
  # as the file path. Source on stdin, destination as a file, matching pair => 0.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --source - --destination "${MATCH_DST}" --label temperatures <"${MATCH_SRC}" >"${OUT}" 2>&1
  assert_code "[stdin] match-source(-) vs match-destination" "${EX_PASS}" "$?"

  # --- DERIVED conflict-policy DIFF ------------------------------------------
  # The sixth scoped field has no committed fixture (the plan's set covers the
  # other five); this derived one-field mutation closes it. Must DIFF and NAME
  # conflict_resolution_policy.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --source "${MATCH_SRC}" --destination "${CONFLICT_DST}" --label temperatures >"${OUT}" 2>&1
  code=$?
  if assert_code "[derived] conflict-policy diff" "${EX_DIFF}" "${code}"; then
    if grep -q "DIFF \[conflict_resolution_policy\]" "${OUT}"; then
      echo "    · named the differing field 'conflict_resolution_policy'"
    else
      echo "  ✗ [derived] conflict-policy diff: exit 3 but did NOT name conflict_resolution_policy" >&2
      sed 's/^/      /' "${OUT}" >&2
      failures=$((failures + 1))
    fi
  fi

  # --- STRUCTURAL fail-closed cases ------------------------------------------
  # "Cannot tell" is never "nothing to see". Each parses far enough to reach the
  # extractors, which would yield defaulted-empty values on both sides and trip a
  # vacuous PASS if the gate were not fail-closed. The bad document is placed in
  # BOTH the source and (once) the destination slot; the OTHER slot is a valid
  # fixture so the nonzero can only be about the bad one. Expect exit 1 + FATAL.
  for probe in \
      "empty-source ${EMPTY_FILE} ${MATCH_DST}" \
      "invalid-json-source ${INVALID} ${MATCH_DST}" \
      "wrong-top-level-type-source ${WRONGTYPE} ${MATCH_DST}" \
      "no-resource-source ${NO_RESOURCE} ${MATCH_DST}" \
      "empty-destination ${MATCH_SRC} ${EMPTY_FILE}"; do
    # Split the 3 space-separated fields by value (no arrays, no ${!arr[@]}).
    p_label="${probe%% *}"; rest="${probe#* }"
    p_src="${rest%% *}"; p_dst="${rest#* }"
    checks=$((checks + 1))
    "${shell_bin}" "${GATE}" --source "${p_src}" --destination "${p_dst}" --label temperatures >"${OUT}" 2>&1
    code=$?
    if [ "${code}" -eq "${EX_OP}" ] && grep -q "FATAL" "${OUT}"; then
      echo "  ✓ [structural] ${p_label}: exit 1 with a FATAL — fail-closed"
    else
      echo "  ✗ [structural] ${p_label}: expected exit 1 with a FATAL, got ${code}" >&2
      sed 's/^/      /' "${OUT}" >&2
      failures=$((failures + 1))
    fi
  done

  # The both-stdin misuse: only one document can come from stdin. Must fail closed
  # (exit 1) rather than silently read one and compare it against itself.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --source - --destination - --label temperatures </dev/null >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -eq "${EX_OP}" ] && grep -q "FATAL" "${OUT}"; then
    echo "  ✓ [structural] both-stdin: exit 1 with a FATAL — fail-closed"
  else
    echo "  ✗ [structural] both-stdin: expected exit 1 with a FATAL, got ${code}" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi

  # --- NORMALIZE control ------------------------------------------------------
  # Asserted LEXICALLY, because an exit code cannot see it. The matching pair's
  # PASS is only meaningful if the two documents are NOT byte-identical — else the
  # gate could be a plain string compare and the normalisation (composite-index
  # set order, deep key order, system fields) would be untested. If someone
  # "simplifies" match-destination into a copy of match-source, this turns red
  # before the exit code stays green for the wrong reason.
  checks=$((checks + 1))
  src_norm="$(jq -S . "${MATCH_SRC}" 2>/dev/null)"
  dst_norm="$(jq -S . "${MATCH_DST}" 2>/dev/null)"
  if [ -z "${src_norm}" ] || [ -z "${dst_norm}" ]; then
    echo "  ✗ [normalize] a matching-pair fixture is not parseable JSON" >&2
    failures=$((failures + 1))
  elif [ "${src_norm}" = "${dst_norm}" ]; then
    echo "  ✗ [normalize] match-source and match-destination are byte-identical (after key sort) — the matching PASS no longer exercises the gate's normalisation" >&2
    failures=$((failures + 1))
  else
    echo "  ✓ [normalize] the matching pair differs in ordering/system fields yet passes — the PASS exercises normalisation, not string equality"
  fi

  # --- DEFANG control ---------------------------------------------------------
  # The throughput-only pair's PASS must depend on the scoped fields agreeing.
  # Inject a REAL scoped diff (partition key off /deviceId) into that pair and the
  # gate must flip from PASS to DIFF. Without this, a gate that had stopped
  # comparing scoped fields altogether would keep the throughput-only row green.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --source "${TP_SRC}" --destination "${DEFANGED_TP}" --label temperatures >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -eq "${EX_DIFF}" ] && grep -q "DIFF \[partition_key\]" "${OUT}"; then
    echo "  ✓ [defang] injecting a real scoped diff into the throughput-only pair flips it to exit 3 — its PASS is non-vacuous"
  else
    echo "  ✗ [defang] expected exit 3 naming partition_key when the throughput-only pair gains a real diff, got ${code} — the throughput-only PASS may not depend on any comparison" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi

  echo "  -- ${shell_bin}: ${checks} checks"
  # Name the shell on STDERR too: every ✗ goes to stderr while the header goes to
  # stdout, so a consumer capturing the streams separately can still attribute a
  # failed case to a shell.
  if [ "${failures}" -ne "${failures_before}" ]; then
    echo "  ✗ ${shell_bin}: $((failures - failures_before)) case(s) above failed under THIS shell" >&2
  fi
  if [ "${checks}" -lt "${MIN_CHECKS_PER_SHELL}" ]; then
    echo "  ✗ ${shell_bin}: ran ${checks} checks, floor is ${MIN_CHECKS_PER_SHELL} — the harness silently ran fewer cases than it advertises" >&2
    failures=$((failures + 1))
  fi
  shells_run=$((shells_run + 1))
  counts="${counts} ${shell_bin}=${checks}"
done

echo
echo "run-cosmos-definition-parity-fixtures: shells_run=${shells_run}, per-shell checks:${counts}"

distinct="$(for c in ${counts}; do echo "${c##*=}"; done | sort -u | wc -l)"
if [ "${shells_run}" -lt 2 ]; then
  echo "run-cosmos-definition-parity-fixtures: FAILED — only ${shells_run} shell(s) ran; the dual-shell contract was not exercised" >&2
  exit 1
fi
if [ "${distinct}" -ne 1 ]; then
  echo "run-cosmos-definition-parity-fixtures: FAILED — per-shell check counts differ (${counts}); a shell skipped rows" >&2
  exit 1
fi

if [ "${failures}" -ne 0 ]; then
  echo "run-cosmos-definition-parity-fixtures: FAILED — ${failures} case(s) did not behave as expected" >&2
  exit 1
fi
echo "run-cosmos-definition-parity-fixtures: all fixtures behaved as expected under every shell."
exit 0
