#!/usr/bin/env bash
#
# run-collect-live-shared-throughput-fixtures.sh — deterministic, credential-less
# regression harness for the LIVE COLLECTOR (MG-53):
# scripts/collect-live-shared-throughput.sh.
#
# The collector is the only half of the MG-53 post-create assertion that touches
# Azure — it runs the `az cosmosdb sql ...` read-backs and assembles the single
# "read-back bundle" the fail-closed gate consumes. This harness proves that
# assembly and its fail-closed CLASSIFICATION without any Azure, credential or real
# `az`: it overrides the collector's AZ_BIN with a FAKE `az` that returns canned
# read-backs and exit codes, then drives the collector end-to-end and INTO the real
# gate (scripts/assert-live-shared-throughput.sh), asserting the gate's verdict.
# That is the strongest possible credential-less evidence: it exercises the exact
# producer→consumer seam the apply job wires, not a mock of it.
#
# The canned `az cosmosdb sql container show` / throughput documents are extracted
# from the committed clean bundle fixture shared-throughput-db-offer-present.json,
# so a CLEAN collection reassembles a bundle the gate must PASS — and a single
# fake-`az` mutation (a container that returns a dedicated offer, a database whose
# throughput-show 404s, an auth error, an unreadable container-show) is what flips
# the end-to-end outcome. The collector's own fail-closed contract (queryOk=false
# on an UNRECOGNISED az failure; die on an unreadable definition) is pinned here.
#
# DUAL SHELL is a security property, not a style one (a collector that ERRORs under
# one shell while assembling under another is fail-open): every case runs under
# BOTH bash and sh, and the per-shell check counts must be EQUAL and meet a floor.
#
# Exit 0 iff every case behaves as expected under every shell AND the counts hold.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
COLLECTOR="${HERE}/../collect-live-shared-throughput.sh"
GATE="${HERE}/../assert-live-shared-throughput.sh"
PRESENT="${HERE}/shared-throughput-db-offer-present.json"

[ -f "${COLLECTOR}" ] || { echo "FATAL: collector not found: ${COLLECTOR}" >&2; exit 2; }
[ -f "${GATE}" ]      || { echo "FATAL: gate not found: ${GATE}" >&2; exit 2; }
[ -f "${PRESENT}" ]   || { echo "FATAL: clean bundle fixture not found: ${PRESENT}" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq is required by this harness (and by the collector)" >&2; exit 2; }

EX_PASS=0
EX_OP=1
EX_VIOLATION=3

DEST_DB="meatgeek-v2-dev-shared-db"
SRC_DB="meatgeek-v2-dev-db"
ACCOUNT="meatgeekv2devcosmos"
RG="meatgeek-v2-dev-rg"
CONTAINERS="cooks users recipes temperatures devices"

# 6 end-to-end scenarios, each contributing 2 checks per shell (five scenarios:
# collector-exit + gate-verdict; the die scenario: collector-exit + no-stdout) =
# 12 checks per shell. Raise it whenever a case is added.
MIN_CHECKS_PER_SHELL=12

SHELL_BINS=""
for cand in bash sh; do
  p="$(command -v "${cand}" 2>/dev/null || true)"
  [ -n "${p}" ] && SHELL_BINS="${SHELL_BINS} ${p}"
done
[ -n "${SHELL_BINS}" ] || { echo "FATAL: no shell found to run the collector under" >&2; exit 2; }

WORK="$(mktemp -d)" || { echo "FATAL: mktemp -d failed" >&2; exit 2; }
trap 'rm -rf "${WORK}"' EXIT HUP INT TERM

# --- The fake `az` ----------------------------------------------------------
# Driven by $FAKE_AZ_DIR: for a computed <key>, if <key>.rc exists it exits that
# code (printing <key>.err to stderr if present); else if <key>.out exists it
# prints it and exits 0; else it exits nonzero (an unconfigured probe fails, so a
# scenario that forgets to stage a read-back cannot look healthy).
FAKE_AZ="${WORK}/fake-az"
cat > "${FAKE_AZ}" <<'FAKEAZ'
#!/usr/bin/env bash
set -u
RESOURCE=""; ACTION=""; NAME=""; DBNAME=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    database)  RESOURCE="database" ;;
    container) RESOURCE="container" ;;
    throughput) ACTION="throughput" ;;
    show)      [ -z "${ACTION}" ] && ACTION="show" ;;
    --name)          NAME="$2"; shift ;;
    --database-name) DBNAME="$2"; shift ;;
    *) : ;;
  esac
  shift
done
key=""
if [ "${RESOURCE}" = "database" ] && [ "${ACTION}" = "throughput" ]; then
  key="db-throughput"
elif [ "${RESOURCE}" = "container" ] && [ "${ACTION}" = "throughput" ]; then
  key="container-tp-${NAME}"
elif [ "${RESOURCE}" = "container" ] && [ "${ACTION}" = "show" ]; then
  if [ "${DBNAME}" = "${FAKE_SRC_DB}" ]; then key="container-show-src-${NAME}"; else key="container-show-dst-${NAME}"; fi
fi
[ -n "${key}" ] || { echo "fake-az: could not classify: RESOURCE=${RESOURCE} ACTION=${ACTION}" >&2; exit 90; }
base="${FAKE_AZ_DIR}/${key}"
if [ -f "${base}.rc" ]; then
  [ -f "${base}.err" ] && cat "${base}.err" >&2
  exit "$(cat "${base}.rc")"
elif [ -f "${base}.out" ]; then
  cat "${base}.out"
  exit 0
else
  echo "fake-az: no canned response for key '${key}'" >&2
  exit 91
fi
FAKEAZ
chmod +x "${FAKE_AZ}"

# stage_clean <dir> — populate a scenario dir with the healthy read-backs, all
# extracted from the committed clean bundle: db offer present at 400, every
# container with NO dedicated offer (throughput-show 404s), and each container's
# destination/source definition as its canned container-show document.
stage_clean() {
  sc_dir="$1"
  mkdir -p "${sc_dir}"
  jq -c '.database.offerProbe.document' "${PRESENT}" > "${sc_dir}/db-throughput.out"
  for c in ${CONTAINERS}; do
    # No dedicated offer: throughput-show exits nonzero with a not-found marker.
    printf '%s\n' '3' > "${sc_dir}/container-tp-${c}.rc"
    printf '%s\n' '(NotFound) Entity with the specified id does not exist in the system.' > "${sc_dir}/container-tp-${c}.err"
    jq -c --arg n "${c}" '(.containers[] | select(.name==$n) | .definition)'       "${PRESENT}" > "${sc_dir}/container-show-dst-${c}.out"
    jq -c --arg n "${c}" '(.containers[] | select(.name==$n) | .sourceDefinition)' "${PRESENT}" > "${sc_dir}/container-show-src-${c}.out"
  done
}

failures=0
shells_run=0
counts=""

# run_scenario <shell> <scenario-dir> <expected-collector-rc> <expected-gate-rc> <label>
# Runs the collector under <shell> with the fake az, capturing its bundle; if the
# collector succeeded, pipes the bundle into the gate and checks the gate verdict.
run_scenario() {
  rs_shell="$1"; rs_dir="$2"; rs_exp_coll="$3"; rs_exp_gate="$4"; rs_label="$5"
  rs_bundle="${WORK}/bundle.json"
  rs_cerr="${WORK}/collector.err"
  FAKE_AZ_DIR="${rs_dir}" FAKE_SRC_DB="${SRC_DB}" AZ_BIN="${FAKE_AZ}" \
    "${rs_shell}" "${COLLECTOR}" \
      --account-name "${ACCOUNT}" --resource-group "${RG}" \
      --database-name "${DEST_DB}" --source-database-name "${SRC_DB}" \
      --containers "${CONTAINERS}" >"${rs_bundle}" 2>"${rs_cerr}"
  rs_coll_rc=$?

  if [ "${rs_coll_rc}" -eq "${rs_exp_coll}" ]; then
    echo "  ✓ ${rs_label}: collector exit ${rs_coll_rc} as expected"
  else
    echo "  ✗ ${rs_label}: collector expected exit ${rs_exp_coll}, got ${rs_coll_rc}" >&2
    sed 's/^/      /' "${rs_cerr}" >&2
    failures=$((failures + 1))
  fi

  if [ "${rs_exp_coll}" -ne 0 ]; then
    # On a fail-closed collector exit, nothing may have been written to stdout —
    # a bundle emitted alongside a failure is exactly the fail-open shape.
    if [ ! -s "${rs_bundle}" ]; then
      echo "  ✓ ${rs_label}: no bundle written to stdout on the fail-closed path"
    else
      echo "  ✗ ${rs_label}: collector failed (exit ${rs_coll_rc}) but still wrote a bundle to stdout" >&2
      failures=$((failures + 1))
    fi
    return
  fi

  # Collector succeeded — feed the assembled bundle to the real gate.
  "${rs_shell}" "${GATE}" --expected-throughput 400 --database-name "${DEST_DB}" "${rs_bundle}" \
    >"${WORK}/gate.out" 2>&1
  rs_gate_rc=$?
  if [ "${rs_gate_rc}" -eq "${rs_exp_gate}" ]; then
    echo "  ✓ ${rs_label}: gate verdict exit ${rs_gate_rc} as expected"
  else
    echo "  ✗ ${rs_label}: gate expected exit ${rs_exp_gate}, got ${rs_gate_rc}" >&2
    if [ "${rs_exp_gate}" -ne 0 ] && [ "${rs_gate_rc}" -eq 0 ]; then
      echo "      FAIL-OPEN: the gate PASSED a destination it must reject." >&2
    fi
    sed 's/^/      /' "${WORK}/gate.out" >&2
    failures=$((failures + 1))
  fi
}

# --- Scenario dirs ----------------------------------------------------------
CLEAN="${WORK}/clean"
stage_clean "${CLEAN}"

# A container holding a dedicated offer: its throughput-show SUCCEEDS -> the
# collector records offerFound=true -> the gate rejects (exit 3).
DEDICATED="${WORK}/dedicated"
stage_clean "${DEDICATED}"
rm -f "${DEDICATED}/container-tp-recipes.rc" "${DEDICATED}/container-tp-recipes.err"
jq -n '{id:"recipes", resource:{throughput:400, minimumThroughput:"400"}}' > "${DEDICATED}/container-tp-recipes.out"

# No database-level offer: db throughput-show 404s -> offerFound=false -> exit 3.
DB_ABSENT="${WORK}/db-absent"
stage_clean "${DB_ABSENT}"
rm -f "${DB_ABSENT}/db-throughput.out"
printf '%s\n' '3' > "${DB_ABSENT}/db-throughput.rc"
printf '%s\n' '(NotFound) Entity with the specified id does not exist in the system.' > "${DB_ABSENT}/db-throughput.err"

# An UNRECOGNISED db throughput-show failure (auth) -> the collector must classify
# queryOk=false, NOT offerFound=false -> the gate fails closed (exit 1). This is
# the crux fail-closed property: "could not tell" is never "no offer".
DB_AUTH="${WORK}/db-auth"
stage_clean "${DB_AUTH}"
rm -f "${DB_AUTH}/db-throughput.out"
printf '%s\n' '1' > "${DB_AUTH}/db-throughput.rc"
printf '%s\n' "ERROR: Please run 'az login' to setup account." > "${DB_AUTH}/db-throughput.err"

# A container throughput probe whose failure names the TARGET as absent (an ARM
# ResourceNotFound — the account/rg/resource, not the offer) -> the collector must
# classify queryOk=false, NOT offerFound=false. A broad not-found classifier read
# this as a healthy shared container (offerFound=false) and the gate PASSED a
# destination it never actually probed — the exact fail-open this scenario pins.
# The container's definition read-backs stay clean, so the collector does NOT die on
# a definition; the misclassification, if present, would reach the gate as a bundle
# and PASS. queryOk=false makes the gate fail closed (exit 1) instead.
CONTAINER_TARGET_NOTFOUND="${WORK}/container-target-notfound"
stage_clean "${CONTAINER_TARGET_NOTFOUND}"
rm -f "${CONTAINER_TARGET_NOTFOUND}/container-tp-recipes.rc" "${CONTAINER_TARGET_NOTFOUND}/container-tp-recipes.err"
printf '%s\n' '3' > "${CONTAINER_TARGET_NOTFOUND}/container-tp-recipes.rc"
printf '%s\n' "ERROR: (ResourceNotFound) The Resource 'Microsoft.DocumentDB/databaseAccounts/meatgeekv2devcosmos' under resource group 'meatgeek-v2-dev-rg' was not found." > "${CONTAINER_TARGET_NOTFOUND}/container-tp-recipes.err"

# An unreadable container-show (definition) -> the collector DIES (exit 1) and
# writes no bundle, rather than emitting one missing a definition the gate needs.
DEF_UNREADABLE="${WORK}/def-unreadable"
stage_clean "${DEF_UNREADABLE}"
rm -f "${DEF_UNREADABLE}/container-show-dst-users.out"
printf '%s\n' '1' > "${DEF_UNREADABLE}/container-show-dst-users.rc"
printf '%s\n' 'ERROR: request failed: connection reset by peer' > "${DEF_UNREADABLE}/container-show-dst-users.err"

# --- Run every scenario under every shell -----------------------------------
for shell_bin in ${SHELL_BINS}; do
  echo "== collector fixtures under ${shell_bin} =="
  # Redirect the group to a file (NOT a pipe): a file redirection runs in the
  # current shell, so run_scenario's mutation of $failures persists. A `| tee`
  # would fork a subshell and silently drop every failure it counted.
  run_out="${WORK}/run.out.${shells_run}"
  {
    run_scenario "${shell_bin}" "${CLEAN}"          0 "${EX_PASS}"      "[clean] healthy destination -> gate PASS"
    run_scenario "${shell_bin}" "${DEDICATED}"      0 "${EX_VIOLATION}" "[violation] recipes holds a dedicated offer -> gate VIOLATION"
    run_scenario "${shell_bin}" "${DB_ABSENT}"      0 "${EX_VIOLATION}" "[violation] no database-level offer -> gate VIOLATION"
    run_scenario "${shell_bin}" "${DB_AUTH}"        0 "${EX_OP}"        "[fail-closed] db offer probe auth error -> queryOk=false -> gate exit 1"
    run_scenario "${shell_bin}" "${CONTAINER_TARGET_NOTFOUND}" 0 "${EX_OP}" "[fail-closed] container probe hits ARM ResourceNotFound (wrong target) -> queryOk=false -> gate exit 1, NOT a false PASS"
    run_scenario "${shell_bin}" "${DEF_UNREADABLE}" "${EX_OP}" 0        "[fail-closed] unreadable container-show -> collector dies, no bundle"
  } > "${run_out}" 2>&1
  cat "${run_out}"
  this_checks="$(grep -c '  ✓ ' "${run_out}" 2>/dev/null || true)"
  this_fail="$(grep -c '  ✗ ' "${run_out}" 2>/dev/null || true)"
  echo "  -- ${shell_bin}: ${this_checks} checks passed, ${this_fail} failed"
  if [ "${this_checks}" -lt "${MIN_CHECKS_PER_SHELL}" ]; then
    echo "  ✗ ${shell_bin}: ran ${this_checks} checks, fewer than the floor ${MIN_CHECKS_PER_SHELL}" >&2
    failures=$((failures + 1))
  fi
  counts="${counts} ${shell_bin}=${this_checks}"
  shells_run=$((shells_run + 1))
done

echo
echo "run-collect-live-shared-throughput-fixtures: shells_run=${shells_run}, per-shell checks:${counts}"
if [ "${failures}" -ne 0 ]; then
  echo "run-collect-live-shared-throughput-fixtures: ${failures} failure(s)." >&2
  exit 1
fi
echo "run-collect-live-shared-throughput-fixtures: all scenarios behaved as expected under every shell."
exit 0
