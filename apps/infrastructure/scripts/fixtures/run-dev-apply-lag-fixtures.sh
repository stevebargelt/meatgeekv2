#!/usr/bin/env bash
#
# run-dev-apply-lag-fixtures.sh — deterministic harness for
# scripts/dev-apply-lag-check.sh, the missed-reconciliation detector (#224,
# carried over from MG-38).
#
# The check reads GitHub's Actions and compare APIs through `gh api`. Here a
# FAKE `gh` (written into a temp dir and passed as GH_BIN) answers each
# endpoint from a per-case directory: the endpoint is turned into a file name,
# and an endpoint the case did not write a file for fails the way a real API
# error does. So a case also pins the exact queries the check makes: a check
# that stopped filtering CI runs to `status=success` would ask for an endpoint
# no case answers, and fail closed instead of passing.
#
# The clock is passed in (--now), never read: no case depends on real time.
#
# Exit codes are asserted EXACTLY: 0 no alert, 3 missed reconciliation (alert),
# 1 could not tell (fail closed). The two states the issue separates:
#   state 1 — main's tip is red, the newest green SHA is already applied -> 0
#   state 2 — a green main SHA is ahead of the last SHA applied to dev   -> 3
#
# Every case runs under bash AND sh, and the per-shell counts must match a floor.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
CHECK="${HERE}/../dev-apply-lag-check.sh"

[ -f "${CHECK}" ] || { echo "FATAL: check not found: ${CHECK}" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq is required" >&2; exit 2; }

WORK="$(mktemp -d)"
trap 'rm -rf "${WORK}"' EXIT

REPO="owner/repo"
S1="1111111111111111111111111111111111111111"
S2="2222222222222222222222222222222222222222"
S3="3333333333333333333333333333333333333333"
# 2026-11-28T12:00:00Z, the fixed "now" of every case.
NOW=1795867200
GREEN_5H_AGO="2026-11-28T07:00:00Z"
GREEN_10M_AGO="2026-11-28T11:50:00Z"

# The fake gh. `gh api <endpoint>` prints CASE_DIR/<key>.json, where <key> is
# the endpoint with every non-alphanumeric character turned into `_`. A
# missing file is an API error (exit 1). Anything but `gh api <endpoint>` is
# an error too, so the check cannot grow a call this harness does not see.
FAKE_GH="${WORK}/fake-gh"
cat >"${FAKE_GH}" <<'EOF'
#!/bin/sh
[ "$#" -eq 2 ] && [ "$1" = "api" ] || { echo "fake-gh: unexpected call: $*" >&2; exit 64; }
key="$(printf '%s' "$2" | tr -c 'A-Za-z0-9' '_')"
f="${CASE_DIR}/${key}.json"
[ -f "$f" ] || { echo "fake-gh: no answer for $2" >&2; exit 1; }
cat "$f"
EOF
chmod +x "${FAKE_GH}"

CI_RUNS_EP="repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1"
APPLY_RUNS_EP="repos/${REPO}/actions/workflows/infra-apply-dev.yml/runs?status=completed&per_page=100&page=1"
APPLY_RUNS_EP2="repos/${REPO}/actions/workflows/infra-apply-dev.yml/runs?status=completed&per_page=100&page=2"

answer() { # answer <case> <endpoint> ; body on stdin
  key="$(printf '%s' "$2" | tr -c 'A-Za-z0-9' '_')"
  mkdir -p "${WORK}/$1"
  cat >"${WORK}/$1/${key}.json"
}

green() { # green <case> <sha> <updated_at>
  printf '{"workflow_runs":[{"id":900,"head_sha":"%s","conclusion":"success","updated_at":"%s"}]}' "$2" "$3" |
    answer "$1" "${CI_RUNS_EP}"
}

apply_runs() { # apply_runs <case> <json array of {id,head_sha,conclusion}> [<endpoint>]
  printf '{"workflow_runs":%s}' "$2" | answer "$1" "${3:-${APPLY_RUNS_EP}}"
}

jobs() { # jobs <case> <run id> <conclusion of the Terraform apply step>
  printf '{"jobs":[{"name":"apply","steps":[{"name":"Stale-SHA guard (never apply superseded trunk)","conclusion":"success"},{"name":"Terraform apply (the exact saved, gated plan)","conclusion":"%s"},{"name":"Final drift plan","conclusion":"success"}]}]}' "$3" |
    answer "$1" "repos/${REPO}/actions/runs/$2/jobs?filter=latest"
}

compare() { # compare <case> <base> <head> <status>
  printf '{"status":"%s","ahead_by":1,"behind_by":0}' "$4" | answer "$1" "repos/${REPO}/compare/$2...$3"
}

# --- the cases ---------------------------------------------------------------

# In sync: the newest green SHA is the last applied one.
green in-sync "$S2" "$GREEN_5H_AGO"
apply_runs in-sync "[{\"id\":12,\"head_sha\":\"$S2\",\"conclusion\":\"success\"}]"
jobs in-sync 12 success

# State 1: main's tip (S2) is red, so the newest green is S1, and S1 is applied.
# The red tip never appears: the CI query asks for successful runs only.
green state1-red-tip "$S1" "$GREEN_5H_AGO"
apply_runs state1-red-tip "[{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]"
jobs state1-red-tip 11 success

# State 2, the MG-38 shape: S2's CI went green, but S3 merged before S2's apply
# ran, so S2's run was superseded (its Terraform apply step skipped); S3's CI
# went red, so S3 never triggered an apply. The last real apply is S1, and the
# newest green SHA, S2, is ahead of it.
green state2-missed "$S2" "$GREEN_5H_AGO"
apply_runs state2-missed "[{\"id\":13,\"head_sha\":\"$S2\",\"conclusion\":\"success\"},{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]"
jobs state2-missed 13 skipped
jobs state2-missed 11 success
compare state2-missed "$S1" "$S2" ahead

# State 2 but the green CI finished 10 minutes ago: its apply may still be
# queued or running, so no alert yet. The next scheduled check alerts if it
# never lands.
green state2-in-grace "$S2" "$GREEN_10M_AGO"
apply_runs state2-in-grace "[{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]"
jobs state2-in-grace 11 success
compare state2-in-grace "$S1" "$S2" ahead

# A partial apply (the Terraform apply step failed) is not an applied SHA.
green partial-apply "$S2" "$GREEN_5H_AGO"
apply_runs partial-apply "[{\"id\":13,\"head_sha\":\"$S2\",\"conclusion\":\"failure\"},{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]"
jobs partial-apply 13 failure
jobs partial-apply 11 success
compare partial-apply "$S1" "$S2" ahead

# Skipped runs (CI runs of pull requests trigger the workflow too) are passed
# over without a jobs lookup: no jobs answer is written for run 14.
green skipped-runs "$S1" "$GREEN_5H_AGO"
apply_runs skipped-runs "[{\"id\":14,\"head_sha\":\"$S3\",\"conclusion\":\"skipped\"},{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]"
jobs skipped-runs 11 success

# The last apply is on page 2: a red main with many pull requests pushes it off
# page 1, whose runs all skipped. Still state 2, not "could not tell".
green paged "$S2" "$GREEN_5H_AGO"
apply_runs paged "[{\"id\":14,\"head_sha\":\"$S3\",\"conclusion\":\"skipped\"}]"
apply_runs paged "[{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]" "${APPLY_RUNS_EP2}"
jobs paged 11 success
compare paged "$S1" "$S2" ahead

# Dev holds a recovery apply newer than the newest green SHA: no alert.
green applied-ahead "$S1" "$GREEN_5H_AGO"
apply_runs applied-ahead "[{\"id\":15,\"head_sha\":\"$S2\",\"conclusion\":\"success\"}]"
jobs applied-ahead 15 success
compare applied-ahead "$S2" "$S1" behind

# Dev holds a tree that is not in main's history: alert.
green diverged "$S2" "$GREEN_5H_AGO"
apply_runs diverged "[{\"id\":16,\"head_sha\":\"$S3\",\"conclusion\":\"success\"}]"
jobs diverged 16 success
compare diverged "$S3" "$S2" diverged

# --- fail closed ---------------------------------------------------------------

# The CI runs query fails.
apply_runs ci-api-error "[{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]"
jobs ci-api-error 11 success

# No green CI run on main at all.
printf '{"workflow_runs":[]}' | answer no-green "${CI_RUNS_EP}"
apply_runs no-green "[{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]"
jobs no-green 11 success

# A malformed SHA in the CI answer.
green bad-sha "not-a-sha" "$GREEN_5H_AGO"
apply_runs bad-sha "[{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]"
jobs bad-sha 11 success

# No run in the window applied anything.
green none-applied "$S2" "$GREEN_5H_AGO"
apply_runs none-applied "[{\"id\":13,\"head_sha\":\"$S2\",\"conclusion\":\"success\"}]"
jobs none-applied 13 skipped
apply_runs none-applied "[]" "${APPLY_RUNS_EP2}"

# The jobs lookup of a candidate run fails.
green jobs-api-error "$S2" "$GREEN_5H_AGO"
apply_runs jobs-api-error "[{\"id\":13,\"head_sha\":\"$S2\",\"conclusion\":\"success\"}]"

# The compare call fails.
green compare-api-error "$S2" "$GREEN_5H_AGO"
apply_runs compare-api-error "[{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]"
jobs compare-api-error 11 success

# The compare answer has a status the check does not know.
green compare-unknown "$S2" "$GREEN_5H_AGO"
apply_runs compare-unknown "[{\"id\":11,\"head_sha\":\"$S1\",\"conclusion\":\"success\"}]"
jobs compare-unknown 11 success
compare compare-unknown "$S1" "$S2" sideways

# Invalid JSON from the runs list.
green bad-json "$S2" "$GREEN_5H_AGO"
printf 'not json' | answer bad-json "${APPLY_RUNS_EP}"

# --- runner ----------------------------------------------------------------------

PASS=0
FAIL=0
BASH_CHECKS=0
SH_CHECKS=0

expect() { # expect <shell> <case> <exit code> [<output substring>]
  shell="$1" case_name="$2" want="$3" needle="${4:-}"
  mkdir -p "${WORK}/${case_name}"
  out="$(CASE_DIR="${WORK}/${case_name}" GH_BIN="${FAKE_GH}" \
    "${shell}" "${CHECK}" --repo "${REPO}" --now "${NOW}" --grace-minutes 120 2>&1 </dev/null)"
  got=$?
  if [ "${got}" -eq "${want}" ] && { [ -z "${needle}" ] || printf '%s' "${out}" | grep -F -- "${needle}" >/dev/null; }; then
    PASS=$((PASS + 1))
  else
    FAIL=$((FAIL + 1))
    echo "FAIL [${shell}] ${case_name}: exit ${got}, want ${want}${needle:+, output containing '${needle}'}" >&2
    printf '%s\n' "${out}" | sed 's/^/    /' >&2
  fi
  if [ "${shell}" = bash ]; then BASH_CHECKS=$((BASH_CHECKS + 1)); else SH_CHECKS=$((SH_CHECKS + 1)); fi
}

for shell in bash sh; do
  expect "${shell}" in-sync 0 "in sync"
  expect "${shell}" state1-red-tip 0 "in sync"
  expect "${shell}" state2-missed 3 "MISSED RECONCILIATION"
  expect "${shell}" state2-missed 3 "${S1}"
  expect "${shell}" state2-in-grace 0 "pending"
  expect "${shell}" partial-apply 3 "MISSED RECONCILIATION"
  expect "${shell}" skipped-runs 0 "in sync"
  expect "${shell}" paged 3 "MISSED RECONCILIATION"
  expect "${shell}" applied-ahead 0 "behind"
  expect "${shell}" diverged 3 "not in main's history"
  expect "${shell}" ci-api-error 1
  expect "${shell}" no-green 1
  expect "${shell}" bad-sha 1
  expect "${shell}" none-applied 1 "applied anything"
  expect "${shell}" jobs-api-error 1
  expect "${shell}" compare-api-error 1
  expect "${shell}" compare-unknown 1
  expect "${shell}" bad-json 1
done

# Usage errors are not verdicts: a missing --repo or a non-numeric --now is 2.
for shell in bash sh; do
  out="$(GH_BIN="${FAKE_GH}" "${shell}" "${CHECK}" --now "${NOW}" 2>&1 </dev/null)"
  if [ $? -eq 2 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL [${shell}] missing --repo is not exit 2" >&2; fi
  out="$(GH_BIN="${FAKE_GH}" "${shell}" "${CHECK}" --repo "${REPO}" --now soon 2>&1 </dev/null)"
  if [ $? -eq 2 ]; then PASS=$((PASS + 1)); else FAIL=$((FAIL + 1)); echo "FAIL [${shell}] non-numeric --now is not exit 2" >&2; fi
  if [ "${shell}" = bash ]; then BASH_CHECKS=$((BASH_CHECKS + 2)); else SH_CHECKS=$((SH_CHECKS + 2)); fi
done

FLOOR=20
echo "dev-apply-lag fixtures: ${PASS} passed, ${FAIL} failed (bash ${BASH_CHECKS}, sh ${SH_CHECKS})"
[ "${BASH_CHECKS}" -eq "${SH_CHECKS}" ] || { echo "FAIL: per-shell check counts differ" >&2; exit 1; }
[ "${BASH_CHECKS}" -ge "${FLOOR}" ] || { echo "FAIL: ran ${BASH_CHECKS} checks per shell, floor is ${FLOOR}" >&2; exit 1; }
[ "${FAIL}" -eq 0 ]
