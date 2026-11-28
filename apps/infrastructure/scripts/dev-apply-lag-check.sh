#!/usr/bin/env bash
#
# dev-apply-lag-check.sh — the missed-reconciliation detector for the dev
# GitOps loop (#224, carried over from MG-38).
#
# infra-apply-dev.yml applies dev only off a CI/CD Pipeline run of a push to
# `main` that concluded `success`, and a run whose SHA is no longer main's tip
# skips cleanly. So if a superseding commit's CI is red, neither commit is
# applied and nothing goes red. This check finds that state:
#
#   GREEN    the newest push-to-main CI/CD Pipeline run that succeeded, and its
#            head SHA. Runs are listed newest-created first, and a re-run keeps
#            its run's creation time, so the first is the newest-pushed green SHA.
#   APPLIED  the head SHA of the newest infra-apply-dev run whose
#            "Terraform apply" step succeeded. A run that skipped as superseded
#            ends `success` with that step skipped, so the step decides, not the
#            run's conclusion. A run that applied has passed both freshness
#            gates, so its head SHA is the SHA it applied.
#
# and compares them with GitHub's compare API (base APPLIED, head GREEN):
#
#   identical   in sync. This includes the state the loop is meant to produce
#               when main's tip is red: the newest GREEN SHA is applied, and the
#               red tip is correctly withheld. No alert.
#   behind      dev holds something newer than the newest green SHA (a recovery
#               apply). No alert.
#   ahead       a green SHA is ahead of dev. If its CI finished more than
#               --grace-minutes ago, its apply has had time to land and has not:
#               MISSED RECONCILIATION. Inside the grace window the apply may still
#               be queued or running, so it is reported as pending.
#   diverged    dev holds a tree that is not in main's history. Alert.
#
# Exit codes: 0 no alert, 3 alert, 1 could not tell (any API error or unexpected
# answer; a check that cannot see is never "in sync"), 2 usage error.
#
# Read-only. It needs only a GITHUB_TOKEN that can read Actions runs and repo
# contents; it never touches Azure or state.
#
# Usage:
#   dev-apply-lag-check.sh --repo OWNER/REPO [--grace-minutes N] [--now EPOCH]
#   GH_BIN=/path/to/fake-gh dev-apply-lag-check.sh ...   # testing seam
#
# POSIX sh: the fixture harness runs it under bash and sh.
set -u

GH_BIN="${GH_BIN:-gh}"
REPO=''
GRACE_MINUTES=120
NOW=''
APPLY_RUNS_PER_PAGE=100

usage() { echo "usage: $0 --repo OWNER/REPO [--grace-minutes N] [--now EPOCH]" >&2; exit 2; }
fail() { echo "dev-apply-lag-check: $* — could not tell whether dev is behind; failing closed." >&2; exit 1; }
is_sha() { printf '%s' "$1" | grep -Eq '^[0-9a-f]{40}$'; }
is_uint() { printf '%s' "$1" | grep -Eq '^[0-9]+$'; }

while [ "$#" -gt 0 ]; do
  case "$1" in
    --repo) [ "$#" -ge 2 ] || usage; REPO="$2"; shift 2 ;;
    --grace-minutes) [ "$#" -ge 2 ] || usage; GRACE_MINUTES="$2"; shift 2 ;;
    --now) [ "$#" -ge 2 ] || usage; NOW="$2"; shift 2 ;;
    *) usage ;;
  esac
done
printf '%s' "$REPO" | grep -Eq '^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+$' || usage
is_uint "$GRACE_MINUTES" || usage
[ -n "$NOW" ] || NOW="$(date +%s)"
is_uint "$NOW" || usage
command -v jq >/dev/null 2>&1 || fail "jq is not on PATH"
command -v "$GH_BIN" >/dev/null 2>&1 || fail "gh ('$GH_BIN') is not on PATH"

api() { "$GH_BIN" api "$1"; }

# --- GREEN ---------------------------------------------------------------------
CI_JSON="$(api "repos/${REPO}/actions/workflows/ci.yml/runs?branch=main&event=push&status=success&per_page=1")" ||
  fail "listing successful CI/CD Pipeline runs on main failed"
GREEN_SHA="$(printf '%s' "$CI_JSON" | jq -r '.workflow_runs[0].head_sha // empty' 2>/dev/null)" ||
  fail "the CI runs answer is not JSON"
is_sha "$GREEN_SHA" || fail "no successful CI/CD Pipeline run of a push to main was found"
GREEN_AT="$(printf '%s' "$CI_JSON" | jq -r '.workflow_runs[0].updated_at | fromdateiso8601' 2>/dev/null)" ||
  fail "the newest green CI run has no readable completion time"
is_uint "$GREEN_AT" || fail "the newest green CI run has no readable completion time"

# --- APPLIED -------------------------------------------------------------------
RUNS_JSON="$(api "repos/${REPO}/actions/workflows/infra-apply-dev.yml/runs?status=completed&per_page=${APPLY_RUNS_PER_PAGE}")" ||
  fail "listing infra-apply-dev runs failed"
# Skipped runs (every pull request's CI run triggers the workflow, and its job
# skips) never applied anything, so they need no jobs lookup.
CANDIDATES="$(printf '%s' "$RUNS_JSON" |
  jq -r '.workflow_runs[] | select(.conclusion != "skipped") | "\(.id) \(.head_sha)"' 2>/dev/null)" ||
  fail "the infra-apply-dev runs answer is not JSON"

APPLIED_SHA=''
APPLIED_RUN=''
# A here-document, not a pipe, so the loop runs in this shell and can set
# APPLIED_SHA and call fail.
while read -r run_id run_sha; do
  [ -n "$run_id" ] || continue
  is_uint "$run_id" || fail "an infra-apply-dev run has a malformed id"
  JOBS_JSON="$(api "repos/${REPO}/actions/runs/${run_id}/jobs?filter=latest")" ||
    fail "reading the jobs of infra-apply-dev run ${run_id} failed"
  APPLIED_STEPS="$(printf '%s' "$JOBS_JSON" |
    jq '[.jobs[].steps[]? | select((.name | startswith("Terraform apply")) and .conclusion == "success")] | length' 2>/dev/null)" ||
    fail "the jobs answer of infra-apply-dev run ${run_id} is not JSON"
  if is_uint "$APPLIED_STEPS" && [ "$APPLIED_STEPS" -gt 0 ]; then
    is_sha "$run_sha" || fail "infra-apply-dev run ${run_id} applied but has a malformed head SHA"
    APPLIED_SHA="$run_sha"
    APPLIED_RUN="$run_id"
    break
  fi
done <<EOF
$CANDIDATES
EOF
[ -n "$APPLIED_SHA" ] ||
  fail "none of the last ${APPLY_RUNS_PER_PAGE} infra-apply-dev runs applied anything"

echo "newest green main SHA: ${GREEN_SHA} (CI finished $(((NOW - GREEN_AT) / 60)) min ago)"
echo "last SHA applied to dev: ${APPLIED_SHA} (infra-apply-dev run ${APPLIED_RUN})"

if [ "$GREEN_SHA" = "$APPLIED_SHA" ]; then
  echo "Dev is in sync with the newest green main SHA. No alert."
  exit 0
fi

# --- COMPARE -------------------------------------------------------------------
CMP_JSON="$(api "repos/${REPO}/compare/${APPLIED_SHA}...${GREEN_SHA}")" ||
  fail "comparing ${APPLIED_SHA} with ${GREEN_SHA} failed"
STATUS="$(printf '%s' "$CMP_JSON" | jq -r '.status // empty' 2>/dev/null)" ||
  fail "the compare answer is not JSON"

case "$STATUS" in
  identical)
    echo "Dev is in sync with the newest green main SHA. No alert."
    exit 0
    ;;
  behind)
    echo "Dev is ahead of the newest green main SHA (the green SHA is behind it). No alert."
    exit 0
    ;;
  ahead)
    if [ $((NOW - GREEN_AT)) -lt $((GRACE_MINUTES * 60)) ]; then
      echo "A green main SHA is ahead of dev, but its CI finished less than ${GRACE_MINUTES} min ago;"
      echo "its apply is pending. No alert yet."
      exit 0
    fi
    echo "MISSED RECONCILIATION: green main SHA ${GREEN_SHA} is ahead of the last SHA applied to dev,"
    echo "${APPLIED_SHA}, and its CI finished more than ${GRACE_MINUTES} min ago."
    echo "Dev is behind main and no apply is coming. Run the recovery path of infra-apply-dev.yml"
    echo "(docs/infrastructure/mg23-live-acceptance.md §10, MG-38) to reconcile."
    exit 3
    ;;
  diverged)
    echo "MISSED RECONCILIATION: the last SHA applied to dev, ${APPLIED_SHA}, is not in main's history"
    echo "(it has diverged from green main SHA ${GREEN_SHA}). Run the recovery path of infra-apply-dev.yml."
    exit 3
    ;;
  *)
    fail "the compare answer has an unknown status '${STATUS}'"
    ;;
esac
