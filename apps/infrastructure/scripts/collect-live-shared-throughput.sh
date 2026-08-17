#!/usr/bin/env bash
#
# collect-live-shared-throughput.sh — the LIVE COLLECTOR half of the MG-53
# post-create assertion. It runs the `az cosmosdb sql ...` read-backs against the
# freshly-created destination and assembles the SINGLE "read-back bundle" JSON
# document that scripts/assert-live-shared-throughput.sh consumes on stdin.
#
# WHY THIS EXISTS — read this before changing anything here.
# assert-live-shared-throughput.sh is authored fail-closed and portable, but it
# consumes a pre-assembled bundle and asserts nothing on its own: it must be RUN,
# against the live destination, with the bundle actually populated from Azure. A
# fail-closed gate that is never executed is fail-OPEN — the degenerate case of the
# very invariant MG-53 protects ("an assertion that could not run is never a
# PASS"). This script is the missing collector: the apply job (infra-apply-dev.yml)
# runs it after the create and pipes its stdout straight into the gate. It mirrors
# the MG-58 precedent, where the live `az functionapp config appsettings list`
# read-back is piped into scripts/assert-live-host-storage.sh.
#
# THE COLLECTOR/GATE SEAM IS DELIBERATE AND MUST BE KEPT. The gate is a pure
# function of a bundle: no Azure, no `az`, no credentials — which is exactly what
# lets run-assert-live-shared-throughput-fixtures.sh regression-test it credential-
# less in CI. This collector holds ALL the live coupling. Do NOT fold the az calls
# into the gate; do NOT teach the gate to reach the network. The seam is what makes
# the gate testable, and run-collect-live-shared-throughput-fixtures.sh in turn
# tests THIS collector credential-less by overriding AZ_BIN with a fake `az`.
#
# WHAT IT COLLECTS, into the bundle shape the gate documents (see that file's INPUT
# section — this is the producer of exactly that document):
#   (a) DATABASE OFFER — `az cosmosdb sql database throughput show` on the
#       destination database. The OUTCOME is the assertion: a database with NO
#       shared offer makes this command EXIT NONZERO rather than return JSON, so
#       the outcome is carried explicitly as offerProbe.{queryOk,offerFound} and,
#       when found, the full read-back as offerProbe.document.
#   (b) PER-CONTAINER OFFER — `az cosmosdb sql container throughput show` for each
#       of the five destination containers. Same outcome encoding: a container with
#       NO dedicated offer (the healthy shared case) exits nonzero, recorded as
#       throughputProbe.{queryOk:true, offerFound:false}.
#   (c/d) DEFINITIONS — `az cosmosdb sql container show` for each container against
#       BOTH the destination database (definition) and the source database
#       (sourceDefinition). These MUST succeed and return a `.resource` object; a
#       container-show that cannot be read is an operational failure here (the gate
#       cannot assert a partition key or definition parity it never received), so
#       this collector FAILS CLOSED on it rather than emitting a bundle the gate
#       would have to reject as malformed.
#
# QUERYOK/OFFERFOUND CLASSIFICATION IS FAIL-CLOSED. The gate's contract is that
# "could not tell" (queryOk=false) is NEVER "nothing wrong". A throughput-show that
# exits nonzero is classified offerFound=false ONLY when its stderr carries a
# recognised OFFER-absence marker (the real no-offer case) AND carries NO
# target-existence marker. The distinction is load-bearing: a probe aimed at the
# wrong account, resource group, subscription or resource returns an ARM
# not-found ("ResourceNotFound", "ResourceGroupNotFound", "could not be found",
# "the Resource ... was not found") whose tokens overlap a bare "not found" — and
# reading THAT as an absent offer would turn "we could not look at the right
# target" into the strongest success claim ("we looked and it shares the offer").
# So a target-existence not-found, like any other nonzero exit — not logged in,
# network, throttled, a 5xx — is classified queryOk=false, which the gate then
# fails closed on. Unrecognised is never read as "no offer", and neither is a
# mistargeted probe. An exit-0 database probe that does not carry a numeric
# `.resource.throughput` is likewise queryOk=false: a success we cannot interpret
# is not an interpretation.
#
# OUTPUT — NAMES, SCHEMA AND RU/s NUMBERS, NEVER SECRETS. A container-show document
# and a throughput offer carry schema and RU/s integers, not credentials or
# connection strings (the destination account has local auth disabled, MG-24). The
# assembled bundle is the same class of content the gate already prints on a diff,
# so it is safe to pipe through a retained CI log — same rule as MG-58, where the
# app-settings document (which DOES carry values) is piped straight into the gate's
# stdin and never written to disk. This collector emits ONLY the bundle on stdout;
# all progress goes to stderr and names containers/fields only.
#
# PORTABILITY. Written to run identically under macOS's default /bin/bash 3.2.57,
# modern bash 5 and dash: no bash-4 case modification, no associative arrays, no
# `mapfile`, no `${!arr[@]}`, no here-strings, no process substitution, no `[[ ]]`.
# The container set is iterated by VALUE from a fixed space-separated list.
#
# EXIT CODES
#   0  the bundle was assembled and written to stdout. This is NOT a verdict on the
#      destination — the gate renders that. It only means collection succeeded.
#   1  OPERATIONAL FAILURE / FAIL-CLOSED: missing/empty required argument, no jq, a
#      container-show that could not be read, or a bundle that could not be
#      assembled. Nothing is written to stdout on this path.
#
# USAGE
#   collect-live-shared-throughput.sh \
#       --account-name <cosmos-account> --resource-group <rg> \
#       --database-name <destination-db> --source-database-name <source-db> \
#       [--containers "cooks users recipes temperatures devices"]
#   AZ_BIN=/path/to/fake-az collect-live-shared-throughput.sh ...   # testing seam
#
set -u

PROG="collect-live-shared-throughput"

EX_OP=1

# The `az` binary, overridable so the fixture harness can inject a fake that
# returns canned read-backs and exit codes — the same seam that keeps this
# collector testable without Azure or credentials.
AZ_BIN="${AZ_BIN:-az}"

# The five destination containers, spelled out ONCE and iterated by VALUE. This is
# the SAME set the gate validates the bundle carries exactly; keep them in sync.
DEFAULT_CONTAINERS="cooks users recipes temperatures devices"

die() { echo "${PROG}: FATAL: $*" >&2; exit "${EX_OP}"; }

usage() {
  echo "usage: ${PROG}.sh --account-name <acct> --resource-group <rg> --database-name <dest-db> --source-database-name <src-db> [--containers \"<names>\"]" >&2
}

command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"

# --- 1. Arguments -----------------------------------------------------------
ACCOUNT_NAME=""
RESOURCE_GROUP=""
DATABASE_NAME=""
SOURCE_DATABASE_NAME=""
CONTAINERS="${DEFAULT_CONTAINERS}"
while [ "$#" -gt 0 ]; do
  case "$1" in
    --account-name)         [ "$#" -ge 2 ] || { usage; die "--account-name requires a value"; };         ACCOUNT_NAME="$2"; shift 2 ;;
    --account-name=*)       ACCOUNT_NAME="${1#--account-name=}"; shift ;;
    --resource-group)       [ "$#" -ge 2 ] || { usage; die "--resource-group requires a value"; };        RESOURCE_GROUP="$2"; shift 2 ;;
    --resource-group=*)     RESOURCE_GROUP="${1#--resource-group=}"; shift ;;
    --database-name)        [ "$#" -ge 2 ] || { usage; die "--database-name requires a value"; };          DATABASE_NAME="$2"; shift 2 ;;
    --database-name=*)      DATABASE_NAME="${1#--database-name=}"; shift ;;
    --source-database-name) [ "$#" -ge 2 ] || { usage; die "--source-database-name requires a value"; };   SOURCE_DATABASE_NAME="$2"; shift 2 ;;
    --source-database-name=*) SOURCE_DATABASE_NAME="${1#--source-database-name=}"; shift ;;
    --containers)           [ "$#" -ge 2 ] || { usage; die "--containers requires a value"; };             CONTAINERS="$2"; shift 2 ;;
    --containers=*)         CONTAINERS="${1#--containers=}"; shift ;;
    -h|--help)              usage; exit "${EX_OP}" ;;
    *)                      usage; die "unknown or unexpected argument: $1" ;;
  esac
done

[ -n "${ACCOUNT_NAME}" ]         || { usage; die "--account-name is required and must be non-empty — refusing to collect against an unresolved account"; }
[ -n "${RESOURCE_GROUP}" ]       || { usage; die "--resource-group is required and must be non-empty"; }
[ -n "${DATABASE_NAME}" ]        || { usage; die "--database-name (the destination database) is required and must be non-empty"; }
[ -n "${SOURCE_DATABASE_NAME}" ] || { usage; die "--source-database-name is required and must be non-empty — definition parity compares each destination container against its SOURCE twin"; }
[ -n "${CONTAINERS}" ]           || { usage; die "--containers must be non-empty"; }

command -v "${AZ_BIN}" >/dev/null 2>&1 || die "the az CLI ('${AZ_BIN}') is not on PATH — a collector that cannot read Azure cannot assemble a bundle. Fail-closed"

WORK="$(mktemp -d 2>/dev/null)" || die "could not create a temp working dir"
trap 'rm -rf "${WORK}"' EXIT INT TERM

echo "${PROG}: collecting the LIVE MG-53 destination read-backs (account=${ACCOUNT_NAME} rg=${RESOURCE_GROUP} dest-db=${DATABASE_NAME} src-db=${SOURCE_DATABASE_NAME})" >&2

# target_absent_marker <stderr-file> — 0 iff the captured az stderr indicates the
# TARGET ITSELF (the account, resource group, subscription, or the ARM resource the
# probe was aimed at) could not be resolved, as opposed to a throughput offer that
# legitimately does not exist. These are ARM/management-plane not-found signals
# (ResourceNotFound, ResourceGroupNotFound, "could not be found", "the Resource ...
# was not found") and they mean we probed the WRONG place — never that the offer is
# absent. Kept separate from the offer signal precisely so a mistargeted probe fails
# closed instead of being read as a healthy shared container.
target_absent_marker() {
  grep -iE 'resourcenotfound|resource not found|resourcegroupnotfound|subscriptionnotfound|databaseaccountnotfound|the resource .* was not found|resource group .* (could not be found|not found|was not found)|could not be found' "$1" >/dev/null 2>&1
}

# offer_absent_marker <stderr-file> — 0 iff the captured az stderr carries the
# specific "the throughput OFFER does not exist" signal (the real no-offer case): a
# container/database that SHARES throughput rather than holding its own offer makes
# `az ... throughput show` 404 the offer entity. This is the DocumentDB data-plane
# "Entity with the specified id does not exist" 404, distinct from the ARM
# target-existence errors above.
offer_absent_marker() {
  grep -iE 'entity with the specified id does not exist|throughput is not defined|no throughput|the offer .* (does not exist|not found|was not found)|throughput .* (does not exist|not found)' "$1" >/dev/null 2>&1
}

# notfound_marker <stderr-file> — 0 iff this is a GENUINE absent-offer outcome: an
# offer-absence signal AND NO target-existence signal. A broad "not found" that names
# an absent account/resource-group/subscription/resource is NOT "no offer" — we could
# not read the intended target, so it fails closed (queryOk=false), which is exactly
# what the contract requires ("could not tell" is never "nothing wrong"). Narrow and
# explicit on both sides: an UNRECOGNISED failure is never classified as "no offer",
# and neither is a mistargeted probe that happens to carry a not-found token.
notfound_marker() {
  if target_absent_marker "$1"; then
    return 1
  fi
  offer_absent_marker "$1"
}

# --- 2. Database-level offer probe (assertion a) ----------------------------
DB_OUT="${WORK}/db-offer.out"
DB_ERR="${WORK}/db-offer.err"
"${AZ_BIN}" cosmosdb sql database throughput show \
  --account-name "${ACCOUNT_NAME}" --resource-group "${RESOURCE_GROUP}" \
  --name "${DATABASE_NAME}" --output json >"${DB_OUT}" 2>"${DB_ERR}"
db_rc=$?

if [ "${db_rc}" -eq 0 ]; then
  # Success — it must carry a numeric .resource.throughput to be interpretable.
  if jq -e '(.resource.throughput | type) == "number"' "${DB_OUT}" >/dev/null 2>&1; then
    DB_JSON="$(jq -n --arg name "${DATABASE_NAME}" --slurpfile doc "${DB_OUT}" \
      '{name:$name, offerProbe:{queryOk:true, offerFound:true, document:$doc[0]}}')" \
      || die "could not assemble the database offer probe result"
    echo "${PROG}: database offer: present (queryOk=true, offerFound=true)" >&2
  else
    DB_JSON="$(jq -n --arg name "${DATABASE_NAME}" \
      '{name:$name, offerProbe:{queryOk:false, offerFound:false}}')" \
      || die "could not assemble the database offer probe result"
    echo "${PROG}: database offer: az returned success but no numeric .resource.throughput — classifying queryOk=false (fail-closed)" >&2
  fi
elif notfound_marker "${DB_ERR}"; then
  DB_JSON="$(jq -n --arg name "${DATABASE_NAME}" \
    '{name:$name, offerProbe:{queryOk:true, offerFound:false}}')" \
    || die "could not assemble the database offer probe result"
  echo "${PROG}: database offer: absent (queryOk=true, offerFound=false) — the gate will render this as a violation" >&2
else
  DB_JSON="$(jq -n --arg name "${DATABASE_NAME}" \
    '{name:$name, offerProbe:{queryOk:false, offerFound:false}}')" \
    || die "could not assemble the database offer probe result"
  echo "${PROG}: database offer: probe did not run to a definite answer (queryOk=false) — unrecognised az failure, NOT an absent offer" >&2
fi

# --- 3. Per container: throughput probe (b) + definitions (c/d) --------------
ENTRIES="${WORK}/entries.jsonl"
: > "${ENTRIES}"

for name in ${CONTAINERS}; do
  # (b) dedicated-offer probe. Same outcome encoding as the database probe.
  C_ERR="${WORK}/${name}-tp.err"
  "${AZ_BIN}" cosmosdb sql container throughput show \
    --account-name "${ACCOUNT_NAME}" --resource-group "${RESOURCE_GROUP}" \
    --database-name "${DATABASE_NAME}" --name "${name}" \
    --output json >/dev/null 2>"${C_ERR}"
  c_rc=$?
  if [ "${c_rc}" -eq 0 ]; then
    c_queryok=true;  c_offerfound=true
    echo "${PROG}: container '${name}': holds a dedicated offer (offerFound=true) — the gate will render this as a violation" >&2
  elif notfound_marker "${C_ERR}"; then
    c_queryok=true;  c_offerfound=false
    echo "${PROG}: container '${name}': no dedicated offer (offerFound=false) — shares the database-level offer" >&2
  else
    c_queryok=false; c_offerfound=false
    echo "${PROG}: container '${name}': throughput probe did not run to a definite answer (queryOk=false) — the gate fails closed on this" >&2
  fi

  # (c/d) definitions — destination and source container-show. These MUST succeed
  # and carry a .resource object; a definition the gate never received is an
  # operational failure, not "definitions match".
  DEF="${WORK}/${name}-dst.json"
  SRCDEF="${WORK}/${name}-src.json"
  "${AZ_BIN}" cosmosdb sql container show \
    --account-name "${ACCOUNT_NAME}" --resource-group "${RESOURCE_GROUP}" \
    --database-name "${DATABASE_NAME}" --name "${name}" \
    --output json >"${DEF}" 2>"${WORK}/${name}-dst.err"
  def_rc=$?
  [ "${def_rc}" -eq 0 ] || die "could not read the destination definition for container '${name}' (az cosmosdb sql container show exited ${def_rc}) — refusing to assemble a bundle missing a definition the gate must assert on. Fail-closed"
  jq -e '(.resource | type) == "object"' "${DEF}" >/dev/null 2>&1 \
    || die "the destination container-show for '${name}' returned no .resource object — this is not a container-show document. Fail-closed"

  "${AZ_BIN}" cosmosdb sql container show \
    --account-name "${ACCOUNT_NAME}" --resource-group "${RESOURCE_GROUP}" \
    --database-name "${SOURCE_DATABASE_NAME}" --name "${name}" \
    --output json >"${SRCDEF}" 2>"${WORK}/${name}-src.err"
  srcdef_rc=$?
  [ "${srcdef_rc}" -eq 0 ] || die "could not read the SOURCE definition for container '${name}' (az cosmosdb sql container show exited ${srcdef_rc} against source db '${SOURCE_DATABASE_NAME}') — definition parity needs both twins. Fail-closed"
  jq -e '(.resource | type) == "object"' "${SRCDEF}" >/dev/null 2>&1 \
    || die "the source container-show for '${name}' returned no .resource object. Fail-closed"

  jq -n --arg n "${name}" --argjson qok "${c_queryok}" --argjson off "${c_offerfound}" \
    --slurpfile dstdoc "${DEF}" --slurpfile srcdoc "${SRCDEF}" \
    '{name:$n, throughputProbe:{queryOk:$qok, offerFound:$off}, definition:$dstdoc[0], sourceDefinition:$srcdoc[0]}' \
    >> "${ENTRIES}" \
    || die "could not assemble the bundle entry for container '${name}'"
done

# --- 4. Assemble and emit the single bundle ---------------------------------
CONTAINERS_JSON="$(jq -s '.' "${ENTRIES}")" || die "could not assemble the containers array"
jq -n --argjson database "${DB_JSON}" --argjson containers "${CONTAINERS_JSON}" \
  '{database:$database, containers:$containers}' \
  || die "could not assemble the final read-back bundle"

echo "${PROG}: assembled the read-back bundle for ${DATABASE_NAME} (5 containers) — piping to the assertion gate" >&2
exit 0
