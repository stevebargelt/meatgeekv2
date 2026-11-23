#!/usr/bin/env bash
#
# remote-install.sh — the root half of onboard-pi.sh (HAR-144). onboard-pi.sh
# copies it, with both binaries, the two units and the udev rule, to
# /tmp/meatgeek-onboard/ on the Pi and runs it there twice over `ssh -t`, so
# the owner types the sudo password once per phase:
#
#   sudo bash /tmp/meatgeek-onboard/remote-install.sh install --device-id <id>
#   sudo bash /tmp/meatgeek-onboard/remote-install.sh start --device-id <id> --id-scope <scope>
#
# install  creates the meatgeek user, installs the binaries, the udev rule and
#          the units, turns I2C on, creates the device identity and copies
#          its certificate (never its key) to /tmp/meatgeek-onboard/device.crt,
#          and starts the controller. It changes only what differs, so a
#          second run changes nothing.
# start    writes the pusher's env file, (re)starts the pusher, waits for it to
#          register and print its claim code, and removes /tmp/meatgeek-onboard.
#
# Exit codes: 0 success, 2 usage, 4 I2C was just turned on (reboot, then run
# onboard-pi.sh again), 5 the pusher did not register in time, 1 anything else.
#
# Test seam: MEATGEEK_ROOT (default empty) prefixes every path, so the tests
# run this against a temporary directory with fake systemctl, useradd and so
# on, on PATH. The wait in `start` counts `sleep 1` calls; the tests put a
# fake sleep on PATH.

set -euo pipefail

PROG=remote-install.sh
ROOT=${MEATGEEK_ROOT:-}

readonly SVC_USER=meatgeek
readonly STATE_DIR=/var/lib/meatgeek-pusher
readonly BUNDLE_DIR=/tmp/meatgeek-onboard
readonly CLAIM_BEGIN=MEATGEEK-CLAIM-BEGIN
readonly CLAIM_END=MEATGEEK-CLAIM-END
# The pusher registers with DPS and reads its twin; at most this many
# one-second polls.
readonly WAIT_POLLS=120

readonly EXIT_USAGE=2
readonly EXIT_REBOOT=4
readonly EXIT_TIMEOUT=5

log() { printf '%s: %s\n' "$PROG" "$*" >&2; }
die() {
  local code=$1
  shift
  log "$*"
  exit "$code"
}

# p <absolute path>: the path under MEATGEEK_ROOT.
p() { printf '%s%s' "$ROOT" "$1"; }

usage() {
  cat <<'EOF'
usage: remote-install.sh install --device-id <id>
       remote-install.sh start --device-id <id> --id-scope <scope>

Run as root on the Pi by onboard-pi.sh. See onboard-pi.sh and
docs/devices/runbook.md.

Exit codes: 0 success, 2 usage, 4 I2C was turned on (reboot and run again),
5 the pusher did not register in time, 1 anything else.
EOF
}

PHASE=${1:-}
case "$PHASE" in
  install | start) shift ;;
  -h | --help)
    usage
    exit 0
    ;;
  *)
    usage >&2
    exit "$EXIT_USAGE"
    ;;
esac

DEVICE_ID=""
ID_SCOPE=""
while [[ $# -gt 0 ]]; do
  case "$1" in
    --device-id | --id-scope)
      [[ $# -ge 2 && -n "$2" ]] || die "$EXIT_USAGE" "$1 needs a value"
      if [[ $1 == --device-id ]]; then DEVICE_ID=$2; else ID_SCOPE=$2; fi
      shift 2
      ;;
    *) die "$EXIT_USAGE" "unexpected argument $1" ;;
  esac
done

[[ "$DEVICE_ID" =~ ^[A-Za-z0-9._:-]{1,128}$ ]] ||
  die "$EXIT_USAGE" "--device-id '$DEVICE_ID' is not valid: use 1 to 128 letters, digits, '-', '.', '_' or ':'"
if [[ $PHASE == start ]]; then
  [[ "$ID_SCOPE" =~ ^[A-Za-z0-9]{1,64}$ ]] || die "$EXIT_USAGE" "--id-scope '$ID_SCOPE' is not a DPS ID scope"
fi

if [[ -z "$ROOT" && $EUID -ne 0 ]]; then
  die 1 "run as root (sudo bash $0 ...)"
fi

BUNDLE=$(p "$BUNDLE_DIR")
PUSHER=$(p /usr/local/bin/meatgeek-pusher)
STATE=$(p "$STATE_DIR")
# The service user cannot enter the caller's home directory.
cd /

# install_file <source> <destination> <mode>: copies only when the content
# differs, through a temporary file and a rename (a running binary is never
# written in place). Returns 0 when it changed the file, 1 when it was already
# the same.
install_file() {
  local src=$1 dst=$2 mode=$3
  [[ -f "$src" ]] || die 1 "the bundle has no $(basename "$src")"
  if [[ -f "$dst" ]] && cmp -s "$src" "$dst"; then
    return 1
  fi
  mkdir -p "$(dirname "$dst")"
  cp "$src" "$dst.meatgeek-new"
  chmod "$mode" "$dst.meatgeek-new"
  mv -f "$dst.meatgeek-new" "$dst"
  log "installed $dst"
  return 0
}

# write_file <destination> <mode> <content>: install_file for generated text.
write_file() {
  local dst=$1 mode=$2 content=$3 tmp
  tmp=$(mktemp)
  printf '%s' "$content" >"$tmp"
  local rc=0
  install_file "$tmp" "$dst" "$mode" || rc=$?
  rm -f "$tmp"
  return "$rc"
}

# add_line_once <file> <line>: appends the line unless the file already has it.
add_line_once() {
  local file=$1 line=$2
  if [[ -f "$file" ]] && grep -qxF -- "$line" "$file"; then
    return 1
  fi
  mkdir -p "$(dirname "$file")"
  if [[ -s "$file" && -n "$(tail -c 1 "$file")" ]]; then
    printf '\n' >>"$file"
  fi
  printf '%s\n' "$line" >>"$file"
  log "added '$line' to $file"
}

unit_active() { systemctl is-active --quiet "$1"; }
unit_enabled() { systemctl is-enabled --quiet "$1"; }

# --- install -----------------------------------------------------------------

ensure_user() {
  if getent passwd "$SVC_USER" >/dev/null 2>&1; then
    return
  fi
  useradd --system --user-group --no-create-home --home-dir /nonexistent \
    --shell /usr/sbin/nologin "$SVC_USER"
  log "created the system user $SVC_USER"
}

# Plain Debian loads the I2C controller only when the device tree asks for it,
# and creates /dev/i2c-1 only with the i2c-dev module.
ensure_i2c() {
  write_file "$(p /etc/modules-load.d/meatgeek.conf)" 0644 $'i2c-dev\n' || true
  [[ -e "$(p /dev/i2c-1)" ]] && return
  modprobe i2c-dev || true
  [[ -e "$(p /dev/i2c-1)" ]] && return

  local config
  config=$(p /boot/firmware/config.txt)
  [[ -f "$config" ]] || die 1 "/dev/i2c-1 is missing and there is no /boot/firmware/config.txt to turn I2C on in"
  add_line_once "$config" "dtparam=i2c_arm=on" || true
  # Debian's raspi-firmware rewrites config.txt on a kernel upgrade and appends
  # this file, so the line survives an upgrade.
  if [[ -f "$(p /etc/default/raspi-firmware)" ]]; then
    add_line_once "$(p /etc/default/raspi-firmware-custom)" "dtparam=i2c_arm=on" || true
  fi
  log "I2C was off; reboot the Pi (\`sudo reboot\`) and run the same command again"
  exit "$EXIT_REBOOT"
}

phase_install() {
  ensure_user

  local controller_changed=0 units_changed=0
  install_file "$BUNDLE/meatgeek-controller" "$(p /usr/local/bin/meatgeek-controller)" 0755 && controller_changed=1
  install_file "$BUNDLE/meatgeek-pusher" "$PUSHER" 0755 || true

  if install_file "$BUNDLE/99-meatgeek.rules" "$(p /etc/udev/rules.d/99-meatgeek.rules)" 0644; then
    udevadm control --reload
    udevadm trigger
    udevadm settle
  fi

  ensure_i2c

  install_file "$BUNDLE/meatgeek-controller.service" "$(p /etc/systemd/system/meatgeek-controller.service)" 0644 && units_changed=1 && controller_changed=1
  install_file "$BUNDLE/meatgeek-pusher.service" "$(p /etc/systemd/system/meatgeek-pusher.service)" 0644 && units_changed=1
  if [[ $units_changed -eq 1 ]]; then
    systemctl daemon-reload
  fi

  # The unit's StateDirectory= would create it at the pusher's first start;
  # the identity is made before that.
  mkdir -p "$STATE"
  chown "$SVC_USER:$SVC_USER" "$STATE"
  chmod 0700 "$STATE"

  # Idempotent: keeps an existing key. It prints only the certificate.
  local crt=$BUNDLE/device.crt
  rm -f "$crt" "$crt.tmp"
  runuser -u "$SVC_USER" -- "$PUSHER" identity init --device-id "$DEVICE_ID" --state-dir "$STATE" >"$crt.tmp" ||
    die 1 "meatgeek-pusher identity init failed"
  if ! grep -q -- '-----BEGIN CERTIFICATE-----' "$crt.tmp" || grep -q -- 'PRIVATE KEY' "$crt.tmp"; then
    rm -f "$crt.tmp"
    die 1 "meatgeek-pusher identity init did not print a certificate"
  fi
  chmod 0644 "$crt.tmp"
  mv -f "$crt.tmp" "$crt"

  unit_enabled meatgeek-controller.service || systemctl enable meatgeek-controller.service
  if ! unit_active meatgeek-controller.service; then
    systemctl start meatgeek-controller.service
  elif [[ $controller_changed -eq 1 ]]; then
    systemctl restart meatgeek-controller.service
  fi
  log "installed; the controller is running and the pusher is not started yet"
}

# --- start -------------------------------------------------------------------

# Sets CLAIM_LINE and returns 0 when the pusher has registered (it has a
# cached DPS assignment) and holds a claim code that has not expired.
registered() {
  CLAIM_LINE=""
  [[ -f "$STATE/identity/assignment.json" ]] || return 1
  local out
  out=$(runuser -u "$SVC_USER" -- "$PUSHER" claim-code --state-dir "$STATE" 2>/dev/null) || return 1
  # An expired code is replaced when the restarted pusher reads its twin.
  [[ "$out" == *'"state":"unclaimed"'* || "$out" == *'"state":"claimed"'* ]] || return 1
  CLAIM_LINE=$out
}

phase_start() {
  trap 'rm -rf "$BUNDLE"' EXIT

  mkdir -p "$(p /etc/meatgeek-pusher)"
  chmod 0755 "$(p /etc/meatgeek-pusher)"
  local env
  env="MEATGEEK_DPS_ID_SCOPE=$ID_SCOPE
MEATGEEK_DEVICE_ID=$DEVICE_ID
MEATGEEK_STATE_DIR=$STATE_DIR
DEVICE_URL=http://localhost:3000
"
  write_file "$(p /etc/meatgeek-pusher/env)" 0640 "$env" || true
  chown "root:$SVC_USER" "$(p /etc/meatgeek-pusher/env)"

  unit_enabled meatgeek-pusher.service || systemctl enable meatgeek-pusher.service
  # A restart also re-mints an expired claim code.
  systemctl restart meatgeek-pusher.service
  log "started the pusher; waiting for it to register with DPS (at most ${WAIT_POLLS} s)"

  local n=0
  until registered; do
    if [[ $n -ge $WAIT_POLLS ]]; then
      log "the pusher did not register within ${WAIT_POLLS} s; its last 30 log lines:"
      journalctl -u meatgeek-pusher.service -n 30 --no-pager >&2 || true
      exit "$EXIT_TIMEOUT"
    fi
    sleep 1
    n=$((n + 1))
  done

  printf '%s\n%s\n%s\n' "$CLAIM_BEGIN" "$CLAIM_LINE" "$CLAIM_END"
  local unit state
  for unit in meatgeek-controller.service meatgeek-pusher.service; do
    state=$(systemctl is-active "$unit" 2>/dev/null) || true
    printf '%s: %s\n' "$unit" "${state:-unknown}"
  done
}

case "$PHASE" in
  install) phase_install ;;
  start) phase_start ;;
esac
