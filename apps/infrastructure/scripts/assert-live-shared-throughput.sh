#!/usr/bin/env bash
#
# assert-live-shared-throughput.sh — FAIL-CLOSED post-create assertion that the
# MG-53 DESTINATION shared-throughput Cosmos database was materialised exactly as
# intended: a SINGLE 400 RU/s offer at the DATABASE level, five containers that
# hold NO dedicated offer of their own, the temperatures container partitioned on
# /deviceId, and five container definitions that are faithful twins of their
# sources. It asserts the acceptance of MG-53 against LIVE Azure read-backs, in
# the same fail-closed style as scripts/assert-live-host-storage.sh (MG-58).
#
# WHY THIS GATE EXISTS — read this before changing anything here.
# MG-53 corrects a wrong mental model: the V2 dev Cosmos database carries NO
# database-level offer, so each of its five containers silently received its own
# 400 RU/s minimum manual offer (~2000 RU/s total) instead of the single shared
# 400 RU/s the code intended. Cosmos provides NO mechanism for one container to
# draw on a sibling's throughput; sharing requires ONE offer on the DATABASE. And
# Azure cannot convert a dedicated-throughput container to shared in place, so the
# fix is a NEWLY CREATED shared-throughput database. A destination that is built
# wrong — a missing database-level offer, a container that kept a dedicated offer,
# a temperatures container that drifted off /deviceId, or a definition that does
# not match its source — is not a valid destination, and every one of those
# failures is INVISIBLE to the config-surface gates (they key on the SOURCE
# labels). The live destination is the only surface these defects exist on, so
# this gate reads live read-backs and asserts against them.
#
# AUTHORITY SPLIT — THIS SCRIPT OWNS THE DESTINATION'S CREATE-ONLY PARTITION KEY.
# scripts/tf-static-checks.sh check 20 asserts the agreement between the IoT Hub
# Cosmos routing endpoint's partition_key_name = "deviceId" and the SOURCE
# temperatures container's partition_key_paths = ["/deviceId"]. Check 20 keys on
# the SOURCE container label (azurerm_cosmosdb_sql_container.temperatures) and is
# STRUCTURALLY BLIND to the differently-labeled destination container
# (azurerm_cosmosdb_sql_container.temperatures_shared). Check 20 therefore covers
# the SOURCE contract ONLY. THIS gate is authoritative for the DESTINATION's
# create-only partition key: a container's partition key path cannot be repaired
# after creation, and MG-73 proved the routed deviceId is derived from the
# authenticated connection identity, so a destination temperatures container that
# is NOT on /deviceId is an unrepairable mis-partition of a trust boundary. The
# module tftest (MG-53 step 2) is the in-container plan-time net for the same
# property; this gate is the live post-create net. Do NOT extend check 20 to the
# destination label to "cover" this — that is not what check 20 is for.
#
# WHAT IT ASSERTS, against a single "read-back bundle" document (see INPUT below):
#   (a) DATABASE-LEVEL OFFER EXISTS AT 400 RU/s. The destination database carries
#       a shared-throughput offer (from `az cosmosdb sql database throughput
#       show`) whose MANUAL throughput equals the expected value (default 400). An
#       autoscale offer is NOT the intended manual shared offer and is a violation.
#   (b) NO DESTINATION CONTAINER HOLDS A DEDICATED OFFER. For each of the five
#       containers, the per-container throughput probe (`az cosmosdb sql container
#       throughput show`) must show NO offer. A probe that RETURNS an offer is a
#       VIOLATION. A probe that could not RUN (auth/network/throttle) is a FATAL,
#       never a pass — "no offer" and "could not tell" are different states and
#       are carried distinctly in the bundle (see INPUT).
#   (c) TEMPERATURES IS ON /deviceId. The destination temperatures container's
#       partition key paths (from `az cosmosdb sql container show`) equal exactly
#       ["/deviceId"]. This gate is authoritative for this create-only property.
#   (d) DEFINITIONS MATCH SOURCE. For each of the five containers, the destination
#       definition is definition-faithful to its source, proven by invoking
#       scripts/cosmos-definition-parity.sh (MG-53 step 3) on the two canonical
#       `az cosmosdb sql container show` read-backs. Throughput is scoped OUT of
#       that comparison by design (the source temperatures container carries a
#       dedicated 400 RU/s offer; the destination deliberately carries none).
#
# NEVER A PASS ON AN ASSERTION THAT DID NOT RUN. Every one of the four assertions
# above sets a "provably ran" marker only after it reaches a recognised verdict,
# and the final PASS is re-derived from all four markers AND a zero violation
# count — it cannot be reached by decrementing a counter or by an assertion that
# silently skipped. Every operational failure (missing/empty/malformed/unreadable
# input, a probe that could not run, a parity comparison that errored) is a FATAL
# that exits before the verdict. "Cannot tell" is NEVER "nothing wrong".
#
# INPUT — a single JSON "read-back bundle" the OPERATOR assembles from the live az
# read-backs, passed as a file argument or on stdin (exactly one document, like
# assert-live-host-storage.sh). The bundle carries the read-backs AND the OUTCOME
# of each throughput probe, because a container/database with NO offer makes
# `az ... throughput show` EXIT NONZERO rather than return JSON — that outcome is
# the assertion, so it must be represented, not inferred from a missing file.
#
#   {
#     "database": {
#       "name": "meatgeek-v2-dev-shared-db",
#       "offerProbe": {
#         "queryOk": true,          // did `az cosmosdb sql database throughput
#                                   //   show` RUN to a definite answer? false =>
#                                   //   auth/network/throttle => FATAL, never a pass
#         "offerFound": true,       // did it return a database-level offer?
#                                   //   false => NO shared offer => VIOLATION
#         "document": { ... }       // the full read-back when offerFound; its
#                                   //   .resource.throughput must equal expected
#       }
#     },
#     "containers": [
#       {
#         "name": "temperatures",
#         "throughputProbe": {
#           "queryOk": true,        // did `az cosmosdb sql container throughput
#                                   //   show` RUN to a definite answer? false => FATAL
#           "offerFound": false     // did it return a dedicated offer?
#                                   //   true => VIOLATION (container has its own offer)
#         },
#         "definition": { ... },       // destination `az cosmosdb sql container show`
#         "sourceDefinition": { ... }  // source      `az cosmosdb sql container show`
#       },
#       ... exactly the five containers: cooks, users, recipes, temperatures, devices
#     ]
#   }
#
#   HOW THE OPERATOR FILLS queryOk / offerFound (documented so the classification
#   is explicit and testable, never a brittle parse of az error text inside this
#   gate): run the throughput-show; if it SUCCEEDS and returns an offer, set
#   queryOk=true, offerFound=true (and include the document for the database).
#   If it FAILS with the specific "offer/throughput not found" result (the shared
#   container / no-offer database case), set queryOk=true, offerFound=false. If it
#   fails for ANY OTHER reason (not logged in, network, throttled, wrong name),
#   set queryOk=false — this gate then fails closed on it.
#
# OUTPUT CONTRACT — NAMES AND REASONS, NEVER SECRETS. A container-show document and
# a throughput offer carry schema and RU/s numbers, not credentials or connection
# strings (the destination account has local auth disabled, MG-24). This gate
# prints container names, field names, fixed reasons, and RU/s integers — the
# schema fragments the parity script already prints on a diff. It is safe in a
# retained CI log, same rule as assert-live-host-storage.sh.
#
# PORTABILITY IS A SECURITY PROPERTY HERE, NOT A STYLE NOTE. Written to run
# IDENTICALLY under macOS's default /bin/bash 3.2.57, modern bash 5 and dash. No
# bash-4 case modification (${v,,}/${v^^}), no associative arrays, no `mapfile`,
# no `${!arr[@]}` index expansion, no here-strings (<<<), no process substitution,
# no `[[ ]]`. A gate that ERRORS on one shell while still reaching a PASS on
# another is FAIL-OPEN, and this repo has shipped exactly that bug once (a
# bash-4-only ${1,,} let a foreign connection string through). Container names are
# iterated by VALUE from a fixed space-separated list, never by index.
#
# EXIT CODES — a caller depends on the distinction between "the destination is
# provably wrong" and "I could not tell".
#   0  PASS: (a) a 400 RU/s database-level offer exists, (b) zero containers hold a
#      dedicated offer, (c) temperatures is on /deviceId, and (d) all five
#      definitions match their source — all four assertions provably ran.
#   3  VIOLATION: at least one assertion RAN and FAILED — no database-level offer,
#      a container holding a dedicated offer, temperatures off /deviceId, or a
#      definition drift. A real, provable defect in the destination; the failing
#      assertion(s) are named. Distinct from operational failure so a caller can
#      tell a genuine defect apart from an environment problem.
#   1  OPERATIONAL FAILURE / FAIL-CLOSED: anything that prevented an assertion from
#      provably running — no jq, the parity script missing/unrunnable, a
#      missing/unreadable/empty input, invalid JSON, a bundle that is not the
#      expected shape (wrong top-level type, wrong container set, a probe that
#      could not run), or a parity comparison that itself errored.
#
# USAGE
#   assert-live-shared-throughput.sh [--expected-throughput 400] \
#       [--database-name <name>] <bundle.json>
#   assert-live-shared-throughput.sh --expected-throughput 400 -   # explicit stdin
#
set -u
# pipefail is a bash/ksh feature; dash lacks it and would print an error and skew
# the exit code. Enable it only where supported — every pipeline below begins with
# printf, which cannot fail, so correctness never DEPENDS on it (defense in depth).
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

PROG="assert-live-shared-throughput"

# Exit codes, spelled out once.
EX_VIOLATION=3
EX_OP=1

# The five destination containers, spelled out ONCE and iterated by VALUE (never
# by index, which would need bash-4 ${!arr[@]}). This IS the required set: a bundle
# that does not carry exactly these five names is malformed and fails closed.
EXPECTED_CONTAINERS="cooks users recipes temperatures devices"
# The one container whose create-only partition key this gate owns, and the path
# it must carry (agreeing with the IoT Hub endpoint's partition_key_name).
TEMPERATURES="temperatures"
DEVICEID_PATH="/deviceId"

die() { echo "${PROG}: FATAL: $*" >&2; exit "${EX_OP}"; }   # fail-closed (operational)

usage() {
  echo "usage: ${PROG}.sh [--expected-throughput <ru>] [--database-name <name>] <bundle.json|->" >&2
  echo "       consumes ONE 'read-back bundle' JSON (file or stdin) assembled from the live az read-backs" >&2
}

command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"

# The parity script (MG-53 step 3) lives next to this one. Resolve it relative to
# this script so the gate works from any CWD, and fail closed if it is absent or
# not executable — a definition assertion that cannot invoke its comparator has
# not run, and "could not compare" is never "definitions match".
HERE="$(cd "$(dirname "$0")" && pwd)" || die "could not resolve this script's directory"
PARITY="${HERE}/cosmos-definition-parity.sh"
[ -f "${PARITY}" ] || die "the definition-parity comparator is not next to this gate: ${PARITY} (MG-53 step 3). Refusing to report PASS on definition parity that could not be checked"
[ -r "${PARITY}" ] || die "the definition-parity comparator is not readable: ${PARITY}"

# --- 1. Arguments -----------------------------------------------------------
EXPECTED_THROUGHPUT="400"
DATABASE_NAME=""
INPUT=""
have_input=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --expected-throughput)
      [ "$#" -ge 2 ] || { usage; die "--expected-throughput requires a value"; }
      EXPECTED_THROUGHPUT="$2"; shift 2 ;;
    --expected-throughput=*)
      EXPECTED_THROUGHPUT="${1#--expected-throughput=}"; shift ;;
    --database-name)
      [ "$#" -ge 2 ] || { usage; die "--database-name requires a value"; }
      DATABASE_NAME="$2"; shift 2 ;;
    --database-name=*)
      DATABASE_NAME="${1#--database-name=}"; shift ;;
    -h|--help)
      usage
      exit "${EX_OP}" ;;   # fail-closed: help is not a passing assertion
    -)
      [ "${have_input}" -eq 0 ] || { usage; die "more than one input document given"; }
      have_input=1; INPUT=""; shift ;;
    -*)
      usage; die "unknown option: $1" ;;
    *)
      [ "${have_input}" -eq 0 ] || { usage; die "more than one input document given"; }
      have_input=1; INPUT="$1"; shift ;;
  esac
done

# The expected throughput must be a positive integer. A missing/garbage expectation
# is the vacuous-PASS class this file exists to close: a gate that "passes" because
# it had no number to compare against is not asserting anything.
case "${EXPECTED_THROUGHPUT}" in
  ''|*[!0-9]*) usage; die "--expected-throughput must be a positive integer (got '${EXPECTED_THROUGHPUT}')" ;;
esac
[ "${EXPECTED_THROUGHPUT}" -gt 0 ] || { usage; die "--expected-throughput must be greater than zero"; }

# --- 2. Load the bundle -----------------------------------------------------
SRC=""
JSON=""
if [ "${have_input}" -eq 1 ] && [ -n "${INPUT}" ]; then
  SRC="${INPUT}"
  [ -f "${INPUT}" ] || die "input not found: ${INPUT}"
  [ -r "${INPUT}" ] || die "input not readable: ${INPUT}"
  JSON="$(cat "${INPUT}")" || die "could not read input: ${INPUT}"
else
  SRC="stdin"
  JSON="$(cat)" || die "could not read the read-back bundle from stdin"
fi

# An empty read is NOT "nothing wrong". It is an assembly step that produced
# nothing — a failed login, a swallowed error, a wrong path. Fail closed.
[ -n "${JSON}" ] || die "no input (empty ${SRC}) — an unreadable read-back bundle is NOT a healthy destination; refusing to report PASS on assertions that never ran"

printf '%s\n' "${JSON}" | jq -e . >/dev/null 2>&1 || \
  die "input is not valid JSON (${SRC}) — refusing to report PASS on a bundle that could not be parsed"

# jqp <filter> — echo the jq result over the bundle, or the literal __PROBE_ERROR__
# if jq itself failed. Every structural probe below routes through this so a jq
# error is a FATAL, never a silently-empty value that could trip a vacuous PASS.
jqp() {
  printf '%s\n' "${JSON}" | jq -r "$1" 2>/dev/null || printf '%s\n' '__PROBE_ERROR__'
}

# jqpc <filter> — like jqp but compact JSON (-c), for extracting sub-documents.
jqpc() {
  printf '%s\n' "${JSON}" | jq -c "$1" 2>/dev/null || printf '%s\n' '__PROBE_ERROR__'
}

# --- 2b. Fail-closed structural validation ----------------------------------
top_type="$(jqp 'type')"
[ "${top_type}" = "__PROBE_ERROR__" ] && die "the top-level type probe failed on ${SRC} — refusing to inspect a bundle whose structure could not be validated"
[ "${top_type}" = "object" ] || die "unexpected bundle shape (${SRC}): top-level is '${top_type}', expected a JSON object"

db_type="$(jqp '(.database | type) // "null"')"
[ "${db_type}" = "__PROBE_ERROR__" ] && die "the .database probe failed on ${SRC}"
[ "${db_type}" = "object" ] || die "the bundle (${SRC}) has no '.database' object (got '${db_type}') — cannot assert the database-level offer. Fail-closed"

dbprobe_type="$(jqp '(.database.offerProbe | type) // "null"')"
[ "${dbprobe_type}" = "__PROBE_ERROR__" ] && die "the .database.offerProbe probe failed on ${SRC}"
[ "${dbprobe_type}" = "object" ] || die "the bundle (${SRC}) has no '.database.offerProbe' object (got '${dbprobe_type}') — the database offer outcome is the assertion; it must be represented. Fail-closed"

containers_type="$(jqp '(.containers | type) // "null"')"
[ "${containers_type}" = "__PROBE_ERROR__" ] && die "the .containers probe failed on ${SRC}"
[ "${containers_type}" = "array" ] || die "the bundle (${SRC}) has no '.containers' array (got '${containers_type}'). Fail-closed"

# The container SET must be EXACTLY the five expected names — no more, no fewer, no
# duplicates. A bundle that silently omits a container would let (b)/(c)/(d) "pass"
# by never running for it; a bundle with a duplicate name makes per-name lookup
# ambiguous. Both are the vacuous-PASS class. Compare canonical sorted name lists.
got_names="$(jqpc '[ .containers[]? | .name ] | sort')"
case "${got_names}" in *__PROBE_ERROR__*) die "the container-name probe failed on ${SRC}" ;; esac
want_names="$(printf '%s\n' "${EXPECTED_CONTAINERS}" | tr ' ' '\n' | jq -R . | jq -c -s 'sort' 2>/dev/null || printf '%s\n' '__PROBE_ERROR__')"
case "${want_names}" in *__PROBE_ERROR__*) die "internal error building the expected container-name set — refusing to compare against nothing" ;; esac
[ "${got_names}" = "${want_names}" ] || \
  die "the bundle (${SRC}) does not carry EXACTLY the five expected destination containers. expected=${want_names} got=${got_names} — a bundle missing/duplicating a container cannot be asserted (an omitted container would silently skip its offer/partition/parity checks). Fail-closed"

# Every container entry must be an object carrying a string name, a throughputProbe
# object, and definition + sourceDefinition objects. The per-container assertions
# ARE those fields; a malformed entry cannot be asserted against.
malformed="$(jqp '
  [ .containers[]
    | if type != "object" then 1
      elif ((.name | type) != "string") then 1
      elif ((.throughputProbe | type) != "object") then 1
      elif ((.throughputProbe.queryOk | type) != "boolean") then 1
      elif ((.throughputProbe.offerFound | type) != "boolean") then 1
      elif ((.definition | type) != "object") then 1
      elif ((.sourceDefinition | type) != "object") then 1
      else empty end
  ] | length
')"
case "${malformed}" in
  ''|*[!0-9]*) die "the container-shape probe failed on ${SRC} — refusing to report PASS on a bundle whose entries could not be validated" ;;
esac
[ "${malformed}" -eq 0 ] || \
  die "${malformed} container entr(y/ies) in ${SRC} are malformed (not an object with a string name, a throughputProbe{queryOk:bool,offerFound:bool}, and definition + sourceDefinition objects). Fail-closed"

# The database offer probe must likewise carry boolean queryOk/offerFound. Read
# each with an explicit type test, NEVER the jq `//` alternative operator: `false
# // x` yields x in jq (false is treated as empty), so `//` would misread the
# healthy offerFound=false case as a bad value. Fail-open by construction — avoided.
db_query_ok="$(jqp '.database.offerProbe | if (.queryOk | type) == "boolean" then (.queryOk | tostring) else "__BAD__" end')"
[ "${db_query_ok}" = "__PROBE_ERROR__" ] && die "the database queryOk probe failed on ${SRC}"
[ "${db_query_ok}" = "__BAD__" ] && die "the bundle (${SRC}) '.database.offerProbe.queryOk' is missing or not a boolean — the database offer outcome cannot be classified. Fail-closed"
db_offer_found="$(jqp '.database.offerProbe | if (.offerFound | type) == "boolean" then (.offerFound | tostring) else "__BAD__" end')"
[ "${db_offer_found}" = "__PROBE_ERROR__" ] && die "the database offerFound probe failed on ${SRC}"
[ "${db_offer_found}" = "__BAD__" ] && die "the bundle (${SRC}) '.database.offerProbe.offerFound' is missing or not a boolean. Fail-closed"

db_name="$(jqp '(.database.name // "") | tostring')"
[ "${db_name}" = "__PROBE_ERROR__" ] && die "the database-name probe failed on ${SRC}"

echo "${PROG}: asserting the LIVE MG-53 destination shared-throughput database (bundle=${SRC})"
[ -n "${db_name}" ] && echo "${PROG}: destination database name (from bundle): ${db_name}"
echo "${PROG}: expected database-level offer: ${EXPECTED_THROUGHPUT} RU/s (manual); expected containers: ${EXPECTED_CONTAINERS}"
echo

# Optional cross-check of the database name against a caller-supplied expectation
# (mirrors assert-live-host-storage.sh's --account-name: compares LIVE against
# DESIRED). Only enforced when the caller passes --database-name.
if [ -n "${DATABASE_NAME}" ]; then
  [ "${db_name}" = "${DATABASE_NAME}" ] || \
    die "the bundle's database name ('${db_name}') does not equal the expected --database-name ('${DATABASE_NAME}') — this bundle is not describing the database this run intended to assert. Fail-closed"
fi

# --- verdict accounting -----------------------------------------------------
violations=0
# Each assertion sets its marker to 1 ONLY after it reaches a recognised verdict.
# The final PASS requires all four markers AND zero violations, so no accept path
# is reachable by an assertion that did not provably run.
ran_db_offer=0
ran_container_offers=0
ran_partition_key=0
ran_parity=0

# report <subject> <reason> — a NAME/subject and a fixed reason. Never a secret.
report() {
  echo "  ✗ VIOLATION [${1}]" >&2
  echo "        reason: ${2}" >&2
  violations=$((violations + 1))
}

# --- 3. Assertion (a): the database-level offer at EXPECTED_THROUGHPUT RU/s ---
# The database offer probe must have RUN (queryOk). A probe that could not run is
# a FATAL — "could not tell whether a shared offer exists" is never "it exists".
[ "${db_query_ok}" = "true" ] || \
  die "the database-level offer probe did not run to a definite answer (queryOk=false) — this is an operational failure (auth/network/throttle/wrong name), NOT an absent offer. Fail-closed"

if [ "${db_offer_found}" = "true" ]; then
  # An offer exists — now it must be a MANUAL offer at exactly EXPECTED_THROUGHPUT.
  db_autoscale="$(jqp '((.database.offerProbe.document.resource.autoscaleSettings // null) != null) | tostring')"
  [ "${db_autoscale}" = "__PROBE_ERROR__" ] && die "the database autoscale probe failed on ${SRC}"
  db_ru="$(jqp '(.database.offerProbe.document.resource.throughput // null) | if type == "number" then tostring else "__BAD__" end')"
  [ "${db_ru}" = "__PROBE_ERROR__" ] && die "the database throughput probe failed on ${SRC}"
  if [ "${db_autoscale}" = "true" ]; then
    report "database-offer" "the destination database carries an AUTOSCALE offer, not the intended MANUAL ${EXPECTED_THROUGHPUT} RU/s shared offer. MG-53 provisions a single manual database-level offer; an autoscale offer is a different provisioning shape and is not what the code intends"
  elif [ "${db_ru}" = "__BAD__" ]; then
    die "the database offer exists but its '.resource.throughput' is missing or not a number in ${SRC} — cannot assert the RU/s. Fail-closed"
  elif [ "${db_ru}" != "${EXPECTED_THROUGHPUT}" ]; then
    report "database-offer" "the destination database-level offer is ${db_ru} RU/s, not the expected ${EXPECTED_THROUGHPUT} RU/s"
  else
    echo "  · database-offer: a manual database-level offer exists at ${db_ru} RU/s (expected ${EXPECTED_THROUGHPUT}) — shared throughput is configured at the DATABASE level"
  fi
else
  # offerFound=false with queryOk=true: the probe RAN and found NO database-level
  # offer. This is the core MG-53 defect (containers then each get their own offer).
  report "database-offer" "NO database-level shared-throughput offer exists on the destination database. Without a database-level offer, Cosmos gives each container its own 400 RU/s minimum offer (~2000 RU/s total) instead of the single shared ${EXPECTED_THROUGHPUT} RU/s the code intends — this is exactly the defect MG-53 exists to correct"
fi
ran_db_offer=1

# --- 4. Assertion (b): NO destination container holds a dedicated offer -------
# Iterate the fixed name list by VALUE. For each, the probe must have RUN; a probe
# that returns an offer is a VIOLATION; a probe that could not run is a FATAL.
for name in ${EXPECTED_CONTAINERS}; do
  # Read each boolean with an explicit type test, NOT the jq `//` operator (see the
  # database probe above: `false // x` yields x, which would misread the healthy
  # offerFound=false case). select() yields nothing on a name miss, so wrap in an
  # array and require exactly one match — a defence even though the name set is
  # already validated to be exactly the five expected.
  c_query_ok="$(printf '%s\n' "${JSON}" | jq -r --arg n "${name}" '
    [ .containers[] | select(.name == $n) ] as $m
    | if ($m | length) != 1 then "__BAD__"
      elif ($m[0].throughputProbe.queryOk | type) != "boolean" then "__BAD__"
      else ($m[0].throughputProbe.queryOk | tostring) end' 2>/dev/null || printf '%s\n' '__PROBE_ERROR__')"
  case "${c_query_ok}" in
    __PROBE_ERROR__|__BAD__) die "the throughput-probe outcome for container '${name}' could not be read from ${SRC} — refusing to report PASS on a per-container offer check that did not run" ;;
  esac
  c_offer_found="$(printf '%s\n' "${JSON}" | jq -r --arg n "${name}" '
    [ .containers[] | select(.name == $n) ] as $m
    | if ($m | length) != 1 then "__BAD__"
      elif ($m[0].throughputProbe.offerFound | type) != "boolean" then "__BAD__"
      else ($m[0].throughputProbe.offerFound | tostring) end' 2>/dev/null || printf '%s\n' '__PROBE_ERROR__')"
  case "${c_offer_found}" in
    __PROBE_ERROR__|__BAD__) die "the offerFound outcome for container '${name}' could not be read from ${SRC}" ;;
  esac

  [ "${c_query_ok}" = "true" ] || \
    die "the dedicated-offer probe for container '${name}' did not run to a definite answer (queryOk=false) — an unreadable probe is an operational failure, NEVER a pass. Fail-closed"

  if [ "${c_offer_found}" = "true" ]; then
    report "container-offer:${name}" "the destination container '${name}' holds its OWN dedicated throughput offer. In a shared-throughput database every container must draw on the single database-level offer and carry NONE of its own; a dedicated offer here means the container was created without sharing (or with a stray offer) and the destination is over-provisioned"
  else
    echo "  · container-offer:${name}: no dedicated offer (draws on the shared database-level offer)"
  fi
done
ran_container_offers=1

# --- 5. Assertion (c): temperatures partitions on /deviceId ------------------
# THIS gate is authoritative for the destination's create-only partition key (see
# the AUTHORITY SPLIT header). Read the destination temperatures container-show
# partition key paths and require them to equal exactly ["/deviceId"].
temp_pk="$(printf '%s\n' "${JSON}" | jq -c --arg n "${TEMPERATURES}" '
  (.containers[] | select(.name == $n) | .definition.resource.partitionKey.paths) // null' 2>/dev/null || printf '%s\n' '__PROBE_ERROR__')"
case "${temp_pk}" in
  __PROBE_ERROR__) die "the temperatures partition-key probe failed on ${SRC} — refusing to report PASS on the create-only partition key without reading it" ;;
esac
want_pk="$(printf '%s\n' "${DEVICEID_PATH}" | jq -R . | jq -c -s '.' 2>/dev/null || printf '%s\n' '__PROBE_ERROR__')"
case "${want_pk}" in *__PROBE_ERROR__*) die "internal error building the expected partition-key path set" ;; esac
if [ "${temp_pk}" = "null" ]; then
  die "the destination temperatures container definition carries no partition key paths in ${SRC} — a container-show read-back always does; this bundle is malformed. Fail-closed"
elif [ "${temp_pk}" = "${want_pk}" ]; then
  echo "  · partition-key:${TEMPERATURES}: on ${DEVICEID_PATH} (matches the IoT Hub endpoint's partition_key_name)"
else
  report "partition-key:${TEMPERATURES}" "the destination temperatures container partitions on ${temp_pk}, NOT ${want_pk}. This must match the IoT Hub Cosmos routing endpoint's partition_key_name = \"deviceId\" (MG-73), and a container's partition key path is CREATE-ONLY — an unrepairable mis-partition of an authentication-anchored trust boundary. The container must be rebuilt on ${DEVICEID_PATH}"
fi
ran_partition_key=1

# --- 6. Assertion (d): definitions match source (via the step-3 parity script) --
# For each container, extract the destination and source container-show documents
# and hand them to cosmos-definition-parity.sh. Its exit code is the verdict:
#   0 => faithful; 3 => a real definition DIFF (VIOLATION here); anything else =>
#   an operational failure in the comparator, which is a FATAL here (a comparison
#   that errored is never "definitions match").
TMPDIR_PARITY="$(mktemp -d 2>/dev/null)" || die "could not create a temp dir for the parity read-backs"
# Clean up the temp dir on any exit. Single-quoted so it expands at trap time.
trap 'rm -rf "${TMPDIR_PARITY}"' EXIT INT TERM

for name in ${EXPECTED_CONTAINERS}; do
  dst_file="${TMPDIR_PARITY}/${name}.destination.json"
  src_file="${TMPDIR_PARITY}/${name}.source.json"

  dst_doc="$(printf '%s\n' "${JSON}" | jq -c --arg n "${name}" '
    (.containers[] | select(.name == $n) | .definition) // empty' 2>/dev/null || printf '%s\n' '__PROBE_ERROR__')"
  case "${dst_doc}" in
    __PROBE_ERROR__|'') die "could not extract the destination definition for container '${name}' from ${SRC} — refusing to report parity on a document that could not be read" ;;
  esac
  src_doc="$(printf '%s\n' "${JSON}" | jq -c --arg n "${name}" '
    (.containers[] | select(.name == $n) | .sourceDefinition) // empty' 2>/dev/null || printf '%s\n' '__PROBE_ERROR__')"
  case "${src_doc}" in
    __PROBE_ERROR__|'') die "could not extract the source definition for container '${name}' from ${SRC}" ;;
  esac

  printf '%s\n' "${dst_doc}" > "${dst_file}" || die "could not stage the destination definition for '${name}'"
  printf '%s\n' "${src_doc}" > "${src_file}" || die "could not stage the source definition for '${name}'"

  # Invoke the comparator. Capture its exit code EXPLICITLY (do not let set -e or a
  # pipeline swallow it) and branch on the three recognised outcomes.
  parity_rc=0
  bash "${PARITY}" --source "${src_file}" --destination "${dst_file}" --label "${name}" || parity_rc=$?
  case "${parity_rc}" in
    0)
      echo "  · definition:${name}: faithful to source (parity script PASS)" ;;
    3)
      report "definition:${name}" "the destination container '${name}' definition is NOT faithful to its source (cosmos-definition-parity.sh reported a DIFF; the differing field(s) are named in its output above). A destination that differs from its source is not a valid destination" ;;
    *)
      die "the definition-parity comparison for container '${name}' did not run to a definite answer (cosmos-definition-parity.sh exited ${parity_rc}, an operational failure) — refusing to report PASS on definition parity that could not be checked. Fail-closed" ;;
  esac
done
ran_parity=1

# --- 7. Verdict -------------------------------------------------------------
# PASS is re-derived from all four assertions having provably RUN and the
# violation count being exactly zero. No future edit can reach PASS by
# decrementing a counter: each ran_* marker is set only after its assertion
# reached a recognised verdict, and every operational failure above already
# die()d with exit 1 before this point.
echo
if [ "${ran_db_offer}" -ne 1 ] || [ "${ran_container_offers}" -ne 1 ] || [ "${ran_partition_key}" -ne 1 ] || [ "${ran_parity}" -ne 1 ]; then
  die "not all four assertions provably ran (db_offer=${ran_db_offer} container_offers=${ran_container_offers} partition_key=${ran_partition_key} parity=${ran_parity}) — refusing to report a verdict on an incomplete assertion. This is a bug in this gate, and it fails closed by design"
fi

if [ "${violations}" -ne 0 ]; then
  echo "${PROG}: FAILED — ${violations} destination violation(s) named above. The MG-53 destination is NOT valid: fix the named defect(s) and re-run this gate. (A container's partition key path is create-only; a mis-partitioned temperatures container must be rebuilt, not edited.)" >&2
  exit "${EX_VIOLATION}"
fi

echo "${PROG}: PASS — a manual ${EXPECTED_THROUGHPUT} RU/s database-level offer exists, no destination container holds a dedicated offer, temperatures is on ${DEVICEID_PATH}, and all five destination definitions are faithful to their source."
exit 0
