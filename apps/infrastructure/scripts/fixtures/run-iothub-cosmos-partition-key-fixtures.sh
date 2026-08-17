#!/usr/bin/env bash
#
# run-iothub-cosmos-partition-key-fixtures.sh — mutation coverage for the MG-73
# IoT Hub Cosmos partition-identity contract in tf-static-checks.sh (check 20).
#
# Each case copies the Terraform inputs into an isolated tree, mutates one
# contract term, then runs the real credentialless checker. This proves the
# gate rejects missing endpoint attributes, endpoint/container drift, non-exact
# identity templates, and attempted payload references without Azure access.
set -u

HERE="$(cd "$(dirname "$0")" && pwd)"
INFRA_SOURCE="$(cd "${HERE}/../.." && pwd)"
CHECKER="${INFRA_SOURCE}/scripts/tf-static-checks.sh"

[ -f "${CHECKER}" ] || { echo "run-iothub-cosmos-partition-key-fixtures: FATAL: checker not found: ${CHECKER}" >&2; exit 2; }

WORK="$(mktemp -d)" || { echo "run-iothub-cosmos-partition-key-fixtures: FATAL: mktemp -d failed" >&2; exit 2; }
trap 'rm -rf "${WORK}"' EXIT HUP INT TERM
SOURCE_FILES="${WORK}/terraform-files"
find "${INFRA_SOURCE}" -type d \( -name '.terraform' -o -name '.nx' -o -name 'node_modules' -o -name '.git' \) -prune -o \
  -type f \( -name '*.tf' -o -name '*.tfvars' -o -name '*.hcl' \) -print | sort > "${SOURCE_FILES}" || exit 2

OUT="${WORK}/checker.out"
failures=0
checks=0

make_tree() {
  fixture_dir="$1"
  mkdir -p "${fixture_dir}" || return 1
  while IFS= read -r source_file; do
    relative_file="${source_file#${INFRA_SOURCE}/}"
    mkdir -p "${fixture_dir}/$(dirname "${relative_file}")" || return 1
    cp "${source_file}" "${fixture_dir}/${relative_file}" || return 1
  done < "${SOURCE_FILES}"
  cp "${INFRA_SOURCE}/.terraform.lock.hcl" "${fixture_dir}/.terraform.lock.hcl" || return 1
  cp "${INFRA_SOURCE}/README.md" "${fixture_dir}/README.md" || return 1
  cp -R "${INFRA_SOURCE}/bootstrap" "${fixture_dir}/bootstrap" || return 1
}

# Count occurrences of a literal, but only inside ONE resource block selected by
# its full label (type + name). MG-53 added a second _shared container to the
# cosmos-db module whose partition_key_paths line is byte-identical to the source
# container's, so a whole-file literal now matches two places; scoping to the
# resource label keeps the mutation aimed at exactly the resource the case intends.
count_occurrences_in_resource() {
  RES_TYPE="$1" RES_NAME="$2" OLD_TEXT="$3" perl -0777 -ne '
    my $blk = "";
    if (/(resource\s+"\Q$ENV{RES_TYPE}\E"\s+"\Q$ENV{RES_NAME}\E"\s*\{.*?)(?=\nresource\s|\z)/s) { $blk = $1; }
    my $c = () = ($blk =~ /\Q$ENV{OLD_TEXT}\E/g);
    print $c;
  ' "$4"
}

# Replace exactly one literal, scoped to a single resource block chosen by label.
# The mutation is deterministic: a future resource that happens to share the same
# term cannot silently become the target, and a zero/multiple match in the
# addressed block is a loud fixture error rather than a misleading result.
replace_once_in_resource() {
  target_file="$1"
  resource_type="$2"
  resource_name="$3"
  old_text="$4"
  new_text="$5"
  occurrences="$(count_occurrences_in_resource "${resource_type}" "${resource_name}" "${old_text}" "${target_file}")"
  if [ "${occurrences}" != "1" ]; then
    echo "run-iothub-cosmos-partition-key-fixtures: FATAL: expected one mutation target in resource ${resource_type}.${resource_name} of ${target_file}, found ${occurrences}" >&2
    return 1
  fi
  # The block is anchored to this label's header, and the non-greedy .*? stops at
  # the FIRST occurrence of old_text after it — which the count above proved is
  # the only one in this block.
  RES_TYPE="${resource_type}" RES_NAME="${resource_name}" OLD_TEXT="${old_text}" NEW_TEXT="${new_text}" perl -0777 -i -pe '
    s/(resource\s+"\Q$ENV{RES_TYPE}\E"\s+"\Q$ENV{RES_NAME}\E"\s*\{.*?)\Q$ENV{OLD_TEXT}\E/"$1$ENV{NEW_TEXT}"/se;
  ' "${target_file}"
}

# Replace exactly one whole-file literal, count-guarded. Used for the resolution
# wiring the re-keyed check 20 follows (a module input in the ROOT main.tf and an
# output declaration in the cosmos-db module), which live in module/output blocks
# rather than resource blocks and so cannot be targeted by the label-scoped
# replacer above. A zero/multiple match is a loud fixture error, not a silent skip.
replace_once_in_file() {
  target_file="$1"
  old_text="$2"
  new_text="$3"
  occurrences="$(OLD_TEXT="${old_text}" perl -0777 -ne 'my $c = () = (/\Q$ENV{OLD_TEXT}\E/g); print $c;' "${target_file}")"
  if [ "${occurrences}" != "1" ]; then
    echo "run-iothub-cosmos-partition-key-fixtures: FATAL: expected one mutation target for '${old_text}' in ${target_file}, found ${occurrences}" >&2
    return 1
  fi
  OLD_TEXT="${old_text}" NEW_TEXT="${new_text}" perl -0777 -i -pe 's/\Q$ENV{OLD_TEXT}\E/$ENV{NEW_TEXT}/;' "${target_file}"
}

mutate_case() {
  case_name="$1"
  iothub_file="$2/modules/iot-hub/main.tf"
  cosmos_file="$2/modules/cosmos-db/main.tf"
  cosmos_outputs_file="$2/modules/cosmos-db/outputs.tf"
  root_file="$2/main.tf"
  case "${case_name}" in
    clean) ;;
    # The six IoT Hub cases target the single cosmos endpoint by label. They match
    # once today, but a second azurerm_iothub_endpoint_cosmosdb_account would make a
    # whole-file replace ambiguous the same way MG-53's second container did to
    # container-drift below — scope every case so no future addition can silently
    # move the target.
    missing-name) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage $'  partition_key_name     = "deviceId"\n' '' ;;
    missing-template) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage $'  partition_key_template = "{deviceid}"\n' '' ;;
    endpoint-container-drift) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage 'partition_key_name     = "deviceId"' 'partition_key_name     = "tenantId"' ;;
    literal-prefix) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage 'partition_key_template = "{deviceid}"' 'partition_key_template = "dev-{deviceid}"' ;;
    wrong-token) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage 'partition_key_template = "{deviceid}"' 'partition_key_template = "{iothub}"' ;;
    body-derived-template) replace_once_in_resource "${iothub_file}" azurerm_iothub_endpoint_cosmosdb_account cosmos_storage 'partition_key_template = "{deviceid}"' 'partition_key_template = "{Body.deviceId}"' ;;
    # After the MG-62 repoint, check 20 no longer keys on the SOURCE container.
    # It RESOLVES the endpoint's target through the root wiring to the DESTINATION
    # container azurerm_cosmosdb_sql_container.temperatures_shared. These cases
    # prove the re-keyed check follows the wiring and stays anti-vacuous:
    #
    # resolved-container-drift: mutate the RESOLVED destination container's
    # partition key. This case was UNREACHABLE while the check pinned the source
    # label — the endpoint addresses temperatures_shared, so drifting it must now
    # be caught (agreement mismatch against the endpoint's partition_key_name).
    resolved-container-drift) replace_once_in_resource "${cosmos_file}" azurerm_cosmosdb_sql_container temperatures_shared 'partition_key_paths   = ["/deviceId"]' 'partition_key_paths   = ["/tenantId"]' ;;
    # nonliteral-target-paths: the resolved container declares a non-literal
    # partition_key_paths; the check cannot compare it and must FAIL, not skip.
    nonliteral-target-paths) replace_once_in_resource "${cosmos_file}" azurerm_cosmosdb_sql_container temperatures_shared 'partition_key_paths   = ["/deviceId"]' 'partition_key_paths   = [var.temperatures_partition_path]' ;;
    # missing-container-wiring: break the root module input the check resolves
    # from, so hop 1 (module.iot_hub cosmos_container_id -> module output) yields
    # a non-module reference. The check must FAIL, never fall back to a guess.
    missing-container-wiring) replace_once_in_file "${root_file}" '= module.cosmos_db.destination_container_ids.temperatures' '= local.orphaned_container_id' ;;
    # renamed-output: rename the destination_container_ids output the wiring names,
    # so hop 3 (module output -> container resource) cannot resolve. FAIL, not skip.
    renamed-output) replace_once_in_file "${cosmos_outputs_file}" 'output "destination_container_ids"' 'output "destination_container_ids_renamed"' ;;
    # unrelated-module-same-label: prove check 20 is SCOPED to the resolved module.
    # Rename the real destination container away from the wired label so it no longer
    # answers in its own module, then plant a same-labeled container carrying the
    # CORRECT /deviceId in an UNRELATED module. The root wiring still resolves to
    # azurerm_cosmosdb_sql_container.temperatures_shared (the outputs.tf reference is
    # untouched). Before the cw_mod_dir scoping fix, the whole-INFRA_DIR scan let that
    # foreign block satisfy the check vacuously (exit 0); the scoped check must FAIL —
    # the wired target is absent from its own module and a same-labeled block in an
    # unrelated module does not substitute for it.
    unrelated-module-same-label)
      replace_once_in_file "${cosmos_file}" \
        'resource "azurerm_cosmosdb_sql_container" "temperatures_shared" {' \
        'resource "azurerm_cosmosdb_sql_container" "temperatures_shared_local" {' || return 1
      mkdir -p "$2/modules/z_unrelated" || return 1
      cat > "$2/modules/z_unrelated/main.tf" <<'UNRELATED_TF'
resource "azurerm_cosmosdb_sql_container" "temperatures_shared" {
  name                = "temperatures"
  database_name       = "unrelated"
  partition_key_paths = ["/deviceId"]
}
UNRELATED_TF
      ;;
    *) echo "run-iothub-cosmos-partition-key-fixtures: FATAL: unknown case ${case_name}" >&2; return 1 ;;
  esac
}

run_case() {
  case_name="$1"
  expected_text="$2"
  fixture_dir="${WORK}/${case_name}"
  checks=$((checks + 1))
  if ! make_tree "${fixture_dir}" || ! mutate_case "${case_name}" "${fixture_dir}"; then
    echo "  ✗ ${case_name}: fixture setup failed" >&2; failures=$((failures + 1)); return
  fi
  if bash "${CHECKER}" "${fixture_dir}" >"${OUT}" 2>&1; then result=0; else result=$?; fi
  if [ "${case_name}" = clean ]; then
    if [ "${result}" -eq 0 ] && grep -Fq "${expected_text}" "${OUT}"; then
      echo "  ✓ clean: passed with the endpoint/container partition contract"
    else
      echo "  ✗ clean: expected exit 0 and '${expected_text}', got exit ${result}" >&2; sed 's/^/      /' "${OUT}" >&2; failures=$((failures + 1))
    fi
  elif [ "${result}" -ne 0 ] && grep -Fq "${expected_text}" "${OUT}"; then
    echo "  ✓ ${case_name}: rejected with its distinguishing message"
  else
    echo "  ✗ ${case_name}: expected nonzero and '${expected_text}', got exit ${result}" >&2; sed 's/^/      /' "${OUT}" >&2; failures=$((failures + 1))
  fi
}

echo "run-iothub-cosmos-partition-key-fixtures: exercising ${CHECKER} with isolated INFRA_DIR copies"
# The clean case proves the re-keyed check RESOLVED the endpoint through the root
# wiring to the DESTINATION container temperatures_shared under the shared-db
# resource, rather than passing vacuously against the source temperatures label.
run_case clean 'endpoint resolved via root wiring to container azurerm_cosmosdb_sql_container.temperatures_shared (database azurerm_cosmosdb_sql_database.meatgeek_shared)'
run_case missing-name 'is missing partition_key_name'
run_case missing-template 'is missing partition_key_template'
run_case endpoint-container-drift 'partition_key_name "tenantId" does not match'
run_case literal-prefix 'partition_key_template must be exactly "{deviceid}"'
run_case wrong-token 'partition_key_template must be exactly "{deviceid}"'
run_case body-derived-template 'must not reference Body or a payload-derived value'
# Re-keyed target: mutating the RESOLVED destination container is rejected, and the
# diagnostic names temperatures_shared — proving the check followed the repoint.
run_case resolved-container-drift "does not match azurerm_cosmosdb_sql_container.temperatures_shared's /tenantId partition property"
# Anti-vacuity across the new resolution chain: each unresolvable target FAILS.
run_case nonliteral-target-paths 'must declare one literal partition_key_paths value'
run_case missing-container-wiring 'cannot resolve module.iot_hub cosmos_container_id'
run_case renamed-output 'does not expose key "temperatures" as a <type>.<name>.id container reference'
# Scope regression (RF-3): a same-labeled container in an UNRELATED module must not
# satisfy check 20 — the resolved target is looked up only in its own module dir.
run_case unrelated-module-same-label 'nor be satisfied by a same-labeled container in an unrelated module'

if [ "${checks}" -ne 12 ] || [ "${failures}" -ne 0 ]; then
  echo "run-iothub-cosmos-partition-key-fixtures: FAILED — ${failures} of ${checks} checks failed (expected 12 checks)." >&2
  exit 1
fi
echo "run-iothub-cosmos-partition-key-fixtures: all ${checks} mutation checks behaved as expected under ${BASH_VERSION}."
