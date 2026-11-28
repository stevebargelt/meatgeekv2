#!/usr/bin/env bash
#
# run-subscription-spend-alert-fixtures.sh — credential-less tests for
# scripts/subscription-spend-alert.sh (issue #225).
#
# The script is the operator-owned subscription budget and the live check of
# subscription state. This harness points its AZ_BIN at a fake `az` that logs
# every call and answers from files, so it reaches no network and needs no
# credential. It pins:
#   * ensure writes ONE budget whose every notification routes to the dev action
#     group (the path the cap alerts proved), with the amount set to the credit;
#   * ensure checks the action group exists before writing, and fails when Azure
#     stores something other than what was written;
#   * check-state reads the state from a live GET /subscriptions/<id>, never from
#     `az account show`'s cached state, and exits 3 on anything but Enabled.
#
# Exit 0 iff every check passes.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
SCRIPT="${HERE}/../subscription-spend-alert.sh"
[ -f "$SCRIPT" ] || { echo "FATAL: script not found: $SCRIPT" >&2; exit 2; }
command -v jq >/dev/null 2>&1 || { echo "FATAL: jq is required" >&2; exit 2; }

SUB="11111111-2222-3333-4444-555555555555"
AG="/subscriptions/${SUB}/resourceGroups/meatgeek-v2-dev-rg/providers/microsoft.insights/actionGroups/meatgeek-v2-dev-alerts"
BUDGET_URL="https://management.azure.com/subscriptions/${SUB}/providers/Microsoft.Consumption/budgets/meatgeek-v2-dev-credit-budget?api-version=2023-05-01"

WORK="$(mktemp -d)" || { echo "FATAL: mktemp -d failed" >&2; exit 2; }
trap 'rm -rf "$WORK"' EXIT HUP INT TERM

# The fake az. State lives in $FAKE: calls.log gets one line per call;
# account.id answers `account show`; subscription.json (or subscription.rc)
# answers GET /subscriptions/<id>; actiongroup.rc makes the action-group GET
# fail; a PUT stores its body in budget.json, which the budget GET returns
# (through readback.jq when present, to simulate Azure storing something else).
FAKE_AZ="${WORK}/fake-az"
cat > "$FAKE_AZ" <<'FAKEAZ'
#!/usr/bin/env bash
set -u
printf '%s\n' "$*" >> "$FAKE/calls.log"
if [ "$1 $2" = "account show" ]; then
  [ -f "$FAKE/account.id" ] || exit 1
  cat "$FAKE/account.id"; exit 0
fi
[ "$1" = "rest" ] || exit 1
shift
method=""; url=""; body=""
while [ $# -gt 0 ]; do
  case "$1" in
    --method) method="$2"; shift 2 ;;
    --url) url="$2"; shift 2 ;;
    --body) body="$2"; shift 2 ;;
    *) shift ;;
  esac
done
case "$method $url" in
  "get "*/actionGroups/*)
    [ -f "$FAKE/actiongroup.rc" ] && exit "$(cat "$FAKE/actiongroup.rc")"
    echo '{"id":"ag"}' ;;
  "put "*/budgets/*)
    printf '%s' "$body" > "$FAKE/budget.json"; cat "$FAKE/budget.json" ;;
  "get "*/budgets/*)
    if [ -f "$FAKE/readback.jq" ]; then jq -f "$FAKE/readback.jq" "$FAKE/budget.json"
    else cat "$FAKE/budget.json"; fi ;;
  "get "*/subscriptions/*)
    [ -f "$FAKE/subscription.rc" ] && exit "$(cat "$FAKE/subscription.rc")"
    cat "$FAKE/subscription.json" ;;
  *) exit 1 ;;
esac
FAKEAZ
chmod +x "$FAKE_AZ"

pass=0; fail=0
ok()  { pass=$((pass+1)); printf 'ok   - %s\n' "$1"; }
bad() { fail=$((fail+1)); printf 'FAIL - %s\n' "$1"; }
check() { if eval "$2"; then ok "$1"; else bad "$1"; fi; }

# A fresh fake state per case. run <subcommand> [VAR=value ...] sets $rc and $out.
n=0
fresh() { n=$((n+1)); FAKE="${WORK}/case${n}"; mkdir -p "$FAKE"; : > "$FAKE/calls.log"; }
run() {
  local sub="$1"; shift
  out="$(env FAKE="$FAKE" AZ_BIN="$FAKE_AZ" SUBSCRIPTION_ID="$SUB" BUDGET_START_DATE=2026-11-01 \
    "$@" bash "$SCRIPT" "$sub" 2>"$FAKE/stderr")"
  rc=$?
}
puts() { grep -c '^rest --method put' "$FAKE/calls.log"; }
budget() { jq -r "$1" "$FAKE/budget.json"; }

# --- ensure: the happy path -------------------------------------------------
fresh; run ensure
check "ensure exits 0" '[ "$rc" -eq 0 ]'
check "ensure writes exactly one budget" '[ "$(puts)" -eq 1 ]'
check "ensure PUTs the budget the Terraform resource used to own" \
  'grep -qF -- "--url ${BUDGET_URL}" "$FAKE/calls.log"'
check "ensure checks the action group before writing" \
  '[ "$(grep -n . "$FAKE/calls.log" | grep ":rest --method get .*actionGroups" | cut -d: -f1)" -lt "$(grep -n "^rest --method put" "$FAKE/calls.log" | cut -d: -f1)" ]'
check "amount defaults to the 200 credit, monthly" \
  '[ "$(budget ".properties.amount") $(budget ".properties.timeGrain") $(budget ".properties.category")" = "200 Monthly Cost" ]'
check "starts on the given first of the month" \
  '[ "$(budget ".properties.timePeriod.startDate")" = "2026-11-01T00:00:00Z" ]'
check "notifications are Actual 50/80/100 and Forecasted 100" \
  '[ "$(budget "[.properties.notifications[] | \"\(.thresholdType)\(.threshold)\"] | sort | join(\",\")")" = "Actual100,Actual50,Actual80,Forecasted100" ]'
check "every notification is enabled and routes ONLY to the dev action group" \
  '[ "$(budget "[.properties.notifications[] | select(.enabled == true and .operator == \"GreaterThan\" and .contactGroups == [\"${AG}\"] and .contactEmails == [])] | length")" -eq 4 ]'
check "ensure never reads the cached account when SUBSCRIPTION_ID is set" \
  '! grep -q "^account" "$FAKE/calls.log"'

# --- ensure: a forced breach uses a low amount -------------------------------
fresh; run ensure MONTHLY_CREDIT=1
check "MONTHLY_CREDIT=1 writes a 1-unit budget (the forced-breach test)" \
  '[ "$rc" -eq 0 ] && [ "$(budget ".properties.amount")" = "1" ]'

# --- ensure: failures -------------------------------------------------------
fresh; echo 3 > "$FAKE/actiongroup.rc"; run ensure
check "missing action group: exit 1 and nothing written" '[ "$rc" -eq 1 ] && [ "$(puts)" -eq 0 ]'

fresh; echo '.properties.notifications.actual_80.contactGroups = []' > "$FAKE/readback.jq"; run ensure
check "read-back without the action group: exit 1" '[ "$rc" -eq 1 ]'

fresh; echo '.properties.amount = 150' > "$FAKE/readback.jq"; run ensure
check "read-back with another amount: exit 1" '[ "$rc" -eq 1 ]'

fresh; echo '.properties.notifications |= with_entries(.key |= ascii_upcase) | .properties.notifications[].contactGroups |= map(ascii_upcase)' > "$FAKE/readback.jq"; run ensure
check "read-back differing only in key and id case: exit 0" '[ "$rc" -eq 0 ]'

fresh; run ensure BUDGET_START_DATE=2026-11-15
check "start date not on the first: exit 1, no az call" '[ "$rc" -eq 1 ] && [ ! -s "$FAKE/calls.log" ]'

fresh; run ensure MONTHLY_CREDIT=lots
check "non-numeric credit: exit 1, no az call" '[ "$rc" -eq 1 ] && [ ! -s "$FAKE/calls.log" ]'

# --- check-state ------------------------------------------------------------
sub_doc() { printf '{"subscriptionId":"%s","state":"%s","subscriptionPolicies":{"spendingLimit":"On"}}' "$SUB" "$1" > "$FAKE/subscription.json"; }

fresh; sub_doc Enabled; run check-state
check "Enabled: exit 0" '[ "$rc" -eq 0 ]'
check "Enabled: prints state and spending limit" \
  '[ "$out" = "subscription ${SUB} state=Enabled spendingLimit=On" ]'
check "the state comes from a live GET /subscriptions/<id>" \
  'grep -qF "rest --method get --url https://management.azure.com/subscriptions/${SUB}?api-version=" "$FAKE/calls.log"'

for s in Disabled Warned PastDue Deleted; do
  fresh; sub_doc "$s"; run check-state
  check "${s}: exit 3" '[ "$rc" -eq 3 ]'
done

fresh; echo 1 > "$FAKE/subscription.rc"; run check-state
check "GET fails: exit 1, not 0" '[ "$rc" -eq 1 ]'

fresh; echo '{"subscriptionId":"x"}' > "$FAKE/subscription.json"; run check-state
check "no state in the document: exit 1" '[ "$rc" -eq 1 ]'

# Without SUBSCRIPTION_ID the id (only) comes from the cache; the cached state
# must never be what is reported.
fresh; sub_doc Disabled; echo "$SUB" > "$FAKE/account.id"
out="$(env FAKE="$FAKE" AZ_BIN="$FAKE_AZ" bash "$SCRIPT" check-state 2>/dev/null)"; rc=$?
check "id from az account show, state still from ARM: exit 3" '[ "$rc" -eq 3 ]'
check "az account show is asked for the id only" \
  '[ "$(grep "^account" "$FAKE/calls.log")" = "account show --query id -o tsv" ]'

fresh; run nonsense
check "unknown subcommand: exit 1" '[ "$rc" -eq 1 ]'

printf '\n%d passed, %d failed\n' "$pass" "$fail"
MIN_CHECKS=28
[ "$fail" -eq 0 ] || exit 1
[ "$pass" -ge "$MIN_CHECKS" ] || { echo "FAIL - only $pass checks ran (floor $MIN_CHECKS)"; exit 1; }
