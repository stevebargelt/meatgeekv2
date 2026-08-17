#!/usr/bin/env bash
#
# run-assert-live-shared-throughput-fixtures.sh — deterministic, credential-less
# regression harness for the fail-closed post-create assertion gate (MG-53,
# step 4: scripts/assert-live-shared-throughput.sh).
#
# Exercises the gate against committed "read-back bundle" documents next to this
# script and asserts each expected EXIT CODE exactly. No Azure, no credentials,
# no `az`, no `terraform` — the gate consumes ONE bundle assembled by an operator
# from the live `az cosmosdb sql database/container ...` read-backs, and every
# fixture here IS one (or a run-time one-field mutation of one). This is the
# in-repo proof that the gate stays fail-closed; the live read-back assertion it
# models is an operator-phase step (MG-53 runs in a container with no Azure creds).
#
# WHAT THE GATE PROMISES, AND HOW EACH PROMISE IS PINNED HERE.
#   * PASS (exit 0) only when ALL FOUR assertions provably ran and held: a manual
#     400 RU/s DATABASE-level offer exists, NO destination container holds a
#     dedicated offer, temperatures is on /deviceId, and all five destination
#     definitions are faithful to their source (via the step-3 parity script). The
#     clean bundle proves this.
#   * VIOLATION (exit 3) — a real, provable defect in the destination — on any
#     single failing assertion: an absent database-level offer, a container holding
#     a dedicated offer, a mis-partitioned temperatures container, or a definition
#     drift. One committed fixture per headline defect, each a ONE-FIELD mutation of
#     its named clean counterpart (proven by the [pair] cases below), plus run-time
#     derived controls for the autoscale/wrong-RU/definition-drift variants. Each is
#     asserted to NAME its violating subject on the gate's output. A distinct code
#     from operational failure so the CI/apply caller can tell a genuine destination
#     defect apart from "I could not tell".
#   * FAIL-CLOSED (exit 1) on anything that prevented an assertion from provably
#     running — a probe that could not run (queryOk=false), a missing/empty/invalid/
#     wrong-shape bundle, a bundle not carrying EXACTLY the five destination
#     containers, a malformed container entry, a bad --expected-throughput, or a
#     --database-name mismatch. "Cannot tell" is NEVER reported as "nothing wrong".
#
# THE PAIRS ARE PROVEN BY MUTATION, NOT BY ASSERTION. Each violation fixture and
# its clean counterpart differ by EXACTLY ONE field, machine-checked below (the
# [pair] cases), not merely claimed in a comment. A fixture edit that defangs
# either end of a pair — deletes the mutation from a violation file, or lets a
# scoped defect leak into a clean file — turns the [pair] or [shape] case red
# BEFORE any exit code changes, which is the point: an exit code cannot detect a
# control that has quietly stopped controlling anything (a healthy destination is
# exactly what a PASS looks like). Same precedent as run-live-host-storage and
# run-cosmos-definition-parity.
#
# EXIT CODES ARE ASSERTED EXACTLY, not merely as pass/nonzero. The CI gate / apply
# job keys off the distinction: 3 means "the destination is provably wrong, stop
# and surface the named defect" while 1 means "an assertion could not run, this is
# an environment/assembly problem". A harness that accepted any nonzero would let 3
# and 1 swap without noticing.
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
GATE="${HERE}/../assert-live-shared-throughput.sh"
PARITY="${HERE}/../cosmos-definition-parity.sh"

[ -f "${GATE}" ] || { echo "FATAL: gate not found: ${GATE}" >&2; exit 2; }
# The gate invokes the parity comparator for assertion (d); if it were absent the
# gate would fail closed on EVERY bundle and this harness would be testing nothing.
[ -f "${PARITY}" ] || { echo "FATAL: parity comparator (step 3) not found next to the gate: ${PARITY}" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq is required by this harness (and by the gate)" >&2; exit 2; }

# Committed fixtures. Every one is a full read-back bundle.
#   present / no-offer / deviceid — three byte-identical CLEAN baselines, one per
#     violation dimension. Each is the paired positive control for its dimension;
#     the [shape] case asserts they stay identical so a clean file cannot silently
#     drift into carrying a defect (which would make a PASS meaningless).
#   absent / dedicated-offer / mispartitioned — the three headline VIOLATION
#     controls, each a one-field mutation of its clean counterpart (see [pair]).
PRESENT="${HERE}/shared-throughput-db-offer-present.json"
NO_OFFER="${HERE}/shared-throughput-container-no-offer.json"
DEVICEID="${HERE}/shared-throughput-temperatures-deviceid.json"
DB_ABSENT="${HERE}/shared-throughput-db-offer-absent.json"
DEDICATED="${HERE}/shared-throughput-container-dedicated-offer.json"
MISPART="${HERE}/shared-throughput-temperatures-mispartitioned.json"

for required in "${PRESENT}" "${NO_OFFER}" "${DEVICEID}" \
                "${DB_ABSENT}" "${DEDICATED}" "${MISPART}"; do
  [ -f "${required}" ] || { echo "FATAL: required fixture missing: ${required}" >&2; exit 2; }
done

# The gate's exit-code contract, spelled out once so the assertions read clearly.
EX_PASS=0
EX_OP=1
EX_VIOLATION=3

# The container carrying a dedicated offer in the dedicated-offer fixture, and the
# expected shared offer RU/s. Named once so the [pair]/[shape] checks stay in sync
# with the fixtures.
DEDICATED_CONTAINER="recipes"
EXPECTED_RU="400"
DB_NAME="meatgeek-v2-dev-shared-db"

# Committed table cases: "<fixture-var-name> <expected-exit> <mode> <subject>".
# subject is the "VIOLATION [<subject>]" token the gate must NAME on a violation,
# or "-" when the case is a PASS. POSIX-portable, no arrays.
CASES="
PRESENT 0 file -
NO_OFFER 0 file -
DEVICEID 0 file -
DB_ABSENT 3 file database-offer
DEDICATED 3 file container-offer:recipes
MISPART 3 file partition-key:temperatures
PRESENT 0 stdin -
PRESENT 0 dash -
"

# 8 table cases + 3 derived violations (drift/autoscale/wrong-RU)
# + 3 derived operational FATALs (db-queryOk/container-queryOk/queryOk-nonbool)
# + 8 structural fail-closed cases + 3 argument cases (bad-expected/db-name
# mismatch/db-name match) + 3 [pair] mutation controls + 1 [shape] control
# + 1 [defang] control = 30.
# Raise this floor whenever a case is added, so the harness cannot quietly run
# fewer than it advertises.
MIN_CHECKS_PER_SHELL=30

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

# --- Run-time derived VIOLATION documents -----------------------------------
# Each is a ONE-FIELD mutation of the clean PRESENT baseline, so its exit 3 can
# only be about the mutated field. Derived (not committed) because the plan's
# committed set covers the three headline defects; these close the remaining
# assertion-(a)/(d) shapes without adding near-duplicate files.
#
# A definition drift: add an excluded path to ONE container's DESTINATION
# definition while leaving its source — the parity comparison must DIFF => the
# gate reports VIOLATION [definition:cooks].
DRIFT="${WORK}/definition-drift.json"
jq '(.containers[] | select(.name=="cooks") | .definition.resource.indexingPolicy.excludedPaths)
      += [{"path": "/secret/?"}]' "${PRESENT}" > "${DRIFT}" \
  || { echo "FATAL: could not derive the definition-drift control" >&2; exit 2; }

# An AUTOSCALE database offer instead of the intended MANUAL one — a different
# provisioning shape, a VIOLATION [database-offer].
AUTOSCALE="${WORK}/db-offer-autoscale.json"
jq '.database.offerProbe.document.resource = {"autoscaleSettings": {"maxThroughput": 4000}}' \
   "${PRESENT}" > "${AUTOSCALE}" \
  || { echo "FATAL: could not derive the autoscale control" >&2; exit 2; }

# --- Run-time derived OPERATIONAL-FAILURE documents (fail-closed, exit 1) -----
# A database offer probe that could not RUN (queryOk=false). "Could not tell
# whether a shared offer exists" is never "it exists" — FATAL, not a violation.
DB_QUERY_FALSE="${WORK}/db-queryok-false.json"
jq '.database.offerProbe = {"queryOk": false, "offerFound": false}' \
   "${PRESENT}" > "${DB_QUERY_FALSE}" \
  || { echo "FATAL: could not derive the db-queryOk-false control" >&2; exit 2; }

# A per-container throughput probe that could not run — FATAL, never a pass.
CONTAINER_QUERY_FALSE="${WORK}/container-queryok-false.json"
jq '(.containers[] | select(.name=="users") | .throughputProbe) = {"queryOk": false, "offerFound": false}' \
   "${PRESENT}" > "${CONTAINER_QUERY_FALSE}" \
  || { echo "FATAL: could not derive the container-queryOk-false control" >&2; exit 2; }

# A non-boolean queryOk — the outcome cannot be classified. Read with the jq `//`
# operator this would be a fail-open (false // x => x); the gate uses an explicit
# type test, and this fixture proves it stays FATAL.
QUERYOK_NONBOOL="${WORK}/db-queryok-nonbool.json"
jq '.database.offerProbe.queryOk = "yes"' "${PRESENT}" > "${QUERYOK_NONBOOL}" \
  || { echo "FATAL: could not derive the queryOk-nonbool control" >&2; exit 2; }

# --- Structural fail-closed inputs ------------------------------------------
# Each parses as far as its own class allows and would let an assertion "pass" by
# never running for a missing/omitted piece if the gate were not fail-closed.
EMPTY_FILE="${WORK}/empty.json"
: > "${EMPTY_FILE}"
INVALID="${WORK}/invalid.json"
printf '%s\n' '{ "database": ' > "${INVALID}"
WRONGTYPE="${WORK}/wrong-top-level-type.json"
printf '%s\n' '[]' > "${WRONGTYPE}"
NO_DATABASE="${WORK}/no-database.json"
jq 'del(.database)' "${PRESENT}" > "${NO_DATABASE}" || { echo "FATAL: could not derive no-database" >&2; exit 2; }
NO_CONTAINERS="${WORK}/no-containers.json"
jq 'del(.containers)' "${PRESENT}" > "${NO_CONTAINERS}" || { echo "FATAL: could not derive no-containers" >&2; exit 2; }
# A bundle carrying only FOUR of the five destination containers — the omitted
# one would silently skip its offer/partition/parity checks (the vacuous-PASS
# shape this gate's set validation exists to close).
FOUR_CONTAINERS="${WORK}/four-containers.json"
jq '.containers |= map(select(.name != "devices"))' "${PRESENT}" > "${FOUR_CONTAINERS}" \
  || { echo "FATAL: could not derive four-containers" >&2; exit 2; }
# A duplicated container name — per-name lookup becomes ambiguous.
DUPLICATE="${WORK}/duplicate-container.json"
jq '.containers += [ (.containers[] | select(.name=="cooks")) ]' "${PRESENT}" > "${DUPLICATE}" \
  || { echo "FATAL: could not derive duplicate-container" >&2; exit 2; }
# A malformed container entry — missing its throughputProbe, so assertion (b)
# cannot be made for it.
MALFORMED="${WORK}/malformed-entry.json"
jq '(.containers[] | select(.name=="users")) |= del(.throughputProbe)' "${PRESENT}" > "${MALFORMED}" \
  || { echo "FATAL: could not derive malformed-entry" >&2; exit 2; }

# The [defang] control target: the PRESENT bundle with a REAL dedicated offer
# injected onto one container. Its PASS must depend on assertion (b) having run;
# injecting a defect must flip it from PASS to VIOLATION.
DEFANGED="${WORK}/present-with-injected-offer.json"
jq '(.containers[] | select(.name=="devices") | .throughputProbe) = {"queryOk": true, "offerFound": true}' \
   "${PRESENT}" > "${DEFANGED}" \
  || { echo "FATAL: could not derive the defang control" >&2; exit 2; }

# Report what `sh` actually resolves to. On many systems /bin/sh IS bash, in which
# case "both shells" is bash twice and the dash-portability property is NOT tested.
# Stated rather than silently laundered.
sh_target="$(readlink -f /bin/sh 2>/dev/null || echo unknown)"
echo "run-assert-live-shared-throughput-fixtures: /bin/sh resolves to ${sh_target}"
case "${sh_target}" in
  *bash*) echo "  NOTE: /bin/sh is bash on this host — the dash-portability leg is NOT exercised here." ;;
esac
echo

failures=0
shells_run=0
counts=""

# resolve_fixture <var-name> — echo the path a table row's symbolic name maps to.
# A `case`, not indirect expansion (${!name} is a bash-4-ism forbidden here).
resolve_fixture() {
  case "$1" in
    PRESENT)   printf '%s\n' "${PRESENT}" ;;
    NO_OFFER)  printf '%s\n' "${NO_OFFER}" ;;
    DEVICEID)  printf '%s\n' "${DEVICEID}" ;;
    DB_ABSENT) printf '%s\n' "${DB_ABSENT}" ;;
    DEDICATED) printf '%s\n' "${DEDICATED}" ;;
    MISPART)   printf '%s\n' "${MISPART}" ;;
    *)         printf '%s\n' "" ;;
  esac
}

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
    echo "      FAIL-OPEN: the gate reported PASS on a destination it must reject." >&2
  fi
  sed 's/^/      /' "${OUT}" >&2
  failures=$((failures + 1))
  return 1
}

# assert_fatal <label> <path> [extra args...] — the gate must exit 1 and print a
# FATAL. Used for every operational/structural fail-closed case.
assert_fatal() {
  af_label="$1"; af_path="$2"; shift 2
  "${shell_bin}" "${GATE}" "$@" "${af_path}" >"${OUT}" 2>&1
  af_code=$?
  if [ "${af_code}" -eq "${EX_OP}" ] && grep -q "FATAL" "${OUT}"; then
    echo "  ✓ [fail-closed] ${af_label}: exit 1 with a FATAL — fail-closed"
  else
    echo "  ✗ [fail-closed] ${af_label}: expected exit 1 with a FATAL, got ${af_code}" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi
}

for shell_bin in ${SHELL_BINS}; do
  echo "== running fixtures under: ${shell_bin} =="
  checks=0
  failures_before=${failures}

  # Read with `< file` (not a pipe) so the loop runs in THIS shell and the
  # counters survive. A piped `while` runs in a subshell under dash and would
  # silently discard every count — exactly the miscount the floor detects.
  while IFS=' ' read -r fx expect mode subject; do
    [ -z "${fx}" ] && continue
    path="$(resolve_fixture "${fx}")"
    checks=$((checks + 1))
    if [ -z "${path}" ]; then
      echo "  ✗ ${fx} [${mode}]: unknown fixture symbol in the case table" >&2
      failures=$((failures + 1))
      continue
    fi
    case "${mode}" in
      file)  "${shell_bin}" "${GATE}" "${path}" >"${OUT}" 2>&1 ;;
      stdin) "${shell_bin}" "${GATE}" <"${path}" >"${OUT}" 2>&1 ;;
      dash)  "${shell_bin}" "${GATE}" - <"${path}" >"${OUT}" 2>&1 ;;
      *)     echo "  ✗ ${fx}: unknown mode '${mode}'" >&2; failures=$((failures + 1)); continue ;;
    esac
    code=$?
    if assert_code "${fx} [${mode}]" "${expect}" "${code}"; then
      # On a VIOLATION the gate must NAME the violating subject. A gate that
      # reached exit 3 but named nothing (or the wrong subject) is not the
      # recorded assertion the brief requires.
      if [ "${expect}" -eq "${EX_VIOLATION}" ] && [ "${subject}" != "-" ]; then
        if grep -q "VIOLATION \[${subject}\]" "${OUT}"; then
          echo "    · named the violating subject '${subject}'"
        else
          echo "  ✗ ${fx} [${mode}]: exit 3 but did NOT name the expected subject '${subject}'" >&2
          sed 's/^/      /' "${OUT}" >&2
          failures=$((failures + 1))
        fi
      fi
    fi
  done < "${CASES_FILE}"

  # --- DERIVED VIOLATION cases (exit 3, named subject) ------------------------
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" "${DRIFT}" >"${OUT}" 2>&1
  code=$?
  if assert_code "[derived] definition drift" "${EX_VIOLATION}" "${code}"; then
    if grep -q "VIOLATION \[definition:cooks\]" "${OUT}"; then
      echo "    · named the violating subject 'definition:cooks'"
    else
      echo "  ✗ [derived] definition drift: exit 3 but did NOT name definition:cooks" >&2
      sed 's/^/      /' "${OUT}" >&2
      failures=$((failures + 1))
    fi
  fi

  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" "${AUTOSCALE}" >"${OUT}" 2>&1
  code=$?
  if assert_code "[derived] autoscale db offer" "${EX_VIOLATION}" "${code}"; then
    if grep -q "VIOLATION \[database-offer\]" "${OUT}"; then
      echo "    · named the violating subject 'database-offer' (autoscale, not the intended manual offer)"
    else
      echo "  ✗ [derived] autoscale db offer: exit 3 but did NOT name database-offer" >&2
      sed 's/^/      /' "${OUT}" >&2
      failures=$((failures + 1))
    fi
  fi

  # A wrong-RU database-level offer, expressed by demanding a DIFFERENT expected
  # throughput of the clean bundle: the offer is 400, we require 800, so the RU
  # comparison must RUN and FAIL. This doubles as the NON-VACUITY proof that the
  # clean bundle's PASS depends on the RU comparison having run and agreed.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --expected-throughput 800 "${PRESENT}" >"${OUT}" 2>&1
  code=$?
  if assert_code "[non-vacuous] clean bundle vs expected 800 RU/s" "${EX_VIOLATION}" "${code}"; then
    if grep -q "VIOLATION \[database-offer\]" "${OUT}"; then
      echo "    · the RU comparison provably ran: 400 != 800 named as a database-offer violation"
    else
      echo "  ✗ [non-vacuous] exit 3 but did NOT name database-offer for the RU mismatch" >&2
      sed 's/^/      /' "${OUT}" >&2
      failures=$((failures + 1))
    fi
  fi

  # --- DERIVED OPERATIONAL FAIL-CLOSED cases (exit 1) -------------------------
  checks=$((checks + 1)); assert_fatal "db-offer probe could not run (queryOk=false)" "${DB_QUERY_FALSE}"
  checks=$((checks + 1)); assert_fatal "container throughput probe could not run (queryOk=false)" "${CONTAINER_QUERY_FALSE}"
  checks=$((checks + 1)); assert_fatal "queryOk is not a boolean" "${QUERYOK_NONBOOL}"

  # --- STRUCTURAL fail-closed cases (exit 1) ----------------------------------
  checks=$((checks + 1)); assert_fatal "empty file" "${EMPTY_FILE}"
  checks=$((checks + 1)); assert_fatal "invalid JSON" "${INVALID}"
  checks=$((checks + 1)); assert_fatal "wrong top-level type" "${WRONGTYPE}"
  checks=$((checks + 1)); assert_fatal "no .database object" "${NO_DATABASE}"
  checks=$((checks + 1)); assert_fatal "no .containers array" "${NO_CONTAINERS}"
  checks=$((checks + 1)); assert_fatal "only four of five containers" "${FOUR_CONTAINERS}"
  checks=$((checks + 1)); assert_fatal "duplicated container name" "${DUPLICATE}"
  checks=$((checks + 1)); assert_fatal "malformed container entry (no throughputProbe)" "${MALFORMED}"

  # --- ARGUMENT cases ---------------------------------------------------------
  # A garbage --expected-throughput is the vacuous-PASS class this gate closes: a
  # gate that "passes" because it had no number to compare against asserts nothing.
  checks=$((checks + 1)); assert_fatal "non-integer --expected-throughput" "${PRESENT}" --expected-throughput abc

  # --database-name is a cross-check that the bundle describes the intended db. A
  # mismatch FATALs (this bundle is not the one this run meant to assert); a match
  # on an otherwise-clean bundle still PASSes.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --database-name "wrong-db-name" "${PRESENT}" >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -eq "${EX_OP}" ] && grep -q "FATAL" "${OUT}"; then
    echo "  ✓ [args] --database-name mismatch: exit 1 with a FATAL — fail-closed"
  else
    echo "  ✗ [args] --database-name mismatch: expected exit 1 with a FATAL, got ${code}" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi

  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --database-name "${DB_NAME}" "${PRESENT}" >"${OUT}" 2>&1
  assert_code "[args] --database-name match on a clean bundle" "${EX_PASS}" "$?"

  # --- PAIR cases: each violation differs from its clean counterpart by EXACTLY
  # one field ---------------------------------------------------------------------
  # Asserted with jq, because an exit code cannot see it. If someone deletes the
  # mutation from a violation fixture, or lets a scoped defect leak into a clean
  # one, these turn red BEFORE any exit code moves — the control stops controlling.
  #
  # DB pair: strip .database.offerProbe from both and the remainder must be equal;
  # the clean side must carry offerFound=true, the violation side offerFound=false.
  checks=$((checks + 1))
  pair_err=""
  present_less_db="$(jq -S 'del(.database.offerProbe)' "${PRESENT}" 2>/dev/null)" || pair_err="PRESENT not parseable"
  absent_less_db="$(jq -S 'del(.database.offerProbe)' "${DB_ABSENT}" 2>/dev/null)" || pair_err="DB_ABSENT not parseable"
  present_found="$(jq -r '.database.offerProbe.offerFound' "${PRESENT}" 2>/dev/null)"
  absent_found="$(jq -r '.database.offerProbe.offerFound' "${DB_ABSENT}" 2>/dev/null)"
  if [ -z "${pair_err}" ]; then
    if [ "${present_found}" != "true" ]; then
      pair_err="the clean counterpart's database offer is not present (offerFound=${present_found})"
    elif [ "${absent_found}" != "false" ]; then
      pair_err="the absent-offer fixture still reports offerFound=${absent_found}; its rejection would be for some other reason"
    elif [ "${present_less_db}" != "${absent_less_db}" ]; then
      pair_err="db-offer-absent differs from its clean counterpart by MORE than .database.offerProbe"
    fi
  fi
  if [ -n "${pair_err}" ]; then
    echo "  ✗ [pair/db] ${pair_err}" >&2
    failures=$((failures + 1))
  else
    echo "  ✓ [pair/db] db-offer-absent is a one-field mutation of its clean counterpart (only .database.offerProbe differs)"
  fi

  # CONTAINER pair: blank EVERY container throughputProbe on both and the remainder
  # must be equal; the clean side has NO container with an offer, the violation side
  # exactly one (the named DEDICATED_CONTAINER).
  checks=$((checks + 1))
  cpair_err=""
  noofr_blanked="$(jq -S '.containers |= map(.throughputProbe = {})' "${NO_OFFER}" 2>/dev/null)" || cpair_err="NO_OFFER not parseable"
  ded_blanked="$(jq -S '.containers |= map(.throughputProbe = {})' "${DEDICATED}" 2>/dev/null)" || cpair_err="DEDICATED not parseable"
  clean_offers="$(jq -r '[ .containers[] | select(.throughputProbe.offerFound == true) ] | length' "${NO_OFFER}" 2>/dev/null)"
  ded_offer_names="$(jq -r '.containers[] | select(.throughputProbe.offerFound == true) | .name' "${DEDICATED}" 2>/dev/null)"
  ded_offer_count="$(printf '%s' "${ded_offer_names}" | grep -c . || true)"
  ded_offer_count="$(printf '%s' "${ded_offer_count}" | tr -d ' ')"
  if [ -z "${cpair_err}" ]; then
    if [ "${clean_offers}" != "0" ]; then
      cpair_err="the clean counterpart already carries ${clean_offers} container offer(s); it must carry none"
    elif [ "${ded_offer_count}" != "1" ]; then
      cpair_err="the dedicated-offer fixture carries ${ded_offer_count} container offer(s); the mutation is exactly one"
    elif [ "${ded_offer_names}" != "${DEDICATED_CONTAINER}" ]; then
      cpair_err="the dedicated offer is on '${ded_offer_names}', expected '${DEDICATED_CONTAINER}'"
    elif [ "${noofr_blanked}" != "${ded_blanked}" ]; then
      cpair_err="dedicated-offer differs from its clean counterpart by MORE than one container's throughputProbe"
    fi
  fi
  if [ -n "${cpair_err}" ]; then
    echo "  ✗ [pair/container] ${cpair_err}" >&2
    failures=$((failures + 1))
  else
    echo "  ✓ [pair/container] dedicated-offer is a one-field mutation of its clean counterpart (only ${DEDICATED_CONTAINER}'s throughputProbe differs)"
  fi

  # TEMPERATURES pair: null out the temperatures destination partition key paths on
  # both and the remainder must be equal; the clean side is on /deviceId, the
  # violation side off it.
  checks=$((checks + 1))
  tpair_err=""
  dev_blanked="$(jq -S '(.containers[] | select(.name=="temperatures") | .definition.resource.partitionKey.paths) = null' "${DEVICEID}" 2>/dev/null)" || tpair_err="DEVICEID not parseable"
  mis_blanked="$(jq -S '(.containers[] | select(.name=="temperatures") | .definition.resource.partitionKey.paths) = null' "${MISPART}" 2>/dev/null)" || tpair_err="MISPART not parseable"
  dev_paths="$(jq -c '.containers[] | select(.name=="temperatures") | .definition.resource.partitionKey.paths' "${DEVICEID}" 2>/dev/null)"
  mis_paths="$(jq -c '.containers[] | select(.name=="temperatures") | .definition.resource.partitionKey.paths' "${MISPART}" 2>/dev/null)"
  if [ -z "${tpair_err}" ]; then
    if [ "${dev_paths}" != '["/deviceId"]' ]; then
      tpair_err="the clean counterpart's temperatures partition key is ${dev_paths}, not [\"/deviceId\"]"
    elif [ "${mis_paths}" = '["/deviceId"]' ] || [ "${mis_paths}" = "null" ]; then
      tpair_err="the mispartitioned fixture's temperatures partition key is ${mis_paths}; it must be OFF /deviceId to control anything"
    elif [ "${dev_blanked}" != "${mis_blanked}" ]; then
      tpair_err="mispartitioned differs from its clean counterpart by MORE than the temperatures partition key"
    fi
  fi
  if [ -n "${tpair_err}" ]; then
    echo "  ✗ [pair/temperatures] ${tpair_err}" >&2
    failures=$((failures + 1))
  else
    echo "  ✓ [pair/temperatures] mispartitioned is a one-field mutation of its clean counterpart (only temperatures partitionKey.paths differs: ${dev_paths} -> ${mis_paths})"
  fi

  # --- SHAPE case: the three clean baselines stay identical AND valid ----------
  # Asserted LEXICALLY. The three clean files are the paired positive controls; if
  # they diverge, or one silently gains a defect (an absent db offer, a container
  # offer, a temperatures drift off /deviceId), the corresponding pair's PASS is a
  # claim about a shape that is not clean. Pin: byte-identical after key sort, and
  # each carries the healthy invariants the gate checks.
  checks=$((checks + 1))
  shape_err=""
  p_norm="$(jq -S . "${PRESENT}" 2>/dev/null)" || shape_err="PRESENT not parseable JSON"
  n_norm="$(jq -S . "${NO_OFFER}" 2>/dev/null)" || shape_err="NO_OFFER not parseable JSON"
  d_norm="$(jq -S . "${DEVICEID}" 2>/dev/null)" || shape_err="DEVICEID not parseable JSON"
  if [ -z "${shape_err}" ]; then
    p_ru="$(jq -r '.database.offerProbe.document.resource.throughput' "${PRESENT}" 2>/dev/null)"
    p_found="$(jq -r '.database.offerProbe.offerFound' "${PRESENT}" 2>/dev/null)"
    p_container_offers="$(jq -r '[ .containers[] | select(.throughputProbe.offerFound == true) ] | length' "${PRESENT}" 2>/dev/null)"
    p_names="$(jq -r '[ .containers[].name ] | sort | join(",")' "${PRESENT}" 2>/dev/null)"
    p_temp="$(jq -c '.containers[] | select(.name=="temperatures") | .definition.resource.partitionKey.paths' "${PRESENT}" 2>/dev/null)"
    if [ "${p_norm}" != "${n_norm}" ] || [ "${p_norm}" != "${d_norm}" ]; then
      shape_err="the three clean baselines are not byte-identical (after key sort) — a violation pair's clean control may have drifted"
    elif [ "${p_found}" != "true" ] || [ "${p_ru}" != "${EXPECTED_RU}" ]; then
      shape_err="the clean baseline no longer carries a present ${EXPECTED_RU} RU/s database-level offer (found=${p_found}, ru=${p_ru})"
    elif [ "${p_container_offers}" != "0" ]; then
      shape_err="the clean baseline carries ${p_container_offers} dedicated container offer(s); a clean destination carries none"
    elif [ "${p_names}" != "cooks,devices,recipes,temperatures,users" ]; then
      shape_err="the clean baseline does not carry EXACTLY the five destination containers (got ${p_names})"
    elif [ "${p_temp}" != '["/deviceId"]' ]; then
      shape_err="the clean baseline's temperatures container is not on /deviceId (got ${p_temp})"
    fi
  fi
  if [ -n "${shape_err}" ]; then
    echo "  ✗ [shape] ${shape_err}" >&2
    failures=$((failures + 1))
  else
    echo "  ✓ [shape] the three clean baselines are identical and each carries the healthy invariants (400 RU/s db offer, no container offers, five containers, temperatures on /deviceId)"
  fi

  # --- DEFANG case: the clean PASS depends on assertion (b) having run ---------
  # Inject a REAL dedicated offer onto a container of the clean bundle; the gate
  # must flip from PASS to VIOLATION. Without this, a gate that had stopped
  # checking container offers would keep the clean rows green.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" "${DEFANGED}" >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -eq "${EX_VIOLATION}" ] && grep -q "VIOLATION \[container-offer:devices\]" "${OUT}"; then
    echo "  ✓ [defang] injecting a real dedicated offer into the clean bundle flips it to exit 3 — the clean PASS is non-vacuous"
  else
    echo "  ✗ [defang] expected exit 3 naming container-offer:devices when the clean bundle gains a real offer, got ${code} — the clean PASS may not depend on assertion (b)" >&2
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
echo "run-assert-live-shared-throughput-fixtures: shells_run=${shells_run}, per-shell checks:${counts}"

distinct="$(for c in ${counts}; do echo "${c##*=}"; done | sort -u | wc -l)"
if [ "${shells_run}" -lt 2 ]; then
  echo "run-assert-live-shared-throughput-fixtures: FAILED — only ${shells_run} shell(s) ran; the dual-shell contract was not exercised" >&2
  exit 1
fi
if [ "${distinct}" -ne 1 ]; then
  echo "run-assert-live-shared-throughput-fixtures: FAILED — per-shell check counts differ (${counts}); a shell skipped rows" >&2
  exit 1
fi

if [ "${failures}" -ne 0 ]; then
  echo "run-assert-live-shared-throughput-fixtures: FAILED — ${failures} case(s) did not behave as expected" >&2
  exit 1
fi
echo "run-assert-live-shared-throughput-fixtures: all fixtures behaved as expected under every shell."
exit 0
