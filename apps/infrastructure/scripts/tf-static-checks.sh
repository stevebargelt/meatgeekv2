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
#  13. ALLOWLIST DRIFT (MG-23 F9/F10). Every `role_definition_name` in the
#      Terraform graph must appear in bootstrap/tf-managed-role-allowlist.tsv,
#      and every allowlisted role must appear in the graph. That file is the
#      single source the bootstrap builds the apply identity's ABAC condition
#      from, so a role added to the graph but not to the allowlist would be
#      DENIED at apply time — mid-run, with AuthorizationFailed and a partially
#      applied stack. This check moves that failure to PR time with a message
#      naming the fix. HONEST SCOPE: it guards role NAMES only. GUID correctness
#      is a LIVE bootstrap-time property (bootstrap.sh resolves each GUID from
#      the tenant and fails closed on disagreement); a credential-less CI job
#      cannot re-verify it.
#  14. GRAPH SCOPE REGRESSION GUARD (MG-23 F14). No `azurerm_role_assignment` in
#      the graph may be scoped to a subscription, or to a resource group other
#      than the workload RG. The MG-23 dev apply identity is Contributor on
#      meatgeek-v2-dev-rg and NOTHING else, so a subscription-scoped assignment
#      in the graph is not merely over-broad — it is unappliable by CI, and the
#      tempting "fix" (widening the identity) would demolish the RG boundary the
#      whole threat model rests on. HONEST SCOPE: this is a regression guard on
#      the TERRAFORM GRAPH. The genuinely out-of-RG grants in this system are
#      BOOTSTRAP-managed (subscription Reader for the plan identity, the
#      container-scoped state roles) and are invisible to an HCL scan; they are
#      asserted separately, by name, in bootstrap/bootstrap.test.sh.
#  15. TERRAFORM TESTS ARE MOCK-PROVIDER / NON-APPLYING (MG-23). Every
#      `*.tftest.hcl` must run against MOCKED providers and must never apply.
#      This is what makes the credentialless PR gate credentialless: as of MG-23
#      a pull request touching apps/infrastructure/** runs `terraform test` with
#      NO Azure identity, NO `id-token: write` and NO protected environment (see
#      scripts/assert-credentialless.sh, which proves the same property at
#      RUNTIME). A test file that declares a REAL provider block, or that runs
#      `command = apply`, would attempt live Azure authentication or live
#      provisioning from a PR — turning the one job an untrusted contributor can
#      reach into an Azure-reaching job. So: no top-level `provider "..."` block,
#      no `command = apply`, and any file referencing an azurerm_/azapi_ resource
#      must declare the matching `mock_provider`. Finding ZERO test files is also
#      a failure — a gate that certifies an empty test set is fail-open.
#  16. A CI-INVOKED MODULE FLOATS ITS PROVIDERS (MG-39). Every module the CI
#      module-test loop inits must declare an explicit version constraint for
#      every provider it uses AND carry a committed .terraform.lock.hcl. Missing
#      either half means `terraform init` on a fresh runner resolves whatever the
#      registry serves that minute: modules/iot-hub declared no azurerm
#      constraint, so on 2026-08-03 it silently took the breaking azurerm v5.0.1
#      and reddened every PR with nothing in this repo having changed. A gate
#      whose result depends on the registry clock is not a gate. Discovery here is
#      find-driven on *.tftest.hcl — the SAME rule ci.yml uses to pick modules —
#      so a module cannot start being CI-invoked without also being covered.
#  17. AN IOT HUB ROUTE DOES NOT REPLACE WITH ITS ENDPOINT (MG-48). Every
#      `azurerm_iothub_route` must carry `lifecycle { replace_triggered_by = [...] }`
#      naming the SAME endpoint resource its `endpoint_names` routes to. The
#      endpoint_names reference alone propagates ordering but not replacement — it
#      reads `.name`, a static literal that is identical before and after the
#      endpoint is replaced — so the route is never planned for replacement and
#      Terraform tries to delete an endpoint a live route still points at. Azure
#      refuses that with IH400111, which is how the 2026-08-06 dev apply died
#      partway through. This is a LEXICAL check by necessity: replacement is a
#      state-diff property, every `command = plan` run in `terraform test` starts
#      from EMPTY state, `command = apply` is banned by check 15 (that ban is what
#      keeps the PR gate credentialless and must not be weakened), and
#      replace_triggered_by does not appear in `terraform show -json` at all — so no
#      Terraform-native assertion can discriminate. The pairing is DERIVED per route
#      rather than hardcoded, so a block attached to the wrong route fails too.
#      Finding ZERO routes is a failure, not a vacuous pass.
#  18. A CHILD REACHES ITS PARENT BY THE PARENT'S CONFIGURED NAME AND IS NOT
#      REPLACED WITH IT (MG-48). The general form of check 17, stated in
#      ATTRIBUTE-KIND terms rather than resource types: wherever a `resource`
#      block assigns `<something>_name = <managed resource>.<label>.name`, that
#      child must carry `lifecycle { replace_triggered_by = [...] }` naming that
#      parent's address. A reference to a parent's COMPUTED attribute (`.id`, an
#      endpoint URI) carries replacement — it is unknown until the new parent
#      exists, so the child's configuration changes and Terraform plans the child
#      for replacement too. A reference to the parent's CONFIGURED `name` carries
#      ORDERING ONLY: that name is a static literal, identical before and after,
#      so Terraform never plans the child for replacement while Azure destroys it
#      with the parent anyway — leaving state listing a resource that no longer
#      exists. That is the 2026-08-07 dev outage: `free_tier_enabled` is
#      create-only, so claiming the free tier replaced the Cosmos account
#      (azurerm_cosmosdb_account.main), Azure destroyed meatgeek-v2-dev-db and its
#      five containers along with it, state kept listing all six, and the IoT Hub
#      Cosmos endpoint's create then failed with IH400142 "Database does not
#      exist".
#      DISCOVERY-DRIVEN, NOT AN ALLOWLIST. Keying this on Cosmos resource types
#      would encode the very assumption that has now broken dev twice ("the
#      obvious two are all of them") and would have passed green against the five
#      latent IoT Hub pairs. Every (child, parent) pair is derived from the HCL,
#      so a new resource of any type is covered the day it is written.
#      EXCLUSION BOUNDARY — documented because an undocumented exclusion is how
#      the next enumeration gap gets created:
#        * `resource_group_name` is excluded. Every resource in the stack reaches
#          the RG by name; an RG replacement is a whole-stack event that
#          tf-plan-destroy-guard.sh blocks on sight, so pairing every resource to
#          it would add no protection and drown the real pairs.
#        * A right-hand side under `data.` / `var.` / `local.` / `module.` is
#          excluded because replace_triggered_by accepts only MANAGED resources in
#          the SAME module — none of those may appear in it, so there is no
#          in-module fix to demand. (Where such a boundary reference genuinely
#          needs to carry replacement, the fix is to pass the parent's id across
#          the boundary onto a `terraform_data` handle, as modules/iot-hub does
#          with terraform_data.cosmos_target_ready.)
#        * `module` and `output` blocks are out of scope STRUCTURALLY: neither can
#          carry a `lifecycle` block, so there is nothing to assert. This is why
#          the root main.tf `log_analytics_workspace_name` module argument and
#          modules/cosmos-db/outputs.tf's `account_name`/`database_name` are not
#          hits.
#      LEXICAL BY NECESSITY, for exactly check 17's reasons: replacement is a
#      state-diff property, `command = plan` always starts from EMPTY state,
#      `command = apply` is banned by check 15 (that ban is what keeps the PR gate
#      credentialless and must not be weakened), and replace_triggered_by never
#      appears in `terraform show -json`. No Terraform-native assertion can see
#      this, which makes this check the only automated guard there is.
#      Finding ZERO pairs is a failure, not a vacuous pass.
#
# OPERATOR-ACCEPTED RESIDUAL (MG-24 — operator decision, steve@bargelt.com):
#   The azurerm_application_insights.main resource STAYS Terraform-managed. Every
#   TF-managed resource inherently stores its own computed attributes in state,
#   so that resource's own connection_string / instrumentation_key ARE present in
#   state — this is unavoidable while the resource is TF-managed. It is ACCEPTED
#   as low-risk: App Insights telemetry is write-only, the Function App
#   authenticates ingestion via AAD (Monitoring Metrics Publisher role +
#   APPLICATIONINSIGHTS_AUTHENTICATION_STRING=Authorization=AAD) so the embedded
#   ingestion key is never used for authentication, and remote-state access is
#   restricted.
#
#   SHIPPED MODEL (supersedes the earlier endpoint-only design): the Function App
#   passes the FULL TF-managed App Insights connection string — InstrumentationKey
#   INCLUDED — as APPLICATIONINSIGHTS_CONNECTION_STRING (root main.tf sets
#   local.appinsights_connection_string = nonsensitive(azurerm_application_insights
#   .main.connection_string); the functions module binds it verbatim). Microsoft
#   REQUIRES the full connection string with its InstrumentationKey as the
#   destination-resource identifier even under Entra, so this is REQUIRED and
#   ACCEPTED — NOT a violation. The earlier design that extracted only the
#   IngestionEndpoint substring into app_settings is SUPERSEDED and no longer how
#   the stack is wired.
#
#   The allowance is a NARROW, COUPLED invariant — it does NOT widen the secret
#   scans. The full AI connection string in app_settings is accepted ONLY while
#   `local_authentication_enabled = false` on the azurerm_application_insights
#   resource forces AAD-only ingestion, so the embedded ikey CANNOT authenticate.
#   If local auth is NOT disabled, that very same full connection string in
#   app_settings is a VIOLATION (check 9). And it is NOT a blanket App Insights
#   exemption: checks 7 and 9 STILL FAIL on the AI connection string as an OUTPUT
#   (an export surface — never accepted) and on every OTHER secret VALUE — a
#   connection string / primary|secondary|access key / SharedAccessKey — for ANY
#   service including App Insights. The authoritative runtime proof of the same
#   coupled invariant is the plan/state gate (scripts/tf-plan-secret-inspection.sh).
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

# --- 2. Tag / budget-window drift via timestamp() ---------------------------
# MG-24 item 7 CORRECTION: timestamp() is now forbidden ANYWHERE — including
# wrapped in formatdate(). The previous gate excluded `formatdate(..., timestamp())`,
# which is exactly how the monitoring module's budget start_date silently rolled
# over each month boundary (formatdate("YYYY-MM-01...", timestamp()) recomputes to
# the current month every plan, so a 2nd plan across a month boundary is NOT a
# no-op). The stable replacement is a persisted `time_static` anchor. So: fail on
# ANY timestamp() call in the Terraform sources, formatdate-wrapped or not.
# Comment lines are stripped so the explanatory note in a .tf file can't self-trip.
ts_hits="$(grep -rEn 'timestamp\(' "${TF_INCLUDES[@]}" "${INFRA_DIR}" 2>/dev/null | grep -vE '^[^:]+:[0-9]+:[[:space:]]*#' || true)"
check "no timestamp() drift (formatdate-wrapped included)" "${ts_hits}"

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
  # Identity-based deployment storage, NO account key in state (MG-24 Flex revision).
  # The hosting model moved from azurerm_linux_function_app (Y1/EP1) to
  # azurerm_function_app_flex_consumption. The old azurerm_linux_function_app
  # attribute `storage_uses_managed_identity = true` NO LONGER EXISTS on the flex
  # resource; MI-authenticated deployment storage is now expressed by the pair
  # storage_authentication_type = "SystemAssignedIdentity" +
  # storage_container_type = "blobContainer" (a BLOB deployment container, not the
  # Y1 Azure Files content share that required a shared key). We also re-assert here
  # that the functions storage account KEEPS shared key DISABLED, so no account key
  # can be minted into state (MG-24 point 5 — no new key exception). The account is
  # now created via azapi over the ARM CONTROL PLANE
  # (Microsoft.Storage/storageAccounts) — NOT azurerm_storage_account, whose OWN
  # shared-key data-plane reads 403 on a shared-key-disabled account — so the
  # disablement invariant lives in the azapi body's allowSharedKeyAccess = false
  # rather than the former azurerm shared_access_key_enabled attribute.
  if ! grep -qE 'storage_authentication_type[[:space:]]*=[[:space:]]*"SystemAssignedIdentity"' "${FUNC_MAIN}"; then
    func_posture+="Function App Flex deployment storage is not identity-based (storage_authentication_type = \"SystemAssignedIdentity\" absent — the flex MI-blob replacement for the removed storage_uses_managed_identity)"$'\n'
  fi
  if ! grep -qE 'storage_container_type[[:space:]]*=[[:space:]]*"blobContainer"' "${FUNC_MAIN}"; then
    func_posture+="Function App Flex deployment storage is not a blob container (storage_container_type = \"blobContainer\" absent)"$'\n'
  fi
  if ! grep -qE 'allowSharedKeyAccess[[:space:]]*=[[:space:]]*false' "${FUNC_MAIN}"; then
    func_posture+="Functions storage account no longer disables shared key (azapi body allowSharedKeyAccess = false absent — a re-enabled key would mint an account key into state)"$'\n'
  fi
  # No secret VALUE in app_settings for ANY service — App Insights included, with
  # exactly ONE cross-field-conditional exemption (MG-24 item 2). This targets
  # secret VALUES, not setting NAMES: a sensitive Terraform attribute reference
  # (.connection_string / .instrumentation_key / .primary_key / .primary_access_key
  # / .primary_connection_string), a var whose name ends in *connection_string /
  # *instrumentation_key, a literal ingestion/account/SAS key marker
  # (InstrumentationKey= / AccountKey= / SharedAccessKey=), a raw
  # storage_account_access_key, OR the Flex deployment-storage `storage_access_key`
  # attribute. Under the shipped MI model the flex deployment container authenticates
  # via storage_authentication_type=SystemAssignedIdentity, so `storage_access_key`
  # MUST NOT appear at all — any assignment reintroduces the shared-key deployment
  # path and would mint a key into state (the HCL-level companion to the plan gate's
  # unconditional storage_access_key rejection, MG-24 red dd7ba9).
  #
  # MG-24 item 2 CORRECTION — the coupled App Insights invariant:
  #   The Function App now passes the FULL TF-managed App Insights connection
  #   string (InstrumentationKey included — Microsoft requires it as the
  #   destination-resource identifier even under Entra) as
  #   `var.application_insights_connection_string`. That would normally trip the
  #   `var\..*connection_string` pattern below. It is ALLOWED — but ONLY when the
  #   root main.tf sets `local_authentication_enabled = false` on the
  #   azurerm_application_insights resource, which forces AAD-only ingestion so the
  #   embedded ikey CANNOT authenticate. This is a CROSS-FIELD conditional, not an
  #   unconditional App Insights allow: if local auth is NOT disabled, the very
  #   same `var.application_insights_connection_string` in app_settings is a
  #   VIOLATION (the ikey could then authenticate). The exemption is scoped to
  #   THIS one var token and drops a line only when it carries no OTHER secret
  #   marker; every other secret VALUE — for App Insights or any other service —
  #   stays flagged. The AUTHORITATIVE runtime proof of this same invariant is the
  #   plan/state gate (scripts/tf-plan-secret-inspection.sh, check 12).
  #
  # Same best-effort DIRECT + INDIRECT approach as check 7: literal secret
  # attribute/var references AND obfuscated index refs (a resource/module/data/
  # local reference indexed with a dynamically-assembled key or a secret-fragment
  # string literal). Numeric attribute indexing (`.identity[0]`) is not matched.
  APPSETTING_SECRET_RE='\.connection_string|\.instrumentation_key|\.primary_key|\.primary_access_key|\.primary_connection_string|\.secondary_[a-z_]*key|var\.[a-z_]*connection_string|var\.[a-z_]*instrumentation_key|InstrumentationKey=|AccountKey=|SharedAccessKey=|storage_account_access_key|storage_access_key[[:space:]]*=|COSMOSDB_CONNECTION_STRING|IOTHUB_CONNECTION_STRING|SIGNALR_CONNECTION_STRING|(azurerm_|module\.|data\.|local\.)[A-Za-z0-9_.]+\[[[:space:]]*(format|join|lookup|element|coalesce|try)\(|\[[[:space:]]*"[^"]*(connection|instrumentation|primary_key|secondary_key|access_key|shared_access|password)[^"]*"[[:space:]]*\]'

  # Is telemetry local auth disabled on the AI resource in the ROOT main.tf? Only
  # then is the full-conn-string exemption unlocked (the coupled invariant). We
  # extract the azurerm_application_insights resource block and look for the flag
  # INSIDE it, so a stray local_authentication_enabled elsewhere can't unlock it.
  ROOT_MAIN="${INFRA_DIR}/main.tf"
  ai_local_auth_disabled=0
  ALLOWED_AI_VAR='var\.application_insights_connection_string'
  if [[ -f "${ROOT_MAIN}" ]]; then
    ai_block="$(awk '/resource[[:space:]]+"azurerm_application_insights"/{f=1} f{print} f&&/^}/{f=0}' "${ROOT_MAIN}" 2>/dev/null || true)"
    if grep -qE 'local_authentication_enabled[[:space:]]*=[[:space:]]*false' <<< "${ai_block}"; then
      ai_local_auth_disabled=1
    fi
  fi

  cs_settings="$(grep -nE "${APPSETTING_SECRET_RE}" "${FUNC_MAIN}" 2>/dev/null | grep -vE '^[0-9]+:[[:space:]]*#' || true)"
  # Apply the coupled-invariant exemption: when local auth is disabled, drop a hit
  # line whose ONLY secret token is the accepted AI conn-string var (re-test the
  # line with that token stripped — if another secret remains, keep it flagged).
  if [[ -n "${cs_settings}" && "${ai_local_auth_disabled}" -eq 1 ]]; then
    kept=""
    while IFS= read -r line; do
      [[ -z "${line}" ]] && continue
      stripped="${line//var.application_insights_connection_string/}"
      if grep -qE "${APPSETTING_SECRET_RE}" <<< "${stripped}"; then
        kept+="${line}"$'\n'   # a DIFFERENT secret is on this line — still a violation
      fi
    done <<< "${cs_settings}"
    cs_settings="${kept%$'\n'}"
  fi
  if [[ -n "${cs_settings}" ]]; then
    if [[ "${ai_local_auth_disabled}" -eq 0 ]] && grep -qE "${ALLOWED_AI_VAR}" <<< "${cs_settings}"; then
      func_posture+="full App Insights connection string in app_settings WITHOUT local_authentication_enabled=false on azurerm_application_insights (coupled-invariant violation — ikey could authenticate; MG-24 item 2):"$'\n'"${cs_settings}"$'\n'
    else
      func_posture+="connection-string / ingestion-key / access-key setting still present:"$'\n'"${cs_settings}"$'\n'
    fi
  fi
  # Default-deny App Service Authentication.
  if ! grep -qE 'require_authentication[[:space:]]*=[[:space:]]*true' "${FUNC_MAIN}"; then
    func_posture+="Function App auth is not default-deny (require_authentication = true absent)"$'\n'
  fi
else
  func_posture="modules/functions/main.tf not found"
fi
check "Function App: managed identity + default-deny auth + no secret settings" "${func_posture%$'\n'}"

# --- CHECK 10. Globally-unique Functions storage account name (MG-24 red-fix) ------
# Must be subscription-derived (same approach as the Cosmos account name) so a
# greenfield apply cannot collide with a pre-existing global storage name.
if grep -qE 'functions_storage_account_name[[:space:]]*=.*sha1\(' "${INFRA_DIR}/main.tf" 2>/dev/null && \
   grep -qE 'functions_storage_account_name[[:space:]]*=.*subscription_id' "${INFRA_DIR}/main.tf" 2>/dev/null; then
  check "Functions storage name is subscription-derived-unique" ""
else
  check "Functions storage name is subscription-derived-unique" \
    "functions_storage_account_name must derive from sha1(subscription_id ...) in main.tf"
fi

# --- CHECK 11. IoT Hub Event Hubs routing endpoint is identity-based (MG-24 S1) ----
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
  if ! grep -qE 'authentication_type[[:space:]]*=[[:space:]]*"identityBased"' <<< "${iot_live}"; then
    iot_routing+="Event Hubs routing endpoint is not identity-based (authentication_type = \"identityBased\" absent)"$'\n'
  fi
  if grep -qE 'connection_string[[:space:]]*=' <<< "${iot_live}"; then
    iot_routing+="a connection_string is present in the IoT Hub module (SAS secret in state):"$'\n'"$(grep -nE 'connection_string[[:space:]]*=' <<< "${iot_live}")"$'\n'
  fi
  if grep -qE 'azurerm_eventhub_authorization_rule' <<< "${iot_live}"; then
    iot_routing+="an azurerm_eventhub_authorization_rule (SAS key source) still exists in the IoT Hub module"$'\n'
  fi
else
  iot_routing="modules/iot-hub/main.tf not found"
fi
check "IoT Hub routing endpoint: identity-based, no SAS connection string" "${iot_routing%$'\n'}"

# --- CHECK 12. Authoritative FAIL-CLOSED plan/state secret inspection is a REQUIRED --
# pre-apply gate in the README (MG-24 item 6). The static output scan (check 7)
# is best-effort and cannot semantically prove no sensitive VALUE materializes.
# The OLD authoritative gate was a README one-liner
#   `terraform show -json <plan> | grep -iE '...' || echo "no secrets ✓"`
# which ALWAYS exits 0 (the `|| echo` swallows the failure) — it prints a warning
# but never BLOCKS an apply. MG-24 item 6 replaces it with the fail-closed script
# scripts/tf-plan-secret-inspection.sh, which EXITS NONZERO on any violation. So
# check 12 now asserts the README documents THAT script AND marks it REQUIRED
# before the first apply. The always-green `grep ... || echo` shape is explicitly
# rejected here so it cannot creep back in as the documented gate. (The README
# lives in INFRA_DIR; the operator runbook under docs/ carries the same script per
# the docs step — this gate anchors on the in-tree README that ships with the
# stack.)
README="${INFRA_DIR}/README.md"
runbook=""
if [[ -f "${README}" ]]; then
  readme_live="$(grep -vE '^[[:space:]]*#' "${README}" 2>/dev/null || true)"
  if ! grep -qE 'tf-plan-secret-inspection\.sh' <<< "${readme_live}"; then
    runbook+="README does not document the fail-closed scripts/tf-plan-secret-inspection.sh plan/state gate"$'\n'
  fi
  if ! grep -qiE 'REQUIRED.*pre-apply|pre-apply.*REQUIRED|required before the first apply|required pre-apply' <<< "${readme_live}"; then
    runbook+="README does not mark the plan/state secret inspection as a REQUIRED pre-apply gate"$'\n'
  fi
  # Reject the always-green shape as the DOCUMENTED gate: a `terraform show -json`
  # (or the script) piped to grep and neutralized with `|| echo`/`|| true` exits 0
  # regardless of findings, so it can never block an apply. If such a line is what
  # the README presents, the fail-closed gate has rotted back to a footnote.
  green_shape="$(grep -nE '(terraform show -json|tf-plan-secret-inspection)[^|]*\|[^|]*grep' <<< "${readme_live}" 2>/dev/null | grep -E '\|\|[[:space:]]*(echo|true|:)' || true)"
  if [[ -n "${green_shape}" ]]; then
    runbook+="README documents an ALWAYS-GREEN inspection (grep ... || echo/true), which never blocks an apply — use the fail-closed tf-plan-secret-inspection.sh instead:"$'\n'"${green_shape}"$'\n'
  fi
else
  runbook="README.md not found"
fi
check "fail-closed plan/state secret inspection is a required pre-apply gate (README)" "${runbook%$'\n'}"

# --- CHECK 13. Terraform-managed role allowlist drift (MG-23 F9/F10) ---------------
# bootstrap/tf-managed-role-allowlist.tsv is the SINGLE source of truth for the
# role definitions the dev infra-apply identity's ABAC condition permits. Two
# artifacts read it — bootstrap.sh (to BUILD the condition) and this check (to
# diff it against the graph) — so it can never drift from what is enforced.
#
# The graph side is grepped from the .tf sources, which deliberately INCLUDES
# count-disabled resources. A `terraform plan` under-enumerates: the app-deploy
# publisher assignments are guarded on `app_deploy_principal_object_id != ""` and
# the native-otlp module is count-guarded, so a plan taken while those guards are
# off omits roles a later plan will require — and an allowlist built from it
# fails closed mid-apply the first time a guard flips.
ALLOWLIST="${INFRA_DIR}/bootstrap/tf-managed-role-allowlist.tsv"
allowlist_drift=""
if [[ -f "${ALLOWLIST}" ]]; then
  graph_roles="$(grep -rhoE 'role_definition_name[[:space:]]*=[[:space:]]*"[^"]+"' \
      --include='*.tf' --exclude-dir='.terraform' --exclude-dir='node_modules' --exclude-dir='.nx' \
      "${INFRA_DIR}" 2>/dev/null \
    | sed -E 's/.*"([^"]+)"[[:space:]]*$/\1/' | sort -u)"
  allow_roles="$(awk -F'\t' '$0 !~ /^#/ && NF >= 2 && $1 != "" { print $1 }' "${ALLOWLIST}" | sort -u)"

  if [[ -z "${graph_roles}" ]]; then
    # Zero matches means the grep broke, not that the graph has no role
    # assignments — treat a silent zero as a failure, never as a pass.
    allowlist_drift+="no role_definition_name found anywhere in the Terraform graph — this check has stopped working (it must never pass by finding nothing)"$'\n'
  fi
  if [[ -z "${allow_roles}" ]]; then
    allowlist_drift+="the allowlist ${ALLOWLIST} parsed to ZERO roles (expected tab-separated '<role>\\t<guid|PENDING>' rows)"$'\n'
  fi

  missing_from_allowlist="$(comm -23 <(printf '%s\n' "${graph_roles}") <(printf '%s\n' "${allow_roles}") || true)"
  missing_from_graph="$(comm -13 <(printf '%s\n' "${graph_roles}") <(printf '%s\n' "${allow_roles}") || true)"
  if [[ -n "${missing_from_allowlist}" ]]; then
    allowlist_drift+="role(s) in the Terraform graph but NOT in ${ALLOWLIST} — the dev CI apply would be DENIED mid-run (AuthorizationFailed, partial state). Add them to the allowlist and RE-RUN apps/infrastructure/bootstrap/bootstrap.sh so the live ABAC condition is reconciled:"$'\n'"${missing_from_allowlist}"$'\n'
  fi
  if [[ -n "${missing_from_graph}" ]]; then
    allowlist_drift+="role(s) in ${ALLOWLIST} but NOT in the Terraform graph — the apply identity is permitted to grant a role nothing needs. Remove them and re-run bootstrap.sh:"$'\n'"${missing_from_graph}"$'\n'
  fi
else
  allowlist_drift="role allowlist not found: ${ALLOWLIST} (bootstrap.sh builds the apply identity's ABAC condition from it; without the file there is nothing to enforce)"
fi
check "Terraform-managed role allowlist matches the graph (names only — GUIDs are verified live by bootstrap.sh)" "${allowlist_drift%$'\n'}"

# --- CHECK 14. Role-assignment scope regression guard (MG-23 F14) ------------------
# The load-bearing invariant: no identity inside meatgeek-v2-dev-rg holds a role
# OUTSIDE it. The dev infra-apply identity is Contributor on that RG and nothing
# else, so a subscription-scoped (or foreign-RG-scoped) azurerm_role_assignment
# is not just over-broad — CI literally cannot apply it, and the tempting fix
# (widen the identity) would dissolve the boundary the MG-23 threat model rests
# on. Fail here instead, at PR time.
ra_scope_lines="$(
  find "${INFRA_DIR}" -type d \( -name '.terraform' -o -name 'node_modules' -o -name '.nx' \) -prune -o \
    -type f -name '*.tf' -print 2>/dev/null |
  while IFS= read -r tf_file; do
    awk -v f="${tf_file}" '
      /^[[:space:]]*resource[[:space:]]+"azurerm_role_assignment"/ { inblk = 1 }
      inblk && /^[[:space:]]*scope[[:space:]]*=/ { printf "%s:%d:%s\n", f, NR, $0 }
      inblk && /^}/ { inblk = 0 }
    ' "${tf_file}"
  done
)"
ra_scope_hits=""
if [[ -z "${ra_scope_lines}" ]]; then
  # As in check 13: finding nothing means the extractor broke. The graph has role
  # assignments; a scan that silently matches zero of them must not report pass.
  ra_scope_hits+="no azurerm_role_assignment scope lines found — this check has stopped working (it must never pass by finding nothing)"$'\n'
fi
# a) A subscription scope: /subscriptions/... with no /resourceGroups/ segment,
#    or a bare data.azurerm_subscription reference.
sub_scoped="$(printf '%s\n' "${ra_scope_lines}" \
  | grep -E '/subscriptions/|data\.azurerm_subscription' | grep -vE '/resourceGroups/' || true)"
[[ -n "${sub_scoped}" ]] && ra_scope_hits+="SUBSCRIPTION-scoped role assignment (the CI apply identity has no subscription-level permission, by design — F18):"$'\n'"${sub_scoped}"$'\n'
# b) A literal resource-group scope that is not the workload RG. An interpolated
#    name (${...}) is the env-derived workload RG and is allowed; the state RG
#    (meatgeek-v2-tfstate-rg) is deliberately NOT — it lives outside the boundary.
foreign_rg_literal="$(printf '%s\n' "${ra_scope_lines}" \
  | grep -E '/resourceGroups/' \
  | grep -vE '/resourceGroups/(\$\{|meatgeek-v2-(dev|prod)-rg)' || true)"
[[ -n "${foreign_rg_literal}" ]] && ra_scope_hits+="role assignment scoped to a resource group OTHER than the workload RG:"$'\n'"${foreign_rg_literal}"$'\n'
# c) A reference to a resource group resource other than azurerm_resource_group.main
#    (the workload RG this stack owns).
foreign_rg_ref="$(printf '%s\n' "${ra_scope_lines}" \
  | grep -E 'azurerm_resource_group\.[A-Za-z0-9_]+' \
  | grep -vE 'azurerm_resource_group\.main\b' || true)"
[[ -n "${foreign_rg_ref}" ]] && ra_scope_hits+="role assignment scoped to a resource group other than azurerm_resource_group.main:"$'\n'"${foreign_rg_ref}"$'\n'
check "no azurerm_role_assignment escapes the workload resource group (graph regression guard)" "${ra_scope_hits%$'\n'}"

# --- CHECK 15. Terraform tests are mock-provider / non-applying (MG-23) -------------
# The PR gate is credentialless (no identity, no id-token, no environment), and
# `terraform test` is the ONE thing it runs that could conceivably reach Azure.
# A real `provider` block would make the test authenticate; `command = apply`
# would make it PROVISION. Either turns the only PR-reachable infrastructure job
# into an Azure-reaching one. assert-credentialless.sh proves the job holds no
# credential at runtime; this proves the tests would not use one even if it did.
tftest_files="$(
  find "${INFRA_DIR}" -type d \( -name '.terraform' -o -name 'node_modules' -o -name '.nx' -o -name '.git' \) -prune -o \
    -type f -name '*.tftest.hcl' -print 2>/dev/null | sort
)"
tftest_hits=""
if [[ -z "${tftest_files}" ]]; then
  # Same fail-open logic as checks 13/14: matching nothing must never pass.
  tftest_hits+="no *.tftest.hcl files found under ${INFRA_DIR} — the credentialless PR gate would certify an EMPTY test set (this check must never pass by finding nothing)"$'\n'
else
  while IFS= read -r tf_test; do
    [[ -n "${tf_test}" ]] || continue
    # Strip comments before matching. monitoring_signals.tftest.hcl legitimately
    # DISCUSSES `command = apply` in a comment explaining why it is not used, and
    # a lexical guard that cannot tell code from prose would fail the committed
    # tree. Full-line and trailing `#`/`//` comments are removed; a `#` inside a
    # string literal is over-stripped, which is safe here (it can only mask a
    # violation in prose, never invent one).
    code="$(sed -e 's|^[[:space:]]*#.*$||' -e 's|[[:space:]]#.*$||' \
                -e 's|^[[:space:]]*//.*$||' -e 's|[[:space:]]//.*$||' "${tf_test}")"

    # a) A REAL top-level provider block. `mock_provider "..."` does not match
    #    (it starts with `mock_`), and a nested `providers = {` does not match
    #    (this requires whitespace then a quote after `provider`).
    real_provider="$(printf '%s\n' "${code}" | grep -nE '^[[:space:]]*provider[[:space:]]+"' || true)"
    [[ -n "${real_provider}" ]] && tftest_hits+="${tf_test}: declares a REAL provider block (tests must use mock_provider — a real provider authenticates to Azure):"$'\n'"${real_provider}"$'\n'

    # b) An APPLYING run block.
    applying="$(printf '%s\n' "${code}" | grep -nE 'command[[:space:]]*=[[:space:]]*apply' || true)"
    [[ -n "${applying}" ]] && tftest_hits+="${tf_test}: uses \`command = apply\` (tests must be non-applying — a PR must never provision):"$'\n'"${applying}"$'\n'

    # c) References an azurerm_/azapi_ resource without the matching mock_provider.
    #    One-directional on purpose: declaring a mock for a provider the file does
    #    not reference is harmless, referencing one with no mock is not.
    for prov in azurerm azapi; do
      if printf '%s\n' "${code}" | grep -qE "\b${prov}_[a-z0-9_]+" ; then
        if ! printf '%s\n' "${code}" | grep -qE "^[[:space:]]*mock_provider[[:space:]]+\"${prov}\"" ; then
          tftest_hits+="${tf_test}: references ${prov}_* resources but declares no \`mock_provider \"${prov}\"\` — the test would use a REAL ${prov} provider"$'\n'
        fi
      fi
    done
  done <<< "${tftest_files}"
fi
check "terraform tests are mock-provider and non-applying (credentialless PR gate)" "${tftest_hits%$'\n'}"

# --- CHECK 16. CI-invoked modules pin their providers (MG-39) ----------------------
# ci.yml's "Terraform module tests" step inits every module containing a
# *.tftest.hcl on a fresh runner. Two things make that init reproducible, and it
# needs BOTH: an explicit version constraint (so the resolver has a range) and a
# committed .terraform.lock.hcl (so it has the exact version + hashes inside that
# range). With neither, modules/iot-hub resolved azurerm to LATEST and picked up
# the breaking v5.0.1 the day it shipped — a red CI on an unchanged tree.
#
# The module list is derived from ${tftest_files} above, i.e. the SAME find on
# *.tftest.hcl that ci.yml uses, with the same `*/tests` -> parent folding. That
# coupling is the point: a module that starts carrying tests starts being gated
# here automatically, rather than waiting for someone to extend a hardcoded list.
#
# The folding lives in a top-level function rather than inline in the pipeline
# because bash 3.2 — /bin/bash on macOS, where this script is run by hand —
# mis-parses a `case` nested inside `$( … )`. Inlining it back reintroduces
# MG-42 finding F5: the substitution dies at parse time and `set -u` then aborts
# the script on the unbound variable, so this check never runs. ci.yml keeps the
# inline form legitimately; that file only ever runs on the runner's bash 5.
tftest_module_dir() {
  case "$1" in
    */tests) printf '%s\n' "${1%/tests}" ;;
    *) printf '%s\n' "$1" ;;
  esac
}

tftest_modules="$(
  printf '%s\n' "${tftest_files}" | grep -v '^$' | while IFS= read -r f; do
    tftest_module_dir "$(dirname "${f}")"
  done | sort -u
)"

# Providers a module actually uses, by local name — the prefix of every
# `resource "<prefix>_..."` / `data "<prefix>_..."` block. That prefix IS the
# provider local name Terraform resolves, so this needs no allowlist of provider
# names to stay current. The `terraform` builtin (data.terraform_remote_state) is
# excluded: it has no registry source and takes no version constraint.
module_providers_used() {
  grep -hoE '^[[:space:]]*(resource|data)[[:space:]]+"[a-z0-9]+_' "$1"/*.tf 2>/dev/null \
    | sed -E 's/.*"([a-z0-9]+)_$/\1/' | sort -u | grep -v '^terraform$' || true
}

# Providers the module CONSTRAINS: every required_providers entry that carries a
# `version =` line. A brace-depth-free state machine is enough because this repo's
# HCL is `terraform fmt`-checked earlier in the same job, so entries are always
# `name = {` ... `}` on their own lines. Written for POSIX awk (CI runners ship
# mawk, which has no 3-argument match()).
module_providers_constrained() {
  cat "$1"/*.tf 2>/dev/null | awk '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    { line = $0; sub(/#.*$/, "", line) }
    inrp == 0 { if (line ~ /required_providers[[:space:]]*\{/) inrp = 1; next }
    inentry == 0 {
      if (line ~ /^[[:space:]]*[A-Za-z0-9_-]+[[:space:]]*=[[:space:]]*\{/) {
        name = line; sub(/[[:space:]]*=.*$/, "", name); name = trim(name)
        inentry = 1; hasver = 0; next
      }
      if (line ~ /\}/) inrp = 0
      next
    }
    {
      if (line ~ /version[[:space:]]*=/) hasver = 1
      if (line ~ /^[[:space:]]*\}/) { if (hasver) print name; inentry = 0 }
    }
  ' | sort -u
}

# `git ls-files` is what distinguishes a COMMITTED lock from one a local
# `terraform init` just dropped in an ignored path — the exact regression a
# re-added .gitignore rule would cause. CI fails either way (an ignored file is
# not in the checkout at all), but tracking-awareness moves that failure to the
# author's machine. Skipped when INFRA_DIR is not inside a work tree (fixtures).
git_tracked=0
if command -v git >/dev/null 2>&1 && git -C "${INFRA_DIR}" rev-parse --is-inside-work-tree >/dev/null 2>&1; then
  git_tracked=1
fi

pin_hits=""
if [[ -z "${tftest_modules}" ]]; then
  # Same fail-open logic as checks 13/14/15: matching nothing must never pass.
  pin_hits+="no test-bearing module directories derived from *.tftest.hcl — this check has stopped working (it must never pass by finding nothing)"$'\n'
else
  while IFS= read -r mod; do
    [[ -n "${mod}" ]] || continue
    lock="${mod}/.terraform.lock.hcl"
    if [[ ! -f "${lock}" ]]; then
      pin_hits+="${mod}: CI-invoked (has *.tftest.hcl) but has NO committed .terraform.lock.hcl — ci.yml's \`terraform init -lockfile=readonly\` will fail, and without the lock a fresh runner resolves whatever the registry serves. Generate it from ${mod}: terraform init -backend=false && terraform providers lock -platform=linux_amd64 -platform=linux_arm64 -platform=darwin_arm64 -platform=darwin_amd64"$'\n'
    elif [[ "${git_tracked}" -eq 1 ]] && ! git -C "${INFRA_DIR}" ls-files --error-unmatch -- "${lock}" >/dev/null 2>&1; then
      pin_hits+="${lock}: present on disk but NOT tracked by git — it will not exist in the CI checkout, so the module still floats. \`git add\` it, and check .gitignore is not re-ignoring apps/infrastructure/modules/*/.terraform.lock.hcl"$'\n'
    fi

    constrained="$(module_providers_constrained "${mod}")"
    while IFS= read -r prov; do
      [[ -n "${prov}" ]] || continue
      if ! printf '%s\n' "${constrained}" | grep -qx "${prov}"; then
        pin_hits+="${mod}: uses ${prov}_* resources but declares no explicit \`${prov}\` version constraint in a required_providers block — a standalone init resolves it UNCONSTRAINED (this is how azurerm v5.0.1 landed). Add ${prov} with a version to the module's required_providers."$'\n'
      fi
    done <<< "$(module_providers_used "${mod}")"
  done <<< "${tftest_modules}"
fi
check "CI-invoked modules pin their providers (explicit constraint + committed lock)" "${pin_hits%$'\n'}"

# --- CHECK 17. IoT Hub routes replace with their endpoints (MG-48) -----------------
# One record per `azurerm_iothub_route` block: file, start line, resource label, the
# raw `endpoint_names` list, and the raw `replace_triggered_by` list. Comments are
# stripped first — the committed routes DISCUSS `endpoint_names` and
# `replace_triggered_by` in prose right next to the code, so a scan that cannot tell
# one from the other would read the explanation as the declaration.
#
# Empty list fields are emitted as "-" rather than left empty: `read` with IFS=tab
# collapses runs of tab (tab is IFS whitespace), so an empty endpoint_names field
# would silently shift replace_triggered_by into its place and the pairing would
# check itself. As with check 16's folding, this lives in a top-level function
# because bash 3.2 — /bin/bash on the operator's Mac — mis-parses quoted patterns
# inlined in `$( … )`.
iothub_route_blocks() {
  awk -v f="$1" '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    function dash(s) { s = trim(s); return (s == "" ? "-" : s) }
    function emit() {
      if (label != "") printf "%s\t%d\t%s\t%s\t%s\n", f, startline, label, dash(eps), dash(rtb)
      label = ""; eps = ""; rtb = ""; inroute = 0; ineps = 0; inrtb = 0
    }
    { line = $0; sub(/#.*$/, "", line) }
    line ~ /^[[:space:]]*resource[[:space:]]+"azurerm_iothub_route"[[:space:]]+"/ {
      emit()
      inroute = 1; startline = NR
      label = line
      sub(/^.*"azurerm_iothub_route"[[:space:]]+"/, "", label)
      sub(/".*$/, "", label)
      next
    }
    inroute == 0 { next }
    ineps == 1 { eps = eps " " line; if (line ~ /\]/) ineps = 0; next }
    inrtb == 1 { rtb = rtb " " line; if (line ~ /\]/) inrtb = 0; next }
    line ~ /endpoint_names[[:space:]]*=/ { eps = eps " " line; if (line !~ /\]/) ineps = 1; next }
    line ~ /replace_triggered_by[[:space:]]*=/ { rtb = rtb " " line; if (line !~ /\]/) inrtb = 1; next }
    line ~ /^\}/ { emit(); next }
    END { emit() }
  ' "$1"
}

# The endpoint RESOURCE addresses a list mentions — `azurerm_iothub_endpoint_<type>.<label>`.
# The trailing `.name` of an endpoint_names reference is not part of the address, so
# the two lists become directly comparable.
iothub_endpoint_refs() {
  printf '%s\n' "$1" | grep -oE 'azurerm_iothub_endpoint_[a-z0-9_]+\.[A-Za-z0-9_]+' | sort -u || true
}

route_records=""
while IFS= read -r tf_file; do
  [[ -n "${tf_file}" ]] || continue
  grep -q 'azurerm_iothub_route' "${tf_file}" 2>/dev/null || continue
  route_records+="$(iothub_route_blocks "${tf_file}")"$'\n'
done <<< "$(
  find "${INFRA_DIR}" -type d \( -name '.terraform' -o -name 'node_modules' -o -name '.nx' -o -name '.git' \) -prune -o \
    -type f -name '*.tf' -print 2>/dev/null | sort
)"
route_records="$(printf '%s' "${route_records}" | grep -v '^$' || true)"

route_replace_hits=""
if [[ -z "${route_records}" ]]; then
  # Same fail-open logic as checks 13/14/15/16: matching nothing must never pass. A
  # refactor that renames or relocates the routes must move this guard with them.
  route_replace_hits+="no azurerm_iothub_route resources found under ${INFRA_DIR} — this check has stopped working (it must never pass by finding nothing)"$'\n'
else
  while IFS=$'\t' read -r r_file r_line r_label r_eps r_rtb; do
    [[ -n "${r_label}" ]] || continue
    ep_refs="$(iothub_endpoint_refs "${r_eps}")"
    rtb_refs="$(iothub_endpoint_refs "${r_rtb}")"
    rtb_flat="$(printf '%s\n' "${rtb_refs}" | grep -v '^$' | tr '\n' ' ' || true)"
    rtb_flat="${rtb_flat% }"
    if [[ -z "${ep_refs}" ]]; then
      route_replace_hits+="${r_file}:${r_line}: azurerm_iothub_route.${r_label} names no azurerm_iothub_endpoint_* resource in endpoint_names, so its replace_triggered_by pairing cannot be verified — reference the endpoint resource, because Azure rejects deleting an endpoint a live route still points at (IH400111, the 2026-08-06 dev-apply outage)"$'\n'
      continue
    fi
    while IFS= read -r ep; do
      [[ -n "${ep}" ]] || continue
      if ! printf '%s\n' "${rtb_refs}" | grep -qxF "${ep}"; then
        if [[ -z "${rtb_flat}" ]]; then
          route_replace_hits+="${r_file}:${r_line}: azurerm_iothub_route.${r_label} routes to ${ep} but declares no lifecycle { replace_triggered_by = [${ep}] } — replacing that endpoint would leave this route pointing at it and Azure rejects the endpoint delete with IH400111, the failure that broke the dev apply on 2026-08-06"$'\n'
        else
          route_replace_hits+="${r_file}:${r_line}: azurerm_iothub_route.${r_label} routes to ${ep} but its replace_triggered_by names ${rtb_flat} instead — the route it actually guards is the wrong one, so replacing ${ep} still leaves this route pointing at it and Azure rejects the endpoint delete with IH400111, the failure that broke the dev apply on 2026-08-06"$'\n'
        fi
      fi
    done <<< "${ep_refs}"
  done <<< "${route_records}"
fi
check "IoT Hub routes are replaced with their endpoints (replace_triggered_by pairing)" "${route_replace_hits%$'\n'}"

# --- CHECK 18. Name-referenced parents are replaced with their children (MG-48) ----
# The general form of check 17. One record per `resource` block that reaches at
# least one parent through the parent's CONFIGURED `name`: file, start line, the
# child's own address, the space-joined list of parent addresses it reaches that
# way, and the raw `replace_triggered_by` list. See the header for the rule and
# the exclusion boundary.
#
# Comments are stripped FIRST. The committed HCL discusses `replace_triggered_by`
# and `account_name`/`iothub_name` in prose immediately beside the code — a scan
# that cannot tell one from the other would read the explanation as the
# declaration. Over-stripping a `#` inside a string literal is safe here: it can
# only mask a violation, never invent one.
#
# Block boundaries are the same assumption check 17 makes: a top-level block ends
# at a `}` in column 0, which `terraform fmt` (enforced earlier in the same CI
# job) guarantees. That is also what keeps `module` and `output` blocks out —
# neither opens a `resource` state, so their name references are never recorded.
#
# As with checks 16 and 17, the awk lives in a TOP-LEVEL function rather than
# inlined in a `$( … )`: bash 3.2.57 — /bin/bash on the operator's Mac, where
# this script is run by hand — mis-parses quoted patterns inside a command
# substitution, and under `set -u` the dead substitution then aborts the whole
# script (MG-42 finding F5). The awk itself is POSIX: CI runners ship mawk, which
# has no 3-argument match(), so the field/value split is done with sub() instead.
# Empty list fields are emitted as "-" — `read` with IFS=tab collapses runs of
# tab, so an empty field would silently shift the next one into its place and the
# pairing would end up checking itself.
name_ref_child_blocks() {
  awk -v f="$1" '
    function trim(s) { sub(/^[[:space:]]+/, "", s); sub(/[[:space:]]+$/, "", s); return s }
    function dash(s) { s = trim(s); return (s == "" ? "-" : s) }
    function emit() {
      if (label != "" && trim(parents) != "")
        printf "%s\t%d\t%s\t%s\t%s\n", f, startline, label, dash(parents), dash(rtb)
      label = ""; parents = ""; rtb = ""; inres = 0; inrtb = 0
    }
    { line = $0; sub(/#.*$/, "", line) }
    line ~ /^[[:space:]]*resource[[:space:]]+"[a-z][a-z0-9_]*"[[:space:]]+"/ {
      emit()
      inres = 1; startline = NR
      label = line
      sub(/^[[:space:]]*resource[[:space:]]+"/, "", label)
      sub(/"[[:space:]]+"/, ".", label)
      sub(/".*$/, "", label)
      next
    }
    inres == 0 { next }
    inrtb == 1 { rtb = rtb " " line; if (line ~ /\]/) inrtb = 0; next }
    line ~ /replace_triggered_by[[:space:]]*=/ { rtb = rtb " " line; if (line !~ /\]/) inrtb = 1; next }
    line ~ /^\}/ { emit(); next }
    line ~ /=/ {
      fld = line; sub(/[[:space:]]*=.*$/, "", fld); fld = trim(fld)
      val = line; sub(/^[^=]*=[[:space:]]*/, "", val); val = trim(val)
      # An argument whose NAME ends in _name and whose VALUE is exactly a
      # <type>.<label>.name reference. resource_group_name is excluded (see the
      # header). A data./module. reference has four dot-segments and cannot match
      # this pattern at all; var./local./each./self. are rejected by name below,
      # because none of them may appear in replace_triggered_by.
      if (fld !~ /^[A-Za-z0-9_]+_name$/) next
      if (fld == "resource_group_name") next
      if (val !~ /^[a-z][a-z0-9_]*\.[A-Za-z0-9_]+\.name$/) next
      first = val; sub(/\..*$/, "", first)
      if (first == "var" || first == "local" || first == "module" || first == "data" ||
          first == "each" || first == "self" || first == "count" || first == "path" ||
          first == "terraform") next
      addr = val; sub(/\.name$/, "", addr)
      if (index(" " parents " ", " " addr " ") == 0) parents = parents " " addr
      next
    }
    END { emit() }
  ' "$1"
}

# The managed-resource addresses a replace_triggered_by list mentions. The
# trailing `.name` of a reference is not part of the address, so the two sides
# become directly comparable.
hcl_resource_addrs() {
  printf '%s\n' "$1" | grep -oE '[a-z][a-z0-9_]*\.[A-Za-z0-9_]+' | sort -u || true
}

name_ref_records=""
while IFS= read -r tf_file; do
  [[ -n "${tf_file}" ]] || continue
  name_ref_records+="$(name_ref_child_blocks "${tf_file}")"$'\n'
done <<< "$(
  find "${INFRA_DIR}" -type d \( -name '.terraform' -o -name 'node_modules' -o -name '.nx' -o -name '.git' \) -prune -o \
    -type f -name '*.tf' -print 2>/dev/null | sort
)"
name_ref_records="$(printf '%s' "${name_ref_records}" | grep -v '^$' || true)"

name_replace_hits=""
name_ref_pairs=0
name_ref_children=0
if [[ -z "${name_ref_records}" ]]; then
  # Same fail-closed logic as checks 13/14/15/16/17: matching nothing must never
  # pass. This stack has 16 such pairs; a scan that finds none has stopped
  # working, and a silent pass here is exactly how the next account replacement
  # orphans its children again.
  name_replace_hits+="no '<something>_name = <managed resource>.<label>.name' reference found in any resource block under ${INFRA_DIR} — this check has stopped working (it must never pass by finding nothing)"$'\n'
else
  while IFS=$'\t' read -r n_file n_line n_child n_parents n_rtb; do
    [[ -n "${n_child}" ]] || continue
    [[ "${n_parents}" != "-" ]] || continue
    name_ref_children=$((name_ref_children + 1))
    rtb_addrs="$(hcl_resource_addrs "${n_rtb}")"
    rtb_flat="$(printf '%s\n' "${rtb_addrs}" | grep -v '^$' | tr '\n' ' ' || true)"
    rtb_flat="${rtb_flat% }"
    for n_parent in ${n_parents}; do
      name_ref_pairs=$((name_ref_pairs + 1))
      if ! printf '%s\n' "${rtb_addrs}" | grep -qxF "${n_parent}"; then
        if [[ -z "${rtb_flat}" ]]; then
          name_replace_hits+="${n_file}:${n_line}: ${n_child} reaches ${n_parent} by that parent's configured name but declares no lifecycle { replace_triggered_by = [${n_parent}] } — the name is a static literal, identical before and after, so Terraform would never plan ${n_child} for replacement while Azure destroys it with ${n_parent} anyway, leaving state listing a resource that no longer exists (MG-48: this is how meatgeek-v2-dev-db and its five containers became ghosts and the IoT Hub Cosmos endpoint create failed with IH400142)"$'\n'
        else
          name_replace_hits+="${n_file}:${n_line}: ${n_child} reaches ${n_parent} by that parent's configured name but its replace_triggered_by names ${rtb_flat} instead — the parent it actually guards is the wrong one, so replacing ${n_parent} still leaves ${n_child} unplanned in state while Azure destroys it (MG-48; add ${n_parent} to the list rather than swapping it in — a child may have more than one name-referenced parent)"$'\n'
        fi
      fi
    done
  done <<< "${name_ref_records}"
fi
# Print the discovered size so a pass is demonstrably non-vacuous rather than a
# scan that quietly matched nothing.
echo "  check 18: discovered ${name_ref_pairs} name-referenced (child, parent) pair(s) across ${name_ref_children} child resource(s)"
check "children reached by a parent's configured name are replaced with it (replace_triggered_by pairing)" "${name_replace_hits%$'\n'}"

echo
if [[ "${fail}" -ne 0 ]]; then
  echo "tf-static-checks: FAILED — fix the violations above." >&2
  exit 1
fi
echo "tf-static-checks: all checks passed."
exit 0
