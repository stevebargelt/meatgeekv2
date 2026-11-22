#!/usr/bin/env bash
#
# enrol-device.sh — enrol a device's X.509 certificate in the IoT Hub Device
# Provisioning Service, so the device can register and connect (HAR-135).
#
# The device creates its own key and prints only its public certificate
# (`meatgeek-pusher identity init`); no key is ever copied. The enrollment id,
# registration id and IoT Hub device id are all the device id, which must be
# the certificate's subject CN.
#
# See README.md in this directory for options, examples and exit codes.

set -euo pipefail

PROG=enrol-device.sh
# shellcheck source=device-common.sh
. "$(dirname "${BASH_SOURCE[0]}")/device-common.sh"

usage() {
  cat <<'EOF'
usage: enrol-device.sh --device-id <id> --certificate <path.pem> [options]

Enrols the device's certificate in DPS as an individual enrollment
(enrollment id = registration id = device id), allocated to the IoT hub.

  --device-id <id>         the device id; must equal the certificate's subject CN
  --certificate <path>     the device's certificate PEM (from `identity init`)
  --resource-group <name>  default meatgeek-v2-dev-rg
  --dps <name>             default: the only DPS in the resource group
  --hub <name>             default: the only IoT hub in the resource group
  --auth-type key|login    passed to az iot; default key

Result (stdout, one line): enrolled | unchanged | certificate replaced |
reinstated, followed by the device id.

A revoked (disabled) enrollment is refused with exit 4. Set REINSTATE=1 to
enable it again with this certificate, and enable the hub device identity.

Exit codes: 0 success, 2 usage or refused certificate, 3 not found,
4 refused because the device is revoked, 1 anything else.
EOF
}

CERT_PATH=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --certificate)
      [[ $# -ge 2 && -n "$2" ]] || usage_error "--certificate needs a value"
      CERT_PATH=$2
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
[[ -n "$CERT_PATH" ]] || usage_error "--certificate is required"
[[ -f "$CERT_PATH" && -r "$CERT_PATH" ]] || usage_error "cannot read the certificate file $CERT_PATH"

# --- The certificate: it must parse, and be for this device. ---------------
# Nothing here prints the PEM; openssl's own errors are dropped because they
# can quote the input.

command -v openssl >/dev/null 2>&1 || die 1 "openssl is not on PATH"

if ! subject=$(openssl x509 -in "$CERT_PATH" -noout -subject -nameopt RFC2253 2>/dev/null); then
  usage_error "$CERT_PATH is not a PEM X.509 certificate; refusing to enrol it"
fi

# RFC 2253: "subject=CN=meatgeek-pi-7,O=..." (device ids contain no commas).
subject=${subject#subject=}
subject=${subject# }
cn=""
cn_count=0
rdns=()
[[ -z "$subject" ]] || IFS=',' read -r -a rdns <<<"$subject"
for rdn in ${rdns[@]+"${rdns[@]}"}; do
  rdn=${rdn# }
  if [[ "$rdn" == CN=* ]]; then
    cn=${rdn#CN=}
    cn_count=$((cn_count + 1))
  fi
done
if [[ $cn_count -ne 1 || "$cn" != "$DEVICE_ID" ]]; then
  usage_error "the certificate's subject CN is '${cn}', not the device id '$DEVICE_ID'; refusing to enrol it"
fi

fingerprint=$(openssl x509 -in "$CERT_PATH" -noout -fingerprint -sha1 2>/dev/null) ||
  usage_error "cannot read the SHA-1 thumbprint of $CERT_PATH"
CERT_THUMBPRINT=$(tr -d ':[:space:]' <<<"${fingerprint#*=}" | tr '[:lower:]' '[:upper:]')

# --- Azure. ------------------------------------------------------------------

require_az
resolve_dps
resolve_hub
read_enrollment

hub_host_name() {
  az_call "resource show (IoT hub host name)" resource show \
    --resource-group "$RESOURCE_GROUP" --name "$HUB_NAME" \
    --resource-type Microsoft.Devices/IotHubs \
    --query properties.hostName --output tsv
  [[ $AZ_RC -eq 0 ]] || az_fail
  local host
  host=$(tr -d '[:space:]' <<<"$AZ_OUT")
  [[ -n "$host" ]] || die 1 "IoT hub $HUB_NAME has no host name"
  printf '%s\n' "$host"
}

case "$ENROLLMENT_STATE" in
  missing)
    host=$(hub_host_name)
    az_write "iot dps enrollment create" iot dps enrollment create \
      --dps-name "$DPS_NAME" --resource-group "$RESOURCE_GROUP" \
      --enrollment-id "$DEVICE_ID" --auth-type "$AUTH_TYPE" \
      --attestation-type x509 --certificate-path "$CERT_PATH" \
      --device-id "$DEVICE_ID" --provisioning-status enabled \
      --allocation-policy static --iot-hubs "$host" --output none
    echo "enrolled $DEVICE_ID"
    ;;

  enabled)
    if [[ "$ENROLLMENT_THUMBPRINT" == "$CERT_THUMBPRINT" ]]; then
      echo "unchanged $DEVICE_ID"
      exit 0
    fi
    # A re-imaged device: same id, new key.
    log "the enrollment for $DEVICE_ID has a different certificate; replacing it"
    az_write "iot dps enrollment update" iot dps enrollment update \
      --dps-name "$DPS_NAME" --resource-group "$RESOURCE_GROUP" \
      --enrollment-id "$DEVICE_ID" --auth-type "$AUTH_TYPE" \
      --certificate-path "$CERT_PATH" --output none
    echo "certificate replaced $DEVICE_ID"
    ;;

  disabled)
    if [[ "${REINSTATE:-}" != "1" ]]; then
      die "$EXIT_REVOKED" "device $DEVICE_ID is revoked (its DPS enrollment is disabled); refusing to enrol it. Set REINSTATE=1 to enable it again with this certificate."
    fi
    az_write "iot dps enrollment update" iot dps enrollment update \
      --dps-name "$DPS_NAME" --resource-group "$RESOURCE_GROUP" \
      --enrollment-id "$DEVICE_ID" --auth-type "$AUTH_TYPE" \
      --certificate-path "$CERT_PATH" --provisioning-status enabled --output none
    read_identity
    if [[ "$IDENTITY_STATE" == "missing" ]]; then
      log "no IoT hub device identity for $DEVICE_ID yet; the device creates it when it registers"
    else
      set_identity_status enabled reinstated
    fi
    echo "reinstated $DEVICE_ID"
    ;;
esac
