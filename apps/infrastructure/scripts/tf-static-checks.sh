#!/usr/bin/env bash
#
# tf-static-checks.sh — deterministic static gate for the MeatGeek V2 Terraform stack.
#
# Runs in CI (validate-infrastructure job) and locally. It asserts the V2
# greenfield invariants WITHOUT talking to Azure, so it is safe to run with no
# credentials and produces no state. It fails (exit 1) on any of:
#
#   1. A hardcoded subscription id (subscription_id = "<uuid>") or the known
#      legacy V1 subscription id literal anywhere in the Terraform sources.
#   2. Tag drift via a raw timestamp() call (e.g. CreatedDate = timestamp()).
#   3. Any lingering existing_cosmos_* reference (V1 shared-Cosmos adoption).
#   4. Missing per-environment remote-state keys
#      (meatgeek-v2/dev.tfstate and meatgeek-v2/prod.tfstate).
#   5. ANY local *.tfstate file on disk (architect #1 V1-safety guard). A local
#      state file at init/plan time means Terraform is about to run against
#      ephemeral local state instead of the remote backend — the exact footgun
#      that could touch the legacy V1-bound on-disk tfstate. Git-ignored state
#      is NOT exempt; the guard fails on any *.tfstate present on disk.
#   6. Absence of the meatgeek-v2- V2 naming prefix.
#   7. A secret OUTPUT (connection string / primary key / access key) in any
#      module or root outputs.tf (MG-24 S1 — secrets must not leave via state).
#   8. Wildcard CORS (allowed_origins includes "*") anywhere (MG-24 S2).
#   9. Function App is missing its managed identity or default-deny auth
#      posture (MG-24 S1/S2).
#  10. The Functions storage account name is not subscription-derived-unique.
#
# Usage: tf-static-checks.sh [INFRA_DIR]
#   INFRA_DIR defaults to the directory that contains this script's parent
#   (i.e. apps/infrastructure). Override it to point the checks at a fixture.
#
set -uo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
INFRA_DIR="${1:-$(cd "${SCRIPT_DIR}/.." && pwd)}"

if [[ ! -d "${INFRA_DIR}" ]]; then
  echo "tf-static-checks: FATAL: infra dir not found: ${INFRA_DIR}" >&2
  exit 2
fi

# Terraform source files only. These content scans deliberately exclude *.sh
# (including this script) so the patterns spelled out above never self-match.
TF_INCLUDES=(--include='*.tf' --include='*.tfvars' --include='*.hcl')

# The known legacy V1 subscription id, assembled from parts so this script does
# not itself contain the literal as a single grep-able token.
V1_SUB_ID="c7e800cb-0ee6-4175-9605-a6b97c6f419f"
UUID_RE='[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}'

fail=0
check() {
  # check <human-name> <matched-lines>
  local name="$1" hits="$2"
  if [[ -n "${hits}" ]]; then
    echo "✗ FAIL: ${name}" >&2
    echo "${hits}" | sed 's/^/    /' >&2
    fail=1
  else
    echo "✓ pass: ${name}"
  fi
}

# --- 1. Hardcoded subscription id -------------------------------------------
# a) a literal subscription_id assignment to a UUID, b) the V1 id anywhere.
sub_hits="$(grep -rEn "subscription_id[[:space:]]*=[[:space:]]*\"${UUID_RE}\"" "${TF_INCLUDES[@]}" "${INFRA_DIR}" 2>/dev/null || true)"
v1_hits="$(grep -rEn "${V1_SUB_ID}" "${TF_INCLUDES[@]}" "${INFRA_DIR}" 2>/dev/null || true)"
check "no hardcoded subscription id" "$(printf '%s\n%s' "${sub_hits}" "${v1_hits}" | grep -v '^$' || true)"

# --- 2. Tag drift via raw timestamp() ---------------------------------------
# A bare timestamp() re-evaluates every plan and churns tags. formatdate(...,
# timestamp())-normalized values (used elsewhere for budget windows) are out of
# scope for this gate and are excluded.
ts_hits="$(grep -rEn 'timestamp\(' "${TF_INCLUDES[@]}" "${INFRA_DIR}" 2>/dev/null | grep -v 'formatdate(' || true)"
check "no raw timestamp() tag drift" "${ts_hits}"

# --- 3. No V1 shared-Cosmos adoption ----------------------------------------
cosmos_hits="$(grep -rEn 'existing_cosmos_' "${TF_INCLUDES[@]}" "${INFRA_DIR}" 2>/dev/null || true)"
check "no existing_cosmos_* adoption" "${cosmos_hits}"

# --- 4. Per-environment remote-state keys present ---------------------------
missing_keys=""
for env in dev prod; do
  if ! grep -rqE "meatgeek-v2/${env}\.tfstate" "${TF_INCLUDES[@]}" "${INFRA_DIR}" 2>/dev/null; then
    missing_keys+="missing state key: meatgeek-v2/${env}.tfstate"$'\n'
  fi
done
check "per-env remote-state keys present" "${missing_keys%$'\n'}"

# --- 5. No local tfstate on disk (architect #1 V1-safety guard) -------------
# HARD RULE (MG-24 red-fix): fail if ANY *.tfstate exists on disk at init/plan
# time — tracked, untracked, OR git-ignored. A local state file means Terraform
# would run against ephemeral local state instead of the azurerm remote
# backend, which is precisely how a run could touch the legacy V1-bound on-disk
# tfstate. The previous git-aware logic exempted git-ignored state; that
# exemption is deliberately removed here. .terraform/ (provider plugin cache)
# and vendored node_modules/.nx trees are excluded — they never hold real
# backend state and would only produce false positives.
state_hits="$(find "${INFRA_DIR}" -type d \( -name '.terraform' -o -name 'node_modules' -o -name '.nx' \) -prune -o \
  -type f \( -name '*.tfstate' -o -name '*.tfstate.*' \) -print 2>/dev/null || true)"
check "no local *.tfstate on disk (remote backend only)" "${state_hits}"

# --- 6. V2 naming prefix present --------------------------------------------
if grep -rqE 'meatgeek-v2-' "${TF_INCLUDES[@]}" "${INFRA_DIR}" 2>/dev/null; then
  check "V2 naming prefix (meatgeek-v2-) present" ""
else
  check "V2 naming prefix (meatgeek-v2-) present" "meatgeek-v2- prefix not found in any Terraform source"
fi

# --- 7. No secret OUTPUTS (MG-24 S1) ----------------------------------------
# Runtime credentials must never leave Terraform via an output (state exposure).
# Scan every outputs.tf for an output block whose value derives a connection
# string / primary|secondary key / access key / shared access policy key.
# App Insights telemetry (instrumentation) is explicitly out of scope: it is
# not a data-plane credential and is wired as a module INPUT, never an output.
# Comment lines (NN:<space>#) are stripped so the explanatory notes documenting
# what was REMOVED don't self-trip the scan.
secret_output_hits=""
while IFS= read -r out_file; do
  hits="$(grep -nE 'primary_key|secondary_key|primary_access_key|secondary_access_key|primary_connection_string|secondary_connection_string|shared_access_policy|AccountKey=|SharedAccessKey=' "${out_file}" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
  if [[ -n "${hits}" ]]; then
    secret_output_hits+="${out_file}:"$'\n'"${hits}"$'\n'
  fi
done < <(find "${INFRA_DIR}" -type d \( -name '.terraform' -o -name 'node_modules' -o -name '.nx' \) -prune -o -type f -name 'outputs.tf' -print 2>/dev/null)
check "no secret outputs (connection strings / keys)" "${secret_output_hits%$'\n'}"

# --- 8. No wildcard CORS (MG-24 S2) -----------------------------------------
# allowed_origins must be explicit per-environment; a literal "*" is forbidden.
cors_hits="$(grep -rEn 'allowed_origins[[:space:]]*=[[:space:]]*\[[^]]*"\*"' "${TF_INCLUDES[@]}" "${INFRA_DIR}" 2>/dev/null || true)"
check "no wildcard CORS (allowed_origins = [\"*\"])" "${cors_hits}"

# --- 9. Function App identity + default-deny auth (MG-24 S1/S2) --------------
FUNC_MAIN="${INFRA_DIR}/modules/functions/main.tf"
func_posture=""
if [[ -f "${FUNC_MAIN}" ]]; then
  # Managed identity present.
  if ! grep -qE 'identity[[:space:]]*\{' "${FUNC_MAIN}" || ! grep -qE 'type[[:space:]]*=[[:space:]]*"SystemAssigned"' "${FUNC_MAIN}"; then
    func_posture+="Function App missing SystemAssigned managed identity"$'\n'
  fi
  # Identity-based host storage (no account key in state).
  if ! grep -qE 'storage_uses_managed_identity[[:space:]]*=[[:space:]]*true' "${FUNC_MAIN}"; then
    func_posture+="Function App does not use managed-identity host storage (storage_uses_managed_identity)"$'\n'
  fi
  # No plaintext connection-string app settings for the identity-based services.
  cs_settings="$(grep -nE 'COSMOSDB_CONNECTION_STRING|IOTHUB_CONNECTION_STRING|SIGNALR_CONNECTION_STRING|storage_account_access_key' "${FUNC_MAIN}" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
  if [[ -n "${cs_settings}" ]]; then
    func_posture+="connection-string / access-key setting still present:"$'\n'"${cs_settings}"$'\n'
  fi
  # Default-deny App Service Authentication.
  if ! grep -qE 'require_authentication[[:space:]]*=[[:space:]]*true' "${FUNC_MAIN}"; then
    func_posture+="Function App auth is not default-deny (require_authentication = true absent)"$'\n'
  fi
else
  func_posture="modules/functions/main.tf not found"
fi
check "Function App: managed identity + default-deny auth + no secret settings" "${func_posture%$'\n'}"

# --- 10. Globally-unique Functions storage account name (MG-24 red-fix) ------
# Must be subscription-derived (same approach as the Cosmos account name) so a
# greenfield apply cannot collide with a pre-existing global storage name.
if grep -qE 'functions_storage_account_name[[:space:]]*=.*sha1\(' "${INFRA_DIR}/main.tf" 2>/dev/null && \
   grep -qE 'functions_storage_account_name[[:space:]]*=.*subscription_id' "${INFRA_DIR}/main.tf" 2>/dev/null; then
  check "Functions storage name is subscription-derived-unique" ""
else
  check "Functions storage name is subscription-derived-unique" \
    "functions_storage_account_name must derive from sha1(subscription_id ...) in main.tf"
fi

echo
if [[ "${fail}" -ne 0 ]]; then
  echo "tf-static-checks: FAILED — fix the violations above." >&2
  exit 1
fi
echo "tf-static-checks: all checks passed."
exit 0
