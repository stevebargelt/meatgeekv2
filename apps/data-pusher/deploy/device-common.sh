# shellcheck shell=bash
# The variables set here are read by the scripts that source this file.
# shellcheck disable=SC2034
#
# Shared by enrol-device.sh, revoke-device.sh (HAR-135) and delete-device.sh
# (HAR-140). Sourced, not run.
#
# The caller sets PROG (its name, for messages) before sourcing, and calls
# parse_common_option for each option it does not handle itself.
#
# Exit codes, the same for every script:
#   0 success, 2 usage (or a certificate that is refused), 3 not found,
#   4 refused (enrol: the device is revoked; delete: the id is outside
#   --only-prefix), 1 anything else.

readonly EXIT_USAGE=2
readonly EXIT_NOT_FOUND=3
readonly EXIT_REVOKED=4
readonly EXIT_REFUSED=4

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

# A --dps or --hub value with a dot in it is the service's host name, not its
# resource name (HAR-139). With --auth-type login, azure-iot then talks to the
# service's data plane directly and makes no ARM call, so an identity that
# holds only the data-plane roles (CI's: IoT Hub Registry Contributor and
# Device Provisioning Service Data Contributor, no Reader) can run these
# scripts. No --resource-group is passed with a host name: with one, the hub
# commands look the hub up in ARM by name anyway.
is_host_name() { [[ "$1" == *.* ]]; }

validate_common_options() {
  [[ -n "$DEVICE_ID" ]] || usage_error "--device-id is required"
  # The same rule as the device's own identity (internal/identity).
  [[ "$DEVICE_ID" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] ||
    usage_error "device id '$DEVICE_ID' is not valid: use 1 to 128 letters, digits, '-', '.', '_' or ':'"
  case "$AUTH_TYPE" in
    key | login) ;;
    *) usage_error "--auth-type must be 'key' or 'login', not '$AUTH_TYPE'" ;;
  esac
  local flag value
  for flag in --dps --hub; do
    if [[ $flag == --dps ]]; then value=$DPS_NAME; else value=$HUB_NAME; fi
    if is_host_name "$value" && [[ "$AUTH_TYPE" != login ]]; then
      usage_error "$flag $value is a host name, which needs --auth-type login (with key auth, az finds the service in ARM by name to read its keys)"
    fi
  done
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

# True when the last az_call failed because the device or enrollment does not
# exist. az exits 3 for ResourceNotFoundError; older extension versions say so
# in text. The azure-iot extension raises the same error when it cannot find
# the DPS or hub itself ("Unable to find ...") or a usable access policy on it
# ("Unable to discover a priviledged policy ..."); those are failures, not a
# missing device, or a revoke against the wrong hub would report success.
az_not_found() {
  grep -qiE 'unable to (find|discover)' <<<"$AZ_ERR" && return 1
  [[ $AZ_RC -eq 3 ]] && return 0
  grep -qiE 'not ?found|(^|[^0-9])404([^0-9]|$)|does not exist' <<<"$AZ_ERR"
}

# az_write <description> <az arguments...>: a call that must succeed.
az_write() {
  az_call "$@"
  [[ $AZ_RC -eq 0 ]] || az_fail
}

# find_one <resource type> <label> <flag> <name-or-empty>: lists the resources
# of that type in the resource group. With a name, prints that name if it is
# in the list and exits 1 if it is not, so a mistyped --dps or --hub fails
# here instead of making every device look missing. Without a name, prints the
# only one, or exits 1 when there are none or several.
find_one() {
  local type=$1 label=$2 flag=$3 want=$4
  az_call "resource list ($label)" resource list --resource-group "$RESOURCE_GROUP" \
    --resource-type "$type" --query "[].name" --output tsv
  [[ $AZ_RC -eq 0 ]] || az_fail
  local names=()
  local line
  while IFS= read -r line; do
    [[ -n "$line" ]] && names+=("$line")
  done <<<"$AZ_OUT"
  if [[ -n "$want" ]]; then
    local lower_want lower_name
    lower_want=$(tr '[:upper:]' '[:lower:]' <<<"$want")
    for line in ${names[@]+"${names[@]}"}; do
      # Azure resource names are case-insensitive.
      lower_name=$(tr '[:upper:]' '[:lower:]' <<<"$line")
      if [[ "$lower_name" == "$lower_want" ]]; then
        printf '%s\n' "$line"
        return
      fi
    done
    if [[ ${#names[@]} -eq 0 ]]; then
      die 1 "no $label named $want in resource group $RESOURCE_GROUP: it has no $label ($type)"
    fi
    die 1 "no $label named $want in resource group $RESOURCE_GROUP (it has: ${names[*]}); check $flag"
  fi
  case ${#names[@]} in
    1) printf '%s\n' "${names[0]}" ;;
    0) die 1 "no $label ($type) in resource group $RESOURCE_GROUP; pass $flag <name>" ;;
    *) die 1 "${#names[@]} ${label}s ($type) in resource group $RESOURCE_GROUP (${names[*]}); pass $flag <name> to choose one" ;;
  esac
}

# Both run even when the name was given, to confirm the resource exists. A
# host name is used as given: confirming it would need ARM, and a wrong one
# fails at the first az iot call (it does not resolve), not as "not found".
# DPS_ARGS and HUB_ARGS are the options that name the service on az iot calls.
resolve_dps() {
  if is_host_name "$DPS_NAME"; then
    DPS_ARGS=(--dps-name "$DPS_NAME")
    return
  fi
  DPS_NAME=$(find_one Microsoft.Devices/provisioningServices DPS --dps "$DPS_NAME")
  DPS_ARGS=(--dps-name "$DPS_NAME" --resource-group "$RESOURCE_GROUP")
}

resolve_hub() {
  if is_host_name "$HUB_NAME"; then
    HUB_ARGS=(--hub-name "$HUB_NAME")
    return
  fi
  HUB_NAME=$(find_one Microsoft.Devices/IotHubs "IoT hub" --hub "$HUB_NAME")
  HUB_ARGS=(--hub-name "$HUB_NAME" --resource-group "$RESOURCE_GROUP")
}

# Sets ENROLLMENT_STATE to missing|enabled|disabled and ENROLLMENT_THUMBPRINT
# to the primary certificate's SHA-1 thumbprint (upper-case hex, no colons;
# empty when DPS reports none). Only those two fields are read, so nothing
# else in the record is printed.
#
# The record is DPS's own JSON (azure-iot returns the service's response as
# is, the same for --auth-type key and login); the thumbprint is at
# attestation.x509.clientCertificates.primary.info.sha1Thumbprint, and
# primary.certificate is not returned. az's TSV output prints a list of
# scalars one per line, not tab-separated (knack's _TsvOutput: each list item
# is a row), and a null in the list as "None". So the output is
# "<status>\n<thumbprint>\n" (HAR-149: reading only the first line left the
# thumbprint empty, and every re-enrol replaced an unchanged certificate).
# Tabs are accepted too.
read_enrollment() {
  az_call "iot dps enrollment show" iot dps enrollment show \
    "${DPS_ARGS[@]}" \
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
  local status="" thumb="" rest=""
  IFS=$'\t\n' read -r -d '' status thumb rest <<<"$AZ_OUT" || true
  ENROLLMENT_THUMBPRINT=$(normalise_thumbprint "$thumb")
  if [[ "$status" == "disabled" ]]; then
    ENROLLMENT_STATE=disabled
  else
    ENROLLMENT_STATE=enabled
  fi
}

# normalise_thumbprint <text>: upper-case hex with no colons or whitespace;
# empty for az's renderings of a null ("None", "null").
normalise_thumbprint() {
  local t
  t=$(tr -d ':[:space:]' <<<"$1" | tr '[:lower:]' '[:upper:]')
  case "$t" in
    NONE | NULL) t="" ;;
  esac
  printf '%s' "$t"
}

# Sets IDENTITY_STATE to missing|enabled|disabled for the hub device identity.
read_identity() {
  az_call "iot hub device-identity show" iot hub device-identity show \
    "${HUB_ARGS[@]}" \
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
    "${HUB_ARGS[@]}" \
    --device-id "$DEVICE_ID" --auth-type "$AUTH_TYPE" \
    --status "$1" --status-reason "$2" --output none
}
