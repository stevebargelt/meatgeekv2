#!/usr/bin/env bash
#
# tf-plan-secret-inspection.sh — FAIL-CLOSED plan/state secret inspection for the
# MeatGeek V2 Terraform stack (MG-24 red-fix, item 6).
#
# This is the AUTHORITATIVE pre-apply gate. Unlike the best-effort lexical scan
# in tf-static-checks.sh (which reads HCL) and the OLD README one-liner
# (`terraform show -json ... | grep ... || echo "ok"` — which ALWAYS exits 0 and
# so never actually blocks an apply), this walks the real planned VALUES and
# EXITS NONZERO on any violation. Run it BEFORE `terraform apply`; do not apply
# until it prints a clean result.
#
# WHAT IT DOES
#   1. Loads a `terraform show -json` document (from a file arg, a plan binary it
#      renders via `terraform show -json`, or stdin). Works on BOTH a PLAN doc and
#      a post-apply STATE doc — run it against BOTH (see the runbook).
#   2. Walks every resource across the root module and ALL nested child modules,
#      UNIONING three sources so no sink is missed: .planned_values (plan),
#      .values (state), and .resource_changes[].change.after (per-resource plan
#      deltas — where a computed / known-after value can first appear, and the
#      exact gap a planned_values-only scan left open). It ALSO reads every output
#      (.planned_values.outputs / .values.outputs / .output_changes[].after). It
#      reads VALUES, not field NAMES — the app_setting KEY
#      `APPLICATIONINSIGHTS_CONNECTION_STRING` is never itself a finding; only the
#      string it is bound to is inspected. That NAME-vs-VALUE distinction is the
#      whole point: a setting can be *named* like a secret and hold a non-secret
#      endpoint, or be named innocuously and hold a live key.
#      LIMIT: .resource_changes[].change.after_unknown values are unknown until
#      apply and cannot be inspected pre-apply — hence the required post-apply
#      STATE run, where they are concrete.
#   3. Inspects two sinks where a credential VALUE would escape into state and be
#      readable by anyone with state access:
#         - Function App / Web App / App Service `app_settings` maps
#         - root module outputs
#   4. Classifies each VALUE. A value is a CREDENTIAL if it carries a
#      connection-string / SAS / account-key / access-key / instrumentation-key
#      marker (see CRED_MARKER_RE). Every credential VALUE is a VIOLATION EXCEPT
#      the single OPERATOR-ACCEPTED App Insights residual:
#         the FULL App Insights connection string (InstrumentationKey=...;
#         IngestionEndpoint=...) in a Function App app_setting — allowed ONLY when
#         the plan's azurerm_application_insights resource sets
#         local_authentication_disabled = true, which forces AAD-only ingestion so
#         the embedded instrumentation key CANNOT authenticate (MG-24 item 2 / the
#         ADR). The AI connection string as an OUTPUT is never accepted (an output
#         is an export surface, not the telemetry sink), and the AI conn string in
#         app_settings WITHOUT local auth disabled is a VIOLATION — that is the
#         coupled invariant this gate enforces.
#   5. Exits 1 on ANY violation (printing every offending path + why), or on ANY
#      operational failure (no jq, unparseable JSON, no input) — fail-closed: an
#      inspection that cannot run must NOT report success. Exits 0 only when the
#      inspection ran to completion and found nothing prohibited.
#
# USAGE
#   tf-plan-secret-inspection.sh <plan.json>     # a `terraform show -json` doc
#   tf-plan-secret-inspection.sh <tfplan>        # a plan binary (needs terraform)
#   terraform show -json tfplan | tf-plan-secret-inspection.sh   # via stdin
#   tf-plan-secret-inspection.sh --json <file>   # force JSON interpretation
#
set -uo pipefail

die() { echo "tf-plan-secret-inspection: FATAL: $*" >&2; exit 1; }   # fail-closed

command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"

# --- 1. Load the plan JSON --------------------------------------------------
SRC=""            # human label for messages
JSON=""
force_json=0
if [[ "${1:-}" == "--json" ]]; then
  force_json=1
  shift
fi

read_input() {
  local arg="${1:-}"
  if [[ -z "${arg}" || "${arg}" == "-" ]]; then
    SRC="stdin"
    cat
    return
  fi
  [[ -f "${arg}" ]] || die "input not found: ${arg}"
  SRC="${arg}"
  # A `terraform show -json` document is JSON; a plan binary is not. If the file
  # already parses as JSON (or the caller forced --json), use it directly.
  # Otherwise treat it as a plan binary and render it with terraform.
  if [[ "${force_json}" -eq 1 ]] || jq -e . "${arg}" >/dev/null 2>&1; then
    cat "${arg}"
    return
  fi
  command -v terraform >/dev/null 2>&1 || \
    die "input '${arg}' is not JSON and terraform is not on PATH to render it"
  terraform show -json "${arg}" 2>/dev/null || \
    die "terraform show -json failed on plan binary: ${arg}"
}

# read_input runs in a command substitution (a subshell); its die() exits that
# subshell with status 1, which the substitution propagates here. Catch that so
# we surface ONE fatal and stay fail-closed rather than dying twice.
if [[ -z "${1:-}" || "${1:-}" == "-" ]]; then SRC="stdin"; else SRC="${1}"; fi
if ! JSON="$(read_input "${1:-}")"; then
  exit 1
fi
[[ -n "${JSON}" ]] || die "no plan input (empty ${SRC:-input})"
echo "${JSON}" | jq -e . >/dev/null 2>&1 || die "input is not valid JSON (${SRC})"

# --- 2. Normalize the resource + output universe ----------------------------
# A `terraform show -json` document differs by mode, and a credential VALUE can
# surface in a DIFFERENT place depending on which:
#   * a PLAN doc carries proposed state under .planned_values AND the per-resource
#     deltas under .resource_changes[].change.after — where a COMPUTED /
#     known-after-config value that is NOT yet materialized in planned_values can
#     first appear (the exact gap the old planned_values-only scan missed);
#   * a STATE doc (`terraform show -json` of applied state) carries everything
#     under .values.
# We UNION all three so a secret VALUE cannot hide in a sink we didn't read.
#   NOTE: .resource_changes[].change.after_unknown marks values still unknown until
#   apply — they cannot be inspected pre-apply. That residual blind spot is exactly
#   why the runbook ALSO requires running this gate against the POST-APPLY
#   `terraform show -json` STATE, where those values are concrete.
RESOURCES="$(echo "${JSON}" | jq -c '
  def modtree: recurse(.child_modules[]?) | .resources[]?;
  [
    (.planned_values.root_module // empty | modtree),
    (.values.root_module // empty | modtree),
    (.resource_changes[]? | {type: .type, address: .address, values: (.change.after // {})})
  ]
' 2>/dev/null || echo '[]')"

# Is telemetry local auth disabled (AAD-only) on EVERY App Insights resource? If
# any AI resource leaves local auth enabled, the ikey-in-app_settings residual is
# NOT safe and must be rejected. `all` over an empty set is true, so also require
# at least one AI resource before treating the residual as accepted. select(. !=
# null) keeps a genuine `false` (which jq's `//` would wrongly drop).
ai_count="$(echo "${RESOURCES}" | jq '[.[] | select(.type=="azurerm_application_insights")] | length')"
ai_local_auth_disabled="$(echo "${RESOURCES}" | jq '[.[] | select(.type=="azurerm_application_insights") | .values.local_authentication_disabled | select(. != null)] | (length > 0) and all(. == true)')"

# The AI resource's OWN computed connection_string / instrumentation_key living in
# its resource block is the inherent-in-state residual (a TF-managed resource
# always stores its own computed attributes). We do NOT scan those resource
# attributes; we scan the SINKS (app_settings / outputs). Collect the ikey values
# so a bare instrumentation key copied verbatim into a sink can still be caught.
# (Pre-apply the ikey may be known-after-apply/unknown; then this list is empty —
# another reason the post-apply STATE run is required.)
ai_ikeys="$(echo "${RESOURCES}" | jq -r '[.[] | select(.type=="azurerm_application_insights") | .values.instrumentation_key] | map(select(. != null and . != "")) | unique | .[]' 2>/dev/null || true)"

# --- 3. Collect the sink VALUES (app_settings + outputs) as TSV --------------
# Each line: <sink-kind>\t<address/path>\t<value>. We emit the VALUE side only.
# sort -u dedups identical rows the planned_values/resource_changes union produces.
app_setting_rows="$(echo "${RESOURCES}" | jq -r '
  .[]
  | select(.type | test("function_app|web_app|app_service"))
  | . as $r
  | ($r.values.app_settings // {})
  | to_entries[]
  | ["app_setting", ($r.address + " :: app_settings[\"" + .key + "\"]"), (.value | tostring)]
  | @tsv
' 2>/dev/null | sort -u || true)"

# Outputs live under different keys by mode: .planned_values.outputs (plan),
# .values.outputs (state), and .output_changes[].after (plan deltas). Union all.
output_rows="$(echo "${JSON}" | jq -r '
  (
    ((.planned_values.outputs // {}) | to_entries[] | {k: .key, v: .value.value}),
    ((.values.outputs // {})         | to_entries[] | {k: .key, v: .value.value}),
    ((.output_changes // {})         | to_entries[] | {k: .key, v: .value.after})
  )
  | ["output", ("output." + .k), (.v | tostring)]
  | @tsv
' 2>/dev/null | sort -u || true)"

# --- 4. Classify every collected VALUE --------------------------------------
# CREDENTIAL markers that appear INSIDE a secret VALUE (right-hand side). These
# are the standard Azure connection-string / SAS / key delimiters. A non-secret
# endpoint value (https://x.service.signalr.net, sb://ns.servicebus.windows.net
# WITHOUT a SharedAccessKey, an accountEndpoint URL) does NOT match, so the
# identity-based `__serviceUri` / `__accountEndpoint` / `__fullyQualifiedNamespace`
# settings pass. This is deliberately about the VALUE, not the setting NAME.
CRED_MARKER_RE='(InstrumentationKey|AccountKey|SharedAccessKey|SharedAccessKeyName|AccessKey|AccountEndpoint=.*AccountKey|Password|PrimaryKey|SecondaryKey|primary_key|secondary_key|primaryKey|secondaryKey)='
# The App Insights connection string is uniquely identifiable: it carries BOTH an
# InstrumentationKey and an IngestionEndpoint segment.
AI_CONNSTR_RE='InstrumentationKey=.*IngestionEndpoint=|IngestionEndpoint=.*InstrumentationKey='

violations=0
report() {
  # report <sink-kind> <path> <reason>
  echo "  ✗ VIOLATION [$1] $2" >&2
  echo "        reason: $3" >&2
  violations=$((violations + 1))
}

inspect_rows() {
  # Read TSV rows on stdin: kind \t path \t value
  local kind path value
  while IFS=$'\t' read -r kind path value; do
    [[ -z "${kind}" ]] && continue

    # Bare instrumentation key (the AI resource's own ikey GUID) copied verbatim
    # into a sink. The ADR permits the ikey ONLY embedded in the full conn string
    # under local-auth-disabled; a bare ikey in a sink is prohibited regardless.
    if [[ -n "${ai_ikeys}" ]]; then
      while IFS= read -r ik; do
        [[ -z "${ik}" ]] && continue
        if [[ "${value}" == "${ik}" ]]; then
          report "${kind}" "${path}" "bare App Insights instrumentation key copied into a ${kind} value (permitted only embedded in the full conn string under local-auth-disabled)"
          continue 2
        fi
      done <<< "${ai_ikeys}"
    fi

    # Does this VALUE look like a credential at all?
    if ! echo "${value}" | grep -qE "${CRED_MARKER_RE}"; then
      continue   # non-secret value (endpoint / URI / plain string) — fine
    fi

    # It is a credential value. The ONLY accepted credential is the full App
    # Insights connection string in an app_setting, under local-auth-disabled.
    if echo "${value}" | grep -qE "${AI_CONNSTR_RE}"; then
      if [[ "${kind}" == "app_setting" && "${ai_local_auth_disabled}" == "true" ]]; then
        echo "  · accepted App Insights residual (ikey non-authenticating; local_authentication_disabled=true): ${path}"
        continue
      fi
      if [[ "${kind}" != "app_setting" ]]; then
        report "${kind}" "${path}" "App Insights connection string exported as an ${kind} (export surface — never accepted, even under local-auth-disabled)"
        continue
      fi
      # app_setting but local auth NOT disabled → the coupled invariant is broken.
      report "${kind}" "${path}" "full App Insights connection string (InstrumentationKey present) in app_settings WITHOUT local_authentication_disabled=true on azurerm_application_insights — the embedded ikey could authenticate ingestion (MG-24 item 2 invariant violated; ai_count=${ai_count})"
      continue
    fi

    # Any other credential value (Cosmos/Storage/Event Hub/SignalR/SAS/etc.).
    report "${kind}" "${path}" "prohibited credential VALUE (connection string / SAS / access|account|primary key) reached a ${kind}"
  done
}

echo "tf-plan-secret-inspection: inspecting ${SRC} (App Insights resources: ${ai_count}, local_authentication_disabled(all)=${ai_local_auth_disabled})"

# Feed both sink sets through the classifier. Process substitution (not a pipe)
# keeps inspect_rows in THIS shell so its violation counter survives. printf
# keeps empty sets harmless.
inspect_rows < <({ printf '%s\n' "${app_setting_rows}"; printf '%s\n' "${output_rows}"; } | grep -v '^[[:space:]]*$')

echo
if [[ "${violations}" -ne 0 ]]; then
  echo "tf-plan-secret-inspection: FAILED — ${violations} prohibited credential VALUE(s) in plan/state. DO NOT APPLY." >&2
  exit 1
fi
echo "tf-plan-secret-inspection: PASS — no prohibited credential VALUE reached app_settings or outputs."
exit 0
