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
#   7. A secret OUTPUT (connection string / primary|secondary|access key /
#      instrumentation key) in any module or root outputs.tf (MG-24 S1 — secrets
#      must not leave via state). This is a BEST-EFFORT static guard: it catches
#      direct secret-attribute tokens AND the common INDIRECT/obfuscated forms
#      (a resource/module/data reference indexed with a dynamically-built key —
#      format()/join()/lookup()/element()/try()/coalesce() — or a string-literal
#      index that spells a secret fragment). It CANNOT semantically prove the
#      absence of every obfuscation a bash grep can't evaluate. The AUTHORITATIVE
#      guarantee is the plan/state inspection gate (check 12 + the README
#      pre-apply runbook): `terraform show -json <plan> | grep -iE
#      'connection_string|primary_key|SharedAccessKey|InstrumentationKey'`, which
#      surfaces the actual sensitive VALUES regardless of how they are
#      referenced. No exemption for a secret VALUE reaching an output — App
#      Insights included.
#   8. Wildcard CORS (allowed_origins includes "*") anywhere (MG-24 S2).
#   9. Function App is missing its managed identity or default-deny auth
#      posture, OR its app_settings still carry a connection-string / ingestion
#      key / primary|access key VALUE — App Insights included, no exemption for a
#      secret VALUE in app_settings (MG-24 S1/S2).
#  10. The Functions storage account name is not subscription-derived-unique.
#  11. The IoT Hub Event Hubs routing endpoint uses a SAS connection string
#      (or a lingering azurerm_eventhub_authorization_rule) instead of the IoT
#      Hub managed identity (identity-based auth) (MG-24 S1).
#  12. The README does NOT document the AUTHORITATIVE plan/state secret
#      inspection as a REQUIRED pre-apply gate. The static output scan (check 7)
#      is best-effort; the `terraform show -json` inspection is what actually
#      guarantees no sensitive VALUE materializes — so it must be a documented,
#      required pre-apply step, not an optional footnote (MG-24 red-fix).
#
# OPERATOR-ACCEPTED RESIDUAL (MG-24 — operator decision, steve@bargelt.com):
#   The azurerm_application_insights.main resource STAYS Terraform-managed. Every
#   TF-managed resource inherently stores its own computed attributes in state,
#   so that resource's own connection_string / instrumentation_key ARE present in
#   state — this is unavoidable while the resource is TF-managed. It is ACCEPTED
#   as low-risk: App Insights telemetry is write-only, the Function App
#   authenticates ingestion via AAD (Monitoring Metrics Publisher role +
#   APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD) so the ingestion
#   key is never used for authentication, and remote-state access is restricted.
#   Correspondingly, main.tf:94-95 extracts ONLY the non-secret IngestionEndpoint
#   substring — regex("IngestionEndpoint=([^;]+)", ...connection_string) wrapped
#   in nonsensitive() — into a local, and only that endpoint reaches app_settings.
#
#   The allowance is NARROW and does NOT widen the secret scans. It covers ONLY
#   (a) the resource's own inherent computed attribute in state and (b) the
#   endpoint-extraction local above. It is NOT a blanket App Insights exemption:
#   checks 7 and 9 STILL FAIL on a real secret VALUE — a connection string /
#   primary|secondary|access key / SharedAccessKey / instrumentation key —
#   assigned into an app_settings map OR emitted as an output, for ANY service
#   INCLUDING App Insights. A raw azurerm_application_insights.main.connection_string
#   copied into app_settings or an output is caught by the .connection_string
#   pattern below; the residual never sanctions that.
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

# --- 7. No secret OUTPUTS — BEST-EFFORT static guard (MG-24 S1) --------------
# Runtime credentials must never leave Terraform via an output (state exposure).
# Scan every outputs.tf for an output whose value derives a connection string /
# primary|secondary key / access key / shared access policy key / App Insights
# instrumentation (ingestion) key. App Insights is scanned exactly like every
# other service. (The AI resource's OWN computed key living in state is the
# separately-documented operator-accepted residual at the top of this file —
# that is not an output, so this scan never reaches it.)
#
# HONESTY NOTE (MG-24 red-fix): this is a BEST-EFFORT lexical guard, NOT a
# semantic proof. A bash grep cannot evaluate Terraform expressions, so a
# sufficiently obfuscated reference can slip past ANY token list. RED bypassed
# the previous literal-token scan with an assembled index:
#     azurerm_application_insights.main[format("%s_%s","connection","string")]
# — the token `connection_string` never appears, so the old grep missed it.
# We now ALSO flag the common INDIRECT forms below (dynamic/string-literal
# indexing into a resource/module/data reference). But the AUTHORITATIVE
# guarantee is the plan/state inspection (check 12 + README pre-apply runbook):
#     terraform show -json <plan> | grep -iE \
#       'connection_string|primary_key|SharedAccessKey|InstrumentationKey'
# which reports the actual sensitive VALUES regardless of how they are
# referenced. Comment lines (NN:<space>#) are stripped so explanatory notes
# don't self-trip the scan.
#
# DIRECT: literal secret-attribute tokens / SAS-key markers (primary|secondary|
# any *_access_key included).
DIRECT_SECRET_RE='connection_string|primary_key|secondary_key|primary_access_key|secondary_access_key|access_key|[A-Za-z0-9_]*_access_key|instrumentation_key|primary_connection_string|secondary_connection_string|shared_access_policy|InstrumentationKey=|AccountKey=|SharedAccessKey='
# INDIRECT / obfuscated: a resource/module/data reference INDEXED with either a
# dynamically-assembled key (format/join/lookup/element/coalesce/try) — the RED
# bypass vector — or a string literal spelling a secret-ish fragment. Legit
# numeric attribute indexing (e.g. `.identity[0]`) is NOT matched: the branches
# require a function call or a quoted key immediately after the bracket.
INDIRECT_SECRET_RE='(azurerm_|module\.|data\.)[A-Za-z0-9_.]+\[[[:space:]]*(format|join|lookup|element|coalesce|try)\(|(azurerm_|module\.|data\.)[A-Za-z0-9_.]+\[[[:space:]]*"[^"]*(connection|string|primary_key|secondary_key|access_key|instrumentation|password|secret|shared_access)[^"]*"[[:space:]]*\]'
secret_output_hits=""
while IFS= read -r out_file; do
  direct="$(grep -nE "${DIRECT_SECRET_RE}" "${out_file}" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
  indirect="$(grep -nE "${INDIRECT_SECRET_RE}" "${out_file}" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
  hits="$(printf '%s\n%s' "${direct}" "${indirect}" | grep -v '^$' || true)"
  if [[ -n "${hits}" ]]; then
    secret_output_hits+="${out_file}:"$'\n'"${hits}"$'\n'
  fi
done < <(find "${INFRA_DIR}" -type d \( -name '.terraform' -o -name 'node_modules' -o -name '.nx' \) -prune -o -type f -name 'outputs.tf' -print 2>/dev/null)
check "no secret outputs — best-effort scan (direct + obfuscated index refs)" "${secret_output_hits%$'\n'}"

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
  # No secret VALUE in app_settings for ANY service — App Insights included, no
  # exemption for a secret VALUE (MG-24 S1). This targets secret VALUES, not
  # setting NAMES: a sensitive Terraform attribute reference (.connection_string /
  # .instrumentation_key / .primary_key / .primary_access_key /
  # .primary_connection_string), a var whose name ends in *connection_string /
  # *instrumentation_key, a literal ingestion/account/SAS key marker
  # (InstrumentationKey= / AccountKey= / SharedAccessKey=), or a raw
  # storage_account_access_key. The standard APPLICATIONINSIGHTS_CONNECTION_STRING
  # SETTING is allowed ONLY because its value is the non-secret ingestion endpoint
  # (IngestionEndpoint=...) under AAD ingestion — if it ever carried an
  # instrumentation key or a .connection_string reference again, one of the
  # patterns below catches it. The operator-accepted residual documented at the
  # top of this file covers ONLY the endpoint-extraction local in main.tf, NEVER
  # a raw key here: a raw azurerm_application_insights.main.connection_string (or
  # .instrumentation_key) copied into app_settings is caught by .connection_string
  # / .instrumentation_key below. The hypothetical *_CONNECTION_STRING setting
  # names for the identity services stay flagged too.
  # Same best-effort DIRECT + INDIRECT approach as check 7: literal secret
  # attribute/var references AND obfuscated index refs (a resource/module/data/
  # local reference indexed with a dynamically-assembled key or a secret-fragment
  # string literal). Numeric attribute indexing (`.identity[0]`) is not matched.
  APPSETTING_SECRET_RE='\.connection_string|\.instrumentation_key|\.primary_key|\.primary_access_key|\.primary_connection_string|\.secondary_[a-z_]*key|var\.[a-z_]*connection_string|var\.[a-z_]*instrumentation_key|InstrumentationKey=|AccountKey=|SharedAccessKey=|storage_account_access_key|COSMOSDB_CONNECTION_STRING|IOTHUB_CONNECTION_STRING|SIGNALR_CONNECTION_STRING|(azurerm_|module\.|data\.|local\.)[A-Za-z0-9_.]+\[[[:space:]]*(format|join|lookup|element|coalesce|try)\(|\[[[:space:]]*"[^"]*(connection|instrumentation|primary_key|secondary_key|access_key|shared_access|password)[^"]*"[[:space:]]*\]'
  cs_settings="$(grep -nE "${APPSETTING_SECRET_RE}" "${FUNC_MAIN}" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
  if [[ -n "${cs_settings}" ]]; then
    func_posture+="connection-string / ingestion-key / access-key setting still present:"$'\n'"${cs_settings}"$'\n'
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

# --- 11. IoT Hub Event Hubs routing endpoint is identity-based (MG-24 S1) ----
# The custom Event Hubs routing endpoint must authenticate with the IoT Hub's
# managed identity — NOT a SAS connection string (which would materialize a
# key/connection string into Terraform state). Assert the endpoint declares
# identityBased auth, carries no connection_string, and that no
# azurerm_eventhub_authorization_rule (the former SAS source) lingers in the
# module.
IOT_MAIN="${INFRA_DIR}/modules/iot-hub/main.tf"
iot_routing=""
if [[ -f "${IOT_MAIN}" ]]; then
  iot_live="$(grep -vE '^[[:space:]]*#' "${IOT_MAIN}")"
  if ! echo "${iot_live}" | grep -qE 'authentication_type[[:space:]]*=[[:space:]]*"identityBased"'; then
    iot_routing+="Event Hubs routing endpoint is not identity-based (authentication_type = \"identityBased\" absent)"$'\n'
  fi
  if echo "${iot_live}" | grep -qE 'connection_string[[:space:]]*='; then
    iot_routing+="a connection_string is present in the IoT Hub module (SAS secret in state):"$'\n'"$(echo "${iot_live}" | grep -nE 'connection_string[[:space:]]*=')"$'\n'
  fi
  if echo "${iot_live}" | grep -qE 'azurerm_eventhub_authorization_rule'; then
    iot_routing+="an azurerm_eventhub_authorization_rule (SAS key source) still exists in the IoT Hub module"$'\n'
  fi
else
  iot_routing="modules/iot-hub/main.tf not found"
fi
check "IoT Hub routing endpoint: identity-based, no SAS connection string" "${iot_routing%$'\n'}"

# --- 12. Authoritative plan/state secret inspection is a REQUIRED pre-apply --
# gate in the README (MG-24 red-fix). The static output scan (check 7) is
# best-effort and cannot semantically prove no sensitive VALUE materializes;
# `terraform show -json <plan> | grep -iE 'connection_string|primary_key|
# SharedAccessKey|InstrumentationKey'` is what actually guarantees it. Assert the
# README documents this inspection AND marks it REQUIRED before the first apply,
# so the authoritative gate can't silently rot into an optional footnote.
README="${INFRA_DIR}/README.md"
runbook=""
if [[ -f "${README}" ]]; then
  readme_live="$(grep -vE '^[[:space:]]*#' "${README}" 2>/dev/null || true)"
  if ! echo "${readme_live}" | grep -qE 'terraform show -json'; then
    runbook+="README does not document the 'terraform show -json' plan/state secret inspection"$'\n'
  fi
  if ! echo "${readme_live}" | grep -qiE 'connection_string\|primary_key\|SharedAccessKey\|InstrumentationKey'; then
    runbook+="README plan-inspection grep does not cover the authoritative secret markers (connection_string|primary_key|SharedAccessKey|InstrumentationKey)"$'\n'
  fi
  if ! echo "${readme_live}" | grep -qiE 'REQUIRED.*pre-apply|pre-apply.*REQUIRED|required before the first apply|required pre-apply'; then
    runbook+="README does not mark the plan/state secret inspection as a REQUIRED pre-apply gate"$'\n'
  fi
else
  runbook="README.md not found"
fi
check "authoritative plan/state secret inspection is a required pre-apply gate (README)" "${runbook%$'\n'}"

echo
if [[ "${fail}" -ne 0 ]]; then
  echo "tf-static-checks: FAILED — fix the violations above." >&2
  exit 1
fi
echo "tf-static-checks: all checks passed."
exit 0
