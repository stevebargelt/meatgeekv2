#!/usr/bin/env sh
#
# assert-credentialless.sh — prove, at RUNTIME, that the job running this script
# cannot reach Azure (MG-23).
#
# WHY THIS EXISTS. MG-23 re-scoped PR validation to be CREDENTIALLESS: a pull
# request touching apps/infrastructure/** runs `terraform init -backend=false`
# -> `validate` -> `test` and nothing else. There is no Azure identity, no
# protected environment, and no federated token anywhere on the PR path. That is
# a strong claim, and the ONLY thing that made it true was the ABSENCE of a few
# lines of YAML — an absence that a one-line edit restores without any test
# going red. This script converts that absence into a POSITIVE, executable
# assertion that fails the job the moment the property stops holding.
#
# It is deliberately a RUNTIME check rather than a YAML lint. A YAML lint proves
# what the workflow file says; this proves what the process actually inherited —
# which also catches a credential arriving via a composite action, a `uses:` step
# that exports one, or a self-hosted runner with an ambient login.
#
# WHAT IT ASSERTS (all must hold; any failure exits nonzero)
#   1. NO Azure credential material in the environment — neither the Terraform
#      azurerm provider's ARM_* family nor the Azure CLI / azure-login AZURE_*
#      family is present and non-empty.
#   2. NO OIDC MINTING CAPABILITY. ACTIONS_ID_TOKEN_REQUEST_URL and
#      ACTIONS_ID_TOKEN_REQUEST_TOKEN must not be set AT ALL.
#      *** THIS IS THE MOST LOAD-BEARING ASSERTION IN THE FILE. *** GitHub
#      injects those two variables into a job IF AND ONLY IF that job holds
#      `id-token: write`. Their absence is therefore a DIRECT, unforgeable proof
#      that the job cannot mint an OIDC token — i.e. that it cannot authenticate
#      to Azure even if a client-id, tenant-id and subscription-id were somehow
#      supplied to it. Every other check here narrows the blast radius; this one
#      closes the door. Do not weaken it to a non-empty test: a declared-but-
#      empty value still signals a permission grant worth failing on.
#   3. NO CACHED `az login` on the runner — no azureProfile.json carrying a
#      non-empty subscriptions array.
#   4. NON-VACUITY. The credentialless sequence is only meaningful if it actually
#      runs tests. If zero `*.tftest.hcl` files are discoverable, this gate is
#      certifying an empty test set, which is fail-open — so zero is a FAILURE.
#      The discovered count is printed so the CI log shows what was covered.
#
# Run it BEFORE any terraform step, so a credential is caught before anything
# can use one.
#
# PORTABILITY — a security property, not a style note, and the same contract the
# other gates in this directory carry. Strict POSIX sh: no bash-4 case
# modification, no arrays, no `[[`, no here-strings, no process substitution. A
# gate that raises a syntax error on the shell that actually runs it, while the
# caller still reaches a PASS, is fail-OPEN.
#
# USAGE
#   apps/infrastructure/scripts/assert-credentialless.sh
#
# Test discovery resolves relative to THIS SCRIPT'S OWN LOCATION, not the current
# working directory, so the gate reports on the tree it ships in no matter where
# it is invoked from.
#
set -u

PROG="assert-credentialless"

die() { echo "${PROG}: FATAL: $*" >&2; exit 1; }   # fail-closed

failures=0
fail() {
  echo "${PROG}: FAIL: $*" >&2
  failures=$((failures + 1))
}

# --- 0. Tools this gate needs ------------------------------------------------
# Fail closed if a tool the gate depends on is missing: an assertion that cannot
# run must never report success.
command -v find >/dev/null 2>&1 || die "find is required but not on PATH"

# --- 1. No Azure credential material in the environment ----------------------
# Both families matter. ARM_* is what the azurerm Terraform provider reads
# directly; AZURE_* is what azure/login and the Azure CLI populate. Either one
# present on a PR-reachable job means the credentialless property is broken.
CRED_VARS="ARM_CLIENT_ID ARM_CLIENT_SECRET ARM_CLIENT_CERTIFICATE_PATH \
ARM_TENANT_ID ARM_SUBSCRIPTION_ID ARM_OIDC_TOKEN ARM_OIDC_REQUEST_URL \
AZURE_CLIENT_ID AZURE_CLIENT_SECRET AZURE_TENANT_ID AZURE_SUBSCRIPTION_ID \
AZURE_CREDENTIALS AZURE_FEDERATED_TOKEN_FILE"

for _v in ${CRED_VARS}; do
  # POSIX indirect expansion. The names come from the fixed list above, never
  # from input, so there is nothing here for a caller to inject.
  eval "_val=\${${_v}:-}"
  if [ -n "${_val}" ]; then
    fail "Azure credential material present in the environment: ${_v} is set and non-empty."
  fi
done

# --- 2. No OIDC minting capability (see the header — most load-bearing) ------
# `${VAR+x}` tests SET-NESS, not emptiness, on purpose: GitHub injects these two
# only into jobs holding `id-token: write`, so their mere presence is the signal.
for _v in ACTIONS_ID_TOKEN_REQUEST_URL ACTIONS_ID_TOKEN_REQUEST_TOKEN; do
  eval "_set=\${${_v}+x}"
  if [ -n "${_set:-}" ]; then
    fail "OIDC minting capability detected: ${_v} is set. GitHub injects this ONLY into a job holding 'id-token: write' — this job must not hold it."
  fi
done

# --- 3. No cached `az login` on the runner -----------------------------------
# A pre-authenticated CLI profile would let a terraform run authenticate with no
# environment variable at all. Only a profile with a NON-EMPTY subscriptions
# array counts: the CLI writes a skeleton file on first use that authenticates
# nobody.
_az_cfg_dir="${AZURE_CONFIG_DIR:-${HOME:-}/.azure}"
_az_profile="${_az_cfg_dir}/azureProfile.json"
if [ -f "${_az_profile}" ]; then
  # jq is only required on the path where the file actually exists.
  command -v jq >/dev/null 2>&1 || \
    die "found ${_az_profile} but jq is not on PATH to inspect it — refusing to assume it is empty"
  _subs="$(jq -r '(.subscriptions // []) | length' "${_az_profile}" 2>/dev/null || echo "error")"
  if [ "${_subs}" = "error" ]; then
    die "could not parse ${_az_profile} — refusing to report credentialless on an unreadable CLI profile"
  fi
  if [ "${_subs}" != "0" ]; then
    fail "cached Azure CLI login detected: ${_az_profile} carries ${_subs} subscription(s)."
  fi
fi

# --- 4. Non-vacuity: the credentialless sequence must have tests to run ------
_script_dir="$(cd "$(dirname "$0")" && pwd)" || die "cannot resolve script directory"
_infra_root="$(cd "${_script_dir}/.." && pwd)" || die "cannot resolve infrastructure root"

# Prune generated/vendored trees: .nx and node_modules carry unrelated fixtures,
# and .terraform holds copies of module sources that would double-count.
_tests="$(find "${_infra_root}" \
  \( -name .nx -o -name .terraform -o -name node_modules -o -name .git \) -prune \
  -o -name '*.tftest.hcl' -print 2>/dev/null || true)"

if [ -z "${_tests}" ]; then
  _test_count=0
else
  _test_count="$(printf '%s\n' "${_tests}" | wc -l | tr -d ' ')"
fi

if [ "${_test_count}" -eq 0 ]; then
  fail "zero discovered *.tftest.hcl files under ${_infra_root} — a credentialless gate that certifies an EMPTY test set is fail-open."
else
  echo "${PROG}: discovered ${_test_count} terraform test file(s) under ${_infra_root}"
fi

# --- Verdict -----------------------------------------------------------------
if [ "${failures}" -ne 0 ]; then
  echo "${PROG}: REFUSING TO PROCEED — ${failures} check(s) failed. This job must hold no Azure identity." >&2
  exit 1
fi

echo "${PROG}: OK — no Azure credential material, no OIDC minting capability, no cached CLI login, ${_test_count} terraform test file(s) discoverable."
exit 0
