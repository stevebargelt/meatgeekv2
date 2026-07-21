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
# PORTABILITY (MG-24 corrective) — this is a SECURITY property, not a style note.
# The gate is written to strict POSIX sh so it runs IDENTICALLY under macOS's
# default bash 3.2, modern bash 5, and dash. It uses NO bash-4-only features
# (no ${v,,}/${v^^} case modification, no associative arrays), NO here-strings
# (<<<), and NO process substitution. Those constructs either raise a
# `bad substitution` / syntax error on bash 3.2 or are silently unavailable on
# dash — and a gate that ERRORS on the operator's shell while still reaching a
# PASS is FAIL-OPEN. The earlier `${1,,}` in ikey_is_managed did exactly that:
# on a shell without bash-4 case modification the managed-ikey comparison broke,
# and a FOREIGN/lookalike connection string slipped through as accepted. Every
# accept path below is now reachable ONLY after the comparison provably ran.
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
#         BOTH (a) the plan's azurerm_application_insights resource sets
#         local_authentication_disabled = true (forcing AAD-only ingestion so the
#         embedded instrumentation key CANNOT authenticate) AND (b) the embedded
#         InstrumentationKey is one of THIS plan/state's OWN managed App Insights
#         ikeys (ai_ikeys). The exception is bound to the managed resource: a
#         lookalike conn string that carries a FOREIGN ikey is a VIOLATION, not the
#         residual (MG-24 item 2 / the ADR). The AI connection string as an OUTPUT is never accepted (an output
#         is an export surface, not the telemetry sink), and the AI conn string in
#         app_settings WITHOUT local auth disabled is a VIOLATION — that is the
#         coupled invariant this gate enforces.
#   5. Exits 1 on ANY violation (printing every offending path + why), or on ANY
#      operational failure (no jq, unparseable JSON, no input, an inconclusive or
#      errored managed-ikey comparison) — fail-closed: an inspection that cannot
#      run, or a residual it cannot PROVE is the managed one, must NOT report
#      success. Exits 0 only when the inspection ran to completion and every
#      credential value was either provably the accepted managed residual or
#      absent.
#
# USAGE
#   tf-plan-secret-inspection.sh <plan.json>     # a `terraform show -json` doc
#   tf-plan-secret-inspection.sh <tfplan>        # a plan binary (needs terraform)
#   terraform show -json tfplan | tf-plan-secret-inspection.sh   # via stdin
#   tf-plan-secret-inspection.sh --json <file>   # force JSON interpretation
#
set -u
# pipefail is a bash/ksh feature; dash lacks it and would print "Illegal option
# -o pipefail" and skew the exit code. Enable it only when the running shell
# supports it. Correctness never DEPENDS on pipefail here — every pipeline below
# begins with echo/printf, which cannot fail — so this is defense in depth, not a
# load-bearing option (and probing it in a subshell keeps dash silent + clean).
if (set -o pipefail) 2>/dev/null; then set -o pipefail; fi

TAB="$(printf '\t')"

die() { echo "tf-plan-secret-inspection: FATAL: $*" >&2; exit 1; }   # fail-closed

command -v jq >/dev/null 2>&1 || die "jq is required but not on PATH"

# Portable lowercase (bash-4's ${v,,} is unavailable on bash 3.2 / dash).
lc() { printf '%s' "$1" | tr '[:upper:]' '[:lower:]'; }

# --- 1. Load the plan JSON --------------------------------------------------
SRC=""            # human label for messages
JSON=""
force_json=0
if [ "${1:-}" = "--json" ]; then
  force_json=1
  shift
fi

read_input() {
  local arg
  arg="${1:-}"
  if [ -z "${arg}" ] || [ "${arg}" = "-" ]; then
    SRC="stdin"
    cat
    return
  fi
  [ -f "${arg}" ] || die "input not found: ${arg}"
  SRC="${arg}"
  # A `terraform show -json` document is JSON; a plan binary is not. If the file
  # already parses as JSON (or the caller forced --json), use it directly.
  # Otherwise treat it as a plan binary and render it with terraform.
  if [ "${force_json}" -eq 1 ] || jq -e . "${arg}" >/dev/null 2>&1; then
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
if [ -z "${1:-}" ] || [ "${1:-}" = "-" ]; then SRC="stdin"; else SRC="${1}"; fi
if ! JSON="$(read_input "${1:-}")"; then
  exit 1
fi
[ -n "${JSON}" ] || die "no plan input (empty ${SRC:-input})"
printf '%s\n' "${JSON}" | jq -e . >/dev/null 2>&1 || die "input is not valid JSON (${SRC})"

# --- 1b. Fail-closed STRUCTURAL validation ----------------------------------
# Valid JSON is NOT enough: '{}', '[]', '{"foo":"bar"}' all parse, collect zero
# resources, walk nothing, and would trip a vacuous PASS — the fail-OPEN hole.
# A PASS must be reachable ONLY after genuinely walking a recognizable
# `terraform show -json` PLAN or STATE document. So before trusting anything,
# require the shape of one: a top-level JSON OBJECT that carries a format_version
# AND at least one recognized resource container
# (.planned_values.root_module | .values.root_module | .resource_changes).
# Absent that shape, or if the shape probe itself errors, we FAIL CLOSED.
top_type="$(printf '%s\n' "${JSON}" | jq -r 'type' 2>/dev/null || true)"
[ "${top_type}" = "object" ] || \
  die "cannot inspect: unrecognized/empty terraform JSON (${SRC}) — top-level is '${top_type:-unknown}', expected a 'terraform show -json' object"
has_shape="$(printf '%s\n' "${JSON}" | jq -r '
  (has("format_version"))
  and (
    (.planned_values.root_module? != null)
    or (.values.root_module? != null)
    or (.resource_changes? != null)
  )
' 2>/dev/null || echo "error")"
[ "${has_shape}" = "true" ] || \
  die "cannot inspect: unrecognized/empty terraform JSON (${SRC}) — missing format_version and/or planned_values.root_module / values.root_module / resource_changes; refusing to report PASS on a document that is not a recognizable terraform plan or state"

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
# A jq collection error here means we cannot enumerate the resource universe —
# that is an inspection that could not run, so FAIL CLOSED (die), never fall back
# to an empty `[]` (which would silently walk nothing and PASS).
RESOURCES="$(printf '%s\n' "${JSON}" | jq -c '
  def modtree: recurse(.child_modules[]?) | .resources[]?;
  [
    (.planned_values.root_module // empty | modtree),
    (.values.root_module // empty | modtree),
    (.resource_changes[]? | {type: .type, address: .address, values: (.change.after // {})})
  ]
' 2>/dev/null)" || die "cannot inspect: failed to collect the resource universe from ${SRC}"

# Is telemetry local auth disabled (AAD-only) on EVERY App Insights resource? If
# any AI resource leaves local auth enabled, the ikey-in-app_settings residual is
# NOT safe and must be rejected. `all` over an empty set is true, so also require
# at least one AI resource before treating the residual as accepted. select(. !=
# null) keeps a genuine `false` (which jq's `//` would wrongly drop).
ai_count="$(printf '%s\n' "${RESOURCES}" | jq '[.[] | select(.type=="azurerm_application_insights")] | length')"
ai_local_auth_disabled="$(printf '%s\n' "${RESOURCES}" | jq '[.[] | select(.type=="azurerm_application_insights") | .values.local_authentication_disabled | select(. != null)] | (length > 0) and all(. == true)')"

# The AI resource's OWN computed connection_string / instrumentation_key living in
# its resource block is the inherent-in-state residual (a TF-managed resource
# always stores its own computed attributes). We do NOT credential-scan the raw
# attribute VALUE (a TF-managed AI always carries it, so that would always trip);
# instead App Insights is folded into the data-service local-auth enforcement in
# --- 2b below, so the inherent residual is accepted ONLY when this AI resource
# disables local auth (identical treatment to Cosmos/Storage/SignalR/Event Hubs).
# Separately we scan the SINKS (app_settings / outputs). Collect the ikey values
# so a bare instrumentation key copied verbatim into a sink can still be caught.
# (Pre-apply the ikey may be known-after-apply/unknown; then this list is empty —
# another reason the post-apply STATE run is required.)
ai_ikeys="$(printf '%s\n' "${RESOURCES}" | jq -r '[.[] | select(.type=="azurerm_application_insights") | .values.instrumentation_key] | map(select(. != null and . != "")) | unique | .[]' 2>/dev/null || true)"

# --- 2b. Collect the INHERENT-KEY data-service resources ---------------------
# Cosmos DB, Storage, SignalR, the Event Hubs namespace, App Insights, and IoT Hub
# each store their OWN computed key / connection-string / instrumentation-key
# attributes in state (primary_key, connection_strings, primary_access_key, the
# namespace's auto-created RootManageSharedAccessKey, shared_access_policy[].primary_key,
# the App Insights instrumentation_key / connection_string …) — a TF-managed
# resource ALWAYS persists its computed attributes, and there is no argument that
# suppresses them. Unlike a sink, these are inherent. They are a
# NON-authenticating residual ONLY when local/key auth is DISABLED on the
# resource (so the in-state key cannot authenticate). If local auth is left
# ENABLED, that in-state key IS a live credential -> VIOLATION. App Insights is
# enforced here IDENTICALLY to the other data services: its inherent
# ikey/connection-string residual is accepted ONLY when THIS specific AI resource
# sets local_authentication_disabled=true (else VIOLATION). The disable-flag
# differs per service:
#     azurerm_cosmosdb_account     -> local_authentication_disabled == true
#     azurerm_storage_account      -> shared_access_key_enabled     == false
#     azurerm_signalr_service      -> local_auth_enabled            == false
#     azurerm_eventhub_namespace   -> local_authentication_enabled  == false
#     azurerm_application_insights -> local_authentication_disabled == true
# IoT Hub is the acknowledged EXCEPTION (devices/data-pusher/device-controller
# authenticate with SAS keys, so key auth must stay on): its key attributes are
# accepted WITH A NOTE, mitigated by restricted state access (MG-24 ADR).
# We emit one row per DISTINCT resource address: <type>\t<address>\t<disabled>.
# group_by/any UNIONs the planned_values and resource_changes sources so a flag
# known in either proves the residual safe. A null/unknown flag yields
# disabled=false -> fail-closed VIOLATION (we refuse to accept a residual we
# cannot PROVE is inert). A jq collection error here is an inspection that could
# not run -> die (fail-closed), never an empty set that walks nothing.
data_service_rows="$(printf '%s\n' "${RESOURCES}" | jq -r '
  [ .[]
    | select(.type=="azurerm_cosmosdb_account"
          or .type=="azurerm_storage_account"
          or .type=="azurerm_signalr_service"
          or .type=="azurerm_eventhub_namespace"
          or .type=="azurerm_application_insights"
          or .type=="azurerm_iothub")
    | { type: .type,
        address: .address,
        disabled: (
          if   .type=="azurerm_cosmosdb_account"     then (.values.local_authentication_disabled == true)
          elif .type=="azurerm_storage_account"      then (.values.shared_access_key_enabled == false)
          elif .type=="azurerm_signalr_service"      then (.values.local_auth_enabled == false)
          elif .type=="azurerm_eventhub_namespace"   then (.values.local_authentication_enabled == false)
          elif .type=="azurerm_application_insights" then (.values.local_authentication_disabled == true)
          else false end)
      }
  ]
  | group_by(.address)
  | map({ type: (.[0].type), address: (.[0].address), disabled: (map(.disabled) | any) })
  | .[]
  | [ .type, .address, (.disabled | tostring) ]
  | @tsv
' 2>/dev/null)" || die "cannot inspect: failed to collect the data-service resource universe from ${SRC}"

# --- 3. Collect the sink VALUES (app_settings + outputs) as TSV --------------
# Each line: <sink-kind>\t<address/path>\t<value>. We emit the VALUE side only.
# sort -u dedups identical rows the planned_values/resource_changes union produces.
# Fail-closed like the data-service universe above: a jq FAILURE (malformed doc,
# broken filter) must die, NOT be swallowed by `|| true` into an empty set that
# walks nothing and PASSes. jq is the last command in this command substitution,
# so `$(...)` carries jq's exit status regardless of pipefail — capture it here,
# then dedup separately (a jq that succeeds with no matching app_settings is a
# legitimate empty result and still proceeds).
app_setting_rows="$(printf '%s\n' "${RESOURCES}" | jq -r '
  .[]
  | select(.type | test("function_app|web_app|app_service"))
  | . as $r
  | ($r.values.app_settings // {})
  | to_entries[]
  | ["app_setting", ($r.address + " :: app_settings[\"" + .key + "\"]"), (.value | tostring)]
  | @tsv
' 2>/dev/null)" || die "cannot inspect: failed to collect Function App / Web App / App Service app_settings sink values from ${SRC}"
app_setting_rows="$(printf '%s\n' "${app_setting_rows}" | sort -u)"

# Outputs live under different keys by mode: .planned_values.outputs (plan),
# .values.outputs (state), and .output_changes[].after (plan deltas). Union all.
# Same fail-closed discipline: jq failure dies, an empty output set proceeds.
output_rows="$(printf '%s\n' "${JSON}" | jq -r '
  (
    ((.planned_values.outputs // {}) | to_entries[] | {k: .key, v: .value.value}),
    ((.values.outputs // {})         | to_entries[] | {k: .key, v: .value.value}),
    ((.output_changes // {})         | to_entries[] | {k: .key, v: .value.after})
  )
  | ["output", ("output." + .k), (.v | tostring)]
  | @tsv
' 2>/dev/null)" || die "cannot inspect: failed to collect root/output sink values from ${SRC}"
output_rows="$(printf '%s\n' "${output_rows}" | sort -u)"

# --- 4. Classify every collected VALUE --------------------------------------
# CREDENTIAL markers that appear INSIDE a secret VALUE (right-hand side). These
# are the standard Azure connection-string / SAS / key delimiters. A non-secret
# endpoint value (https://x.service.signalr.net, sb://ns.servicebus.windows.net
# WITHOUT a SharedAccessKey, an accountEndpoint URL) does NOT match, so the
# identity-based `__serviceUri` / `__accountEndpoint` / `__fullyQualifiedNamespace`
# settings pass. This is deliberately about the VALUE, not the setting NAME.
#
# SCOPE — this marker set is a BEST-EFFORT REGRESSION GUARD for the COMMON
# credential forms (Azure connection strings, storage keys, SAS tokens), not an
# exhaustive adversarial barrier: a sufficiently novel or obfuscated encoding can
# still evade a lexical match. The AUTHORITATIVE defenses are the identity-based
# design (no secrets in state BY CONSTRUCTION — managed identity / RBAC, no keys
# minted into app_settings or outputs) and HUMAN plan review before apply. This
# gate exists to catch the accidental reintroduction of a known credential shape,
# and so it errs toward catching more forms (case-insensitive, whitespace- and
# SAS-tolerant) rather than fewer.
#
# Each key marker tolerates OPTIONAL WHITESPACE before '=' ("AccountKey = SECRET"
# with spaces is just as live a secret as "AccountKey=SECRET"), matched
# case-INSENSITIVELY below (grep -qiE). SAS tokens are covered by two forms: the
# signature query parameter '[?&]sig=' (…&sig=<base64>) and the classic
# 'SharedAccessSignature=' connection-string field — alongside the storage
# 'SharedAccessKey' / 'SharedAccessKeyName' account-key fields.
CRED_MARKER_RE='(InstrumentationKey|AccountKey|SharedAccessKeyName|SharedAccessKey|SharedAccessSignature|AccessKey|Password|PrimaryKey|SecondaryKey|primary_key|secondary_key|primaryKey|secondaryKey)[[:space:]]*=|[?&][[:space:]]*sig[[:space:]]*='
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

# Is <ikey> one of the plan/state's OWN azurerm_application_insights
# instrumentation_key values (ai_ikeys)? The accepted-residual exception is bound
# to the MANAGED resource: only the full conn string whose embedded ikey belongs
# to a TF-managed App Insights is safe under local-auth-disabled. A lookalike
# conn string carrying a FOREIGN ikey is NOT the residual — it is a leak. GUID
# comparison is case-insensitive. An EMPTY needle (extraction failed) or empty
# ai_ikeys returns 1 (not managed) — so the caller treats it as a VIOLATION.
# The membership loop is a for-over-newlines (NO here-string), so it runs in THIS
# shell on bash 3.2 / bash 5 / dash alike.
ikey_is_managed() {
  local needle ik oldifs
  needle="$(lc "${1:-}")"
  [ -z "${needle}" ] && return 1
  [ -z "${ai_ikeys}" ] && return 1
  oldifs="${IFS}"
  IFS='
'
  set -f
  for ik in ${ai_ikeys}; do
    [ -z "${ik}" ] && continue
    if [ "${needle}" = "$(lc "${ik}")" ]; then
      IFS="${oldifs}"; set +f; return 0
    fi
  done
  IFS="${oldifs}"; set +f
  return 1
}

# Does a sink VALUE exactly equal one of the bare managed ikey GUIDs? (A bare
# ikey copied verbatim into a sink — prohibited regardless of local-auth state.)
value_is_bare_ikey() {
  local v ik oldifs
  v="$1"
  [ -z "${ai_ikeys}" ] && return 1
  oldifs="${IFS}"
  IFS='
'
  set -f
  for ik in ${ai_ikeys}; do
    [ -z "${ik}" ] && continue
    if [ "${v}" = "${ik}" ]; then
      IFS="${oldifs}"; set +f; return 0
    fi
  done
  IFS="${oldifs}"; set +f
  return 1
}

inspect_rows() {
  # Read TSV rows on stdin: kind \t path \t value. Called with `< file`
  # redirection (NOT a pipe / process substitution), so it runs in THIS shell and
  # the `violations` counter that report() bumps survives.
  local kind path value embedded_ikey
  while IFS="${TAB}" read -r kind path value; do
    [ -z "${kind}" ] && continue

    # Bare instrumentation key (the AI resource's own ikey GUID) copied verbatim
    # into a sink. The ADR permits the ikey ONLY embedded in the full conn string
    # under local-auth-disabled; a bare ikey in a sink is prohibited regardless.
    if value_is_bare_ikey "${value}"; then
      report "${kind}" "${path}" "bare App Insights instrumentation key copied into a ${kind} value (permitted only embedded in the full conn string under local-auth-disabled)"
      continue
    fi

    # Does this VALUE look like a credential at all? Match CASE-INSENSITIVELY:
    # Azure honors connection-string keywords regardless of case, so a lowercased
    # or mixed-case `accountkey=` / `AcCountKey=` / `accountendpoint=…;accountkey=`
    # is just as live a secret as the canonical form. A case-SENSITIVE match here
    # was a gate bypass — the exact hole this closes.
    if ! printf '%s\n' "${value}" | grep -qiE "${CRED_MARKER_RE}"; then
      continue   # non-secret value (endpoint / URI / plain string) — fine
    fi

    # It is a credential value. The ONLY accepted credential is the full App
    # Insights connection string in an app_setting, under local-auth-disabled.
    # Case-insensitive here too so a mixed-case AI conn string still routes to the
    # managed-ikey binding below rather than the generic-credential reject.
    if printf '%s\n' "${value}" | grep -qiE "${AI_CONNSTR_RE}"; then
      if [ "${kind}" = "app_setting" ] && [ "${ai_local_auth_disabled}" = "true" ]; then
        # The exception is bound to the MANAGED resource: the embedded
        # InstrumentationKey MUST be one of this plan/state's own App Insights
        # ikeys. FAIL CLOSED here — a foreign/attacker conn string that merely
        # LOOKS like the AI shape (InstrumentationKey=…;IngestionEndpoint=…) but
        # carries a different ikey, OR an extraction that yields no ikey at all,
        # is a VIOLATION, not the accepted residual. Accept ONLY when the ikey is
        # non-empty AND provably managed.
        embedded_ikey="$(printf '%s' "${value}" | grep -oiE 'InstrumentationKey=[^;"]+' | head -n1 | cut -d= -f2)"
        if [ -n "${embedded_ikey}" ] && ikey_is_managed "${embedded_ikey}"; then
          echo "  · accepted App Insights residual (managed ikey non-authenticating; local_authentication_disabled=true): ${path}"
          continue
        fi
        report "${kind}" "${path}" "App Insights connection string carries an InstrumentationKey (${embedded_ikey:-<none>}) that is NOT one of the plan/state's managed azurerm_application_insights instrumentation_key values — a foreign/lookalike connection string is not the accepted residual (ai_count=${ai_count})"
        continue
      fi
      if [ "${kind}" != "app_setting" ]; then
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

inspect_data_services() {
  # Read TSV rows on stdin: type \t address \t disabled(true|false). Called with
  # `< file` redirection (NOT a pipe) so it runs in THIS shell and the shared
  # `violations` counter that report() bumps survives. Case comparison on the
  # type is exact (jq emits canonical resource type names); the boolean is
  # lowercased defensively before the equality test.
  local rtype raddr rdisabled
  while IFS="${TAB}" read -r rtype raddr rdisabled; do
    [ -z "${rtype}" ] && continue
    rdisabled="$(lc "${rdisabled}")"
    if [ "${rtype}" = "azurerm_iothub" ]; then
      echo "  · accepted IoT Hub key residual (DOCUMENTED EXCEPTION: devices/data-pusher/device-controller authenticate with SAS keys, so key auth is intentionally kept enabled; mitigated by restricted, container-scoped state access — MG-24 ADR): ${raddr}"
      continue
    fi
    if [ "${rdisabled}" = "true" ]; then
      echo "  · accepted inherent key residual (local/key auth disabled — the in-state key of ${rtype} is non-authenticating): ${raddr}"
      continue
    fi
    report "resource" "${raddr}" "TF-managed ${rtype} persists its inherent key/connection-string/instrumentation-key attributes in state, but local/key auth is NOT disabled on it — that in-state key is a LIVE credential. Set local_authentication_disabled=true (Cosmos / App Insights) / shared_access_key_enabled=false (Storage) / local_auth_enabled=false (SignalR) / local_authentication_enabled=false (Event Hubs namespace) to make the residual non-authenticating (MG-24 gate)"
  done
}

echo "tf-plan-secret-inspection: inspecting ${SRC} (App Insights resources: ${ai_count}, local_authentication_disabled(all)=${ai_local_auth_disabled})"

# Feed both sink sets through the classifier. We stage the rows in a temp file and
# read inspect_rows with `< file` (not a pipe / process substitution — neither is
# portable to dash) so the loop runs in THIS shell and its violation counter
# survives. printf keeps empty sets harmless.
rows_file="$(mktemp)"
trap 'rm -f "${rows_file}"' EXIT
{ printf '%s\n' "${app_setting_rows}"; printf '%s\n' "${output_rows}"; } \
  | grep -v '^[[:space:]]*$' > "${rows_file}" || true
inspect_rows < "${rows_file}"

# Inspect the inherent-key data-service resources (Cosmos/Storage/SignalR/IoT).
# Same temp-file + `< file` pattern so the loop runs in THIS shell and the
# violation counter survives (no pipe / process substitution — dash-portable).
ds_file="$(mktemp)"
trap 'rm -f "${rows_file}" "${ds_file}"' EXIT
printf '%s\n' "${data_service_rows}" | grep -v '^[[:space:]]*$' > "${ds_file}" || true
inspect_data_services < "${ds_file}"

echo
if [ "${violations}" -ne 0 ]; then
  echo "tf-plan-secret-inspection: FAILED — ${violations} prohibited credential VALUE(s) in plan/state. DO NOT APPLY." >&2
  exit 1
fi
echo "tf-plan-secret-inspection: PASS — no prohibited credential VALUE reached app_settings or outputs."
exit 0
