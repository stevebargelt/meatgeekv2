#!/usr/bin/env bash
#
# cosmos-definition-parity.sh — FAIL-CLOSED comparison of two canonical Cosmos SQL
# container definitions (MG-53). It answers exactly one question: are a SOURCE
# container and a newly-created DESTINATION container DEFINITION-FAITHFUL to each
# other over the fields that define the container's shape — and NOTHING else?
#
# WHY THIS GATE EXISTS — read this before changing anything here.
# MG-53 creates a parallel shared-throughput database whose five containers must
# reproduce the source containers FAITHFULLY: same partition key, same indexing
# policy, same TTL, same unique keys, same conflict-resolution policy. A
# destination container that silently DRIFTS from its source is not a valid
# destination — and a container's partition key path in particular is CREATE-ONLY
# (Azure cannot repair it after the fact; MG-73's IoT routing endpoint
# materialises a top-level deviceId that MUST land on partition_key_paths
# ["/deviceId"]). The brief requires this parity be "RECORDED BY A SCRIPT THAT
# FAILS CLOSED, not asserted in prose." This is that script.
#
# CANONICAL-vs-CANONICAL, deliberately. Both inputs are the read-back Azure itself
# returns from `az cosmosdb sql container show` — NOT the Terraform config. Azure
# canonicalises a container definition on create (it drops the system `_etag`
# exclusion from the readable indexing policy, fills defaults, and fixes key
# order), so config-vs-live comparisons produce perpetual phantom diffs while
# live-vs-live compares the two definitions as Azure actually materialised them.
# The destination's fidelity is a property of what Azure BUILT, not of what the
# HCL asked for, so both sides are read from the same canonical surface.
#
# THROUGHPUT IS SCOPED OUT, ON PURPOSE. "Definition-faithful" for MG-53
# EXCLUDES throughput: the source temperatures container carries a dedicated
# 400 RU/s offer, and the destination deliberately carries NONE (it shares a
# single 400 RU/s DATABASE-level offer). A container's throughput is not even
# part of `az cosmosdb sql container show` — it is a separate offer resource read
# via `az cosmosdb sql container throughput show` — so it is absent from these
# documents by construction. This script reinforces that by extracting ONLY the
# scoped definition fields below and ignoring everything else, so a difference
# that is ONLY about throughput can never register as a definition diff. (The
# throughput assertions live in the post-create assertion script, not here.)
#
# WHAT IS COMPARED — EXACTLY these fields, from `.resource`, and no others:
#   1. partition key — paths (ORDER-SIGNIFICANT: hierarchical keys), kind, version
#   2. indexing policy:
#        · indexing mode          (case-folded — Azure canonicalises to lowercase)
#        · included paths         (compared as a SET — declaration order is not
#                                  semantically meaningful)
#        · excluded paths         (compared as a SET)
#        · composite indexes      (each index is ORDER-SIGNIFICANT internally — a
#                                  composite (deviceId ASC, timestamp DESC) is not
#                                  (timestamp DESC, deviceId ASC) — but the SET of
#                                  composite indexes is order-insensitive)
#   3. default TTL
#   4. unique key policy          (set of keys; each key's paths kept in order)
#   5. conflict-resolution policy (mode + path/procedure; null-safe — no source
#                                  container declares one, so Azure returns its
#                                  default on both sides and they match)
# Anything NOT in this list — throughput, rid/etag/ts system fields, the resource
# id, spatial indexes (not used by any container here), self/perms links — is
# deliberately NOT part of the parity contract and is ignored.
#
# ORDER NORMALISATION. Object key order is normalised on BOTH sides (deep key sort
# via the `dsort` jq def below) so a key-ordering difference in Azure's JSON can
# never masquerade as a definition diff, and arrays whose order is not meaningful
# (included/excluded paths, the set of composite indexes, the set of unique keys)
# are sorted by canonical value. Arrays whose order IS meaningful (partition key
# paths, the paths WITHIN one composite index, the paths WITHIN one unique key)
# are compared in place. The goal is: a real schema difference is ALWAYS a diff,
# and a mere serialisation difference is NEVER one.
#
# OUTPUT CONTRACT. A container-show document carries schema (partition paths,
# index paths, ttl) and Azure system fields — NO credentials, NO connection
# strings, NO keys (unlike the app-settings document assert-live-host-storage.sh
# consumes, this surface has nothing secret on it). So on a diff this gate DOES
# print the differing field's canonical value on both sides: that is the recorded
# comparison the brief asks for, and it is a schema fragment, not a secret.
#
# PORTABILITY IS A CORRECTNESS PROPERTY HERE, NOT A STYLE NOTE.
# Written to run IDENTICALLY under macOS's default /bin/bash 3.2.57, modern
# bash 5, and dash. No bash-4 case modification (${v,,}/${v^^}), no associative
# arrays, no `mapfile`, no `${!arr[@]}` index expansion, no here-strings (<<<), no
# process substitution, no `[[ ]]`. A gate that ERRORS on one shell while still
# reaching a PASS on another is FAIL-OPEN, and this repo has shipped exactly that
# bug before (a bash-4-only ${1,,} let a foreign connection string through). Case
# folding is done with jq's `ascii_downcase`, never a shell expansion; arrays are
# iterated by VALUE, never by index.
#
# EXIT CODES — a caller (scripts/assert-live-shared-throughput.sh) depends on the
# distinction between "the definitions genuinely differ" and "I could not tell".
#   0  PASS: the two definitions AGREE on every scoped field.
#   3  DIFF: the two definitions were both read and compared, and they DIFFER on
#      at least one scoped field. This is a real, provable definition drift; the
#      differing field name(s) are printed. A distinct code so a caller can tell a
#      genuine schema drift apart from an operational failure.
#   1  OPERATIONAL FAILURE / FAIL-CLOSED: anything that prevented the comparison
#      from provably running — no jq, a missing/unreadable/empty input, invalid
#      JSON, a document that is not a container-show object (wrong top-level type,
#      no `.resource`, no partition key, no indexing policy), or a jq probe that
#      itself errored. "Cannot tell" is NEVER "no difference": an assertion that
#      could not run is never reported as PASS.
#
# USAGE
#   cosmos-definition-parity.sh --source <src.json|-> --destination <dst.json|-> \
#       [--label <container-name>]
#   az cosmosdb sql container show ... -o json > src.json   # SOURCE read-back
#   az cosmosdb sql container show ... -o json > dst.json   # DESTINATION read-back
#   cosmos-definition-parity.sh --source src.json --destination dst.json --label temperatures
# At most ONE of --source/--destination may be `-` (stdin).
#
set -u
# pipefail is a bash/ksh feature; dash lacks it and would print an error and skew
# the exit code. Enable it only where supported — every pipeline below begins with
# printf, which cannot fail, so correctness never DEPENDS on it (defense in depth).
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

PROG="cosmos-definition-parity"

# Exit codes, spelled out once.
EX_DIFF=3
EX_OP=1

die() { echo "${PROG}: FATAL: $*" >&2; exit "${EX_OP}"; }   # fail-closed (operational)

usage() {
  echo "usage: ${PROG}.sh --source <src.json|-> --destination <dst.json|-> [--label <container-name>]" >&2
  echo "       compares two canonical 'az cosmosdb sql container show' documents; at most one may be '-' (stdin)" >&2
}

command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"

# --- jq prelude -------------------------------------------------------------
# `dsort` deep-sorts object keys (recursively) while PRESERVING array order, so a
# key-ordering difference in Azure's JSON cannot masquerade as a definition diff.
# Defined explicitly rather than relying on the `walk` builtin so this behaves the
# same on any jq >= 1.5.
JQ_PRELUDE='def dsort:
  if type == "object" then
    to_entries | sort_by(.key) | map({key: .key, value: (.value | dsort)}) | from_entries
  elif type == "array" then
    map(dsort)
  else . end;'

# field_filter <field-key> — echo the jq expression that extracts that scoped
# field, in canonical form, from a whole container-show document. A `case`, not an
# associative array, so this runs under bash 3.2 / dash.
#   * paths WITHIN a partition key / composite index / unique key keep their order
#     (order is meaningful there);
#   * the SET of included/excluded paths, composite indexes and unique keys is
#     sorted by canonical value (order is NOT meaningful there);
#   * object keys are deep-sorted via dsort on both sides.
field_filter() {
  case "$1" in
    partition_key)
      echo '{paths: (.resource.partitionKey.paths // []), kind: (.resource.partitionKey.kind // null), version: (.resource.partitionKey.version // null)} | dsort' ;;
    indexing_mode)
      echo '((.resource.indexingPolicy.indexingMode // null) | if type == "string" then ascii_downcase else . end)' ;;
    included_paths)
      echo '((.resource.indexingPolicy.includedPaths // []) | map(dsort) | sort_by(tojson))' ;;
    excluded_paths)
      echo '((.resource.indexingPolicy.excludedPaths // []) | map(dsort) | sort_by(tojson))' ;;
    composite_indexes)
      echo '((.resource.indexingPolicy.compositeIndexes // []) | map(map(dsort)) | sort_by(tojson))' ;;
    default_ttl)
      echo '(.resource.defaultTtl // null)' ;;
    unique_keys)
      echo '((.resource.uniqueKeyPolicy.uniqueKeys // []) | map({paths: (.paths // [])}) | sort_by(tojson))' ;;
    conflict_resolution_policy)
      echo '((.resource.conflictResolutionPolicy // null) | if . == null then null else dsort end)' ;;
    *)
      echo '' ;;
  esac
}

# The scoped field keys, iterated by VALUE (never by index). Order here is only
# the order diagnostics are printed in.
FIELDS="partition_key indexing_mode included_paths excluded_paths composite_indexes default_ttl unique_keys conflict_resolution_policy"

# --- 1. Arguments -----------------------------------------------------------
SRC_SPEC=""
DST_SPEC=""
LABEL="container"
have_src=0
have_dst=0
while [ "$#" -gt 0 ]; do
  case "$1" in
    --source)
      [ "$#" -ge 2 ] || { usage; die "--source requires a value"; }
      SRC_SPEC="$2"; have_src=1; shift 2 ;;
    --source=*)
      SRC_SPEC="${1#--source=}"; have_src=1; shift ;;
    --destination)
      [ "$#" -ge 2 ] || { usage; die "--destination requires a value"; }
      DST_SPEC="$2"; have_dst=1; shift 2 ;;
    --destination=*)
      DST_SPEC="${1#--destination=}"; have_dst=1; shift ;;
    --label)
      [ "$#" -ge 2 ] || { usage; die "--label requires a value"; }
      LABEL="$2"; shift 2 ;;
    --label=*)
      LABEL="${1#--label=}"; shift ;;
    -h|--help)
      usage
      exit "${EX_OP}" ;;   # fail-closed: help is not a passing assertion
    -*)
      usage; die "unknown option: $1" ;;
    *)
      usage; die "unexpected positional argument: $1 (use --source and --destination)" ;;
  esac
done

[ "${have_src}" -eq 1 ] && [ -n "${SRC_SPEC}" ] || { usage; die "--source is required and must be non-empty"; }
[ "${have_dst}" -eq 1 ] && [ -n "${DST_SPEC}" ] || { usage; die "--destination is required and must be non-empty"; }
if [ "${SRC_SPEC}" = "-" ] && [ "${DST_SPEC}" = "-" ]; then
  die "--source and --destination cannot both be '-' — only one document can be read from stdin"
fi

# --- 2. Load + fail-closed structural validation ----------------------------
# A container-show document is a JSON OBJECT whose `.resource` is an object
# carrying at least a partition key (with a non-empty paths array) and an indexing
# policy object. Anything else — {}, an array, a bare string, a document with no
# `.resource` — would let the extractors below yield defaulted-empty values on both
# sides and trip a vacuous PASS. Require the real shape before trusting anything.
read_spec() {
  # read_spec <spec> <role> — echoes the JSON; die on any read failure. Only the
  # role name and the (non-secret) path are ever printed.
  rs_spec="$1"; rs_role="$2"
  if [ "${rs_spec}" = "-" ]; then
    cat || die "could not read the ${rs_role} document from stdin"
  else
    [ -f "${rs_spec}" ] || die "${rs_role} input not found: ${rs_spec}"
    [ -r "${rs_spec}" ] || die "${rs_role} input not readable: ${rs_spec}"
    cat "${rs_spec}" || die "could not read ${rs_role} input: ${rs_spec}"
  fi
}

validate_doc() {
  # validate_doc <json> <name> <role> — fail-closed structural checks.
  vd_json="$1"; vd_name="$2"; vd_role="$3"

  [ -n "${vd_json}" ] || die "the ${vd_role} document (${vd_name}) is EMPTY — an unreadable container read-back is NOT an empty definition; refusing to compare against nothing"

  printf '%s\n' "${vd_json}" | jq -e . >/dev/null 2>&1 || \
    die "the ${vd_role} document (${vd_name}) is not valid JSON — refusing to compare a document that could not be parsed"

  vd_top="$(printf '%s\n' "${vd_json}" | jq -r 'type' 2>/dev/null || echo "__PROBE_ERROR__")"
  [ "${vd_top}" = "__PROBE_ERROR__" ] && die "the top-level type probe failed on the ${vd_role} document (${vd_name}) — refusing to compare a document whose structure could not be validated"
  [ "${vd_top}" = "object" ] || die "the ${vd_role} document (${vd_name}) top-level is '${vd_top}', not the JSON object that 'az cosmosdb sql container show' emits — refusing to inspect it"

  vd_res="$(printf '%s\n' "${vd_json}" | jq -r '(.resource | type) // "null"' 2>/dev/null || echo "__PROBE_ERROR__")"
  [ "${vd_res}" = "__PROBE_ERROR__" ] && die "the .resource probe failed on the ${vd_role} document (${vd_name})"
  [ "${vd_res}" = "object" ] || die "the ${vd_role} document (${vd_name}) has no '.resource' object (got '${vd_res}') — a container-show document carries its definition under .resource; refusing to compare"

  vd_pk="$(printf '%s\n' "${vd_json}" | jq -r '(.resource.partitionKey.paths | type) // "null"' 2>/dev/null || echo "__PROBE_ERROR__")"
  [ "${vd_pk}" = "__PROBE_ERROR__" ] && die "the partition-key probe failed on the ${vd_role} document (${vd_name})"
  [ "${vd_pk}" = "array" ] || die "the ${vd_role} document (${vd_name}) has no partition key paths array (got '${vd_pk}') — every container has a partition key; a document missing it is malformed. Fail-closed"

  vd_pkn="$(printf '%s\n' "${vd_json}" | jq -r '(.resource.partitionKey.paths | length)' 2>/dev/null || echo "__PROBE_ERROR__")"
  case "${vd_pkn}" in
    ''|*[!0-9]*) die "the partition-key length probe returned a non-numeric result on the ${vd_role} document (${vd_name})" ;;
  esac
  [ "${vd_pkn}" -gt 0 ] || die "the ${vd_role} document (${vd_name}) has an EMPTY partition key paths array — a container cannot have zero partition key paths; this is a malformed read-back. Fail-closed"

  vd_ip="$(printf '%s\n' "${vd_json}" | jq -r '(.resource.indexingPolicy | type) // "null"' 2>/dev/null || echo "__PROBE_ERROR__")"
  [ "${vd_ip}" = "__PROBE_ERROR__" ] && die "the indexing-policy probe failed on the ${vd_role} document (${vd_name})"
  [ "${vd_ip}" = "object" ] || die "the ${vd_role} document (${vd_name}) has no '.resource.indexingPolicy' object (got '${vd_ip}') — refusing to compare an indexing policy that is not present. Fail-closed"
}

SRC_NAME="${SRC_SPEC}"
[ "${SRC_SPEC}" = "-" ] && SRC_NAME="stdin(source)"
DST_NAME="${DST_SPEC}"
[ "${DST_SPEC}" = "-" ] && DST_NAME="stdin(destination)"

SRC_JSON="$(read_spec "${SRC_SPEC}" "source")"
DST_JSON="$(read_spec "${DST_SPEC}" "destination")"

validate_doc "${SRC_JSON}" "${SRC_NAME}" "source"
validate_doc "${DST_JSON}" "${DST_NAME}" "destination"

echo "${PROG}: comparing definitions for '${LABEL}' (source=${SRC_NAME}, destination=${DST_NAME})"
echo "${PROG}: throughput is deliberately OUT of scope — only definition fields are compared"

# --- 3. Field-by-field comparison -------------------------------------------
# canon <json> <field-filter> — echoes the canonical serialisation of one scoped
# field, or the literal __PROBE_ERROR__ if jq failed. dsort/`-c` make the output
# order-normalised, so a byte comparison of two canon outputs is a semantic
# comparison of the field.
canon() {
  printf '%s\n' "$1" | jq -c "${JQ_PRELUDE} $2" 2>/dev/null || printf '%s\n' '__PROBE_ERROR__'
}

diffs=0
for field in ${FIELDS}; do
  filter="$(field_filter "${field}")"
  [ -n "${filter}" ] || die "internal error: no jq filter defined for scoped field '${field}' — refusing to report PASS on a comparison that skipped a field"

  s_val="$(canon "${SRC_JSON}" "${filter}")"
  d_val="$(canon "${DST_JSON}" "${filter}")"

  case "${s_val}" in *__PROBE_ERROR__*) die "the '${field}' probe failed on the source document (${SRC_NAME}) — refusing to report parity on a comparison that did not provably run" ;; esac
  case "${d_val}" in *__PROBE_ERROR__*) die "the '${field}' probe failed on the destination document (${DST_NAME}) — refusing to report parity on a comparison that did not provably run" ;; esac

  if [ "${s_val}" = "${d_val}" ]; then
    echo "  · ${field}: match"
  else
    echo "  ✗ DIFF [${field}] — source and destination definitions differ" >&2
    echo "        source:      ${s_val}" >&2
    echo "        destination: ${d_val}" >&2
    diffs=$((diffs + 1))
  fi
done

# --- 4. Verdict -------------------------------------------------------------
# The PASS is derived from the diff counter being provably 0 AFTER every field was
# compared without a probe error (any probe error would have die()d above). No
# accept path is reachable without every field's comparison having run.
echo
if [ "${diffs}" -ne 0 ]; then
  echo "${PROG}: DIFF — the destination '${LABEL}' container definition is NOT faithful to the source: ${diffs} scoped field(s) differ (named above). A destination that differs from its source is not a valid destination." >&2
  exit "${EX_DIFF}"
fi
echo "${PROG}: PASS — the destination '${LABEL}' container definition is faithful to the source across all scoped fields (throughput excluded by design)."
exit 0
