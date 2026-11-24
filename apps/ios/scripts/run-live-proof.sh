#!/usr/bin/env bash
# HAR-169 (goal HAR-157) — the live iOS proof's runner.
#
# Runs MeatGeekLiveUITests (the `Live` test plan) against dev, in a throwaway
# simulator, while simdevice sends the iOS device's readings:
#
#   1. checks its inputs (below), naming every missing one;
#   2. syncs the device's twin (`simdevice --twin --count 0`), so a device
#      released since its last sync mints a fresh claim code, then reads it
#      (`simdevice claim-code`): `unclaimed` passes the code to the test,
#      `claimed` passes `already-claimed` (an earlier run stopped before it
#      released the device);
#   3. creates an iPhone simulator on the iOS runtime matching Xcode's SDK and
#      boots it (deleted again on exit, so no sign-in or cookie outlives it);
#   4. builds the app and the live tests (`xcodebuild build-for-testing`);
#   5. starts simdevice in the background, sending a reading every 2 s, and
#      waits for its first one;
#   6. runs the test plan (`xcodebuild test-without-building -testPlan Live`)
#      with the test's inputs as TEST_RUNNER_MEATGEEK_LIVE_* variables;
#   7. on exit, whatever happened: stops simdevice, says how many readings it
#      sent, deletes the simulator and its own temporary files.
#
# Exits with xcodebuild's status, or 2 for a usage or setup problem.
#
# Inputs, all from the environment (the same names as the web proof's):
#   ACCEPTANCE_USER_UPN, ACCEPTANCE_USER_PASSWORD, ACCEPTANCE_USER_TOTP_SECRET
#       the acceptance user
#   ACCEPTANCE_IOS_DEVICE_ID   the device the proof claims and sends as
#   ACCEPTANCE_IOS_STATE_DIR   its simdevice state dir (its DPS identity)
#   ACCEPTANCE_DPS_ID_SCOPE    the dev DPS's ID scope
#   ACCEPTANCE_SIMDEVICE_BIN   the built simdevice
# Optional:
#   ACCEPTANCE_DPS_ENDPOINT    simdevice's DPS endpoint (its default otherwise)
#   ACCEPTANCE_RUN_ID          names the cook (default: a UTC timestamp)
#   IOS_SIMULATOR              device type (default "iPhone 17")
#   IOS_LIVE_RESULT_BUNDLE     the .xcresult to write (default ./ios-live-proof.xcresult; must not exist)
#   IOS_LIVE_DERIVED_DATA      DerivedData (default under $TMPDIR)
#
# Secrets never reach a command line: the password, TOTP secret and claim code
# go to xcodebuild only as exported TEST_RUNNER_* variables, which it hands to
# the test runner, and the claim code is read from simdevice's output into a
# variable. simdevice itself gets PATH, HOME and its MEATGEEK_* variables only.
# Nothing here prints a secret; simdevice's own output stays in a temporary
# directory, and only the first line of its stderr is ever printed, with
# anything shaped like a claim code masked.
#
# Docs: "Live iOS proof" in docs/development/live-acceptance.md.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../../.." && pwd)"
PROJECT="$REPO_ROOT/apps/ios/MeatGeek.xcodeproj"
# Every bound below has a row in "The iOS proof's waits" in
# docs/development/live-acceptance.md.
TWIN_SYNC_TIMEOUT=60s
SEND_INTERVAL=2s
# 900 readings 2 s apart: 30 min, longer than the job's timeout.
SEND_COUNT=900
FIRST_READING_BOUND_S=60

note() { printf 'run-live-proof: %s\n' "$*"; }
fail() { printf 'run-live-proof: %s\n' "$*" >&2; exit 2; }
# simdevice's stderr can quote a claim code; mask anything shaped like one.
mask() { sed -E 's/(^|[^0-9A-Za-z-])[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}-[0-9A-HJKMNP-TV-Z]{4}([^0-9A-Za-z-]|$)/\1[redacted]\2/g'; }

missing=()
for name in ACCEPTANCE_USER_UPN ACCEPTANCE_USER_PASSWORD ACCEPTANCE_USER_TOTP_SECRET \
  ACCEPTANCE_IOS_DEVICE_ID ACCEPTANCE_IOS_STATE_DIR ACCEPTANCE_DPS_ID_SCOPE ACCEPTANCE_SIMDEVICE_BIN; do
  [ -n "${!name:-}" ] || missing+=("$name")
done
[ "${#missing[@]}" -eq 0 ] || fail "missing: ${missing[*]} (see \"Live iOS proof\" in docs/development/live-acceptance.md)"
[ -x "$ACCEPTANCE_SIMDEVICE_BIN" ] || fail "ACCEPTANCE_SIMDEVICE_BIN is not an executable file"
[ -d "$ACCEPTANCE_IOS_STATE_DIR" ] || fail "ACCEPTANCE_IOS_STATE_DIR is not a directory (enrol the device first)"

RESULT_BUNDLE="${IOS_LIVE_RESULT_BUNDLE:-$PWD/ios-live-proof.xcresult}"
DERIVED_DATA="${IOS_LIVE_DERIVED_DATA:-${TMPDIR:-/tmp}/meatgeek-ios-live-derived-data}"
SIMULATOR="${IOS_SIMULATOR:-iPhone 17}"
RUN_ID="${ACCEPTANCE_RUN_ID:-$(date -u +%Y%m%dT%H%M%SZ)}"
[ ! -e "$RESULT_BUNDLE" ] || fail "$RESULT_BUNDLE already exists: remove it or set IOS_LIVE_RESULT_BUNDLE"

work="$(mktemp -d)"
sender_pid=""
udid=""
# shellcheck disable=SC2329 # run by the EXIT trap
cleanup() {
  local rc=$?
  if [ -n "$sender_pid" ]; then
    if kill -0 "$sender_pid" 2>/dev/null; then
      kill "$sender_pid" 2>/dev/null || true
    fi
    wait "$sender_pid" 2>/dev/null || true
    note "simdevice: stopped; it sent $(wc -l < "$work/sent.jsonl" | tr -d ' ') readings as $ACCEPTANCE_IOS_DEVICE_ID"
  fi
  if [ -n "$udid" ]; then
    xcrun simctl shutdown "$udid" >/dev/null 2>&1 || true
    xcrun simctl delete "$udid" >/dev/null 2>&1 || true
    note "simulator: deleted $udid"
  fi
  rm -rf "$work"
  exit "$rc"
}
trap cleanup EXIT
trap 'exit 130' INT TERM

# simdevice with its own environment only: PATH, HOME, the device's DPS mode.
simdevice() {
  local env=(PATH="$PATH" HOME="$HOME"
    MEATGEEK_DPS_ID_SCOPE="$ACCEPTANCE_DPS_ID_SCOPE"
    MEATGEEK_DEVICE_ID="$ACCEPTANCE_IOS_DEVICE_ID"
    MEATGEEK_STATE_DIR="$ACCEPTANCE_IOS_STATE_DIR")
  [ -z "${ACCEPTANCE_DPS_ENDPOINT:-}" ] || env+=(MEATGEEK_DPS_ENDPOINT="$ACCEPTANCE_DPS_ENDPOINT")
  env -i "${env[@]}" "$ACCEPTANCE_SIMDEVICE_BIN" "$@"
}

# 2. The claim code.
if ! simdevice --twin --count 0 --timeout "$TWIN_SYNC_TIMEOUT" >"$work/twin.out" 2>"$work/twin.err"; then
  fail "simdevice could not sync $ACCEPTANCE_IOS_DEVICE_ID's twin: $(head -n 1 "$work/twin.err" | mask)"
fi
claim_rc=0
env -i PATH="$PATH" HOME="$HOME" "$ACCEPTANCE_SIMDEVICE_BIN" claim-code \
  --state-dir "$ACCEPTANCE_IOS_STATE_DIR" >"$work/claim.json" 2>"$work/claim.err" || claim_rc=$?
if [ "$claim_rc" -eq 3 ]; then
  fail "simdevice claim-code: $ACCEPTANCE_IOS_DEVICE_ID has minted no claim code, even after a twin sync"
elif [ "$claim_rc" -ne 0 ]; then
  fail "simdevice claim-code exited $claim_rc: $(head -n 1 "$work/claim.err" | mask)"
fi
claim_state="$(plutil -extract state raw -o - "$work/claim.json" 2>/dev/null)" || claim_state=""
case "$claim_state" in
  unclaimed)
    claim_code="$(plutil -extract claimCode raw -o - "$work/claim.json" 2>/dev/null)" || claim_code=""
    [ -n "$claim_code" ] || fail "simdevice claim-code reports $ACCEPTANCE_IOS_DEVICE_ID unclaimed, with no code"
    note "claim: $ACCEPTANCE_IOS_DEVICE_ID is unclaimed; the test claims it with the code it reports"
    ;;
  claimed)
    claim_code="already-claimed"
    note "claim: $ACCEPTANCE_IOS_DEVICE_ID reports claimed (an earlier run did not release it); the test expects it on the acceptance user's Devices tab"
    ;;
  *)
    fail "simdevice claim-code reports $ACCEPTANCE_IOS_DEVICE_ID ${claim_state:-in no readable state}; expected unclaimed or claimed"
    ;;
esac
rm -f "$work/claim.json"

# 3. A throwaway simulator on the runtime matching Xcode's simulator SDK.
sdk="$(xcrun --sdk iphonesimulator --show-sdk-version)"
runtime="$(xcrun simctl list runtimes -j | /usr/bin/python3 -I -c '
import json, sys
sdk = sys.argv[1]
for r in json.load(sys.stdin)["runtimes"]:
    if r.get("platform") == "iOS" and r.get("isAvailable") and (r["version"] == sdk or r["version"].startswith(sdk + ".")):
        print(r["identifier"]); break
' "$sdk")"
[ -n "$runtime" ] || fail "no available iOS $sdk simulator runtime for $(xcodebuild -version | head -n 1)"
udid="$(xcrun simctl create "MeatGeek live proof $RUN_ID" "$SIMULATOR" "$runtime")"
note "simulator: created $SIMULATOR on $runtime ($udid)"
xcrun simctl bootstatus "$udid" -b >/dev/null
note "simulator: booted"

# 4. Build. Default simulator signing ("Sign to Run Locally"): the app's MSAL
# keychain cache needs the build's entitlements, which CODE_SIGNING_ALLOWED=NO
# drops. No team id is involved.
xcodebuild build-for-testing -quiet \
  -project "$PROJECT" -scheme MeatGeek -testPlan Live \
  -destination "id=$udid" -derivedDataPath "$DERIVED_DATA" \
  -skipPackagePluginValidation
note "build: done"

# 5. Readings, for the length of the test.
simdevice --count "$SEND_COUNT" --interval "$SEND_INTERVAL" >"$work/sent.jsonl" 2>"$work/sent.err" &
sender_pid=$!
waited=0
while [ ! -s "$work/sent.jsonl" ]; do
  if ! kill -0 "$sender_pid" 2>/dev/null; then
    sender_rc=0
    wait "$sender_pid" || sender_rc=$?
    sender_pid=""
    fail "simdevice exited $sender_rc before sending a reading: $(head -n 1 "$work/sent.err" | mask)"
  fi
  [ "$waited" -lt "$FIRST_READING_BOUND_S" ] || fail "simdevice sent no reading within ${FIRST_READING_BOUND_S} s"
  sleep 1
  waited=$((waited + 1))
done
note "simdevice: sending a reading every $SEND_INTERVAL as $ACCEPTANCE_IOS_DEVICE_ID (first after ~${waited} s)"

# 6. The proof. Exported in a subshell, so only xcodebuild's environment holds
# them; xcodebuild passes TEST_RUNNER_<NAME> to the test runner as <NAME>.
test_rc=0
(
  export TEST_RUNNER_MEATGEEK_LIVE_UPN="$ACCEPTANCE_USER_UPN"
  export TEST_RUNNER_MEATGEEK_LIVE_PASSWORD="$ACCEPTANCE_USER_PASSWORD"
  export TEST_RUNNER_MEATGEEK_LIVE_TOTP_SECRET="$ACCEPTANCE_USER_TOTP_SECRET"
  export TEST_RUNNER_MEATGEEK_LIVE_DEVICE_ID="$ACCEPTANCE_IOS_DEVICE_ID"
  export TEST_RUNNER_MEATGEEK_LIVE_CLAIM_CODE="$claim_code"
  export TEST_RUNNER_MEATGEEK_LIVE_RUN_ID="$RUN_ID"
  exec xcodebuild test-without-building \
    -project "$PROJECT" -scheme MeatGeek -testPlan Live \
    -destination "id=$udid" -derivedDataPath "$DERIVED_DATA" \
    -resultBundlePath "$RESULT_BUNDLE"
) || test_rc=$?
unset claim_code

if ! kill -0 "$sender_pid" 2>/dev/null; then
  sender_rc=0
  wait "$sender_pid" || sender_rc=$?
  sender_pid=""
  note "simdevice: exited $sender_rc during the test, after $(wc -l < "$work/sent.jsonl" | tr -d ' ') readings: $(head -n 1 "$work/sent.err" | mask)"
fi
note "xcodebuild test-without-building exited $test_rc"
exit "$test_rc"
