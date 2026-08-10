#!/usr/bin/env bash
#
# run-live-host-storage-fixtures.sh — deterministic regression harness for the
# fail-closed LIVE host-storage gate (MG-58 guard 3 and guard 4).
#
# Exercises scripts/assert-live-host-storage.sh against the committed
# live-appsettings-* fixtures next to this script and asserts each expected EXIT
# CODE. No Azure, no credentials, no `terraform` binary and no `az` — the gate
# consumes an `az functionapp config appsettings list` document, and every
# fixture here IS one.
#
# WHY THIS HARNESS EXISTS, AND WHY IT IS SEPARATE FROM THE FLEX ONE.
# MG-58's defect was never representable on any surface Terraform exposes: the
# pinned azurerm provider composes and WRITES the scalar `AzureWebJobsStorage`
# connection string on every Function App create and update, then routes it out
# of app_settings on read, so it is absent from HCL, from the plan document and
# from state by construction. Every config-surface guard this repo had was green
# while the live site carried the key. run-flex-secret-gate-fixtures.sh drives
# the CONFIG-surface gate against `terraform show -json` documents; this one
# drives the LIVE-surface gate against settings documents. Different gate,
# different input shape, different failure class — so a separate harness, the
# same precedent as the destroy-guard and cross-module-propagation runners.
#
# GUARD 3 IS PROVEN BY MUTATION, NOT BY ASSERTION. live-appsettings-clean.json
# and live-appsettings-scalar-injected.json differ by EXACTLY ONE KEY — the
# scalar `AzureWebJobsStorage` — and that difference is machine-checked below
# (the [pair] case), not merely claimed in a comment. The injected value is
# byte-identical to the string observed on the live dev site, empty AccountKey
# and all, so the negative control is the REAL defect rather than a synthetic
# stand-in. A fixture edit that defangs either end of the pair turns the [pair]
# or [shape] case red BEFORE any exit code changes, which is the point: an exit
# code cannot detect a control that has quietly stopped controlling anything
# (absence of a key is exactly what a PASS looks like).
#
# EXIT CODES ARE ASSERTED EXACTLY, not merely as pass/nonzero. The dev apply
# job's bounded remediation keys off the distinction: 3 means "the scalar key is
# present, delete that ONE setting on that ONE app and re-assert", while 1 means
# every other violation and every operational failure. A harness that accepted
# any nonzero would let 3 and 1 swap without noticing, and the workflow would
# then either stop remediating a remediable defect or start deleting settings in
# response to an unreadable document.
#
# DUAL SHELL. Every case runs under BOTH bash and sh. This is a SECURITY
# property, not a style one: a gate that ERRORs under one shell while still
# reaching a PASS is fail-open, and this repo has already shipped exactly that
# bug once (the bash-4-only ${1,,} in tf-plan-secret-inspection.sh).
#
# COUNTING. Checks are tracked PER SHELL against a floor, and the per-shell
# counts must be EQUAL. A harness that silently runs fewer cases than it
# advertises — a vanished fixture, a skipped shell, a subshell that swallowed
# the loop — is the same class of fail-open as the gate holes it exists to
# catch.
#
# SOME CASES ARE GENERATED AT RUN TIME into a temp dir rather than committed.
# The structural fail-closed inputs (wrong top-level type, invalid JSON, empty
# array, empty file, absent path) and the two exact-matching probes are
# one-liners derived from the committed clean fixture; deriving them keeps them
# from drifting away from it, and keeps the committed fixture set to the six
# documents that carry real meaning.
#
# Exit 0 iff every case behaves as expected under every shell AND the counts hold.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="${HERE}/../assert-live-host-storage.sh"

[ -f "${GATE}" ] || { echo "FATAL: gate not found: ${GATE}" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq is required by this harness (and by the gate)" >&2; exit 2; }

# The account name the clean fixture claims, i.e. what a caller would have
# resolved from `terraform output -raw`. Passed as --account-name on every case
# except the ones deliberately probing a wrong/absent expectation.
ACCOUNT="mgv2dev13bd19e9f03d"
WRONG_ACCOUNT="mgv2devsomeotheraccount"

# The scalar value observed on the LIVE dev site on 2026-08-09 before the manual
# repair, recorded byte-for-byte. It carries NO key material: the AccountKey
# field is EMPTY, which is the whole point — the provider composes this string
# from the `storage_access_key` attribute, and that attribute is empty under
# storage_authentication_type = SystemAssignedIdentity. It is a forensic
# fingerprint of provider injection, NOT a credential and NOT a restore path.
LIVE_SCALAR_VALUE='DefaultEndpointsProtocol=https;AccountName=mgv2dev13bd19e9f03d;AccountKey=;EndpointSuffix=core.windows.net'

SCALAR_KEY="AzureWebJobsStorage"
IDENTITY_KEY="AzureWebJobsStorage__accountName"
SENTINEL='MGSENTINELDONOTLOG'

CLEAN="${HERE}/live-appsettings-clean.json"
INJECTED="${HERE}/live-appsettings-scalar-injected.json"
MISMATCH="${HERE}/live-appsettings-accountname-mismatch.json"
SENTINEL_FIXTURE="${HERE}/live-appsettings-sentinel.json"

# CASE-VARIANT CONTROLS. App Service app-setting names are CASE-INSENSITIVE, so
# each of these documents carries THE FORBIDDEN SCALAR SETTING just as surely as
# live-appsettings-scalar-injected.json does — the Functions host resolves any of
# them ahead of the identity form. A case-SENSITIVE gate returned PASS on exactly
# this shape, which meant the apply job took its clean branch and never
# remediated: a fail-open in the one gate authoritative for this defect class.
# These are committed rather than derived because the fixture pair IS the proof.
LOWERCASE="${HERE}/live-appsettings-scalar-lowercase.json"
UPPERCASE="${HERE}/live-appsettings-scalar-uppercase.json"
MIXEDCASE="${HERE}/live-appsettings-scalar-mixedcase.json"

for required in "${CLEAN}" "${INJECTED}" "${MISMATCH}" "${SENTINEL_FIXTURE}" \
                "${LOWERCASE}" "${UPPERCASE}" "${MIXEDCASE}"; do
  [ -f "${required}" ] || { echo "FATAL: required fixture missing: ${required}" >&2; exit 2; }
done

# Fixture cases: "<fixture> <expected-exit-code> <mode> <dump>" rows.
# POSIX-portable, no arrays.
#   expected-exit-code: asserted EXACTLY. 0 pass, 3 scalar key present
#                       (remediable), 1 everything else including every
#                       operational failure.
#   mode: "file"   => pass the fixture path as an argument.
#         "stdin"  => pipe it in, the shape the apply workflow actually uses.
#         "dash"   => pipe it in and pass an explicit `-`.
#   dump: "dump"  => on an unexpected result, print the gate's output to help
#                    diagnose. "quiet" => print only the exit code, because the
#                    fixture is sentinel-laden and echoing a suspected leak into
#                    this harness's own log would reproduce the very failure the
#                    redaction cases exist to detect.
CASES="
live-appsettings-clean.json 0 file dump
live-appsettings-scalar-injected.json 3 file dump
live-appsettings-scalar-lowercase.json 3 file dump
live-appsettings-scalar-uppercase.json 3 file dump
live-appsettings-scalar-mixedcase.json 3 file dump
live-appsettings-accountname-missing.json 1 file dump
live-appsettings-accountname-mismatch.json 1 file quiet
live-appsettings-malformed.json 1 file dump
live-appsettings-sentinel.json 3 file quiet
live-appsettings-clean.json 0 stdin dump
live-appsettings-scalar-injected.json 3 dash dump
"

# 11 fixture rows + 2 marker cases + 2 argument cases + 1 non-vacuity case
# + 5 structural fail-closed cases + 2 exact-matching cases + 2 redaction cases
# + 1 accept-path value-hygiene case + 1 [shape] case + 1 [pair] case
# + 3 [case] remediation-branch cases + 1 [case-pair] case + 2 [names-out] cases.
# Raise this floor whenever a case is added, so the harness cannot quietly run
# fewer than it advertises.
MIN_CHECKS_PER_SHELL=34

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
ERR="${WORK}/err"

# --- Run-time derived documents ---------------------------------------------
# Structural fail-closed inputs. Each one PARSES as far as its own class allows
# and would yield zero settings from the gate's collectors — the vacuous-PASS
# shape this gate's structural validation exists to close.
WRONGTYPE="${WORK}/wrong-top-level-type.json"
printf '%s\n' '{"value": [{"name": "AzureWebJobsStorage__accountName", "value": "mgv2dev13bd19e9f03d"}]}' > "${WRONGTYPE}"
INVALID="${WORK}/invalid.json"
printf '%s\n' '[{"name": "AzureWebJobsStorage__accountName", "value": ' > "${INVALID}"
EMPTY_ARRAY="${WORK}/empty-array.json"
printf '%s\n' '[]' > "${EMPTY_ARRAY}"
EMPTY_FILE="${WORK}/empty.json"
: > "${EMPTY_FILE}"
ABSENT="${WORK}/does-not-exist.json"
rm -f "${ABSENT}"

# Exact-matching probes, both derived from the clean fixture so they cannot
# drift away from it.
#   SCALAR_ONLY  — the scalar form present and the identity form ABSENT. The
#                  scalar key must NOT be read as satisfying the account-name
#                  requirement: a prefix or substring match would make this
#                  document a PASS, which is the permanently-vacuous failure
#                  mode.
#   PREFIX_VARIANT — an `AzureWebJobsStorage`-PREFIXED key that is neither of
#                  the two exact keys. It must NOT trip the scalar check (that
#                  would make the gate permanently red on a site carrying a
#                  service-URI form); it is reported as a non-fatal NOTE.
SCALAR_ONLY="${WORK}/scalar-only.json"
jq --arg s "${SCALAR_KEY}" --arg i "${IDENTITY_KEY}" --arg v "${LIVE_SCALAR_VALUE}" '
  map(select(.name != $i)) + [{"name": $s, "slotSetting": false, "value": $v}]
' "${CLEAN}" > "${SCALAR_ONLY}" || { echo "FATAL: could not derive the scalar-only probe" >&2; exit 2; }
PREFIX_VARIANT="${WORK}/prefix-variant.json"
jq --arg s "${SCALAR_KEY}" '
  . + [{"name": ($s + "__blobServiceUri"), "slotSetting": false, "value": "https://mgv2dev13bd19e9f03d.blob.core.windows.net"}]
' "${CLEAN}" > "${PREFIX_VARIANT}" || { echo "FATAL: could not derive the prefix-variant probe" >&2; exit 2; }

# Report what `sh` actually resolves to. On many systems /bin/sh IS bash, in
# which case "both shells" is bash twice and the dash-portability property is
# NOT being tested. That is stated rather than silently laundered.
sh_target="$(readlink -f /bin/sh 2>/dev/null || echo unknown)"
echo "run-live-host-storage-fixtures: /bin/sh resolves to ${sh_target}"
case "${sh_target}" in
  *bash*) echo "  NOTE: /bin/sh is bash on this host — the dash-portability leg is NOT exercised here." ;;
esac
echo

failures=0
shells_run=0
counts=""

# assert_code <label> <expected> <actual> <dump|quiet>
# Shared reporting for the exit-code cases. Reads and writes the enclosing
# shell's counters, so it must never be called from a subshell or a pipeline.
assert_code() {
  ac_label="$1"; ac_expect="$2"; ac_actual="$3"; ac_dump="$4"
  if [ "${ac_actual}" -eq "${ac_expect}" ]; then
    echo "  ✓ ${ac_label}: exit ${ac_actual} as expected"
    return 0
  fi
  echo "  ✗ ${ac_label}: expected exit ${ac_expect}, got ${ac_actual}" >&2
  if [ "${ac_expect}" -ne 0 ] && [ "${ac_actual}" -eq 0 ]; then
    echo "      FAIL-OPEN: the gate ACCEPTED a document it must reject." >&2
  fi
  if [ "${ac_dump}" = "dump" ]; then
    sed 's/^/      /' "${OUT}" >&2
  else
    echo "      (gate output withheld: this fixture is sentinel-laden and echoing it here would reproduce the leak the redaction cases test for)" >&2
  fi
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
  while IFS=' ' read -r fixture expect mode dump; do
    [ -z "${fixture}" ] && continue
    path="${HERE}/${fixture}"
    checks=$((checks + 1))
    if [ ! -f "${path}" ]; then
      echo "  ✗ ${fixture} [${mode}]: fixture file missing" >&2
      failures=$((failures + 1))
      continue
    fi
    case "${mode}" in
      file)  "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" "${path}" >"${OUT}" 2>&1 ;;
      stdin) "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" <"${path}" >"${OUT}" 2>&1 ;;
      dash)  "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" - <"${path}" >"${OUT}" 2>&1 ;;
      *)     echo "  ✗ ${fixture}: unknown mode '${mode}' in the case table" >&2; failures=$((failures + 1)); continue ;;
    esac
    code=$?
    assert_code "${fixture} [${mode}]" "${expect}" "${code}" "${dump}"
  done < "${CASES_FILE}"

  # --- MARKER cases -----------------------------------------------------------
  # The apply workflow's bounded remediation decides whether to delete a setting
  # by looking for `SCALAR_KEY_PRESENT=AzureWebJobsStorage` on stdout. That
  # string is a CONTRACT between the gate and the workflow, so it is pinned in
  # both directions: it must appear exactly once when the key is present, and
  # NEVER when it is not. A marker that leaked onto the clean path would make
  # the workflow delete a setting on a healthy site.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" "${INJECTED}" >"${OUT}" 2>"${ERR}"
  marker_hits="$(grep -c "^SCALAR_KEY_PRESENT=${SCALAR_KEY}\$" "${OUT}" 2>/dev/null || true)"
  marker_hits="$(printf '%s' "${marker_hits}" | tr -d ' ')"
  if [ "${marker_hits}" = "1" ]; then
    echo "  ✓ [marker] the scalar-injected document emits SCALAR_KEY_PRESENT=${SCALAR_KEY} exactly once on STDOUT"
  else
    echo "  ✗ [marker] expected exactly one SCALAR_KEY_PRESENT=${SCALAR_KEY} line on stdout, found ${marker_hits} — the apply job's bounded remediation keys off this line" >&2
    failures=$((failures + 1))
  fi

  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" "${CLEAN}" >"${OUT}" 2>"${ERR}"
  clean_marker="$(grep -c 'SCALAR_KEY_PRESENT' "${OUT}" "${ERR}" 2>/dev/null | awk -F: '{ s += $2 } END { print s+0 }')"
  if [ "${clean_marker}" = "0" ]; then
    echo "  ✓ [marker] the clean document emits NO SCALAR_KEY_PRESENT line on either stream"
  else
    echo "  ✗ [marker] the clean document emitted a SCALAR_KEY_PRESENT marker (${clean_marker} occurrence(s)) — the apply job would delete a setting on a healthy site" >&2
    failures=$((failures + 1))
  fi

  # --- CASE-VARIANT cases -----------------------------------------------------
  # THE DEMONSTRATED FAIL-OPEN, pinned. Each case-variant document must not
  # merely be REJECTED — it must enter the SAME one-key remediation branch the
  # canonical spelling enters. That means two things together, and neither alone
  # is sufficient:
  #   * exit 3, not 1. The apply job remediates on 3 specifically; a variant that
  #     collapsed to 1 would be reported and then left on the site.
  #   * the `SCALAR_KEY_PRESENT=AzureWebJobsStorage` marker, exactly once, on
  #     STDOUT, spelled CANONICALLY. The marker is the gate/workflow contract and
  #     the workflow deletes the canonical name; the management plane folds case,
  #     so the canonical name removes whichever capitalisation is live. A marker
  #     echoing the OBSERVED spelling instead would still delete the right
  #     setting, but it would break the contract the spec pins, so it is asserted
  #     in the canonical form deliberately.
  for casevar in "lowercase:${LOWERCASE}" "uppercase:${UPPERCASE}" "mixedcase:${MIXEDCASE}"; do
    case_label="${casevar%%:*}"
    case_path="${casevar#*:}"
    checks=$((checks + 1))
    "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" "${case_path}" >"${OUT}" 2>"${ERR}"
    code=$?
    case_marker="$(grep -c "^SCALAR_KEY_PRESENT=${SCALAR_KEY}\$" "${OUT}" 2>/dev/null || true)"
    case_marker="$(printf '%s' "${case_marker}" | tr -d ' ')"
    if [ "${code}" -eq 3 ] && [ "${case_marker}" = "1" ]; then
      echo "  ✓ [case/${case_label}] a case-variant scalar key is exit 3 and emits the canonical SCALAR_KEY_PRESENT marker — it enters the same one-key remediation branch"
    else
      echo "  ✗ [case/${case_label}] expected exit 3 with exactly one canonical SCALAR_KEY_PRESENT marker, got exit ${code} with ${case_marker} marker(s)" >&2
      if [ "${code}" -eq 0 ]; then
        echo "      FAIL-OPEN: App Service app-setting names are CASE-INSENSITIVE, so this document carries the forbidden scalar setting and the host resolves it ahead of the identity form. A PASS here means the apply job takes its clean branch and never remediates." >&2
      fi
      sed 's/^/      /' "${OUT}" >&2
      failures=$((failures + 1))
    fi
  done

  # --- NAMES-OUT cases --------------------------------------------------------
  # `--names-out` is load-bearing for the apply job's collateral-loss detection:
  # it compares the setting NAME set before its one-key delete against the set
  # after, and fails RED on any other difference. Two properties matter.
  #   * It writes NAMES ONLY. The whole reason the gate exports this rather than
  #     the caller capturing it is that the settings document must never leave
  #     the gate's stdin; that is worthless if the export leaks values.
  #   * It FAILS CLOSED when it cannot write. A caller that proceeded to delete
  #     with an empty or stale set would compare against nothing and conclude
  #     nothing was lost — the vacuous-PASS shape this gate exists to close.
  checks=$((checks + 1))
  names_out="${WORK}/names-out.txt"
  rm -f "${names_out}"
  "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" --names-out "${names_out}" "${SENTINEL_FIXTURE}" >"${OUT}" 2>"${ERR}"
  code=$?
  no_hits="$(grep -o "${SENTINEL}" "${names_out}" 2>/dev/null | wc -l | tr -d ' ')"
  no_lines="$(grep -c . "${names_out}" 2>/dev/null || true)"
  no_lines="$(printf '%s' "${no_lines}" | tr -d ' ')"
  if [ "${code}" -eq 3 ] && [ "${no_hits}" = "0" ] && [ "${no_lines}" -gt 0 ]; then
    echo "  ✓ [names-out] wrote ${no_lines} setting NAME(s) and NOT the sentinel that laces every value in that fixture"
  else
    echo "  ✗ [names-out] expected exit 3 and a names-only export, got exit ${code} with ${no_lines} line(s) and ${no_hits} sentinel occurrence(s)" >&2
    failures=$((failures + 1))
  fi

  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" --names-out "${WORK}/no-such-dir/names.txt" "${CLEAN}" >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -eq 1 ] && grep -q 'FATAL' "${OUT}"; then
    echo "  ✓ [names-out] an unwritable --names-out path is FATAL even on an otherwise CLEAN document — fail-closed"
  else
    echo "  ✗ [names-out] expected exit 1 with a FATAL on an unwritable --names-out path, got ${code}" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi

  # --- ARGUMENT cases ---------------------------------------------------------
  # --account-name is the ONLY thing the live value is compared AGAINST. A gate
  # that ran without one would "pass" because it had no expectation, which is
  # the vacuous-PASS class this whole gate exists to close. Both the omitted and
  # the empty forms must FATAL, and both are driven with the CLEAN fixture so
  # the nonzero can only be about the missing expectation.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" "${CLEAN}" >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -ne 0 ] && grep -q 'account-name is required' "${OUT}"; then
    echo "  ✓ [args] omitted --account-name: nonzero (${code}) naming the missing expectation"
  else
    echo "  ✗ [args] omitted --account-name: expected nonzero naming the missing expectation, got ${code}" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi

  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --account-name "" "${CLEAN}" >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -ne 0 ] && grep -q 'account-name is required' "${OUT}"; then
    echo "  ✓ [args] empty --account-name: nonzero (${code}) naming the missing expectation"
  else
    echo "  ✗ [args] empty --account-name: expected nonzero naming the missing expectation, got ${code}" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi

  # --- NON-VACUITY case -------------------------------------------------------
  # The clean fixture's PASS must depend on the comparison having RUN and agreed,
  # not on the gate reaching a default. Feed the same accepted document with a
  # DIFFERENT expected account name: it must now be rejected. Without this, a
  # gate that stopped comparing altogether would keep the clean row green.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --account-name "${WRONG_ACCOUNT}" "${CLEAN}" >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -eq 1 ] && grep -q "VIOLATION \[${IDENTITY_KEY}\]" "${OUT}"; then
    echo "  ✓ [non-vacuous] the ACCEPTED document is rejected (exit 1) against a different expected account name — the comparison provably ran"
  else
    echo "  ✗ [non-vacuous] expected exit 1 naming ${IDENTITY_KEY} when the expected account name differs, got ${code} — the clean row's PASS may not depend on any comparison" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi

  # --- STRUCTURAL fail-closed cases ------------------------------------------
  # "Cannot tell" is never "nothing to see". Each of these parses far enough to
  # reach a collector that would yield zero settings and report a clean site.
  for probe in "wrong-top-level-type:${WRONGTYPE}" "invalid-json:${INVALID}" "empty-array:${EMPTY_ARRAY}" "empty-file:${EMPTY_FILE}" "absent-path:${ABSENT}"; do
    probe_label="${probe%%:*}"
    probe_path="${probe#*:}"
    checks=$((checks + 1))
    "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" "${probe_path}" >"${OUT}" 2>&1
    code=$?
    if [ "${code}" -eq 1 ] && grep -q "FATAL" "${OUT}"; then
      echo "  ✓ [structural] ${probe_label}: exit 1 with a FATAL — fail-closed"
    else
      echo "  ✗ [structural] ${probe_label}: expected exit 1 with a FATAL, got ${code}" >&2
      sed 's/^/      /' "${OUT}" >&2
      failures=$((failures + 1))
    fi
  done

  # --- EXACT-MATCHING cases ---------------------------------------------------
  # Both directions of the confusion that would make this gate useless.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" "${SCALAR_ONLY}" >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -eq 3 ] && grep -q "VIOLATION \[${SCALAR_KEY}\]" "${OUT}" && grep -q "VIOLATION \[${IDENTITY_KEY}\]" "${OUT}"; then
    echo "  ✓ [exact] a document carrying ONLY the scalar form is exit 3 and reports BOTH violations — the scalar key never satisfies the account-name requirement"
  else
    echo "  ✗ [exact] scalar-only document: expected exit 3 reporting both ${SCALAR_KEY} present and ${IDENTITY_KEY} missing, got ${code}" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi

  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" "${PREFIX_VARIANT}" >"${OUT}" 2>&1
  code=$?
  if [ "${code}" -eq 0 ] && grep -q "${SCALAR_KEY}__blobServiceUri" "${OUT}"; then
    echo "  ✓ [exact] an ${SCALAR_KEY}-PREFIXED variant does not trip the scalar check — exit 0, reported as a non-fatal NOTE"
  else
    echo "  ✗ [exact] prefix-variant document: expected exit 0 with a NOTE naming the variant, got ${code} — a prefix match here would make the gate permanently red" >&2
    sed 's/^/      /' "${OUT}" >&2
    failures=$((failures + 1))
  fi

  # --- REDACTION cases --------------------------------------------------------
  # THE GATE MUST NOT PRINT THE VALUES IT READS.
  #
  # The document this gate consumes is an app-settings list: it carries
  # connection strings, and it is read inside a CI job whose log is retained and
  # broadly readable. The gate's own stdout/stderr is therefore a place a
  # credential must not reach, and its reject paths are the ones most tempted to
  # quote what they found. run-flex-secret-gate-fixtures.sh pins the same
  # property on the config-surface gate, for the same reason and after a real
  # leak on exactly such a path.
  #
  # STDOUT AND STDERR ARE CAPTURED SEPARATELY, deliberately. "We checked the
  # merged blob" cannot say WHICH stream leaked, and is a weaker claim than
  # "neither stream contains it".
  #
  # REJECTION IS ASSERTED TOO. A gate that ACCEPTED these documents would
  # trivially satisfy "did not print the sentinel" while being catastrophically
  # wrong; the redaction property only means anything on a run that rejected.
  for redact in "whole-surface:${SENTINEL_FIXTURE}:3" "mismatch-path:${MISMATCH}:1"; do
    redact_label="$(printf '%s' "${redact}" | cut -d: -f1)"
    redact_path="$(printf '%s' "${redact}" | cut -d: -f2)"
    redact_code="$(printf '%s' "${redact}" | cut -d: -f3)"
    checks=$((checks + 1))
    "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" "${redact_path}" >"${OUT}" 2>"${ERR}"
    code=$?
    # grep -c counts LINES; -o | wc -l counts OCCURRENCES, which is what a leak
    # claim is about (one line can carry several).
    hits_out="$(grep -o "${SENTINEL}" "${OUT}" 2>/dev/null | wc -l | tr -d ' ')"
    hits_err="$(grep -o "${SENTINEL}" "${ERR}" 2>/dev/null | wc -l | tr -d ' ')"
    if [ "${code}" -ne "${redact_code}" ]; then
      echo "  ✗ [redact/${redact_label}] expected exit ${redact_code}, got ${code} — redaction is vacuous on a run that did not reject as expected" >&2
      failures=$((failures + 1))
    elif [ "${hits_out}" != "0" ] || [ "${hits_err}" != "0" ]; then
      echo "  ✗ [redact/${redact_label}] the gate PRINTED a value it read — sentinel occurrences: stdout=${hits_out}, stderr=${hits_err}" >&2
      echo "      A reject path must print the setting NAME + a fixed reason, never the VALUE." >&2
      failures=$((failures + 1))
    else
      echo "  ✓ [redact/${redact_label}] rejected (${code}) and the sentinel appears in NEITHER stdout NOR stderr"
    fi
  done

  # --- ACCEPT-PATH value hygiene ---------------------------------------------
  # The reject paths are not the only ones that read values. The gate prints a
  # full NAME list for operator diagnosis on EVERY run, including the accepting
  # one, and the clean fixture carries a connection string and an
  # instrumentation key like any real site does. So the accepting path is
  # asserted to print no value fragments either.
  #
  # The expected account name IS echoed, and that is correct and deliberate: it
  # came from the CALLER (terraform output), not from the document, and it is a
  # resource name rather than a credential. So it is excluded from the markers
  # below rather than pretended away.
  checks=$((checks + 1))
  "${shell_bin}" "${GATE}" --account-name "${ACCOUNT}" "${CLEAN}" >"${OUT}" 2>"${ERR}"
  code=$?
  leak_markers=''
  for marker in 'AccountKey=' 'EndpointSuffix=' 'InstrumentationKey=' 'IngestionEndpoint='; do
    if grep -qF "${marker}" "${OUT}" 2>/dev/null || grep -qF "${marker}" "${ERR}" 2>/dev/null; then
      leak_markers="${leak_markers} ${marker}"
    fi
  done
  if [ "${code}" -ne 0 ]; then
    echo "  ✗ [hygiene] the clean fixture did not pass (exit ${code}) — the accept-path hygiene claim would be vacuous" >&2
    failures=$((failures + 1))
  elif [ -n "${leak_markers}" ]; then
    echo "  ✗ [hygiene] the ACCEPTING run printed value fragments:${leak_markers}" >&2
    failures=$((failures + 1))
  else
    echo "  ✓ [hygiene] the accepting run printed setting NAMES only — no value fragment from the document reached either stream"
  fi

  # --- SHAPE case: the mutation control must still be a control ---------------
  # Asserted LEXICALLY, because an exit code cannot see this. If someone deletes
  # the scalar entry from the injected fixture, that fixture stops being the
  # defect and its row would go green under a gate that had stopped working. If
  # someone adds the scalar entry to the clean fixture, or removes the identity
  # form from it, the accepted control stops describing a healthy site. Each of
  # those edits must turn THIS case red before any exit code moves.
  checks=$((checks + 1))
  shape_err=""
  if ! grep -qE "\"name\"[[:space:]]*:[[:space:]]*\"${IDENTITY_KEY}\"" "${CLEAN}"; then
    shape_err="the ACCEPTED control does not carry ${IDENTITY_KEY} — it has drifted behind modules/functions/main.tf, so its PASS is a claim about a site shape that is not deployed"
  elif grep -qE "\"name\"[[:space:]]*:[[:space:]]*\"${SCALAR_KEY}\"" "${CLEAN}"; then
    shape_err="the ACCEPTED control carries the scalar ${SCALAR_KEY} setting — that document must never be a PASS"
  elif ! grep -qE "\"name\"[[:space:]]*:[[:space:]]*\"${SCALAR_KEY}\"" "${INJECTED}"; then
    shape_err="the NEGATIVE control no longer carries the scalar ${SCALAR_KEY} setting — its rejection would be for some other reason, making the pair vacuous"
  elif ! grep -qE "\"name\"[[:space:]]*:[[:space:]]*\"${IDENTITY_KEY}\"" "${INJECTED}"; then
    shape_err="the NEGATIVE control no longer carries ${IDENTITY_KEY} — the defect under test is the scalar form SHADOWING a correct identity form, and a document missing the identity form is a different defect"
  elif ! grep -qF "${LIVE_SCALAR_VALUE}" "${INJECTED}"; then
    shape_err="the NEGATIVE control's scalar value is no longer byte-identical to the string observed on the live site — the negative control has become synthetic"
  elif grep -qE "\"name\"[[:space:]]*:[[:space:]]*\"[^\"]*${SENTINEL}" "${SENTINEL_FIXTURE}"; then
    shape_err="the redaction fixture embeds the sentinel in a setting NAME — names are printed by design, so that would make the redaction cases fail for a reason that is not a leak"
  elif ! grep -q "${SENTINEL}" "${SENTINEL_FIXTURE}"; then
    shape_err="the redaction fixture no longer carries the sentinel at all — the redaction case would be vacuous"
  elif ! grep -q "${SENTINEL}" "${MISMATCH}"; then
    shape_err="the mismatch fixture no longer carries the sentinel in its account-name value — the mismatch-path redaction case would be vacuous"
  fi
  if [ -n "${shape_err}" ]; then
    echo "  ✗ [shape] ${shape_err}" >&2
    failures=$((failures + 1))
  else
    echo "  ✓ [shape] mutation control intact: clean carries ONLY the identity form, injected carries both with the live scalar value, sentinels live in values only"
  fi

  # --- PAIR case: differ by EXACTLY one key -----------------------------------
  # The lexical shape case above proves each fixture carries what it should. This
  # one proves the pair is a MUTATION rather than two independently-written
  # documents: strip the scalar entry from the injected fixture and what remains
  # must be identical to the clean fixture, entry for entry and value for value.
  # Any other difference would mean the pair's exit codes differ for some reason
  # other than the one key this ticket exists to keep off the site.
  checks=$((checks + 1))
  pair_err=""
  clean_norm="$(jq -S 'sort_by(.name)' "${CLEAN}" 2>/dev/null)" || pair_err="the clean fixture is not parseable JSON"
  injected_norm="$(jq -S --arg s "${SCALAR_KEY}" 'map(select(.name != $s)) | sort_by(.name)' "${INJECTED}" 2>/dev/null)" || pair_err="the injected fixture is not parseable JSON"
  if [ -z "${pair_err}" ]; then
    scalar_in_injected="$(jq -r --arg s "${SCALAR_KEY}" '[ .[] | select(.name == $s) ] | length' "${INJECTED}" 2>/dev/null)"
    scalar_in_clean="$(jq -r --arg s "${SCALAR_KEY}" '[ .[] | select(.name == $s) ] | length' "${CLEAN}" 2>/dev/null)"
    injected_scalar_value="$(jq -r --arg s "${SCALAR_KEY}" 'first(.[] | select(.name == $s) | .value) // ""' "${INJECTED}" 2>/dev/null)"
    if [ "${scalar_in_clean}" != "0" ]; then
      pair_err="the clean fixture carries ${scalar_in_clean} scalar ${SCALAR_KEY} entr(y/ies); it must carry none"
    elif [ "${scalar_in_injected}" != "1" ]; then
      pair_err="the injected fixture carries ${scalar_in_injected} scalar ${SCALAR_KEY} entr(y/ies); the mutation is exactly one"
    elif [ "${injected_scalar_value}" != "${LIVE_SCALAR_VALUE}" ]; then
      pair_err="the injected fixture's scalar value is not the value observed on the live site"
    elif [ "${clean_norm}" != "${injected_norm}" ]; then
      pair_err="the two fixtures differ by MORE than the scalar ${SCALAR_KEY} entry — strip that one key from the injected document and the remainder must equal the clean document exactly, or their differing exit codes are not attributable to it"
    fi
  fi
  if [ -n "${pair_err}" ]; then
    echo "  ✗ [pair] ${pair_err}" >&2
    failures=$((failures + 1))
  else
    echo "  ✓ [pair] clean and scalar-injected differ by EXACTLY the ${SCALAR_KEY} entry, whose value is byte-identical to the live observation"
  fi

  # --- CASE-PAIR case: the variants are one-key mutations too ------------------
  # Same discipline as [pair], applied to the three case-variant controls. Each
  # must differ from the clean document by EXACTLY ONE entry; that entry must
  # lowercase to the scalar key, must NOT be spelled canonically (or it is just a
  # duplicate of the injected fixture and proves nothing about case), and must
  # carry the live scalar value. Without this, a fixture edit that "fixed" the
  # capitalisation would leave the [case] rows green while testing nothing.
  checks=$((checks + 1))
  casepair_err=""
  for casevar in "lowercase:${LOWERCASE}" "uppercase:${UPPERCASE}" "mixedcase:${MIXEDCASE}"; do
    case_label="${casevar%%:*}"
    case_path="${casevar#*:}"
    [ -n "${casepair_err}" ] && continue
    cp_norm="$(jq -S --arg s "${SCALAR_KEY}" '
      map(select((.name | ascii_downcase) != ($s | ascii_downcase))) | sort_by(.name)
    ' "${case_path}" 2>/dev/null)" || { casepair_err="${case_label}: not parseable JSON"; continue; }
    cp_names="$(jq -r --arg s "${SCALAR_KEY}" '
      .[].name | select((. | ascii_downcase) == ($s | ascii_downcase))
    ' "${case_path}" 2>/dev/null)"
    cp_count="$(printf '%s' "${cp_names}" | grep -c . || true)"
    cp_count="$(printf '%s' "${cp_count}" | tr -d ' ')"
    cp_value="$(jq -r --arg s "${SCALAR_KEY}" '
      first(.[] | select((.name | ascii_downcase) == ($s | ascii_downcase)) | .value) // ""
    ' "${case_path}" 2>/dev/null)"
    if [ "${cp_count}" != "1" ]; then
      casepair_err="${case_label}: carries ${cp_count} scalar-key entr(y/ies); the mutation is exactly one"
    elif [ "${cp_names}" = "${SCALAR_KEY}" ]; then
      casepair_err="${case_label}: spells the key CANONICALLY (${cp_names}) — it is a duplicate of the injected fixture and proves nothing about case-insensitivity"
    elif [ "${cp_value}" != "${LIVE_SCALAR_VALUE}" ]; then
      casepair_err="${case_label}: scalar value is not the value observed on the live site — the control has become synthetic"
    elif [ "${cp_norm}" != "${clean_norm}" ]; then
      casepair_err="${case_label}: differs from the clean document by MORE than the scalar entry, so its exit 3 is not attributable to the case-variant key"
    fi
  done
  if [ -n "${casepair_err}" ]; then
    echo "  ✗ [case-pair] ${casepair_err}" >&2
    failures=$((failures + 1))
  else
    echo "  ✓ [case-pair] each case-variant control is a one-key mutation of the clean document, spelled non-canonically, carrying the live scalar value"
  fi

  echo "  -- ${shell_bin}: ${checks} checks"
  # Name the shell on STDERR too: every ✗ goes to stderr while the "running
  # under" header goes to stdout, so a consumer capturing the streams separately
  # otherwise sees failed cases with no way to attribute them to a shell.
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
echo "run-live-host-storage-fixtures: shells_run=${shells_run}, per-shell checks:${counts}"

distinct="$(for c in ${counts}; do echo "${c##*=}"; done | sort -u | wc -l)"
if [ "${shells_run}" -lt 2 ]; then
  echo "run-live-host-storage-fixtures: FAILED — only ${shells_run} shell(s) ran; the dual-shell contract was not exercised" >&2
  exit 1
fi
if [ "${distinct}" -ne 1 ]; then
  echo "run-live-host-storage-fixtures: FAILED — per-shell check counts differ (${counts}); a shell skipped rows" >&2
  exit 1
fi

if [ "${failures}" -ne 0 ]; then
  echo "run-live-host-storage-fixtures: FAILED — ${failures} case(s) did not behave as expected" >&2
  exit 1
fi
# NOTE — the phrase "all fixtures behaved as expected" is a CONTRACT, matching
# the line run-flex-secret-gate-fixtures.sh emits: the api-interfaces posture
# suite matches on it to confirm a harness ran green. Extend the line; do not
# rewrite it.
echo "run-live-host-storage-fixtures: all fixtures behaved as expected under every shell."
exit 0
