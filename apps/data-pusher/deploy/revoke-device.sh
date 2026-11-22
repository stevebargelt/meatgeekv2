#!/usr/bin/env bash
#
# revoke-device.sh — revoke a lost device, so IoT Hub accepts nothing more
# from it (HAR-135).
#
# It disables the device's DPS enrollment (the device cannot register again)
# and its IoT Hub device identity (a disabled identity is refused at connect,
# and IoT Hub drops its open connections). It deletes nothing, and it does not
# touch the API's ownership record: release the device in the web app.
#
# See README.md in this directory for options, examples and exit codes.

set -euo pipefail

PROG=revoke-device.sh
# shellcheck source=device-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/device-common.sh"

usage() {
  cat <<'EOF'
usage: revoke-device.sh --device-id <id> [options]

Disables the device's DPS enrollment and its IoT Hub device identity
(status disabled, reason "revoked"). Running it again changes nothing.

  --device-id <id>         the device id (= DPS enrollment id)
  --resource-group <name>  default meatgeek-v2-dev-rg
  --dps <name>             default: the only DPS in the resource group
  --hub <name>             default: the only IoT hub in the resource group
  --auth-type key|login    passed to az iot; default key

Result (stdout, one line): "revoked <id>" or "already revoked <id>", with
"(no DPS enrollment)" or "(no IoT hub device identity)" when one is missing.

Exit codes: 0 success, 2 usage, 3 no such device (neither exists),
1 anything else.
EOF
}

while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --*)
      parse_common_option "$1" "${2:-}" || usage_error "unknown option $1"
      shift 2
      ;;
    *) usage_error "unexpected argument $1" ;;
  esac
done

validate_common_options
require_az
resolve_dps
resolve_hub
read_enrollment
read_identity

if [[ "$ENROLLMENT_STATE" == "missing" && "$IDENTITY_STATE" == "missing" ]]; then
  die "$EXIT_NOT_FOUND" "no such device $DEVICE_ID: no DPS enrollment in $DPS_NAME and no device identity in $HUB_NAME"
fi

changed=0

# The enrollment first: once it is disabled the device cannot register again,
# even if the hub update below fails.
if [[ "$ENROLLMENT_STATE" == "enabled" ]]; then
  az_write "iot dps enrollment update" iot dps enrollment update \
    --dps-name "$DPS_NAME" --resource-group "$RESOURCE_GROUP" \
    --enrollment-id "$DEVICE_ID" --auth-type "$AUTH_TYPE" \
    --provisioning-status disabled --output none
  log "disabled the DPS enrollment $DEVICE_ID in $DPS_NAME"
  changed=1
fi

if [[ "$IDENTITY_STATE" == "enabled" ]]; then
  set_identity_status disabled revoked
  log "disabled the device identity $DEVICE_ID in $HUB_NAME"
  changed=1
fi

note=""
if [[ "$ENROLLMENT_STATE" == "missing" ]]; then
  log "there is no DPS enrollment $DEVICE_ID in $DPS_NAME"
  note=" (no DPS enrollment)"
elif [[ "$IDENTITY_STATE" == "missing" ]]; then
  log "there is no device identity $DEVICE_ID in $HUB_NAME"
  note=" (no IoT hub device identity)"
fi

if [[ $changed -eq 1 ]]; then
  echo "revoked $DEVICE_ID$note"
else
  echo "already revoked $DEVICE_ID$note"
fi
