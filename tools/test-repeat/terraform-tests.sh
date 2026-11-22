#!/usr/bin/env bash
# HAR-107 — the `terraform-tests` suite for tools/test-repeat.
#
#   terraform-tests.sh init   backend-less init of the root and every
#                             test-bearing module (run once, before the loop)
#   terraform-tests.sh test   `terraform test` in the root and in every
#                             test-bearing module (one run)
#
# Mirrors ci.yml's validate-infrastructure steps "Terraform Init (root ...)",
# "Terraform tests (root module)" and "Terraform module tests (every
# test-bearing module)": the same find-driven discovery, the same refusal of an
# empty discovery, the same -backend=false -input=false -lockfile=readonly.
# Run from the repository root.
set -euo pipefail

mode="${1:-}"
case "$mode" in
  init | test) ;;
  *)
    echo "usage: $0 init|test" >&2
    exit 2
    ;;
esac

# HAR-119: the same environment whether the harness runs this or a person does.
#
# No checkpoint call: Terraform otherwise asks HashiCorp for the latest version
# on every command, so a run would reach the network.
export CHECKPOINT_DISABLE=1
# A short TMPDIR: Terraform's provider plugins listen on unix sockets in TMPDIR,
# and a socket path is limited to ~104 bytes, so an already-long TMPDIR (some
# sandboxes nest it deeply) breaks provider start-up. Same rule as the
# harness's (lib.mjs runCopy): over 60 characters, use a fresh dir under /tmp.
tmp_base="${TMPDIR:-/tmp}"
if [ "${#tmp_base}" -gt 60 ]; then
  short_tmp="$(mktemp -d /tmp/tf.XXXXXX)"
  trap 'rm -rf "$short_tmp"' EXIT
  export TMPDIR="$short_tmp"
fi

modules="$(
  find apps/infrastructure -name '*.tftest.hcl' \
    -not -path '*/.terraform/*' -not -path '*/.nx/*' -print |
    while IFS= read -r f; do
      d="$(dirname "$f")"
      case "$d" in
        */tests) d="${d%/tests}" ;;
      esac
      printf '%s\n' "$d"
    done |
    sort -u
)"
if [ -z "$modules" ]; then
  echo "no *.tftest.hcl discovered under apps/infrastructure —" >&2
  echo "refusing to report a vacuous pass" >&2
  exit 1
fi

if [ "$mode" = init ]; then
  terraform -chdir=apps/infrastructure init -backend=false -input=false -lockfile=readonly
  while IFS= read -r m; do
    terraform -chdir="$m" init -backend=false -input=false -lockfile=readonly
  done <<<"$modules"
  exit 0
fi

echo "== root module tests: apps/infrastructure =="
terraform -chdir=apps/infrastructure test
while IFS= read -r m; do
  echo "== module tests: $m =="
  terraform -chdir="$m" test
done <<<"$modules"
