#!/usr/bin/env bash
#
# subscription-spend-alert.sh — the OPERATOR-owned subscription spend alert and a
# live check of subscription state (issue #225).
#
# WHY THIS IS NOT IN TERRAFORM. The CI apply identity is Contributor on
# meatgeek-v2-dev-rg only, so the stack cannot write a /subscriptions/<id>
# budget (manage_subscription_budget = false in environments/dev.tfvars). The
# credit the subscription runs on is shared by everything in it, other projects
# included, so a resource-group budget cannot see it run out. This script is the
# written-down owner of the subscription budget: an operator runs it, as a
# subscription Owner, after the first dev apply (the action group it routes to
# is Terraform-managed and must exist first).
#
# Subcommands:
#   ensure        Create or update the subscription budget ${BUDGET_NAME}, with
#                 amount ${MONTHLY_CREDIT} (the monthly credit) and Actual 50/80/100%
#                 plus Forecasted 100% notifications, every one routed to the
#                 action group ${ACTION_GROUP_NAME}: the path the Log Analytics cap
#                 alerts use, proven in HAR-179. Then read it back and fail unless
#                 Azure stored exactly that.
#   check-state   Ask ARM for the subscription's state now. `az account show`
#                 prints the state cached at `az login` time, so it still says
#                 "Enabled" after Azure disables the subscription; this does a live
#                 GET /subscriptions/<id> instead. Exit 0 only when the state is
#                 Enabled.
#
# Exit codes: 0 ok; 1 operational failure (az failed, bad input, read-back
# mismatch); 3 check-state only, the subscription is not Enabled.
#
# Inputs (environment):
#   SUBSCRIPTION_ID     default: the id `az account show` reports (the id is safe
#                       to take from the cache; its state is not)
#   MONTHLY_CREDIT      budget amount in the billing currency, default 200
#                       (environments/dev.tfvars: "$200 Azure credit")
#   BUDGET_NAME         default meatgeek-v2-dev-credit-budget, the name the
#                       Terraform resource used, so `ensure` adopts a budget left
#                       behind by `terraform state rm` instead of adding a second
#   ACTION_GROUP_RG     default meatgeek-v2-dev-rg
#   ACTION_GROUP_NAME   default meatgeek-v2-dev-alerts
#   BUDGET_START_DATE   default the first day of the current UTC month (YYYY-MM-01)
#   AZ_BIN              default az; the fixture harness points it at a fake az
#
# Usage:
#   az login && az account set --subscription <id>
#   bash apps/infrastructure/scripts/subscription-spend-alert.sh ensure
#   bash apps/infrastructure/scripts/subscription-spend-alert.sh check-state
#
# Runbook: docs/monitoring/observability.md, "Budgets".
set -euo pipefail

AZ_BIN="${AZ_BIN:-az}"
ARM="https://management.azure.com"
BUDGET_API="2023-05-01"
SUBSCRIPTION_API="2022-12-01"
ACTION_GROUP_API="2023-01-01"

die() { printf 'subscription-spend-alert: %s\n' "$*" >&2; exit 1; }
log() { printf '%s\n' "$*" >&2; }

command -v jq >/dev/null 2>&1 || die "jq is required"

subscription_id() {
  local id="${SUBSCRIPTION_ID:-}"
  if [ -z "$id" ]; then
    id="$("$AZ_BIN" account show --query id -o tsv)" || die "az account show failed; run az login"
  fi
  printf '%s' "$id" | grep -Eqi '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' \
    || die "subscription id is not a GUID: '$id'"
  printf '%s' "$id"
}

check_state() {
  local sub doc state limit
  sub="$(subscription_id)"
  doc="$("$AZ_BIN" rest --method get \
    --url "${ARM}/subscriptions/${sub}?api-version=${SUBSCRIPTION_API}")" \
    || die "GET /subscriptions/${sub} failed"
  state="$(printf '%s' "$doc" | jq -r '.state // empty')" || die "subscription document is not JSON"
  [ -n "$state" ] || die "subscription document has no .state"
  limit="$(printf '%s' "$doc" | jq -r '.subscriptionPolicies.spendingLimit // "unknown"')"
  printf 'subscription %s state=%s spendingLimit=%s\n' "$sub" "$state" "$limit"
  if [ "$state" != "Enabled" ]; then
    log "NOT ENABLED: Azure has disabled or restricted this subscription; see docs/monitoring/observability.md, Budgets"
    exit 3
  fi
}

# The budget body. Every notification goes to the action group only, so there is
# one delivery path to prove, and it is the one already proven.
budget_body() {
  local amount="$1" start="$2" group="$3"
  jq -cn --argjson amount "$amount" --arg start "${start}T00:00:00Z" --arg group "$group" '
    def note($t; $type): {enabled: true, operator: "GreaterThan", threshold: $t,
      thresholdType: $type, contactEmails: [], contactGroups: [$group]};
    {properties: {
      category: "Cost", amount: $amount, timeGrain: "Monthly",
      timePeriod: {startDate: $start},
      notifications: {
        actual_50: note(50; "Actual"),
        actual_80: note(80; "Actual"),
        actual_100: note(100; "Actual"),
        forecasted_100: note(100; "Forecasted")
      }}}'
}

# What a read-back must match, normalised so key order and the case Azure
# returns an action-group id in do not matter.
budget_shape() {
  jq -S '{amount: (.properties.amount | tonumber), timeGrain: .properties.timeGrain,
    notifications: (.properties.notifications | with_entries(.key |= ascii_downcase)
      | map_values({enabled, operator, threshold: (.threshold | tonumber),
          thresholdType, contactGroups: ((.contactGroups // []) | map(ascii_downcase) | sort)}))}'
}

ensure() {
  local sub amount start group url body want got
  sub="$(subscription_id)"
  amount="${MONTHLY_CREDIT:-200}"
  printf '%s' "$amount" | grep -Eq '^[0-9]+(\.[0-9]+)?$' || die "MONTHLY_CREDIT must be a number: '$amount'"
  start="${BUDGET_START_DATE:-$(date -u +%Y-%m-01)}"
  printf '%s' "$start" | grep -Eq '^[0-9]{4}-[0-9]{2}-01$' \
    || die "BUDGET_START_DATE must be the first of a month (YYYY-MM-01): '$start'"
  group="/subscriptions/${sub}/resourceGroups/${ACTION_GROUP_RG:-meatgeek-v2-dev-rg}/providers/microsoft.insights/actionGroups/${ACTION_GROUP_NAME:-meatgeek-v2-dev-alerts}"

  "$AZ_BIN" rest --method get --url "${ARM}${group}?api-version=${ACTION_GROUP_API}" >/dev/null \
    || die "action group not found: ${group} (apply the dev stack first)"

  url="${ARM}/subscriptions/${sub}/providers/Microsoft.Consumption/budgets/${BUDGET_NAME:-meatgeek-v2-dev-credit-budget}?api-version=${BUDGET_API}"
  body="$(budget_body "$amount" "$start" "$group")"
  "$AZ_BIN" rest --method put --url "$url" --body "$body" >/dev/null || die "PUT budget failed"

  want="$(printf '%s' "$body" | budget_shape)"
  got="$("$AZ_BIN" rest --method get --url "$url" | budget_shape)" || die "budget read-back failed"
  if [ "$want" != "$got" ]; then
    log "read-back differs from what was written"
    log "want: $want"
    log "got:  $got"
    exit 1
  fi
  printf 'budget %s: amount %s monthly from %s, Actual 50/80/100%% and Forecasted 100%% to %s\n' \
    "${BUDGET_NAME:-meatgeek-v2-dev-credit-budget}" "$amount" "$start" "$group"
}

case "${1:-}" in
  ensure) ensure ;;
  check-state) check_state ;;
  *) die "usage: $0 ensure|check-state" ;;
esac
