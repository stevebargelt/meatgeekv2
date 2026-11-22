# shellcheck shell=bash
# The variables set here are read by the scripts that source this file.
# shellcheck disable=SC2034
#
# Shared by enrol-device.sh and revoke-device.sh (HAR-135). Sourced, not run.
#
# The caller sets PROG (its name, for messages) before sourcing, and calls
# parse_common_option for each option it does not handle itself.
#
# Exit codes, the same for both scripts:
#   0 success, 2 usage (or a certificate that is refused), 3 not found,
#   4 refused because the device is revoked, 1 anything else.

readonly EXIT_USAGE=2
readonly EXIT_NOT_FOUND=3
readonly EXIT_REVOKED=4

RESOURCE_GROUP="meatgeek-v2-dev-rg"
DPS_NAME=""
HUB_NAME=""
AUTH_TYPE="key"
DEVICE_ID=""

# Diagnostics go to stderr; stdout carries only the one result line.
log() { printf '%s: %s\n' "$PROG" "$*" >&2; }
die() {
  local code=$1
  shift
  log "$*"
  exit "$code"
}
usage_error() {
  log "$*"
  log "run '$PROG --help' for usage"
  exit "$EXIT_USAGE"
}

# parse_common_option <option> <value-or-empty>
# Returns 0 if the option is a common one and was consumed with its value,
# 1 if the caller should handle it.
parse_common_option() {
  case "$1" in
    --resource-group | --dps | --hub | --auth-type | --device-id)
      [[ $# -ge 2 && -n "$2" ]] || usage_error "$1 needs a value"
      ;;
    *) return 1 ;;
  esac
  case "$1" in
    --resource-group) RESOURCE_GROUP=$2 ;;
    --dps) DPS_NAME=$2 ;;
    --hub) HUB_NAME=$2 ;;
    --auth-type) AUTH_TYPE=$2 ;;
    --device-id) DEVICE_ID=$2 ;;
  esac
}

validate_common_options() {
  [[ -n "$DEVICE_ID" ]] || usage_error "--device-id is required"
  # The same rule as the device's own identity (internal/identity).
  [[ "$DEVICE_ID" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] ||
    usage_error "device id '$DEVICE_ID' is not valid: use 1 to 128 letters, digits, '-', '.', '_' or ':'"
  case "$AUTH_TYPE" in
    key | login) ;;
    *) usage_error "--auth-type must be 'key' or 'login', not '$AUTH_TYPE'" ;;
  esac
}

require_az() {
  command -v az >/dev/null 2>&1 ||
    die 1 "the Azure CLI (az) is not on PATH; install it: https://learn.microsoft.com/cli/azure/install-azure-cli"
  if ! az extension show --name azure-iot --output none >/dev/null 2>&1; then
    die 1 "the azure-iot extension for the Azure CLI is not installed; install it with:
  az extension add --name azure-iot"
  fi
}

# Hide anything key-shaped in az's error text before it is shown.
redact() {
  sed -E 's/(SharedAccessKey|SharedAccessSignature|sig|[Pp]rimaryKey|[Ss]econdaryKey)([=:"[:space:]]+)[^;&",[:space:]]+/\1\2<redacted>/g'
}

# az_call <description> <az arguments...>
# Runs az; sets AZ_OUT (stdout), AZ_ERR (stderr) and AZ_RC. Never exits.
az_call() {
  local desc=$1
  shift
  local errfile
  errfile=$(mktemp)
  AZ_RC=0
  AZ_OUT=$(az "$@" 2>"$errfile") || AZ_RC=$?
  AZ_ERR=$(redact <"$errfile")
  rm -f "$errfile"
  AZ_DESC=$desc
}

# Reports the last az_call as failed and exits 1.
az_fail() {
  log "az $AZ_DESC failed (exit $AZ_RC)"
  [[ -z "$AZ_ERR" ]] || printf '%s\n' "$AZ_ERR" >&2
  exit 1
}

# True when the last az_call failed because the thing does not exist. az
# exits 3 for ResourceNotFoundError; older extension versions say so in text.
az_not_found() {
  [[ $AZ_RC -eq 3 ]] && return 0
  grep -qiE 'not ?found|(^|[^0-9])404([^0-9]|$)|does not exist' <<<"$AZ_ERR"
}

# az_write <description> <az arguments...>: a call that must succeed.
az_write() {
  az_call "$@"
  [[ $AZ_RC -eq 0 ]] || az_fail
}

# find_one <resource type> <label> <flag>: prints the name of the only
# resource of that type in the resource group, or exits 1.
find_one() {
  local type=$1 label=$2 flag=$3
  az_call "resource list ($label)" resource list --resource-group "$RESOURCE_GROUP" \
    --resource-type "$type" --query "[].name" --output tsv
  [[ $AZ_RC -eq 0 ]] || az_fail
  local names=()
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && names+=("$line")
  done <<<"$AZ_OUT"
  case ${#names[@]} in
    1) printf '%s\n' "${names[0]}" ;;
    0) die 1 "no $label ($type) in resource group $RESOURCE_GROUP; pass $flag <name>" ;;
    *) die 1 "${#names[@]} ${label}s ($type) in resource group $RESOURCE_GROUP (${names[*]}); pass $flag <name> to choose one" ;;
  esac
}

resolve_dps() {
  if [[ -z "$DPS_NAME" ]]; then
    DPS_NAME=$(find_one Microsoft.Devices/provisioningServices DPS --dps)
  fi
}

resolve_hub() {
  if [[ -z "$HUB_NAME" ]]; then
    HUB_NAME=$(find_one Microsoft.Devices/IotHubs "IoT hub" --hub)
  fi
}

# Sets ENROLLMENT_STATE to missing|enabled|disabled and ENROLLMENT_THUMBPRINT
# to the primary certificate's SHA-1 thumbprint (upper-case hex, no colons).
# Only those two fields are read, so nothing else in the record is printed.
read_enrollment() {
  az_call "iot dps enrollment show" iot dps enrollment show \
    --dps-name "$DPS_NAME" --resource-group "$RESOURCE_GROUP" \
    --enrollment-id "$DEVICE_ID" --auth-type "$AUTH_TYPE" \
    --query "[provisioningStatus, attestation.x509.clientCertificates.primary.info.sha1Thumbprint]" \
    --output tsv
  ENROLLMENT_THUMBPRINT=""
  if [[ $AZ_RC -ne 0 ]]; then
    if az_not_found; then
      ENROLLMENT_STATE=missing
      return
    fi
    az_fail
  fi
  local status thumb
  IFS=$'\t' read -r status thumb <<<"$AZ_OUT" || true
  ENROLLMENT_THUMBPRINT=$(tr -d ':[:space:]' <<<"$thumb" | tr '[:lower:]' '[:upper:]')
  if [[ "$status" == "disabled" ]]; then
    ENROLLMENT_STATE=disabled
  else
    ENROLLMENT_STATE=enabled
  fi
}

# Sets IDENTITY_STATE to missing|enabled|disabled for the hub device identity.
read_identity() {
  az_call "iot hub device-identity show" iot hub device-identity show \
    --hub-name "$HUB_NAME" --resource-group "$RESOURCE_GROUP" \
    --device-id "$DEVICE_ID" --auth-type "$AUTH_TYPE" \
    --query status --output tsv
  if [[ $AZ_RC -ne 0 ]]; then
    if az_not_found; then
      IDENTITY_STATE=missing
      return
    fi
    az_fail
  fi
  if [[ "$(tr -d '[:space:]' <<<"$AZ_OUT")" == "disabled" ]]; then
    IDENTITY_STATE=disabled
  else
    IDENTITY_STATE=enabled
  fi
}

# set_identity_status <enabled|disabled> <reason>
set_identity_status() {
  az_write "iot hub device-identity update" iot hub device-identity update \
    --hub-name "$HUB_NAME" --resource-group "$RESOURCE_GROUP" \
    --device-id "$DEVICE_ID" --auth-type "$AUTH_TYPE" \
    --status "$1" --status-reason "$2" --output none
}
