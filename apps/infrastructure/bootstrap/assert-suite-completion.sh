#!/usr/bin/env bash
#
# Completion guard for the bootstrap shell suites (MG-42 finding F5).
# ===========================================================================
# Run: bash assert-suite-completion.sh [suite.sh ...]     (no args = both)
#
# WHY THIS EXISTS.
#
# `bootstrap.test.sh` runs under `set -u`. When the MG-42 block hit a Bash 3.2
# command-substitution parse error, the resulting unbound variable aborted the
# run at line 1571. The suite had printed 229 `ok` lines and simply STOPPED —
# no `passed=/failed=` summary, no failing assertion, and (because the abort
# happened inside a `$( … ) || true` capture) an exit status that told nobody
# anything. The defect was invisible except as a missing tail, and it shipped:
# CI runs these suites under Ubuntu Bash 5.x, which parses the construct fine
# and correctly reported `passed=321 failed=0` before and after the fix, while
# every developer on macOS /bin/bash 3.2 was running a truncated suite.
#
# The general failure mode is broader than that one parse error: a shell suite
# that DIES PARTWAY THROUGH LOOKS LIKE A PASS. A `set -e` trip, a stray
# `exit`/`return`, an unbound variable, a syntax error inside a substitution —
# whatever kills it, the observable is identical: fewer assertions ran, and
# nobody is counting. This guard is the thing that counts.
#
# WHAT IT ASSERTS, per suite:
#
#   1. COMPLETION — the suite printed its `passed=N failed=M` summary line.
#      A suite that exits without one did not finish, and that is a hard
#      failure here EVEN IF its exit status is 0.
#   2. NO FAILURES — `failed=0`, and the suite's own exit status is 0.
#   3. NO SILENT SHRINK — `passed` is at or above the pinned minimum below.
#      A dropped assertion breaks the build instead of passing quietly.
#
# It deliberately does NOT parse or reimplement any assertion. The suites stay
# the source of truth for what is true; this only proves they RAN.
#
# Reproducing the 3.2 truncation locally (macOS):
#
#     BOOTSTRAP_SUITE_SHELL=/bin/bash bash assert-suite-completion.sh
#
# This script is itself written to Bash 3.2 syntax — a guard that only parses
# on the shell that hid the bug would be worth nothing.
set -uo pipefail

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# The interpreter the suites run under. Defaults to whatever `bash` resolves to
# (Bash 5.x in CI). Override to point at an older bash to reproduce a
# version-specific truncation locally.
BOOTSTRAP_SUITE_SHELL="${BOOTSTRAP_SUITE_SHELL:-bash}"

# --- PINNED EXPECTED MINIMUM ASSERTION COUNTS ------------------------------
# These are floors, not equalities: adding tests is free, losing them is not.
#
# RAISE a value here when you ADD assertions to that suite — deliberately, in
# the same commit, so the new floor is reviewed alongside the new coverage.
#
# NEVER LOWER one to make a build pass. A count that dropped means assertions
# stopped executing, which is precisely the defect this guard exists to catch;
# lowering the floor re-hides it. If assertions were intentionally REMOVED, say
# so in the commit message and lower it there — never as a build fix.
EXPECTED_MIN_BOOTSTRAP_TEST=321                  # bootstrap.test.sh
EXPECTED_MIN_OIDC_SUBJECT_INTEGRATION=66         # bootstrap.oidc-subject.integration.test.sh

# Bash 3.2 has no associative arrays — a case lookup is the portable form.
expected_min_for() {
  case "$1" in
    bootstrap.test.sh)
      printf '%s\n' "$EXPECTED_MIN_BOOTSTRAP_TEST" ;;
    bootstrap.oidc-subject.integration.test.sh)
      printf '%s\n' "$EXPECTED_MIN_OIDC_SUBJECT_INTEGRATION" ;;
    *)
      return 1 ;;
  esac
}

DEFAULT_SUITES="bootstrap.test.sh bootstrap.oidc-subject.integration.test.sh"

guard_fail=0
out=""
# So a `timeout`-killed run (CI bounds this script) does not leave the capture
# file behind. Each check_suite call removes its own on the normal paths.
trap 'rm -f "${out:-}"' EXIT

# check_suite <suite-basename>
check_suite() {
  suite_name="$1"
  suite_path="$DIR/$suite_name"

  min="$(expected_min_for "$suite_name")" || {
    printf 'GUARD FAIL - %s: no pinned minimum assertion count is declared for this suite.\n' "$suite_name"
    printf '             Add one to assert-suite-completion.sh (EXPECTED_MIN_*) — an unpinned\n'
    printf '             suite can shrink to zero without anyone noticing.\n'
    guard_fail=$((guard_fail+1))
    return 1
  }

  if [ ! -f "$suite_path" ]; then
    printf 'GUARD FAIL - %s: suite not found at %s\n' "$suite_name" "$suite_path"
    guard_fail=$((guard_fail+1))
    return 1
  fi

  out="$(mktemp)"
  status=0
  # `< /dev/null` so nothing in the suite can block on stdin. Output is captured
  # rather than streamed so the guard can inspect the tail; it is echoed below
  # on failure so a red build still shows the run.
  "$BOOTSTRAP_SUITE_SHELL" "$suite_path" < /dev/null > "$out" 2>&1 || status=$?

  # The LAST summary line wins — a suite is free to print other things after it,
  # but the tally it ends on is the one that counts.
  summary="$(grep -E '^passed=[0-9]+ failed=[0-9]+$' "$out" | tail -1)"

  if [ -z "$summary" ]; then
    # THE MG-42 F5 CASE. No summary means the suite never reached its own last
    # line: it was truncated by a parse error, an early exit, a set -e trip or
    # an unbound variable. Exit status is reported but NOT trusted — the whole
    # point of this check is that the status was 0 while the suite was broken.
    printf 'GUARD FAIL - %s: suite exited WITHOUT printing its "passed=N failed=M" summary.\n' "$suite_name"
    printf '             It did not run to completion — it was TRUNCATED. Assertions after the\n'
    printf '             abort point never executed. Exit status was %d (0 here would mean the\n' "$status"
    printf '             truncation is silent, which is exactly what this guard is for).\n'
    printf '             Interpreter: %s (%s)\n' "$BOOTSTRAP_SUITE_SHELL" "$("$BOOTSTRAP_SUITE_SHELL" -c 'echo "$BASH_VERSION"' 2>/dev/null)"
    printf '             ok lines emitted before the abort: %s\n' "$(grep -c '^ok   - ' "$out")"
    printf '             --- last 10 lines of suite output ---\n'
    tail -10 "$out" | sed 's/^/             /'
    printf '             -------------------------------------\n'
    guard_fail=$((guard_fail+1))
    rm -f "$out"
    return 1
  fi

  # summary is "passed=N failed=M" — split without calling out to sed/awk.
  rest="${summary#passed=}"
  actual_pass="${rest%% *}"
  actual_fail="${summary##*failed=}"

  suite_bad=0

  if [ "$actual_fail" -ne 0 ]; then
    printf 'GUARD FAIL - %s: %s assertion(s) FAILED.\n' "$suite_name" "$actual_fail"
    suite_bad=1
  fi

  if [ "$status" -ne 0 ] && [ "$actual_fail" -eq 0 ]; then
    # Ran to completion, reported no failures, still exited non-zero — something
    # outside the assertions went wrong and must not be swallowed.
    printf 'GUARD FAIL - %s: suite reported failed=0 but exited non-zero (status %d).\n' "$suite_name" "$status"
    suite_bad=1
  fi

  if [ "$actual_pass" -lt "$min" ]; then
    printf 'GUARD FAIL - %s: assertion count SHRANK — ran %s, expected at least %s.\n' "$suite_name" "$actual_pass" "$min"
    printf '             %s assertion(s) that used to run no longer do. If they were removed on\n' "$((min - actual_pass))"
    printf '             purpose, lower EXPECTED_MIN_* in assert-suite-completion.sh in the SAME\n'
    printf '             commit and say why. Do not lower it to make a build green.\n'
    suite_bad=1
  fi

  if [ "$suite_bad" -ne 0 ]; then
    printf '             --- suite output ---\n'
    sed 's/^/             /' "$out"
    printf '             --------------------\n'
    guard_fail=$((guard_fail+1))
    rm -f "$out"
    return 1
  fi

  printf 'GUARD ok   - %s: completed, passed=%s failed=%s (floor %s)\n' \
    "$suite_name" "$actual_pass" "$actual_fail" "$min"
  rm -f "$out"
  return 0
}

if [ "$#" -gt 0 ]; then
  suites="$*"
else
  suites="$DEFAULT_SUITES"
fi

for s in $suites; do
  check_suite "$(basename "$s")" || true
done

printf -- '-----------------------------------------\n'
if [ "$guard_fail" -ne 0 ]; then
  printf 'bootstrap suite completion guard: FAILED (%d suite(s))\n' "$guard_fail"
  exit 1
fi
printf 'bootstrap suite completion guard: OK\n'
exit 0
