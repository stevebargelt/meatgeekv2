#!/usr/bin/env bash
#
# onboard-pi.sh — from the owner's laptop, take a fresh Raspberry Pi to a
# running, enrolled MeatGeek device and print its claim code (HAR-144).
#
#   preflight  (laptop and Pi, read only) go, az, the azure-iot extension, one
#              DPS and one hub, ssh, an aarch64 Pi with SPI on
#   build      the controller and the pusher for linux/arm64, CGO off
#   install    (Pi, sudo) remote-install.sh install: user, binaries, udev
#              rule, I2C, units, the device identity; starts the controller
#   enrol      (laptop) enrol-device.sh with the certificate the Pi printed
#   start      (Pi, sudo) remote-install.sh start: env file, the pusher, and
#              its claim code once it has registered
#
# Safe to run again: a second run changes nothing on a set-up Pi except
# restarting the pusher, and prints the same device id and a valid code.
# See docs/devices/runbook.md.

set -euo pipefail

PROG=onboard-pi.sh
DIR=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
# shellcheck source=device-common.sh
. "$DIR/device-common.sh"

REPO=$(cd "$DIR/../../.." && pwd)
WEB_ORIGIN="https://meatgeekv2-web.vercel.app"
REMOTE_DIR=/tmp/meatgeek-onboard
readonly CLAIM_BEGIN=MEATGEEK-CLAIM-BEGIN
readonly CLAIM_END=MEATGEEK-CLAIM-END
readonly EXIT_REBOOT=4
readonly EXIT_TIMEOUT=5

usage() {
  cat <<'EOF'
usage: onboard-pi.sh <user@host> [options]

Takes a fresh Raspberry Pi (64-bit Debian, SPI on, key-based ssh) to a
running, enrolled MeatGeek device and prints its claim code. Run it from a
checkout of the repository on your laptop. ssh asks for the Pi's sudo
password twice: once to install, once to start the pusher.

  --device-id <id>         default: meatgeek- and the last 8 hex digits of the
                           Pi's serial number
  --resource-group <name>  default meatgeek-v2-dev-rg
  --web-origin <url>       default https://meatgeekv2-web.vercel.app
  --dps <name>             default: the only DPS in the resource group
  --hub <name>             default: the only IoT hub in the resource group
  --auth-type key|login    passed to enrol-device.sh; default key

REINSTATE=1 passes through to enrol-device.sh, to bring back a revoked device.

Exit codes: 0 done (the claim code, or "already claimed", is printed),
2 usage, 4 the Pi must reboot (I2C was just turned on) or the device is
revoked, 5 the pusher did not register with DPS in time, 1 anything else
(a failed preflight check prints the command that fixes it).
EOF
}

HOST=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    -h | --help)
      usage
      exit 0
      ;;
    --web-origin)
      [[ $# -ge 2 && -n "$2" ]] || usage_error "--web-origin needs a value"
      WEB_ORIGIN=${2%/}
      shift 2
      ;;
    --*)
      parse_common_option "$1" "${2:-}" || usage_error "unknown option $1"
      shift 2
      ;;
    -*) usage_error "unknown option $1" ;;
    *)
      [[ -z "$HOST" ]] || usage_error "unexpected argument $1"
      HOST=$1
      shift
      ;;
  esac
done

[[ -n "$HOST" ]] || usage_error "the Pi's <user@host> is required"
[[ "$HOST" =~ ^[A-Za-z0-9._@:%-]+$ && "$HOST" != -* ]] || usage_error "'$HOST' is not a user@host"
case "$AUTH_TYPE" in
  key | login) ;;
  *) usage_error "--auth-type must be 'key' or 'login', not '$AUTH_TYPE'" ;;
esac
for value in "$DPS_NAME" "$HUB_NAME"; do
  ! is_host_name "$value" || usage_error "pass --dps and --hub as resource names, not host names: the ID scope is read from the DPS resource"
done
valid_id() { [[ "$1" =~ ^[A-Za-z0-9._:-]{1,128}$ ]]; }
if [[ -n "$DEVICE_ID" ]] && ! valid_id "$DEVICE_ID"; then
  usage_error "device id '$DEVICE_ID' is not valid: use 1 to 128 letters, digits, '-', '.', '_' or ':'"
fi

say() { printf '==> %s\n' "$*" >&2; }
# fail <fix> <message>: a failed check, and the one command that fixes it.
fail() {
  log "$2"
  printf '  fix: %s\n' "$1" >&2
  exit 1
}

SSH=(ssh -o BatchMode=yes)
remote() { "${SSH[@]}" "$HOST" "$@"; }

# --- preflight: changes nothing ------------------------------------------------

say "preflight"

# version_lt a b: dotted version a is older than b.
version_lt() {
  [[ "$1" != "$2" ]] &&
    [[ "$(printf '%s\n%s\n' "$1" "$2" | sort -t. -k1,1n -k2,2n -k3,3n | head -n 1)" == "$1" ]]
}

command -v go >/dev/null 2>&1 || fail "brew install go" "Go is not installed"
# The newer `go` directive of the two modules.
need_go=0
for mod in "$REPO/apps/device-controller/go.mod" "$REPO/apps/data-pusher/go.mod"; do
  v=$(sed -n 's/^go[[:space:]]\{1,\}\([0-9][0-9.]*\).*/\1/p' "$mod" | head -n 1)
  [[ -n "$v" ]] || die 1 "cannot read the go version in $mod"
  if version_lt "$need_go" "$v"; then need_go=$v; fi
done
have_go=$(go env GOVERSION 2>/dev/null) || have_go=""
have_go=${have_go#go}
have_go=${have_go%%[!0-9.]*}
if [[ -z "$have_go" ]] || version_lt "$have_go" "$need_go"; then
  fail "brew upgrade go" "Go ${have_go:-(unknown version)} is older than $need_go, which go.mod needs"
fi

command -v az >/dev/null 2>&1 || fail "brew install azure-cli" "the Azure CLI (az) is not installed"
az account show --output none >/dev/null 2>&1 || fail "az login" "the Azure CLI is not signed in"
az extension show --name azure-iot --output none >/dev/null 2>&1 ||
  fail "az extension add --name azure-iot" "the azure-iot extension for the Azure CLI is not installed"
resolve_dps
resolve_hub
az_call "iot dps show (ID scope)" iot dps show --name "$DPS_NAME" --resource-group "$RESOURCE_GROUP" \
  --query properties.idScope --output tsv
[[ $AZ_RC -eq 0 ]] || az_fail
ID_SCOPE=$(tr -d '[:space:]' <<<"$AZ_OUT")
[[ "$ID_SCOPE" =~ ^[A-Za-z0-9]{1,64}$ ]] || die 1 "DPS $DPS_NAME returned no usable ID scope ('$ID_SCOPE')"

remote true </dev/null >/dev/null 2>&1 ||
  fail "ssh-copy-id $HOST" "cannot ssh to $HOST with a key (ssh -o BatchMode=yes $HOST true failed)"
arch=$(remote uname -m </dev/null 2>/dev/null | tr -d '[:space:]') || arch=""
[[ "$arch" == aarch64 ]] ||
  fail "flash a 64-bit (arm64) Debian image on the Pi" "$HOST is '${arch:-unknown}', not aarch64"
remote test -e /dev/spidev0.0 </dev/null >/dev/null 2>&1 ||
  fail "add dtparam=spi=on to /boot/firmware/config.txt on the Pi, then sudo reboot" "$HOST has no /dev/spidev0.0: SPI is off"

# --- the device id -------------------------------------------------------------

# serial_suffix <serial>: the last 8 hex digits, lower-case, or nothing.
serial_suffix() {
  local s
  s=$(tr -d '[:space:]' <<<"$1" | tr '[:upper:]' '[:lower:]')
  [[ "$s" =~ ^[0-9a-f]{8,}$ ]] || return 1
  printf '%s' "${s:$((${#s} - 8))}"
}

if [[ -z "$DEVICE_ID" ]]; then
  suffix=""
  if serial=$(remote cat /proc/device-tree/serial-number </dev/null 2>/dev/null | tr -d '\000'); then
    suffix=$(serial_suffix "$serial") || suffix=""
  fi
  if [[ -z "$suffix" ]] && cpuinfo=$(remote cat /proc/cpuinfo </dev/null 2>/dev/null); then
    serial=$(sed -n 's/^Serial[[:space:]]*:[[:space:]]*//p' <<<"$cpuinfo" | head -n 1)
    suffix=$(serial_suffix "$serial") || suffix=""
  fi
  [[ -n "$suffix" ]] ||
    usage_error "cannot read the Pi's serial number (/proc/device-tree/serial-number or Serial in /proc/cpuinfo); pass --device-id <id>"
  DEVICE_ID="meatgeek-$suffix"
fi
valid_id "$DEVICE_ID" || usage_error "device id '$DEVICE_ID' is not valid"
say "device id $DEVICE_ID, DPS $DPS_NAME (ID scope $ID_SCOPE), hub $HUB_NAME"

# --- build ---------------------------------------------------------------------

WORK=$(mktemp -d "${TMPDIR:-/tmp}/meatgeek-onboard.XXXXXX")
trap 'rm -rf "$WORK"' EXIT
BUNDLE=$WORK/bundle
mkdir "$BUNDLE"

version=$(git -C "$REPO" describe --tags --always --dirty 2>/dev/null) || version=dev
say "building the controller and the pusher for linux/arm64 ($version)"
(cd "$REPO/apps/device-controller" &&
  GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -o "$BUNDLE/meatgeek-controller" .)
(cd "$REPO/apps/data-pusher" &&
  GOOS=linux GOARCH=arm64 CGO_ENABLED=0 go build -trimpath -ldflags "-X main.Version=$version" \
    -o "$BUNDLE/meatgeek-pusher" ./cmd)
for f in meatgeek-controller.service meatgeek-pusher.service 99-meatgeek.rules remote-install.sh; do
  cp "$DIR/$f" "$BUNDLE/$f"
done

say "copying the bundle to $HOST:$REMOTE_DIR"
remote "rm -rf $REMOTE_DIR && mkdir -m 0700 $REMOTE_DIR" </dev/null
scp -q -o BatchMode=yes "$BUNDLE/meatgeek-controller" "$BUNDLE/meatgeek-pusher" \
  "$BUNDLE/meatgeek-controller.service" "$BUNDLE/meatgeek-pusher.service" \
  "$BUNDLE/99-meatgeek.rules" "$BUNDLE/remote-install.sh" "$HOST:$REMOTE_DIR/"

# --- install (sudo) --------------------------------------------------------------

say "installing on $HOST (sudo asks for the Pi's password)"
rc=0
# stdout is kept for the result; the remote's output (through the pty) is progress.
"${SSH[@]}" -t "$HOST" sudo bash "$REMOTE_DIR/remote-install.sh" install --device-id "$DEVICE_ID" >&2 || rc=$?
if [[ $rc -eq $EXIT_REBOOT ]]; then
  log "I2C was off and is now on. Reboot the Pi (ssh $HOST sudo reboot), then run the same command again."
  exit "$EXIT_REBOOT"
fi
[[ $rc -eq 0 ]] || die 1 "the install on $HOST failed (exit $rc)"

# --- enrol (laptop) --------------------------------------------------------------

scp -q -o BatchMode=yes "$HOST:$REMOTE_DIR/device.crt" "$WORK/device.crt"
say "enrolling $DEVICE_ID in DPS"
rc=0
"$DIR/enrol-device.sh" --device-id "$DEVICE_ID" --certificate "$WORK/device.crt" \
  --resource-group "$RESOURCE_GROUP" --dps "$DPS_NAME" --hub "$HUB_NAME" --auth-type "$AUTH_TYPE" >&2 || rc=$?
if [[ $rc -eq $EXIT_REVOKED ]]; then
  log "this device was revoked; re-run with REINSTATE=1 if you mean to bring it back"
  exit "$EXIT_REVOKED"
fi
[[ $rc -eq 0 ]] || die 1 "enrol-device.sh failed (exit $rc)"

# --- start (sudo) ----------------------------------------------------------------

say "starting the pusher on $HOST (sudo asks for the Pi's password again)"
# The remote output is shown as it arrives (tee), so sudo's prompt is seen; it
# is kept in a variable for the claim line, never in a file.
set +e
out=$("${SSH[@]}" -t "$HOST" sudo bash "$REMOTE_DIR/remote-install.sh" start \
  --device-id "$DEVICE_ID" --id-scope "$ID_SCOPE" | tee /dev/stderr)
rc=$?
set -e
if [[ $rc -eq $EXIT_TIMEOUT ]]; then
  die "$EXIT_TIMEOUT" "the pusher on $HOST did not register with DPS in time; see its log above (journalctl -u meatgeek-pusher)"
fi
[[ $rc -eq 0 ]] || die 1 "starting the pusher on $HOST failed (exit $rc)"

# A pty ends lines with \r\n.
line=$(tr -d '\r' <<<"$out" | sed -n "/^$CLAIM_BEGIN\$/,/^$CLAIM_END\$/p" | sed '1d;$d' | head -n 1)
field() {
  local re="\"$1\":\"([^\"]*)\""
  [[ "$line" =~ $re ]] && printf '%s' "${BASH_REMATCH[1]}"
}
state=$(field state) || state=""
reported_id=$(field deviceId) || reported_id=""
[[ "$reported_id" == "$DEVICE_ID" ]] ||
  die 1 "the Pi reported device id '${reported_id}', not $DEVICE_ID"

case "$state" in
  unclaimed)
    code=$(field claimCode) || die 1 "the Pi reported no claim code"
    expires=$(field expiresAt) || expires="(unknown)"
    printf '\nDevice id:   %s\n' "$DEVICE_ID"
    printf 'Claim code:  %s\n' "$code"
    printf 'Expires:     %s\n' "$expires"
    printf 'Claim it at: %s/devices/claim?deviceId=%s\n' "$WEB_ORIGIN" "$DEVICE_ID"
    ;;
  claimed)
    printf '\nDevice id:   %s\n' "$DEVICE_ID"
    printf 'already claimed: release it in the web app to claim it again\n'
    ;;
  *) die 1 "the Pi reported claim state '${state}'" ;;
esac
