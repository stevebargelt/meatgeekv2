#!/usr/bin/env bash
#
# MeatGeek V2 — derive the Terraform remote-state STORAGE ACCOUNT NAME from the
# subscription id (MG-24 item 9: global-uniqueness of the state account).
# =========================================================================
# Azure storage-account names are GLOBALLY unique and constrained to 3–24
# lowercase alphanumeric chars. A hardcoded literal (the old
# "meatgeekv2tfstate") is not guaranteed unique across subscriptions and cannot
# be re-created in a fresh subscription if the name is already taken elsewhere.
#
# This helper is the SINGLE source of truth for the name. bootstrap.sh sources
# it to create the account; the CI workflows and the operator runbook source it
# to inject `storage_account_name=$(state-account-name.sh "$ARM_SUBSCRIPTION_ID")`
# at `terraform init` time. Because there is exactly one derivation, the
# bootstrap, the backend init, and every workflow can never drift to different
# names.
#
# Format (deterministic, no randomness so it is stable across re-runs):
#   "meatgeekv2tf" (12 chars) + first 12 hex chars of sha1(subscription_id)
#   = 24 chars, lowercase alphanumeric — exactly the storage-account maximum,
#   and it satisfies the V1-safety guard (assert_v2_name: meatgeekv2*).
#
# NOTE: this is NOT a secret. The subscription id is an identifier, and the
# derived name is public infrastructure metadata. It is emitted to stdout by
# design so callers can capture it.
#
# Usage:
#   state-account-name.sh <subscription-id>   # explicit (CI / tests / runbook)
#   state-account-name.sh                      # falls back to ARM_SUBSCRIPTION_ID,
#                                              #   then `az account show`
#   source state-account-name.sh && state_account_name <sub-id>

# Prefix is 12 chars; the 12-char suffix fills the 24-char storage-account cap.
STATE_ACCOUNT_PREFIX="${STATE_ACCOUNT_PREFIX:-meatgeekv2tf}"

# Echo the derived, globally-unique state-account name for a subscription id.
# Returns non-zero (with a message on stderr) if no subscription id is available.
state_account_name() {
  local sub_id="${1:-}"
  if [ -z "$sub_id" ]; then
    sub_id="${ARM_SUBSCRIPTION_ID:-}"
  fi
  if [ -z "$sub_id" ]; then
    # Last resort: the currently-selected az subscription. Never fabricate one.
    sub_id="$(az account show --query id -o tsv 2>/dev/null || true)"
  fi
  if [ -z "$sub_id" ]; then
    echo "state-account-name: no subscription id — pass it as an argument, set ARM_SUBSCRIPTION_ID, or 'az login'." >&2
    return 1
  fi

  local suffix name
  # sha1sum output is lowercase hex (0-9a-f) => already storage-account-safe.
  suffix="$(printf '%s' "$sub_id" | sha1sum | cut -c1-12)"
  name="${STATE_ACCOUNT_PREFIX}${suffix}"

  # Defence in depth: never emit a name that would violate the storage-account
  # contract (<=24 lowercase alnum). This fails CLOSED rather than emitting a
  # name Azure would reject at create time.
  if ! printf '%s' "$name" | grep -Eq '^[a-z0-9]{3,24}$'; then
    echo "state-account-name: derived name '${name}' is not a valid storage-account name (<=24 lowercase alnum)." >&2
    return 1
  fi
  printf '%s\n' "$name"
}

# Run directly (not sourced): strict mode + emit the name for the given sub id.
if [ "${BASH_SOURCE[0]}" = "${0}" ]; then
  set -euo pipefail
  state_account_name "$@"
fi
