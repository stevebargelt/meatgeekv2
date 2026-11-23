#!/usr/bin/env bash
#
# delete-device.sh — delete a throwaway device's DPS individual enrollment
# and its IoT Hub device identity (HAR-140).
#
# For CI's fresh acceptance devices, which are enrolled, claimed, released and
# then deleted in one run. It is not how a real device is retired: revoke a
# lost device with revoke-device.sh, which deletes nothing.
#
# --only-prefix is required, and an id that does not start with it is refused
# before any az call: this is the catch that stops a CI run from ever deleting
# a real device such as the owner's Pi.
#
# See README.md in this directory for options, examples and exit codes.

set -euo pipefail

PROG=delete-device.sh
# shellcheck source=device-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/device-common.sh"

usage() {
  cat <<'EOF'
usage: delete-device.sh --device-id <id> --only-prefix <prefix> [options]

Deletes the device's DPS individual enrollment (first, so it cannot register
again) and its IoT Hub device identity. Running it again changes nothing.

  --device-id <id>         the device id (= DPS enrollment id)
  --only-prefix <prefix>   required; refuse (exit 4) any id that does not
                           start with it, before any az call
  --resource-group <name>  default meatgeek-v2-dev-rg
  --dps <name|host>        default: the only DPS in the resource group
  --hub <name|host>        default: the only IoT hub in the resource group.
                           A host name (with a dot) for --dps or --hub is
                           used as given, with no ARM lookup and no
                           --resource-group; it needs --auth-type login
  --auth-type key|login    passed to az iot; default key

Result (stdout, one line): "deleted <id>" or "already deleted <id>", with
"(no DPS enrollment)" or "(no IoT hub device identity)" when one was missing.

Exit codes: 0 success (including nothing left to delete), 2 usage,
4 refused because the id does not start with --only-prefix, 1 anything else.
EOF
}

ONLY_PREFIX=""
ONLY_PREFIX_SET=0
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --only-prefix)
      [[ $# -ge 2 && -n "$2" ]] || usage_error "--only-prefix needs a value"
      ONLY_PREFIX=$2
      ONLY_PREFIX_SET=1
      shift 2
      ;;
    --*)
      parse_common_option "$1" "${2:-}" || usage_error "unknown option $1"
      shift 2
      ;;
    *) usage_error "unexpected argument $1" ;;
  esac
done

validate_common_options
[[ $ONLY_PREFIX_SET -eq 1 ]] || usage_error "--only-prefix is required"

# The safety catch, before anything touches Azure. Quoted, so the prefix is
# matched literally and never as a glob.
if [[ "$DEVICE_ID" != "$ONLY_PREFIX"* ]]; then
  die "$EXIT_REFUSED" "refusing to delete device $DEVICE_ID: it does not start with --only-prefix '$ONLY_PREFIX'"
fi

require_az
resolve_dps
resolve_hub
read_enrollment
read_identity

if [[ "$ENROLLMENT_STATE" == "missing" && "$IDENTITY_STATE" == "missing" ]]; then
  echo "already deleted $DEVICE_ID"
  exit 0
fi

# az_delete <description> <az arguments...>: a delete that must succeed, or
# find the thing already gone (another run deleted it in between).
az_delete() {
  az_call "$@"
  [[ $AZ_RC -eq 0 ]] || az_not_found || az_fail
}

# The enrollment first: once it is gone the device cannot register again,
# even if the hub delete below fails.
if [[ "$ENROLLMENT_STATE" != "missing" ]]; then
  az_delete "iot dps enrollment delete" iot dps enrollment delete \
    "${DPS_ARGS[@]}" \
    --enrollment-id "$DEVICE_ID" --auth-type "$AUTH_TYPE" --output none
  log "deleted the DPS enrollment $DEVICE_ID in $DPS_NAME"
fi

if [[ "$IDENTITY_STATE" != "missing" ]]; then
  az_delete "iot hub device-identity delete" iot hub device-identity delete \
    "${HUB_ARGS[@]}" \
    --device-id "$DEVICE_ID" --auth-type "$AUTH_TYPE" --output none
  log "deleted the device identity $DEVICE_ID in $HUB_NAME"
fi

note=""
if [[ "$ENROLLMENT_STATE" == "missing" ]]; then
  note=" (no DPS enrollment)"
elif [[ "$IDENTITY_STATE" == "missing" ]]; then
  note=" (no IoT hub device identity)"
fi
echo "deleted $DEVICE_ID$note"
