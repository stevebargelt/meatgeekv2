#!/usr/bin/env bash
#
# run-flex-secret-gate-fixtures.sh — deterministic regression harness for the
# Flex Consumption shape of the fail-closed plan/state secret gate (MG-24).
#
# Exercises scripts/tf-plan-secret-inspection.sh against the committed
# terraform-show-json fixtures next to this script and asserts each expected exit
# code. No Azure, no `terraform` binary, no credentials — the gate consumes a
# `terraform show -json` document and every fixture IS one.
#
# To catch the MG-24 portable-shell regression (a gate that PASSes on bash but
# ERRORs on dash is fail-open), each fixture is run under BOTH bash and dash
# (`sh`) when dash is available.
#
# Exit 0 iff every fixture behaves as expected under every shell.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
GATE="${HERE}/../tf-plan-secret-inspection.sh"

[ -f "${GATE}" ] || { echo "FATAL: gate not found: ${GATE}" >&2; exit 2; }

# Fixtures and the expectation: "pass" => gate must exit 0, "fail" => nonzero.
# (space-separated "<fixture> <expectation>" rows — POSIX-portable, no arrays.)
CASES="
flex-plan-accepted.json pass
flex-plan-reenabled-shared-key.json fail
flex-plan-appsetting-key.json fail
flex-plan-siteconfig-key.json fail
flex-plan-sas-endpoint.json fail
flex-plan-deploy-storage-key.json fail
"

SHELLS="bash"
if command -v sh >/dev/null 2>&1; then SHELLS="bash sh"; fi

failures=0
for sh in ${SHELLS}; do
  echo "== running fixtures under: ${sh} =="
  # shellcheck disable=SC2086
  printf '%s\n' "${CASES}" | while IFS=' ' read -r fixture expect; do
    [ -z "${fixture}" ] && continue
    path="${HERE}/${fixture}"
    if [ ! -f "${path}" ]; then
      echo "  ✗ ${fixture}: fixture file missing" >&2
      exit 1
    fi
    if "${sh}" "${GATE}" "${path}" >/tmp/flex-gate-out.$$ 2>&1; then
      code=0
    else
      code=$?
    fi
    if [ "${expect}" = "pass" ]; then
      if [ "${code}" -eq 0 ]; then
        echo "  ✓ ${fixture}: exit 0 as expected (accepted)"
      else
        echo "  ✗ ${fixture}: expected exit 0, got ${code}" >&2
        sed 's/^/      /' /tmp/flex-gate-out.$$ >&2
        exit 1
      fi
    else
      if [ "${code}" -ne 0 ]; then
        echo "  ✓ ${fixture}: nonzero (${code}) as expected (fail-closed)"
      else
        echo "  ✗ ${fixture}: expected nonzero, got 0 — FAIL-OPEN" >&2
        sed 's/^/      /' /tmp/flex-gate-out.$$ >&2
        exit 1
      fi
    fi
  done || failures=$((failures + 1))
done
rm -f /tmp/flex-gate-out.$$

echo
if [ "${failures}" -ne 0 ]; then
  echo "run-flex-secret-gate-fixtures: FAILED" >&2
  exit 1
fi
echo "run-flex-secret-gate-fixtures: all fixtures behaved as expected."
exit 0
